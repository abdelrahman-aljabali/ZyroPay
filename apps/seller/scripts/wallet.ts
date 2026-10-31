/**
 * Generate a Cardano PREPROD wallet for the seller (payTo), a test buyer, the Token
 * Intelligence specialist (apps/specialist payTo) or the seller's sub-hire budget wallet.
 *
 *   pnpm --filter @zyropay/seller wallet seller      # -> .secrets/seller.mnemonic
 *   pnpm --filter @zyropay/seller wallet buyer       # -> .secrets/buyer.mnemonic
 *   pnpm --filter @zyropay/seller wallet specialist  # -> .secrets/specialist.mnemonic
 *   pnpm --filter @zyropay/seller wallet subhire     # -> .secrets/subhire.mnemonic (SELLER_BUYER_MNEMONIC)
 *
 * The mnemonic is written ONLY to apps/seller/.secrets/<role>.mnemonic (git-ignored, mode
 * 0600) and never printed. Only the address is printed. An existing file is never
 * overwritten: delete it yourself if you really mean to discard that wallet.
 */
import { Address, PrivateKey } from "@evolution-sdk/evolution";
import { addressFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = ["seller", "buyer", "specialist", "subhire"] as const;
const role = ROLES.find((r) => r === process.argv[2]);
if (role === undefined) {
  console.error(`usage: wallet <${ROLES.join("|")}>`);
  process.exit(2);
}

const secretsDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".secrets");
const file = join(secretsDir, `${role}.mnemonic`);
if (existsSync(file)) {
  console.error(`${file} already exists; refusing to overwrite a wallet. Delete it first.`);
  process.exit(1);
}

const mnemonic = PrivateKey.generateMnemonic(256);
// Same derivation as @x402/cardano's toClientCardanoSigner (Evolution SDK withSeed, account 0).
const address = Address.toBech32(addressFromSeed(mnemonic, { networkId: 0 }).address);

mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
writeFileSync(file, `${mnemonic}\n`, { mode: 0o600, flag: "wx" });

console.log(`${role} preprod address: ${address}`);
console.log(`mnemonic saved to ${file} (mode 0600, git-ignored; back it up offline)`);
if (role === "seller") console.log("Set SELLER_ADDRESS to this address.");
else if (role === "specialist")
  console.log("Set SELLER_ADDRESS in apps/specialist/wrangler.jsonc (and SPECIALIST_PAY_TO here).");
else console.log("Fund it with test ADA: https://docs.cardano.org/cardano-testnets/tools/faucet");
