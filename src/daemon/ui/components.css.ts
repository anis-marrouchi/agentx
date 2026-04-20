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
  max-width: 1040px; margin: 18px auto 22px; padding: 0 24px;
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
.ax-connector.is-active {
  border-color: var(--ax-accent);
  background: color-mix(in oklch, var(--ax-accent) 8%, var(--ax-surface));
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

/* --- Mesh hero (enable toggle + SVG network viz) --- */
.ax-mesh-hero {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: 20px;
  display: grid; grid-template-columns: 1fr 240px; gap: 24px;
  align-items: center; margin-bottom: 18px;
}
.ax-mesh-hero h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.ax-mesh-hero p { margin: 0 0 12px; font-size: 12.5px; color: var(--ax-text-2); line-height: 1.5; }
.ax-mesh-viz { position: relative; width: 240px; height: 140px; }
.ax-mesh-dot {
  position: absolute; width: 44px; height: 44px; border-radius: 50%;
  background: var(--ax-surface-2); border: 2px solid var(--ax-border-2);
  display: grid; place-items: center;
  font-family: var(--ax-mono); font-size: 10px; font-weight: 600;
  color: var(--ax-text-2);
}
.ax-mesh-dot.self {
  background: color-mix(in oklch, var(--ax-accent) 18%, var(--ax-surface));
  border-color: var(--ax-accent); color: var(--ax-accent);
}
.ax-mesh-dot.empty {
  border-style: dashed; color: var(--ax-muted); font-size: 14px;
}
.ax-mesh-wires { position: absolute; inset: 0; }
.ax-mesh-wires line { stroke: var(--ax-border-2); stroke-width: 1.5; stroke-dasharray: 3 3; }
.ax-mesh-wires line.live { stroke: var(--ax-accent); stroke-dasharray: 0; opacity: 0.6; }

/* Pill-shaped toggle (used for the mesh enable switch + similar binary actions). */
.ax-mesh-toggle {
  display: inline-flex; align-items: center; gap: 10px;
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: 20px; padding: 4px 14px 4px 5px;
  cursor: pointer; user-select: none; font-size: 12px;
}
.ax-mesh-switch {
  width: 32px; height: 18px; background: var(--ax-surface-3);
  border-radius: 9px; position: relative; transition: background 160ms;
}
.ax-mesh-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--ax-text-2); transition: all 160ms;
}
.ax-mesh-toggle.is-on .ax-mesh-switch {
  background: color-mix(in oklch, var(--ax-accent) 80%, transparent);
}
.ax-mesh-toggle.is-on .ax-mesh-switch::after {
  left: 16px; background: var(--ax-bg);
}

/* --- Schedule builder: sentence-builder + pill picks + day picker --- */
.ax-builder {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: 20px;
}
.ax-builder h3 {
  margin: 0 0 4px; font-size: 15px; font-weight: 600; letter-spacing: -0.005em;
}
.ax-builder__hint { margin: 0 0 16px; font-size: 12.5px; color: var(--ax-muted); }
.ax-builder__lbl {
  display: block; font-size: 11px; color: var(--ax-muted);
  letter-spacing: 0.03em; text-transform: uppercase; margin: 12px 0 5px;
  font-weight: 500;
}
.ax-builder__lbl .opt {
  text-transform: none; letter-spacing: 0; font-weight: 400;
  opacity: 0.75; margin-left: 6px;
}
.ax-builder__inp {
  width: 100%; background: var(--ax-bg); color: var(--ax-text);
  border: 1px solid var(--ax-border); border-radius: 5px;
  padding: 8px 11px; font: inherit; font-size: 13px;
  transition: border-color 120ms, box-shadow 120ms;
}
.ax-builder__inp:focus {
  outline: none; border-color: var(--ax-accent);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--ax-accent) 18%, transparent);
}
textarea.ax-builder__inp { min-height: 80px; line-height: 1.5; resize: vertical; }

.ax-mode-switch {
  display: inline-flex; background: var(--ax-surface-2);
  border: 1px solid var(--ax-border); border-radius: 6px; padding: 3px;
  margin-bottom: 14px;
}
.ax-mode-switch button {
  background: transparent; border: 0; color: var(--ax-muted);
  padding: 6px 14px; font: inherit; font-size: 12px; cursor: pointer;
  border-radius: 4px; font-weight: 500;
}
.ax-mode-switch button.is-active {
  background: var(--ax-surface); color: var(--ax-text);
}

