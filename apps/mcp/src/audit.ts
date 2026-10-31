import type { AuditEvent } from "./contracts/internal";
import { AuditEventSchema, internalContracts } from "./contracts/internal";

/**
 * Audit trail for grant events and tool calls. Never contains tokens, secrets, addresses
 * or amounts: only ids, the tool name, the outcome and the error code.
 */
export interface AuditSink {
  record(event: Omit<AuditEvent, "at">): void;
}

type Waiter = (promise: Promise<unknown>) => void;

export function createAuditSink(options: {
  mode: "log" | "api";
  waitUntil: Waiter;
  forward?: (event: AuditEvent) => Promise<Response>;
}): AuditSink {
  return {
    record(partial) {
      const event = AuditEventSchema.parse({ ...partial, at: new Date().toISOString() });
      // Workers Logs / Logpush pick this up; `audit` is the stable discriminator.
      console.log(JSON.stringify({ audit: event }));
      if (options.mode === "api" && options.forward) {
        const forward = options.forward;
        options.waitUntil(
          forward(event)
            .then((response) => {
              if (!response.ok)
                console.warn(JSON.stringify({ auditForwardFailed: response.status }));
            })
            .catch(() => {
              console.warn(JSON.stringify({ auditForwardFailed: "network" }));
            }),
        );
      }
    },
  };
}

export function auditForwarder(
  fetcher: (request: Request) => Promise<Response>,
  baseUrl: string,
  serviceToken: string,
): (event: AuditEvent) => Promise<Response> {
  return (event) =>
    fetcher(
      new Request(new URL(internalContracts.internalRecordAuditEvent.path, baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5_000),
      }),
    );
}

export const EMPTY_AUDIT: Pick<
  AuditEvent,
  | "userId"
  | "agentId"
  | "clientId"
  | "connectionId"
  | "tool"
  | "errorCode"
  | "requestId"
  | "idempotencyKey"
  | "durationMs"
> = {
  userId: null,
  agentId: null,
  clientId: null,
  connectionId: null,
  tool: null,
  errorCode: null,
  requestId: null,
  idempotencyKey: null,
  durationMs: null,
};
