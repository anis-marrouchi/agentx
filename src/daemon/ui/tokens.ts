// --- Design tokens for every dashboard surface ---
//
// SINGLE source of truth for the desktop dashboard AND the phone app (/app):
// every page drops AX_TOKENS_CSS in its <style> block once, so no page (and
// no phone palette) carries its own :root copy (#2101).
//
// The look follows Orca's desktop app (https://github.com/stablyai/orca,
// src/renderer/src/assets/main.css): a neutral shadcn-style system with 1px
// borders, a 10px radius, no hard offset shadows and Geist type. Only colour
// and size values are taken, no code. Orca is MIT licensed:
//   Copyright (c) 2026 Lovecast Inc. Permission is hereby granted, free of
//   charge, to any person obtaining a copy of this software ... (MIT).
//
// What is AgentX's own: the name, logo and icon, and the vivid AgentX blue
// for the primary button, links, focus and the current place, where Orca
// stays monochrome. Text blue is #1f66e5 on white (5.1:1) and #4d94ff on
// the dark ground (6.6:1 on #0a0a0a). The primary button is #1f66e5 in both
// themes, so its white label stays at 5.1:1 (white on #2979FF is 3.98:1).
//
// Principles kept from before (agentina): contacts not concepts, one screen
// one job, honest UI. Dark stays the desktop default; the phone follows the
// system setting.
//
// Guideline for adding tokens: every token must be page-neutral. Page-
// specific padding/gaps belong in the page's own CSS file, not here.

/** The one theme boot for every page (dashboard, Hub, phone), run in <head>
 *  before first paint. Key `ax-theme`; with no choice saved it follows the
 *  computer's setting (#2101 Q2). The Hub's old key `ax-wall-theme` is read
 *  once: a saved Hub choice moves to `ax-theme`, then the old key is dropped
 *  (#2101 condition 6). */
export const AX_THEME_BOOT_JS = `(function(){var t=null;try{var o=localStorage.getItem('ax-wall-theme');if(o!==null){if(o==='light'||o==='dark')localStorage.setItem('ax-theme',o);localStorage.removeItem('ax-wall-theme')}t=localStorage.getItem('ax-theme')}catch(e){}if(t!=='light'&&t!=='dark')t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)})();`

export const AX_THEME_BOOT = `<script>${AX_THEME_BOOT_JS}</script>`

export const AX_PRIMARY_COLOR = "#1f66e5"