.ax-sentence {
  display: flex; align-items: center; gap: 8px;
  font-size: 16px; line-height: 1.9; flex-wrap: wrap;
  margin-bottom: 14px; padding: 14px 16px;
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-sm);
}
.ax-sentence > span { color: var(--ax-text-2); }
.ax-pill-pick {
  background: var(--ax-surface); border: 1px solid var(--ax-border-2);
  color: var(--ax-accent); padding: 3px 10px; border-radius: 6px;
  font-size: 14px; font-family: inherit; cursor: pointer; font-weight: 500;
}
.ax-pill-pick:hover { background: var(--ax-surface-2); border-color: var(--ax-accent); }
.ax-pill-pick--sm { font-size: 13px; padding: 3px 8px; }

.ax-day-picker { display: flex; gap: 4px; }
.ax-day-picker button {
  width: 30px; height: 30px; border-radius: 6px;
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  color: var(--ax-muted); font: inherit; font-size: 11px; font-weight: 500;
  cursor: pointer;
}
.ax-day-picker button:hover { border-color: var(--ax-border-2); color: var(--ax-text); }
.ax-day-picker button.is-active {
  background: color-mix(in oklch, var(--ax-accent) 20%, var(--ax-surface));
  border-color: var(--ax-accent); color: var(--ax-accent);
}

.ax-preview-box {
  background: color-mix(in oklch, var(--ax-accent) 5%, var(--ax-bg-elev));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 20%, var(--ax-border));
  border-radius: var(--ax-radius-sm); padding: 12px 14px; margin-top: 12px;
  font-size: 12.5px; color: var(--ax-text-2);
  display: flex; align-items: center; gap: 10px;
}
.ax-preview-box svg { width: 15px; height: 15px; color: var(--ax-accent); flex-shrink: 0; }
.ax-preview-box b { color: var(--ax-text); font-weight: 600; }

.ax-cron-hints {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 18px;
  margin-top: 10px; font-size: 11.5px; color: var(--ax-muted);
}
.ax-cron-hints code {
  font-family: var(--ax-mono); color: var(--ax-text);
  background: var(--ax-bg); border: 1px solid var(--ax-border);
  padding: 1px 6px; border-radius: 3px; margin-right: 6px;
}

/* --- JSON tree viewer (Advanced tab) --- */
.ax-jv-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: var(--ax-bg-elev);
  border: 1px solid var(--ax-border); border-bottom: 0;
  border-radius: var(--ax-radius) var(--ax-radius) 0 0;
}
.ax-jv-toolbar .ax-jv-spacer { flex: 1; }
.ax-jv-toolbar .ax-jv-seg {
  display: inline-flex; background: var(--ax-surface);
  border: 1px solid var(--ax-border); border-radius: 5px; padding: 2px;
}
.ax-jv-toolbar .ax-jv-seg button {
  background: transparent; border: 0; color: var(--ax-muted);
  padding: 4px 10px; font: inherit; font-size: 11px;
  cursor: pointer; border-radius: 4px;
}
.ax-jv-toolbar .ax-jv-seg button.is-active { background: var(--ax-surface-2); color: var(--ax-text); }
.ax-jv-search {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: 5px; padding: 4px 9px; font: inherit; font-size: 12px;
  color: var(--ax-text); width: 180px;
}
.ax-jv-search:focus { outline: none; border-color: var(--ax-accent); }

.ax-jv-viewer {
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-top: 0; border-radius: 0 0 var(--ax-radius) var(--ax-radius);
  font-family: var(--ax-mono); font-size: 12.5px; line-height: 1.75;
  padding: 14px 18px; max-height: 620px; overflow: auto;
}
.ax-jv-line {
  display: flex; align-items: flex-start; padding: 1px 0; gap: 0;
  position: relative; border-radius: 3px; white-space: nowrap;
}
.ax-jv-line:hover { background: color-mix(in oklch, var(--ax-accent) 5%, transparent); }
.ax-jv-line.is-match { background: color-mix(in oklch, var(--ax-warn) 16%, transparent); }
.ax-jv-toggle {
  width: 12px; display: inline-block; color: var(--ax-muted);
  cursor: pointer; user-select: none; text-align: center;
  font-size: 9px; line-height: 1.75;
}
.ax-jv-toggle.empty { cursor: default; }
.ax-jv-key { color: var(--ax-info); margin-right: 0; }
.ax-jv-punc { color: var(--ax-muted); }
.ax-jv-string { color: var(--ax-accent); }
.ax-jv-number { color: var(--ax-warn); }
.ax-jv-bool { color: var(--ax-info); font-weight: 500; }
.ax-jv-null { color: var(--ax-muted); font-style: italic; }
.ax-jv-comment {
  color: var(--ax-muted); font-family: var(--ax-font);
  font-style: italic; font-size: 11.5px; margin-left: 8px; opacity: 0.8;
}
.ax-jv-children {
  padding-left: 18px;
  border-left: 1px dashed color-mix(in oklch, var(--ax-border) 80%, transparent);
  margin-left: 4px;
}
.ax-jv-children.is-collapsed { display: none; }
.ax-jv-collapsed-note {
  color: var(--ax-muted); font-size: 11px; font-style: italic; margin-left: 4px;
}
.ax-jv-empty-brace { color: var(--ax-muted); }

