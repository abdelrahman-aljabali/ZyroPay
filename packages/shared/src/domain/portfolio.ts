import { z } from "zod";
import { IsoDateTimeSchema } from "../common";
import { FiatCurrencySchema, FiatValueSchema } from "../money";
import { NetworkIdSchema } from "../networks";
import { BalanceSchema } from "./assets";

export const PortfolioSnapshotSchema = z.object({
  /** When the underlying chain data was read. */
  asOf: IsoDateTimeSchema,
  /** True when served from cache past its freshness window or a provider failed. */
  stale: z.boolean(),
  currency: FiatCurrencySchema,
  /** Sum of priced balances only; see `unpricedAssetCount`. */
  totalValue: FiatValueSchema,
  unpricedAssetCount: z.number().int().min(0),
  networks: z.array(NetworkIdSchema),
  balances: z.array(BalanceSchema),
  simulated: z.boolean(),
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;
