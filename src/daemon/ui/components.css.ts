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
}

/* ============================================================
 * Settings-page design system (also reusable on other pages).
 * Ported from the Stitch redesign mockup so the primitives can
 * be consumed by any page — not just /admin. Sections:
 *   page-head     — kicker + h1 + lead paragraph
 *   health-strip  — 4-up status cards with coloured dot
 *   wit           — dismissable "what is this?" info banner
 *   section-head  — icon chip + title + lead + right-aligned CTA
 *   row-card      — list row with avatar + info + actions + expand
 *   avatar        — coloured-initial square (teal/coral/amber/blue)
 *   pill          — small status pill with coloured dot (chip-flavor)
 *   connectors    — 2-up grid of connector cards
 *   tab-count     — mono count bubble on a tab
 *   toast         — bottom-right ephemeral notification
 *   modal         — simple centred dialog + backdrop
 *   sec-label     — uppercase mini-heading with optional CTA
 * ============================================================ */

/* --- Page head --- */
.ax-page-head {
  max-width: 1040px; margin: 0 auto; padding: 28px 24px 12px;
}
.ax-page-head .ax-kicker {
  display: inline-block; font-size: 10px; letter-spacing: 0.1em;
  color: var(--ax-muted); text-transform: uppercase; margin-bottom: 6px;
  font-family: var(--ax-mono);
}
.ax-page-head h1 {
  font-size: 22px; font-weight: 600; letter-spacing: -0.015em;
  margin: 0 0 4px; display: flex; align-items: center; gap: 10px;
}
.ax-page-head .ax-lead {
  color: var(--ax-text-2); margin: 0; font-size: 13px;
  max-width: 640px; line-height: 1.6;
}
.ax-page-head .ax-lead code {
  font-family: var(--ax-mono); font-size: 11.5px;
  background: var(--ax-surface-2); padding: 1px 6px; border-radius: 3px;
}

/* --- Health strip --- */
.ax-health-strip {
  max-width: 1040px; margin: 18px auto 0; padding: 0 24px;
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
}
.ax-health-card {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-sm); padding: 12px 14px;
  display: flex; align-items: center; gap: 11px;
  transition: border-color 120ms;
}
.ax-health-card:hover { border-color: var(--ax-border-2); }
.ax-health-card .ax-hc-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.ax-health-card .ax-hc-dot--ok {
  background: var(--ax-accent);
  box-shadow: 0 0 8px color-mix(in oklch, var(--ax-accent) 50%, transparent);
}
.ax-health-card .ax-hc-dot--warn { background: var(--ax-warn); }
.ax-health-card .ax-hc-dot--off { background: var(--ax-border-2); }
.ax-health-card .ax-hc-txt { flex: 1; min-width: 0; }
.ax-health-card .ax-hc-num {
  font-size: 17px; font-weight: 600; letter-spacing: -0.015em;
}
.ax-health-card .ax-hc-lbl {
  font-size: 11px; color: var(--ax-muted); margin-top: 1px;
}

/* --- "What is this?" info banner (dismissable) --- */
.ax-wit {
  background: color-mix(in oklch, var(--ax-info) 6%, var(--ax-bg-elev));
  border: 1px solid color-mix(in oklch, var(--ax-info) 22%, var(--ax-border));
  border-radius: var(--ax-radius-sm); padding: 12px 14px; margin-bottom: 18px;
  font-size: 12.5px; color: var(--ax-text-2); line-height: 1.6;
  display: flex; gap: 10px; align-items: flex-start;
}
.ax-wit__icon {
  width: 18px; height: 18px; border-radius: 50%;
  background: color-mix(in oklch, var(--ax-info) 18%, transparent);
  color: var(--ax-info);
  display: grid; place-items: center;
  font-size: 11px; font-weight: 600; flex-shrink: 0; margin-top: 1px;
}
.ax-wit b { color: var(--ax-text); font-weight: 600; }
.ax-wit code {
  font-family: var(--ax-mono); font-size: 11.5px;
  background: var(--ax-bg); padding: 1px 5px; border-radius: 3px;
  border: 1px solid var(--ax-border);
}
.ax-wit .ax-wit__dismiss {
  background: transparent; border: 0; color: var(--ax-muted);
  font-size: 16px; cursor: pointer; margin-left: auto;
  padding: 0 4px; line-height: 1;
}
.ax-wit .ax-wit__dismiss:hover { color: var(--ax-text); }

/* --- Section head (icon + title + lead + right CTA) --- */
.ax-section-head {
  display: flex; align-items: flex-start; gap: 16px; margin-bottom: 18px;
}
.ax-section-head__icon {
  width: 44px; height: 44px; border-radius: 10px;
  background: color-mix(in oklch, var(--ax-accent) 10%, var(--ax-surface));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 25%, var(--ax-border));
  display: grid; place-items: center; flex-shrink: 0;
  color: var(--ax-accent);
}
.ax-section-head__icon svg { width: 22px; height: 22px; }
.ax-section-head__text { flex: 1; }
.ax-section-head h2 {
  font-size: 18px; margin: 0 0 3px;
  font-weight: 600; letter-spacing: -0.01em;
}
.ax-section-head .ax-lead {
  color: var(--ax-text-2); margin: 0; font-size: 13px; line-height: 1.55;
  max-width: 640px;
}

