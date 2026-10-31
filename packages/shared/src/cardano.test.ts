import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  addressesEqual,
  isValidAddress,
  isValidAddressForNetwork,
  normalizeAddress,
  AddressSchema,
} from "./addresses";
import {
  bech32Decode,
  bech32Encode,
  cardanoAddressFromBytes,
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoPaymentKeyHash,
  cardanoUnsignedBodyHash,
  isValidCardanoAddress,
  isValidCardanoByronAddress,
  isValidCardanoPaymentAddress,
  MASUMI_ESCROW_ADDRESSES,
  parseShelleyAddress,
  splitCardanoAssetUnit,
} from "./cardano";
import { defaultAgentPolicy } from "./domain/agents";
import { AssetIdSchema, AssetSchema, nativeAsset } from "./domain/assets";
import { evaluatePolicy } from "./policy";
import { cardanoNetworkId, networksForMode, NETWORKS } from "./networks";
import { createCanonicalPayload, isMasumiEscrowLock } from "./payload";

// CIP-19 test vectors (https://cips.cardano.org/cip/CIP-0019#test-vectors).
const CIP19 = {
  paymentVk: "addr_vk1w0l2sr2zgfm26ztc6nl9xy8ghsk5sh6ldwemlpmp9xylzy4dtf7st80zhd",
  keyHash: "9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e",
  type0:
    "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
  type1:
    "addr1z8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs9yc0hh",
  type4: "addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k",
  type6: "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8",
  type6Test: "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz",
  type7: "addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx",
  type14: "stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw",
  byronIcarus: "Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi",
  byronDaedalus:
    "DdzFFzCqrht4PWfBGtmrQz4x1GkZHYLVGbK7aaBkjWxujxzz3L5GxCgPiTsks5RjUr3yX9KvwKjNJBt7ZzPCmS3fUQrGeRvo9Y1YBQKQ",
};

