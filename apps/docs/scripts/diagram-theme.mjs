/*
 * Mermaid themes for the pre-rendered diagrams. One light and one dark variant per diagram,
 * matched to the site tokens in src/styles/theme.css. Changing this file changes every
 * diagram's source hash, so `pnpm diagrams` must be re-run (the build checks it).
 *
 * The font is the site's Inter (public/fonts/inter-var-opsz.woff2, 47 KB): the renderer loads it
 * before Mermaid measures any text, and every SVG embeds it, because an SVG shown as <img>
 * cannot load the page's web font. So the diagrams set in the same type as the page around
 * them, on every platform.
 */
export const FONT = 'Inter, Helvetica, Arial, sans-serif';

const shared = {
  fontFamily: FONT,
  fontSize: "14px",
};

export const THEMES = {
  light: {
    ...shared,
    background: "transparent",
    primaryColor: "#f4f5f7",
    primaryTextColor: "#111318",
    primaryBorderColor: "#9aa0ab",
    secondaryColor: "#eef0f3",
    tertiaryColor: "#ffffff",
    lineColor: "#4b505a",
    textColor: "#111318",
    mainBkg: "#f4f5f7",
    nodeBorder: "#9aa0ab",
    clusterBkg: "#fafbfc",
    clusterBorder: "#c9ccd3",
    titleColor: "#111318",
    edgeLabelBackground: "#ffffff",
    actorBkg: "#f4f5f7",
    actorBorder: "#9aa0ab",
    actorTextColor: "#111318",
    actorLineColor: "#c9ccd3",
    signalColor: "#2b2f36",
    signalTextColor: "#111318",
    labelBoxBkgColor: "#f4f5f7",
    labelBoxBorderColor: "#9aa0ab",
    labelTextColor: "#111318",
    loopTextColor: "#111318",
    noteBkgColor: "#eef0f3",
    noteBorderColor: "#b5bac4",
    noteTextColor: "#111318",
    activationBkgColor: "#e6e8ec",
    activationBorderColor: "#9aa0ab",
    sequenceNumberColor: "#ffffff",
    labelColor: "#111318",
    stateLabelColor: "#111318",
    altBackground: "#ffffff",
  },
  dark: {
    ...shared,
    background: "transparent",
    primaryColor: "#15171c",
    primaryTextColor: "#eceef1",
    primaryBorderColor: "#4a4f59",
    secondaryColor: "#1d1f25",
    tertiaryColor: "#0b0c10",
    lineColor: "#a9adb6",
    textColor: "#eceef1",
    mainBkg: "#15171c",
    nodeBorder: "#4a4f59",
    clusterBkg: "#0e1014",
    clusterBorder: "#2f333b",
    titleColor: "#eceef1",
    edgeLabelBackground: "#0b0c10",
    actorBkg: "#15171c",
    actorBorder: "#4a4f59",
    actorTextColor: "#eceef1",
    actorLineColor: "#3a3e46",
    signalColor: "#c9ccd3",
    signalTextColor: "#eceef1",
    labelBoxBkgColor: "#15171c",
    labelBoxBorderColor: "#4a4f59",
    labelTextColor: "#eceef1",
    loopTextColor: "#eceef1",
    noteBkgColor: "#1d1f25",
    noteBorderColor: "#4a4f59",
    noteTextColor: "#eceef1",
    activationBkgColor: "#1d2027",
    activationBorderColor: "#4a4f59",
    sequenceNumberColor: "#0b0c10",
    labelColor: "#eceef1",
    stateLabelColor: "#eceef1",
    altBackground: "#0b0c10",
  },
};

/**
 * The house style, as CSS inside each SVG (Mermaid scopes it to the diagram). Text sizes are
 * not touched here: Mermaid measures labels at render time, so sizes live in the config below
 * and the boxes always fit their text. Everything else is drawing: rounded boxes, dashed zones
 * with small capital labels, hairline lifelines, round step badges.
 */
