/* Per-file teardown: release the PGlite instances (WASM heaps) a test file opened. */
import { afterAll } from "vitest";
import { closeTestDbs } from "./helpers";

afterAll(async () => {
  await closeTestDbs();
});
