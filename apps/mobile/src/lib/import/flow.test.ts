import {
  IMPORTED_KEY_DERIVATION_PATH,
  isImportedKeyWallet,
  networksForMode,
  type CreateWalletBody,
} from "@zyropay/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "@/api/client";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import {
  simulatedSigner,
  SIMULATED_IMPORT_PREFIX,
  SignerUnavailableError,
} from "@/lib/turnkey/signer";
import { previewPhraseAddresses } from "./derive";
import {
  TEST_EVM_KEY,
  TEST_EVM_KEY_ADDRESS,
  TEST_PHRASE_12,
  TEST_PHRASE_12_ADDRESSES,
} from "./fixtures";
import { importToTurnkey, registerImported, registrationBody, verifyImported } from "./flow";
import { checkPrivateKey } from "./private-key";
import { SecretDraft } from "./secret";

/*
 * ADR-003 end to end in mock mode: SecretDraft -> simulated Turnkey import (public test
 * vectors only) -> verification -> POST /v1/wallets on the mock transport. Every request
 * the app sends is captured and checked for key material.
 */

const DEV = networksForMode("development");
const ORG = "simulated-suborg-0000";

function capturingClient() {
  const sent: string[] = [];
  const inner = mockTransport({ latencyMs: 0 });
  const client = new ApiClient({
    transport: (req) => {
      sent.push(JSON.stringify(req));
      return inner(req);
    },
    getAccessToken: () => "simulated",
  });
  const register = (body: CreateWalletBody) =>
    client.call("createWallet", { body }).then((r) => r.wallet);
  return { client, register, sent };
}

describe("import flow over the mock transport (simulated, test vectors only)", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("phrase -> Solana + EVM + Cardano wallet; the API only ever sees the Turnkey id", async () => {
    const { client, register, sent } = capturingClient();
    const draft = new SecretDraft();
    draft.fillFromText(TEST_PHRASE_12);
    const families = ["solana", "evm", "cardano"] as const;
    const preview = await previewPhraseAddresses(draft.getWords().join(" "), families);
    const plan = { kind: "phrase" as const, families, preview };

    const imported = await importToTurnkey(simulatedSigner(), {
      organizationId: ORG,
      name: "Imported",
      plan,
      secret: () => draft.getWords().join(" "),
    });
    draft.wipe();
    expect(draft.isEmpty()).toBe(true);
    expect(imported.turnkeyWalletId.startsWith(SIMULATED_IMPORT_PREFIX)).toBe(true);

    const verified = verifyImported(plan, imported, DEV);
    expect(verified.ok).toBe(true);

    const wallet = await registerImported(register, plan, imported, "Imported", "import:t1", DEV);
    expect(wallet.name).toBe("Imported");
    const byFamily = Object.fromEntries(wallet.addresses.map((a) => [a.family, a]));
    expect(byFamily.solana?.address).toBe(TEST_PHRASE_12_ADDRESSES.solana);
    expect(byFamily.evm?.address).toBe(TEST_PHRASE_12_ADDRESSES.evm);
    expect(byFamily.cardano?.address).toMatch(/^addr_test1v/);
    expect(isImportedKeyWallet(wallet)).toBe(false);

    const list = await client.call("listWallets", {});
    expect(list.wallets.some((w) => w.id === wallet.id)).toBe(true);
    for (const req of sent) {
      expect(req).not.toContain("abandon");
      expect(req).not.toMatch(/mnemonic|privateKey|encryptedBundle/i);
    }
  });

  it("private key -> one-account wallet marked as an imported key", async () => {
    const { register, sent } = capturingClient();
    const checked = checkPrivateKey(TEST_EVM_KEY);
    if (!checked.ok) throw new Error("fixture");
    const plan = { kind: "key" as const, family: checked.family, address: checked.address };
    const imported = await importToTurnkey(simulatedSigner(), {
      organizationId: ORG,
      name: "Old key",
      plan,
      secret: () => checked.privateKey,
    });
    expect(verifyImported(plan, imported, DEV).ok).toBe(true);
    const wallet = await registerImported(register, plan, imported, undefined, "import:t2", DEV);
    expect(wallet.addresses).toEqual([
      expect.objectContaining({
        family: "evm",
        address: TEST_EVM_KEY_ADDRESS,
        derivationPath: IMPORTED_KEY_DERIVATION_PATH,
      }),
    ]);
    expect(isImportedKeyWallet(wallet)).toBe(true);
    for (const req of sent) expect(req).not.toContain(TEST_EVM_KEY.slice(2, 20));
  });

  it("the simulated signer refuses anything but the public test vectors", async () => {
    const signer = simulatedSigner();
    const words = TEST_PHRASE_12.split(" ");
    words[11] = "abandon";
    await expect(
      signer.importWallet({
        organizationId: ORG,
        name: "x",
        mnemonic: words.join(" "),
        families: ["evm"],
      }),
    ).rejects.toBeInstanceOf(SignerUnavailableError);
    await expect(
      signer.importPrivateKey({
        organizationId: ORG,
        name: "x",
        privateKey: `0x${"11".repeat(32)}`,
        family: "evm",
      }),
    ).rejects.toBeInstanceOf(SignerUnavailableError);
  });

  it("a mismatch between Turnkey and the device's preview is never registered", () => {
    const checked = checkPrivateKey(TEST_EVM_KEY);
    if (!checked.ok) throw new Error("fixture");
    const plan = { kind: "key" as const, family: "evm" as const, address: checked.address };
    const tampered = {
      turnkeyWalletId: `${SIMULATED_IMPORT_PREFIX}x`,
      accounts: [{ family: "evm" as const, address: TEST_PHRASE_12_ADDRESSES.evm }],
    };
    expect(verifyImported(plan, tampered, DEV).ok).toBe(false);
  });

  it("the registration body is exactly id + network + name + idempotency key", () => {
    const plan = {
      kind: "phrase" as const,
      families: ["evm", "solana"] as const,
      preview: TEST_PHRASE_12_ADDRESSES,
    };
    const body = registrationBody(
      plan,
      { turnkeyWalletId: "tk-1", accounts: [] },
      "Imported",
      "import:t3",
      DEV,
    );
    expect(Object.keys(body).sort()).toEqual([
      "idempotencyKey",
      "name",
      "network",
      "turnkeyWalletId",
    ]);
    expect(body.network).not.toMatch(/solana|cardano/);
  });
});
