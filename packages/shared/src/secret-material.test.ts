import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { api } from "./api/contracts";
import { apiExt } from "./api/ext";
import { mcpInternal } from "./api/internal";
import { apiWallets } from "./api/wallet-management";
import { mcpTools } from "./mcp";
import { findSecretMaterial, isSecretFieldName, looksLikeRecoveryPhrase } from "./secret-material";

/*
 * ADR-003 security test: a recovery phrase or private key goes from the device to
 * Turnkey's import enclave only. No request contract of the ZyroPay API (user, internal,
 * webhook), the MCP worker's internal endpoint or any MCP tool may have a field for one.
 */

// BIP-39 test vectors (Trezor's python-mnemonic vectors.json): public, never real funds.
const TEST_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_24 =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

/** Every property name reachable from a request schema (objects, wrappers, unions, arrays). */
function fieldNames(schema: z.ZodType, seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const out: string[] = [];
  const visit = (s: unknown) => {
    if (s !== undefined && s !== null && typeof s === "object" && "_zod" in s)
      out.push(...fieldNames(s as z.ZodType, seen));
  };
  if (def.type === "object") {
    for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) {
      out.push(key);
      visit(child);
    }
    visit(def.catchall);
  }
  for (const k of ["innerType", "element", "in", "out", "left", "right", "valueType", "keyType"])
    visit(def[k]);
  if (Array.isArray(def.options)) for (const o of def.options) visit(o);
  if (Array.isArray(def.items)) for (const o of def.items) visit(o);
  if (typeof def.getter === "function") visit((def.getter as () => unknown)());
  return out;
}

const requestSchemas: [string, z.ZodType][] = [];
for (const [group, contracts] of Object.entries({ api, apiExt, apiWallets, mcpInternal })) {
  for (const [name, c] of Object.entries(contracts as Record<string, Record<string, unknown>>)) {
    for (const part of ["params", "query", "body"] as const) {
      const s = c[part];
      if (s !== undefined) requestSchemas.push([`${group}.${name}.${part}`, s as z.ZodType]);
    }
  }
}
for (const [name, tool] of Object.entries(mcpTools))
  requestSchemas.push([`mcp.${name}`, tool.input]);

describe("no request contract accepts key material (ADR-003)", () => {
  it("walks every request schema", () => {
    expect(requestSchemas.length).toBeGreaterThan(40);
    expect(fieldNames(apiWallets.createWallet.body)).toContain("turnkeyWalletId");
  });

  it.each(requestSchemas)("%s has no mnemonic / private-key field", (_, schema) => {
    const offending = fieldNames(schema).filter(isSecretFieldName);
    expect(offending).toEqual([]);
  });

  it("strips a smuggled phrase from the wallet registration body", () => {
    const parsed = apiWallets.createWallet.body.parse({
      turnkeyWalletId: "wallet-1",
      network: "solana-devnet",
      idempotencyKey: "import-0123456789abcdef",
      mnemonic: TEST_12,
      privateKey: "0x" + "11".repeat(32),
    });
    expect(JSON.stringify(parsed)).not.toContain("abandon");
    expect(JSON.stringify(parsed)).not.toContain("1111");
  });
});

describe("findSecretMaterial", () => {
  it("flags reserved key names wherever they are nested, reporting only the path", () => {
    for (const key of [
      "mnemonic",
      "seedPhrase",
      "recovery_phrase",
      "privateKey",
      "private-key",
      "solanaPrivateKey",
      "secretKey",
      "encryptedBundle",
      "importBundle",
    ]) {
      const found = findSecretMaterial({ a: [{ b: { [key]: "x" } }] });
      expect(found, key).toEqual({ path: `$.a[0].b.${key}`, reason: "secret_field_name" });
    }
  });

  it("flags a valid BIP-39 phrase in any string field (12 and 24 words, any spacing/case)", () => {
    expect(findSecretMaterial({ memo: TEST_12 })).toEqual({
      path: "$.memo",
      reason: "recovery_phrase_value",
    });
    expect(findSecretMaterial({ list: ["ok", `  ${TEST_24.toUpperCase()}\n`] })?.path).toBe(
      "$.list[1]",
    );
  });

  it("does not flag legitimate data", () => {
    const benign = {
      name: "Travel wallet",
      secret: true, // plugin manifests: "is this config value secret", not a key
      publicKey: "ab".repeat(32),
      signature: "5".repeat(88),
      payloadHash: "f".repeat(64),
      note: "please pay the invoice for the design work we discussed last week thanks",
      // 12 wordlist words with a wrong checksum is not a phrase
      words:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
    };
    expect(findSecretMaterial(benign)).toBeNull();
    expect(looksLikeRecoveryPhrase("abandon about")).toBe(false);
    expect(isSecretFieldName("speed")).toBe(false);
    expect(isSecretFieldName("turnkeyWalletId")).toBe(false);
  });
});
