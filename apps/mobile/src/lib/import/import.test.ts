import { base58 } from "@scure/base";
import { mnemonicToSeed } from "@scure/bip39";
import { CARDANO_TURNKEY_ACCOUNT, networksForMode, type NetworkId } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { EVM_PATH, previewPhraseAddresses, slip10Ed25519, SOLANA_PATH } from "./derive";
import {
  TEST_EVM_KEY,
  TEST_EVM_KEY_ADDRESS,
  TEST_PHRASE_12,
  TEST_PHRASE_12_ADDRESSES,
  TEST_SOLANA_KEY,
} from "./fixtures";
import { checkPhrase, isWordlistWord, splitPhrase, suggestWords } from "./phrase";
import {
  familyCopy,
  importAccounts,
  importFamilies,
  registrationNetwork,
  verifyImport,
} from "./plan";
import { checkPrivateKey, detectKeyFamily, formatExportedKey } from "./private-key";
import { SecretDraft, wipeOnUnmount } from "./secret";

const DEV = networksForMode("development");
const PROD = networksForMode("production");
// Trezor python-mnemonic vectors (public).
const TEST_24 =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
// The 32-byte secret half of TEST_SOLANA_KEY (what Turnkey's export decrypts to).
const TEST_SOLANA_KEY_HEX = Buffer.from(base58.decode(TEST_SOLANA_KEY).slice(0, 32)).toString(
  "hex",
);

describe("phrase validation (BIP-39 wordlist + checksum, @scure/bip39)", () => {
  it("accepts the 12- and 24-word test vectors, normalized", () => {
    const r12 = checkPhrase(TEST_PHRASE_12.toUpperCase().split(" "));
    expect(r12).toEqual({ ok: true, phrase: TEST_PHRASE_12, length: 12 });
    const r24 = checkPhrase(TEST_24.split(" ").map((w) => ` ${w} `));
    expect(r24.ok && r24.length).toBe(24);
  });

  it("names unknown words by position", () => {
    const words = TEST_PHRASE_12.split(" ");
    words[3] = "abandn";
    words[7] = "bitcoin";
    const r = checkPhrase(words);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown_words");
      expect(r.unknown).toEqual([3, 7]);
      expect(r.message).toContain("4, 8");
    }
  });

  it("asks for missing words before checking the checksum", () => {
    const words = TEST_PHRASE_12.split(" ");
    words[11] = "";
    const r = checkPhrase(words);
    expect(!r.ok && r.reason).toBe("incomplete");
  });

  it("rejects valid words with a bad checksum (one word wrong or swapped)", () => {
    const words = TEST_PHRASE_12.split(" ");
    words[11] = "abandon";
    expect(checkPhrase(words)).toMatchObject({ ok: false, reason: "checksum" });
    const swapped = TEST_24.split(" ");
    [swapped[0], swapped[1]] = [swapped[1] ?? "", swapped[0] ?? ""];
    expect(checkPhrase(swapped)).toMatchObject({ ok: false, reason: "checksum" });
  });

  it("rejects lengths other than 12 or 24", () => {
    expect(checkPhrase(TEST_PHRASE_12.split(" ").slice(0, 11))).toMatchObject({
      ok: false,
      reason: "length",
    });
  });

  it("splits pasted text with numbering, commas and newlines", () => {
    expect(splitPhrase("1. Legal\n2) winner, 3: thank  year")).toEqual([
      "legal",
      "winner",
      "thank",
      "year",
    ]);
  });

  it("suggests wordlist words by prefix (local, no keyboard learning)", () => {
    expect(suggestWords("aban")).toEqual(["abandon"]);
    expect(suggestWords("ab").length).toBe(4);
    expect(suggestWords("")).toEqual([]);
    expect(suggestWords("abandon")).toEqual([]);
    expect(isWordlistWord("Zoo")).toBe(true);
    expect(isWordlistWord("zyropay")).toBe(false);
  });
});

