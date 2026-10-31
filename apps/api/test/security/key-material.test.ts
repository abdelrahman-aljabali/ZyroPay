/*
 * ADR-003: a recovery phrase or private key travels from the device to Turnkey's import
 * enclave only. The API must refuse any request that carries one, on every endpoint,
 * before anything is stored or logged; and an imported wallet is linked only by its
 * Turnkey id, re-read from the user's own sub-organization.
 */
import {
  api,
  apiExt,
  apiWallets,
  buildPath,
  IMPORTED_KEY_DERIVATION_PATH,
  sha256Hex,
  type EndpointContract,
} from "@zyropay/shared";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import type { Logger } from "../../src/lib/logger";
import type { Harness, TestUser } from "../helpers";
import { call, createHarness, signUp } from "../helpers";

// BIP-39 test vector: public, never holds funds.
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HEX_KEY = `0x${"4c".repeat(32)}`;
const key = (label: string) => `${label}-${sha256Hex(String(Math.random())).slice(0, 16)}`;
const UUID = "0192f3a1-0000-7000-8000-000000000001";

function withBody(): [string, EndpointContract][] {
  const all = { ...api, ...apiExt, ...apiWallets } as Record<string, EndpointContract>;
  return Object.entries(all).filter(
    ([, c]) => c.body !== undefined && c.auth !== "webhook" && c.method !== "GET",
  );
}

function pathFor(c: EndpointContract): string {
  const names = [...c.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] ?? "");
  // Valid params, so the request reaches the body check (params are parsed first).
  return buildPath(
    c.path,
    Object.fromEntries(names.map((n) => [n, n === "pluginId" ? "jupiter" : UUID])),
  );
}

describe("the API refuses recovery phrases and private keys (ADR-003)", () => {
  let h: Harness;
  let user: TestUser;
  const logged: string[] = [];

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h, "keys");
    const capture: Logger = {
      info: (e, f) => logged.push(JSON.stringify({ e, f })),
      warn: (e, f) => logged.push(JSON.stringify({ e, f })),
      error: (e, f) => logged.push(JSON.stringify({ e, f })),
    };
    (h.deps as { logger: Logger }).logger = capture;
  });

  const endpoints = withBody();

  it("covers every endpoint with a request body", () => {
    expect(endpoints.length).toBeGreaterThan(15);
  });

  it.each(endpoints)(
    "%s refuses a `mnemonic` / `privateKey` field and a phrase value",
    async (_, c) => {
      const auth =
        c.auth === "user"
          ? { token: user.accessToken }
          : c.auth === "internal"
            ? { internal: true }
            : {};
      for (const body of [
        { mnemonic: PHRASE },
        { privateKey: HEX_KEY },
        { wallet: { seed_phrase: "x" } },
        { name: PHRASE, idempotencyKey: key("p") },
      ]) {
        const idem = key("k");
        const res = await call(h, c.method, pathFor(c), { ...auth, body, idempotencyKey: idem });
        expect(res.status, `${c.method} ${c.path} ${Object.keys(body).join(",")}`).toBe(400);
        expect(res.json.error.code).toBe("BAD_REQUEST");
        expect(JSON.stringify(res.json)).not.toContain("abandon");
      }
    },
  );

  it("never logs or stores the secret", async () => {
    expect(logged.some((l) => l.includes("request.secret_material_refused"))).toBe(true);
    for (const line of logged) {
      expect(line).not.toContain("abandon");
      expect(line).not.toContain("4c4c4c");
      expect(line).not.toContain("seed_phrase");
    }
    const audits = await h.db
      .select({ metadata: t.auditLogs.metadata })
      .from(t.auditLogs)
      .where(eq(t.auditLogs.userId, user.userId));
    expect(JSON.stringify(audits)).not.toContain("abandon");
    const wallets = await h.db.select().from(t.wallets).where(eq(t.wallets.userId, user.userId));
    expect(JSON.stringify(wallets)).not.toContain("abandon");
  });
});

describe("linking an imported wallet (ADR-003)", () => {
  let h: Harness;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    alice = await signUp(h, "alice");
    bob = await signUp(h, "bob");
  });

  const link = (u: TestUser, body: Record<string, unknown>) => {
    const idempotencyKey = key("import");
    return call(h, "POST", "/v1/wallets", {
      token: u.accessToken,
      body: { idempotencyKey, ...body },
      idempotencyKey,
    });
  };

  it("an imported phrase is an ordinary HD wallet: all its chosen accounts are linked", async () => {
    // What Turnkey's IMPORT_WALLET leaves in the sub-org: one wallet with the accounts the
    // user picked (here Solana + EVM + Cardano).
    const imported = h.turnkey.createWallet(alice.organizationId, {
      name: "Imported",
      families: ["solana", "evm", "cardano"],
    });
    const res = await link(alice, {
      turnkeyWalletId: imported.turnkeyWalletId,
      network: "solana-devnet",
    });
    expect(res.status).toBe(200);
    expect(res.json.wallet.addresses.map((a: { family: string }) => a.family).sort()).toEqual([
      "cardano",
      "evm",
      "solana",
    ]);
  });

  it("links an imported private key by its Turnkey id, as a one-account wallet", async () => {
    const pk = h.turnkey.importPrivateKey(alice.organizationId, { family: "evm", name: "Old key" });
    const res = await link(alice, { turnkeyWalletId: pk.privateKeyId, network: "base-sepolia" });
    expect(res.status).toBe(200);
    expect(res.json.wallet.name).toBe("Old key");
    expect(res.json.wallet.addresses).toHaveLength(1);
    expect(res.json.wallet.addresses[0]).toMatchObject({
      family: "evm",
      address: pk.address,
      derivationPath: IMPORTED_KEY_DERIVATION_PATH,
    });
  });

  it("refuses a private key of another family for the chosen network", async () => {
    const pk = h.turnkey.importPrivateKey(alice.organizationId, { family: "solana" });
    const res = await link(alice, { turnkeyWalletId: pk.privateKeyId, network: "base-sepolia" });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("NETWORK_NOT_SUPPORTED");
  });

  it("bob cannot link alice's imported key (not in his sub-org)", async () => {
    const pk = h.turnkey.importPrivateKey(alice.organizationId, { family: "solana" });
    const res = await link(bob, { turnkeyWalletId: pk.privateKeyId, network: "solana-devnet" });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("FORBIDDEN");
  });
});
