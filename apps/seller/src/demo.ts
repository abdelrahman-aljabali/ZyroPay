/*
 * "Dishonest seller" demo switch, for demonstrating Masumi escrow refunds on preprod.
 *
 * OFF unless BOTH hold:
 *   1. the worker has DEMO_DISHONEST_MODE=enabled (exact value), and
 *   2. the ESCROW route is requested with `?demo=tamper` or `?demo=nodelivery`.
 * Every response of a demo request carries `X-Demo-Mode: <mode>` (the 402 included, so a
 * buyer sees it before paying), and the parameter is part of the paid URL, so it is also in
 * the seller-signed input commitment. `demo` on the default route, an unknown value, or any
 * value while the switch is off is a 400: a request can never silently fall back to honest
 * (or dishonest) behaviour.
 *
 *  - tamper:     the seller records sha256(real report) on chain (X-Escrow-Result-Hash,
 *                SubmitResult) but delivers DIFFERENT bytes. The delivery receipt signs what
 *                was actually delivered, so receipt.contentSha256 != the on-chain result hash.
 *  - nodelivery: the lock settles, but the seller withholds the report and never submits a
 *                result; the buyer refunds after submit_result_time (or requests one).
 */

export const DEMO_HEADER = "X-Demo-Mode";
export const DEMO_MODES = ["tamper", "nodelivery"] as const;
export type DemoMode = (typeof DEMO_MODES)[number];

export function demoEnabled(raw: string | undefined): boolean {
  return raw?.trim() === "enabled";
}

export type DemoCheck =
  | { readonly ok: true; readonly mode: DemoMode | null }
  | { readonly ok: false; readonly error: string };

/** The demo mode a request asks for (`values` = every `demo` query value). */
export function checkDemo(
  values: readonly string[],
  enabled: boolean,
  escrowRoute: boolean,
): DemoCheck {
  if (values.length === 0) return { ok: true, mode: null };
  if (values.length > 1) return { ok: false, error: "pass at most one 'demo'" };
  if (!escrowRoute)
    return {
      ok: false,
      error: "'demo' applies only to the escrow route (/v1/address-report/escrow)",
    };
  if (!enabled) return { ok: false, error: "demo modes are disabled on this seller" };
  const mode = DEMO_MODES.find((m) => m === values[0]);
  if (mode === undefined)
    return { ok: false, error: `'demo' must be one of: ${DEMO_MODES.join(", ")}` };
  return { ok: true, mode };
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(new TextEncoder().encode(text));

/** tamper: a well-formed report whose bytes differ from the one hashed on chain. */
export function tamperedBody(real: Uint8Array): Uint8Array<ArrayBuffer> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(real)) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return utf8(
    JSON.stringify({
      ...parsed,
      riskFlags: [],
      riskScore: 0,
      demo: {
        mode: "tamper",
        note: "DEMO: these bytes are NOT the report whose hash this seller put on chain.",
      },
    }),
  );
}

/** nodelivery: what the buyer gets instead of the report. */
export function withheldBody(): Uint8Array<ArrayBuffer> {
  return utf8(
    JSON.stringify({
      delivered: false,
      demo: {
        mode: "nodelivery",
        note: "DEMO: the seller took the escrow lock and withheld the report; no result will be submitted. Request a refund.",
      },
    }),
  );
}
