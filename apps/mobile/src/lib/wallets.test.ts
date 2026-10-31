import { CARDANO_TURNKEY_ACCOUNT, networksForMode, type PortfolioSnapshot } from "@zyropay/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "@/api/client";
import { ADDR, ASSETS, balanceFor, WALLET_MAIN, WATCH_ADDRESS } from "@/api/mock/fixtures";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import { computeChange } from "./portfolio-change";
import {
  simulatedSigner,
  SIMULATED_NEW_WALLET_PREFIX,
  walletAccountParams,
} from "./turnkey/signer";
import {
  checkWalletName,
  checkWatchAddress,
  defaultWalletName,
  needsCardanoAccount,
  parseScannedAddress,
  receiveNetworks,
  siblingNetworks,
  walletNetworks,
} from "./wallets";

const DEV = networksForMode("development");
const SOL = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const EVM = "0x52908400098527886e0f7030069857d2e4169ee7";

describe("add-wallet helpers", () => {
  it("parses addresses out of payment URIs and pastes", () => {
    expect(parseScannedAddress(`  ${SOL}  `)).toBe(SOL);
    expect(parseScannedAddress(`solana:${SOL}?amount=1&label=x`)).toBe(SOL);
    expect(parseScannedAddress(`ethereum:${EVM}@84532/transfer?value=1`)).toBe(EVM);
    expect(parseScannedAddress(`ethereum:pay-${EVM}@1`)).toBe(EVM);
    expect(parseScannedAddress("web+cardano:addr_test1qz?amount=2")).toBe("addr_test1qz");
  });

  it("validates watch addresses with the shared helpers for the chosen network", () => {
    expect(checkWatchAddress("solana-devnet", `solana:${SOL}`)).toEqual({ ok: true, address: SOL });
    expect(checkWatchAddress("base-sepolia", EVM)).toEqual({ ok: true, address: EVM });
    expect(checkWatchAddress("base-sepolia", SOL).ok).toBe(false);
    expect(checkWatchAddress("solana-devnet", EVM).ok).toBe(false);
    expect(checkWatchAddress("solana-devnet", "").ok).toBe(false);
    // Mixed case with a wrong EIP-55 checksum is the typo checksums exist to catch.
    expect(
      checkWatchAddress("ethereum-sepolia", "0x52908400098527886E0F7030069857D2E4169eE7").ok,
    ).toBe(false);
  });

  it("validates optional names with the shared schema", () => {
    expect(checkWalletName("")).toEqual({ ok: true });
    expect(checkWalletName("  Travel  ")).toEqual({ ok: true, name: "Travel" });
    expect(checkWalletName("x".repeat(65)).ok).toBe(false);
    expect(checkWalletName("bad\u0000name").ok).toBe(false);
  });

  it("derives chain lists from the registry", () => {
    expect(defaultWalletName("base-sepolia")).toBe("Base wallet");
    expect(defaultWalletName("solana-devnet")).toBe("Solana wallet");
    expect(siblingNetworks("base-sepolia", DEV)).toEqual(["ethereum-sepolia"]);
    expect(siblingNetworks("solana-devnet", DEV)).toEqual([]);
    expect(
      walletNetworks({ addresses: [{ family: "solana" }] } as never, DEV).every((n) =>
        n.startsWith("solana"),
      ),
    ).toBe(true);
  });

  it("maps chain families to Turnkey account parameters", () => {
    expect(walletAccountParams("solana")).toMatchObject({
      curve: "CURVE_ED25519",
      addressFormat: "ADDRESS_FORMAT_SOLANA",
    });
    expect(walletAccountParams("evm")).toMatchObject({
      curve: "CURVE_SECP256K1",
      addressFormat: "ADDRESS_FORMAT_ETHEREUM",
    });
    // ADR-002: Cardano is the compressed Ed25519 key at the CIP-1852 path.
    expect(walletAccountParams("cardano")).toEqual({ ...CARDANO_TURNKEY_ACCOUNT });
  });

  it("offers Cardano in the chain picker and adds it only to legacy multi-chain wallets", () => {
    expect(DEV).toContain("cardano-preprod");
    const legacy = { addresses: [{ family: "solana" }, { family: "evm" }] } as never;
    const single = { addresses: [{ family: "solana" }] } as never;
    const withAda = {
      addresses: [{ family: "solana" }, { family: "evm" }, { family: "cardano" }],
    } as never;
    expect(needsCardanoAccount(legacy, DEV)).toBe(true);
    expect(needsCardanoAccount(single, DEV)).toBe(false);
    expect(needsCardanoAccount(withAda, DEV)).toBe(false);
    expect(
      needsCardanoAccount(
        legacy,
        DEV.filter((n) => !n.startsWith("cardano")),
      ),
    ).toBe(false);
    expect(receiveNetworks(legacy, DEV)).toContain("cardano-preprod");
    expect(receiveNetworks(single, DEV)).not.toContain("cardano-preprod");
    expect(walletNetworks({ addresses: [{ family: "cardano" }] } as never, DEV)).toEqual([
      "cardano-preprod",
    ]);
  });
});

