// MIP-003 agent API for Cardano Address Intelligence, paid through Masumi escrow.
//
// This is the `apiBaseUrl` registered on the Masumi registry (infrastructure/masumi). Sokosumi's
// marketplace and any Masumi buyer hire the agent here:
//
//   POST /start_job   -> asks our Payment Service for signed escrow terms (POST /payment)
//   (buyer locks 1 tUSDM in the Masumi V2 escrow contract)
//   advance()         -> sees FundsLocked, runs the seller's deterministic report,
//                        submits the MIP-004 result hash (POST /payment/submit-result)
//   GET  /status      -> "completed" with the report once ResultSubmitted is confirmed on chain
//
// The Payment Service auto-collects the escrow after unlockTime. Nothing here signs a
// transaction or holds a key: the Payment Service does both, reached with a wallet-scoped
// ReadAndPay key (never the admin key).
//
// Storage, the payment node and the report are injected, so this file runs unchanged in the
// Cloudflare Worker (worker.mjs, Durable Object storage) and in node:test (app.test.mjs).

const MINUTE = 60_000;
const MAX_BODY_BYTES = 20_000;
const NONCE = /^[0-9a-fA-F]{14,26}$/u;
const JOB_ID = /^[0-9a-f-]{36}$/u;
// Masumi Payment Service deadlines (payments route): submit >= now + 15 min,
// unlock >= submit + 15 min, external dispute >= unlock + 15 min. The TUM template's offsets.
export const DEADLINES = { payBy: 10, submitResult: 20, unlock: 36, externalDispute: 52 };
// Do not start or submit work this close to submitResultTime.
const SUBMIT_MARGIN_MS = 2 * MINUTE;
// After payByTime, wait this long for a late lock to confirm before failing the job.
const PAYMENT_GRACE_MS = 10 * MINUTE;
const ACTIVE = new Set(["awaiting-payment", "running", "submit-pending", "awaiting-result"]);
const REFUND_STATES = new Set([
  "RefundRequested",
  "RefundAuthorized",
  "RefundWithdrawn",
  "Disputed",
  "DisputedWithdrawn",
  "FundsOrDatumInvalid",
]);

export const EXAMPLE_ADDRESS =
  "addr_test1qr954ww3l08ezv7gqk8kddlckaqupe2fkv6shu6len37cn4t54p3mmj5xp74prvahzg5qljdvff6cxucu2lzug775hcs0dkaen";

export const INPUT_SCHEMA = {
  input_data: [
    {
      id: "address",
      type: "string",
      name: "Cardano preprod address",
      data: {
        placeholder: "addr_test1...",
        description:
          "A Cardano preprod payment address. The report covers its balance, tokens, activity, stake and a 0-100 caution score.",
      },
      validations: [
        { validation: "min", value: "20" },
        { validation: "max", value: "200" },
      ],
    },
  ],
};

/** RFC 8785 (JCS) for JSON values: sorted keys, ECMAScript number and string serialization. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** MIP-004 input hash: sha256(identifier_from_purchaser ";" JCS(input_data)). */
export const mip004InputHash = (inputData, nonce) =>
  sha256Hex(`${nonce};${canonicalJson(inputData)}`);
/** MIP-004 output hash: sha256(identifier_from_purchaser ";" raw output). */
export const mip004ResultHash = (result, nonce) => sha256Hex(`${nonce};${result}`);

/** True when `payment` has a confirmed transaction that moved it to `expected` (template rule). */
function confirmedState(payment, expected) {
  return Boolean(
    (payment?.CurrentTransaction?.status === "Confirmed" &&
      payment.CurrentTransaction.newOnChainState === expected) ||
    payment?.TransactionHistory?.some(
      (tx) => tx.status === "Confirmed" && tx.newOnChainState === expected,
    ),
  );
}

