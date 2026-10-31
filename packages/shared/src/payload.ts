import { z } from "zod";
import { isChecksummedEvmAddress, isValidAddressForNetwork, normalizeAddress } from "./addresses";
import { MASUMI_ESCROW_ADDRESSES } from "./cardano";
import { IdempotencyKeySchema, IsoDateTimeSchema, JsonObjectSchema } from "./common";
import { AssetIdSchema, AssetKindSchema, parseAssetId } from "./domain/assets";
import { sha256Hex } from "./hash";
import { BaseUnitAmountSchema, DecimalsSchema } from "./money";
import { chainFamilyOf, NetworkIdSchema, NETWORKS } from "./networks";
import { PluginIdSchema } from "./plugins";
import { RequestSourceSchema } from "./tools";

export const CANONICAL_PAYLOAD_VERSION = 1;

/**
 * The immutable payload an approval binds to. The user's approval, the policy decision,
 * the spending reservation and the signed transaction all reference `payloadHash(payload)`.
 * Any material change (recipient, amount, asset, network, fee cap, expiry, ...) produces a
 * different hash and therefore invalidates the approval.
 *
 * Addresses must be in canonical form (EIP-55 for EVM); build payloads with
 * `createCanonicalPayload` to normalize them.
 */
export const CanonicalTransactionPayloadSchema = z
  .strictObject({
    version: z.literal(CANONICAL_PAYLOAD_VERSION),
    network: NetworkIdSchema,
    from: z.string(),
    to: z.string(),
    asset: z.object({
      id: AssetIdSchema,
      kind: AssetKindSchema,
      decimals: DecimalsSchema,
    }),
    amount: BaseUnitAmountSchema,
    /** Max network fee in the native asset's base units the signer may spend. */
    feeCap: BaseUnitAmountSchema,
    /** Plugin that built the transaction (null for plain transfers). */
    plugin: PluginIdSchema.nullable(),
    /** What created the request: an MCP tool or the in-app send flow. */
    tool: RequestSourceSchema,
    /** Plugin-specific material terms (e.g. swap output mint and minimum output). */
    pluginData: JsonObjectSchema.nullable(),
    /** 128-bit random hex; makes two otherwise-identical requests hash differently. */
    nonce: z.string().regex(/^[0-9a-f]{32}$/, "nonce must be 32 lowercase hex chars"),
    expiresAt: IsoDateTimeSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .superRefine((p, ctx) => {
    for (const field of ["from", "to"] as const) {
      const address = p[field];
      if (field === "to" && isMasumiEscrowLock(p)) continue;
      if (!isValidAddressForNetwork(p.network, address)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `invalid address for ${p.network}`,
        });
      } else if (chainFamilyOf(p.network) === "evm" && !isChecksummedEvmAddress(address)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "EVM address must be EIP-55 checksummed",
        });
      }
    }
    const assetNetwork = parseAssetId(p.asset.id).network;
    if (assetNetwork !== p.network) {
      ctx.addIssue({
        code: "custom",
        path: ["asset", "id"],
        message: "asset is on a different network",
      });
    }
    if (
      p.asset.kind === "native" &&
      p.asset.decimals !== NETWORKS[p.network].nativeCurrency.decimals
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["asset", "decimals"],
        message: "wrong native decimals",
      });
    }
  });
export type CanonicalTransactionPayload = z.infer<typeof CanonicalTransactionPayloadSchema>;

/**
 * The one case where `to` may be a SCRIPT address: an x402 payment on Cardano with
 * `pluginData.escrow.method === "masumi"` whose `to` is exactly the canonical Masumi escrow
 * address of the network (MASUMI_ESCROW_ADDRESSES) and equals `pluginData.escrow.escrowAddress`.
 * The escrow terms and the exact inline datum (`pluginData.escrow.datumCbor`) are part of
 * pluginData, so payloadHash commits to them; the API's lock verifier checks the transaction
 * carries that datum byte for byte. Any other script address stays invalid.
 */
export function isMasumiEscrowLock(p: {
  network: string;
  to: string;
  plugin: string | null;
  pluginData: Record<string, unknown> | null;
}): boolean {
  if (p.plugin !== "x402" || p.pluginData === null) return false;
  const network = NetworkIdSchema.safeParse(p.network);
  if (!network.success || chainFamilyOf(network.data) !== "cardano") return false;
  const escrow = p.pluginData.escrow;
  if (escrow === null || typeof escrow !== "object" || Array.isArray(escrow)) return false;
  const { method, escrowAddress } = escrow as Record<string, unknown>;
  const canonical = MASUMI_ESCROW_ADDRESSES[network.data];
  return (
    method === "masumi" &&
    canonical !== undefined &&
    escrowAddress === canonical &&
    p.to === canonical
  );
}

/** Parse + normalize (EIP-55) an input into a canonical payload. Throws ZodError if invalid. */
export function createCanonicalPayload(
  input: CanonicalTransactionPayload,
): CanonicalTransactionPayload {
  const family = chainFamilyOf(input.network);
  const normalized = {
    ...input,
    from: isValidAddressForNetwork(input.network, input.from)
      ? normalizeAddress(family, input.from)
      : input.from,
    to: isValidAddressForNetwork(input.network, input.to)
      ? normalizeAddress(family, input.to)
      : input.to,
  };
  return CanonicalTransactionPayloadSchema.parse(normalized);
}

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit order (as in RFC 8785/JCS),
 * no whitespace, arrays keep order. Rejects values JSON cannot represent faithfully
 * (undefined, functions, symbols, bigint, NaN/Infinity, non-plain objects).
 * For the string/integer/boolean/null data used in payloads the output equals JCS.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError(`${path}: non-finite number`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => serialize(v, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError(`${path}: only plain objects can be canonicalized`);
      }
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          const v = record[key];
          if (v === undefined) throw new CanonicalizationError(`${path}.${key}: undefined`);
          return `${JSON.stringify(key)}:${serialize(v, `${path}.${key}`)}`;
        });
      return `{${entries.join(",")}}`;
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new CanonicalizationError(`${path}: cannot canonicalize ${typeof value}`);
  }
  throw new CanonicalizationError(`${path}: unsupported value`);
}

/** sha256 (lowercase hex) of the canonical JSON of a validated payload. */
export function payloadHash(payload: CanonicalTransactionPayload): string {
  const validated = CanonicalTransactionPayloadSchema.parse(payload);
  return sha256Hex(canonicalize(validated));
}

export const PayloadHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 lowercase hex");
export type PayloadHash = z.infer<typeof PayloadHashSchema>;
