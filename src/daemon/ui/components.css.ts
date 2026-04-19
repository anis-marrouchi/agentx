// --- Shared component CSS ---
//
// Styles for the primitives in components.ts. Kept separate from tokens so a
// page can opt-in to only what it uses (setup-wizard doesn't need stat-strip
// styles, for example). Most pages just emit both blocks together.
//
// All class names are prefixed `ax-` — they won't collide with host-app or
// per-page styles.

export const AX_COMPONENTS_CSS = `
/* --- Dots --- */
.ax-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ax-muted); }
.ax-dot--ok, .ax-dot--live { background: var(--ax-accent); }
.ax-dot--warn { background: var(--ax-warn); }
.ax-dot--err { background: var(--ax-err); }
.ax-dot--off { background: var(--ax-border-2); }
.ax-dot--pulse {
  box-shadow: 0 0 0 0 currentColor;
  animation: ax-pulse 1.8s infinite;
  color: var(--ax-accent);
}
@keyframes ax-pulse {
  0%   { box-shadow: 0 0 0 0 color-mix(in oklch, var(--ax-accent) 70%, transparent); }
  70%  { box-shadow: 0 0 0 6px color-mix(in oklch, var(--ax-accent) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--ax-accent) 0%, transparent); }
}

/* --- Badges --- */
.ax-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 7px; border-radius: 3px; font-size: var(--ax-fs-xs); line-height: 16px;
  border: 1px solid var(--ax-border-2); color: var(--ax-text-2); background: transparent;
}
.ax-badge--mono {
  font-family: var(--ax-mono); letter-spacing: 0.02em;
  text-transform: uppercase; font-size: 10px;
}
.ax-badge--accent {
  color: var(--ax-accent);
  border-color: color-mix(in oklch, var(--ax-accent) 50%, transparent);
}
.ax-badge--live {
  color: var(--ax-accent);
  background: color-mix(in oklch, var(--ax-accent) 14%, transparent);
  border-color: color-mix(in oklch, var(--ax-accent) 60%, transparent);
  font-weight: 600; letter-spacing: 0.06em;
}
.ax-badge--warn {
  color: var(--ax-warn);
  border-color: color-mix(in oklch, var(--ax-warn) 50%, transparent);
}
.ax-badge--err {
  color: var(--ax-err);
  border-color: color-mix(in oklch, var(--ax-err) 50%, transparent);
}
.ax-badge--ghost {
  color: var(--ax-muted); border-color: var(--ax-border); background: var(--ax-surface-2);
}

/* --- Buttons --- */
.ax-btn {
  background: transparent; color: var(--ax-text-2);
  border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius);
  padding: 7px 14px; font: inherit; font-size: var(--ax-fs); cursor: pointer;
  transition: border-color 0.1s, color 0.1s, background 0.1s;
  line-height: 1.4;
}
.ax-btn:hover:not(:disabled) { color: var(--ax-text); border-color: var(--ax-accent); }
.ax-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.ax-btn--primary {
  background: color-mix(in oklch, var(--ax-accent) 15%, var(--ax-surface));
  color: var(--ax-accent);
  border-color: color-mix(in oklch, var(--ax-accent) 50%, var(--ax-border-2));
  font-weight: 600;
}
.ax-btn--primary:hover:not(:disabled) {
  background: color-mix(in oklch, var(--ax-accent) 25%, var(--ax-surface));
  border-color: var(--ax-accent);
}

.ax-btn--ghost {
  background: transparent; color: var(--ax-muted);
  border-color: var(--ax-border);
}

.ax-btn--danger {
  color: var(--ax-err);
  border-color: color-mix(in oklch, var(--ax-err) 50%, var(--ax-border-2));
}
.ax-btn--danger:hover:not(:disabled) {
  background: color-mix(in oklch, var(--ax-err) 12%, var(--ax-surface));
  border-color: var(--ax-err);
}

/* --- Chips (read-only labels used in kanban filters, etc.) --- */
.ax-chip {
  display: inline-block; padding: 0 6px; font-family: var(--ax-mono);
  font-size: 10px; line-height: 16px; border-radius: 3px; color: var(--ax-muted);
  border: 1px solid var(--ax-border); background: var(--ax-surface);
}

/* --- Cards --- */
.ax-card {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius); padding: var(--ax-pad);
}

/* Step cards used by the setup wizard / onboarding-style flows. */
.ax-step {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: 8px; padding: 20px 22px; margin: 14px 0;
}
.ax-step__head {
  font-size: var(--ax-fs-xs); font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--ax-muted);
  margin: 0 0 14px; display: flex; align-items: center; gap: 10px;
}
.ax-step__num {
  width: 22px; height: 22px; border-radius: 4px;
  background: color-mix(in oklch, var(--ax-accent) 15%, var(--ax-surface));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 45%, var(--ax-border-2));
  color: var(--ax-accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-family: var(--ax-mono); font-size: 11px; font-weight: 700;
  letter-spacing: 0; text-transform: none;
}

/* --- Stat strip (the "COUNT / label" cards across the top of Live) --- */
.ax-statstrip {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: var(--ax-gap); padding: var(--ax-pad) var(--ax-pad) 0;
}
.ax-stat {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius); padding: 14px 16px;
}
.ax-stat__label {
  font-size: var(--ax-fs-xs); text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--ax-muted); display: flex; align-items: center; gap: 6px;
}
.ax-stat__value {
  font-size: 24px; font-weight: 600; margin-top: 4px; letter-spacing: -0.02em;
  font-family: var(--ax-mono); font-variant-numeric: tabular-nums;
}
.ax-stat__sub {
  font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ax-stat--live .ax-stat__value { color: var(--ax-accent); }
.ax-stat--warn .ax-stat__value { color: var(--ax-warn); }
.ax-stat--err .ax-stat__value { color: var(--ax-err); }

/* --- Forms --- */
.ax-field { margin: 10px 0 0; }
.ax-field:first-child { margin-top: 0; }
.ax-field label {
  display: block; margin-bottom: 5px;
  font-size: var(--ax-fs-xs); color: var(--ax-muted);
  text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500;
}
.ax-field label .ax-hint {
  text-transform: none; letter-spacing: 0; color: var(--ax-muted);
  font-weight: 400; font-size: var(--ax-fs-xs); margin-left: 6px;
}
.ax-field input, .ax-field textarea, .ax-field select {
  width: 100%;
  background: var(--ax-bg); color: var(--ax-text);
  border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius);
  padding: 8px 10px; font: inherit; font-size: var(--ax-fs);
  transition: border-color 0.1s ease;
}
.ax-field input:focus, .ax-field textarea:focus, .ax-field select:focus {
  outline: none; border-color: var(--ax-accent);
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--ax-accent) 18%, transparent);
}
.ax-field textarea { resize: vertical; min-height: 72px; font-family: var(--ax-font); }
.ax-field input::placeholder, .ax-field textarea::placeholder {
  color: var(--ax-muted); opacity: 0.7;
}

.ax-row { display: flex; gap: 12px; }
.ax-row > * { flex: 1; }

/* --- Section titles shared across pages --- */
.ax-section-title {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 12px;
}
.ax-section-title__label {
  font-size: var(--ax-fs-xs); text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--ax-muted);
}
.ax-section-title__right {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--ax-fs-xs); color: var(--ax-muted);
}`
