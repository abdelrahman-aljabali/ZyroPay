import type { ClientCardanoSigner } from "@x402/cardano";
import { ASSET_TRANSFER_METHOD_MASUMI, InMemoryMasumiTermsStorage } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import type { FacilitatorClient, RouteConfig, RoutesConfig } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ShelleyAddress } from "./address";
import { checkQueryAddress } from "./address";
import { BlockfrostClient, DataSourceError } from "./blockfrost";
import type { Config, Env } from "./config";
import {
  admitQuoteMiddleware,
  ESCROW_ID_HEADER,
  ESCROW_RESULT_HEADER,
  ESCROW_STATUS_PATH,
  escrowDeliveryMiddleware,
} from "./escrow/delivery";
import type { EscrowRuntime } from "./escrow/runtime";
import { escrowAddress, escrowRuntime } from "./escrow/runtime";
import { lookupEscrow } from "./escrow/status";
import { ASSET, loadConfig, MAX_TIMEOUT_SECONDS, NETWORK } from "./config";
import { masumiSellerSigner, ownRegistryClaim } from "./escrow/terms";
import { embeddedFacilitator } from "./facilitator";
import { loadReceiptSigner, RECEIPT_HEADER, receiptMiddleware } from "./receipt";
import type { DemoMode } from "./demo";
import { checkDemo, DEMO_HEADER, DEMO_MODES, demoEnabled } from "./demo";
import { computeReport } from "./report";
import type { Subhirer } from "./subhire";
import { loadSubhireConfig, makeSubhirer, SPECIALIST_PATH, SPECIALIST_SERVICE } from "./subhire";

const SERVICE_NAME = "Cardano Address Intelligence";
export const REPORT_PATH = "/v1/address-report";
export const REPORT_DESCRIPTION = "Cardano address intelligence report";
export const ESCROW_REPORT_PATH = "/v1/address-report/escrow";
const ESCROW_REPORT_DESCRIPTION =
  "Cardano address intelligence report, paid into Masumi escrow (refundable)";

export interface Deps {
  /** Facilitator override (tests). Default: embedded, or HTTPFacilitatorClient at FACILITATOR_URL. */
  readonly facilitator?: FacilitatorClient;
  readonly now?: () => Date;
  /** Background work after a response (default: the request's ctx.waitUntil). Tests. */
  readonly background?: (task: Promise<unknown>) => void;
  /** Sub-hire wallet override (tests). Default: toClientCardanoSigner(SELLER_BUYER_MNEMONIC). */
  readonly subhireSigner?: ClientCardanoSigner;
}

interface Vars {
  queryAddress: ShelleyAddress;
  masumiQuote?: PaymentRequirements;
  demoMode?: DemoMode | null;
}

type AppEnv = { Bindings: Env; Variables: Vars };

type SubhireState =
  | {
      readonly enabled: true;
      readonly subhirer: Subhirer;
      readonly url: string;
      readonly cap: bigint;
    }
  | { readonly enabled: false; readonly problems: readonly string[] };

