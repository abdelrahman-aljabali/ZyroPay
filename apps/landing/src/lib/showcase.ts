/**
 * The demo video and the source-code link, from config/showcase.json (shared with the docs site).
 *
 * HOW TO FILL IT (edit config/showcase.json only, then rebuild and deploy):
 *   video.embedUrl   a privacy-friendly player URL, preferred. For YouTube use the no-cookie host:
 *                    "https://www.youtube-nocookie.com/embed/<id>"; for Vimeo
 *                    "https://player.vimeo.com/video/<id>?dnt=1". Nothing loads from that host
 *                    until the visitor presses play.
 *   video.url        the watch page ("https://youtu.be/<id>") or a direct .mp4/.webm file. With no
 *                    embedUrl, a direct file plays in a native <video>; a page opens in a new tab.
 *   video.poster     an image (a path under apps/landing/public, e.g. "/showcase/poster.jpg", or an
 *                    https URL). Without one, a drawn poster is used.
 *   video.title, video.durationSeconds   shown on the player and in the placeholder.
 *   repository.url   the public repository; repository.label is the button text.
 * Leave a value null to keep its placeholder ("Demo video coming soon", "publishing soon").
 * scripts/postbuild.mjs adds the embed/video/poster origins to the CSP from the same file.
 */
import config from "../../../../config/showcase.json";

export interface Showcase {
  readonly video: {
    /** The state the player renders. */
    readonly mode: "embed" | "file" | "link" | "placeholder";
    readonly src: string | null;
    readonly poster: string | null;
    readonly title: string;
    /** "2:30", or null. */
    readonly duration: string | null;
    /** "2½ minutes"-style phrase for prose, or null. */
    readonly durationWords: string | null;
  };
  readonly repository: { readonly url: string | null; readonly label: string };
}

function https(u: unknown): string | null {
  if (typeof u !== "string" || u.trim() === "") return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A path under public/ ("/x.jpg") or an https URL. */
function asset(u: unknown): string | null {
  if (typeof u === "string" && /^\/[\w./-]+$/.test(u) && !u.startsWith("//")) return u;
  return https(u);
}

function clock(s: unknown): string | null {
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return null;
  const n = Math.round(s);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

function words(s: unknown): string | null {
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return null;
  if (s < 60) return `${Math.round(s)} seconds`;
  const half = Math.round(s / 30) / 2;
  const whole = Math.floor(half);
  const label = half % 1 === 0 ? String(whole) : `${whole === 0 ? "" : String(whole)}½`;
  return `${label} minute${half > 1 ? "s" : ""}`;
}

function load(): Showcase {
  const v = config.video;
  const embed = https(v.embedUrl);
  const url = https(v.url);
  const file = url !== null && /\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(url);
  const mode = embed ? "embed" : url ? (file ? "file" : "link") : "placeholder";
  return {
    video: {
      mode,
      src: embed ?? url,
      poster: asset(v.poster),
      title: typeof v.title === "string" && v.title ? v.title : "ZyroPay demo",
      duration: clock(v.durationSeconds),
      durationWords: words(v.durationSeconds),
    },
    repository: {
      url: https(config.repository.url),
      label:
        typeof config.repository.label === "string" && config.repository.label
          ? config.repository.label
          : "Source code",
    },
  };
}

export const SHOWCASE: Showcase = load();
