// --- Design tokens for every dashboard surface ---
//
// SINGLE source of truth. Every page imports AX_TOKENS_CSS and drops it in
// its <style> block once, so no page carries its own :root copy.
//
// The palette and shape language are ported from the agentina console
// (packages/console/src/index.ts) — a deliberately plain, friendly system
// built on three principles worth restating here, because they are as much
// about what we remove as how it looks:
//
//   1. CONTACTS, NOT CONCEPTS — surface the people and agents you work with;
//      grants, sessions and adapters stay machinery.
//   2. ONE SCREEN, ONE JOB — a flow is a short wizard with one obvious next
//      action, not a dense panel of every option.
//   3. HONEST UI — nothing simulated. Offline is offline, denied is denied.
//
// What was ported and what was not:
//   - Ported: the four-colour brand palette, 2px borders, generous radii,
//     pill chips, the hard offset shadow (`0 4px 0 <darker>`) that makes
//     controls read as physical, and Outfit / Roboto Mono.
//   - NOT ported: light-only. agentina is a consumer console; this is a
//     dense ops dashboard people read at 2am, so the dark variant stays and
//     carries the same shape language with the palette lifted for contrast.
//   - Removed: the `crt` theme. Two well-maintained themes beat three, and
//     it had no users.
//
// Guideline for adding tokens: every token must be page-neutral. Page-
// specific padding/gaps belong in the page's own CSS file, not here.

export const AX_TOKENS_CSS = `:root {
  /* --- Brand (agentina) --------------------------------------------- */
  --ax-blue: #2979FF;
  --ax-blue-d: #1B5FD9;
  --ax-blue-t: #E7F0FF;
  --ax-blue-e: #A9CBFF;
  --ax-green: #22B573;
  --ax-green-d: #178F58;
  --ax-green-e: #A9E8C9;
  --ax-amber: #FFB300;
  --ax-amber-e: #FFE08A;
  --ax-amber-t: #FFFCF5;
  --ax-red: #F23A3A;
  --ax-red-t: #FEECEC;
  --ax-red-e: #F9C1C1;

  /* --- Surfaces + text ---------------------------------------------- */
  --ax-bg: #f8f9fa;
  --ax-bg-elev: #f1f3f4;
  --ax-surface: #ffffff;
  --ax-surface-2: #f8f9fa;
  --ax-surface-3: #f1f3f4;
  --ax-border: #e8eaed;
  --ax-border-2: #dadce0;
  --ax-text: #202124;
  --ax-text-2: #5f6368;
  --ax-muted: #9aa0a6;

  /* --- Semantic ------------------------------------------------------ */
  --ax-accent: var(--ax-blue);
  --ax-accent-2: var(--ax-blue-d);
  --ax-accent-t: var(--ax-blue-t);
  --ax-ok: var(--ax-green);
  --ax-warn: var(--ax-amber);
  --ax-err: var(--ax-red);
  --ax-info: var(--ax-blue);

  /* --- Shape ---------------------------------------------------------
     The offset shadow is the signature move: a solid, un-blurred drop in a
     darker shade of the element's own colour. It reads as a physical edge
     rather than a glow, and it is what stops flat 2px-bordered boxes from
     looking like a wireframe. */
  --ax-border-w: 2px;
  --ax-radius: 16px;
  --ax-radius-lg: 20px;
  --ax-radius-sm: 12px;
  --ax-radius-pill: 999px;
  --ax-shadow: 0 3px 0 var(--ax-border);
  --ax-shadow-lg: 0 4px 0 var(--ax-border-2);
  --ax-shadow-accent: 0 4px 0 var(--ax-blue-d);
  --ax-shadow-ok: 0 4px 0 var(--ax-green-d);

  /* --- Spacing ------------------------------------------------------- */
  --ax-pad: 16px;
  --ax-pad-sm: 10px;
  --ax-gap: 12px;

  /* --- Type ---------------------------------------------------------- */
  --ax-font: "Outfit", -apple-system, "Segoe UI", system-ui, sans-serif;
  --ax-mono: "Roboto Mono", ui-monospace, "SF Mono", Consolas, monospace;
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

/* Dark is not a tint of light — the brand colours are lifted toward their
   tints so they keep contrast against a dark ground, and the offset shadow
   goes DARKER than the surface instead of lighter. Same shape language,
   inverted physics. */
[data-theme="dark"] {
  --ax-blue: #6BA5FF;
  --ax-blue-d: #1B5FD9;
  --ax-blue-t: #16233d;
  --ax-blue-e: #2f4d7a;
  --ax-green: #4ED89B;
  --ax-green-d: #178F58;
  --ax-green-e: #1e4a36;
  --ax-amber: #FFC948;
  --ax-amber-e: #4a3a12;
  --ax-amber-t: #2a2313;
  --ax-red: #FF6B6B;
  --ax-red-t: #3a1c1c;
  --ax-red-e: #6b2f2f;

  --ax-bg: #14161a;
  --ax-bg-elev: #191c21;
  --ax-surface: #1e2228;
  --ax-surface-2: #23272e;
  --ax-surface-3: #2a2f37;
  --ax-border: #2f353e;
  --ax-border-2: #3d444f;
  --ax-text: #f1f3f4;
  --ax-text-2: #b6bcc4;
  --ax-muted: #858c96;

  --ax-shadow: 0 3px 0 #0e1013;
  --ax-shadow-lg: 0 4px 0 #0e1013;
  --ax-shadow-accent: 0 4px 0 #14396e;
  --ax-shadow-ok: 0 4px 0 #11402c;
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
