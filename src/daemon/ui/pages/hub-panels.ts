// --- The Hub's panels: resize, collapse, expand, remembered; Back (#2101 P) ---
//
// Anis, 2026-11-26: "make the side menu collapsible like Orca. Orca makes
// any side panel controllable ... we can reduce its size, or collapse it,
// or expand it, or we can also navigate back to the previous pages."
//
// Two panels on a computer (over 1180 px; under it the menu is already the
// 72 px rail and the right panel a sheet, so nothing changes there):
//   - nav: the side menu. Drag its right edge (200–420 px), or collapse it
//     to the 72 px icon rail and expand it again.
//   - cx: the right context panel (wall-context.client.ts). Drag its left
//     edge (320 px up to 70% of the window), or collapse it; its tabs stay
//     open and the titlebar's Panel button brings it back.
// Each edge is a separator: drag it, double-click it to collapse or expand,
// or focus it and use ← → (16 px) and Enter. ⌘B / Ctrl+B toggles the menu,
// ⌘J / Ctrl+J the panel. The widths and the collapsed state are kept in
// localStorage (one key), so a reload or a new tab opens them as left.
//
// Back and Forward in the titlebar walk the browser's history, which the
// Hub's hash pages already fill: Back returns to the previous page, not
// only from a post to the feed.

/** The panels the Hub remembers. */
export type HubPanelId = "nav" | "cx"
export interface HubPanelState { w: number | null; folded: boolean }
export type HubPanels = Record<HubPanelId, HubPanelState>

export const HUB_PANELS_KEY = "ax.hub.panels"
export const HUB_NAV_MIN = 200
export const HUB_NAV_MAX = 420
export const HUB_CX_MIN = 320
/** The right panel's widest, as a share of the window. */
export const HUB_CX_MAX_SHARE = 0.7
export const HUB_PANEL_STEP = 16

/** The page in the middle never gets narrower than this from a drag, so
 *  its text is not squeezed (the Workflows complaint, 2026-11-26). */
export const HUB_MAIN_MIN = 480

/** A panel's width kept inside its bounds; null (the default) stays null.
 *  `others`: the width of the other side columns, so the right panel
 *  leaves the page at least 480 px. */
export function hubPanelClamp(id: string, w: unknown, viewport: number, others?: number): number | null {
  if (typeof w !== "number" || !isFinite(w)) return null
  const min = id === "nav" ? 200 : 320
  let max = id === "nav" ? 420 : Math.floor(viewport * 0.7)
  if (id !== "nav" && typeof others === "number") max = Math.min(max, viewport - others - 480)
  return Math.round(Math.min(Math.max(min, max), Math.max(min, w)))
}

/** The saved state, read safely: anything broken gives the defaults. */
export function hubPanelsRead(raw: string | null | undefined, viewport: number): HubPanels {
  let saved: Record<string, { w?: unknown; folded?: unknown }> = {}
  try {
    const v = raw ? JSON.parse(raw) : null
    if (v && typeof v === "object" && !Array.isArray(v)) saved = v
  } catch { saved = {} }
  const one = (id: string) => {
    const s = saved[id] && typeof saved[id] === "object" ? saved[id] : {}
    return { w: hubPanelClamp(id, s.w, viewport), folded: s.folded === true }
  }
  return { nav: one("nav"), cx: one("cx") }
}

/** The CSS variables and classes the state gives `.ax-wall`. */
export function hubPanelsApply(p: HubPanels): { vars: Record<string, string>; classes: Record<string, boolean> } {
  const vars: Record<string, string> = {}
  // A folded panel takes the fold's width (the CSS), not its saved one: the
  // saved width comes back when it is expanded.
  if (p.nav.w != null && !p.nav.folded) vars["--ax-nav-w"] = p.nav.w + "px"
  if (p.cx.w != null && !p.cx.folded) vars["--ax-cx-w"] = p.cx.w + "px"
  return { vars, classes: { "nav-folded": p.nav.folded, "cx-folded": p.cx.folded } }
}

/** The width a drag gives: the nav grows to the right, the panel to the left. */
export function hubPanelDrag(id: string, startW: number, startX: number, x: number, viewport: number, others?: number): number | null {
  return hubPanelClamp(id, id === "nav" ? startW + (x - startX) : startW - (x - startX), viewport, others)
}

const PANEL_ICON = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
}

