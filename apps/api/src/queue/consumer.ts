import type { AppDeps } from "../deps";
import { broadcastSigned, confirmRequest, executeAutonomous } from "../services/execution";
import { pushAgentRevocation } from "../services/mcp";
import { dispatchNotification } from "../services/notifications";
import { processWebhookEvent } from "../services/webhooks";
import type { QueueMessage } from "./messages";
import { QueueMessageSchema } from "./messages";

/** Handle one message. Throws on transient failure (the queue retries); idempotent. */
export async function handleMessage(deps: AppDeps, message: QueueMessage): Promise<void> {
  switch (message.type) {
    case "execute":
      return executeAutonomous(deps, message.requestId);
    case "broadcast":
      await broadcastSigned(deps, message.requestId, { inline: false });
      return;
    case "confirm":
      return confirmRequest(deps, message.requestId);
    case "notify":
      return dispatchNotification(deps, message);
    case "mcp_revoke":
      return pushAgentRevocation(
        deps,
        { agentId: message.agentId, userId: message.userId },
        { inline: false },
      );
    case "push_receipts":
      await deps.notifier.checkReceipts?.(message.tickets);
      return;
    case "webhook":
      return processWebhookEvent(deps, message.webhookEventId);
  }
}

export interface RetryableMessage {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Cloudflare Queues batch consumer: per-message ack/retry with backoff; poison messages are dropped. */
export async function consumeBatch(
  deps: AppDeps,
  messages: readonly RetryableMessage[],
): Promise<void> {
  for (const msg of messages) {
    const parsed = QueueMessageSchema.safeParse(msg.body);
    if (!parsed.success) {
      deps.logger.error("queue.poison_message", { issues: parsed.error.issues.length });
      msg.ack();
      continue;
    }
    try {
      await handleMessage(deps, parsed.data);
      msg.ack();
    } catch (error) {
      deps.logger.warn("queue.retry", { type: parsed.data.type, attempts: msg.attempts, error });
      msg.retry({ delaySeconds: Math.min(2 ** Math.min(msg.attempts, 8), 300) });
    }
  }
}
