import { useCallback, useEffect, useRef } from "react";
import { HOLD_MS } from "../../lib/story";

interface HoldButtonProps {
  readonly label: string;
  readonly doneLabel: string;
  readonly done: boolean;
  readonly disabled?: boolean;
  /** Accessible name, longer than the visible label. */
  readonly ariaLabel: string;
  readonly autoHold?: boolean;
  readonly onHoldingChange: (holding: boolean) => void;
  readonly onComplete: () => void;
}

const R = 15;
const C = 2 * Math.PI * R;

/**
 * Press-and-hold button with a progress ring, the app's "Hold to approve".
 * Pointer, touch and keyboard (Space / Enter held down) all work. Releasing early unwinds fast:
 * slow where the person decides, fast where the system responds.
 */
export function HoldButton({
  label,
  doneLabel,
  done,
  disabled = false,
  ariaLabel,
  autoHold = false,
  onHoldingChange,
  onComplete,
}: HoldButtonProps) {
  const ring = useRef<SVGCircleElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const raf = useRef<number | null>(null);
  const progress = useRef(0);
  const holding = useRef(false);
  const completed = useRef(false);

  const paint = useCallback((p: number) => {
    progress.current = p;
    if (ring.current) ring.current.style.strokeDashoffset = String(C * (1 - p));
    if (fill.current) fill.current.style.transform = `scaleX(${p})`;
  }, []);

  const stopLoop = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  };

  const start = useCallback(() => {
    if (disabled || done || holding.current || completed.current) return;
    holding.current = true;
    onHoldingChange(true);
    stopLoop();
    const from = progress.current;
    const t0 = performance.now() - from * HOLD_MS;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / HOLD_MS);
      paint(p);
      if (p >= 1) {
        holding.current = false;
        completed.current = true;
        raf.current = null;
        // A short tick on phones; only after a real gesture (browsers refuse it otherwise).
        if ("vibrate" in navigator && navigator.userActivation.hasBeenActive) navigator.vibrate(12);
        onComplete();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [disabled, done, onComplete, onHoldingChange, paint]);

  const cancel = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    onHoldingChange(false);
    stopLoop();
    // Unwind in ~180 ms with an ease-out.
    const from = progress.current;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / 180);
      const eased = 1 - Math.pow(1 - t, 3);
      paint(from * (1 - eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else raf.current = null;
    };
    raf.current = requestAnimationFrame(tick);
  }, [onHoldingChange, paint]);

  // Reset when the story replays.
  useEffect(() => {
    if (!done && !disabled) {
      completed.current = false;
      paint(0);
    }
  }, [done, disabled, paint]);

  // QA capture: press for the full duration once the button is live.
  useEffect(() => {
    if (!autoHold || disabled || done) return;
    const id = window.setTimeout(start, 900);
    return () => {
      window.clearTimeout(id);
    };
  }, [autoHold, disabled, done, start]);

  useEffect(() => stopLoop, []);

  return (
    <button
      type="button"
      className="zp-hold"
      data-done={done ? "true" : "false"}
      aria-label={done ? doneLabel : ariaLabel}
      aria-disabled={disabled || done}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") cancel();
      }}
      onBlur={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <span className="zp-hold__fill" ref={fill} aria-hidden="true" />
      <span className="zp-hold__icon" aria-hidden="true">
        <svg viewBox="0 0 36 36" className="zp-hold__ring">
          <circle className="zp-hold__track" cx="18" cy="18" r={R} />
          <circle
            ref={ring}
            className="zp-hold__progress"
            cx="18"
            cy="18"
            r={R}
            strokeDasharray={C}
            strokeDashoffset={C}
          />
        </svg>
        {done ? (
          <svg viewBox="0 0 24 24" className="zp-hold__glyph">
            <path d="M6 12.5l4 4 8-9" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="zp-hold__glyph">
            <circle cx="9.5" cy="8" r="3.5" />
            <path d="M3.5 19.5c.6-3.3 3-5.2 6-5.2 1.3 0 2.5.3 3.4 1" />
            <circle cx="17.5" cy="15" r="2" />
            <path d="M17.5 17v3.5M17.5 19h1.6" />
          </svg>
        )}
      </span>
      <span className="zp-hold__label">{done ? doneLabel : label}</span>
    </button>
  );
}
