import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREPROD_V2_ESCROW,
  TUSDM,
  agentStateFiles,
  amountOf,
  buildRegistration,
  createNodeClient,
  findExisting,
  findV2Source,
  isConfirmed,
  parseTunnelUrl,
  probeAvailability,
  readConfig,
  runtimeKeyBody,
  sourceIndexOf,
  type RegistryEntry,
} from "../../infrastructure/masumi/scripts/lib.ts";

const VKEY = "ab".repeat(28);
const URL_ = "https://masumi-agent.zyropay.online";

test("config defaults and tUSDM price conversion", () => {
  const c = readConfig({ ADMIN_KEY: " k ", AGENT_AUTHOR_NAME: "Team" });
  assert.equal(c.mpsUrl, "http://127.0.0.1:3001");
  assert.equal(c.apiBaseUrl, URL_);
  assert.equal(c.priceUnits, "1000000");
  assert.equal(readConfig({ AGENT_PRICE_TUSDM: "0.5" }).priceUnits, "500000");
  assert.equal(readConfig({ AGENT_PRICE_TUSDM: "2.000001" }).priceUnits, "2000001");
  assert.throws(() => readConfig({ AGENT_PRICE_TUSDM: "0" }), /positive/);
  assert.throws(() => readConfig({ AGENT_PRICE_TUSDM: "1.0000001" }), /6 decimals/);
});

test("registration body matches the Payment Service 0.29 V2 schema limits", () => {
  const body = buildRegistration({
    apiBaseUrl: URL_,
    authorName: "Team ZyroPay",
    sellingWalletVkey: VKEY,
    escrowAddress: PREPROD_V2_ESCROW,
    priceUnits: "1000000",
  });
  assert.equal(body.network, "Preprod");
  assert.equal(body.type, "Standard");
  assert.equal(body.apiBaseUrl, URL_);
  assert.equal("AgentPricing" in body, false, "V2 forbids legacy AgentPricing");
  assert.ok(body.description.length <= 250);
  assert.ok(body.name.length <= 250);
  assert.ok(body.Tags.length >= 1 && body.Tags.length <= 15);
  assert.ok(body.Tags.every((t) => t.length <= 63));
  assert.ok(
    body.ExampleOutputs.every(
      (e) => e.name.length <= 60 && e.url.length <= 250 && e.mimeType.length <= 60,
    ),
  );
  assert.ok((body.Legal.other ?? "").length <= 250);
  assert.deepEqual(body.supportedPaymentSources, [
    {
      chain: "Cardano",
      network: "Preprod",
      paymentSourceType: "Web3CardanoV2",
      address: PREPROD_V2_ESCROW,
      pricing: { pricingType: "Fixed", fixed: [{ asset: TUSDM, amount: "1000000" }] },
    },
  ]);
  assert.equal("contactEmail" in body.Author, false);
  assert.throws(() => buildRegistration({ ...base(), authorName: "" }), /AGENT_AUTHOR_NAME/);
  assert.throws(
    () => buildRegistration({ ...base(), apiBaseUrl: "http://127.0.0.1:21950" }),
    /public https/,
  );
  assert.throws(() => buildRegistration({ ...base(), sellingWalletVkey: "xyz" }), /vkey/);
});

const base = () => ({
  apiBaseUrl: URL_,
  authorName: "T",
  sellingWalletVkey: VKEY,
  escrowAddress: PREPROD_V2_ESCROW,
  priceUnits: "1000000",
});

test("runtime key is scoped to the selling wallet and cannot administer", () => {
  const body = runtimeKeyBody("wallet-1");
  assert.equal(body.canAdmin, false);
  assert.equal(body.canPay, true);
  assert.deepEqual(body.WalletScopeHotWalletIds, ["wallet-1"]);
  assert.deepEqual(body.NetworkLimit, ["Preprod"]);
});

test("V2 source prefers the canonical escrow address", () => {
  const sources = [
    {
      id: "v1",
      network: "Preprod",
      paymentSourceType: "Web3CardanoV1",
      smartContractAddress: "addr_test1v1",
      policyId: null,
    },
    {
      id: "other",
      network: "Preprod",
      paymentSourceType: "Web3CardanoV2",
      smartContractAddress: "addr_test1x",
      policyId: null,
    },
    {
      id: "v2",
      network: "Preprod",
      paymentSourceType: "Web3CardanoV2",
      smartContractAddress: PREPROD_V2_ESCROW,
      policyId: null,
    },
  ];
  assert.equal(findV2Source(sources).id, "v2");
  assert.throws(() => findV2Source(sources.slice(0, 1)), /No Preprod Web3CardanoV2/);
});

