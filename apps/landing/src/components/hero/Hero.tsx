import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { AGENT, EYEBROW, LEDE, LEDE_SHORT, SCENARIOS, type Scenario } from "../../lib/content";
import { announcement, reached, useStory, type Phase } from "../../lib/story";
import { ApprovalScreen } from "../phone/ApprovalScreen";
import { Phone, PhoneScreen } from "../phone/Phone";
import { Receipt } from "../receipt/Receipt";

const PhoneScene = lazy(() => import("./PhoneScene"));

/**
 * 3D only where it is cheap: wide screens, WebGL2, no reduced motion, no data saver and a
 * reasonably capable device. Everything else keeps the CSS phone, which tells the same story.
 * `?3d=1` / `?3d=0` force either path (QA).
 */
function canRender3D(): boolean {
  const force = new URLSearchParams(window.location.search).get("3d");
  if (force === "1") return true;
  if (force === "0") return false;
  if (!window.matchMedia("(min-width: 1100px)").matches) return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  if (nav.connection?.saveData === true) return false;
  if ((nav.hardwareConcurrency || 8) < 4) return false;
  if ((nav.deviceMemory ?? 8) < 4) return false;
  try {
    const c = document.createElement("canvas");
    return c.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

function ScenarioSwitch({
  scenario,
  onPick,
  className,
}: {
  readonly scenario: Scenario;
  readonly onPick: (s: Scenario) => void;
  readonly className?: string;
}) {
  return (
    <div
      className={`s-seg${className ? ` ${className}` : ""}`}
      role="radiogroup"
      aria-label="Scenario"
    >
      {(["honest", "attack"] as const).map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={scenario === key}
          className="s-seg__btn"
          onClick={() => {
            onPick(key);
          }}
        >
          {SCENARIOS[key].tab}
        </button>
      ))}
    </div>
  );
}

/**
 * Small screens: the conversation as one incoming message at a time, in a fixed-height slot
 * directly above the phone, so the approval card stays in the first viewport and nothing
 * below it ever moves. Screen readers get the same story from the live announcer instead.
 */
function MiniChat({
  phase,
  scenario,
  typed,
}: {
  readonly phase: Phase;
  readonly scenario: Scenario;
  readonly typed: string;
}) {
  const s = SCENARIOS[scenario];
  let who: "you" | "ai" = "ai";
  let body: ReactNode;
  let tone: "plain" | "danger" | "ok" = "plain";
  const dots = (
    <span className="s-dots">
      <i />
      <i />
      <i />
    </span>
  );
  switch (phase) {
    case "idle":
      who = "you";
      body = s.user;
      break;
    case "thinking":
      body = dots;
      break;
    case "typing":
      body = typed || dots;
      break;
    case "requesting":
    case "arrived":
    case "holding":
    case "approved":
      body = typed || s.request;
      break;
    case "paid":
      body = `${s.paid} ${s.receipt}`;
      tone = "ok";
      break;
    case "rejected":
      body = s.rejected;
      tone = "danger";
      break;
  }
  // Three short lines at most on small screens.
  if (typeof body === "string" && body.length > 84) body = `${body.slice(0, 81).trimEnd()}…`;
  return (
    <div className="s-mini" aria-hidden="true">
      <div
        className="s-mini__msg"
        data-who={who}
        data-tone={tone}
        key={`${scenario}-${who}-${tone}`}
      >
        <span className="s-mini__text">
          <span className="s-mini__who">{who === "you" ? "You" : AGENT.name}</span>
          <span className="s-mini__body">{body}</span>
        </span>
      </div>
    </div>
  );
}

const LABEL = "ZyroPay app, simulated: payment request. Press and hold to approve, or reject.";