/* --- Row cards (collapsible list items) --- */
.ax-stack { display: flex; flex-direction: column; gap: 10px; }
.ax-row-card {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: 14px 16px;
  transition: border-color 160ms, transform 160ms;
}
.ax-row-card:hover { border-color: var(--ax-border-2); }
.ax-row-card__top { display: flex; align-items: center; gap: 12px; }
.ax-row-card__info { flex: 1; min-width: 0; }
.ax-row-card__info .ax-name {
  font-size: 14px; font-weight: 600; letter-spacing: -0.005em;
  display: flex; align-items: center; gap: 8px;
}
.ax-row-card__info .ax-slug {
  font-family: var(--ax-mono); font-size: 11px;
  color: var(--ax-muted); margin-left: 4px;
}
.ax-row-card__info .ax-sub {
  font-size: 12px; color: var(--ax-text-2); margin-top: 3px;
  line-height: 1.5; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.ax-row-card__actions { display: flex; gap: 6px; align-items: center; }
.ax-row-card__details {
  display: none; margin-top: 14px; padding-top: 14px;
  border-top: 1px dashed var(--ax-border);
  font-size: 12.5px; color: var(--ax-text-2); line-height: 1.6;
}
.ax-row-card.is-open .ax-row-card__details { display: block; }
.ax-row-card.is-open .ax-chev { transform: rotate(180deg); }
.ax-chev { transition: transform 160ms; }

.ax-detail-grid {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 12px 20px; margin-bottom: 12px;
}
.ax-detail-grid dt {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ax-muted); margin-bottom: 3px; font-family: var(--ax-mono);
}
.ax-detail-grid dd {
  margin: 0; font-size: 12.5px; color: var(--ax-text);
}
.ax-triggers { display: flex; gap: 4px; flex-wrap: wrap; }
.ax-trigger-pill {
  font-family: var(--ax-mono); font-size: 11px;
  padding: 2px 8px; background: var(--ax-bg);
  border: 1px solid var(--ax-border); border-radius: 4px;
  color: var(--ax-text);
}

/* --- Avatars (coloured initial square) --- */
.ax-avatar {
  width: 36px; height: 36px; border-radius: 9px; flex-shrink: 0;
  background: var(--ax-surface-2); border: 1px solid var(--ax-border-2);
  display: grid; place-items: center;
  font-weight: 600; font-size: 14px; letter-spacing: -0.01em;
  color: var(--ax-text);
}
.ax-avatar--teal {
  background: color-mix(in oklch, var(--ax-accent) 18%, var(--ax-surface));
  border-color: color-mix(in oklch, var(--ax-accent) 35%, var(--ax-border));
  color: var(--ax-accent);
}
.ax-avatar--coral {
  background: color-mix(in oklch, var(--ax-err) 14%, var(--ax-surface));
  border-color: color-mix(in oklch, var(--ax-err) 30%, var(--ax-border));
  color: var(--ax-err);
}
.ax-avatar--amber {
  background: color-mix(in oklch, var(--ax-warn) 14%, var(--ax-surface));
  border-color: color-mix(in oklch, var(--ax-warn) 30%, var(--ax-border));
  color: var(--ax-warn);
}
.ax-avatar--blue {
  background: color-mix(in oklch, var(--ax-info) 14%, var(--ax-surface));
  border-color: color-mix(in oklch, var(--ax-info) 30%, var(--ax-border));
  color: var(--ax-info);
}

/* --- Pills (status indicator with coloured dot) ---
 *
 * Different from .ax-badge: pills have a rounded (10px) shape, a small
 * leading coloured dot, and stronger semantics (ok/warn/off/info). Use
 * for "live", "idle", "receiving", "stale" states next to a name.
 */
.ax-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; padding: 2px 8px; line-height: 16px;
  border-radius: 10px; background: var(--ax-surface-2);
  color: var(--ax-text-2); border: 1px solid var(--ax-border);
  white-space: nowrap;
}
.ax-pill .ax-pill__dot {
  width: 6px; height: 6px; border-radius: 50%; background: currentColor;
}
.ax-pill--ok {
  background: color-mix(in oklch, var(--ax-accent) 14%, transparent);
  color: var(--ax-accent);
  border-color: color-mix(in oklch, var(--ax-accent) 30%, transparent);
}
.ax-pill--warn {
  background: color-mix(in oklch, var(--ax-warn) 14%, transparent);
  color: var(--ax-warn);
  border-color: color-mix(in oklch, var(--ax-warn) 30%, transparent);
}
.ax-pill--off { color: var(--ax-muted); }
.ax-pill--info {
  background: color-mix(in oklch, var(--ax-info) 14%, transparent);
  color: var(--ax-info);
  border-color: color-mix(in oklch, var(--ax-info) 30%, transparent);
}