/** Public key bytes of the CIP-19 payment verification key. */
function cip19PublicKey(): string {
  const decoded = bech32Decode(CIP19.paymentVk);
  if (decoded === null) throw new Error("vector");
  return Array.from(decoded.bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("bech32", () => {
  it("round-trips and rejects a broken checksum or mixed case", () => {
    const decoded = bech32Decode(CIP19.type6);
    expect(decoded?.hrp).toBe("addr");
    expect(bech32Encode("addr", decoded!.bytes)).toBe(CIP19.type6);
    expect(bech32Decode(`${CIP19.type6.slice(0, -1)}9`)).toBeNull();
    expect(bech32Decode(CIP19.type6.toUpperCase())?.hrp).toBe("addr");
    expect(bech32Decode(`A${CIP19.type6.slice(1)}`)).toBeNull();
  });
});

describe("Cardano addresses (CIP-19)", () => {
  it("derives the CIP-19 key hash and enterprise addresses from the public key", () => {
    const pk = cip19PublicKey();
    expect(cardanoKeyHash(pk)).toBe(CIP19.keyHash);
    expect(cardanoEnterpriseAddress(pk, "cardano-mainnet")).toBe(CIP19.type6);
    expect(cardanoEnterpriseAddress(pk, "cardano-preprod")).toBe(CIP19.type6Test);
    expect(() => cardanoKeyHash("00")).toThrow();
    expect(() => cardanoEnterpriseAddress(pk, "solana-mainnet")).toThrow();
  });
  it("parses every Shelley type and its payment credential", () => {
    expect(parseShelleyAddress(CIP19.type0)).toMatchObject({ type: 0, networkId: 1 });
    expect(parseShelleyAddress(CIP19.type1)?.payment?.kind).toBe("script");
    expect(parseShelleyAddress(CIP19.type4)?.type).toBe(4);
    expect(parseShelleyAddress(CIP19.type6)?.payment).toEqual({ kind: "key", hash: CIP19.keyHash });
    expect(parseShelleyAddress(CIP19.type7)?.payment?.kind).toBe("script");
    expect(parseShelleyAddress(CIP19.type14)?.payment).toBeNull();
    expect(cardanoPaymentKeyHash(CIP19.type0)).toBe(CIP19.keyHash);
    expect(cardanoPaymentKeyHash(CIP19.type7)).toBeNull();
  });
  it("validates Byron envelopes (display only)", () => {
    expect(isValidCardanoByronAddress(CIP19.byronIcarus)).toBe(true);
    expect(isValidCardanoByronAddress(CIP19.byronDaedalus)).toBe(true);
    expect(isValidCardanoByronAddress(`${CIP19.byronIcarus.slice(0, -1)}j`)).toBe(false);
    expect(isValidCardanoAddress(CIP19.byronIcarus)).toBe(true);
  });
  it("send recipients: key credential, matching network, no Byron/stake/script", () => {
    expect(isValidCardanoPaymentAddress("cardano-mainnet", CIP19.type0)).toBe(true);
    expect(isValidCardanoPaymentAddress("cardano-mainnet", CIP19.type4)).toBe(true);
    expect(isValidCardanoPaymentAddress("cardano-mainnet", CIP19.type6)).toBe(true);
    expect(isValidCardanoPaymentAddress("cardano-preprod", CIP19.type6)).toBe(false);
    expect(isValidCardanoPaymentAddress("cardano-preprod", CIP19.type6Test)).toBe(true);
    expect(isValidCardanoPaymentAddress("cardano-mainnet", CIP19.type6Test)).toBe(false);
    for (const bad of [CIP19.type1, CIP19.type7, CIP19.type14, CIP19.byronIcarus]) {
      expect(isValidCardanoPaymentAddress("cardano-mainnet", bad)).toBe(false);
      expect(isValidAddressForNetwork("cardano-mainnet", bad)).toBe(false);
    }
    expect(isValidAddressForNetwork("cardano-preprod", CIP19.type6Test)).toBe(true);
    expect(isValidAddressForNetwork("solana-mainnet", CIP19.type6)).toBe(false);
  });
  it("family-level helpers: validity, canonical lowercase, case-insensitive equality", () => {
    expect(isValidAddress("cardano", CIP19.type6)).toBe(true);
    expect(isValidAddress("cardano", CIP19.type7)).toBe(false);
    expect(normalizeAddress("cardano", CIP19.type6.toUpperCase())).toBe(CIP19.type6);
    expect(addressesEqual("cardano", CIP19.type6, CIP19.type6.toUpperCase())).toBe(true);
  });
  it("AddressSchema accepts any on-chain Cardano form (display), up to base-address length", () => {
    for (const a of [CIP19.type0, CIP19.type1, CIP19.type6Test, CIP19.byronDaedalus]) {
      expect(AddressSchema.safeParse(a).success).toBe(true);
    }
    expect(AddressSchema.safeParse(CIP19.type14).success).toBe(false);
  });
  it("re-encodes raw output address bytes", () => {
    const parsed = parseShelleyAddress(CIP19.type0)!;
    expect(cardanoAddressFromBytes(parsed.bytes)).toBe(CIP19.type0);
    expect(cardanoAddressFromBytes(Uint8Array.from([0x82, 0x00]))).toBeNull();
  });
});

describe("Cardano policy (ADR-002)", () => {
  it("an autonomous agent within limits still needs approval on Cardano", () => {
    const wallet = "0199f3a0-0000-7000-8000-000000000001";
    const policy = {
      ...defaultAgentPolicy(),
      mode: "autonomous" as const,
      spendingEnabled: true,
      allowedWalletIds: [wallet],
      allowedNetworks: ["cardano-preprod" as const],
      recipientAllowlist: [{ family: "cardano" as const, address: CIP19.type6Test, label: null }],
      limits: { perTransactionUsdMinor: "5000", dailyUsdMinor: "10000", monthlyUsdMinor: "50000" },
    };
    const zero = { spentUsdMinor: "0", reservedUsdMinor: "0" };
    const result = evaluatePolicy(
      policy,
      {
        tool: "send",
        walletId: wallet,
        network: "cardano-preprod",
        recipient: CIP19.type6Test.toUpperCase(),
        protocol: null,
      },
      "100",
      { daily: zero, monthly: zero },
      { now: new Date("2026-10-30T00:00:00Z") },
    );
    expect(result.decision).toBe("require_approval");
    expect(result.reasons.map((r) => r.code)).toEqual(["AUTONOMY_NOT_SUPPORTED"]);
  });
});

describe("Cardano networks and assets", () => {
  it("is a mainnet/testnet pair with ADA at 6 decimals", () => {
    expect(NETWORKS["cardano-mainnet"].counterpart).toBe("cardano-preprod");
    expect(NETWORKS["cardano-mainnet"].nativeCurrency).toEqual({
      symbol: "ADA",
      name: "Cardano",
      decimals: 6,
    });
    expect(cardanoNetworkId("cardano-mainnet")).toBe(1);
    expect(cardanoNetworkId("cardano-preprod")).toBe(0);
    expect(networksForMode("development")).toContain("cardano-preprod");
    expect(networksForMode("development")).not.toContain("cardano-mainnet");
    expect(networksForMode("production")).toContain("cardano-mainnet");
  });
  it("asset ids carry the policy id + asset name unit", () => {
    const unit = "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa4e49474854";
    expect(AssetIdSchema.safeParse(`cardano-mainnet:${unit}`).success).toBe(true);
    expect(AssetIdSchema.safeParse("cardano-preprod:native").success).toBe(true);
    expect(AssetIdSchema.safeParse(`cardano-mainnet:${unit.toUpperCase()}`).success).toBe(false);
    expect(AssetIdSchema.safeParse("cardano-mainnet:abc").success).toBe(false);
    expect(splitCardanoAssetUnit(unit)).toEqual({
      policyId: "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa",
      assetName: "4e49474854",
    });
    const token = {
      id: `cardano-mainnet:${unit}`,
      network: "cardano-mainnet",
      kind: "cardano_token",
      address: unit,
      symbol: "NIGHT",
      name: "NIGHT",
      decimals: 6,
      logoUrl: null,
      verified: false,
    } as const;
    expect(AssetSchema.safeParse(token).success).toBe(true);
    expect(AssetSchema.safeParse({ ...token, kind: "spl" }).success).toBe(false);
    expect(AssetSchema.safeParse(nativeAsset("cardano-preprod")).success).toBe(true);
  });
  it("canonical payloads accept Cardano and lowercase the addresses", () => {
    const payload = createCanonicalPayload({
      version: 1,
      network: "cardano-preprod",
      from: CIP19.type6Test.toUpperCase(),
      to: CIP19.type6Test,
      asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
      amount: "1500000",
      feeCap: "400000",
      plugin: null,
      tool: "app_send",
      pluginData: null,
      nonce: "0123456789abcdef0123456789abcdef",
      expiresAt: "2099-01-01T00:00:00.000Z",
      idempotencyKey: "cardano-key-001",
    });
    expect(payload.from).toBe(CIP19.type6Test);
    expect(() => createCanonicalPayload({ ...payload, to: CIP19.type6 })).toThrow(); // mainnet address on preprod
    expect(() =>
      createCanonicalPayload({
        ...payload,
        asset: { id: "cardano-preprod:native", kind: "native", decimals: 9 },
      }),
    ).toThrow();
  });
});

describe("cardanoUnsignedBodyHash", () => {
  // Minimal well-formed body {0: [], 2: 170000} and its blake2b-256.
  const body = "a20080021a00029810";
  const hash = bytesToHex(blake2b(hexToBytes(body), { dkLen: 32 }));

  it("hashes the body of an unsigned transfer or lock (empty witness set)", () => {
    expect(cardanoUnsignedBodyHash(`84${body}a0f5f6`)).toBe(hash);
    expect(cardanoUnsignedBodyHash(`0x84${body.toUpperCase()}a0f5f6`)).toBe(hash);
  });

  it("hashes the body of an unsigned script spend (redeemers 5 and scripts 7 only)", () => {
    // {5: {[0, 0]: [d87a80, [1, 2]]}, 7: [h'00']}
    const ws = "a205a182000082d87a80820102078141" + "00";
    expect(cardanoUnsignedBodyHash(`84${body}${ws}f5f6`)).toBe(hash);
    expect(cardanoUnsignedBodyHash(`84${body}a1078141 00f5f6`.replace(" ", ""))).toBe(hash);
  });

  it("refuses signed transactions and any other shape", () => {
    const vkeys = "a100d9010281825820" + "11".repeat(32) + "5840" + "22".repeat(64);
    expect(cardanoUnsignedBodyHash(`84${body}${vkeys}f5f6`)).toBeNull(); // key 0: signed
    expect(cardanoUnsignedBodyHash(`84${body}a10180f5f6`)).toBeNull(); // key 1 (native scripts)
    expect(cardanoUnsignedBodyHash(`84${body}a2078141000580f5f6`)).toBeNull(); // keys out of order
    expect(cardanoUnsignedBodyHash(`84${body}a0f5f600`)).toBeNull(); // trailing bytes
    expect(cardanoUnsignedBodyHash(`84${body}a0f4f6`)).toBeNull(); // is_valid false
    expect(cardanoUnsignedBodyHash(`84bf0080ffa0f5f6`)).toBeNull(); // indefinite body
    expect(cardanoUnsignedBodyHash(`8480a0f5f6`)).toBeNull(); // body is not a map
    expect(cardanoUnsignedBodyHash(`84a20080021a0002a0f5f6`)).toBeNull(); // truncated body
    expect(cardanoUnsignedBodyHash("zz")).toBeNull();
  });
});

describe("Masumi escrow lock payloads", () => {
  const escrowAddress = MASUMI_ESCROW_ADDRESSES["cardano-preprod"] ?? "";
  const base = {
    version: 1 as const,
    network: "cardano-preprod" as const,
    from: CIP19.type6Test,
    to: escrowAddress,
    asset: { id: "cardano-preprod:native", kind: "native" as const, decimals: 6 },
    amount: "4000000",
    feeCap: "3000000",
    plugin: "x402",
    tool: "pay_x402" as const,
    pluginData: { escrow: { method: "masumi", escrowAddress } },
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: "masumi-lock-001",
  };

  it("the escrow is a script address, never a valid payment address", () => {
    expect(parseShelleyAddress(escrowAddress)?.payment?.kind).toBe("script");
    expect(isValidAddressForNetwork("cardano-preprod", escrowAddress)).toBe(false);
  });

  it("accepts the canonical escrow address as `to` only for an x402 masumi lock", () => {
    expect(createCanonicalPayload(base).to).toBe(escrowAddress);
    expect(isMasumiEscrowLock(base)).toBe(true);
    const refused = [
      { ...base, plugin: null },
      { ...base, pluginData: null },
      { ...base, pluginData: { escrow: { method: "default", escrowAddress } } },
      { ...base, pluginData: { escrow: { method: "masumi", escrowAddress: CIP19.type6Test } } },
      { ...base, pluginData: { escrow: "masumi" } },
      // Another script address, even when pluginData names it.
      {
        ...base,
        to: "addr_test1wqsztux7j6c23ukjj3328vvxe3yqug43fs9vufysg6ddxpg8xqev4",
        pluginData: {
          escrow: {
            method: "masumi",
            escrowAddress: "addr_test1wqsztux7j6c23ukjj3328vvxe3yqug43fs9vufysg6ddxpg8xqev4",
          },
        },
      },
      // The mainnet escrow on preprod.
      {
        ...base,
        to: MASUMI_ESCROW_ADDRESSES["cardano-mainnet"] ?? "",
        pluginData: {
          escrow: {
            method: "masumi",
            escrowAddress: MASUMI_ESCROW_ADDRESSES["cardano-mainnet"] ?? "",
          },
        },
      },
    ];
    for (const p of refused) expect(() => createCanonicalPayload(p)).toThrow();
    // `from` is never allowed to be the escrow.
    expect(() => createCanonicalPayload({ ...base, from: escrowAddress })).toThrow();
  });
});