export default function Hero() {
  const story = useStory();
  const { phase, typed, scenario } = story;
  const s = SCENARIOS[scenario];
  const root = useRef<HTMLElement>(null);
  const [want3D, setWant3D] = useState(false);
  const [ready3D, setReady3D] = useState(false);
  useEffect(() => {
    if (!canRender3D()) return;
    const start = () => {
      const w = window as Window & {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      };
      if (typeof w.requestIdleCallback === "function")
        w.requestIdleCallback(
          () => {
            setWant3D(true);
          },
          { timeout: 1200 },
        );
      else
        window.setTimeout(() => {
          setWant3D(true);
        }, 300);
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
  }, []);

  const waiting = phase === "arrived" || phase === "holding";
  const lit = reached(phase, "approved") && phase !== "rejected";
  const other: Scenario = scenario === "honest" ? "attack" : "honest";

  const makeScreen = (auto: "hold" | "reject" | null) => (
    <ApprovalScreen
      scenario={scenario}
      phase={phase}
      scheme="light"
      auto={auto}
      onHoldingChange={story.setHolding}
      onApprove={story.approve}
      onReject={story.reject}
      onReplay={story.replay}
      onTryOther={() => {
        story.play(other);
      }}
    />
  );

  return (
    <section
      ref={root}
      className="s-hero"
      aria-labelledby="hero-title"
      data-phase={phase}
      data-scenario={scenario}
      data-3d={ready3D ? "on" : "off"}
    >
      <p className="sr-only" aria-live="polite">
        {announcement(phase, scenario)}
      </p>
      <div className="s-hero__copy">
        <p className="s-eyebrow">
          <span className="s-eyebrow__dot" aria-hidden="true" />
          {EYEBROW}
        </p>
        <h1 id="hero-title" className="s-title">
          <span>Your AI asks.</span> <span>Your passkey decides.</span>{" "}
          <span>Cardano proves it.</span>
        </h1>
        <p className="s-lede">{LEDE}</p>
        <p className="s-mcap">
          {scenario === "honest" ? LEDE_SHORT : "Simulated. Nothing is sent."}
        </p>
        <div className="s-mbar">
          <ScenarioSwitch scenario={scenario} onPick={story.play} className="s-seg--sm" />
        </div>
        <MiniChat phase={phase} scenario={scenario} typed={typed} />

        <div
          className="s-chat"
          role="group"
          aria-label={`Conversation with ${AGENT.name} (simulated)`}
        >
          <div className="s-chat__bar">
            <span className="s-chat__name">
              <span className="s-chat__dot" aria-hidden="true" />
              {AGENT.name}
            </span>
            <ScenarioSwitch scenario={scenario} onPick={story.play} />
          </div>
          <ol className="s-chat__log">
            <li className="s-bubble s-bubble--you">{s.user}</li>
            <li className="s-row" data-on={reached(phase, "thinking") ? "true" : "false"}>
              <span className="s-avatar" aria-hidden="true">
                {AGENT.initial}
              </span>
              <span className="s-bubble s-bubble--ai">
                {phase === "thinking" ? (
                  <span className="s-dots" aria-label={`${AGENT.name} is typing`}>
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  typed
                )}
              </span>
            </li>
            <li className="s-status" data-on={waiting ? "true" : "false"}>
              <span className="s-status__light" aria-hidden="true" />
              {s.waiting}
            </li>
            <li
              className="s-row"
              data-on={phase === "paid" || phase === "rejected" ? "true" : "false"}
              data-tone={phase === "rejected" ? "danger" : "ok"}
            >
              <span className="s-avatar" aria-hidden="true">
                {AGENT.initial}
              </span>
              <span className="s-bubble s-bubble--ai s-bubble--end">
                {phase === "rejected" ? (
                  <b>{s.rejected}</b>
                ) : (
                  <>
                    <b>{s.paid}</b>
                    <span>{s.receipt}</span>
                  </>
                )}
              </span>
            </li>
          </ol>
          <p className="s-chat__note">
            {scenario === "honest"
              ? "The chat and the phone are a simulation. The receipt is from a real run on Cardano preprod."
              : "The chat and the phone are a simulation. Nothing is sent."}
          </p>
        </div>
      </div>

      <div className="s-stage" data-lit={lit ? "true" : "false"}>
        <span className="s-beam" aria-hidden="true" />
        <span className="s-floor" aria-hidden="true" />
        <div className="s-fallback" aria-hidden={ready3D} inert={ready3D}>
          <Phone label={LABEL}>{ready3D ? null : makeScreen(story.auto)}</Phone>
        </div>
        {scenario === "honest" ? (
          <Receipt
            variant="verified"
            stamped={phase === "paid"}
            className="s-hero__receipt"
            hidden={phase !== "paid"}
          />
        ) : null}
        {want3D ? (
          <Suspense fallback={null}>
            <PhoneScene
              lit={lit}
              onReady={() => {
                setReady3D(true);
              }}
              screen={
                <PhoneScreen className="s-screen3d" label={LABEL}>
                  {makeScreen(ready3D ? story.auto : null)}
                </PhoneScreen>
              }
            />
          </Suspense>
        ) : null}
      </div>
    </section>
  );
}
