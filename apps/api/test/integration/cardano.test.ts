/*
 * Cardano through the same pipeline as Solana/EVM (ADR-002), in mock-adapter mode:
 * wallet sync derives the preprod enterprise address from the Turnkey Ed25519 key, the
 * review carries the raw payload (body hash) to stamp, SIGN_RAW_PAYLOAD_V2 is verified and
 * forwarded, MockTurnkey returns a REAL Ed25519 signature that the API verifies before it
 * attaches the witness, then broadcast and confirmation run unchanged. Agents never get
 * autonomous Cardano payments.
 */
import { cardanoEnterpriseAddress, sha256Hex } from "@zyropay/shared";
import { mockPasskeyStamp } from "@zyropay/wallet";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import type { Harness, TestUser } from "../helpers";
import {
  call,
  connectAgent,
  createHarness,
  enableDelegatedSigner,
  setPolicy,
  signUp,
} from "../helpers";

const TK = "https://api.turnkey.com";

const TO = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";
const MAINNET_TO = "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8";

function rawSign(
  credentialId: string,
  opts: { organizationId: string; signWith: string; payload: string; timestampMs: number },
  params: Record<string, unknown> = {},
) {
  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(opts.timestampMs),
    organizationId: opts.organizationId,
    parameters: {
      signWith: opts.signWith,
      payload: opts.payload,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
      ...params,
    },
  });
  return {
    url: `${TK}/public/v1/submit/sign_raw_payload`,
    body,
    stamp: mockPasskeyStamp(credentialId, body),
  };
}

