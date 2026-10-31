import { z } from "zod";

/** Closed set of API error codes, with the HTTP status each maps to. */
export const ERROR_HTTP_STATUS = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  ILLEGAL_STATE_TRANSITION: 409,
  PAYLOAD_HASH_MISMATCH: 409,
  REQUEST_EXPIRED: 410,
  POLICY_DENIED: 403,
  NETWORK_NOT_SUPPORTED: 400,
  NETWORK_MODE_MISMATCH: 400,
  INVALID_ADDRESS: 422,
  DECIMALS_MISMATCH: 422,
  INSUFFICIENT_FUNDS: 422,
  PLUGIN_DISABLED: 403,
  SWAP_UNAVAILABLE_ON_NETWORK: 422,
  VALUATION_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  SIGNING_FAILED: 502,
  BROADCAST_FAILED: 502,
  WEBHOOK_SIGNATURE_INVALID: 401,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;
export const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export function apiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}
