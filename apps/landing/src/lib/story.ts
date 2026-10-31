import { useCallback, useEffect, useRef, useState } from "react";
import { SCENARIOS, type Scenario } from "./content";

/**
 * The hero narrative: a simulation of the app's approval flow, nothing is sent anywhere.
 *
 *   idle ─► thinking ─► typing ─► requesting ─► arrived ─┬─► (holding) ─► approved ─► paid
 *                                                        └─► rejected   (swipe left / Reject)
 *
 * Everything up to "arrived" is timed. From "arrived" on, nothing happens until the visitor
 * acts (that is the product's whole point), unless `?autohold=1` / `?autoreject=1` is set,
 * which the QA capture scripts use to record the full sequence.
 */
export type Phase =
  | "idle"
  | "thinking"
  | "typing"
  | "requesting"
  | "arrived"
  | "holding"
  | "approved"
  | "paid"
  | "rejected";

const ORDER: readonly Phase[] = [
  "idle",
  "thinking",
  "typing",
  "requesting",
  "arrived",
  "holding",
  "approved",
  "paid",
];

/** True when phase `a` is at or past phase `b` on the approve path. */
export function reached(a: Phase, b: Phase): boolean {
  if (a === "rejected") return b === "rejected" || ORDER.indexOf(b) <= ORDER.indexOf("arrived");
  return ORDER.indexOf(a) >= ORDER.indexOf(b);
}

/** Milliseconds. */
const T = {
  thinking: 700,
  typing: 1500,
  charMs: 24,
  buzzAfterTyped: 450,
  arriveAfterBuzz: 1300,
  approvedToPaid: 900,
} as const;

export const HOLD_MS = 1200;

/** Window event other islands use to switch the hero's scenario (the "try to hack it" panel). */
export const SCENARIO_EVENT = "zyropay:scenario";

export interface Story {
  readonly scenario: Scenario;
  readonly phase: Phase;
  /** The assistant's request line as typed so far. */
  readonly typed: string;
  /** Increments on every buzz so the phone can key an animation off it. */
  readonly buzz: number;
  readonly reducedMotion: boolean;
  /** QA only: the phone acts by itself. */
  readonly auto: "hold" | "reject" | null;
  readonly setHolding: (holding: boolean) => void;
  readonly approve: () => void;
  readonly reject: () => void;
  readonly replay: () => void;
  readonly play: (scenario: Scenario) => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useStory(): Story {
  const [scenario, setScenario] = useState<Scenario>("honest");
  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState("");
  const [buzz, setBuzz] = useState(0);
  const [run, setRun] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [auto, setAuto] = useState<"hold" | "reject" | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    setReducedMotion(prefersReducedMotion());
    const q = new URLSearchParams(window.location.search);
    if (q.get("autohold") === "1") setAuto("hold");
    if (q.get("autoreject") === "1") setAuto("reject");
    if (q.get("scenario") === "attack") setScenario("attack");
  }, []);

  useEffect(() => {
    const reduce = prefersReducedMotion();
    const at = (ms: number, fn: () => void) => {
      timers.current.push(window.setTimeout(fn, ms));
    };
    const line = SCENARIOS[scenario].request;

    setTyped("");
    setPhase("idle");

    if (reduce) {
      at(300, () => {
        setTyped(line);
        setPhase("requesting");
      });
      at(900, () => {
        setPhase("arrived");
      });
    } else {
      at(T.thinking, () => {
        setPhase("thinking");
      });
      at(T.typing, () => {
        setPhase("typing");
      });
      for (let i = 1; i <= line.length; i++) {
        at(T.typing + i * T.charMs, () => {
          setTyped(line.slice(0, i));
        });
      }
      const typedAt = T.typing + line.length * T.charMs;
      at(typedAt + T.buzzAfterTyped, () => {
        setPhase("requesting");
        setBuzz((b) => b + 1);
      });
      at(typedAt + T.buzzAfterTyped + T.arriveAfterBuzz, () => {
        setPhase("arrived");
      });
    }

    const pending = timers.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
      timers.current = [];
    };
  }, [scenario, run]);

  const setHolding = useCallback((holding: boolean) => {
    setPhase((p) => {
      if (holding && p === "arrived") return "holding";
      if (!holding && p === "holding") return "arrived";
      return p;
    });
  }, []);

  const approve = useCallback(() => {
    setPhase("approved");
    timers.current.push(
      window.setTimeout(
        () => {
          setPhase("paid");
        },
        prefersReducedMotion() ? 200 : T.approvedToPaid,
      ),
    );
  }, []);

  const reject = useCallback(() => {
    setPhase((p) => (p === "arrived" || p === "holding" ? "rejected" : p));
  }, []);

  // Reset in the same update as the switch, so no frame shows the new scenario in an old phase.
  const replay = useCallback(() => {
    setPhase("idle");
    setTyped("");
    setRun((r) => r + 1);
  }, []);

  const play = useCallback((next: Scenario) => {
    setPhase("idle");
    setTyped("");
    setScenario(next);
    setRun((r) => r + 1);
  }, []);

  // Other islands can start a scenario (e.g. "See it on the phone" in the attack panel).
  useEffect(() => {
    const onScenario = (e: Event) => {
      // The event comes from outside React: validate it rather than trusting the cast.
      const next: unknown = (e as CustomEvent<unknown>).detail;
      if (next === "honest" || next === "attack") play(next);
    };
    window.addEventListener(SCENARIO_EVENT, onScenario);
    return () => {
      window.removeEventListener(SCENARIO_EVENT, onScenario);
    };
  }, [play]);

  return {
    scenario,
    phase,
    typed,
    buzz,
    reducedMotion,
    auto,
    setHolding,
    approve,
    reject,
    replay,
    play,
  };
}

/** One calm screen-reader announcement per step (the typing itself is not announced). */
export function announcement(phase: Phase, scenario: Scenario): string {
  const s = SCENARIOS[scenario];
  switch (phase) {
    case "idle":
    case "thinking":
    case "typing":
      return "";
    case "requesting":
      return `Claude: ${s.request}`;
    case "arrived":
    case "holding":
      return `A payment request for ${s.card.amount} ${s.card.asset} is on the phone. Press and hold to approve, or reject it.`;
    case "approved":
      return "Approved.";
    case "paid":
      return scenario === "honest"
        ? `Claude: ${s.paid} ${s.receipt} Receipt stamped: verified on Cardano.`
        : `Claude: ${s.paid} ${s.receipt}`;
    case "rejected":
      return s.rejected;
  }
}
