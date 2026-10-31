/*
 * HTTP side of the escrow route.
 *
 *  - `admitQuoteMiddleware` (before @x402/hono): a paid retry's Masumi quote, if provably
 *    ours (terms.ts checkPaidQuote), is admitted into the scheme's quote store so the retry
 *    verifies on any isolate.
 *  - `escrowDeliveryMiddleware` (inside the receipt middleware, outside @x402/hono): once
 *    the lock has settled and the report is served, the result hash is fixed as
 *    sha256(exact body bytes) — the same value the delivery receipt signs as contentSha256 —
 *    and sent in X-Escrow-Result-Hash. The record goes to KV and the SubmitResult runs after
 *    the response (ctx.waitUntil); the cron sweeper retries it if the lock is not yet on
 *    chain.
 *  - Demo modes (src/demo.ts, off by default): `tamper` records the real hash but delivers
 *    other bytes; `nodelivery` withholds the report and records / submits nothing.
 */
import type { MasumiTermsStorage, CardanoExtraMasumi } from "@x402/cardano";
import { isMasumiExtra } from "@x402/cardano";
import type { PaymentRequirements } from "@x402/core/types";
import type { Context, MiddlewareHandler } from "hono";
import { ASSET, NETWORK } from "../config";
import type { DemoMode } from "../demo";
import { tamperedBody, withheldBody } from "../demo";
import { settledTransaction, sha256Hex } from "../receipt";
import type { EscrowRuntime } from "./runtime";
import { escrowAddress } from "./runtime";
import type { EscrowRecord } from "./store";
import { submitResultSoon } from "./sweeper";
import { admitPaidQuote, checkPaidQuote } from "./terms";

export const ESCROW_RESULT_HEADER = "X-Escrow-Result-Hash";
export const ESCROW_ID_HEADER = "X-Escrow-Id";
const ESCROW_STATUS_HEADER = "X-Escrow-Status";
export const ESCROW_STATUS_PATH = "/v1/escrow";

type Enabled = Extract<EscrowRuntime, { enabled: true }>;
type Defer = (c: Context, task: Promise<unknown>) => void;

function decodePayment(header: string | undefined): { accepted?: PaymentRequirements } | null {
  if (header === undefined || header === "") return null;
  try {
    return JSON.parse(atob(header)) as { accepted?: PaymentRequirements };
  } catch {
    return null;
  }
}

export function admitQuoteMiddleware(
  rt: Enabled,
  storage: MasumiTermsStorage,
  now: () => Date,
): MiddlewareHandler<{ Variables: { masumiQuote?: PaymentRequirements } }> {
  return async (c, next) => {
    const accepted = decodePayment(c.req.header("PAYMENT-SIGNATURE"))?.accepted;
    if (accepted !== undefined && isMasumiExtra(accepted.extra)) {
      const problem = await checkPaidQuote(accepted, {
        sellerAddress: rt.seller.address,
        payTo: escrowAddress(),
        network: NETWORK,
        asset: ASSET,
        amount: rt.config.priceLovelace,
        maxTimeoutSeconds: rt.config.maxTimeoutSeconds,
        resourceUrl: c.req.url,
        nowMs: now().getTime(),
        agentIdentifier: rt.config.agentIdentifier,
      });
      if (problem === null) {
        await admitPaidQuote(storage, accepted);
        c.set("masumiQuote", accepted);
      } else {
        // The payment layer answers (402); log the rule only.
        console.warn(`[seller] escrow quote not admitted: ${problem}`);
      }
    }
    await next();
  };
}

export function escrowDeliveryMiddleware(
  rt: Enabled,
  defer: Defer,
  now: () => Date,
): MiddlewareHandler<{
  Variables: { masumiQuote?: PaymentRequirements; demoMode?: DemoMode | null };
}> {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status !== 200) return;
    const lockTx = settledTransaction(res.headers.get("PAYMENT-RESPONSE"));
    const quote = c.get("masumiQuote");
    if (typeof lockTx !== "string" || quote === undefined) return;
    const extra = quote.extra as unknown as CardanoExtraMasumi;
    const real = new Uint8Array(await res.arrayBuffer());
    const demo = c.get("demoMode") ?? null;
    const headers = new Headers(res.headers);
    headers.set(ESCROW_ID_HEADER, extra.blockchainIdentifier);
    headers.set(
      ESCROW_STATUS_HEADER,
      `${new URL(c.req.url).origin}${ESCROW_STATUS_PATH}/${lockTx}`,
    );
    if (demo === "nodelivery") {
      // DEMO: keep the lock, deliver nothing, submit nothing (no record either).
      headers.delete("content-length");
      c.res = undefined;
      c.res = new Response(withheldBody(), { status: 200, headers });
      console.warn(`[seller] DEMO nodelivery: escrow ${lockTx} gets no result`);
      return;
    }
    const resultHash = await sha256Hex(real);
    // DEMO tamper: the hash above (of the real report) goes on chain; other bytes go out.
    const body = demo === "tamper" ? tamperedBody(real) : real;
    if (demo === "tamper") console.warn(`[seller] DEMO tamper: escrow ${lockTx} body != result`);
    const record: EscrowRecord = {
      lockTx,
      sellerNonce: extra.terms.sellerNonce,
      blockchainIdentifier: extra.blockchainIdentifier,
      resultHash,
      resourceUrl: c.req.url,
      createdAt: now().toISOString(),
    };
    headers.set(ESCROW_RESULT_HEADER, resultHash);
    if (body !== real) headers.delete("content-length");
    c.res = undefined;
    c.res = new Response(body, { status: res.status, statusText: res.statusText, headers });
    defer(
      c,
      (async () => {
        await rt.store.put(record);
        const outcome = await submitResultSoon(rt.sweepDeps(), record);
        console.log(
          `[seller] escrow ${lockTx}: ${outcome.txHash ? `SubmitResult ${outcome.txHash}` : (outcome.error ?? outcome.reason ?? "no action")}`,
        );
      })().catch((err: unknown) => {
        console.error(
          "[seller] escrow follow-up failed:",
          err instanceof Error ? err.name : "unknown",
        );
      }),
    );
  };
}
