/*
 * Cardano Token Intelligence: the Hono app. Same payment stack as Address Intelligence
 * (apps/seller), imported from it: config rules, the embedded @x402/cardano facilitator and
 * the signed X-Delivery-Receipt. One paid route, x402 `exact` on cardano:preprod.
 */
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import type { FacilitatorClient } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import { DataSourceError } from "@zyropay/seller/blockfrost";
import type { Config, Env as SellerEnv } from "@zyropay/seller/config";
import { ASSET, loadConfig, MAX_TIMEOUT_SECONDS, NETWORK } from "@zyropay/seller/config";
import { embeddedFacilitator } from "@zyropay/seller/facilitator";
import { loadReceiptSigner, RECEIPT_HEADER, receiptMiddleware } from "@zyropay/seller/receipt";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { TokenBlockfrost } from "./blockfrost";
import { computeTokenReport } from "./report";
import type { TokenQuery } from "./unit";
import { checkUnit } from "./unit";

const SERVICE_NAME = "Cardano Token Intelligence";
export const REPORT_PATH = "/v1/token-report";
const REPORT_DESCRIPTION = "Cardano native token intelligence report";
/** 1.5 tADA unless PRICE_LOVELACE says otherwise (Address Intelligence caps sub-hires at 3). */
const DEFAULT_PRICE_LOVELACE = "1500000";

/** The seller's bindings, minus the escrow ones this worker never reads. */
export type Env = Pick<
  SellerEnv,
  | "SELLER_ADDRESS"
  | "BLOCKFROST_PROJECT_ID"
  | "FACILITATOR_URL"
  | "FACILITATOR_MODE"
  | "PRICE_LOVELACE"
  | "L1_CONFIRMATIONS"
  | "BLOCKFROST_BASE_URL"
  | "SELLER_SIGNING_KEY"
>;

export interface Deps {
  readonly facilitator?: FacilitatorClient;
  readonly now?: () => Date;
}

type AppEnv = { Bindings: Env; Variables: { tokenQuery: TokenQuery } };

function paymentLayer(config: Config, deps: Deps) {
  const facilitator =
    deps.facilitator ??
    (config.facilitatorMode === "embedded"
      ? embeddedFacilitator(config)
      : new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
  const resourceServer = new x402ResourceServer(facilitator).register(
    NETWORK,
    new ExactCardanoScheme(),
  );
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    [`GET ${REPORT_PATH}`]: {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: config.payTo,
        price: { amount: config.priceLovelace, asset: ASSET },
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { confirmationPolicy: { l1Confirmations: config.l1Confirmations } },
      },
      // No `resource` override: resource.url is the full request URL (path AND query).
      description: REPORT_DESCRIPTION,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
    },
  });
  let init: Promise<void> | null = null;
  // Own initialisation so a facilitator outage is a clean 503 (as in apps/seller).
  const ensureInitialized = async () => {
    init ??= httpServer.initialize();
    try {
      await init;
    } catch (err) {
      init = null;
      throw err;
    }
  };
  const middleware = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);
  return { ensureInitialized, middleware };
}

export function createApp(env: Env, deps: Deps = {}) {
  const now = deps.now ?? (() => new Date());
  const configResult = loadConfig({
    ...env,
    PRICE_LOVELACE: env.PRICE_LOVELACE?.trim() || DEFAULT_PRICE_LOVELACE,
  });
  if (!configResult.ok)
    console.error(`[specialist] configuration invalid: ${configResult.problems.join("; ")}`);
  const payment = configResult.ok ? paymentLayer(configResult.config, deps) : null;
  const receipts = configResult.ok
    ? loadReceiptSigner(env.SELLER_SIGNING_KEY, configResult.config.payTo)
    : null;
  if (receipts !== null && !receipts.ok)
    console.warn(`[specialist] delivery receipts disabled: ${receipts.problem}`);

  const describe = () => {
    const c = configResult.ok ? configResult.config : null;
    return {
      name: SERVICE_NAME,
      sells:
        "A deterministic JSON report on a Cardano preprod native token (policy id or asset " +
        "unit): supply, holder count and concentration, mint/burn history, metadata flags " +
        "and a 0-100 risk score. Data from Blockfrost.",
      simulated: false,
      paidRoute: {
        method: "GET",
        path: `${REPORT_PATH}?unit=<policyId[assetNameHex]>`,
        protocol: "x402 v2, scheme exact",
        network: NETWORK,
        asset: ASSET,
        priceLovelace: c?.priceLovelace ?? null,
        payTo: c?.payTo ?? null,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      },
      facilitator:
        c === null ? null : c.facilitatorMode === "embedded" ? "embedded" : c.facilitatorUrl,
      dataSource: "blockfrost-preprod",
      config: configResult.ok ? { ok: true } : { ok: false, problems: configResult.problems },
      deliveryReceipts:
        receipts?.ok === true
          ? { enabled: true, header: RECEIPT_HEADER, scheme: "zyropay-x402-receipt-v1" }
          : { enabled: false },
    };
  };

  const app = new Hono<AppEnv>();
  app.get("/", (c) => c.json(describe()));
  app.get("/health", (c) => c.json({ ok: configResult.ok, ...describe() }));

  // Config guard, then the query is validated BEFORE any 402: nobody pays for a bad unit.
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (payment === null) return c.json({ error: "service is misconfigured; see GET /" }, 503);
    const values = c.req.queries("unit") ?? [];
    if (values.length > 1) return c.json({ error: "pass exactly one 'unit'" }, 400);
    const check = checkUnit(values[0]);
    if (!check.ok) return c.json({ error: check.reason }, 400);
    c.set("tokenQuery", check.query);
    try {
      await payment.ensureInitialized();
    } catch {
      return c.json({ error: "payment facilitator unavailable; try again later" }, 503);
    }
    return next();
  };
  app.use(REPORT_PATH, guard);
  // Receipt wraps x402: it signs only bodies that were paid and settled.
  if (receipts?.ok === true) app.use(REPORT_PATH, receiptMiddleware(receipts.signer, now));
  if (payment !== null) app.use(REPORT_PATH, payment.middleware);

  app.get(REPORT_PATH, async (c) => {
    if (!configResult.ok) return c.json({ error: "service is misconfigured" }, 503);
    const { blockfrostProjectId, blockfrostBaseUrl } = configResult.config;
    try {
      const data = await new TokenBlockfrost(blockfrostProjectId, blockfrostBaseUrl).fetchTokenData(
        c.get("tokenQuery"),
      );
      return c.json(computeTokenReport(c.get("tokenQuery"), data, now()));
    } catch (err) {
      // Any status >= 400 makes the x402 middleware cancel instead of settling.
      if (err instanceof DataSourceError) return c.json({ error: err.message }, err.status);
      console.error("[specialist] report failed:", err instanceof Error ? err.name : "unknown");
      return c.json({ error: "report failed; you were not charged" }, 500);
    }
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("[specialist] unhandled:", err.name);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
