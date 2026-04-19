// --- Design tokens for every dashboard surface ---
//
// SINGLE source of truth. Previously each page file (live, boards, admin,
// graph, agent, setup) carried its own copy of :root + [data-theme=light] +
// [data-theme=crt] — ~60 lines of CSS duplicated 6 times. Now they import
// AX_TOKENS_CSS and drop it in their <style> block once.
//
// Guideline for adding tokens: every token must be page-neutral. Page-
// specific padding/gaps belong in the page's own CSS file, not here.

export const AX_TOKENS_CSS = `:root {
  --ax-bg: oklch(0.16 0.010 265);
  --ax-bg-elev: oklch(0.19 0.012 265);
  --ax-surface: oklch(0.21 0.012 265);
  --ax-surface-2: oklch(0.24 0.014 265);
  --ax-surface-3: oklch(0.27 0.016 265);
  --ax-border: oklch(0.29 0.014 265);
  --ax-border-2: oklch(0.35 0.016 265);
  --ax-text: oklch(0.95 0.005 265);
  --ax-text-2: oklch(0.80 0.008 265);
  --ax-muted: oklch(0.60 0.010 265);
  --ax-accent: oklch(0.78 0.13 165);
  --ax-accent-2: oklch(0.55 0.11 165);
  --ax-warn: oklch(0.80 0.14 75);
  --ax-err: oklch(0.68 0.19 25);
  --ax-info: oklch(0.78 0.10 220);
  --ax-radius: 6px;
  --ax-radius-lg: 8px;
  --ax-radius-sm: 5px;
  --ax-pad: 16px;
  --ax-pad-sm: 10px;
  --ax-gap: 12px;
  --ax-font: "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif;
  --ax-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Consolas, monospace;
  --ax-fs: 13px;
  --ax-fs-sm: 12px;
  --ax-fs-xs: 11px;
  /* Legacy aliases so older CSS blocks keep rendering until they're ported. */
  --bg: var(--ax-bg);
  --card: var(--ax-surface);
  --node: var(--ax-bg-elev);
  --border: var(--ax-border);
  --text: var(--ax-text);
  --muted: var(--ax-muted);
  --accent: var(--ax-accent);
  --green: var(--ax-accent);
  --yellow: var(--ax-warn);
  --red: var(--ax-err);
  --blue: var(--ax-info);
  --gray: var(--ax-muted);
  color-scheme: dark;
}
[data-theme="light"] {
  --ax-bg: oklch(0.98 0.002 265);
  --ax-bg-elev: oklch(0.96 0.003 265);
  --ax-surface: oklch(0.99 0.002 265);
  --ax-surface-2: oklch(0.955 0.003 265);
  --ax-surface-3: oklch(0.92 0.004 265);
  --ax-border: oklch(0.88 0.006 265);
  --ax-border-2: oklch(0.78 0.008 265);
  --ax-text: oklch(0.22 0.010 265);
  --ax-text-2: oklch(0.36 0.010 265);
  --ax-muted: oklch(0.54 0.010 265);
  --ax-accent: oklch(0.55 0.14 165);
  color-scheme: light;
}
[data-theme="crt"] {
  --ax-bg: #05140a;
  --ax-bg-elev: #061a0d;
  --ax-surface: #08201f;
  --ax-surface-2: #0b2922;
  --ax-surface-3: #0e3329;
  --ax-border: #164a30;
  --ax-border-2: #1f6a44;
  --ax-text: #b7ffcc;
  --ax-text-2: #83e3a8;
  --ax-muted: #4f9a73;
  --ax-accent: #6dff9e;
  --ax-font: "IBM Plex Mono", ui-monospace, monospace;
}

/* Base element resets shared across every page. */
* { box-sizing: border-box; }
html, body {
  margin: 0; min-height: 100vh;
  background: var(--ax-bg); color: var(--ax-text);
  font-family: var(--ax-font); font-size: var(--ax-fs);
  -webkit-font-smoothing: antialiased; font-feature-settings: "ss01", "cv01";
}
pre, code, .ax-mono {
  font-family: var(--ax-mono); font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
a { color: var(--ax-accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.ax-muted { color: var(--ax-muted); }
.ax-accent { color: var(--ax-accent); }`