/* --- Connectors grid (Channels tab) --- */
.ax-connectors {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;
}
.ax-connector {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: 18px 18px 16px;
  cursor: pointer; position: relative;
  transition: border-color 160ms, transform 160ms, background 160ms;
}
.ax-connector:hover { border-color: var(--ax-border-2); background: var(--ax-surface-2); }
.ax-connector.is-on {
  border-color: color-mix(in oklch, var(--ax-accent) 40%, var(--ax-border));
}
.ax-connector__top {
  display: flex; align-items: center; gap: 12px; margin-bottom: 10px;
}
.ax-connector__logo {
  width: 40px; height: 40px; border-radius: 10px;
  display: grid; place-items: center;
  font-weight: 700; font-size: 15px; letter-spacing: -0.02em; flex-shrink: 0;
  background: var(--ax-surface-2); border: 1px solid var(--ax-border-2);
  color: var(--ax-text); font-family: var(--ax-mono);
}
.ax-connector__meta { flex: 1; }
.ax-connector__name {
  font-weight: 600; font-size: 14px; letter-spacing: -0.005em;
}
.ax-connector__sub {
  font-size: 11.5px; color: var(--ax-muted); margin-top: 2px;
}
.ax-connector__status { margin-left: auto; }
.ax-connector__desc {
  font-size: 12.5px; color: var(--ax-text-2); line-height: 1.5; min-height: 36px;
}
.ax-connector__foot {
  margin-top: 12px; display: flex; align-items: center; justify-content: space-between;
  font-size: 11.5px; color: var(--ax-muted);
}
.ax-connector__cta {
  color: var(--ax-accent); font-weight: 500;
  display: inline-flex; align-items: center; gap: 4px;
}
.ax-connector__cta svg { width: 12px; height: 12px; }

/* --- Tab counts + warn indicator --- */
.ax-tab-count {
  font-family: var(--ax-mono); font-size: 10px;
  padding: 1px 6px; background: var(--ax-surface-2);
  color: var(--ax-muted); border-radius: 9px; line-height: 14px;
  margin-left: 6px;
}
.is-active .ax-tab-count {
  background: color-mix(in oklch, var(--ax-accent) 18%, transparent);
  color: var(--ax-accent);
}
.ax-tab-warn {
  width: 6px; height: 6px; border-radius: 50%; background: var(--ax-warn);
  display: inline-block; margin-left: 6px;
}

/* --- Section mini-labels --- */
.ax-sec-label {
  display: flex; align-items: center; justify-content: space-between;
  margin: 22px 0 10px;
}
.ax-sec-label h3 {
  font-size: 12px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ax-muted);
  margin: 0; font-family: var(--ax-mono);
}

/* --- Toast --- */
.ax-toast {
  position: fixed; bottom: 24px; right: 24px;
  background: var(--ax-surface-2);
  border: 1px solid var(--ax-accent); color: var(--ax-text);
  padding: 10px 16px; border-radius: 6px; font-size: 12.5px;
  display: flex; align-items: center; gap: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  opacity: 0; transform: translateY(10px); pointer-events: none;
  transition: opacity 200ms, transform 200ms; z-index: 100;
}
.ax-toast.is-show { opacity: 1; transform: none; }
.ax-toast__icon { color: var(--ax-accent); }

/* --- Modal (centred dialog + backdrop) --- */
.ax-modal-bd {
  position: fixed; inset: 0;
  background: color-mix(in oklch, var(--ax-bg) 60%, black);
  display: none; align-items: center; justify-content: center;
  z-index: 200; padding: 24px;
}
.ax-modal-bd.is-show { display: flex; }
.ax-modal {
  width: min(560px, 94vw); max-height: 86vh; overflow: auto;
  background: var(--ax-surface); border: 1px solid var(--ax-border-2);
  border-radius: 12px; padding: 0;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
}
.ax-modal > header {
  padding: 18px 22px 10px; border-bottom: 1px solid var(--ax-border);
  display: flex; align-items: center; gap: 10px;
}
.ax-modal > header h3 {
  margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; flex: 1;
}
.ax-modal > header .ax-modal__close {
  background: transparent; border: 0; color: var(--ax-muted);
  font-size: 22px; cursor: pointer; line-height: 1; padding: 0 6px;
}
.ax-modal__body { padding: 18px 22px; }
.ax-modal__foot {
  padding: 12px 22px 18px;
  display: flex; justify-content: flex-end; gap: 8px;
  border-top: 1px solid var(--ax-border);
}

/* --- Responsive collapses for the settings primitives --- */
@media (max-width: 760px) {
  .ax-health-strip { grid-template-columns: repeat(2, 1fr); }
  .ax-connectors { grid-template-columns: 1fr; }
  .ax-detail-grid { grid-template-columns: 1fr; }
}`
