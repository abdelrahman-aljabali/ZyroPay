/*
 * Cardano TransactionBuilder (Blockfrost for UTxOs, protocol parameters and the tip).
 *
 * buildTransfer(payload):
 *  1. validate the payload, the bound network (addresses carry the network id), expiry;
 *  2. token sends: read the asset (Blockfrost /assets/{unit}); its registered decimals must
 *     equal the payload's (DECIMALS_MISMATCH);
 *  3. the recipient output: ADA sends carry exactly `amount` lovelace and must meet the
 *     min-UTxO rule; token sends carry the tokens plus the minimum lovelace an output with
 *     them needs (`minAdaDeposit`, paid by the sender and bounded by `feeCap`);
 *  4. coin selection, largest first, skipping UTxOs with reference scripts (Conway charges
 *     for them); change returns to `from` and must meet min-UTxO, else more inputs;
 *  5. fee = minFeeA * size(signed tx with one vkey witness) + minFeeB, iterated to a fixed
 *     point; TTL = tip slot + time left until the payload expires + a margin;
 *  6. sanity checks: value preserved, size <= maxTxSize, every value <= maxValSize,
 *     fee + minAdaDeposit <= feeCap;
 *  7. verifyMatchesPayload on the built bytes (self-check).
 *
 * Min-UTxO (Babbage+): (160 + serialized output size) * coinsPerUTxOByte
 * (https://docs.cardano.org/native-tokens/minimum-ada-value-requirement/).
 * Fee: https://docs.cardano.org/about-cardano/explore-more/fee-structure
 *
 * There is no on-node simulation for plain key-witnessed transfers (no scripts to
 * evaluate); the ledger rules that would reject the transaction are re-checked here.
 */
import type {
  BaseUnitAmount,
  CanonicalTransactionPayload,
  NetworkId,
  TransactionBuilder,
  UnsignedTransaction,
  VerificationResult,
} from "@zyropay/shared";
import {
  addressesEqual,
  CanonicalTransactionPayloadSchema,
  parseAssetId,
  parseBaseUnits,
  payloadHash,
} from "@zyropay/shared";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { assertAddress, assertFamily, assertSameNetwork } from "../networks";
import type { BlockfrostUtxo, ChainTip, ProtocolParams } from "./blockfrost";
import { BlockfrostClient } from "./blockfrost";
import { readAssetMetadata } from "./metadata";
import type { CardanoInput, CardanoTxOutput, CardanoValue } from "./tx";
import {
  addValues,
  assembleTx,
  decodeCardanoTx,
  emptyValue,
  encodeBody,
  outputSize,
  signedSizeOf,
  valueSize,
} from "./tx";

export interface CardanoTransactionBuilderConfig extends HttpOptions {
  readonly blockfrostProjectId: string;
  readonly network: NetworkId;
  readonly blockfrostBaseUrl?: string;
  /** Extra validity after the payload expires, seconds. Default 600. */
  readonly ttlMarginSeconds?: number;
  /** Upper bound on the validity window, seconds. Default 7200. */
  readonly maxTtlSeconds?: number;
  /** Seconds per slot (1 on mainnet and preprod since Shelley). Default 1. */
  readonly secondsPerSlot?: number;
  /** Max inputs a transfer may spend. Default 60. */
  readonly maxInputs?: number;
  readonly now?: () => Date;
}

export interface CardanoUnsignedTransaction extends UnsignedTransaction {
  readonly family: "cardano";
  readonly encoding: "hex";
  /** blake2b-256 of the body: what the passkey signs (SIGN_RAW_PAYLOAD) and the tx id. */
  readonly bodyHash: string;
  /** Absolute slot after which the transaction can never land. */
  readonly ttlSlot: string;
  /**
   * Lovelace that rides with a token to the recipient (min-UTxO). Paid by the sender in
   * addition to the fee; "0" for ADA sends. `estimatedFee + minAdaDeposit <= feeCap`.
   */
  readonly minAdaDeposit: BaseUnitAmount;
  readonly inputCount: number;
}

