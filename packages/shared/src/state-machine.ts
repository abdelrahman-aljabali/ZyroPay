import { z } from "zod";

/**
 * Lifecycle of a transaction request (agent- or user-initiated).
 *
 *   CREATED -> POLICY_CHECK -> APPROVED ---------> SIGNING -> BROADCAST -> CONFIRMED
 *                          \-> PENDING_APPROVAL -/        \            \-> FAILED
 *                          \-> REJECTED                    \-> FAILED
 *
 * EXPIRED / CANCELLED are reachable only before signing starts: once a signature may
 * exist, only the chain decides the outcome (CONFIRMED or FAILED).
 */
export const TX_REQUEST_STATES = [
  "CREATED",
  "POLICY_CHECK",
  "PENDING_APPROVAL",
  "APPROVED",
  "SIGNING",
  "BROADCAST",
  "CONFIRMED",
  "REJECTED",
  "EXPIRED",
  "FAILED",
  "CANCELLED",
] as const;
export const TxRequestStateSchema = z.enum(TX_REQUEST_STATES);
export type TxRequestState = z.infer<typeof TxRequestStateSchema>;

export const TX_REQUEST_EVENTS = [
  /** Validation passed; policy evaluation begins. */
  "START_POLICY_CHECK",
  /** Policy decision `allow` (autonomous within limits). */
  "POLICY_ALLOWED",
  /** Policy decision `require_approval`. */
  "POLICY_REQUIRES_APPROVAL",
  /** Policy decision `deny`. */
  "POLICY_DENIED",
  /** User approved in the app (passkey signature over the exact payload). */
  "USER_APPROVED",
  /** User rejected in the app. */
  "USER_REJECTED",
  /** Signer invoked (Turnkey activity submitted). */
  "START_SIGNING",
  /** Signed transaction accepted by the network RPC. */
  "BROADCASTED",
  /** Reached the required confirmation depth. */
  "CONFIRMED",
  /** Unrecoverable error (signing refused, broadcast rejected, reverted, dropped). */
  "FAIL",
  /** Deadline (`expiresAt`) passed before signing started. */
  "EXPIRE",
  /** Requester or user withdrew the request before signing started. */
  "CANCEL",
] as const;
export const TxRequestEventSchema = z.enum(TX_REQUEST_EVENTS);
export type TxRequestEvent = z.infer<typeof TxRequestEventSchema>;

type TransitionTable = Readonly<
  Record<TxRequestState, Readonly<Partial<Record<TxRequestEvent, TxRequestState>>>>
>;

/** The ONLY legal transitions. Anything not listed throws. */
export const TX_REQUEST_TRANSITIONS: TransitionTable = {
  CREATED: {
    START_POLICY_CHECK: "POLICY_CHECK",
    FAIL: "FAILED",
    EXPIRE: "EXPIRED",
    CANCEL: "CANCELLED",
  },
  POLICY_CHECK: {
    POLICY_ALLOWED: "APPROVED",
    POLICY_REQUIRES_APPROVAL: "PENDING_APPROVAL",
    POLICY_DENIED: "REJECTED",
    FAIL: "FAILED",
    EXPIRE: "EXPIRED",
    CANCEL: "CANCELLED",
  },
  PENDING_APPROVAL: {
    USER_APPROVED: "APPROVED",
    USER_REJECTED: "REJECTED",
    EXPIRE: "EXPIRED",
    CANCEL: "CANCELLED",
  },
  APPROVED: {
    START_SIGNING: "SIGNING",
    FAIL: "FAILED",
    EXPIRE: "EXPIRED",
    CANCEL: "CANCELLED",
  },
  SIGNING: {
    BROADCASTED: "BROADCAST",
    FAIL: "FAILED",
  },
  BROADCAST: {
    CONFIRMED: "CONFIRMED",
    FAIL: "FAILED",
  },
  CONFIRMED: {},
  REJECTED: {},
  EXPIRED: {},
  FAILED: {},
  CANCELLED: {},
};

export const TERMINAL_STATES: readonly TxRequestState[] = TX_REQUEST_STATES.filter(
  (s) => Object.keys(TX_REQUEST_TRANSITIONS[s]).length === 0,
);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TxRequestState,
    readonly event: TxRequestEvent,
  ) {
    super(`illegal transition: ${event} in state ${from}`);
    this.name = "IllegalTransitionError";
  }
}

/** Pure transition function. Throws IllegalTransitionError for any unlisted pair. */
export function transition(state: TxRequestState, event: TxRequestEvent): TxRequestState {
  const next = TX_REQUEST_TRANSITIONS[state][event];
  if (next === undefined) throw new IllegalTransitionError(state, event);
  return next;
}

export function canTransition(state: TxRequestState, event: TxRequestEvent): boolean {
  return TX_REQUEST_TRANSITIONS[state][event] !== undefined;
}

export function allowedEvents(state: TxRequestState): TxRequestEvent[] {
  return TX_REQUEST_EVENTS.filter((e) => canTransition(state, e));
}

export function isTerminalState(state: TxRequestState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * States in which a signature may exist, so the request can no longer be withdrawn.
 * (FAILED is excluded: it is also reachable before signing.)
 */
export function isPastPointOfNoReturn(state: TxRequestState): boolean {
  return state === "SIGNING" || state === "BROADCAST" || state === "CONFIRMED";
}
