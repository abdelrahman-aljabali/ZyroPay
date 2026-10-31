import { useEffect, useRef, useState } from "react";
import { ATTACKS } from "../../lib/content";
import { SCENARIO_EVENT } from "../../lib/story";

const STEP_MS = 520;

/**
 * "Try to hack it": pick an attack, watch the simulated response line by line. Every attack and
 * every answer comes from the threat model in docs/SECURITY.md.
 */
export default function HackIt() {
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState(0);
  const [reduced, setReduced] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const attack = ATTACKS[active] ?? ATTACKS[0];

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (!attack) return;
    const total = attack.steps.length + 1;
    if (reduced) {
      setShown(total);
      return;
    }
    setShown(0);
    const ids: number[] = [];
    for (let i = 1; i <= total; i++) {
      ids.push(
        window.setTimeout(
          () => {
            setShown(i);
          },
          300 + i * STEP_MS,
        ),
      );
    }
    return () => {
      for (const id of ids) window.clearTimeout(id);
    };
  }, [attack, reduced]);

  if (!attack) return null;
  const done = shown > attack.steps.length;

  return (
    <div className="s-hack">
      <div className="s-hack__list" role="radiogroup" aria-label="Choose an attack">
        {ATTACKS.map((a, i) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={i === active}
            className="s-hack__pick"
            onClick={() => {
              setActive(i);
              panel.current?.focus({ preventScroll: true });
            }}
          >
            <span className="s-hack__n" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            {a.title}
          </button>
        ))}
      </div>

      <div className="s-console" ref={panel} tabIndex={-1} aria-live="polite" aria-atomic="false">
        <div className="s-console__bar" aria-hidden="true">
          <span />
          <span />
          <span />
          <p>Simulated attack</p>
        </div>
        <div className="s-console__body">
          <p className="s-console__line s-console__line--attacker">
            <span className="s-console__who">attacker</span>
            {attack.attempt}
          </p>
          {attack.steps.map((step, i) => (
            <p
              key={`${attack.id}-${String(i)}`}
              className="s-console__line"
              data-on={shown > i ? "true" : "false"}
            >
              <span className="s-console__who">zyropay</span>
              {step}
            </p>
          ))}
          <div className="s-console__verdict" data-on={done ? "true" : "false"}>
            <span className={`s-verdict s-verdict--${attack.verdict}`}>{attack.verdictLabel}</span>
            <span className="s-console__ref">Threat model {attack.ref}</span>
          </div>
          {attack.id === "inject" ? (
            <button
              type="button"
              className="s-console__try"
              data-on={done ? "true" : "false"}
              tabIndex={done ? 0 : -1}
              onClick={() => {
                window.dispatchEvent(new CustomEvent(SCENARIO_EVENT, { detail: "attack" }));
                document.getElementById("top")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              If your policy asks instead: try it on the phone ↑
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
