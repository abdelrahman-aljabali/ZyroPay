import { z } from "zod";
import { AddressSchema } from "../addresses";
import { IsoDateTimeSchema } from "../common";
import { BaseUnitAmountSchema, FiatValueSchema } from "../money";
import { NetworkIdSchema } from "../networks";
import { AssetSchema, PriceBasisSchema } from "./assets";

export const TransactionDirectionSchema = z.enum(["in", "out", "self"]);
export type TransactionDirection = z.infer<typeof TransactionDirectionSchema>;

export const ChainTransactionStatusSchema = z.enum(["pending", "confirmed", "failed"]);
export type ChainTransactionStatus = z.infer<typeof ChainTransactionStatusSchema>;

/** Normalized on-chain transfer as shown in history. One row per asset movement. */
export const TransactionSchema = z.object({
  id: z.uuid(),
  walletId: z.uuid(),
  network: NetworkIdSchema,
  /** EVM tx hash (0x...) or Solana signature (base58). */
  txHash: z.string().min(1).max(128),
  direction: TransactionDirectionSchema,
  status: ChainTransactionStatusSchema,
  from: AddressSchema,
  to: AddressSchema,
  asset: AssetSchema,
  amount: BaseUnitAmountSchema,
  /** Fee in the network's native asset base units; null for incoming transfers. */
  fee: BaseUnitAmountSchema.nullable(),
  valueAtTime: FiatValueSchema.nullable(),
  /** Set with `valueAtTime`: `mainnet_proxy` = valued at the mainnet counterpart's price. */
  priceBasis: PriceBasisSchema.nullable().optional(),
  timestamp: IsoDateTimeSchema,
  blockNumber: z.string().regex(/^\d+$/).nullable(),
  /** Set when the transfer originated from a ZyroPay transaction request. */
  transactionRequestId: z.uuid().nullable(),
  explorerUrl: z.url().nullable(),
  simulated: z.boolean(),
});
export type Transaction = z.infer<typeof TransactionSchema>;
