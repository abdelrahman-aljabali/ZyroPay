import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MARK_PATH, MARK_TILE_RADIUS } from "../../lib/brand";
import { AGENTS, CHAINS, DECISIONS, STEPS, type Decision, type StepState } from "../../lib/flow";

const STEP_WORD: Record<StepState, string> = {
  on: "passed",
  off: "not needed",
  stop: "stopped here",
};

/** Who said yes (or no) for each decision, under the node. */
const DECIDER: Record<Decision["verdict"], string> = {
  auto: "your on-chain allowance",
  passkey: "your passkey",
  denied: "your rules",
  refunded: "the proof check",
  hire: "the agent’s capped budget",
  delivered: "the on-chain result",
};

interface Wire {
  readonly id: string;
  readonly d: string;
  readonly on: boolean;
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${mx.toFixed(1)} ${y1.toFixed(1)} ${mx.toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
};

function Entry({ d }: { d: Decision }) {
  return (
    <>
      <span className={`s-any__pill s-any__pill--${d.verdict}`}>{d.verdictLabel}</span>
      <p className="s-any__line">
        <span>{d.from}</span>
        <span className="s-any__arrow" aria-hidden="true">
          →
        </span>
        <span className="sr-only"> pays </span>
        <b>{d.amount}</b>
        <span className="s-any__arrow" aria-hidden="true">
          →
        </span>
        <span className="sr-only"> to </span>
        <span>{d.to}</span>
      </p>
      <p className="s-any__meta">
        <span>{d.why}</span>
        {d.tx ? (
          <a className="s-any__tx" href={d.tx.url} target="_blank" rel="noopener noreferrer">
            <span aria-hidden="true">tx</span>
            <code>{d.tx.short}</code>
            <span aria-hidden="true">↗</span>
            <span className="sr-only">(transaction on Cardanoscan, opens in a new tab)</span>
          </a>
        ) : (
          <span className="s-any__notx">no transaction</span>
        )}
      </p>
    </>
  );
}

/**
 * "Any agent. Any chain. One decision.": the agents on the left, ZyroPay's checks in the middle,
 * the chains on the right, and a ticker of real decisions from evidence.json. The ticker advances
 * when its progress bar's CSS animation ends, so pausing it is one CSS property.
 */
export default function AnyAgent() {
  const [i, setI] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  // The bar's CSS animation would run (and end) in the server markup before hydration, with no
  // handler to advance the ticker; it starts only once this island is live.
  const [mounted, setMounted] = useState(false);
  const [wires, setWires] = useState<readonly Wire[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const d = DECISIONS[i] ?? DECISIONS[0];
  const n = DECISIONS.length;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setReduced(mq.matches);
    };
    sync();
    setMounted(true);
    mq.addEventListener("change", sync);
    const el = root.current;
    const io = el
      ? new IntersectionObserver(([e]) => {
          setVisible(Boolean(e?.isIntersecting));
        })
      : null;
    if (el) io?.observe(el);
    return () => {
      mq.removeEventListener("change", sync);
      io?.disconnect();
    };
  }, []);

  const step = useCallback(
    (by: number) => {
      setI((v) => (v + by + n) % n);
    },
    [n],
  );

  // The wires: from each agent group's edge into the node, and from the node to each chain.
  const fromRole = AGENTS.find((a) => a.id === d?.fromAgent)?.role ?? "buyer";
  const measure = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const ask = el.querySelector(".s-any__ask")?.getBoundingClientRect();
    const node = el.querySelector(".s-any__orb")?.getBoundingClientRect();
    if (!ask || !node || node.width === 0 || ask.right > node.left) {
      setWires([]);
      return;
    }
    const cx = node.left + node.width / 2 - box.left;
    const cy = node.top + node.height / 2 - box.top;
    const r = node.width / 2;
    const out: Wire[] = [];
    for (const g of el.querySelectorAll<HTMLElement>("[data-group]")) {
      const t = g.getBoundingClientRect();
      const y = t.top + t.height / 2 - box.top;
      const role = g.dataset.group ?? "";
      out.push({
        id: `in-${role}`,
        d: curve(ask.right - box.left, y, cx - r, cy + (role === "buyer" ? -18 : 18)),
        on: !reduced && role === fromRole,
      });
    }
    for (const row of el.querySelectorAll<HTMLElement>("[data-chain]")) {
      const t = row.getBoundingClientRect();
      const y = t.top + t.height / 2 - box.top;
      out.push({
        id: `out-${row.dataset.chain ?? ""}`,
        d: curve(cx + r, cy, t.left - box.left, y),
        on: row.dataset.chain === "cardano",
      });
    }
    setWires(out);
  }, [fromRole, reduced]);

  useLayoutEffect(() => {
    measure();
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [measure]);

  if (!d) return null;
  const running = mounted && !reduced && !paused && visible;

  return (
    <div
      className="s-any"
      ref={root}
      data-verdict={d.verdict}
      data-reduced={reduced ? "" : undefined}
    >
      <svg className="s-any__wires" aria-hidden="true">
        {wires.map((w) => (
          <g key={w.id} className="s-any__wire" data-on={w.on ? "true" : "false"}>
            <path d={w.d} pathLength={100} />
            {w.on && !reduced ? (
              <path
                key={`${w.id}-${String(i)}`}
                className="s-any__pulse"
                d={w.d}
                pathLength={100}
              />
            ) : null}
          </g>
        ))}
      </svg>

      <div className="s-any__card s-any__ask">
        <h3 className="s-any__title">Who asks</h3>
        {(["buyer", "seller"] as const).map((role) => (
          <div key={role} className="s-any__group">
            <p className="s-any__label">
              {role === "buyer" ? "Buyers" : "Sellers in our live runs"}
            </p>
            <ul className={`s-any__tiles s-any__tiles--${role}`} data-group={role}>
              {AGENTS.filter((a) => a.role === role).map((a) => (
                <li
                  key={a.id}
                  className="s-any__tile"
                  data-on={
                    reduced
                      ? undefined
                      : a.id === d.fromAgent
                        ? "from"
                        : a.id === d.toAgent
                          ? "to"
                          : undefined
                  }
                >
                  <span className="s-any__mono" aria-hidden="true">
                    {a.mono}
                  </span>
                  <span className="s-any__name">{a.name}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="s-any__node">
        <div className="s-any__orb">
          <span className="s-any__ring" aria-hidden="true" />
          <svg className="mark s-any__mark" viewBox="0 0 100 100" aria-hidden="true">
            <rect width="100" height="100" rx={MARK_TILE_RADIUS} />
            <path d={MARK_PATH} />
          </svg>
          <p className="s-any__brand">ZyroPay</p>
          <p className="s-any__rules">your rules</p>
        </div>
        <ol className="s-any__steps" key={reduced ? "static" : `run-${String(i)}`}>
          {STEPS.map((s, k) => {
            const state = d.steps[k] ?? "off";
            return (
              <li key={s} className="s-any__step" data-state={reduced ? "idle" : state}>
                <span className="s-any__dot" aria-hidden="true" />
                {s}
                {reduced ? null : <span className="sr-only">: {STEP_WORD[state]}</span>}
              </li>
            );
          })}
        </ol>
        {reduced ? (
          <p className="s-any__decider">
            <span>Decided by</span> your passkey or your on-chain allowance
          </p>
        ) : (
          <p className="s-any__decider" key={`decider-${String(i)}`}>
            <span>{d.verdict === "denied" ? "Refused by" : "Decided by"}</span> {DECIDER[d.verdict]}
          </p>
        )}
      </div>

      <div className="s-any__card s-any__settle">
        <h3 className="s-any__title">Where it settles</h3>
        <ul className="s-any__chains">
          {CHAINS.map((c) => (
            <li key={c.slug} className="s-any__chain" data-chain={c.slug} data-status={c.status}>
              <span
                className={`s-netplate s-any__plate${c.plate === "white" ? " s-netplate--white" : ""}${c.plate === "cardano" ? " s-netplate--cardano" : ""}`}
              >
                <img src={c.file} alt="" width="22" height="22" loading="lazy" decoding="async" />
              </span>
              <div className="s-any__chaininfo">
                <p className="s-any__chainname">
                  {c.name}
                  <span className={`s-any__badge s-any__badge--${c.status}`}>
                    {c.status === "live" ? "Live" : "Tested"}
                  </span>
                </p>
                <p className="s-any__assets">{c.assets}</p>
                <ul className="s-any__can" aria-label={`${c.name} capabilities`}>
                  {c.can.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div
        className="s-any__tick"
        data-running={running ? "true" : "false"}
        onPointerEnter={() => {
          setPaused(true);
          setEngaged(true);
        }}
        onPointerLeave={(e) => {
          if (!e.currentTarget.contains(document.activeElement)) setPaused(false);
        }}
        onFocus={() => {
          setPaused(true);
          setEngaged(true);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false);
        }}
      >
        <div className="s-any__tickhead">
          <p className="s-any__label">
            <span className="s-ledger__dot" aria-hidden="true" />
            Real runs · preprod
          </p>
          {reduced ? null : (
            <div className="s-any__ctl">
              <span className="s-any__count" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
                <span> / {String(n).padStart(2, "0")}</span>
              </span>
              <button
                type="button"
                className="s-any__btn"
                aria-label="Previous decision"
                onClick={() => {
                  step(-1);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14.5 6.5 9 12l5.5 5.5" />
                </svg>
              </button>
              <button
                type="button"
                className="s-any__btn"
                aria-label="Next decision"
                onClick={() => {
                  step(1);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9.5 6.5 15 12l-5.5 5.5" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {reduced ? (
          <ol className="s-any__list">
            {DECISIONS.map((x) => (
              <li key={x.id} className="s-any__entry">
                <Entry d={x} />
              </li>
            ))}
          </ol>
        ) : (
          <>
            <div
              className="s-any__entry s-any__entry--live"
              key={d.id}
              aria-live={engaged ? "polite" : "off"}
              aria-atomic="true"
            >
              <Entry d={d} />
            </div>
            <span
              key={`bar-${String(i)}`}
              className="s-any__bar"
              aria-hidden="true"
              onAnimationEnd={() => {
                step(1);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