/** The menu's fold button, at the top of the nav. */
export function hubNavFoldHtml(): string {
  return `<button type="button" class="axp-btn axp-navfold" data-panel-toggle="nav" aria-label="Collapse the side menu" aria-expanded="true" title="Collapse the side menu (⌘B)">${PANEL_ICON.menu}</button>`
}

/** The edges you drag: one on the nav, one on the right panel. */
export function hubPanelGripHtml(id: HubPanelId): string {
  const label = id === "nav" ? "Resize the side menu" : "Resize the right panel"
  return `<div class="axp-grip axp-grip--${id}" data-panel-grip="${id}" role="separator" aria-orientation="vertical" aria-label="${label}" tabindex="0" title="Drag to resize. Double-click to collapse."></div>`
}

/** Back, Forward and the Panel button, at the start of the titlebar. */
export function hubHistoryHtml(): string {
  return `<span class="axp-hist"><button type="button" class="axp-btn" data-hist="back" aria-label="Back to the previous page" title="Back" disabled>${PANEL_ICON.back}</button><button type="button" class="axp-btn" data-hist="fwd" aria-label="Forward" title="Forward" disabled>${PANEL_ICON.fwd}</button></span>`
}

/** Shown while the right panel is collapsed and has tabs open. */
export function hubPanelReopenHtml(): string {
  return `<button type="button" class="axp-btn axp-reopen" data-panel-toggle="cx" aria-label="Show the right panel" title="Show the right panel (⌘J)" hidden>${PANEL_ICON.panel}<b class="axp-reopen__n" id="axp-cx-n"></b></button>`
}

export const HUB_PANELS_CSS = `
/* Panels you resize, collapse and expand (#2101 P, hub-panels.ts). */
.axp-btn { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 28px; height: 28px; padding: 0 4px; border-radius: var(--ax-radius-sm); color: var(--ax-muted); cursor: pointer; }
.axp-btn:hover:not(:disabled) { background: var(--ax-surface-3); color: var(--ax-text); }
.axp-btn:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 1px; }
.axp-btn:disabled { opacity: .35; cursor: default; }
.axp-btn svg { width: 16px; height: 16px; flex: none; }
.axp-hist { display: inline-flex; gap: 2px; margin-right: 6px; flex: none; }
.axp-reopen__n { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.axp-reopen__n:empty { display: none; }
.ax-wall__nav { position: sticky; }
.axp-navfold { position: absolute; top: 14px; right: 10px; }
.axp-grip { position: absolute; top: 0; bottom: 0; width: 7px; z-index: 5; cursor: col-resize; touch-action: none; }
.axp-grip::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; background: transparent; transition: background-color .12s ease-out; }
.axp-grip:hover::after, .axp-grip:focus-visible::after, .axp-grip.is-drag::after { background: var(--ax-accent); }
.axp-grip:focus-visible { outline: none; }
/* The menu scrolls, so its edge sits on the page, at the menu's width. */
.axp-grip--nav { position: fixed; left: calc(var(--ax-nav-w, 280px) - 4px); }
.ax-wall.is-editor .axp-grip--nav, .ax-wall.is-editor .axp-navfold { display: none; }
.axp-grip--cx { left: -4px; }
.wcx { position: sticky; }
body.axp-dragging, body.axp-dragging * { cursor: col-resize !important; user-select: none !important; }
/* The widths: the grids read these variables (wall-space.ts, wall-chat.css.ts, wall-context.client.ts). */
@media (min-width: 1181px) {
  .ax-wall.nav-folded { --ax-nav-w: 72px; }
  .ax-wall.nav-folded .ax-wall__nav { padding: 12px 8px; align-items: center; }
  .ax-wall.nav-folded .ax-wall__logo small, .ax-wall.nav-folded .ax-wall__nav > .ax-wall__item span, .ax-wall.nav-folded .ax-wall__nav > .lt,
  .ax-wall.nav-folded .ax-wall__nav .ax-wall__navlbl, .ax-wall.nav-folded .ax-wall__nav > .ha { display: none; }
  /* The same icon rail as under 1180 px (hub-nav.ts): the switcher is its magnifier, the foot row a column of icons. */
  .ax-wall.nav-folded .ax-wall__nav > .ha__k { position: static; box-shadow: none; width: 40px; height: 40px; padding: 0; justify-content: center; }
  .ax-wall.nav-folded .ax-wall__nav > .ha__k span, .ax-wall.nav-folded .ax-wall__nav > .ha__k kbd, .ax-wall.nav-folded .hf__item span { display: none; }
  .ax-wall.nav-folded .ax-wall__nav > .hf { margin-top: auto; flex-direction: column; flex-wrap: nowrap; gap: 4px; padding: 10px 0 2px; }
  .ax-wall.nav-folded .hf__item { position: relative; padding: 8px; }
  .ax-wall.nav-folded .hf__item svg { width: 18px; height: 18px; }
  .ax-wall.nav-folded .hf__set { margin-left: 0; }
  .ax-wall.nav-folded .hf__n { position: absolute; top: 0; right: -4px; }
  .ax-wall.nav-folded .ax-wall__item { width: max-content; }
  .ax-wall.nav-folded .ax-wall__n { position: absolute; top: 4px; right: 0; min-width: 18px; line-height: 18px; padding: 0 4px; font-size: 11px; }
  .ax-wall.nav-folded .ax-wall__logo { padding: 8px 0 8px; }
  .ax-wall.nav-folded .axp-navfold { position: static; margin: 0 0 10px; }
  .ax-wall.nav-folded .axp-navfold svg { transform: scaleX(-1); }
  .ax-wall.nav-folded .axp-grip--nav { display: none; }
  .ax-wall.cx-open.cx-folded, .ax-wall.cx-open.cx-folded.is-wide, .ax-wall.cx-open.cx-folded.is-settings, .ax-wall.hc-open.cx-open.cx-folded { grid-template-columns: var(--ax-nav-w, 280px) minmax(0, 1fr); }
  .ax-wall.cx-folded .wcx { display: none; }
}
/* History Back replaces the post's own ← (it still opens the feed when the post was opened by a link). */
.ax-wall__back { display: none !important; }
/* Under 1180 px the rail and the sheet stay as they are. */
@media (max-width: 1180px) {
  .axp-grip, .axp-navfold, .axp-reopen { display: none !important; }
}
@media (max-width: 640px) { .axp-hist { display: none; } }
@media (prefers-reduced-motion: reduce) { .axp-grip::after { transition: none; } }
`