function describe(
  env: Env,
  receipts: boolean,
  escrow: EscrowRuntime | null,
  subhire: SubhireState | null,
) {
  const result = loadConfig(env);
  const c = result.ok ? result.config : null;
  return {
    name: SERVICE_NAME,
    sells:
      "A compact JSON report on any Cardano preprod address: balance, tokens, activity, " +
      "stake delegation and code-computed risk flags with a 0-100 score. Data from Blockfrost.",
    simulated: false,
    paidRoute: {
      method: "GET",
      path: `${REPORT_PATH}?address=<addr_test1...>`,
      protocol: "x402 v2, scheme exact",
      network: NETWORK,
      asset: ASSET,
      priceLovelace: c?.priceLovelace ?? null,
      payTo: c?.payTo ?? null,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      confirmationPolicy: c === null ? null : { l1Confirmations: c.l1Confirmations },
    },
    escrowRoute:
      escrow === null || !escrow.enabled
        ? {
            enabled: false,
            ...(escrow === null ? {} : { problems: escrow.problems }),
          }
        : {
            enabled: true,
            method: "GET",
            path: `${ESCROW_REPORT_PATH}?address=<addr_test1...>`,
            protocol: 'x402 v2, scheme exact, assetTransferMethod "masumi" (vested_pay v2 escrow)',
            payTo: escrowAddress(),
            priceLovelace: escrow.config.priceLovelace,
            maxTimeoutSeconds: escrow.config.maxTimeoutSeconds,
            deadlinesAfterPayByMinutes: {
              submitResult: escrow.config.submitAfterPayByMs / 60_000,
              unlock:
                (escrow.config.submitAfterPayByMs + escrow.config.unlockAfterSubmitMs) / 60_000,
              externalDisputeUnlock:
                (escrow.config.submitAfterPayByMs +
                  escrow.config.unlockAfterSubmitMs +
                  escrow.config.disputeAfterUnlockMs) /
                60_000,
            },
            resultHash: "sha256 of the delivered body (= X-Delivery-Receipt contentSha256)",
            headers: [ESCROW_RESULT_HEADER, ESCROW_ID_HEADER],
            status: `${ESCROW_STATUS_PATH}/<lockTx or blockchainIdentifier>`,
            autoAuthorizeRefunds: escrow.config.autoAuthorizeRefunds,
            // The Masumi registry identity every escrow 402 claims (null: unregistered).
            masumiAgentIdentifier: escrow.config.agentIdentifier,
            stateStore: escrow.store.enabled ? "kv" : "none (chain only)",
          },
    // Agents hiring agents (src/subhire.ts): pays Cardano Token Intelligence for the top token.
    subcontracting:
      subhire?.enabled === true
        ? {
            enabled: true,
            service: SPECIALIST_SERVICE,
            route: `${subhire.url}${SPECIALIST_PATH}?unit=<top token>`,
            maxLovelacePerJob: subhire.cap.toString(),
            reportField: "subcontracted",
          }
        : {
            enabled: false,
            ...(subhire === null || env.SUBHIRE_ENABLED === undefined
              ? {}
              : { problems: subhire.problems }),
          },
    // "Dishonest seller" switch for refund demos (src/demo.ts). Off unless DEMO_DISHONEST_MODE=enabled.
    demoDishonestMode: demoEnabled(env.DEMO_DISHONEST_MODE)
      ? {
          enabled: true,
          route: `${ESCROW_REPORT_PATH}?address=<addr_test1...>&demo=<mode>`,
          modes: DEMO_MODES,
          header: DEMO_HEADER,
        }
      : { enabled: false },
    facilitator:
      c === null
        ? null
        : c.facilitatorMode === "embedded"
          ? "embedded (@x402/cardano 2.29.0, submits through Blockfrost preprod)"
          : c.facilitatorUrl,
    dataSource: "blockfrost-preprod",
    config: result.ok ? { ok: true } : { ok: false, problems: result.problems },
    // Whether paid responses carry a signed X-Delivery-Receipt (never the key itself).
    deliveryReceipts: receipts
      ? { enabled: true, header: RECEIPT_HEADER, scheme: "zyropay-x402-receipt-v1" }
      : { enabled: false },
  };
}

function reportRoute(accepts: RouteConfig["accepts"], description: string): RouteConfig {
  return {
    accepts,
    // No `resource` override: @x402/core then binds resource.url to the full request
    // URL (path AND query), which is what ZyroPay compares against.
    description,
    mimeType: "application/json",
    serviceName: SERVICE_NAME,
  };
}

