import { useCallback, useEffect, useRef, useState } from "react";
import { APP_ORIGIN, APP_URL } from "../../lib/content";
import { Phone } from "../phone/Phone";
import "../../styles/phone.css";
import "../../styles/appview.css";

/**
 * "Open the app", on every page (mounted once in the layout).
 *
 * Desktop (≥1100px): any `a[data-open-app]` opens a centred phone over a blurred, dimmed page,
 * and the phone's screen loads the real app in an iframe. If the hero phone is on screen the
 * overlay phone flies out of it; otherwise it grows out of the button that was clicked. Close
 * with the button, the backdrop or Esc; focus returns to the link. Smaller screens just follow
 * the link to the app.
 *
 * Inside the phone a status bar is drawn above the iframe and a home indicator below it, so the
 * app's own content never sits under the Dynamic Island or the home bar.
 *
 * The app reports over postMessage (only messages from APP_ORIGIN are read):
 *   { type: "zyropay:ready" }                  the app booted inside the frame
 *   { type: "zyropay:passkey-unavailable" }    WebAuthn is refused in this frame
 * Without "ready" within a few seconds we offer the full-screen app instead.
 */

type Status = "loading" | "ready" | "slow" | "blocked";

const READY_TIMEOUT_MS = 6000;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DESKTOP = "(min-width: 1100px)";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function lockScroll(locked: boolean): void {
  document.documentElement.classList.toggle("is-locked", locked);
  window.dispatchEvent(new Event(locked ? "zyropay:lock" : "zyropay:unlock"));
}

/** The hero phone's screen, if it is visible right now. */
function heroScreen(): DOMRect | null {
  const el = document.querySelector(
    '.s-hero[data-3d="on"] .s-overlay .zp-screen, .s-hero[data-3d="off"] .s-fallback .zp-screen',
  );
  const r = el?.getBoundingClientRect();
  if (!r || r.width === 0) return null;
  const visible = r.top < window.innerHeight * 0.8 && r.bottom > window.innerHeight * 0.2;
  return visible ? r : null;
}