/** Runs in the page after the Hub's own scripts. */
export const HUB_PANELS_SCRIPT = String.raw`
(function () {
  var wall = document.querySelector('.ax-wall');
  if (!wall) return;
  var KEY = '${HUB_PANELS_KEY}';
  function read() { try { return hubPanelsRead(localStorage.getItem(KEY), innerWidth); } catch (e) { return hubPanelsRead(null, innerWidth); } }
  var P = read();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* private mode: the state lives for this page only */ } }
  function cxTabs() { return document.querySelectorAll('#wcx-tabs [role="tab"]').length; }
  function apply() {
    var a = hubPanelsApply(P);
    wall.style.removeProperty('--ax-nav-w'); wall.style.removeProperty('--ax-cx-w');
    Object.keys(a.vars).forEach(function (k) { wall.style.setProperty(k, a.vars[k]); });
    Object.keys(a.classes).forEach(function (k) { wall.classList.toggle(k, a.classes[k]); });
    document.querySelectorAll('[data-panel-toggle="nav"]').forEach(function (b) {
      b.setAttribute('aria-expanded', String(!P.nav.folded));
      b.setAttribute('aria-label', P.nav.folded ? 'Expand the side menu' : 'Collapse the side menu');
      b.title = (P.nav.folded ? 'Expand' : 'Collapse') + ' the side menu (⌘B)';
    });
    var re = document.querySelector('.axp-reopen'), n = cxTabs();
    if (re) { re.hidden = !(P.cx.folded && wall.classList.contains('cx-open')); var c = document.getElementById('axp-cx-n'); if (c) c.textContent = n > 1 ? String(n) : ''; }
  }
  function toggle(id) { P[id].folded = !P[id].folded; save(); apply(); }
  function widthOf(id) {
    var el = id === 'nav' ? wall.querySelector('.ax-wall__nav') : document.getElementById('wall-ctx');
    return el ? el.getBoundingClientRect().width : 0;
  }
  function others(id) { return id === 'nav' ? 0 : widthOf('nav'); }
  function setW(id, w) { P[id].w = hubPanelClamp(id, w, innerWidth, others(id)); P[id].folded = false; apply(); }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-panel-toggle],[data-hist]');
    if (!t) return;
    if (t.hasAttribute('data-panel-toggle')) { toggle(t.getAttribute('data-panel-toggle')); return; }
    if (t.getAttribute('data-hist') !== 'back') { history.forward(); return; }
    // Nothing behind in this tab (a post opened from a link): the post's own Back opens the feed.
    var own = document.getElementById('wall-back'), nv = window.navigation;
    var can = nv && 'canGoBack' in nv ? nv.canGoBack : depth > 0;
    if (!can && own && !own.hidden) own.click(); else history.back();
  });
  // Drag an edge; double-click it to collapse or expand; ← → and Enter from the keyboard.
  document.addEventListener('pointerdown', function (ev) {
    var g = ev.target.closest && ev.target.closest('[data-panel-grip]');
    if (!g || ev.button !== 0) return;
    ev.preventDefault();
    var id = g.getAttribute('data-panel-grip'), x0 = ev.clientX, w0 = widthOf(id);
    g.classList.add('is-drag'); document.body.classList.add('axp-dragging');
    try { g.setPointerCapture(ev.pointerId); } catch (e) { /* an old browser: the document listeners still follow */ }
    function move(e) { setW(id, hubPanelDrag(id, w0, x0, e.clientX, innerWidth, others(id))); }
    function up() {
      g.classList.remove('is-drag'); document.body.classList.remove('axp-dragging');
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      save();
    }
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  document.addEventListener('dblclick', function (ev) {
    var g = ev.target.closest && ev.target.closest('[data-panel-grip]');
    if (g) toggle(g.getAttribute('data-panel-grip'));
  });
  document.addEventListener('keydown', function (ev) {
    var g = ev.target.closest && ev.target.closest('[data-panel-grip]');
    if (g) {
      var id = g.getAttribute('data-panel-grip'), d = id === 'nav' ? 1 : -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        setW(id, widthOf(id) + (ev.key === 'ArrowRight' ? d : -d) * ${HUB_PANEL_STEP}); save(); return;
      }
      if (ev.key === 'Enter') { ev.preventDefault(); toggle(id); return; }
    }
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
    var k = (ev.key || '').toLowerCase();
    if (k !== 'b' && k !== 'j') return;
    var tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
    if (innerWidth <= 1180) return;
    ev.preventDefault();
    toggle(k === 'b' ? 'nav' : 'cx');
  });
  // The panel opens and closes as tabs come and go: keep the Panel button in step.
  new MutationObserver(apply).observe(wall, { attributes: true, attributeFilter: ['class'] });
  var tabs = document.getElementById('wcx-tabs');
  if (tabs) new MutationObserver(apply).observe(tabs, { childList: true });
  var ownBack = document.getElementById('wall-back');
  if (ownBack) new MutationObserver(function () { hist(); }).observe(ownBack, { attributes: true, attributeFilter: ['hidden'] });
  // Back and Forward: enabled when the browser has somewhere to go in this tab.
  var depth = 0, ahead = 0;
  try { depth = Number(sessionStorage.getItem('ax.hub.depth')) || 0; ahead = Number(sessionStorage.getItem('ax.hub.ahead')) || 0; } catch (e) { depth = 0; }
  var nav = window.navigation;
  function hist() {
    var own = document.getElementById('wall-back');
    var back = (nav && 'canGoBack' in nav ? nav.canGoBack : depth > 0) || !!(own && !own.hidden);
    var fwd = nav && 'canGoForward' in nav ? nav.canGoForward : ahead > 0;
    document.querySelectorAll('[data-hist="back"]').forEach(function (b) { b.disabled = !back; });
    document.querySelectorAll('[data-hist="fwd"]').forEach(function (b) { b.disabled = !fwd; });
  }
  function keep() { try { sessionStorage.setItem('ax.hub.depth', String(depth)); sessionStorage.setItem('ax.hub.ahead', String(ahead)); } catch (e) { /* the buttons fall back to enabled */ } }
  if (nav && nav.addEventListener) nav.addEventListener('currententrychange', hist);
  else {
    // No Navigation API: count the hash moves; a Back press counts down.
    var going = 0;
    document.addEventListener('click', function (ev) { var t = ev.target.closest && ev.target.closest('[data-hist]'); if (t) going = t.getAttribute('data-hist') === 'back' ? -1 : 1; }, true);
    window.addEventListener('hashchange', function () {
      if (going < 0) { depth = Math.max(0, depth - 1); ahead++; } else if (going > 0) { depth++; ahead = Math.max(0, ahead - 1); } else { depth++; ahead = 0; }
      going = 0; keep(); hist();
    });
  }
  apply(); hist();
})();
`
