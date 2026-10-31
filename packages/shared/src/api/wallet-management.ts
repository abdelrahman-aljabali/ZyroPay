/*
 * Wallet management (additive, next to `api` and `apiExt`): the Wallets tab's
 * "+" flow, rename and remove.
 *
 *  - Create: the app creates a new Turnkey wallet in the user's sub-organization
 *    with the passkey (ADR-001: the API holds no key that could create one), then
 *    registers it here. The API re-reads the sub-organization from Turnkey and
 *    refuses any wallet id that is not in it, so a wallet created outside
 *    ZyroPay's sub-org can never be linked.
 *  - Watch: a read-only address. Watch wallets have no keys: they can never
 *    sign, send, or be shared with an agent. They live in their own table and
 *    their own schema so no signing path can ever receive one.
 *  - Remove = unlink. Turnkey keys are never deleted; creating the same wallet
 *    again (or a sync) links it back.
 */
import { z } from "zod";
import { IdempotencyKeySchema, IsoDateTimeSchema } from "../common";
import { WalletSchema } from "../domain/wallets";
import { PortfolioSnapshotSchema } from "../domain/portfolio";
import { FiatCurrencySchema } from "../money";
import { ChainFamilySchema, NetworkIdSchema } from "../networks";
import type { EndpointContract } from "./contracts";

function walletEndpoint<const T extends EndpointContract>(contract: T): T {
  return contract;
}

/** User-facing wallet name: trimmed, 1 to 64 characters, no control characters. */
export const WalletNameSchema = z
  .string()
  .trim()
  .min(1, "Name can't be empty")
  .max(64, "Name is too long")
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Name contains invalid characters");

export const WatchWalletSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: WalletNameSchema,
  family: ChainFamilySchema,
  /** The chain the user picked when adding it (for display); balances cover every network of `family` in the build's mode. */
  network: NetworkIdSchema,
  /** Canonical form (EIP-55 for EVM, unchanged base58 for Solana, lowercase bech32 for Cardano). */
  address: z.string().min(1).max(128),
  /** Always true: no keys, no signing, no sends, never visible to agents. */
  watchOnly: z.literal(true),
  createdAt: IsoDateTimeSchema,
});
export type WatchWallet = z.infer<typeof WatchWalletSchema>;

const OkSchema = z.object({ ok: z.literal(true) });
const WalletIdParams = z.object({ walletId: z.uuid() });
const WatchWalletIdParams = z.object({ watchWalletId: z.uuid() });

export const CreateWalletBodySchema = z.object({
  /**
   * Id Turnkey returned for the wallet the passkey just created or imported in the user's
   * sub-org, or (ADR-003) the id of a private key the passkey just imported. Never key
   * material: the phrase/key goes from the device to Turnkey's import enclave only.
   */
  turnkeyWalletId: z.string().min(1).max(128),
  /** Chain the user picked; the wallet must hold an account for its family and it must be in the build's mode. */
  network: NetworkIdSchema,
  name: WalletNameSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type CreateWalletBody = z.infer<typeof CreateWalletBodySchema>;

export const CreateWatchWalletBodySchema = z.object({
  network: NetworkIdSchema,
  /**
   * Validated server-side with the shared address helpers for `network` (Cardano: CIP-19
   * Shelley payment address with a key credential of that network).
   */
  address: z.string().trim().min(1).max(128),
  name: WalletNameSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type CreateWatchWalletBody = z.infer<typeof CreateWatchWalletBodySchema>;

export const apiWallets = {
  createWallet: walletEndpoint({
    method: "POST",
    path: "/v1/wallets",
    auth: "user",
    summary:
      "Register a wallet the app just created or imported (ADR-003: a recovery phrase as an HD wallet, or a raw private key) with the passkey in the user's Turnkey sub-organization. The API re-reads the sub-org's wallets and private keys from Turnkey and refuses (FORBIDDEN) an id that is not there; a removed wallet is linked again. The API refuses (BAD_REQUEST) any request that carries a recovery phrase or private key. Audited.",
    idempotent: true,
    body: CreateWalletBodySchema,
    response: z.object({ wallet: WalletSchema }),
  }),
  renameWallet: walletEndpoint({
    method: "PATCH",
    path: "/v1/wallets/:walletId",
    auth: "user",
    summary: "Rename one of the user's wallets (ZyroPay label only). Audited.",
    params: WalletIdParams,
    body: z.object({ name: WalletNameSchema }),
    response: z.object({ wallet: WalletSchema }),
  }),
  removeWallet: walletEndpoint({
    method: "DELETE",
    path: "/v1/wallets/:walletId",
    auth: "user",
    summary:
      "Unlink a wallet from ZyroPay. Keys stay in the user's Turnkey sub-organization and nothing is deleted there. Refused (CONFLICT) for the last linked wallet, while an agent can use it, or while a request is in flight. Audited.",
    params: WalletIdParams,
    response: OkSchema,
  }),
  listWatchWallets: walletEndpoint({
    method: "GET",
    path: "/v1/watch-wallets",
    auth: "user",
    summary: "Read-only (watch) addresses, oldest first.",
    response: z.object({ watchWallets: z.array(WatchWalletSchema) }),
  }),
  createWatchWallet: walletEndpoint({
    method: "POST",
    path: "/v1/watch-wallets",
    auth: "user",
    summary:
      "Watch an address read-only. Validated for the network's family and the build's mode; the same address twice is a CONFLICT. Never signs, never sends, never visible to agents. Audited.",
    idempotent: true,
    body: CreateWatchWalletBodySchema,
    response: z.object({ watchWallet: WatchWalletSchema }),
  }),
  renameWatchWallet: walletEndpoint({
    method: "PATCH",
    path: "/v1/watch-wallets/:watchWalletId",
    auth: "user",
    summary: "Rename a watch wallet. Audited.",
    params: WatchWalletIdParams,
    body: z.object({ name: WalletNameSchema }),
    response: z.object({ watchWallet: WatchWalletSchema }),
  }),
  removeWatchWallet: walletEndpoint({
    method: "DELETE",
    path: "/v1/watch-wallets/:watchWalletId",
    auth: "user",
    summary: "Stop watching an address. Audited.",
    params: WatchWalletIdParams,
    response: OkSchema,
  }),
  getWatchWalletPortfolio: walletEndpoint({
    method: "GET",
    path: "/v1/watch-wallets/:watchWalletId/portfolio",
    auth: "user",
    summary:
      "Balances of one watch address on every network of its family in the build's mode. Balances carry the watch wallet's id as walletId. Not part of the main portfolio total.",
    params: WatchWalletIdParams,
    query: z.object({ currency: FiatCurrencySchema.default("USD") }),
    response: z.object({ portfolio: PortfolioSnapshotSchema }),
  }),
} as const;

export type ApiWallets = typeof apiWallets;