const STYLE = [
  // Flat shapes, rounded like the site's cards.
  "rect,polygon,circle,path,g{filter:none !important}",
  ".node rect,.basic.label-container{rx:10px;ry:10px}",
  ".node rect,.node polygon,.node circle,.node path{stroke-width:1.25px}",
  // Zones (subgraphs): dashed, rounded, the title set small and spaced.
  ".cluster rect{rx:14px;ry:14px;stroke-dasharray:5 4;stroke-width:1px}",
  ".cluster-label text,.cluster-label .nodeLabel{font-size:12px;letter-spacing:0.08em;font-weight:600}",
  // Edges: hairlines with small, solid arrowheads; labels on a rounded plate.
  ".flowchart-link{stroke-width:1.25px}",
  ".edgeLabel rect,.labelBkg{rx:6px;ry:6px}",
  ".edgeLabel text,.edgeLabel .label text{font-size:12.5px}",
  // Sequence: rounded actors, faint dashed lifelines, step badges in the accent colour.
  "rect.actor{rx:10px;ry:10px;stroke-width:1.25px}",
  ".actor-line{stroke-dasharray:3 5;stroke-width:1px}",
  ".messageLine0,.messageLine1{stroke-width:1.25px}",
  ".note{rx:8px;ry:8px;stroke-width:1px}",
  ".sequenceNumber{font-size:11px;font-weight:700}",
  // Lift message text clear of its step badge and of the self-message loop.
  ".messageText{transform:translateY(-14px)}",
  // States: rounded, with the same hairlines.
  ".stateGroup rect,.state-note rect{rx:10px;ry:10px}",
].join("");

/**
 * Per-scheme additions to STYLE: accent step badges, edge labels on a bordered plate, and a
 * halo in the page colour behind message text so lifelines never cross the words.
 */
export const SCHEME_CSS = {
  light:
    '[id$="-sequencenumber"] circle{fill:#111318;r:8px}' +
    ".edgeLabel rect,.labelBkg{fill:#ffffff !important;stroke:#c9ccd3;stroke-width:1px;opacity:1 !important}" +
    ".messageText,.loopText{paint-order:stroke;stroke:#ffffff;stroke-width:5px;stroke-linejoin:round}",
  dark:
    '[id$="-sequencenumber"] circle{fill:#f3f4f6;r:8px}' +
    ".edgeLabel rect,.labelBkg{fill:#111318 !important;stroke:#2f333b;stroke-width:1px;opacity:1 !important}" +
    ".messageText,.loopText{paint-order:stroke;stroke:#0b0c10;stroke-width:5px;stroke-linejoin:round}",
};

/** Mermaid config shared by both variants. */
export const CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  htmlLabels: false,
  themeCSS: STYLE,
  flowchart: {
    htmlLabels: false,
    wrappingWidth: 200,
    curve: "monotoneY",
    padding: 14,
    nodeSpacing: 36,
    rankSpacing: 50,
    diagramPadding: 12,
  },
  sequence: {
    showSequenceNumbers: true,
    mirrorActors: false,
    actorMargin: 34,
    boxMargin: 10,
    boxTextMargin: 6,
    messageMargin: 72,
    noteMargin: 14,
    wrap: true,
    width: 124,
    height: 48,
    messageFontSize: 13,
    noteFontSize: 12.5,
    actorFontSize: 13.5,
    diagramMarginX: 16,
    diagramMarginY: 16,
  },
  state: { padding: 12 },
};

/**
 * Colour tokens a diagram source may use as {{name}} (in classDef lines), substituted per
 * variant: green and red only for allow/deny outcomes, white (ink on paper) for highlights.
 */
export const TOKENS = {
  light: {
    ok: "#1a7f45",
    okBg: "#e9f6ee",
    deny: "#b42318",
    denyBg: "#fdecea",
    warn: "#8a5a00",
    warnBg: "#fff4dc",
    accent: "#111318",
    accentBg: "#eef0f3",
    zone: "#fafbfc",
    zoneLine: "#c9ccd3",
    text: "#111318",
  },
  dark: {
    ok: "#5fd68a",
    okBg: "#0f2318",
    deny: "#ff6b5e",
    denyBg: "#2a1412",
    warn: "#ffc56b",
    warnBg: "#2a2110",
    accent: "#f3f4f6",
    accentBg: "#1d1f25",
    zone: "#0e1014",
    zoneLine: "#2f333b",
    text: "#eceef1",
  },
};

/**
 * The docs column shows a diagram at most this wide (50rem content minus the figure padding).
 * Sequence diagrams are laid out to fill it exactly, so they are never scaled down and their
 * text stays at its real size.
 */
export const COLUMN_PX = 740;

/** Lane geometry for a sequence diagram with `actors` participants: 2/3 box, 1/3 gap. */
export function sequenceLanes(actors) {
  const lane = Math.min(240, Math.floor((COLUMN_PX - 2 * CONFIG.sequence.diagramMarginX) / actors));
  const width = Math.round(lane * 0.68);
  return { width, actorMargin: lane - width };
}
