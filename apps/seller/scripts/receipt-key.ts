/**
 * Derive the seller's receipt signing key (SELLER_SIGNING_KEY) from its wallet.
 *
 *   pnpm --filter @zyropay/seller receipt-key              # the seller (this app)
 *   pnpm --filter @zyropay/seller receipt-key specialist   # apps/specialist's payTo key
 *
 * With `specialist`, the mnemonic is .secrets/specialist.mnemonic, SELLER_ADDRESS is looked
 * up in apps/specialist (env SPECIALIST_ADDRESS, else its .dev.vars, else its wrangler.jsonc)
 * and the key goes to .secrets/specialist.signing-key.
 *
 * Reads apps/seller/.secrets/seller.mnemonic (written by `wallet seller`), derives the
 * payment key exactly as `wallet` derives the address (Evolution SDK, account 0, payment
 * index 0), checks that blake2b-224 of its verification key is the payment credential of
 * SELLER_ADDRESS (env, else apps/seller/.dev.vars, else wrangler.jsonc), and writes the
 * 64-byte BIP32-Ed25519 extended key (hex) to .secrets/seller.signing-key (mode 0600).
 * Prints only the public key and the address: never the key or the mnemonic.
 */
import { Address, KeyHash, PrivateKey, VKey } from "@evolution-sdk/evolution";
import { addressFromSeed, keysFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const role = process.argv[2] === "specialist" ? "specialist" : "seller";
if (process.argv[2] !== undefined && process.argv[2] !== role) {
  console.error("usage: receipt-key [specialist]");
  process.exit(2);
}
const appDir = role === "seller" ? root : join(root, "..", "specialist");
const secretsDir = join(root, ".secrets");
const mnemonicFile = join(secretsDir, `${role}.mnemonic`);
const keyFile = join(secretsDir, `${role}.signing-key`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function sellerAddress(): { value: string; from: string } | null {
  const envName = role === "seller" ? "SELLER_ADDRESS" : "SPECIALIST_ADDRESS";
  const env = process.env[envName]?.trim();
  if (env) return { value: env, from: `${envName} (env)` };
  const pattern = /^\s*"?SELLER_ADDRESS"?\s*[:=]\s*"?(addr_test1[0-9a-z]+)"?/m;
  for (const name of [".dev.vars", "wrangler.jsonc"]) {
    const file = join(appDir, name);
    if (!existsSync(file)) continue;
    const match = pattern.exec(readFileSync(file, "utf8"));
    if (match?.[1]) return { value: match[1], from: name };
  }
  return null;
}

if (!existsSync(mnemonicFile))
  fail(`${mnemonicFile} not found. Run \`pnpm --filter @zyropay/seller wallet ${role}\` first.`);
const mnemonic = readFileSync(mnemonicFile, "utf8").trim();
if (!PrivateKey.validateMnemonic(mnemonic)) fail(`${mnemonicFile} is not a valid mnemonic.`);

const target = sellerAddress();
if (target === null) fail("SELLER_ADDRESS not found (env, .dev.vars or wrangler.jsonc).");

const key = PrivateKey.fromBech32(keysFromSeed(mnemonic).paymentKey);
const vkey = VKey.fromPrivateKey(key);
const keyHash = KeyHash.toHex(KeyHash.fromVKey(vkey));

let credential: string | null = null;
try {
  const payment = Address.fromBech32(target.value).paymentCredential;
  credential = payment instanceof KeyHash.KeyHash ? KeyHash.toHex(payment) : null;
} catch {
  fail(`SELLER_ADDRESS from ${target.from} is not a valid Cardano address.`);
}
if (credential !== keyHash) {
  const derived = Address.toBech32(addressFromSeed(mnemonic, { networkId: 0 }).address);
  fail(
    `The mnemonic's payment key is not the payment key of SELLER_ADDRESS (${target.from}).\n` +
      `  SELLER_ADDRESS: ${target.value}\n  mnemonic address: ${derived}`,
  );
}

writeFileSync(keyFile, `${PrivateKey.toHex(key)}\n`, { mode: 0o600 });
chmodSync(keyFile, 0o600);

console.log(`payTo:      ${target.value} (from ${target.from})`);
console.log(`public key: ${VKey.toHex(vkey)} (blake2b-224 = payment credential ${keyHash})`);
console.log(`signing key saved to ${keyFile} (mode 0600, git-ignored; not printed)`);
console.log(
  role === "seller"
    ? "Deploy it: cd apps/seller && pnpm exec wrangler secret put SELLER_SIGNING_KEY < .secrets/seller.signing-key"
    : "Deploy it: cd apps/specialist && pnpm exec wrangler secret put SELLER_SIGNING_KEY < ../seller/.secrets/specialist.signing-key",
);