test("balances sum ADA under both unit spellings", () => {
  const balance = [
    { unit: "", quantity: 5_000_000 },
    { unit: "lovelace", quantity: "1000000" },
    { unit: TUSDM, quantity: 2_000_000 },
  ];
  assert.equal(amountOf(balance, "lovelace"), 6_000_000n);
  assert.equal(amountOf(balance, TUSDM), 2_000_000n);
});

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
  id: "r1",
  name: "Cardano Address Intelligence",
  apiBaseUrl: URL_,
  state: "RegistrationRequested",
  agentIdentifier: null,
  error: null,
  supportedPaymentSources: [{ address: PREPROD_V2_ESCROW }],
  SmartContractWallet: { walletVkey: VKEY, walletAddress: "addr_test1seller" },
  CurrentTransaction: null,
  ...over,
});

test("an existing live registration is reused instead of minting twice", () => {
  const key = { name: "Cardano Address Intelligence", apiBaseUrl: URL_, vkey: VKEY };
  assert.equal(findExisting([entry({})], key)?.id, "r1");
  assert.equal(findExisting([entry({ state: "RegistrationFailed" })], key), undefined);
  assert.equal(findExisting([entry({ state: "DeregistrationConfirmed" })], key), undefined);
  assert.equal(findExisting([entry({ apiBaseUrl: "https://other.example" })], key), undefined);
  assert.equal(findExisting([entry({ id: "r2" })], { ...key, id: "r2" })?.id, "r2");
});

test("confirmation needs the state and the identifier", () => {
  assert.equal(isConfirmed(entry({ state: "RegistrationConfirmed" })), false);
  assert.equal(
    isConfirmed(entry({ state: "RegistrationConfirmed", agentIdentifier: "a".repeat(120) })),
    true,
  );
  assert.equal(
    isConfirmed(entry({ state: "UpdateConfirmed", agentIdentifier: "a".repeat(120) })),
    true,
  );
  assert.equal(sourceIndexOf(entry({}), PREPROD_V2_ESCROW), 0);
  assert.equal(
    sourceIndexOf(
      entry({ supportedPaymentSources: [{ address: "x" }, { address: PREPROD_V2_ESCROW }] }),
      PREPROD_V2_ESCROW,
    ),
    1,
  );
});

test("agent state files carry what paid-task.mjs reads", () => {
  const files = agentStateFiles({
    sourceId: "s",
    walletId: "w",
    sellerAddress: "addr_test1seller",
    sellerVkey: VKEY,
    registrationId: "r1",
    entry: entry({ state: "RegistrationConfirmed", agentIdentifier: "a".repeat(120) }),
    supportedPaymentSourceIndex: 0,
  });
  assert.deepEqual(files.payment, {
    sourceId: "s",
    walletId: "w",
    sellerAddress: "addr_test1seller",
  });
  assert.equal(files.registration.registrationState, "RegistrationConfirmed");
  assert.equal(
    files.registration.registration.SmartContractWallet.walletAddress,
    "addr_test1seller",
  );
  assert.equal(files.registration.pricingType, "Fixed");
  assert.equal(files.registration.supportedPaymentSourceIndex, 0);
});

test("the last quick-tunnel URL in the log wins", () => {
  const log = `INF |  https://old-name-a.trycloudflare.com  |\nINF Registered\nINF |  https://new-name-b.trycloudflare.com  |`;
  assert.equal(parseTunnelUrl(log), "https://new-name-b.trycloudflare.com");
  assert.equal(parseTunnelUrl("nothing"), undefined);
});

test("availability probe applies the registry's rule", async () => {
  const respond = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status });
  assert.equal(
    (await probeAvailability(URL_, respond(200, { status: "available", type: "masumi-agent" }))).ok,
    true,
  );
  assert.equal(
    (await probeAvailability(URL_, respond(200, { status: "available", type: "x" }))).ok,
    false,
  );
  assert.equal((await probeAvailability(URL_, respond(302, {}))).ok, false);
});

test("node client sends the token, encodes queries and surfaces errors", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const request = createNodeClient({
    url: "http://127.0.0.1:3001",
    token: "admin",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.includes("/fail")
        ? new Response(JSON.stringify({ status: "error", error: { message: "bad input" } }), {
            status: 400,
          })
        : new Response(JSON.stringify({ status: "success", data: { ok: 1 } }), { status: 200 });
    },
  });
  assert.deepEqual(
    await request("/wallet/list", { query: { take: "100", walletType: "Selling" } }),
    { ok: 1 },
  );
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:3001/api/v1/wallet/list?take=100&walletType=Selling",
  );
  assert.equal((calls[0].init?.headers as Record<string, string>).token, "admin");
  assert.equal(calls[0].init?.method, "GET");
  await assert.rejects(request("/fail", { body: {} }), /HTTP 400: bad input/);
});