describe("Cardano (preprod, mock adapters)", () => {
  let h: Harness;
  let user: TestUser;
  let publicKey: string;
  let address: string;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h, "ada");
    const account = (await h.turnkey.listWalletAccounts(user.organizationId)).find(
      (a) => a.family === "cardano",
    );
    publicKey = account?.publicKey ?? "";
    address = cardanoEnterpriseAddress(publicKey, "cardano-preprod");
  });

  it("wallet sync stores the preprod enterprise address of the Turnkey Ed25519 key", async () => {
    const wallets = await call(h, "GET", "/v1/wallets", { token: user.accessToken });
    const cardano = wallets.json.wallets[0].addresses.find(
      (a: { family: string }) => a.family === "cardano",
    );
    expect(cardano).toMatchObject({ address, derivationPath: "m/1852'/1815'/0'/0'/0'" });
    expect(address).toMatch(/^addr_test1v/);
    const portfolio = await call(h, "GET", "/v1/portfolio?network=cardano-preprod", {
      token: user.accessToken,
    });
    expect(portfolio.status).toBe(200);
    expect(portfolio.json.portfolio.balances).toEqual([
      expect.objectContaining({
        address,
        amount: "5000000",
        asset: expect.objectContaining({ symbol: "ADA" }),
      }),
    ]);
  });

  it("receive: CIP-13 QR payload and honest warnings", async () => {
    const res = await call(
      h,
      "GET",
      `/v1/receive?walletId=${user.walletId}&network=cardano-preprod`,
      {
        token: user.accessToken,
      },
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      address,
      qrPayload: `web+cardano:${address}`,
      isTestnet: true,
    });
    expect(res.json.warnings.join(" ")).toMatch(/no staking part/);
    const mainnet = await call(
      h,
      "GET",
      `/v1/receive?walletId=${user.walletId}&network=cardano-mainnet`,
      {
        token: user.accessToken,
      },
    );
    expect(mainnet.status).toBeGreaterThanOrEqual(400);
  });

  it("quote -> SIGN_RAW_PAYLOAD over the body hash -> verified witness -> broadcast -> confirmed", async () => {
    const key = `ada-send-${Date.now()}`;
    const quote = await call(h, "POST", "/v1/send/quote", {
      token: user.accessToken,
      idempotencyKey: key,
      body: {
        walletId: user.walletId,
        network: "cardano-preprod",
        to: TO,
        assetId: "cardano-preprod:native",
        amount: "2000000",
        decimals: 6,
        idempotencyKey: key,
      },
    });
    expect(quote.status).toBe(200);
    const review = quote.json.review;
    expect(review.payload.from).toBe(address);
    expect(review.rawPayload).toEqual({
      kind: "cardano_tx_body_hash",
      payload: sha256Hex(
        Uint8Array.from(
          Buffer.from(review.unsignedTransaction.serialized.replace(/^0x/, ""), "hex"),
        ),
      ),
      signWith: publicKey,
    });

    const base = {
      organizationId: user.organizationId,
      signWith: publicKey,
      payload: review.rawPayload.payload,
      timestampMs: h.clock.now().getTime(),
    };
    const submit = (signRequest: unknown) =>
      call(h, "POST", `/v1/send/${review.request.id}/submit`, {
        token: user.accessToken,
        body: { payloadHash: review.payloadHash, signRequest },
      });
    // Wrong payload, wrong key, wrong hash function, wrong activity: all refused before Turnkey.
    const seen: string[] = [];
    for (const bad of [
      rawSign(user.credentialId, { ...base, payload: "ab".repeat(32) }),
      rawSign(user.credentialId, { ...base, signWith: "cd".repeat(32) }),
      rawSign(user.credentialId, base, { hashFunction: "HASH_FUNCTION_NO_OP" }),
      { ...rawSign(user.credentialId, base), url: `${TK}/public/v1/submit/sign_transaction` },
    ]) {
      const res = await submit(bad);
      seen.push(`${res.status} ${res.json.error.code} ${res.json.error.details?.reason}`);
    }
    expect(seen).toEqual([
      "409 PAYLOAD_HASH_MISMATCH PAYLOAD_MISMATCH",
      "409 PAYLOAD_HASH_MISMATCH SIGN_WITH_MISMATCH",
      "409 PAYLOAD_HASH_MISMATCH BODY_MALFORMED",
      "409 PAYLOAD_HASH_MISMATCH URL_NOT_ALLOWED",
    ]);
    const signedBefore = h.turnkey.signed.length;
    const ok = await submit(rawSign(user.credentialId, base));
    expect(ok.status).toBe(200);
    expect(ok.json.request.state).toBe("BROADCAST");
    expect(h.turnkey.signed.length - signedBefore).toBe(1);
    expect(h.turnkey.signed.at(-1)).toMatchObject({
      via: "passkey",
      kind: "raw_payload",
      signWith: publicKey,
    });
    expect(ok.json.request.txHash).toMatch(/^[0-9a-f]{64}$/);
    await h.drain();
    const [row] = await h.db
      .select()
      .from(t.transactionRequests)
      .where(eq(t.transactionRequests.id, review.request.id));
    expect(row?.state).toBe("CONFIRMED");
    expect(row?.txHash).toBe(ok.json.request.txHash);
  });

  it("refuses a mainnet address on preprod", async () => {
    const key = `ada-bad-${Date.now()}`;
    const res = await call(h, "POST", "/v1/send/quote", {
      token: user.accessToken,
      idempotencyKey: key,
      body: {
        walletId: user.walletId,
        network: "cardano-preprod",
        to: MAINNET_TO,
        assetId: "cardano-preprod:native",
        amount: "2000000",
        decimals: 6,
        idempotencyKey: key,
      },
    });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("INVALID_ADDRESS");
  });

  it("agents: Cardano payments always need the passkey, even in autonomous mode", async () => {
    const agentId = await connectAgent(h, user, ["cardano-preprod"]);
    await enableDelegatedSigner(h, user);
    await setPolicy(h, user, agentId, {
      mode: "autonomous",
      spendingEnabled: true,
      recipientAllowlist: [{ family: "cardano", address: TO, label: null }],
      limits: {
        perTransactionUsdMinor: "100000",
        dailyUsdMinor: "100000",
        monthlyUsdMinor: "100000",
      },
    });
    const idempotencyKey = `ada-agent-${Date.now()}`;
    const res = await call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
      internal: true,
      idempotencyKey,
      body: {
        tool: "send",
        input: {
          walletId: user.walletId,
          network: "cardano-preprod",
          to: TO,
          assetId: "cardano-preprod:native",
          amount: "3000000",
          decimals: 6,
          idempotencyKey,
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.request.state).toBe("PENDING_APPROVAL");
    expect(res.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "AUTONOMY_NOT_SUPPORTED",
    );
  });
});
