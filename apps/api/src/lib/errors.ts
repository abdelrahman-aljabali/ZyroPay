import type { ApiErrorBody, ErrorCode } from "@zyropay/shared";
import {
  apiError,
  httpStatusFor,
  IllegalTransitionError,
  MoneyError,
  NetworkModeError,
} from "@zyropay/shared";
import { ZodError } from "zod";
import { ConfigError } from "../env";

/** The only error type handlers throw on purpose. Messages are safe to show to clients. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "resource"): AppError =>
  new AppError("NOT_FOUND", `${what} not found`);

/**
 * Map any thrown value to a safe error envelope. Unknown errors become INTERNAL_ERROR with
 * a generic message: no stack traces, SQL, upstream bodies or secrets reach clients.
 */
export function toErrorResponse(error: unknown): {
  status: number;
  body: ApiErrorBody;
  expected: boolean;
} {
  if (error instanceof AppError) {
    return {
      status: httpStatusFor(error.code),
      body: apiError(error.code, error.message, error.details),
      expected: true,
    };
  }
  if (error instanceof ZodError) {
    const issues = error.issues
      .slice(0, 20)
      .map((i) => ({ path: i.path.join("."), message: i.message }));
    return {
      status: httpStatusFor("VALIDATION_FAILED"),
      body: apiError("VALIDATION_FAILED", "request validation failed", { issues }),
      expected: true,
    };
  }
  if (error instanceof IllegalTransitionError) {
    return {
      status: httpStatusFor("ILLEGAL_STATE_TRANSITION"),
      body: apiError("ILLEGAL_STATE_TRANSITION", `request is ${error.from}`),
      expected: true,
    };
  }
  if (error instanceof NetworkModeError) {
    return {
      status: httpStatusFor("NETWORK_MODE_MISMATCH"),
      body: apiError("NETWORK_MODE_MISMATCH", error.message),
      expected: true,
    };
  }
  if (error instanceof MoneyError) {
    return {
      status: httpStatusFor("BAD_REQUEST"),
      body: apiError("BAD_REQUEST", "invalid amount"),
      expected: true,
    };
  }
  if (error instanceof ConfigError) {
    return {
      status: httpStatusFor("INTERNAL_ERROR"),
      body: apiError("INTERNAL_ERROR", "service misconfigured"),
      expected: false,
    };
  }
  return {
    status: httpStatusFor("INTERNAL_ERROR"),
    body: apiError("INTERNAL_ERROR", "internal error"),
    expected: false,
  };
}

/** Postgres unique_violation (23505), from node-postgres / neon / PGlite error shapes. */
export function isUniqueViolation(error: unknown): boolean {
  for (
    let e: unknown = error, depth = 0;
    e !== null && typeof e === "object" && depth < 5;
    depth++
  ) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