export interface CardanoTransferFeeEstimate {
  readonly estimatedFee: BaseUnitAmount;
  /** fee x2 (at least +0.2 ADA) plus the token deposit; becomes the payload's feeCap. */
  readonly recommendedFeeCap: BaseUnitAmount;
  readonly minAdaDeposit: BaseUnitAmount;
}

export interface CardanoTransactionBuilder extends TransactionBuilder<"cardano"> {
  readonly network: NetworkId;
  /**
   * `maxValiditySeconds` caps the validity window further (x402: the facilitator refuses a
   * TTL beyond now + maxTimeoutSeconds).
   */
  buildTransfer(
    payload: CanonicalTransactionPayload,
    options?: { maxValiditySeconds?: number },
  ): Promise<CardanoUnsignedTransaction>;
  estimateTransferFee(
    input: Omit<CanonicalTransactionPayload, "feeCap" | "nonce" | "idempotencyKey" | "expiresAt">,
  ): Promise<CardanoTransferFeeEstimate>;
}

/** Hard ceiling on the lovelace a token output may carry (min-UTxO is ~1-2 ADA). */
export const MAX_TOKEN_OUTPUT_LOVELACE = 5_000_000n;
const MIN_FEE_HEADROOM = 200_000n;

type TransferInput = Pick<
  CanonicalTransactionPayload,
  "network" | "from" | "to" | "asset" | "amount"
>;

interface Plan {
  readonly bodyBytes: Uint8Array;
  readonly fee: bigint;
  readonly deposit: bigint;
  readonly inputCount: number;
}

export function minAdaFor(output: CardanoTxOutput, coinsPerByte: bigint): bigint {
  // The coin amount is part of the output's size: iterate to a fixed point.
  let coin = output.value.coin;
  for (let i = 0; i < 4; i++) {
    const need =
      (160n + BigInt(outputSize({ ...output, value: { ...output.value, coin } }))) * coinsPerByte;
    if (need === coin) return need;
    coin = need;
  }
  return coin;
}

export function utxoValue(u: BlockfrostUtxo): CardanoValue {
  let coin = 0n;
  const assets = new Map<string, bigint>();
  for (const a of u.amount) {
    const q = BigInt(a.quantity);
    if (a.unit === "lovelace") coin += q;
    else assets.set(a.unit, (assets.get(a.unit) ?? 0n) + q);
  }
  return { coin, assets };
}

export function subtract(a: CardanoValue, b: CardanoValue): CardanoValue | null {
  const coin = a.coin - b.coin;
  const assets = new Map(a.assets);
  for (const [unit, qty] of b.assets) {
    const left = (assets.get(unit) ?? 0n) - qty;
    if (left < 0n) return null;
    if (left === 0n) assets.delete(unit);
    else assets.set(unit, left);
  }
  return { coin, assets };
}

/** Inputs to `planCardanoPayment`: one fixed output plus change back to `from`. */
export interface CardanoPaymentPlanInput {
  /** The fixed output (may carry an inline datum: min-UTxO is the caller's check). */
  readonly recipient: CardanoTxOutput & { readonly address: string };
  /** Token the recipient carries, if any: UTxOs holding it are selected first. */
  readonly unit: string | null;
  readonly utxos: readonly BlockfrostUtxo[];
  readonly params: ProtocolParams;
  readonly ttl: bigint;
  readonly from: string;
  readonly maxInputs: number;
  /** UTxOs that must be spent (e.g. the x402 nonce input); must be among `utxos`. */
  readonly required?: readonly CardanoInput[];
  /** More fixed outputs after `recipient` (ADA only; e.g. an allowance's agent float). */
  readonly extra?: readonly CardanoTxOutput[];
}

export interface CardanoPaymentPlan {
  readonly bodyBytes: Uint8Array;
  readonly fee: bigint;
  readonly inputCount: number;
  readonly inputs: readonly CardanoInput[];
}

