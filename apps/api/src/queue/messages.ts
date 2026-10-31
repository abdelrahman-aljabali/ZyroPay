import { z } from "zod";

/** Async stages. Every handler is idempotent: redelivery and duplicates are no-ops. */
export const QueueMessageSchema = z.discriminatedUnion("type", [
  /** Autonomous (delegated-key) signing of an APPROVED agent request. */
  z.object({ type: z.literal("execute"), requestId: z.uuid() }),
  /** (Re)broadcast the stored signed bytes of a SIGNING request. */
  z.object({ type: z.literal("broadcast"), requestId: z.uuid() }),
  /** Poll chain status of a BROADCAST request. */
  z.object({ type: z.literal("confirm"), requestId: z.uuid() }),
  /** Push notification; deduplicated by `dedupeKey`. */
  z.object({
    type: z.literal("notify"),
    dedupeKey: z.string().min(1).max(200),
    userId: z.uuid(),
    event: z.string().min(1).max(64),
    title: z.string().max(120),
    body: z.string().max(400),
    data: z.record(z.string(), z.string()),
  }),
  /** Check Expo push receipts ~15 min after sending; DeviceNotRegistered deactivates tokens. */
  z.object({
    type: z.literal("push_receipts"),
    tickets: z
      .array(z.object({ ticketId: z.string().min(1).max(128), token: z.string().min(1).max(300) }))
      .min(1)
      .max(100),
  }),
  /** Push an agent revocation to the MCP worker (retried until it succeeds or DLQ). */
  z.object({ type: z.literal("mcp_revoke"), agentId: z.uuid(), userId: z.uuid() }),
  /** Process a stored, signature-verified webhook event. */
  z.object({ type: z.literal("webhook"), webhookEventId: z.uuid() }),
]);
export type QueueMessage = z.infer<typeof QueueMessageSchema>;

export interface JobQueue {
  send(message: QueueMessage, options?: { delaySeconds?: number }): Promise<void>;
}

/** Test/dev queue: messages are collected and drained explicitly. */
export class InMemoryQueue implements JobQueue {
  readonly messages: { message: QueueMessage; delaySeconds: number }[] = [];
  send(message: QueueMessage, options?: { delaySeconds?: number }): Promise<void> {
    this.messages.push({
      message: QueueMessageSchema.parse(message),
      delaySeconds: options?.delaySeconds ?? 0,
    });
    return Promise.resolve();
  }
  take(): QueueMessage[] {
    return this.messages.splice(0, this.messages.length).map((m) => m.message);
  }
}

/** Cloudflare Queues producer. */
export class CloudflareQueue implements JobQueue {
  constructor(private readonly queue: Queue<QueueMessage>) {}
  async send(message: QueueMessage, options?: { delaySeconds?: number }): Promise<void> {
    await this.queue.send(QueueMessageSchema.parse(message), {
      contentType: "json",
      ...(options?.delaySeconds !== undefined ? { delaySeconds: options.delaySeconds } : {}),
    });
  }
}