/** One x402 resource server per configuration, initialised against the facilitator once. */
function paymentLayer(config: Config, deps: Deps, escrow: EscrowRuntime) {
  // The registry identity escrow 402s claim (MASUMI_AGENT_IDENTIFIER), vouched for only here.
  const agentIdentifier = escrow.enabled ? escrow.config.agentIdentifier : null;
  const registryClaim =
    escrow.enabled && agentIdentifier !== null
      ? ownRegistryClaim({
          agentIdentifier,
          sellerAddress: config.payTo,
          network: NETWORK,
          asset: ASSET,
          amount: escrow.config.priceLovelace,
        })
      : undefined;
  const facilitator =
    deps.facilitator ??
    (config.facilitatorMode === "embedded"
      ? embeddedFacilitator(config, registryClaim)
      : new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
  // Masumi quotes: the scheme issues and signs one per 402 with the seller key.
  const masumiStorage = new InMemoryMasumiTermsStorage();
  const scheme = escrow.enabled
    ? new ExactCardanoScheme({
        masumiStorage,
        masumi: {
          seller: masumiSellerSigner(escrow.key, config.payTo),
          ...(agentIdentifier !== null ? { agentIdentifier } : {}),
          deadlines: {
            submitResultAfterPayByMs: escrow.config.submitAfterPayByMs,
            unlockAfterPayByMs:
              escrow.config.submitAfterPayByMs + escrow.config.unlockAfterSubmitMs,
            externalDisputeUnlockAfterPayByMs:
              escrow.config.submitAfterPayByMs +
              escrow.config.unlockAfterSubmitMs +
              escrow.config.disputeAfterUnlockMs,
          },
        },
      })
    : new ExactCardanoScheme();
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, scheme);
  const routes: Record<string, RouteConfig> = {
    [`GET ${REPORT_PATH}`]: reportRoute(
      {
        scheme: "exact",
        network: NETWORK,
        payTo: config.payTo,
        price: { amount: config.priceLovelace, asset: ASSET },
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { confirmationPolicy: { l1Confirmations: config.l1Confirmations } },
      },
      REPORT_DESCRIPTION,
    ),
  };
  if (escrow.enabled) {
    routes[`GET ${ESCROW_REPORT_PATH}`] = reportRoute(
      {
        scheme: "exact",
        network: NETWORK,
        payTo: escrowAddress(),
        price: { amount: escrow.config.priceLovelace, asset: ASSET },
        maxTimeoutSeconds: escrow.config.maxTimeoutSeconds,
        extra: {
          assetTransferMethod: ASSET_TRANSFER_METHOD_MASUMI,
          confirmationPolicy: { l1Confirmations: config.l1Confirmations },
        },
      },
      ESCROW_REPORT_DESCRIPTION,
    );
  }
  const httpServer = new x402HTTPResourceServer(resourceServer, routes satisfies RoutesConfig);
  let init: Promise<void> | null = null;
  // Our own initialisation (instead of the middleware's) so a facilitator outage becomes a
  // clean 503 and never reaches @x402/core's background `process.exit` handler.
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
  return { ensureInitialized, middleware, masumiStorage };
}

