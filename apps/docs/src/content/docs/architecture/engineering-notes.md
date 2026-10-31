---
title: "Engineering notes"
description: "Two CPU problems found on Cloudflare Workers while running Masumi escrow live, and how each was fixed: a byte-level datum prefilter for the seller's sweeper, and a precomputed escrow script for the Evolution SDK."
---

Cloudflare Workers limit CPU time per invocation, not wall time: waiting on Blockfrost is free,
decoding Plutus data is not. Both problems below appeared only on Workers, under live preprod data,
and neither showed up in tests on Node. Each fix keeps the original code as the decider and only
skips work whose answer is already known.

## The seller's sweeper: 1.2–2 s to 40–80 ms per sweep

**Symptom.** The demo seller's cron sweeper runs every minute (`apps/seller/src/escrow/sweeper.ts`):
it retries SubmitResult, withdraws after `unlockTime` and decides refund requests. `wrangler tail`
on the cron events showed 874–2,050 ms of CPU per sweep, and one sweep in five ended in
`exceededCpu`. It still collected the live escrow (the [Withdraw](/evidence/#sellers-withdraw)
landed 39 s after unlock) because most sweeps still finished.

**Cause.** Masumi's `vested_pay` escrow address is shared by every seller. Each sweep fetched the
UTxOs at that address and fully decoded all of their inline datums, about 300 of them, nearly all
other sellers' escrows, at about 2 ms each.

**Fix.** Before decoding, the sweeper checks the raw datum hex for our 28-byte payment key hash as a
CBOR byte string (header `0x581c` followed by the hash: `datumMentionsKeyHash` in
`apps/seller/src/escrow/datum.ts`). A datum that names us as seller must contain those bytes, so the
check is a necessary condition and never drops one of our escrows. A match still goes through the
full parse, which decides; a foreign datum that happens to contain the bytes (for example, one naming
us as buyer) is rejected there as before.

| Build                                      | CPU per sweep (ms, five cron events) | Outcome                   |
| ------------------------------------------ | ------------------------------------ | ------------------------- |
| Before (the version that ran the Withdraw) | 1317, 1377, 2050, 1181, 874          | one of five `exceededCpu` |
| After the prefilter (version `ed6a33ce`)   | 60, 37, 56, 37, 81                   | all `ok`                  |

Wall time per sweep is still 0.3–1.9 s, dominated by Blockfrost round trips, which do not count
against the CPU limit.

## Deriving the escrow address: over 2 s of CPU to a constant

**Symptom.** Masumi escrow requests (a 402 quote on the seller; the terms check and lock build on the
API) were killed for exceeding the CPU limit; on the seller, the first one in every isolate.

**Cause.** `@x402/cardano` derives the Masumi escrow address on every masumi quote and lock
(`verifyMasumiAuthorization`, `buildMasumiLock`) by applying the canonical deployment parameters to
the 10 kB `vested_pay` script, through the Evolution SDK's `UPLC.applyParamsToScript`. Evolution does
that through Effect Schema: about 0.5 s of CPU in Node and over 2 s on Workers.

**Fix.** The result is a constant: the parameters are Masumi's canonical deployment, and the applied
script is the one the escrow address hashes. The Worker builds of the API and the seller alias
`@evolution-sdk/evolution` (`alias` in `wrangler.jsonc`) to a thin wrapper
(`apps/api/src/evolution/index.ts`, `apps/seller/src/evolution.ts`) that re-exports the real package
unchanged, except that `applyParamsToScript` returns the precomputed applied script when, and only
when, it is called with the exact unapplied `vested_pay` v2 script, the exact canonical parameters
and no options. Any other input goes to the real function.

- The shortcut is tested against the real computation (`apps/api/test/integration/evolution-shim.test.ts`,
  `apps/seller/test/evolution-shim.test.ts`), so a change in Evolution, `@x402/cardano` or the
  script fails the build instead of producing a wrong address.
- Tests and Node scripts import the real package; only the Worker bundles use the wrapper.
- The seller also derives its escrow address on first use rather than at module scope
  (`apps/seller/src/escrow/runtime.ts`), so the cost never lands in the Worker's startup budget.

## What these have in common

- Measure on the platform. Node was fast enough in both cases; Workers' CPU accounting was not.
- Keep the expensive, correct code as the decider. The prefilter only rejects what cannot match;
  the shim only answers the one input whose answer is fixed, and a test proves it equal.
- Shared on-chain state grows with other people's use. A scan that is cheap with our own three
  escrows is not cheap at a shared address with hundreds.