describe("wallet management over the mock transport", () => {
  const client = () =>
    new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "simulated",
    });

  beforeEach(() => {
    resetMockState();
  });

  it("creates a wallet the simulated passkey made, idempotently", async () => {
    const c = client();
    const turnkeyWalletId = await simulatedSigner().createWallet({
      organizationId: "simulated-suborg-0000",
      name: "Travel",
      family: "evm",
    });
    expect(turnkeyWalletId.startsWith(SIMULATED_NEW_WALLET_PREFIX)).toBe(true);
    const body = {
      turnkeyWalletId,
      network: "base-sepolia" as const,
      name: "Travel",
      idempotencyKey: "wallet-create:test-1",
    };
    const first = await c.call("createWallet", { body });
    const replay = await c.call("createWallet", { body });
    expect(replay.wallet.id).toBe(first.wallet.id);
    expect(first.wallet.addresses.map((a) => a.family)).toEqual(["evm"]);
    const list = await c.call("listWallets", {});
    expect(list.wallets.filter((w) => w.name === "Travel")).toHaveLength(1);
  });

  it("refuses a wallet outside the ZyroPay sub-organization and other modes", async () => {
    const c = client();
    await expect(
      c.call("createWallet", {
        body: {
          turnkeyWalletId: "some-other-org-wallet",
          network: "base-sepolia",
          idempotencyKey: "wallet-create:test-2",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      c.call("createWallet", {
        body: {
          turnkeyWalletId: `${SIMULATED_NEW_WALLET_PREFIX}x`,
          network: "base-mainnet",
          idempotencyKey: "wallet-create:test-3",
        },
      }),
    ).rejects.toMatchObject({ code: "NETWORK_MODE_MISMATCH" });
  });

  it("renames, and refuses to remove a wallet an agent can use", async () => {
    const c = client();
    const renamed = await c.call("renameWallet", {
      params: { walletId: WALLET_MAIN },
      body: { name: "Everyday" },
    });
    expect(renamed.wallet.name).toBe("Everyday");
    await expect(
      c.call("removeWallet", { params: { walletId: WALLET_MAIN } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("watches an address read-only and keeps it out of the main portfolio", async () => {
    const c = client();
    const before = await c.call("getPortfolio", { query: {} });
    const watched = await c.call("createWatchWallet", {
      body: { network: "solana-devnet", address: `  ${SOL} `, idempotencyKey: "watch:test-1" },
    });
    expect(watched.watchWallet.watchOnly).toBe(true);
    expect(watched.watchWallet.address).toBe(SOL);
    await expect(
      c.call("createWatchWallet", {
        body: { network: "solana-devnet", address: SOL, idempotencyKey: "watch:test-2" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      c.call("createWatchWallet", {
        body: { network: "solana-devnet", address: ADDR.solMain, idempotencyKey: "watch:test-3" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      c.call("createWatchWallet", {
        body: { network: "base-sepolia", address: SOL, idempotencyKey: "watch:test-4" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    const after = await c.call("getPortfolio", { query: {} });
    expect(after.portfolio.totalValue).toEqual(before.portfolio.totalValue);
    const list = await c.call("listWatchWallets", {});
    const fixture = list.watchWallets.find((w) => w.address === WATCH_ADDRESS);
    if (!fixture) throw new Error("fixture missing");
    const p = await c.call("getWatchWalletPortfolio", {
      params: { watchWalletId: fixture.id },
      query: {},
    });
    expect(p.portfolio.balances.every((b) => b.walletId === fixture.id)).toBe(true);
    expect(p.portfolio.networks.every((n) => n.endsWith("sepolia"))).toBe(true);
    await c.call("removeWatchWallet", { params: { watchWalletId: watched.watchWallet.id } });
    expect((await c.call("listWatchWallets", {})).watchWallets).toHaveLength(
      list.watchWallets.length - 1,
    );
  });
});

describe("24h change", () => {
  const portfolio = (balances: PortfolioSnapshot["balances"]) => ({ currency: "USD", balances });

  it("sums exact cents across assets and fails closed on a missing series", () => {
    const sol = balanceFor(WALLET_MAIN, ADDR.solMain, ASSETS.sol, "10000000000"); // 10 SOL
    const usdc = balanceFor(WALLET_MAIN, ADDR.solMain, ASSETS.usdcSol, "5000000"); // 5 USDC
    const ok = computeChange(
      portfolio([sol, usdc]),
      new Map([
        [ASSETS.sol.id, { first: "140.00", last: "142.18" }],
        [ASSETS.usdcSol.id, { first: "1.00", last: "1.00" }],
      ]),
    );
    expect(ok).toEqual({ value: "21.80", percent: "1.55%", label: "Today" });
    const down = computeChange(
      portfolio([sol]),
      new Map([[ASSETS.sol.id, { first: "150.00", last: "142.18" }]]),
    );
    expect(down?.value).toBe("-78.20");
    expect(down?.percent).toBe("−5.21%");
    expect(computeChange(portfolio([sol, usdc]), new Map([[ASSETS.sol.id, null]]))).toBeNull();
    expect(computeChange({ currency: "EUR", balances: [sol] }, new Map())).toBeNull();
  });
});