/* ============================================================
 * Detail-page primitives (Agent manage, and any future
 * detail-view). Built around a 3-col layout:
 *
 *   [rail 200px] [main] [test-drive 360px]
 *
 * Scales down: test-drive hides at 1180px, rail hides at 780px.
 * ============================================================ */

/* Crumb */
.ax-crumb {
  max-width: 1400px; margin: 0 auto; padding: 16px 24px 0;
  font-size: 12px; color: var(--ax-muted);
  display: flex; align-items: center; gap: 6px;
}
.ax-crumb a { color: var(--ax-muted); }
.ax-crumb a:hover { color: var(--ax-accent); text-decoration: none; }
.ax-crumb .ax-crumb__sep { color: var(--ax-border-2); }
.ax-crumb .ax-crumb__cur { color: var(--ax-text); }

/* Hero — large avatar + editable name + chip row + actions */
.ax-hero {
  max-width: 1400px; margin: 0 auto; padding: 14px 24px 18px;
  display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
}
.ax-hero__ava {
  width: 64px; height: 64px; border-radius: 14px;
  background: color-mix(in oklch, var(--ax-accent) 20%, var(--ax-surface));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 40%, var(--ax-border));
  display: grid; place-items: center;
  font-weight: 700; font-size: 22px; letter-spacing: -0.02em;
  color: var(--ax-accent); flex-shrink: 0; position: relative;
}
.ax-hero__on {
  position: absolute; bottom: -2px; right: -2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--ax-accent); border: 3px solid var(--ax-bg);
}
.ax-hero__title { flex: 1; min-width: 260px; }
.ax-hero h1 {
  margin: 0 0 3px; font-size: 22px; font-weight: 600;
  letter-spacing: -0.02em; display: flex; align-items: center; gap: 10px;
}
.ax-hero h1 input {
  background: transparent; border: 0; color: var(--ax-text);
  font: inherit; padding: 0; border-bottom: 1px dashed transparent;
  transition: border-color 120ms; max-width: 260px;
}
.ax-hero h1 input:hover { border-color: var(--ax-border-2); }
.ax-hero h1 input:focus { outline: none; border-color: var(--ax-accent); }
.ax-hero__sub {
  color: var(--ax-text-2); font-size: 13px; margin-top: 2px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.ax-hero__sub .ax-hero__dot {
  width: 3px; height: 3px; background: var(--ax-border-2); border-radius: 50%;
}
.ax-hero__actions { display: flex; gap: 8px; align-items: center; }

/* Inline stats strip (smaller than the settings health strip — fits in
 * the detail page hero below the hero title). */
.ax-stats-inline {
  max-width: 1400px; margin: 0 auto; padding: 0 24px;
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
}
.ax-stat-inline {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-sm); padding: 10px 12px;
  display: flex; align-items: center; gap: 11px;
}
.ax-stat-inline__icon {
  width: 26px; height: 26px; border-radius: 6px;
  background: color-mix(in oklch, var(--ax-accent) 12%, var(--ax-surface-2));
  display: grid; place-items: center;
  color: var(--ax-accent); flex-shrink: 0;
}
.ax-stat-inline__icon svg { width: 14px; height: 14px; }
.ax-stat-inline__v {
  font-size: 15px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.1;
}
.ax-stat-inline__l {
  font-size: 11px; color: var(--ax-muted); margin-top: 1px;
}

/* 3-col detail layout (rail + main + test-drive) */
.ax-layout {
  max-width: 1400px; margin: 22px auto 0; padding: 0 24px 60px;
  display: grid; grid-template-columns: 200px 1fr 360px;
  gap: 22px; align-items: flex-start;
}

