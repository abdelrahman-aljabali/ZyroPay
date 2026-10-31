import { useEffect, useRef, useState, type ReactNode } from "react";
import { MARK_PATH, MARK_TILE_RADIUS } from "../../lib/brand";
import { AGENT, CLOCK, SCENARIOS, type Scenario } from "../../lib/content";
import { reached, type Phase } from "../../lib/story";
import { HoldButton } from "./HoldButton";

export type Scheme = "light" | "dark";

interface ApprovalScreenProps {
  readonly scenario: Scenario;
  readonly phase: Phase;
  readonly scheme: Scheme;
  readonly auto: "hold" | "reject" | null;
  readonly onHoldingChange: (holding: boolean) => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onReplay: () => void;
  readonly onTryOther: () => void;
}

/** Counts down from 9:58 once the request is on screen, like the app's expiry pill. */
function Expiry({ running }: { readonly running: boolean }) {
  const [left, setLeft] = useState(598);
  useEffect(() => {
    if (!running) {
      setLeft(598);
      return;
    }
    const id = window.setInterval(() => {
      setLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [running]);
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");
  return (
    <span className="zp-pill zp-pill--time">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
      <span className="zp-tabular">{`${m}:${s}`}</span>
    </span>
  );
}

function StatusBar() {
  return (
    <div className="zp-status" aria-hidden="true">
      <span className="zp-status__time">{CLOCK.now}</span>
      <span className="zp-status__icons">
        <svg viewBox="0 0 18 12">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        <svg viewBox="0 0 16 12">
          <path d="M8 11.5l2.4-2.9a3.6 3.6 0 0 0-4.8 0zM3.6 6.4a6.6 6.6 0 0 1 8.8 0l1.5-1.8a9 9 0 0 0-11.8 0zM.2 2.4a11.8 11.8 0 0 1 15.6 0L14.6 3.9 14.3 4.2a9.8 9.8 0 0 0-12.6 0z" />
        </svg>
        <svg viewBox="0 0 27 12">
          <rect x=".5" y=".5" width="22" height="11" rx="3.5" fill="none" strokeWidth="1" />
          <rect x="2.5" y="2.5" width="16" height="7" rx="2" />
          <path d="M24.5 4v4a2 2 0 0 0 0-4z" />
        </svg>
      </span>
    </div>
  );
}

function AppMark({ small = false }: { readonly small?: boolean }) {
  return (
    <svg className={small ? "zp-mark zp-mark--sm" : "zp-mark"} viewBox="0 0 100 100">
      <rect width="100" height="100" rx={MARK_TILE_RADIUS} />
      <path d={MARK_PATH} />
    </svg>
  );
}

function Home({ scheme }: { readonly scheme: Scheme }) {
  const on = scheme === "dark" ? "on-dark" : "on-light";
  return (
    <div className="zp-home" aria-hidden="true">
      <div className="zp-home__top">
        <AppMark />
        <span className="zp-round">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
          </svg>
        </span>
      </div>
      <p className="zp-home__label">Total balance</p>
      <p className="zp-home__balance">
        $2,480<span>.16</span>
      </p>
      <p className="zp-home__delta">↑ $12.40 (0.50%) Today</p>
      <div className="zp-home__actions">
        <span className="zp-btn zp-btn--primary">+ Top up</span>
        <span className="zp-btn">↑ Send</span>
        <span className="zp-btn">↓ Receive</span>
      </div>
      <div className="zp-list">
        {[
          ["Solana", "/brand/solana.svg", "$1,182.40", "8.3 SOL"],
          ["Ether", `/brand/ethereum-${on}.svg`, "$904.12", "0.35 ETH"],
          ["Cardano", `/brand/cardano-${on}.svg`, "$393.64", "820 ADA"],
        ].map(([name, logo, usd, amt]) => (
          <div className="zp-list__row" key={name}>
            <span className="zp-plate">
              <img src={logo} alt="" width="20" height="20" />
            </span>
            <span className="zp-list__name">{name}</span>
            <span className="zp-list__val">
              <b>{usd}</b>
              <i>{amt}</i>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The app's tab bar (apps/mobile/src/app/(tabs)/_layout.tsx): Home is selected. */
function TabBar({ pending }: { readonly pending: boolean }) {
  const tabs: { name: string; icon: ReactNode }[] = [
    {
      name: "Home",
      icon: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />,
    },
    {
      name: "Wallets",
      icon: (
        <>
          <rect x="3.5" y="6" width="17" height="13" rx="2.5" />
          <path d="M3.5 9.5h17M15.5 14h2" />
        </>
      ),
    },
    {
      name: "Agents",
      icon: (
        <path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />
      ),
    },
    {
      name: "Approvals",
      icon: (
        <>
          <path d="M12 3l7 3v5.5c0 4.4-3 7.9-7 9.5-4-1.6-7-5.1-7-9.5V6z" />
          <path d="M9 12l2 2 4-4" />
        </>
      ),
    },
    {
      name: "Settings",
      icon: (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
        </>
      ),
    },
  ];
  return (
    <nav className="zp-tabs" aria-hidden="true">
      {tabs.map((t, i) => (
        <span key={t.name} className="zp-tabs__tab" data-on={i === 0 ? "true" : "false"}>
          <svg viewBox="0 0 24 24">{t.icon}</svg>
          {t.name === "Approvals" && pending ? <i className="zp-tabs__badge">1</i> : null}
          <span>{t.name}</span>
        </span>
      ))}
    </nav>
  );
}

/**
 * The review card follows the finger when dragged left; past a distance or with a quick flick it
 * leaves and rejects the request. Dragging right meets friction instead of a hard stop.
 */
function useSwipeToReject(enabled: boolean, onReject: () => void) {
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x0: number; t0: number; dx: number } | null>(null);

  const setX = (x: number, animate: boolean) => {
    const el = card.current;
    if (!el) return;
    el.style.transition = animate ? "transform 320ms cubic-bezier(0.23, 1, 0.32, 1)" : "none";
    el.style.transform = x === 0 ? "" : `translate3d(${x}px,0,0) rotate(${x / 60}deg)`;
  };

  useEffect(() => {
    if (!enabled) setX(0, false);
  }, [enabled]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || drag.current) return;
      // The hold button and the reject button handle their own presses.
      if ((e.target as HTMLElement).closest("button")) return;
      drag.current = { id: e.pointerId, x0: e.clientX, t0: performance.now(), dx: 0 };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const raw = e.clientX - d.x0;
      d.dx = raw > 0 ? raw * 0.25 : raw;
      setX(d.dx, false);
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      const width = card.current?.offsetWidth ?? 300;
      const velocity = Math.abs(d.dx) / Math.max(1, performance.now() - d.t0);
      if (d.dx < -width * 0.33 || (d.dx < -24 && velocity > 0.5)) {
        setX(-width * 1.4, true);
        window.setTimeout(onReject, 220);
      } else {
        setX(0, true);
      }
    },
    onPointerCancel: () => {
      drag.current = null;
      setX(0, true);
    },
  };

  return { card, handlers };
}

/**
 * Faithful recreation of the app's approval flow (apps/mobile, "Review request"), simulated.
 * Sized in container units (1 app point = 100cqw / 393), so it stays crisp at any phone size.
 */
export function ApprovalScreen({
  scenario,
  phase,
  scheme,
  auto,
  onHoldingChange,
  onApprove,
  onReject,
  onReplay,
  onTryOther,
}: ApprovalScreenProps) {
  const s = SCENARIOS[scenario];
  const c = s.card;
  const banner = phase === "requesting";
  const sheet = reached(phase, "arrived") && phase !== "rejected";
  const live = phase === "arrived" || phase === "holding";
  const approved = reached(phase, "approved") && phase !== "rejected";
  const paid = phase === "paid";
  const rejected = phase === "rejected";
  const { card, handlers } = useSwipeToReject(live, onReject);

  // QA: reject by itself.
  useEffect(() => {
    if (auto !== "reject" || phase !== "arrived") return;
    const id = window.setTimeout(onReject, 1200);
    return () => {
      window.clearTimeout(id);
    };
  }, [auto, phase, onReject]);

  return (
    <div className="zp-app" data-scheme={scheme} data-phase={phase} data-scenario={scenario}>
      <StatusBar />
      <Home scheme={scheme} />
      <TabBar pending={reached(phase, "requesting") && !approved && !rejected} />

      <div className="zp-banner" data-on={banner ? "true" : "false"} aria-hidden="true">
        <AppMark small />
        <span className="zp-banner__text">
          <b>ZyroPay</b>
          <span>
            {AGENT.name} wants to pay {c.amount} {c.asset}
          </span>
        </span>
        <span className="zp-banner__now">now</span>
      </div>

      <div className="zp-scrim" data-on={sheet ? "true" : "false"} aria-hidden="true" />

      <section
        className="zp-sheet"
        data-on={sheet ? "true" : "false"}
        aria-label="Payment request (simulated)"
        aria-hidden={!sheet}
        inert={!sheet}
      >
        <p className="zp-sheet__title">Review request</p>
        <div className="zp-card" ref={card} {...handlers}>
          <div className="zp-card__head">
            <span className="zp-avatar" aria-hidden="true">
              {AGENT.initial}
            </span>
            <span className="zp-card__who">
              <b>{AGENT.name}</b>
              <span>{c.action}</span>
            </span>
            <Expiry running={live} />
          </div>
          <p className="zp-amount">
            {c.amount} {c.asset}
          </p>
          <p className="zp-fiat">{c.fiat}</p>
          <hr />
          <dl className="zp-rows">
            <div>
              <dt>To</dt>
              <dd className="zp-mono">{c.to}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>
                <span className="zp-plate zp-plate--sm zp-plate--cardano" aria-hidden="true">
                  <img
                    src={`/brand/cardano-${scheme === "dark" ? "on-dark" : "on-light"}.svg`}
                    alt=""
                    width="12"
                    height="12"
                  />
                </span>
                {c.network}
              </dd>
            </div>
          </dl>
          <div className="zp-chips">
            {c.risks.map((r) => (
              <span key={r.label} className={`zp-chip zp-chip--${r.tone}`}>
                {r.tone === "ok" ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 3l7 3v5.5c0 4.4-3 7.9-7 9.5-4-1.6-7-5.1-7-9.5V6z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                ) : r.tone === "escrow" ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
                    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
                  </svg>
                ) : r.tone === "danger" ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 4l9 16H3z" />
                    <path d="M12 10v4M12 17.2v.1" />
                  </svg>
                ) : null}
                {r.label}
              </span>
            ))}
          </div>
          <HoldButton
            label={c.hold}
            doneLabel="Approved"
            done={approved}
            disabled={!live && !approved}
            ariaLabel={`${c.hold}: pay ${c.amount} ${c.asset} to ${c.to}. Press and hold. Simulated.`}
            autoHold={auto === "hold"}
            onHoldingChange={onHoldingChange}
            onComplete={onApprove}
          />
          <button type="button" className="zp-reject" onClick={onReject} disabled={!live}>
            ‹ Swipe left to reject
          </button>
        </div>
        <p className="zp-sheet__sub" aria-hidden="true">
          Details
        </p>
        <dl className="zp-card zp-rows zp-details" aria-hidden="true">
          <div>
            <dt>Agent</dt>
            <dd>
              <b>{AGENT.name}</b>
            </dd>
          </div>
          <div>
            <dt>Action</dt>
            <dd>{scenario === "honest" ? "Pay (x402)" : "Send"}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              <b>
                {c.amount} {c.asset}
              </b>
            </dd>
          </div>
          <div>
            <dt>Settlement</dt>
            <dd>{scenario === "honest" ? "Masumi escrow" : "Direct"}</dd>
          </div>
        </dl>
      </section>

      <div
        className="zp-end"
        data-on={paid || rejected ? "true" : "false"}
        data-tone={rejected ? "danger" : "success"}
        aria-hidden={!(paid || rejected)}
      >
        <span className="zp-end__icon" aria-hidden="true">
          {rejected ? (
            <svg viewBox="0 0 24 24">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24">
              <path d="M6 12.5l4 4 8-9" />
            </svg>
          )}
        </span>
        <p className="zp-end__title">{rejected ? "Blocked" : `Paid ${c.amount} ${c.asset}`}</p>
        <p className="zp-end__detail">
          {rejected
            ? "Rejected by you · nothing was sent"
            : scenario === "honest"
              ? "Locked in escrow · signed in a secure enclave"
              : `Signed in a secure enclave · ${c.network}`}
        </p>
        <div className="zp-end__actions">
          <button
            type="button"
            className="zp-replay"
            onClick={onReplay}
            tabIndex={paid || rejected ? 0 : -1}
          >
            Replay
          </button>
          <button
            type="button"
            className="zp-replay zp-replay--strong"
            onClick={onTryOther}
            tabIndex={paid || rejected ? 0 : -1}
          >
            {scenario === "honest" ? "Try an attack" : "Honest request"}
          </button>
        </div>
      </div>
      <span className="zp-homebar" aria-hidden="true" />
    </div>
  );
}