function mip003Status(job) {
  if (job.phase === "completed") return "completed";
  if (job.phase === "failed") return "failed";
  if (job.phase === "awaiting-payment" || job.phase === "payment-pending")
    return "awaiting_payment";
  return "running";
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * Error thrown by the payment node client. `definite` = the request certainly created nothing
 * (the node refused it, or it never reached the node).
 */
export class PaymentNodeError extends Error {
  constructor(message, { status = 0, definite = false } = {}) {
    super(message);
    this.status = status;
    this.definite = definite;
  }
}

/**
 * Masumi Payment Service client. `token` is a wallet-scoped ReadAndPay key.
 * Never follows redirects. Definite (nothing was created): any 4xx; 503 from the gateway
 * (Payment Service not running); 530 from Cloudflare (the quick tunnel is gone). Anything else,
 * including timeouts, is uncertain.
 */
export function createPaymentNode({
  url,
  token,
  fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = 25_000,
}) {
  const base = String(url ?? "").replace(/\/+$/u, "");
  return async function mps(path, body) {
    let response;
    try {
      response = await fetchImpl(`${base}/api/v1${path}`, {
        method: body ? "POST" : "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { token, "content-type": "application/json", accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new PaymentNodeError(`Payment node unreachable: ${String(error?.message ?? error)}`);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // handled below
    }
    if (!response.ok || data?.status !== "success") {
      const detail = String(data?.error?.message ?? data?.message ?? "").slice(0, 200);
      throw new PaymentNodeError(`Payment node ${path} HTTP ${response.status} ${detail}`.trim(), {
        status: response.status,
        definite:
          (response.status >= 400 && response.status < 500) || [503, 530].includes(response.status),
      });
    }
    return data.data;
  };
}

/**
 * @param {object} deps
 * @param {{get(k:string):Promise<any>, put(k:string,v:any):Promise<void>, delete(k:string):Promise<any>, list(prefix:string):Promise<any[]>}} deps.store
 * @param {(path:string, body?:object)=>Promise<any>} [deps.mps] payment node; absent = not configured
 * @param {(address:string, deadline:number)=>Promise<string>} deps.report  the paid work
 * @param {(text:string)=>{ok:boolean,address?:{bech32:string},reason?:string}} deps.parseAddress
 * @param {{agentIdentifier?:string, sellerVkey?:string, supportedPaymentSourceIndex?:number, network?:string}} deps.config
 */
export function createMip003({
  store,
  mps,
  report,
  parseAddress,
  config,
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
  log = console,
}) {
  const network = config.network ?? "Preprod";
  const sourceIndex = Number(config.supportedPaymentSourceIndex ?? 0);
  const missing = [
    !config.agentIdentifier && "AGENT_IDENTIFIER",
    !config.sellerVkey && "SELLER_VKEY",
    !mps && "MPS_URL/MPS_TOKEN",
    !Number.isInteger(sourceIndex) && "SUPPORTED_PAYMENT_SOURCE_INDEX",
  ].filter(Boolean);
  const save = (job) => store.put(`job:${job.id}`, job);
  const busy = new Set();

  function availability() {
    // The registry health check marks the entry Online for any 200 with type "masumi-agent".
    // agentIdentifier is deliberately omitted: a registry update re-mints the asset, and a stale
    // identifier here would mark the entry Invalid.
    return missing.length === 0
      ? { status: "available", type: "masumi-agent", message: "Cardano Address Intelligence" }
      : {
          status: "unavailable",
          type: "masumi-agent",
          message: `Not configured: ${missing.join(", ")}`,
        };
  }

  async function startJob(request) {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES)
      return json(413, { error: "Request too large" });
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      return json(400, { error: "Body must be JSON" });
    }
    const nonce = input?.identifier_from_purchaser ?? input?.identifierFromPurchaser;
    if (typeof nonce !== "string" || !NONCE.test(nonce))
      return json(400, { error: "identifier_from_purchaser must be 14 to 26 hex characters" });
    const inputData = input.input_data;
    if (
      !inputData ||
      typeof inputData !== "object" ||
      Array.isArray(inputData) ||
      typeof inputData.address !== "string" ||
      Object.keys(inputData).some((k) => k !== "address")
    )
      return json(400, {
        error: 'input_data must be {"address": "addr_test1..."} (see /input_schema)',
      });
    const parsed = parseAddress(inputData.address.trim());
    if (!parsed.ok) return json(400, { error: parsed.reason });
    if (missing.length > 0)
      // 4xx tells Sokosumi that no job was accepted, so it refunds the buyer at once.
      return json(424, { error: `Agent not configured: ${missing.join(", ")}` });

    const inputHash = await mip004InputHash(inputData, nonce);
    const nonceKey = `nonce:${await sha256Hex(nonce)}`;
    const existingId = await store.get(nonceKey);
    if (existingId) {
      const existing = await store.get(`job:${existingId}`);
      if (existing?.inputHash !== inputHash)
        return json(409, { error: "identifier_from_purchaser already used with another input" });
      if (existing.response) return json(200, existing.response);
      return json(409, { error: "This job's payment request has an uncertain outcome" });
    }

    const t = now();
    const job = {
      id: newId(),
      nonce,
      address: parsed.address.bech32,
      inputData,
      inputHash,
      createdAt: new Date(t).toISOString(),
      phase: "payment-pending",
    };
    // Persist before the payment write: an uncertain outcome is never replayed blindly.
    await save(job);
    await store.put(nonceKey, job.id);
    let payment;
    try {
      payment = await mps("/payment", {
        network,
        agentIdentifier: config.agentIdentifier,
        paymentSourceType: "Web3CardanoV2",
        supportedPaymentSourceIndex: sourceIndex,
        inputHash,
        identifierFromPurchaser: nonce,
        // No RequestedFunds: the registration is Fixed-priced (1 tUSDM on chain).
        payByTime: new Date(t + DEADLINES.payBy * MINUTE).toISOString(),
        submitResultTime: new Date(t + DEADLINES.submitResult * MINUTE).toISOString(),
        unlockTime: new Date(t + DEADLINES.unlock * MINUTE).toISOString(),
        externalDisputeUnlockTime: new Date(t + DEADLINES.externalDispute * MINUTE).toISOString(),
        metadata: JSON.stringify({ jobId: job.id }),
      });
    } catch (error) {
      if (error instanceof PaymentNodeError && error.definite) {
        // The node refused: no payment request exists, so the nonce may be used again.
        await store.delete(nonceKey);
        await save({ ...job, phase: "failed", error: error.message });
        return json(424, { error: "The payment node is unavailable or refused the request" });
      }
      log.error("start_job: uncertain payment request", job.id, String(error?.message ?? error));
      await save({ ...job, error: String(error?.message ?? error).slice(0, 300) });
      return json(500, {
        error: "Payment request outcome uncertain. Retry later with a new nonce.",
      });
    }
    job.payment = {
      blockchainIdentifier: payment.blockchainIdentifier,
      payByTime: Number(payment.payByTime),
      submitResultTime: Number(payment.submitResultTime),
      unlockTime: Number(payment.unlockTime),
      externalDisputeUnlockTime: Number(payment.externalDisputeUnlockTime),
    };
    job.response = {
      id: job.id,
      job_id: job.id,
      status: "awaiting_payment",
      input_hash: inputHash,
      identifierFromPurchaser: nonce,
      blockchainIdentifier: payment.blockchainIdentifier,
      agentIdentifier: config.agentIdentifier,
      sellerVKey: payment.SmartContractWallet?.walletVkey ?? config.sellerVkey,
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: sourceIndex,
      ...job.payment,
    };
    job.phase = "awaiting-payment";
    await save(job);
    return json(200, job.response);
  }

  async function resolve(job) {
    return mps("/payment/resolve-blockchain-identifier", {
      network,
      blockchainIdentifier: job.payment.blockchainIdentifier,
      includeHistory: "true",
    });
  }

  async function submit(job) {
    await mps("/payment/submit-result", {
      network,
      blockchainIdentifier: job.payment.blockchainIdentifier,
      submitResultHash: job.resultHash,
    });
  }

  const fail = (job, reason) => save({ ...job, phase: "failed", error: reason });

  /** Moves one job forward by at most one external write. Safe to call repeatedly. */
  async function advance(job) {
    if (!ACTIVE.has(job.phase) || !mps || busy.has(job.id)) return job;
    busy.add(job.id);
    try {
      const t = now();
      const { submitResultTime, payByTime } = job.payment;
      const observed = await resolve(job);
      const state = observed?.onChainState ?? null;
      if (REFUND_STATES.has(state)) {
        await fail(job, `Escrow is ${state}`);
        return store.get(`job:${job.id}`);
      }
      if (job.phase === "awaiting-payment" || job.phase === "running") {
        if (state !== "FundsLocked" || !confirmedState(observed, "FundsLocked")) {
          if (t > payByTime + PAYMENT_GRACE_MS) await fail(job, "Payment was not locked in time");
          return store.get(`job:${job.id}`);
        }
        if (t >= submitResultTime - SUBMIT_MARGIN_MS) {
          await fail(job, "Too close to submitResultTime to deliver");
          return store.get(`job:${job.id}`);
        }
        await save({ ...job, phase: "running" });
        // Reads public chain data only, so a crash here is safely retried.
        const result = await report(job.address, submitResultTime - SUBMIT_MARGIN_MS);
        const resultHash = await mip004ResultHash(result, job.nonce);
        const next = { ...job, phase: "submit-pending", result, resultHash };
        await save(next);
        if (now() >= submitResultTime - SUBMIT_MARGIN_MS) {
          await fail(next, "Report finished too close to submitResultTime");
          return store.get(`job:${job.id}`);
        }
        await submit(next);
        await save({
          ...next,
          phase: "awaiting-result",
          submittedAt: new Date(now()).toISOString(),
        });
        return store.get(`job:${job.id}`);
      }
      if (job.phase === "submit-pending") {
        // The submit request may or may not have reached the node.
        const requested = String(observed?.NextAction?.requestedAction ?? "");
        if (state === "ResultSubmitted" || /^SubmitResult/u.test(requested)) {
          await save({ ...job, phase: "awaiting-result" });
        } else if (t < submitResultTime - SUBMIT_MARGIN_MS) {
          await submit(job);
          await save({ ...job, phase: "awaiting-result" });
        } else {
          await fail(job, "Result was not submitted before submitResultTime");
        }
        return store.get(`job:${job.id}`);
      }
      if (job.phase === "awaiting-result") {
        if (
          state === "ResultSubmitted" &&
          String(observed?.resultHash ?? "").toLowerCase() === job.resultHash &&
          confirmedState(observed, "ResultSubmitted")
        )
          await save({ ...job, phase: "completed", completedAt: new Date(now()).toISOString() });
        else if (t > submitResultTime + PAYMENT_GRACE_MS)
          await fail(job, "Result submission did not confirm");
        return store.get(`job:${job.id}`);
      }
      return job;
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      log.warn("advance", job.id, message);
      const latest = (await store.get(`job:${job.id}`)) ?? job;
      // A crash between "running" and the submit leaves "running"; keep the phase, record why.
      await save({ ...latest, lastError: message, lastErrorAt: new Date(now()).toISOString() });
      return store.get(`job:${job.id}`);
    } finally {
      busy.delete(job.id);
    }
  }

  async function activeJobs() {
    return (await store.list("job:")).filter((job) => ACTIVE.has(job.phase));
  }

  /** Advances every active job. Returns how many remain active (for the alarm). */
  async function advanceAll() {
    for (const job of await activeJobs()) await advance(job);
    return (await activeJobs()).length;
  }

  async function status(url) {
    const id = url.searchParams.get("job_id") ?? "";
    if (!JOB_ID.test(id)) return json(400, { error: "job_id must be a job id from /start_job" });
    let job = await store.get(`job:${id}`);
    if (!job) return json(404, { error: "Job not found" });
    if (ACTIVE.has(job.phase)) job = (await advance(job)) ?? job;
    const body = { id, job_id: id, status: mip003Status(job) };
    if (body.status === "completed") body.result = job.result;
    if (body.status === "failed") body.message = job.error ?? "Job failed";
    return json(200, body);
  }

  async function demo() {
    return json(200, {
      input: { address: EXAMPLE_ADDRESS },
      output: {
        result:
          "# Cardano Address Intelligence report\n\nRisk score: 0/100 (low caution). Balance, tokens, activity, stake credential and every raised flag, followed by the full deterministic JSON.",
      },
    });
  }

  async function fetchHandler(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/\/+$/u, "") || "/"}`;
    switch (route) {
      case "GET /":
        return json(200, {
          name: "Cardano Address Intelligence (Masumi MIP-003)",
          endpoints: ["/availability", "/input_schema", "/start_job", "/status?job_id=", "/demo"],
          price: "1 tUSDM per report, paid into Masumi escrow on Cardano preprod",
          ...availability(),
        });
      case "GET /availability":
        return json(200, availability());
      case "GET /input_schema":
        return json(200, INPUT_SCHEMA);
      case "GET /demo":
        return demo();
      case "POST /start_job":
        return startJob(request);
      case "GET /status":
        return status(url);
      default:
        return json(404, { error: "Route not found" });
    }
  }

  return { fetch: fetchHandler, advance, advanceAll, activeJobs, availability };
}