export function createApp(env: Env, deps: Deps = {}) {
  const now = deps.now ?? (() => new Date());
  const configResult = loadConfig(env);
  if (!configResult.ok) {
    // Names and rules only, never values.
    console.error(`[seller] configuration invalid: ${configResult.problems.join("; ")}`);
  }
  const escrow = configResult.ok ? escrowRuntime(env, configResult.config) : null;
  if (escrow !== null && !escrow.enabled) {
    // Once per isolate; rule names only. The default route is unaffected.
    console.info(`[seller] escrow route disabled: ${escrow.problems.join("; ")}`);
  }
  const payment =
    configResult.ok && escrow !== null ? paymentLayer(configResult.config, deps, escrow) : null;
  const receipts = configResult.ok
    ? loadReceiptSigner(env.SELLER_SIGNING_KEY, configResult.config.payTo)
    : null;
  if (receipts !== null && !receipts.ok) {
    // Once per isolate. Paid responses are still served, without a delivery receipt.
    console.warn(`[seller] delivery receipts disabled: ${receipts.problem}`);
  }

  let subhire: SubhireState | null = null;
  if (configResult.ok) {
    const sub = loadSubhireConfig(env, configResult.config);
    subhire = sub.enabled
      ? {
          enabled: true,
          subhirer: makeSubhirer(
            sub.config,
            deps.subhireSigner === undefined ? {} : { signer: deps.subhireSigner },
          ),
          url: sub.config.specialistUrl,
          cap: sub.config.maxLovelace,
        }
      : sub;
    if (!sub.enabled && env.SUBHIRE_ENABLED !== undefined)
      console.info(`[seller] sub-hiring disabled: ${sub.problems.join("; ")}`);
  }

  const app = new Hono<AppEnv>();

  const signing = receipts?.ok === true;
  app.get("/", (c) => c.json(describe(env, signing, escrow, subhire)));
  app.get("/health", (c) =>
    c.json({ ok: configResult.ok, ...describe(env, signing, escrow, subhire) }),
  );

  const defer = (c: Context, task: Promise<unknown>) => {
    if (deps.background !== undefined) {
      deps.background(task);
      return;
    }
    try {
      c.executionCtx.waitUntil(task);
    } catch {
      void task; // no execution context (e.g. app.request in a script): run detached
    }
  };

  // 1. Refuse a misconfigured seller before anyone is asked to pay.
  // 2. Validate the address BEFORE the x402 middleware: nobody pays for an invalid query.
  // 3. Initialise against the facilitator (/supported).
  // 4. x402 (@x402/hono): 402 / verify, run the handler, settle only on a status < 400.
  const guard =
    (escrowRoute: boolean): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      if (payment === null) return c.json({ error: "seller is misconfigured; see GET /" }, 503);
      if (escrowRoute && escrow?.enabled !== true)
        return c.json({ error: "the escrow route is not configured; see GET /" }, 503);
      const values = c.req.queries("address") ?? [];
      if (values.length > 1) return c.json({ error: "pass exactly one 'address'" }, 400);
      const check = checkQueryAddress(values[0]);
      if (!check.ok) return c.json({ error: check.reason }, 400);
      c.set("queryAddress", check.address);
      const demo = checkDemo(
        c.req.queries("demo") ?? [],
        demoEnabled(env.DEMO_DISHONEST_MODE),
        escrowRoute,
      );
      if (!demo.ok) return c.json({ error: demo.error }, 400);
      c.set("demoMode", demo.mode);
      try {
        await payment.ensureInitialized();
      } catch {
        return c.json({ error: "payment facilitator unavailable; try again later" }, 503);
      }
      return next();
    };
  app.use(REPORT_PATH, guard(false));
  app.use(ESCROW_REPORT_PATH, guard(true));
  // Label every response of a demo request (402 included) so nobody mistakes it.
  app.use(ESCROW_REPORT_PATH, async (c, next) => {
    await next();
    const mode = c.get("demoMode");
    if (mode === null || mode === undefined) return;
    const res = new Response(c.res.body, c.res);
    res.headers.set(DEMO_HEADER, mode);
    c.res = undefined;
    c.res = res;
  });
  // 5. Delivery receipt: wraps x402, so it signs only bodies that were paid and settled.
  if (receipts?.ok === true) {
    app.use(REPORT_PATH, receiptMiddleware(receipts.signer, now));
    app.use(ESCROW_REPORT_PATH, receiptMiddleware(receipts.signer, now));
  }
  if (payment !== null && escrow?.enabled === true) {
    // 6. Escrow: result hash + SubmitResult after a settled lock; quote admission.
    app.use(ESCROW_REPORT_PATH, escrowDeliveryMiddleware(escrow, defer, now));
    app.use(ESCROW_REPORT_PATH, admitQuoteMiddleware(escrow, payment.masumiStorage, now));
  }
  if (payment !== null) {
    app.use(REPORT_PATH, payment.middleware);
    app.use(ESCROW_REPORT_PATH, payment.middleware);
  }

  const report = async (c: Context<AppEnv>) => {
    if (!configResult.ok) return c.json({ error: "seller is misconfigured" }, 503);
    const address = c.get("queryAddress");
    const { blockfrostProjectId, blockfrostBaseUrl } = configResult.config;
    const blockfrost = new BlockfrostClient(blockfrostProjectId, blockfrostBaseUrl);
    try {
      const data = await blockfrost.fetchAddressData(address.bech32);
      const result = computeReport(address, data, now());
      // Sub-hire (fail-soft; never on a demo request that withholds delivery anyway).
      if (subhire?.enabled !== true || c.get("demoMode") === "nodelivery") return c.json(result);
      const subcontracted = await subhire.subhirer.forAddress(data.address?.amount);
      return c.json({ ...result, subcontracted });
    } catch (err) {
      // Any status >= 400 here makes the x402 middleware cancel instead of settling.
      if (err instanceof DataSourceError) return c.json({ error: err.message }, err.status);
      console.error("[seller] report failed:", err instanceof Error ? err.name : "unknown");
      return c.json({ error: "report failed; you were not charged" }, 500);
    }
  };
  app.get(REPORT_PATH, report);
  app.get(ESCROW_REPORT_PATH, report);

  // Free: an escrow's state from chain (lock tx id, `<tx>#<ix>`, or blockchainIdentifier).
  app.get(`${ESCROW_STATUS_PATH}/:id`, async (c) => {
    if (escrow?.enabled !== true)
      return c.json({ error: "the escrow route is not configured; see GET /" }, 503);
    try {
      const found = await lookupEscrow(
        escrow.chain,
        escrow.store,
        escrowAddress(),
        escrow.config.scanPages,
        c.req.param("id"),
      );
      if (!found.ok) return c.json({ error: found.error }, found.code);
      return c.json({ escrowAddress: escrowAddress(), ...found.status });
    } catch (err) {
      console.error("[seller] escrow status failed:", err instanceof Error ? err.name : "unknown");
      return c.json({ error: "chain data unavailable; try again later" }, 503);
    }
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("[seller] unhandled:", err.name);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