export const AX_TOKENS_CSS = `/* Geist, SIL OFL 1.1 (c) 2023 Vercel: served by the daemon, no font CDN.
   Licence at /assets/OFL-Geist.txt. Offline, the system stack takes over. */
@font-face { font-family: "Geist"; src: url("/assets/Geist-Variable.woff2") format("woff2");
  font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Geist Mono"; src: url("/assets/GeistMono-Variable.woff2") format("woff2");
  font-weight: 100 900; font-style: normal; font-display: swap; }
:root {
  /* --- Brand: blue accent + status colours ---------------------------- */
  --ax-blue: #1f66e5;
  --ax-blue-d: #1a56c4;
  --ax-blue-t: #e8f0ff;
  --ax-blue-e: #b9d0fb;
  --ax-green: #16a34a;
  --ax-green-d: #15803d;
  --ax-green-e: #bbf7d0;
  --ax-amber: #f59e0b;
  --ax-amber-e: #fde68a;
  --ax-amber-t: #fffbeb;
  --ax-person-t: color-mix(in oklch, #f08c3c 16%, var(--ax-bg));
  --ax-person-ink: color-mix(in oklch, #d4691f 80%, var(--ax-text));
  --ax-red: #e40014;
  --ax-red-t: #fef2f2;
  --ax-red-e: #fecaca;

  /* Ink steps. Amber and red are legible as FILLS, not as small text. Use
     these wherever the colour carries words rather than area. */
  --ax-amber-ink: #8a5a00;
  --ax-red-ink: #b00010;

  /* --- Surfaces + text (Orca light) ---------------------------------- */
  --ax-bg: #ffffff;
  --ax-bg-elev: #fafafa;
  --ax-surface: #ffffff;
  --ax-surface-2: #fafafa;
  --ax-surface-3: #f5f5f5;
  --ax-border: #e5e5e5;
  --ax-border-2: #d4d4d4;
  --ax-text: #0a0a0a;
  --ax-text-2: #525252;
  --ax-muted: #696969;

  /* What makes it AgentX, not a copy of Orca's monochrome (owner
     2026-11-22 22:01Z: vivid blue, no purple): the primary button, the
     focus ring and the current place are AgentX blue. White on #1f66e5 is
     5.1:1. */
  --ax-primary: ${AX_PRIMARY_COLOR};
  --ax-primary-fg: #ffffff;
  --ax-ring: #2979FF;

  /* The one focus ring (orca-design C16): 3px of the ring colour at 50%.
     Drawn by the global :focus-visible rule below; a row that clips its
     outside uses "inset var(--ax-focus-ring)". */
  --ax-focus-ring: 0 0 0 3px color-mix(in srgb, var(--ax-ring) 50%, transparent);

  /* Phone chat bubble + online green (were the phone-only palette). */
  --phone-bubble: #f5f5f5;
  --phone-green: #16a34a;
  /* Ink on an --ax-accent fill (count badges, the selected tab). */
  --ax-on-accent: #ffffff;
  /* Scrim behind a sheet or dialog (Orca: bg-black/55). */
  --ax-overlay: rgb(0 0 0 / 0.55);

  /* --- Semantic ------------------------------------------------------ */
  --ax-accent: var(--ax-blue);
  --ax-accent-2: var(--ax-blue-d);
  --ax-accent-t: var(--ax-blue-t);
  --ax-ok: var(--ax-green);
  --ax-warn: var(--ax-amber);
  --ax-err: var(--ax-red);
  --ax-info: var(--ax-blue);

  /* --- Shape (Orca: 1px lines, 10px radius, soft shadow only on things
     that float: menus, dialogs, the drawer) ------------------------------ */
  --ax-border-w: 1px;
  --ax-radius: 10px;
  --ax-radius-lg: 14px;
  --ax-radius-sm: 6px;
  /* Buttons, selects, inputs and toggles. Pill corners are only for send,
     scroll-to-bottom and suggestion pills (orca-design C25). */
  --ax-radius-md: 8px;
  --ax-radius-pill: 999px;
  --ax-shadow: none;
  /* Embedded: outline buttons and cards that sit in the page. */
  --ax-shadow-xs: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  /* Floating: menus, popovers, dialogs, toasts and drawers. */
  --ax-shadow-lg: 0 10px 30px -10px rgb(0 0 0 / 0.18), 0 2px 6px rgb(0 0 0 / 0.06);
  --ax-shadow-accent: none;
  --ax-shadow-ok: none;

  /* --- Spacing ------------------------------------------------------- */
  /* Width of the ask-an-agent drawer. Lives here because pages reflow
     around it; the drawer overwrites it on :root when resized. */
  --ax-as-w: 420px;
  /* Width of the desktop left sidebar (topbar.ts, >= 1024px). */
  --ax-side-w: 232px;
  --ax-pad: 16px;
  --ax-pad-sm: 10px;
  --ax-gap: 12px;

  /* --- Type ---------------------------------------------------------- */
  --ax-font: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --ax-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ax-fs: 14px;
  --ax-fs-sm: 13px;
  --ax-fs-xs: 12px;
  /* Type roles (orca-design principle 6). Row text is --ax-fs (14) and
     --ax-fs-sm (13). No weight above --ax-fw-strong. */
  --ax-fs-pane: 24px;
  --ax-fs-group: 15px;
  --ax-fs-help: 12.5px;
  --ax-fs-label: 11px;
  --ax-fs-phone-title: 20px;
  --ax-fw-strong: 600;

  /* Legacy aliases so older CSS blocks keep rendering until they're ported. */
  --bg: var(--ax-bg);
  --card: var(--ax-surface);
  --node: var(--ax-bg-elev);
  --border: var(--ax-border);
  --text: var(--ax-text);
  --muted: var(--ax-muted);
  --accent: var(--ax-accent);
  --yellow: var(--ax-warn);
  --red: var(--ax-err);
  --blue: var(--ax-info);
  --gray: var(--ax-muted);
  color-scheme: light;
}

/* Orca dark: near-black ground, #171717 cards, borders as white at 7-12%. */
[data-theme="dark"] {
  --ax-blue: #4d94ff;
  --ax-blue-d: #2979FF;
  --ax-blue-t: #1c2b47;
  --ax-blue-e: #2f4d7a;
  --ax-green: #4ade80;
  --ax-green-d: #22c55e;
  --ax-green-e: #14532d;
  --ax-amber: #fbbf24;
  --ax-amber-e: #4a3a12;
  --ax-amber-t: #262013;
  --ax-red: #ff6568;
  --ax-red-t: #2e1517;
  --ax-red-e: #5c2427;
  --ax-amber-ink: #fbbf24;
  --ax-red-ink: #ff8a8c;

  --ax-bg: #0a0a0a;
  --ax-bg-elev: #111111;
  --ax-surface: #171717;
  --ax-surface-2: #1c1c1c;
  --ax-surface-3: #262626;
  --ax-border: rgb(255 255 255 / 0.08);
  --ax-border-2: rgb(255 255 255 / 0.14);
  --ax-text: #f0f0f0;
  --ax-text-2: #c4c4c4;
  --ax-muted: #acacac;

  --ax-primary: ${AX_PRIMARY_COLOR};
  --ax-primary-fg: #ffffff;
  --ax-ring: #4d94ff;
  /* Ink on --ax-accent (the Hub nav count badge): white on #4d94ff is
     about 3.0:1, near-black is about 6.9:1 (DevOps nit on #2127). */
  --ax-on-accent: #0a0a0a;

  --phone-bubble: #262626;
  --phone-green: #4ade80;

  --ax-shadow: none;
  --ax-shadow-lg: 0 10px 30px -10px rgb(0 0 0 / 0.7), 0 0 0 1px rgb(255 255 255 / 0.06);
  --ax-shadow-accent: none;
  --ax-shadow-ok: none;
  color-scheme: dark;
}

/* Base element resets shared across every page. */
* { box-sizing: border-box; }
html, body {
  margin: 0; min-height: 100vh;
  background: var(--ax-bg); color: var(--ax-text);
  font-family: var(--ax-font); font-size: var(--ax-fs);
  -webkit-font-smoothing: antialiased;
}
pre, code, .ax-mono {
  font-family: var(--ax-mono); font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
a { color: var(--ax-accent); text-decoration: none; font-weight: 600; }
a:hover { color: var(--ax-accent-2); text-decoration: underline; }
/* One focus ring on every page (orca-design C16). ":root" lifts it over a
   plain class that sets its own shadow, such as .ax-btn's shadow-xs. */
:root :focus-visible { outline: none; box-shadow: var(--ax-focus-ring); }
/* Reduced motion (C20): animations and transitions end at once. A spinner
   stops; the word next to it still says it is working. */
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important; scroll-behavior: auto !important;
  }
}
.ax-muted { color: var(--ax-muted); }
.ax-accent { color: var(--ax-accent); }`