/* Left rail — sticky nav list with grouped items */
.ax-rail {
  position: sticky; top: 72px;
  display: flex; flex-direction: column; gap: 1px;
}
.ax-rail a {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 11px; border-radius: 6px;
  color: var(--ax-text-2); font-size: 13px; font-weight: 500;
  cursor: pointer; position: relative;
  transition: background 120ms, color 120ms;
}
.ax-rail a svg {
  width: 15px; height: 15px; flex-shrink: 0; color: var(--ax-muted);
}
.ax-rail a:hover {
  background: var(--ax-surface); color: var(--ax-text); text-decoration: none;
}
.ax-rail a:hover svg { color: var(--ax-text); }
.ax-rail a.is-active {
  background: color-mix(in oklch, var(--ax-accent) 12%, var(--ax-surface));
  color: var(--ax-accent);
}
.ax-rail a.is-active svg { color: var(--ax-accent); }
.ax-rail a.is-active::before {
  content: ""; position: absolute; left: -3px; top: 7px; bottom: 7px;
  width: 2px; border-radius: 2px; background: var(--ax-accent);
}
.ax-rail__count {
  margin-left: auto; font-family: var(--ax-mono);
  font-size: 10px; padding: 1px 6px; background: var(--ax-surface-2);
  color: var(--ax-muted); border-radius: 9px; line-height: 14px;
}
.ax-rail a.is-active .ax-rail__count {
  background: color-mix(in oklch, var(--ax-accent) 22%, transparent);
  color: var(--ax-accent);
}
.ax-rail__sep { height: 1px; background: var(--ax-border); margin: 8px 4px; }
.ax-rail__label {
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ax-muted); padding: 6px 11px 4px; font-family: var(--ax-mono);
}

/* Main panel containers (one per section) */
.ax-panel {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: 22px;
}
.ax-panel + .ax-panel { margin-top: 12px; }
.ax-panel h2 {
  margin: 0 0 4px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em;
}
.ax-panel .ax-lead {
  margin: 0 0 16px; font-size: 12.5px; color: var(--ax-text-2); line-height: 1.55;
}
.ax-panel__head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; margin-bottom: 14px;
}
.ax-panel__head h2 { margin: 0 0 3px; }
.ax-panel__tab { display: none; animation: ax-fade 180ms ease; }
.ax-panel__tab.is-active { display: block; }
@keyframes ax-fade {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: none; }
}

/* Grids for form rows */
.ax-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ax-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }

/* Slider-style setting row — label + hint + segmented options */
.ax-slider-row {
  display: grid; grid-template-columns: 140px 1fr auto;
  gap: 12px; align-items: center;
  padding: 10px 0; border-bottom: 1px dashed var(--ax-border);
}
.ax-slider-row:last-child { border-bottom: 0; }
.ax-slider-row label { font-size: 12.5px; color: var(--ax-text); margin: 0; }
.ax-slider-row .ax-hint {
  margin: 0; color: var(--ax-muted); font-size: 11.5px;
}
.ax-slider-row .ax-opts {
  display: flex; gap: 4px; background: var(--ax-bg);
  border: 1px solid var(--ax-border); border-radius: 5px; padding: 2px;
}
.ax-slider-row .ax-opts button {
  background: transparent; border: 0; color: var(--ax-muted);
  padding: 5px 11px; font: inherit; font-size: 11.5px;
  cursor: pointer; border-radius: 3px; white-space: nowrap;
}
.ax-slider-row .ax-opts button.is-active {
  background: var(--ax-surface-2); color: var(--ax-text);
}

/* Sub-tabs (Guided/Freeform, CLAUDE.md/SOUL.md/IDENTITY.md) */
.ax-subtabs {
  display: inline-flex; background: var(--ax-bg);
  border: 1px solid var(--ax-border); border-radius: 6px;
  padding: 3px; margin-bottom: 16px;
}
.ax-subtabs button {
  background: transparent; border: 0; color: var(--ax-muted);
  padding: 6px 14px; font: inherit; font-size: 12px;
  cursor: pointer; border-radius: 4px; font-weight: 500;
}
.ax-subtabs button.is-active {
  background: var(--ax-surface-2); color: var(--ax-text);
}

