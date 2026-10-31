import type {
  Clock,
  IdGenerator,
  Notifier,
  OnrampProvider,
  PluginAdapter,
  PortfolioProvider,
  PriceHistoryProvider,
  PriceProvider,
} from "@zyropay/shared";
import type { MasumiRegistryClient } from "@zyropay/integrations";
import type { TurnkeyGateway } from "@zyropay/wallet";
import type { ChainAdapters } from "./chain";
import type { Db } from "./db/client";
import type { AppConfig } from "./env";
import type { Logger } from "./lib/logger";
import type { JobQueue } from "./queue/messages";
import type { McpClient } from "./services/mcp";

/** An accepted push ticket and the device token it was sent to (Expo receipts). */
export interface PushTicketRef {
  readonly ticketId: string;
  readonly token: string;
}

/** Everything the API talks to, wired once per request/batch in providers.ts. */
export interface AppDeps {
  readonly config: AppConfig;
  readonly db: Db;
  readonly turnkey: TurnkeyGateway;
  /** Builders, broadcasters, confirmation tracking and signed-tx tools, routed by network. */
  readonly chain: ChainAdapters;
  readonly portfolio: PortfolioProvider;
  readonly prices: PriceProvider;
  /** Price history for the asset chart (fails closed to "unavailable"). */
  readonly priceHistory: PriceHistoryProvider;
  readonly onramp: OnrampProvider;
  /** Push. The Expo notifier also checks delivery receipts (DeviceNotRegistered). */
  readonly notifier: Notifier & {
    checkReceipts?(tickets: readonly PushTicketRef[]): Promise<unknown>;
  };
  /** Enabled plugin adapters by plugin id (jupiter, x402, ...). */
  readonly plugins: Readonly<Partial<Record<string, PluginAdapter>>>;
  /** Masumi agent registry of the served Cardano network; null when not configured. */
  readonly masumiRegistry: MasumiRegistryClient | null;
  readonly queue: JobQueue;
  /** API -> MCP worker (revocation push); null when neither binding nor URL is configured. */
  readonly mcp: McpClient | null;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** Per-request context passed to services. */
export interface Ctx {
  readonly deps: AppDeps;
  readonly requestId: string;
  /** Client IP (never stored raw; audit stores a salted hash). */
  readonly ip: string | null;
}

export const systemClock: Clock = { now: () => new Date() };