const sameInput = (u: BlockfrostUtxo, i: CardanoInput) =>
  u.tx_hash === i.txHash && u.output_index === i.index;

/**
 * Coin selection + fee fixed point for "one fixed output + change": largest first, UTxOs
 * holding the token first, never UTxOs with reference scripts; change must meet min-UTxO.
 * Throws INSUFFICIENT_FUNDS with the last reason when no prefix of the ordering works.
 */
export function planCardanoPayment(input: CardanoPaymentPlanInput): CardanoPaymentPlan {
  const { unit } = input;
  const required = input.required ?? [];
  const forced: BlockfrostUtxo[] = [];
  for (const r of required) {
    const u = input.utxos.find((x) => sameInput(x, r));
    if (u === undefined)
      throw new ChainError(
        "VALIDATION_FAILED",
        "a required input is not an unspent UTxO of the sender",
      );
    if (u.reference_script_hash !== null)
      throw new ChainError("VALIDATION_FAILED", "a required input carries a reference script");
    forced.push(u);
  }
  const usable = input.utxos.filter(
    (u) => u.reference_script_hash === null && !required.some((r) => sameInput(u, r)),
  );
  const pureAda = (u: BlockfrostUtxo) => u.amount.every((a) => a.unit === "lovelace");
  const coin = (u: BlockfrostUtxo) => utxoValue(u).coin;
  const tokenQty = (u: BlockfrostUtxo) =>
    unit === null ? 0n : (utxoValue(u).assets.get(unit) ?? 0n);
  const byCoinDesc = (a: BlockfrostUtxo, b: BlockfrostUtxo) =>
    coin(b) > coin(a) ? 1 : coin(b) < coin(a) ? -1 : 0;
  const withToken = usable
    .filter((u) => tokenQty(u) > 0n)
    .sort((a, b) =>
      tokenQty(b) > tokenQty(a) ? 1 : tokenQty(b) < tokenQty(a) ? -1 : byCoinDesc(a, b),
    );
  const ada = usable.filter((u) => tokenQty(u) === 0n && pureAda(u)).sort(byCoinDesc);
  const other = usable.filter((u) => tokenQty(u) === 0n && !pureAda(u)).sort(byCoinDesc);
  const ordered = [...withToken, ...ada, ...other];

  let shortReason = "insufficient balance";
  const selected: BlockfrostUtxo[] = [...forced];
  if (selected.length > 0) {
    const attempt = tryPlan(selected, input);
    if (typeof attempt !== "string") return attempt;
    shortReason = attempt;
  }
  for (const next of ordered) {
    if (selected.length >= input.maxInputs) break;
    selected.push(next);
    const attempt = tryPlan(selected, input);
    if (typeof attempt !== "string") return attempt;
    shortReason = attempt;
  }
  throw new ChainError("INSUFFICIENT_FUNDS", shortReason);
}

/** A plan for exactly these inputs, or why it does not work. */
function tryPlan(
  selected: readonly BlockfrostUtxo[],
  { recipient, params, ttl, from, extra = [] }: CardanoPaymentPlanInput,
): CardanoPaymentPlan | string {
  const total = addValues(selected.map(utxoValue));
  const fixedCoin = extra.reduce((sum, o) => sum + o.value.coin, recipient.value.coin);
  const inputs: CardanoInput[] = selected.map((u) => ({
    txHash: u.tx_hash,
    index: u.output_index,
  }));
  let fee = 0n;
  for (let round = 0; round < 6; round++) {
    const change = subtract(total, {
      coin: fixedCoin + fee,
      assets: recipient.value.assets,
    });
    if (change === null) return "insufficient token balance";
    if (change.coin < 0n) return "insufficient ADA for amount and fee";
    const outputs: CardanoTxOutput[] = [recipient, ...extra];
    if (change.coin > 0n || change.assets.size > 0) {
      const changeOutput = { address: from, value: change };
      if (change.coin < minAdaFor(changeOutput, params.coinsPerUtxoByte)) {
        return "not enough ADA left for the change output (Cardano minimum per output)";
      }
      if (valueSize(change) > params.maxValSize) return "change output holds too many tokens";
      outputs.push(changeOutput);
    }
    const bodyBytes = encodeBody({ inputs, outputs, fee, ttl });
    const size = signedSizeOf(bodyBytes);
    if (size > params.maxTxSize) return "transaction would exceed the maximum size";
    const needed = params.minFeeA * BigInt(size) + params.minFeeB;
    if (needed === fee) return { bodyBytes, fee, inputCount: inputs.length, inputs };
    fee = needed;
  }
  return "fee did not converge";
}