/* Trigger-word chips with inline input (for Wake words field) */
.ax-triggers-edit {
  display: flex; flex-wrap: wrap; gap: 6px;
  background: var(--ax-bg); border: 1px solid var(--ax-border);
  padding: 7px; border-radius: 5px; min-height: 38px;
  align-items: center; cursor: text;
}
.ax-triggers-edit:focus-within {
  border-color: var(--ax-accent);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--ax-accent) 18%, transparent);
}
.ax-trig-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--ax-mono); font-size: 11px;
  padding: 3px 4px 3px 9px;
  background: color-mix(in oklch, var(--ax-accent) 16%, var(--ax-surface));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 30%, var(--ax-border));
  border-radius: 4px; color: var(--ax-accent);
}
.ax-trig-pill button {
  background: transparent; border: 0; color: currentColor;
  opacity: 0.6; cursor: pointer; font-size: 13px; line-height: 1;
  padding: 0 2px; border-radius: 3px;
}
.ax-trig-pill button:hover {
  opacity: 1;
  background: color-mix(in oklch, var(--ax-accent) 20%, transparent);
}
.ax-triggers-edit input {
  flex: 1; min-width: 120px;
  background: transparent; border: 0; color: var(--ax-text);
  font: inherit; font-size: 12.5px;
  padding: 4px 6px; font-family: var(--ax-mono);
}
.ax-triggers-edit input:focus { outline: none; }

/* Prompt editor (freeform CLAUDE.md) */
.ax-prompt-edit { position: relative; }
.ax-prompt-edit textarea { min-height: 220px; line-height: 1.6; }
.ax-prompt-badges {
  position: absolute; top: 8px; right: 8px; display: flex; gap: 6px;
}
.ax-prompt-badges .ax-pbadge {
  font-size: 10px; padding: 3px 7px; border-radius: 3px;
  background: var(--ax-surface-2); color: var(--ax-muted);
  font-family: var(--ax-mono); letter-spacing: 0.03em;
}

/* Skill gallery */
.ax-skill-toolbar {
  display: flex; gap: 10px; align-items: center;
  margin-bottom: 14px; flex-wrap: wrap;
}
.ax-search {
  position: relative; flex: 1; min-width: 220px;
}
.ax-search svg {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  width: 13px; height: 13px; color: var(--ax-muted); pointer-events: none;
}
.ax-search input { width: 100%; padding-left: 30px; }
.ax-skill-filter {
  display: flex; gap: 4px; background: var(--ax-bg);
  border: 1px solid var(--ax-border); border-radius: 5px; padding: 2px;
}
.ax-skill-filter button {
  background: transparent; border: 0; color: var(--ax-muted);
  padding: 5px 10px; font: inherit; font-size: 11.5px;
  cursor: pointer; border-radius: 3px;
}
.ax-skill-filter button.is-active {
  background: var(--ax-surface-2); color: var(--ax-text);
}
.ax-skill-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.ax-skill-card {
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: 14px;
  display: flex; flex-direction: column; gap: 8px;
  cursor: pointer; position: relative; overflow: hidden;
  transition: border-color 160ms, transform 160ms, background 160ms;
}
.ax-skill-card:hover { border-color: var(--ax-border-2); transform: translateY(-1px); }
.ax-skill-card.is-on {
  border-color: color-mix(in oklch, var(--ax-accent) 40%, var(--ax-border));
  background: color-mix(in oklch, var(--ax-accent) 5%, var(--ax-bg-elev));
}
.ax-skill-card.is-on::after {
  content: ""; position: absolute; top: 0; right: 0;
  width: 0; height: 0;
  border-left: 26px solid transparent;
  border-top: 26px solid var(--ax-accent);
}
.ax-skill-card.is-on::before {
  content: ""; position: absolute; top: 5px; right: 3px;
  width: 7px; height: 4px;
  border-left: 2px solid var(--ax-bg);
  border-bottom: 2px solid var(--ax-bg);
  transform: rotate(-45deg); z-index: 2;
}
.ax-skill-card__top { display: flex; align-items: center; gap: 10px; }
.ax-skill-card__icon {
  width: 32px; height: 32px; border-radius: 7px;
  background: var(--ax-surface-2);
  display: grid; place-items: center; flex-shrink: 0;
  color: var(--ax-accent);
}
.ax-skill-card__icon svg { width: 16px; height: 16px; }
.ax-skill-card__name {
  font-weight: 600; font-size: 13px; letter-spacing: -0.005em;
}
.ax-skill-card__slug {
  font-family: var(--ax-mono); font-size: 10.5px;
  color: var(--ax-muted); margin-top: 1px;
}
.ax-skill-card__desc {
  font-size: 12px; color: var(--ax-text-2); line-height: 1.5;
  flex: 1; min-height: 32px;
}
.ax-skill-card__foot {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: var(--ax-muted);
}

