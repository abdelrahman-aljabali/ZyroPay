#!/usr/bin/env node
/*
 * `pnpm contracts:check`: runs `aiken check` (unit + property tests) for every Aiken project
 * under contracts/, then, when the installed compiler is the pinned one, rebuilds and fails
 * if the committed plutus.json is stale. Without aiken (e.g. CI) it skips and exits 0; the
 * blockchain package tests still assert that plutus.json and the TS constant agree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const candidates = [join(homedir(), ".aiken", "bin", "aiken"), "aiken"];
const aiken = candidates.find((bin) => {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
if (aiken === undefined) {
  console.log("contracts:check skipped: aiken is not installed (https://aiken-lang.org)");
  process.exit(0);
}

const version = execFileSync(aiken, ["--version"], { encoding: "utf8" }).trim();
const contracts = join(root, "contracts");
const projects = existsSync(contracts)
  ? readdirSync(contracts).filter((d) => existsSync(join(contracts, d, "aiken.toml")))
  : [];

let failed = false;
for (const project of projects) {
  const cwd = join(contracts, project);
  const pinned = /compiler = "(v[^"]+)"/.exec(readFileSync(join(cwd, "aiken.toml"), "utf8"))?.[1];
  console.log(`contracts/${project}: aiken check (${version})`);
  try {
    execFileSync(aiken, ["check"], { cwd, stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    console.error(`contracts/${project}: aiken check failed (run it there for details)`);
    failed = true;
    continue;
  }
  if (pinned === undefined || !version.includes(pinned)) {
    console.log(
      `contracts/${project}: compiler is not ${pinned ?? "pinned"}; blueprint not rebuilt`,
    );
    continue;
  }
  const blueprint = join(cwd, "plutus.json");
  const before = existsSync(blueprint) ? readFileSync(blueprint, "utf8") : "";
  execFileSync(aiken, ["build"], { cwd, stdio: ["ignore", "ignore", "inherit"] });
  if (readFileSync(blueprint, "utf8") !== before) {
    console.error(
      `contracts/${project}: plutus.json was stale and has been rebuilt; commit it and regenerate packages/shared/src/cardano-allowance-script.ts`,
    );
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
