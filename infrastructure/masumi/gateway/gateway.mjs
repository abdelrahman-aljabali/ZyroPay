// Allow-list proxy in front of the Masumi Payment Service. The Cloudflare tunnel points here, so
// the internet can reach exactly the routes the MIP-003 Worker (apps/sokosumi-agent/mip003) calls:
//
//   GET  /api/v1/health
//   POST /api/v1/payment                                  create signed escrow terms
//   POST /api/v1/payment/resolve-blockchain-identifier    read one payment's on-chain state
//   POST /api/v1/payment/submit-result                    queue the result-hash transaction
//
// Everything else (the admin UI, API keys, wallets, registry, purchases, x402) answers 404 and
// never reaches the node. The node still checks the caller's `token` on every request; the
// Worker holds a wallet-scoped ReadAndPay key, never ADMIN_KEY. No dependencies: runs on node:24.
import { createServer } from "node:http";

const UPSTREAM = (process.env.UPSTREAM ?? "http://payment-service:3001").replace(/\/+$/u, "");
const PORT = Number(process.env.PORT ?? 3002);
const MAX_BODY = 64 * 1024;
const ALLOWED = new Set([
  "GET /api/v1/health",
  "POST /api/v1/payment",
  "POST /api/v1/payment/resolve-blockchain-identifier",
  "POST /api/v1/payment/submit-result",
]);

const reply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export function createGateway({ upstream = UPSTREAM, fetchImpl = fetch } = {}) {
  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/\/+$/u, "");
    if (!ALLOWED.has(`${req.method} ${path}`))
      return reply(res, 404, { status: "error", error: { message: "Not exposed" } });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY)
        return reply(res, 413, { status: "error", error: { message: "Too large" } });
      chunks.push(chunk);
    }
    try {
      const upstreamResponse = await fetchImpl(upstream + path, {
        method: req.method,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(typeof req.headers.token === "string" ? { token: req.headers.token } : {}),
        },
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      });
      const text = await upstreamResponse.text();
      res.writeHead(upstreamResponse.status, { "content-type": "application/json" });
      res.end(text);
    } catch (error) {
      // 503 = the request never reached the node (it is not running), so the caller may treat
      // the write as not done. 504 = sent but no answer: the outcome is unknown.
      const code = error?.cause?.code;
      const neverSent = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"].includes(code);
      reply(res, neverSent ? 503 : 504, {
        status: "error",
        error: { message: neverSent ? "Payment Service not running" : "Payment Service timed out" },
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createGateway().listen(PORT, "0.0.0.0", () =>
    console.log(`gateway: ${[...ALLOWED].join(", ")} -> ${UPSTREAM} on :${PORT}`),
  );
}
