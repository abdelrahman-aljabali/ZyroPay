/*
 * The Worker build's "@evolution-sdk/evolution" (wrangler.jsonc `alias`): the real package,
 * unchanged, except that UPLC.applyParamsToScript answers the one call this worker makes on
 * the request path from a precomputed result.
 *
 * @x402/cardano derives the Masumi escrow address (402 issuance, route checks, facilitator
 * verify) by applying the canonical deployment parameters to the 10 kB vested_pay script.
 * Evolution does that through Effect Schema: ~0.5 s CPU in Node and over 2 s on Cloudflare,
 * which exceeds the Worker's CPU limit on the first escrow request of every isolate. The result
 * is a constant: CBOR-wrapped VESTED_PAY_V2_APPLIED_HEX. Any other input goes to the real
 * function. test/evolution-shim.test.ts checks the shortcut against the real computation.
 *
 * Tests (vitest) and the Node scripts import the real package directly.
 */
import { Data, UPLC as RealUPLC } from "@evolution-sdk/evolution/index";
import { VESTED_PAY_V2_APPLIED_HEX, VESTED_PAY_V2_UNAPPLIED_HEX } from "./escrow/script";

export * from "@evolution-sdk/evolution/index";

/** CBOR of [2, [admin vkey hashes], 420000]: MASUMI_DEFAULT_DEPLOYMENT as applied params. */
export const CANONICAL_PARAMS_CBOR =
  "9f029f581cfc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75581c7f78161369549d8e2b138fee724c9fa606d6107a66720bdb4c48ada6581c89eef9ea84e0ee7fe4921fa93eb2873ff6e34473f751d5d52cb75aa6ff1a000668a0ff";

/** applyParamsToScript's result: a CBOR byte string (0x59 0x2713) around the 10003 bytes. */
export const CANONICAL_APPLIED_CBOR = `592713${VESTED_PAY_V2_APPLIED_HEX}`;

const applyParamsToScript: typeof RealUPLC.applyParamsToScript = (script, params, options) => {
  if (
    options === undefined &&
    script === VESTED_PAY_V2_UNAPPLIED_HEX &&
    Data.toCBORHex(Data.list([...params])) === CANONICAL_PARAMS_CBOR
  )
    return CANONICAL_APPLIED_CBOR;
  return RealUPLC.applyParamsToScript(script, params, options);
};

export const UPLC: typeof RealUPLC = { ...RealUPLC, applyParamsToScript };