export function createCardanoTransactionBuilder(
  config: CardanoTransactionBuilderConfig,
): CardanoTransactionBuilder {
  assertFamily(config.network, "cardano");
  const client = new BlockfrostClient({
    ...config,
    projectId: config.blockfrostProjectId,
    ...(config.blockfrostBaseUrl !== undefined ? { baseUrl: config.blockfrostBaseUrl } : {}),
  });
  const now = config.now ?? (() => new Date());
  const ttlMargin = BigInt(config.ttlMarginSeconds ?? 600);
  const maxTtl = BigInt(config.maxTtlSeconds ?? 7200);
  const secondsPerSlot = config.secondsPerSlot ?? 1;
  const maxInputs = config.maxInputs ?? 60;

  function validate(input: TransferInput): void {
    assertSameNetwork(config.network, input.network);
    assertAddress(input.network, input.from, "from");
    assertAddress(input.network, input.to, "to");
    if (parseAssetId(input.asset.id).network !== input.network) {
      throw new ChainError("NETWORK_MODE_MISMATCH", "asset is on a different network");
    }
    if (parseBaseUnits(input.amount) === 0n) {
      throw new ChainError("VALIDATION_FAILED", "amount must be greater than zero");
    }
    if (input.asset.kind !== "native" && input.asset.kind !== "cardano_token") {
      throw new ChainError(
        "VALIDATION_FAILED",
        `${input.asset.kind} assets cannot be sent on Cardano`,
      );
    }
  }

  async function checkAsset(input: TransferInput): Promise<string | null> {
    const unit = parseAssetId(input.asset.id).tokenAddress;
    if (unit === null) return null;
    const meta = await readAssetMetadata(client, unit);
    if (meta === null) throw new ChainError("VALIDATION_FAILED", "unknown Cardano asset");
    if (meta.decimals !== input.asset.decimals) {
      throw new ChainError(
        "DECIMALS_MISMATCH",
        `asset has ${meta.decimals} decimals, request says ${input.asset.decimals}`,
      );
    }
    return unit;
  }

  /**
   * Validity is counted from the tip's slot, which trails wall-clock time by up to a block, so
   * the window never ends later than `now + window`.
   */
  function ttlFor(tip: ChainTip, expiresAt: string | null, maxValiditySeconds?: number): bigint {
    const left =
      expiresAt === null
        ? 0n
        : BigInt(Math.max(0, Math.ceil((Date.parse(expiresAt) - now().getTime()) / 1000)));
    let window = left + ttlMargin;
    if (window > maxTtl) window = maxTtl;
    if (maxValiditySeconds !== undefined) {
      if (!Number.isInteger(maxValiditySeconds) || maxValiditySeconds < 60)
        throw new ChainError("VALIDATION_FAILED", "validity window must be at least 60 s");
      if (window > BigInt(maxValiditySeconds)) window = BigInt(maxValiditySeconds);
    }
    return tip.slot + window / BigInt(secondsPerSlot);
  }

  function plan(
    input: TransferInput,
    unit: string | null,
    utxos: readonly BlockfrostUtxo[],
    params: ProtocolParams,
    ttl: bigint,
  ): Plan {
    const amount = parseBaseUnits(input.amount);
    const recipient: { address: string; value: CardanoValue } =
      unit === null
        ? { address: input.to, value: emptyValue(amount) }
        : { address: input.to, value: { coin: 0n, assets: new Map([[unit, amount]]) } };
    let deposit = 0n;
    if (unit === null) {
      const min = minAdaFor(recipient, params.coinsPerUtxoByte);
      if (amount < min) {
        throw new ChainError(
          "VALIDATION_FAILED",
          `Cardano outputs need at least ${min.toString()} lovelace; send more ADA`,
        );
      }
    } else {
      deposit = minAdaFor(recipient, params.coinsPerUtxoByte);
      recipient.value = { ...recipient.value, coin: deposit };
    }
    if (valueSize(recipient.value) > params.maxValSize) {
      throw new ChainError("VALIDATION_FAILED", "output value is too large");
    }
    const p = planCardanoPayment({
      recipient,
      unit,
      utxos,
      params,
      ttl,
      from: input.from,
      maxInputs,
    });
    return { bodyBytes: p.bodyBytes, fee: p.fee, inputCount: p.inputCount, deposit };
  }

  async function prepare(
    input: TransferInput,
    expiresAt: string | null,
    maxValiditySeconds?: number,
  ) {
    validate(input);
    const unit = await checkAsset(input);
    const [params, tip, utxos] = await Promise.all([
      client.protocolParams(),
      client.tip(),
      client.utxos(input.from),
    ]);
    const ttl = ttlFor(tip, expiresAt, maxValiditySeconds);
    return { plan: plan(input, unit, utxos, params, ttl), tip, ttl };
  }

  const builder: CardanoTransactionBuilder = {
    family: "cardano",
    network: config.network,

    async estimateTransferFee(input) {
      const { plan: p } = await prepare(input, null);
      const headroom = p.fee > MIN_FEE_HEADROOM ? p.fee : MIN_FEE_HEADROOM;
      return {
        estimatedFee: p.fee.toString(),
        recommendedFeeCap: (p.fee + headroom + p.deposit).toString(),
        minAdaDeposit: p.deposit.toString(),
      };
    },

    async buildTransfer(rawPayload, options = {}) {
      const payload = CanonicalTransactionPayloadSchema.parse(rawPayload);
      assertFamily(payload.network, "cardano");
      if (Date.parse(payload.expiresAt) <= now().getTime()) {
        throw new ChainError("REQUEST_EXPIRED", "payload has expired");
      }
      const {
        plan: p,
        tip,
        ttl,
      } = await prepare(payload, payload.expiresAt, options.maxValiditySeconds);
      if (p.fee + p.deposit > parseBaseUnits(payload.feeCap)) {
        throw new ChainError(
          "VALIDATION_FAILED",
          `fee ${p.fee.toString()} + deposit ${p.deposit.toString()} exceeds the fee cap ${payload.feeCap}`,
        );
      }
      const serialized = bytesToHex(assembleTx(p.bodyBytes, []));
      const verified = verifyCardanoTransfer(serialized, "hex", payload, config.network);
      if (!verified.ok) {
        throw new ChainError(
          "INTERNAL_ERROR",
          `built transaction failed self-check: ${verified.reason}`,
        );
      }
      const decoded = decodeCardanoTx(hexToBytes(serialized));
      const validUntilMs = (tip.time + Number(ttl - tip.slot) * secondsPerSlot) * 1000;
      return {
        family: "cardano",
        network: payload.network,
        payloadHash: payloadHash(payload),
        encoding: "hex",
        serialized,
        estimatedFee: p.fee.toString(),
        validUntil: new Date(validUntilMs).toISOString(),
        simulated: false,
        bodyHash: decoded.bodyHash,
        ttlSlot: ttl.toString(),
        minAdaDeposit: p.deposit.toString(),
        inputCount: p.inputCount,
      };
    },

    verifyMatchesPayload(serialized, encoding, payload) {
      return Promise.resolve(verifyCardanoTransfer(serialized, encoding, payload, config.network));
    },
  };
  return builder;
}