/* Info callout (similar to wit but inline inside panels) */
.ax-callout {
  background: color-mix(in oklch, var(--ax-info) 5%, var(--ax-bg-elev));
  border: 1px solid color-mix(in oklch, var(--ax-info) 20%, var(--ax-border));
  border-radius: var(--ax-radius-sm); padding: 12px 14px;
  font-size: 12.5px; color: var(--ax-text-2); line-height: 1.6;
  display: flex; gap: 10px; align-items: flex-start; margin-bottom: 16px;
}
.ax-callout__icon {
  width: 18px; height: 18px; border-radius: 50%;
  background: color-mix(in oklch, var(--ax-info) 18%, transparent);
  color: var(--ax-info); display: grid; place-items: center;
  font-size: 11px; font-weight: 600; flex-shrink: 0; margin-top: 1px;
}
.ax-callout b { color: var(--ax-text); }
.ax-callout code {
  font-family: var(--ax-mono); font-size: 11.5px;
  background: var(--ax-bg); padding: 1px 5px; border-radius: 3px;
  border: 1px solid var(--ax-border);
}

/* Channel-binding rows (agent-specific view) */
.ax-chan-row {
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: 12px 14px;
  display: flex; align-items: center; gap: 12px; margin-bottom: 8px;
}
.ax-chan-row__logo {
  width: 32px; height: 32px; border-radius: 7px;
  display: grid; place-items: center;
  font-weight: 700; font-size: 13px; color: white; flex-shrink: 0;
  font-family: var(--ax-mono);
}
.ax-chan-row__info { flex: 1; }
.ax-chan-row__name { font-size: 13px; font-weight: 600; }
.ax-chan-row__desc {
  font-size: 12px; color: var(--ax-muted);
  margin-top: 2px; font-family: var(--ax-mono);
}

/* Handover viz (from-agent → to-agent arrow) */
.ax-handover-viz {
  display: flex; align-items: center; justify-content: space-between;
  gap: 14px; padding: 16px 18px;
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); margin-bottom: 14px;
}
.ax-ho-side {
  display: flex; flex-direction: column; align-items: center;
  gap: 6px; flex: 0 0 130px;
}
.ax-ho-side__av {
  width: 42px; height: 42px; border-radius: 10px;
  display: grid; place-items: center;
  font-weight: 600; font-size: 15px;
}
.ax-ho-side--from .ax-ho-side__av {
  background: color-mix(in oklch, var(--ax-accent) 18%, var(--ax-surface));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 35%, var(--ax-border));
  color: var(--ax-accent);
}
.ax-ho-side--to .ax-ho-side__av {
  background: var(--ax-surface-2); border: 1px solid var(--ax-border-2);
  color: var(--ax-text);
}
.ax-ho-side__nm { font-size: 12px; font-weight: 600; }
.ax-ho-side__rl {
  font-size: 10px; color: var(--ax-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  font-family: var(--ax-mono);
}
.ax-ho-wire {
  flex: 1; height: 2px; position: relative;
  background: repeating-linear-gradient(90deg,
    var(--ax-border-2) 0, var(--ax-border-2) 4px,
    transparent 4px, transparent 8px);
}
.ax-ho-wire svg {
  position: absolute; right: -6px; top: 50%; transform: translateY(-50%);
  width: 16px; height: 16px; color: var(--ax-accent);
}
.ax-ho-list-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-sm); margin-bottom: 6px;
  font-size: 12.5px;
}
.ax-ho-list-row .ax-who { flex: 1; color: var(--ax-text-2); }
.ax-ho-list-row .ax-who b {
  color: var(--ax-text); font-family: var(--ax-mono); font-weight: 500;
}
.ax-ho-list-row .ax-when { color: var(--ax-muted); font-size: 11px; }

/* Activity cells + spark + session rows */
.ax-activity-grid {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 10px; margin-bottom: 18px;
}
.ax-activity-cell {
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-sm); padding: 14px;
}
.ax-activity-cell .ax-v {
  font-size: 20px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2;
}
.ax-activity-cell .ax-l {
  font-size: 11px; color: var(--ax-muted); margin-top: 2px;
}
.ax-activity-cell .ax-delta {
  font-size: 11px; margin-top: 6px;
  display: inline-flex; align-items: center; gap: 3px;
}
.ax-activity-cell .ax-delta--up { color: var(--ax-accent); }
.ax-activity-cell .ax-delta--down { color: var(--ax-muted); }

