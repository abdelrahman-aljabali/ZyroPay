import { describe, expect, it } from "vitest";
import { isPublicHttpsUrl, probeX402, X402_MAX_BODY_BYTES } from "../../src/mcp/x402";

const requirements = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      payTo: "0x0000000000000000000000000000000000000001",
    },
  ],
  error: "payment required",
};

function fetchReturning(response: Response, seen: Request[] = []) {
  return (request: Request) => {
    seen.push(request);
    return Promise.resolve(response);
  };
}

describe("isPublicHttpsUrl", () => {
  it.each([
    ["https://api.example.com/paid", true],
    ["http://api.example.com/paid", false],
    ["https://localhost/x", false],
    ["https://127.0.0.1/x", false],
    ["https://169.254.169.254/latest", false],
    ["https://[::1]/x", false],
    ["https://intranet/x", false],
    ["https://db.internal/x", false],
    ["https://printer.local/x", false],
    ["https://db.internal./x", false],
    ["https://localhost./x", false],
    ["https://printer.local../x", false],
    ["https://user:pw@example.com/x", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isPublicHttpsUrl(url)).toBe(expected);
  });
});

describe("probeX402", () => {
  it("reads v1 requirements from the 402 body, without following redirects", async () => {
    const seen: Request[] = [];
    const result = await probeX402(
      "https://api.example.com/paid",
      "GET",
      fetchReturning(Response.json(requirements, { status: 402 }), seen),
    );
    expect(result).toEqual({ ok: true, requirements });
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("reads v2 requirements from the PAYMENT-REQUIRED header", async () => {
    const header = btoa(JSON.stringify({ ...requirements, x402Version: 2 }));
    const result = await probeX402(
      "https://api.example.com/paid",
      "POST",
      fetchReturning(
        new Response("ignored", { status: 402, headers: { "PAYMENT-REQUIRED": header } }),
      ),
    );
    expect(result.ok && result.requirements.x402Version).toBe(2);
  });

  it("refuses non-402 answers (including redirects)", async () => {
    const result = await probeX402(
      "https://api.example.com/paid",
      "GET",
      fetchReturning(
        new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
      ),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses malformed or oversized requirements", async () => {
    const malformed = await probeX402(
      "https://api.example.com/paid",
      "GET",
      fetchReturning(Response.json({ hello: "world" }, { status: 402 })),
    );
    expect(malformed.ok).toBe(false);
    const huge = await probeX402(
      "https://api.example.com/paid",
      "GET",
      fetchReturning(new Response("x".repeat(X402_MAX_BODY_BYTES + 10), { status: 402 })),
    );
    expect(huge).toEqual({ ok: false, reason: "payment requirements too large" });
  });

  it("refuses private targets without fetching", async () => {
    const seen: Request[] = [];
    const result = await probeX402(
      "https://10.0.0.1/paid",
      "GET",
      fetchReturning(new Response(), seen),
    );
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("maps network errors to a failure", async () => {
    const result = await probeX402("https://api.example.com/paid", "GET", () =>
      Promise.reject(new Error("dns")),
    );
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("a 402 body that errors mid-stream is a retryable failure, not a crash", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"x402Version":1,'));
        controller.error(new Error("connection reset"));
      },
    });
    const result = await probeX402("https://api.example.com/paid", "GET", () =>
      Promise.resolve(new Response(stream, { status: 402 })),
    );
    expect(result).toMatchObject({ ok: false, retryable: true });
  });
});
