// `npm run report -- addr_test1...`: print the Task result locally, without Sokosumi.
// Reads Blockfrost preprod (BLOCKFROST_API_KEY_PREPROD). Never pays and never writes.
import { createAnswer } from "./report.mjs";

const input = process.argv.slice(2).join(" ");
if (!input.trim()) {
  console.error("Usage: npm run report -- addr_test1...");
  process.exitCode = 2;
} else {
  try {
    console.log(await createAnswer()(input));
  } catch (error) {
    console.error(`Report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
