/**
 * Safety-net BUYER: pays the seller once via x402 (@x402/fetch + the reference Cardano
 * signer) and prints the report and the settlement transaction.
 *
 *   pnpm --filter @zyropay/seller buy --yes [--address addr_test1...]
 *
 * THIS SPENDS TEST FUNDS (price + network fee, from the buyer wallet). It refuses to run
 * without --yes. Spend controls allow only lovelace, at most 3 tADA per payment.
 *
 * Env (apps/seller/.env is loaded when present):
 *   SELLER_URL             e.g. https://address-intel.zyropay.online (or http://localhost:8790)
 *   BLOCKFROST_PROJECT_ID  preprod project id (the buyer reads its UTxOs through Blockfrost)
 *   BUYER_MNEMONIC         optional; default: the contents of .secrets/buyer.mnemonic
 * --address defaults to the buyer's own address.
 */
import { toClientCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NETWORK = "cardano:preprod";
const MAX_LOVELACE_PER_PAYMENT = "3000000";
const BLOCKFROST_BASE_URL = "https://cardano-preprod.blockfrost.io/api/v0";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!args.includes("--yes")) {
  fail(
    "buy spends test ADA (price + fee) from the buyer wallet. Re-run with --yes to proceed.\n" +
      "Check https://preprod.cardanoscan.io first if a previous attempt may still be pending.",
  );
}

const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const sellerUrl = process.env.SELLER_URL?.trim().replace(/\/+$/, "");
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim();
if (!sellerUrl) fail("Set SELLER_URL (the seller's base URL).");
if (!projectId?.startsWith("preprod")) fail("Set BLOCKFROST_PROJECT_ID to a preprod project id.");

const mnemonicFile = join(root, ".secrets", "buyer.mnemonic");
const mnemonic =
  process.env.BUYER_MNEMONIC?.trim() ||
  (existsSync(mnemonicFile) ? readFileSync(mnemonicFile, "utf8").trim() : "");
if (!mnemonic) fail("Set BUYER_MNEMONIC or run `pnpm --filter @zyropay/seller wallet buyer`.");

const signer = toClientCardanoSigner({
  mnemonic,
  network: NETWORK,
  provider: { blockfrost: { baseUrl: BLOCKFROST_BASE_URL, projectId } },
});
const addressFlag = args.indexOf("--address");
const target = addressFlag >= 0 ? args[addressFlag + 1] : signer.getAddress();
if (!target) fail("--address needs a value");

// lovelace is not USD-pegged, so the default spend controls would refuse it: allow it
// explicitly and cap it.
const client = new x402Client().setSpendControls({
  allowedAssets: [
    { network: "cardano:*", asset: "lovelace", maxAmountPerPayment: MAX_LOVELACE_PER_PAYMENT },
  ],
});
client.register("cardano:*", new ExactCardanoScheme(signer));

const url = `${sellerUrl}/v1/address-report?address=${encodeURIComponent(target)}`;
console.log(`buyer wallet: ${signer.getAddress()}`);
console.log(`GET ${url}`);
console.log("(on 402 this signs and the facilitator settles a real preprod payment: 20-90 s)");

const started = Date.now();
const response = await wrapFetchWithPayment(fetch, client)(url, {
  method: "GET",
  headers: { accept: "application/json" },
});
console.log(`\nHTTP ${response.status} after ${((Date.now() - started) / 1000).toFixed(1)} s`);

const text = await response.text();
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text.slice(0, 2000));
}

if (response.headers.get("payment-response") !== null) {
  const receipt = new x402HTTPClient(client).getPaymentSettleResponse((name) =>
    response.headers.get(name),
  );
  console.log("\nPAYMENT-RESPONSE:", JSON.stringify(receipt, null, 2));
  if (receipt.transaction) {
    console.log(`tx id: ${receipt.transaction}`);
    console.log(`https://preprod.cardanoscan.io/transaction/${receipt.transaction}`);
  }
} else {
  console.log("\n(no PAYMENT-RESPONSE header)");
}
if (!response.ok) process.exit(1);