.ax-spark { width: 100%; height: 100px; margin: 10px 0 14px; }

.ax-session {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-sm); margin-bottom: 6px;
  font-size: 12.5px;
}
.ax-session__ch {
  width: 24px; height: 24px; border-radius: 5px;
  display: grid; place-items: center;
  font-weight: 700; font-size: 10px; color: white;
  flex-shrink: 0; font-family: var(--ax-mono);
}
.ax-session__body { flex: 1; min-width: 0; }
.ax-session__txt {
  color: var(--ax-text); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}
.ax-session__meta {
  font-size: 11px; color: var(--ax-muted);
  margin-top: 1px; font-family: var(--ax-mono);
}

/* Log row (Conversations tab) */
.ax-log-head {
  display: grid; grid-template-columns: 24px 90px 160px 1fr auto;
  gap: 12px; padding: 8px 10px;
  border-bottom: 1px solid var(--ax-border-2);
  font-size: 10px; color: var(--ax-muted);
  text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--ax-mono);
}
.ax-log-row {
  display: grid; grid-template-columns: 24px 90px 160px 1fr auto;
  gap: 12px; align-items: center; padding: 9px 10px;
  border-bottom: 1px solid var(--ax-border); font-size: 12px;
}
.ax-log-row:hover { background: color-mix(in oklch, var(--ax-accent) 4%, transparent); }
.ax-log-row .ax-sev {
  width: 8px; height: 8px; border-radius: 50%; margin-left: 8px;
}
.ax-log-row .ax-sev--ok { background: var(--ax-accent); }
.ax-log-row .ax-sev--warn { background: var(--ax-warn); }
.ax-log-row .ax-sev--err { background: var(--ax-err); }
.ax-log-row .ax-t {
  font-family: var(--ax-mono); color: var(--ax-muted); font-size: 11px;
}
.ax-log-row .ax-who {
  font-family: var(--ax-mono); font-size: 11px; color: var(--ax-text-2);
}
.ax-log-row .ax-msg {
  color: var(--ax-text); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.ax-log-row .ax-ms {
  color: var(--ax-muted); font-family: var(--ax-mono); font-size: 11px;
}

/* Danger zone */
.ax-panel--danger {
  border-color: color-mix(in oklch, var(--ax-err) 30%, var(--ax-border));
}
.ax-danger-item {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 0; border-bottom: 1px dashed var(--ax-border);
}
.ax-danger-item:last-child { border-bottom: 0; padding-bottom: 0; }
.ax-danger-item:first-child { padding-top: 4px; }
.ax-danger-item__info { flex: 1; }
.ax-danger-item__name { font-size: 13px; font-weight: 600; margin-bottom: 3px; }
.ax-danger-item__desc { font-size: 12px; color: var(--ax-muted); line-height: 1.5; }

/* Test-drive side panel */
.ax-td-col { position: sticky; top: 72px; }
.ax-td-panel {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); overflow: hidden;
  display: flex; flex-direction: column;
  height: calc(100vh - 94px); max-height: 760px;
}
.ax-td-head {
  padding: 12px 14px; border-bottom: 1px solid var(--ax-border);
  background: var(--ax-bg-elev);
  display: flex; align-items: center; gap: 10px;
}
.ax-td-head__dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--ax-accent);
  box-shadow: 0 0 8px color-mix(in oklch, var(--ax-accent) 60%, transparent);
  animation: ax-pulse 2.2s infinite;
}
.ax-td-head__t { flex: 1; font-size: 12px; font-weight: 600; }
.ax-td-head__sub {
  font-size: 11px; color: var(--ax-muted); font-family: var(--ax-mono);
}
.ax-td-head__seg {
  display: inline-flex; background: var(--ax-surface);
  border: 1px solid var(--ax-border); border-radius: 5px; padding: 2px;
}
.ax-td-head__seg button {
  background: transparent; border: 0; color: var(--ax-muted);
  padding: 3px 8px; font: inherit; font-size: 10.5px;
  cursor: pointer; border-radius: 3px; font-family: var(--ax-mono);
}
.ax-td-head__seg button.is-active {
  background: var(--ax-surface-2); color: var(--ax-text);
}