/** FLIP "invert": the transform that puts the target rect onto the source rect. */
function invert(source: DOMRect, target: DOMRect, tilt: boolean): string {
  const s = Math.max(source.width / target.width, 0.12);
  const dx = source.left + source.width / 2 - (target.left + target.width / 2);
  const dy = source.top + source.height / 2 - (target.top + target.height / 2);
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(4)})${
    tilt ? " perspective(1600px) rotateY(-10deg)" : ""
  }`;
}

function StatusBar() {
  return (
    <div className="appview__status" aria-hidden="true">
      <span>9:41</span>
      <span className="appview__status-icons">
        <svg viewBox="0 0 18 12">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        <svg viewBox="0 0 27 12">
          <rect x=".5" y=".5" width="22" height="11" rx="3.5" fill="none" stroke="currentColor" />
          <rect x="2.5" y="2.5" width="16" height="7" rx="2" />
          <path d="M24.5 4v4a2 2 0 0 0 0-4z" />
        </svg>
      </span>
    </div>
  );
}

export default function AppLauncher() {
  const dialog = useRef<HTMLDialogElement>(null);
  const flyer = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const origin = useRef<{ rect: DOMRect | null; fromHero: boolean; link: HTMLElement | null }>({
    rect: null,
    fromHero: false,
    link: null,
  });
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  const [loaded, setLoaded] = useState(false);

  const screenRect = () =>
    flyer.current?.querySelector(".zp-screen")?.getBoundingClientRect() ?? null;

  // Every "Open the app" link on the page.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest<HTMLElement>("a[data-open-app]");
      if (!link) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!window.matchMedia(DESKTOP).matches) return;
      e.preventDefault();
      const hero = heroScreen();
      origin.current = {
        rect: hero ?? link.getBoundingClientRect(),
        fromHero: hero !== null,
        link,
      };
      setOpen(true);
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
    };
  }, []);

  // Open: show the dialog, then bring the phone in.
  useEffect(() => {
    const d = dialog.current;
    if (!open || !d || d.open) return;
    closing.current = false;
    for (const el of [flyer.current, backdrop.current, chrome.current]) {
      for (const a of el?.getAnimations() ?? []) a.cancel();
    }
    setStatus("loading");
    setLoaded(false);
    d.showModal();
    lockScroll(true);
    const { rect, fromHero } = origin.current;
    document.documentElement.classList.toggle("is-app-from-hero", fromHero);
    const reduce = prefersReducedMotion();
    const to = screenRect();
    backdrop.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: reduce ? 150 : 420,
      easing: "ease",
      fill: "both",
    });
    chrome.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 300,
      delay: reduce ? 0 : 450,
      easing: "ease",
      fill: "both",
    });
    const f = flyer.current;
    if (!f) return;
    if (!reduce && rect && to) {
      f.animate(
        [
          { transform: invert(rect, to, fromHero), opacity: fromHero ? 1 : 0 },
          { transform: "none", opacity: 1 },
        ],
        { duration: fromHero ? 720 : 560, easing: EASE, fill: "both" },
      );
    } else {
      f.animate(
        [
          { opacity: 0, transform: "scale(0.96)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220, easing: "ease", fill: "both" },
      );
    }
  }, [open]);

  const close = useCallback(() => {
    const d = dialog.current;
    if (!d?.open || closing.current) return;
    closing.current = true;
    const reduce = prefersReducedMotion();
    // Fly back to the hero only if it is still where we left it.
    const hero = origin.current.fromHero ? heroScreen() : null;
    const back = hero ?? origin.current.link?.getBoundingClientRect() ?? null;
    const to = screenRect();
    const duration = reduce ? 150 : 520;
    chrome.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: "both" });
    backdrop.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration,
      easing: "ease",
      fill: "both",
    });
    const f = flyer.current;
    const flight =
      f && !reduce && back && to
        ? f.animate(
            [
              { transform: "none", opacity: 1 },
              { transform: invert(back, to, hero !== null), opacity: hero ? 1 : 0 },
            ],
            { duration, easing: EASE, fill: "both" },
          )
        : f?.animate([{ opacity: 1 }, { opacity: 0 }], { duration, fill: "both" });
    const finish = () => {
      d.close();
      lockScroll(false);
      document.documentElement.classList.remove("is-app-from-hero");
      setOpen(false);
      origin.current.link?.focus({ preventScroll: true });
    };
    if (flight) flight.onfinish = finish;
    else finish();
  }, []);

  // Esc animates out instead of the dialog's instant close.
  const onCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    close();
  };

  // Messages from the app inside the frame.
  useEffect(() => {
    if (!open) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== APP_ORIGIN) return;
      const type: unknown = (e.data as { type?: unknown } | null)?.type;
      if (type === "zyropay:ready") setStatus((s) => (s === "blocked" ? s : "ready"));
      if (type === "zyropay:passkey-unavailable") setStatus("blocked");
    };
    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(() => {
      setStatus((s) => (s === "loading" ? "slow" : s));
    }, READY_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="appview"
      aria-label="ZyroPay app"
      onCancel={onCancel}
      data-status={status}
    >
      <div ref={backdrop} className="appview__backdrop" onClick={close} aria-hidden="true" />
      <div className="appview__stage">
        <div ref={flyer} className="appview__phone">
          <Phone label="ZyroPay app">
            <div className="appview__screen">
              <StatusBar />
              <div className="appview__viewport">
                {open ? (
                  <iframe
                    className="appview__frame"
                    src={APP_URL}
                    title="ZyroPay app"
                    allow="publickey-credentials-get *; publickey-credentials-create *; clipboard-write"
                    referrerPolicy="strict-origin-when-cross-origin"
                    onLoad={() => {
                      setLoaded(true);
                    }}
                  />
                ) : null}
                <div
                  className="appview__loading"
                  data-on={loaded ? "false" : "true"}
                  aria-hidden="true"
                >
                  <span className="appview__spinner" />
                </div>
                {status === "blocked" ? (
                  <div className="appview__blocked" role="alert">
                    <p>Passkeys can’t run inside this preview in your browser.</p>
                    <a className="appview__cta" href={APP_URL}>
                      Continue in full screen ↗
                    </a>
                  </div>
                ) : null}
              </div>
              <span className="appview__homebar" aria-hidden="true" />
            </div>
          </Phone>
        </div>
        <div ref={chrome} className="appview__bar">
          <p className="appview__hint">
            {status === "slow"
              ? "Not loading here? The app also runs on its own."
              : "The real app, on test networks."}
          </p>
          <a
            className="appview__full"
            href={APP_URL}
            data-strong={status === "slow" ? "true" : "false"}
          >
            {status === "slow" ? "Continue in full screen ↗" : "Open full screen ↗"}
          </a>
        </div>
      </div>
      {/* Focus starts here (not in the cross-origin frame), so Esc reaches the page. */}
      <button
        type="button"
        className="appview__close"
        onClick={close}
        aria-label="Close the app"
        autoFocus
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </dialog>
  );
}