/**
 * Independent decode of an unsigned Cardano transfer against its payload. No network
 * access; fails closed on anything ZyroPay does not build:
 *  - strict canonical CBOR that re-encodes to the same body bytes;
 *  - body keys exactly {inputs, outputs, fee, ttl} (no certificates, withdrawals, mint,
 *    collateral, required signers, scripts, metadata hash, governance);
 *  - empty witness set, is_valid = true, no auxiliary data;
 *  - output 0 pays `to` exactly: ADA sends `amount` lovelace and nothing else; token sends
 *    exactly `amount` of the payload's asset and at most MAX_TOKEN_OUTPUT_LOVELACE;
 *  - at most one more output, back to `from` (change); no datums or script references;
 *  - fee + the token output's lovelace <= feeCap.
 */
export function verifyCardanoTransfer(
  serialized: string,
  encoding: "base64" | "hex",
  rawPayload: CanonicalTransactionPayload,
  boundNetwork: NetworkId,
): VerificationResult {
  const fail = (reason: string): VerificationResult => ({ ok: false, reason });
  try {
    const parsed = CanonicalTransactionPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return fail("payload is invalid");
    const payload = parsed.data;
    if (payload.network !== boundNetwork) return fail("payload is for another network");
    if (encoding !== "hex" || !/^[0-9a-f]+$/.test(serialized) || serialized.length % 2 !== 0)
      return fail("expected lowercase hex CBOR");
    const tx = decodeCardanoTx(hexToBytes(serialized), { strict: true });
    if (!tx.isValid) return fail("is_valid must be true");
    if (tx.hasAuxiliaryData) return fail("auxiliary data is not allowed");
    if (tx.witnessKeys.length !== 0) return fail("unsigned transaction must have no witnesses");
    const keys = [...tx.bodyKeys].sort((a, b) => a - b).join(",");
    if (keys !== "0,1,2,3") return fail(`unexpected body fields: ${keys}`);
    if (tx.fee === null || tx.ttl === null) return fail("fee and ttl are required");
    if (tx.inputs.length === 0) return fail("no inputs");
    if (tx.outputs.length < 1 || tx.outputs.length > 2)
      return fail("expected one payment and at most one change output");
    if (tx.outputs.some((o) => o.address === null || o.hasExtras))
      return fail("outputs must be plain Shelley outputs");
    const reencoded = encodeBody({
      inputs: tx.inputs,
      outputs: tx.outputs,
      fee: tx.fee,
      ttl: tx.ttl,
    });
    if (bytesToHex(reencoded) !== bytesToHex(tx.bodyBytes))
      return fail("body is not in canonical form");
    const [pay, change] = tx.outputs;
    if (pay?.address == null || !addressesEqual("cardano", pay.address, payload.to))
      return fail("first output does not pay the recipient");
    if (
      change !== undefined &&
      (change.address === null || !addressesEqual("cardano", change.address, payload.from))
    )
      return fail("second output is not change to the sender");

    const amount = parseBaseUnits(payload.amount);
    const unit = parseAssetId(payload.asset.id).tokenAddress;
    let deposit = 0n;
    if (unit === null) {
      if (payload.asset.kind !== "native") return fail("asset kind mismatch");
      if (pay.value.coin !== amount || pay.value.assets.size !== 0)
        return fail("payment output value differs from the payload");
    } else {
      if (payload.asset.kind !== "cardano_token") return fail("asset kind mismatch");
      if (pay.value.assets.size !== 1 || pay.value.assets.get(unit) !== amount)
        return fail("payment output tokens differ from the payload");
      if (pay.value.coin > MAX_TOKEN_OUTPUT_LOVELACE)
        return fail("token output carries too much ADA");
      deposit = pay.value.coin;
    }
    if (tx.fee + deposit > parseBaseUnits(payload.feeCap)) return fail("fee exceeds the fee cap");
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? `decode failed: ${error.message}` : "decode failed");
  }
}
