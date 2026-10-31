import { describe, expect, it } from "vitest";
import type { TxRequestEvent, TxRequestState } from "./state-machine";
import {
  allowedEvents,
  IllegalTransitionError,
  isPastPointOfNoReturn,
  isTerminalState,
  TERMINAL_STATES,
  transition,
  TX_REQUEST_EVENTS,
  TX_REQUEST_STATES,
} from "./state-machine";

/**
 * Written independently of the implementation table: the specification of every legal
 * transition. Every (state, event) pair NOT listed here must throw.
 */
const LEGAL: ReadonlyArray<[TxRequestState, TxRequestEvent, TxRequestState]> = [
  ["CREATED", "START_POLICY_CHECK", "POLICY_CHECK"],
  ["CREATED", "FAIL", "FAILED"],
  ["CREATED", "EXPIRE", "EXPIRED"],
  ["CREATED", "CANCEL", "CANCELLED"],
  ["POLICY_CHECK", "POLICY_ALLOWED", "APPROVED"],
  ["POLICY_CHECK", "POLICY_REQUIRES_APPROVAL", "PENDING_APPROVAL"],
  ["POLICY_CHECK", "POLICY_DENIED", "REJECTED"],
  ["POLICY_CHECK", "FAIL", "FAILED"],
  ["POLICY_CHECK", "EXPIRE", "EXPIRED"],
  ["POLICY_CHECK", "CANCEL", "CANCELLED"],
  ["PENDING_APPROVAL", "USER_APPROVED", "APPROVED"],
  ["PENDING_APPROVAL", "USER_REJECTED", "REJECTED"],
  ["PENDING_APPROVAL", "EXPIRE", "EXPIRED"],
  ["PENDING_APPROVAL", "CANCEL", "CANCELLED"],
  ["APPROVED", "START_SIGNING", "SIGNING"],
  ["APPROVED", "FAIL", "FAILED"],
  ["APPROVED", "EXPIRE", "EXPIRED"],
  ["APPROVED", "CANCEL", "CANCELLED"],
  ["SIGNING", "BROADCASTED", "BROADCAST"],
  ["SIGNING", "FAIL", "FAILED"],
  ["BROADCAST", "CONFIRMED", "CONFIRMED"],
  ["BROADCAST", "FAIL", "FAILED"],
];

const legalKey = (s: TxRequestState, e: TxRequestEvent) => `${s}:${e}`;
const legalMap = new Map(LEGAL.map(([s, e, n]) => [legalKey(s, e), n]));

const ALL_PAIRS = TX_REQUEST_STATES.flatMap((s) => TX_REQUEST_EVENTS.map((e) => [s, e] as const));
const ILLEGAL = ALL_PAIRS.filter(([s, e]) => !legalMap.has(legalKey(s, e)));

describe("transaction request state machine", () => {
  it("covers the full state x event space", () => {
    expect(ALL_PAIRS).toHaveLength(TX_REQUEST_STATES.length * TX_REQUEST_EVENTS.length);
    expect(LEGAL.length + ILLEGAL.length).toBe(ALL_PAIRS.length);
  });

  it.each(LEGAL)("%s --%s--> %s", (state, event, next) => {
    expect(transition(state, event)).toBe(next);
  });

  it.each(ILLEGAL)("%s --%s--> throws", (state, event) => {
    expect(() => transition(state, event)).toThrow(IllegalTransitionError);
  });

  it("terminal states are exactly the five outcomes and accept no event", () => {
    expect([...TERMINAL_STATES].sort()).toEqual([
      "CANCELLED",
      "CONFIRMED",
      "EXPIRED",
      "FAILED",
      "REJECTED",
    ]);
    for (const s of TERMINAL_STATES) {
      expect(isTerminalState(s)).toBe(true);
      expect(allowedEvents(s)).toEqual([]);
    }
    expect(isTerminalState("SIGNING")).toBe(false);
  });

  it("cannot cancel or expire once signing may have happened", () => {
    for (const s of ["SIGNING", "BROADCAST"] as const) {
      expect(isPastPointOfNoReturn(s)).toBe(true);
      expect(() => transition(s, "CANCEL")).toThrow(IllegalTransitionError);
      expect(() => transition(s, "EXPIRE")).toThrow(IllegalTransitionError);
    }
  });

  it("every non-terminal state can reach a terminal state", () => {
    for (const start of TX_REQUEST_STATES) {
      const seen = new Set<TxRequestState>([start]);
      const queue: TxRequestState[] = [start];
      while (queue.length > 0) {
        const s = queue.shift()!;
        for (const e of allowedEvents(s)) {
          const n = transition(s, e);
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
      expect([...seen].some(isTerminalState)).toBe(true);
    }
  });

  it("happy paths", () => {
    const run = (events: TxRequestEvent[]) => events.reduce<TxRequestState>(transition, "CREATED");
    expect(
      run(["START_POLICY_CHECK", "POLICY_ALLOWED", "START_SIGNING", "BROADCASTED", "CONFIRMED"]),
    ).toBe("CONFIRMED");
    expect(
      run([
        "START_POLICY_CHECK",
        "POLICY_REQUIRES_APPROVAL",
        "USER_APPROVED",
        "START_SIGNING",
        "BROADCASTED",
        "CONFIRMED",
      ]),
    ).toBe("CONFIRMED");
  });
});