describe("local derivation (address preview before anything leaves the device)", () => {
  it("SLIP-10 Ed25519 matches the published test vector 1", () => {
    const seed = Uint8Array.from(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"));
    expect(hex(slip10Ed25519(seed, "m/0'"))).toBe(
      "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
    );
    expect(hex(slip10Ed25519(seed, "m/0'/1'/2'/2'/1000000000'"))).toBe(
      "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793",
    );
    expect(() => slip10Ed25519(seed, "m/0'/1")).toThrow(/hardened/);
  });

  it("derives the addresses Phantom and MetaMask show for the test phrase", async () => {
    expect(await previewPhraseAddresses(TEST_PHRASE_12, ["solana", "evm", "cardano"])).toEqual(
      TEST_PHRASE_12_ADDRESSES,
    );
    expect(await previewPhraseAddresses(TEST_PHRASE_12, ["evm"])).toEqual({
      evm: TEST_PHRASE_12_ADDRESSES.evm,
    });
  });

  it("uses the same paths it asks Turnkey for", () => {
    expect(importAccounts(["solana", "evm"]).map((a) => a.path)).toEqual([SOLANA_PATH, EVM_PATH]);
  });

  it("the seed buffer is a plain Uint8Array that can be zeroed", async () => {
    const seed = await mnemonicToSeed(TEST_PHRASE_12);
    seed.fill(0);
    expect(seed.every((b) => b === 0)).toBe(true);
  });
});

describe("private key validation", () => {
  it("EVM hex (with or without 0x) -> checksummed address", () => {
    expect(checkPrivateKey(TEST_EVM_KEY)).toMatchObject({
      ok: true,
      family: "evm",
      keyFormat: "HEXADECIMAL",
      address: TEST_EVM_KEY_ADDRESS,
    });
    expect(checkPrivateKey(TEST_EVM_KEY.slice(2).toUpperCase())).toMatchObject({
      ok: true,
      privateKey: TEST_EVM_KEY,
    });
  });

  it("refuses the zero key and the curve order", () => {
    expect(checkPrivateKey("0".repeat(64)).ok).toBe(false);
    expect(
      checkPrivateKey("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141").ok,
    ).toBe(false);
  });

  it("Solana base58 keypair -> address; a damaged pair is refused", () => {
    expect(checkPrivateKey(TEST_SOLANA_KEY)).toMatchObject({
      ok: true,
      family: "solana",
      keyFormat: "SOLANA",
      address: TEST_PHRASE_12_ADDRESSES.solana,
    });
    // Flip the last character: still 64 bytes of base58, but the public half no longer matches.
    const last = TEST_SOLANA_KEY.slice(-1) === "i" ? "j" : "i";
    const damaged = `${TEST_SOLANA_KEY.slice(0, -1)}${last}`;
    expect(detectKeyFamily(damaged)).toBe("solana");
    expect(checkPrivateKey(damaged)).toMatchObject({ ok: false });
  });

  it("formats an exported key the way it was imported", () => {
    expect(formatExportedKey(TEST_EVM_KEY.slice(2), "evm")).toBe(TEST_EVM_KEY);
    const solanaSecretHex = Buffer.from(
      Uint8Array.from(Buffer.from(TEST_SOLANA_KEY_HEX, "hex")),
    ).toString("hex");
    expect(formatExportedKey(solanaSecretHex, "solana")).toBe(TEST_SOLANA_KEY);
    expect(() => formatExportedKey("zz", "evm")).toThrow();
  });

  it("explains unknown formats", () => {
    expect(detectKeyFamily(TEST_PHRASE_12)).toBeNull();
    expect(checkPrivateKey("hello").ok).toBe(false);
    expect(checkPrivateKey("").ok).toBe(false);
  });
});

describe("chain selection and the derivation plan", () => {
  it("offers the build's families, from the shared registry", () => {
    expect(importFamilies(DEV)).toEqual(["solana", "evm", "cardano"]);
    expect(importFamilies(PROD).sort()).toEqual(["cardano", "evm", "solana"]);
  });

  it("Cardano uses ZyroPay's ADR-002 account and says it won't match Yoroi/Eternl/Daedalus", () => {
    expect(importAccounts(["cardano"])).toEqual([{ ...CARDANO_TURNKEY_ACCOUNT }]);
    const copy = familyCopy("cardano", DEV);
    expect(copy.caution).toBe(true);
    expect(copy.note).toMatch(/Yoroi, Eternl or Daedalus/);
    expect(familyCopy("solana", DEV).note).toMatch(/Phantom/);
    expect(familyCopy("evm", DEV).note).toMatch(/MetaMask/);
  });

  it("registers with a network of the first chosen family", () => {
    expect(registrationNetwork(["evm", "solana"], DEV)).toBe(
      DEV.find((n) => n.startsWith("ethereum") || n.startsWith("base")) as NetworkId,
    );
    expect(registrationNetwork([], DEV)).toBeNull();
  });

  it("verifies Turnkey's accounts against the local preview, fail closed", () => {
    const chosen = ["solana", "evm", "cardano"] as const;
    const cardanoKey = "ab".repeat(32);
    const good = verifyImport(
      chosen,
      TEST_PHRASE_12_ADDRESSES,
      [
        { family: "solana", address: TEST_PHRASE_12_ADDRESSES.solana },
        { family: "evm", address: TEST_PHRASE_12_ADDRESSES.evm.toLowerCase() },
        { family: "cardano", address: cardanoKey },
      ],
      DEV,
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.addresses[2]?.address).toMatch(/^addr_test1v/);

    const wrong = verifyImport(
      ["evm"],
      TEST_PHRASE_12_ADDRESSES,
      [{ family: "evm", address: TEST_EVM_KEY_ADDRESS }],
      DEV,
    );
    expect(wrong.ok).toBe(false);
    expect(verifyImport(["solana"], TEST_PHRASE_12_ADDRESSES, [], DEV).ok).toBe(false);
    expect(
      verifyImport(["cardano"], {}, [{ family: "cardano", address: "not-a-key" }], DEV).ok,
    ).toBe(false);
  });
});

describe("SecretDraft (in-memory only, wiped)", () => {
  it("holds words and a key, and wipe() clears every slot", () => {
    const d = new SecretDraft();
    d.fillFromText(TEST_PHRASE_12);
    d.setKey(` ${TEST_EVM_KEY} `);
    expect(d.getWords().join(" ")).toBe(TEST_PHRASE_12);
    expect(d.getKey()).toBe(TEST_EVM_KEY);
    const before = d.getWords();
    d.wipe();
    expect(d.isEmpty()).toBe(true);
    expect(d.length).toBe(12);
    // The old array was overwritten too, not just replaced.
    expect(before.every((w) => w === "")).toBe(true);
  });

  it("a 24-word paste switches to 24 fields; typing a space never lands in a word", () => {
    const d = new SecretDraft();
    expect(d.fillFromText(TEST_24)).toBe(24);
    expect(d.length).toBe(24);
    d.setWord(0, "Legal ");
    expect(d.getWord(0)).toBe("legal");
    d.setLength(12);
    expect(d.getWords().join(" ")).toBe(TEST_24.split(" ").slice(0, 12).join(" "));
  });

  it("renders from immutable snapshots (React Compiler memoizes on props)", () => {
    const d = new SecretDraft();
    const s0 = d.getSnapshot();
    d.setKey(TEST_EVM_KEY);
    const s1 = d.getSnapshot();
    expect(s1).not.toBe(s0);
    expect(s0.key).toBe("");
    expect(s1.key).toBe(TEST_EVM_KEY);
    d.setWord(0, "abandon");
    expect(d.getSnapshot().words[0]).toBe("abandon");
    const last = d.getSnapshot();
    d.wipe();
    expect(last.words.every((w) => w === "")).toBe(true);
    expect(d.getSnapshot().key).toBe("");
  });

  it("notifies subscribers, and the unmount cleanup wipes the draft", () => {
    const d = new SecretDraft();
    let renders = 0;
    const unsubscribe = d.subscribe(() => {
      renders += 1;
    });
    d.setWord(0, "abandon");
    const cleanup = wipeOnUnmount(d);
    expect(d.isEmpty()).toBe(false);
    cleanup();
    expect(d.isEmpty()).toBe(true);
    expect(renders).toBe(2);
    unsubscribe();
  });
});
