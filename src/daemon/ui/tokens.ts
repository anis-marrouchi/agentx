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
// What stays AgentX: the name, logo and icon, and blue as the accent for
// links, focus and the active place. The blue is the phone's approved text
// blue (#488): #1f66e5 on white and #6aa0ff on dark, both above 4.5:1.
// Primary buttons are neutral (near-black on light, near-white on dark), as
// in Orca.
//
// Principles kept from before (agentina): contacts not concepts, one screen
// one job, honest UI. Dark stays the desktop default; the phone follows the
// system setting.
//
// Guideline for adding tokens: every token must be page-neutral. Page-
// specific padding/gaps belong in the page's own CSS file, not here.

export const AX_TOKENS_CSS = `:root {
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

  /* Primary button: neutral, as in Orca. */
  --ax-primary: #171717;
  --ax-primary-fg: #fafafa;
  --ax-ring: #a1a1a1;

  /* Phone chat bubble + online green (were the phone-only palette). */
  --phone-bubble: #f5f5f5;
  --phone-green: #16a34a;

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
  --ax-radius-pill: 999px;
  --ax-shadow: none;
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
  --ax-blue: #6aa0ff;
  --ax-blue-d: #4d8af5;
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

  --ax-primary: #e5e5e5;
  --ax-primary-fg: #171717;
  --ax-ring: #737373;

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
.ax-muted { color: var(--ax-muted); }
.ax-accent { color: var(--ax-accent); }`