.ax-td-scenarios {
  padding: 10px 14px; background: var(--ax-bg-elev);
  border-bottom: 1px solid var(--ax-border);
  display: flex; gap: 5px; flex-wrap: wrap;
}
.ax-td-scenarios__lbl {
  font-size: 10px; color: var(--ax-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  font-family: var(--ax-mono); width: 100%; margin-bottom: 3px;
}
.ax-td-scenario {
  font-size: 11px; padding: 3px 8px;
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: 10px; color: var(--ax-text-2);
  cursor: pointer; transition: all 120ms;
}
.ax-td-scenario:hover { border-color: var(--ax-accent); color: var(--ax-accent); }

.ax-td-chat {
  flex: 1; overflow-y: auto; padding: 14px;
  display: flex; flex-direction: column; gap: 8px;
  background: var(--ax-bg);
}
.ax-td-chat__msg-wrap {
  display: flex; flex-direction: column; gap: 2px; max-width: 86%;
}
.ax-td-chat__msg-wrap.is-user { align-self: flex-end; align-items: flex-end; }
.ax-td-chat__msg-wrap.is-bot { align-self: flex-start; }
.ax-td-chat__bubble {
  padding: 8px 12px; border-radius: 12px;
  font-size: 12.5px; line-height: 1.55; word-wrap: break-word;
}
.ax-td-chat__bubble.is-user {
  background: var(--ax-accent); color: var(--ax-bg);
  border-bottom-right-radius: 3px; font-weight: 500;
}
.ax-td-chat__bubble.is-bot {
  background: var(--ax-surface-2); color: var(--ax-text);
  border-bottom-left-radius: 3px; border: 1px solid var(--ax-border);
}
.ax-td-chat__meta {
  font-size: 9.5px; color: var(--ax-muted);
  font-family: var(--ax-mono); padding: 0 4px;
}
.ax-td-chat__typing {
  align-self: flex-start; padding: 10px 14px;
  background: var(--ax-surface-2); border: 1px solid var(--ax-border);
  border-radius: 12px; border-bottom-left-radius: 3px;
  display: inline-flex; gap: 4px;
}
.ax-td-chat__typing span {
  width: 6px; height: 6px; background: var(--ax-muted);
  border-radius: 50%; animation: axTypingBounce 1.2s infinite;
}
.ax-td-chat__typing span:nth-child(2) { animation-delay: 0.15s; }
.ax-td-chat__typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes axTypingBounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-5px); opacity: 1; }
}
.ax-td-input {
  padding: 10px; border-top: 1px solid var(--ax-border);
  background: var(--ax-bg-elev); display: flex; gap: 6px;
}
.ax-td-input input {
  flex: 1; background: var(--ax-bg); border: 1px solid var(--ax-border);
  border-radius: 6px; padding: 8px 11px;
  color: var(--ax-text); font: inherit; font-size: 12.5px;
}
.ax-td-input input:focus { outline: none; border-color: var(--ax-accent); }
.ax-td-input button {
  background: var(--ax-accent); color: var(--ax-bg); border: 0;
  border-radius: 6px; padding: 0 12px;
  cursor: pointer; font-weight: 600;
}
.ax-td-input button:hover {
  background: color-mix(in oklch, var(--ax-accent) 88%, white);
}

/* Section mini-label used throughout detail pages */
.ax-sec-label-d {
  display: flex; align-items: center; justify-content: space-between;
  margin: 20px 0 10px;
}
.ax-sec-label-d h3 {
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ax-muted);
  margin: 0; font-family: var(--ax-mono);
}

/* --- Responsive collapses for the settings primitives --- */
@media (max-width: 1180px) {
  .ax-layout { grid-template-columns: 180px 1fr; }
  .ax-td-col { display: none; }
}
@media (max-width: 760px) {
  .ax-health-strip { grid-template-columns: repeat(2, 1fr); }
  .ax-connectors { grid-template-columns: 1fr; }
  .ax-detail-grid { grid-template-columns: 1fr; }
  .ax-mesh-hero { grid-template-columns: 1fr; }
  .ax-mesh-viz { margin: 0 auto; }
  .ax-cron-hints { grid-template-columns: 1fr; }
  .ax-layout { grid-template-columns: 1fr; }
  .ax-rail { display: none; }
  .ax-stats-inline { grid-template-columns: repeat(2, 1fr); }
  .ax-activity-grid { grid-template-columns: repeat(2, 1fr); }
  .ax-log-head, .ax-log-row { grid-template-columns: 8px 80px 1fr auto; }
  .ax-log-head span:nth-child(3), .ax-log-row .ax-who { display: none; }
  .ax-grid-2, .ax-grid-3 { grid-template-columns: 1fr; }
}`
