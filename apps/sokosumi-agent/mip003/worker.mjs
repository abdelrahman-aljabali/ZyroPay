// Cloudflare Worker entry for the MIP-003 agent API (app.mjs). Deployed separately from the x402
// seller so its URL can be registered on the Masumi registry without touching apps/seller.
//
// One Durable Object holds every job (SQLite-backed storage, free plan), so start_job and /status
// always read their own writes. Its alarm moves paid jobs forward every 15 s while any is active.
//
// Secrets (wrangler secret bulk, see README "Masumi registration"):
//   MPS_URL                     public URL of your Masumi Payment Service (no /api/v1)
//   MPS_TOKEN                   wallet-scoped ReadAndPay key (`register-agent key`), never ADMIN_KEY
//   AGENT_IDENTIFIER            from `register-agent` once RegistrationConfirmed
//   SELLER_VKEY                 the selling wallet's payment key hash
//   SUPPORTED_PAYMENT_SOURCE_INDEX  0 for our registration
//   BLOCKFROST_API_KEY_PREPROD  report data source
//
// Jobs uses the classic Durable Object class shape (constructor(state, env), fetch, alarm) and
// does not import "cloudflare:workers", so worker.test.mjs can run it in Node with fake storage.
import { createAnswer, parseTask } from "../report.mjs";
import { createMip003, createPaymentNode } from "./app.mjs";

const ALARM_MS = 15_000;

function storeFor(storage) {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    delete: (key) => storage.delete(key),
    list: async (prefix) => [...(await storage.list({ prefix })).values()],
  };
}

function appFor(env, storage) {
  const mpsUrl = env.MPS_URL?.trim();
  const mpsToken = env.MPS_TOKEN?.trim();
  // Wrapped: the Workers runtime throws "Illegal invocation" when fetch is called as a method
  // of another object (BlockfrostClient stores it as this.fetchImpl).
  const fetchImpl = (input, init) => fetch(input, init);
  const answer = createAnswer({ env, fetchImpl, summarizer: null });
  return createMip003({
    store: storeFor(storage),
    mps:
      mpsUrl && mpsToken
        ? createPaymentNode({ url: mpsUrl, token: mpsToken, fetchImpl })
        : undefined,
    report: (address, deadline) => answer(`Report on ${address}`, undefined, deadline),
    parseAddress: parseTask,
    config: {
      agentIdentifier: env.AGENT_IDENTIFIER?.trim(),
      sellerVkey: env.SELLER_VKEY?.trim(),
      supportedPaymentSourceIndex: Number(env.SUPPORTED_PAYMENT_SOURCE_INDEX ?? 0),
    },
  });
}

export class Jobs {
  constructor(state, env) {
    this.storage = state.storage;
    this.app = appFor(env, state.storage);
  }

  async fetch(request) {
    const response = await this.app.fetch(request);
    if ((await this.app.activeJobs()).length > 0) await this.schedule();
    return response;
  }

  async schedule() {
    if ((await this.storage.getAlarm()) === null)
      await this.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async alarm() {
    const remaining = await this.app.advanceAll();
    if (remaining > 0) await this.storage.setAlarm(Date.now() + ALARM_MS);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Stateless routes answer without waking the Durable Object.
    if (
      request.method === "GET" &&
      ["/", "/availability", "/input_schema", "/demo"].includes(pathname)
    )
      return appFor(env, null).fetch(request);
    const stub = env.JOBS.get(env.JOBS.idFromName("jobs"));
    return stub.fetch(request);
  },
};
