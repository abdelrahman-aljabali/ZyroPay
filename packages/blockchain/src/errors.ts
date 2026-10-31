import type { ErrorCode } from "@zyropay/shared";

/**
 * Error thrown by every chain/provider adapter. `code` is always one of the shared API error
 * codes, so the API can map it to an HTTP response without string matching.
 */
export class ChainError extends Error {
  readonly code: ErrorCode;
  /** True when retrying the same call later may succeed (rate limit, timeout, 5xx). */
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isChainError(error: unknown): error is ChainError {
  return error instanceof ChainError;
}
