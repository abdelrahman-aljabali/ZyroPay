/*
 * Agents hiring agents: while building an address report, this seller can pay a second
 * x402 service — Cardano Token Intelligence (apps/specialist) — for a report on the
 * address's top native token, and embed the specialist's report, its delivery receipt and
 * the sub-payment transaction under `subcontracted`. The seller then signs its own body,
 * which contains the specialist's receipt: a receipt chain buyer -> seller -> specialist.
 *
 * Off unless SUBHIRE_ENABLED=true. The seller pays from its OWN hot budget wallet
 * (SELLER_BUYER_MNEMONIC, never the payTo key), at most SUBHIRE_MAX_LOVELACE (<= 3 tADA)
 * per job and one sub-payment per job, lovelace only, `exact` default transfers only, to
 * SPECIALIST_PAY_TO when pinned. Fail-soft: any problem becomes
 * `{status: "failed", reason}` and the main report is still delivered.
 *
 * Caveat (documented): the sub-payment happens inside the main request, after the buyer's
 * payment was VERIFIED but before it is settled. If the main settlement then fails, the
 * seller has spent up to the cap for nothing. The per-job cap and the small wallet bound it.
 */
import type { ClientCardanoSigner } from "@x402/cardano";
import { toClientCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { BfAmount } from "./blockfrost";
import { ASSET, NETWORK, serviceUrl } from "./config";
import type { DeliveryReceipt } from "./receipt";
import { RECEIPT_HEADER, settledTransaction, verifyDeliveryReceipt } from "./receipt";

export interface SubhireEnv {
  /** "true" turns sub-hiring on. Anything else (default): off. */
  readonly SUBHIRE_ENABLED?: string;
  /** Base URL of Cardano Token Intelligence (https; http only for localhost). */
  readonly SPECIALIST_URL?: string;
  /** Optional pin: refuse to pay any other payTo, and require receipts signed by it. */
  readonly SPECIALIST_PAY_TO?: string;
  /** Per-job cap in lovelace. Default 3000000; 1000000..3000000. */
  readonly SUBHIRE_MAX_LOVELACE?: string;
  /** Secret: BIP-39 mnemonic of the seller's small budget wallet that pays the specialist. */
  readonly SELLER_BUYER_MNEMONIC?: string;
}

export const SPECIALIST_SERVICE = "Cardano Token Intelligence";
export const SPECIALIST_PATH = "/v1/token-report";
const MAX_CAP_LOVELACE = 3_000_000n;
const MIN_CAP_LOVELACE = 1_000_000n;
/** Whole sub-hire (402, sign, paid retry, settle) must finish within this. */
const SUBHIRE_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface SubhireConfig {
  readonly specialistUrl: string;
  readonly specialistPayTo: string | null;
  readonly maxLovelace: bigint;
  readonly mnemonic: string;
  readonly blockfrostBaseUrl: string;
  readonly blockfrostProjectId: string;
}

export type SubhireConfigResult =
  | { readonly enabled: true; readonly config: SubhireConfig }
  | { readonly enabled: false; readonly problems: readonly string[] };

/** Problems name the variable and the rule, never the value. */
export function loadSubhireConfig(
  env: SubhireEnv,
  blockfrost: { readonly blockfrostBaseUrl: string; readonly blockfrostProjectId: string },
): SubhireConfigResult {
  if (env.SUBHIRE_ENABLED?.trim().toLowerCase() !== "true")
    return { enabled: false, problems: ["SUBHIRE_ENABLED is not true"] };
  const problems: string[] = [];
  let specialistUrl = "";
  if (!env.SPECIALIST_URL?.trim()) problems.push("SPECIALIST_URL is not set");
  else specialistUrl = serviceUrl(env.SPECIALIST_URL, "", "SPECIALIST_URL", problems);
  const pin = env.SPECIALIST_PAY_TO?.trim() ?? "";
  if (pin !== "" && !/^addr_test1[0-9a-z]{50,120}$/.test(pin))
    problems.push("SPECIALIST_PAY_TO must be a preprod address (addr_test1...)");
  const capRaw = env.SUBHIRE_MAX_LOVELACE?.trim() || MAX_CAP_LOVELACE.toString();
  const cap = /^[1-9][0-9]{0,15}$/.test(capRaw) ? BigInt(capRaw) : -1n;
  if (cap < MIN_CAP_LOVELACE || cap > MAX_CAP_LOVELACE)
    problems.push("SUBHIRE_MAX_LOVELACE must be an integer from 1000000 to 3000000");
  const mnemonic = env.SELLER_BUYER_MNEMONIC?.trim().toLowerCase().split(/\s+/).join(" ") ?? "";
  const words = mnemonic === "" ? 0 : mnemonic.split(" ").length;
  if (mnemonic === "") problems.push("SELLER_BUYER_MNEMONIC is not set");
  else if (![12, 15, 24].includes(words) || !/^[a-z ]+$/.test(mnemonic))
    problems.push("SELLER_BUYER_MNEMONIC must be a 12, 15 or 24-word BIP-39 mnemonic");
  if (problems.length > 0) return { enabled: false, problems };
  return {
    enabled: true,
    config: {
      specialistUrl,
      specialistPayTo: pin === "" ? null : pin,
      maxLovelace: cap,
      mnemonic,
      blockfrostBaseUrl: blockfrost.blockfrostBaseUrl,
      blockfrostProjectId: blockfrost.blockfrostProjectId,
    },
  };
}

/** The native token the address holds most of (ties: lowest unit). Null when none. */
export function topToken(amounts: readonly BfAmount[] | undefined): string | null {
  const tokens = (amounts ?? []).filter(
    (a) =>
      a.unit !== "lovelace" &&
      /^[0-9a-f]{56,120}$/.test(a.unit) &&
      /^[1-9][0-9]*$/.test(a.quantity),
  );
  tokens.sort((a, b) => {
    const qa = BigInt(a.quantity);
    const qb = BigInt(b.quantity);
    if (qa !== qb) return qa > qb ? -1 : 1;
    return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0;
  });
  return tokens[0]?.unit ?? null;
}

export type Subcontract =
  | {
      readonly status: "delivered";
      readonly service: typeof SPECIALIST_SERVICE;
      readonly unit: string;
      readonly resourceUrl: string;
      readonly payTo: string;
      readonly priceLovelace: string;
      /** The seller's payment to the specialist (preprod tx id). */
      readonly paymentTx: string | null;
      readonly receiptVerified: boolean;
      readonly receiptProblem?: string;
      /** The specialist's X-Delivery-Receipt, decoded. */
      readonly receipt: DeliveryReceipt | null;
      /** The specialist's report, as delivered (its sha256 = receipt.contentSha256). */
      readonly report: unknown;
    }
  | {
      readonly status: "failed";
      readonly service: typeof SPECIALIST_SERVICE;
      readonly unit: string;
      readonly resourceUrl: string;
      readonly reason: string;
      readonly paymentTx?: string;
    };

export interface Subhirer {
  /** At most one sub-hire per job: the top token of `amounts`; [] when it holds none. */
  forAddress(amounts: readonly BfAmount[] | undefined): Promise<Subcontract[]>;
}

const short = (err: unknown): string =>
  (err instanceof Error ? err.message : "unknown error").replace(/\s+/g, " ").slice(0, 200);

async function readLimited(res: Response): Promise<Uint8Array<ArrayBuffer> | null> {
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > MAX_BODY_BYTES ? null : buf;
}

export function makeSubhirer(
  config: SubhireConfig,
  deps: { readonly signer?: ClientCardanoSigner; readonly fetch?: typeof fetch } = {},
): Subhirer {
  // Built on first use: deriving the wallet from the mnemonic costs CPU, and is only needed
  // for addresses that hold tokens.
  let signer: ClientCardanoSigner | undefined = deps.signer;
  const getSigner = () =>
    (signer ??= toClientCardanoSigner({
      mnemonic: config.mnemonic,
      network: NETWORK,
      provider: {
        blockfrost: { baseUrl: config.blockfrostBaseUrl, projectId: config.blockfrostProjectId },
      },
    }));
  const baseFetch = deps.fetch ?? ((input, init) => fetch(input, init));

  // `extra` may be absent on the wire, whatever the type says.
  const method = (r: PaymentRequirements) =>
    (r.extra as Record<string, unknown> | undefined)?.assetTransferMethod;
  const acceptable = (r: PaymentRequirements) =>
    r.scheme === "exact" &&
    r.network === NETWORK &&
    r.asset === ASSET &&
    /^[0-9]{1,16}$/.test(r.amount) &&
    BigInt(r.amount) <= config.maxLovelace &&
    (method(r) === undefined || method(r) === "default") &&
    (config.specialistPayTo === null || r.payTo === config.specialistPayTo);

  async function hire(unit: string): Promise<Subcontract> {
    const resourceUrl = `${config.specialistUrl}${SPECIALIST_PATH}?unit=${unit}`;
    const failed = (reason: string, paymentTx?: string | null): Subcontract => ({
      status: "failed",
      service: SPECIALIST_SERVICE,
      unit,
      resourceUrl,
      reason,
      ...(typeof paymentTx === "string" ? { paymentTx } : {}),
    });
    // One x402 client per job, so the selected requirements belong to this job only.
    let selected: PaymentRequirements | null = null;
    const client = new x402Client()
      .registerPolicy((_v, reqs) => reqs.filter(acceptable))
      .setSpendControls({
        allowedAssets: [
          { network: NETWORK, asset: ASSET, maxAmountPerPayment: config.maxLovelace.toString() },
        ],
      })
      .onBeforePaymentCreation((ctx) => {
        selected = ctx.selectedRequirements;
        return Promise.resolve();
      });
    let res: Response;
    try {
      client.register(NETWORK, new ExactCardanoScheme(getSigner()));
      res = await wrapFetchWithPayment(baseFetch, client)(resourceUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(SUBHIRE_TIMEOUT_MS),
      });
    } catch (err) {
      return failed(`sub-payment failed: ${short(err)}`);
    }
    const paymentTx = settledTransaction(res.headers.get("PAYMENT-RESPONSE"));
    const paidTx = typeof paymentTx === "string" ? paymentTx : null;
    if (res.status !== 200) {
      await res.body?.cancel();
      return failed(`specialist answered HTTP ${res.status}`, paidTx);
    }
    const req = selected as PaymentRequirements | null;
    if (req === null || paymentTx === undefined) {
      await res.body?.cancel();
      return failed("specialist delivered without a settled x402 payment", paidTx);
    }
    let body: Uint8Array<ArrayBuffer> | null;
    let report: unknown;
    try {
      body = await readLimited(res);
      if (body === null) return failed("specialist response too large", paidTx);
      report = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return failed("specialist response is not JSON", paidTx);
    }
    const check = await verifyDeliveryReceipt(res.headers.get(RECEIPT_HEADER), {
      resourceUrl,
      payTo: req.payTo,
      paymentTx: paidTx,
      body,
    });
    return {
      status: "delivered",
      service: SPECIALIST_SERVICE,
      unit,
      resourceUrl,
      payTo: req.payTo,
      priceLovelace: req.amount,
      paymentTx: paidTx,
      receiptVerified: check.ok,
      ...(check.ok ? {} : { receiptProblem: check.problem }),
      receipt: check.receipt,
      report,
    };
  }

  return {
    async forAddress(amounts) {
      const unit = topToken(amounts);
      if (unit === null) return [];
      try {
        return [await hire(unit)];
      } catch (err) {
        return [
          {
            status: "failed",
            service: SPECIALIST_SERVICE,
            unit,
            resourceUrl: `${config.specialistUrl}${SPECIALIST_PATH}?unit=${unit}`,
            reason: `sub-hire failed: ${short(err)}`,
          },
        ];
      }
    },
  };
}
