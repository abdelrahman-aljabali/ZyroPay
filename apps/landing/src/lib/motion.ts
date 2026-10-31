/**
 * Page-level motion: Lenis smooth scrolling driven by GSAP's ticker, plus scroll reveals.
 *
 * Everything is visible without this script. Reveals only *enhance* elements that are still
 * below the fold when it runs, and nothing runs at all under prefers-reduced-motion.
 * Loaded after first paint (idle), so it never competes with the hero for the main thread.
 */

import type { gsap as Gsap } from "gsap";
import type { ScrollTrigger as ScrollTriggerType } from "gsap/ScrollTrigger";

export interface MotionOptions {
  /** Lenis lerp; lower is floatier. */
  readonly lerp?: number;
  /** Called with gsap + ScrollTrigger so a page can add its own scroll choreography. */
  readonly extend?: (gsap: typeof Gsap, ScrollTrigger: typeof ScrollTriggerType) => void;
}

function idle(fn: () => void): void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout: 1500 });
  else window.setTimeout(fn, 200);
}

export function initMotion(options: MotionOptions = {}): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const start = async () => {
    const [{ gsap }, { ScrollTrigger }, { default: Lenis }] = await Promise.all([
      import("gsap"),
      import("gsap/ScrollTrigger"),
      import("lenis"),
    ]);
    gsap.registerPlugin(ScrollTrigger);

    const lenis = new Lenis({ lerp: options.lerp ?? 0.11, anchors: true });
    lenis.on("scroll", () => {
      ScrollTrigger.update();
    });
    gsap.ticker.add((time) => {
      lenis.raf(time * 1000);
    });
    gsap.ticker.lagSmoothing(0);
    // The "Open the app" view locks the page behind it.
    window.addEventListener("zyropay:lock", () => {
      lenis.stop();
    });
    window.addEventListener("zyropay:unlock", () => {
      lenis.start();
    });

    const fold = window.innerHeight;
    for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
      if (el.getBoundingClientRect().top < fold * 0.9) continue;
      const items = el.querySelectorAll<HTMLElement>("[data-reveal-item]");
      const targets = items.length > 0 ? Array.from(items) : [el];
      gsap.from(targets, {
        y: 28,
        opacity: 0,
        duration: 0.9,
        ease: "expo.out",
        stagger: 0.07,
        scrollTrigger: { trigger: el, start: "top 85%", once: true },
      });
    }

    options.extend?.(gsap, ScrollTrigger);
  };

  if (document.readyState === "complete") idle(() => void start());
  else
    window.addEventListener(
      "load",
      () => {
        idle(() => void start());
      },
      { once: true },
    );
}
