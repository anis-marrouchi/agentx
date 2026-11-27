// --- The Hub's panels: resize, collapse, expand, remembered; Back (#2101 P) ---
//
// Anis, 2026-11-26: "make the side menu collapsible like Orca. Orca makes
// any side panel controllable ... we can reduce its size, or collapse it,
// or expand it, or we can also navigate back to the previous pages."
//
// Two panels on a computer (over 1180 px; under it the menu is already the
// 56 px rail and the right panel a sheet, so nothing changes there):
//   - nav: the side menu. Drag its right edge (200–420 px), or collapse it
//     to the 56 px icon rail and expand it again.
//   - cx: the right context panel (wall-context.client.ts). Drag its left
//     edge (320 px up to 70% of the window), or collapse it; its tabs stay
//     open and the titlebar's Panel button brings it back. Opening a new tab
//     expands it again.
// The page in the middle keeps at least 480 px: the saved widths are fitted
// to the window on load, on every window resize and after each drag (the
// saved preference itself is kept, so a wider window gives it back).
// Each edge is a separator: drag it, double-click it to give the panel its
// default width back, or focus it and use ← → (16 px) and Enter (collapse or
// expand). Esc inside the right panel collapses it. "Reset layout" in the
// status bar puts both panels back as they start (orca-design C21, C23). On a Mac ⌘B toggles the menu
// and ⌘J the panel. Windows and Linux get no shortcut: Ctrl+B and Ctrl+J
// are the browser's (bookmarks, downloads), and Ctrl+Shift+J opens the
// console, so there the buttons and the focusable edges do it.
// The widths and the collapsed state are kept in localStorage (one key).
//
// Back and Forward in the titlebar walk the browser's history, which the
// Hub's hash pages already fill. With the Navigation API the browser says
// whether it can go back; without it each history entry carries its index
// in history.state (hubHistStep), so a browser Back or swipe counts down,
// not up, and a reload reads the index of the entry it is on.

import { icon } from "../icons"
import { tip } from "../components"

/** The panels the Hub remembers. */
export type HubPanelId = "nav" | "cx"
export interface HubPanelState { w: number | null; folded: boolean }
export type HubPanels = Record<HubPanelId, HubPanelState>

export const HUB_PANELS_KEY = "ax.hub.panels"
export const HUB_NAV_MIN = 200
export const HUB_NAV_MAX = 420
/** The menu's width when nothing is saved, and folded to icons (the CSS). */
export const HUB_NAV_DEFAULT = 280
export const HUB_NAV_RAIL = 56
export const HUB_CX_MIN = 320
/** The right panel's widest, as a share of the window. */
export const HUB_CX_MAX_SHARE = 0.7
/** The right panel's width when nothing is saved: minmax(380px, 42vw). */
export const HUB_CX_DEFAULT_MIN = 380
export const HUB_CX_DEFAULT_SHARE = 0.42
export const HUB_PANEL_STEP = 16

/** The page in the middle never gets narrower than this, so its text is
 *  not squeezed (the Workflows complaint, 2026-11-26). */
export const HUB_MAIN_MIN = 480

/** The bounds, in one object. The helpers below are shipped to the browser
 *  as text (injectFns), where module constants do not exist, so the page
 *  passes this object to them as JSON; the server and tests use the default. */
export const HUB_PANEL_LIMITS = {
  navMin: HUB_NAV_MIN, navMax: HUB_NAV_MAX, navDefault: HUB_NAV_DEFAULT, navRail: HUB_NAV_RAIL,
  cxMin: HUB_CX_MIN, cxMaxShare: HUB_CX_MAX_SHARE, cxDefaultMin: HUB_CX_DEFAULT_MIN, cxDefaultShare: HUB_CX_DEFAULT_SHARE,
  mainMin: HUB_MAIN_MIN,
}
export type HubPanelLimits = typeof HUB_PANEL_LIMITS

/** A panel's width kept inside its bounds; null (the default) stays null.
 *  `others`: the width of the other side column, so the page in the middle
 *  keeps at least 480 px. A panel never goes under its own minimum. */
export function hubPanelClamp(id: string, w: unknown, viewport: number, others?: number, lim: HubPanelLimits = HUB_PANEL_LIMITS): number | null {
  if (typeof w !== "number" || !isFinite(w)) return null
  const min = id === "nav" ? lim.navMin : lim.cxMin
  let max = id === "nav" ? lim.navMax : Math.floor(viewport * lim.cxMaxShare)
  if (typeof others === "number" && isFinite(others)) max = Math.min(max, viewport - others - lim.mainMin)
  return Math.round(Math.min(Math.max(min, max), Math.max(min, w)))
}

/** The saved state, read safely: anything broken gives the defaults. */
export function hubPanelsRead(raw: string | null | undefined, viewport: number, lim: HubPanelLimits = HUB_PANEL_LIMITS): HubPanels {
  let saved: Record<string, { w?: unknown; folded?: unknown }> = {}
  try {
    const v = raw ? JSON.parse(raw) : null
    if (v && typeof v === "object" && !Array.isArray(v)) saved = v
  } catch { saved = {} }
  const one = (id: string) => {
    const s = saved[id] && typeof saved[id] === "object" ? saved[id] : {}
    return { w: hubPanelClamp(id, s.w, viewport, undefined, lim), folded: s.folded === true }
  }
  return { nav: one("nav"), cx: one("cx") }
}

/** The state fitted to this window: the right panel first leaves the page
 *  480 px next to the menu, then the menu gives way if both still do not
 *  fit. `cxOpen`: the right panel shows (it takes no room otherwise). The
 *  saved state is not changed; this is what the page shows now. */
export function hubPanelsFit(p: HubPanels, viewport: number, cxOpen: boolean, lim: HubPanelLimits = HUB_PANEL_LIMITS): HubPanels {
  const navW = p.nav.folded ? lim.navRail : (p.nav.w ?? lim.navDefault)
  const cxShows = cxOpen && !p.cx.folded
  const cxW = cxShows && p.cx.w != null ? hubPanelClamp("cx", p.cx.w, viewport, navW, lim) : p.cx.w
  const cxTakes = !cxShows ? 0 : (cxW ?? Math.max(lim.cxDefaultMin, Math.round(viewport * lim.cxDefaultShare)))
  const nW = p.nav.w != null ? hubPanelClamp("nav", p.nav.w, viewport, cxTakes, lim) : null
  return { nav: { w: nW, folded: p.nav.folded }, cx: { w: cxW, folded: p.cx.folded } }
}

/** The CSS variables and classes the state gives `.ax-wall`. */
export function hubPanelsApply(p: HubPanels): { vars: Record<string, string>; classes: Record<string, boolean> } {
  const vars: Record<string, string> = {}
  // A folded panel takes the fold's width (the CSS), not its saved one: the
  // saved width comes back when it is expanded.
  if (p.nav.w != null && !p.nav.folded) vars["--axp-nav-w"] = p.nav.w + "px"
  if (p.cx.w != null && !p.cx.folded) vars["--axp-cx-w"] = p.cx.w + "px"
  return { vars, classes: { "nav-folded": p.nav.folded, "cx-folded": p.cx.folded } }
}

/** The width a drag gives: the nav grows to the right, the panel to the left. */
export function hubPanelDrag(id: string, startW: number, startX: number, x: number, viewport: number, others?: number, lim: HubPanelLimits = HUB_PANEL_LIMITS): number | null {
  return hubPanelClamp(id, id === "nav" ? startW + (x - startX) : startW - (x - startX), viewport, others, lim)
}

/** Which panel a key press toggles, or null to leave the key to the page.
 *  ⌘B / ⌘J on a Mac only (see the top of this file); never while typing,
 *  never under 1180 px, and ⌘J only while the right panel has tabs, so a
 *  stray ⌘J cannot fold a panel that is not there. */
export function hubPanelKey(
  ev: { key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  ctx: { mac: boolean; typing: boolean; viewport: number; cxOpen: boolean },
): HubPanelId | null {
  if (!ctx.mac || !ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null
  if (ctx.typing || ctx.viewport <= 1180) return null
  const k = (ev.key || "").toLowerCase()
  if (k === "b") return "nav"
  if (k === "j" && ctx.cxOpen) return "cx"
  return null
}

/** Back and Forward without the Navigation API: where this tab is in the
 *  Hub's history. `idx` is the entry's own index (kept in history.state),
 *  `top` the furthest entry ahead. A new entry (`state` has no index) goes
 *  one past the current one and drops what was ahead; moving to an entry
 *  that has an index, by Back, Forward or a swipe, takes that index. */
export function hubHistStep(cur: { idx: number; top: number }, stateIdx: unknown): { idx: number; top: number } {
  if (typeof stateIdx === "number" && isFinite(stateIdx) && stateIdx >= 0) {
    return { idx: stateIdx, top: Math.max(cur.top, stateIdx) }
  }
  const idx = cur.idx + 1
  return { idx, top: idx }
}

/** Whether the right panel's tabs changed because something was opened in
 *  it: one more tab, or another tab made the open one. A folded panel then
 *  expands, so what was opened shows. Closing a tab, or the panel drawing
 *  the same tabs again, does not. `n`: tabs, `on`: the open tab's index. */
export function hubCxOpened(prev: { n: number; on: string | null }, next: { n: number; on: string | null }): boolean {
  if (next.n > prev.n) return true
  return next.n > 0 && next.n === prev.n && next.on !== prev.on
}

/** The helpers HUB_PANELS_SCRIPT calls, for injectFns() in the page. */
export const HUB_PANELS_FNS = { hubPanelClamp, hubPanelsRead, hubPanelsFit, hubPanelsApply, hubPanelDrag, hubPanelKey, hubHistStep, hubCxOpened }

// Lucide, 16 px (icons.ts).
const PANEL_ICON = {
  menu: icon("panel-left"),
  reset: icon("rotate-ccw", 14),
  panel: icon("panel-right"),
  back: icon("chevron-left"),
  fwd: icon("chevron-right"),
}

/** The menu's fold button, at the top of the nav. */
export function hubNavFoldHtml(): string {
  return `<button type="button" class="axp-btn axp-navfold" data-panel-toggle="nav" aria-label="Collapse the side menu" aria-expanded="true" ${tip("Collapse the side menu")}>${PANEL_ICON.menu}</button>`
}

/** The edges you drag: one on the nav, one on the right panel. */
export function hubPanelGripHtml(id: HubPanelId): string {
  const label = id === "nav" ? "Resize the side menu" : "Resize the right panel"
  // The value: the panel's width in px. The page script keeps
  // aria-valuenow (and the right panel's max, which follows the window) in step.
  const [min, max, now] = id === "nav" ? [HUB_NAV_MIN, HUB_NAV_MAX, HUB_NAV_DEFAULT] : [HUB_CX_MIN, HUB_CX_MIN, HUB_CX_MIN]
  return `<div class="axp-grip axp-grip--${id}" data-panel-grip="${id}" role="separator" aria-orientation="vertical" aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${now}" tabindex="0" ${tip("Drag to resize. Double-click to reset.")}></div>`
}

/** Back, Forward and the Panel button, at the start of the titlebar. */
export function hubHistoryHtml(): string {
  return `<span class="axp-hist"><button type="button" class="axp-btn" data-hist="back" aria-label="Back to the previous page" ${tip("Back")} disabled>${PANEL_ICON.back}</button><button type="button" class="axp-btn" data-hist="fwd" aria-label="Forward" ${tip("Forward")} disabled>${PANEL_ICON.fwd}</button></span>`
}

/** Shown while the right panel is collapsed and has tabs open. */
export function hubPanelReopenHtml(): string {
  return `<button type="button" class="axp-btn axp-reopen" data-panel-toggle="cx" aria-label="Show the right panel" ${tip("Show the right panel")} hidden>${PANEL_ICON.panel}<b class="axp-reopen__n" id="axp-cx-n"></b></button>`
}

/** "Reset layout" (C21): in the status bar, shown only while a panel is not
 *  as it starts (a width set, or folded). */
export function hubPanelResetHtml(): string {
  return `<button type="button" class="hs__btn axp-reset" data-panel-reset hidden>${PANEL_ICON.reset}<span>Reset layout</span></button>`
}

export const HUB_PANELS_CSS = `
/* Panels you resize, collapse and expand (#2101 P, hub-panels.ts). */
.axp-btn { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 28px; height: 28px; padding: 0 4px; border-radius: var(--ax-radius-sm); color: var(--ax-muted); cursor: pointer; }
@media (hover: hover) { .axp-btn:hover:not(:disabled) { background: var(--ax-surface-3); color: var(--ax-text); } }
.axp-btn:focus-visible { box-shadow: var(--ax-focus-ring); }
.axp-btn:disabled { opacity: .35; cursor: default; }
.axp-btn svg { width: 16px; height: 16px; flex: none; }
.axp-hist { display: inline-flex; gap: 2px; margin-right: 6px; flex: none; }
.axp-reopen__n { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.axp-reopen__n:empty { display: none; }
.ax-wall__nav { position: sticky; }
.axp-navfold { position: absolute; top: 14px; right: 10px; }
.axp-grip { position: absolute; top: 0; bottom: 0; width: 7px; z-index: 5; cursor: col-resize; touch-action: none; }
.axp-grip::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; background: transparent; transition: background-color .12s ease-out; }
@media (hover: hover) { .axp-grip:hover::after { background: var(--ax-ring); } }
.axp-grip.is-drag::after { background: var(--ax-ring); }
/* Focus: the one ring (S1), as a 3px band on the edge. */
.axp-grip:focus-visible::after { left: 2px; width: 3px; background: color-mix(in srgb, var(--ax-ring) 50%, transparent); }
.axp-grip:focus-visible { box-shadow: none; }
/* The menu scrolls, so its edge sits on the page, at the menu's width. */
.axp-grip--nav { position: fixed; left: calc(var(--axp-nav-w, 280px) - 4px); }
.ax-wall.is-editor .axp-grip--nav, .ax-wall.is-editor .axp-navfold { display: none; }
.axp-grip--cx { left: -4px; }
.wcx { position: sticky; }
body.axp-dragging, body.axp-dragging * { cursor: col-resize !important; user-select: none !important; }
/* The widths: the grids read these variables (wall-space.ts, wall-chat.css.ts, wall-context.client.ts). */
@media (min-width: 1181px) {
  .ax-wall.nav-folded { --axp-nav-w: ${HUB_NAV_RAIL}px; }
  /* The rail itself is hub-nav.ts .is-rail. */
  .ax-wall.nav-folded .axp-navfold svg { transform: scaleX(-1); }
  .ax-wall.nav-folded .axp-grip--nav { display: none; }
  .ax-wall.cx-open.cx-folded, .ax-wall.cx-open.cx-folded.is-wide, .ax-wall.cx-open.cx-folded.is-settings, .ax-wall.hc-open.cx-open.cx-folded { grid-template-columns: var(--axp-nav-w, 280px) minmax(0, 1fr); }
  .ax-wall.cx-folded .wcx { display: none; }
}
/* History Back replaces the post's own ← (it still opens the feed when the post was opened by a link).
   On a phone Back and Forward are hidden, so the post's own ← stays. */
@media (min-width: 641px) { .ax-wall__back { display: none !important; } }
/* Under 1180 px the rail and the sheet stay as they are. */
@media (max-width: 1180px) {
  .axp-grip, .axp-navfold, .axp-reopen, .axp-reset { display: none !important; }
}
@media (max-width: 640px) { .axp-hist { display: none; } }
@media (prefers-reduced-motion: reduce) { .axp-grip::after { transition: none; } }
`

/** Runs in the page after the Hub's own scripts. */
export const HUB_PANELS_SCRIPT = String.raw`
(function () {
  var wall = document.querySelector('.ax-wall');
  if (!wall) return;
  var KEY = '${HUB_PANELS_KEY}', LIM = ${JSON.stringify(HUB_PANEL_LIMITS)};
  // ⌘B and ⌘J on a Mac only: on Windows and Linux Ctrl+B and Ctrl+J are the browser's.
  var MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  function read() { try { return hubPanelsRead(localStorage.getItem(KEY), innerWidth, LIM); } catch (e) { return hubPanelsRead(null, innerWidth, LIM); } }
  var P = read();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* private mode: the state lives for this page only */ } }
  function cxOpen() { return wall.classList.contains('cx-open'); }
  function cxSeen() {
    var t = document.querySelectorAll('#wcx-tabs [role="tab"]'), on = document.querySelector('#wcx-tabs [role="tab"][aria-selected="true"]');
    return { n: t.length, on: on ? on.getAttribute('data-i') : null };
  }
  function shown(el) { return !!(el && el.getClientRects().length); }
  function widthOf(id) {
    var el = id === 'nav' ? wall.querySelector('.ax-wall__nav') : document.getElementById('wall-ctx');
    return el ? el.getBoundingClientRect().width : 0;
  }
  function others(id) { return id === 'nav' ? (cxOpen() && !P.cx.folded ? widthOf('cx') : 0) : widthOf('nav'); }
  function apply() {
    // What shows is the saved state fitted to this window, so the page keeps 480 px.
    var a = hubPanelsApply(hubPanelsFit(P, innerWidth, cxOpen(), LIM));
    wall.style.removeProperty('--axp-nav-w'); wall.style.removeProperty('--axp-cx-w');
    Object.keys(a.vars).forEach(function (k) { wall.style.setProperty(k, a.vars[k]); });
    Object.keys(a.classes).forEach(function (k) { wall.classList.toggle(k, a.classes[k]); });
    // The icon rail (hub-nav.ts, orca-design C26): 641-1180 px, the folded
    // menu on a computer, and the workflow editor.
    wall.classList.toggle('is-rail', innerWidth > 640 && (innerWidth <= 1180 || P.nav.folded || wall.classList.contains('is-editor')));
    document.querySelectorAll('[data-panel-toggle="nav"]').forEach(function (b) {
      b.setAttribute('aria-expanded', String(!P.nav.folded));
      b.setAttribute('aria-label', P.nav.folded ? 'Expand the side menu' : 'Collapse the side menu');
      b.setAttribute('data-tip', (P.nav.folded ? 'Expand' : 'Collapse') + ' the side menu');
      if (MAC) b.setAttribute('data-tip-key', '⌘B');
    });
    var re = document.querySelector('.axp-reopen'), n = cxSeen().n;
    if (re) {
      re.hidden = !(P.cx.folded && cxOpen());
      if (MAC) re.setAttribute('data-tip-key', '⌘J');
      var c = document.getElementById('axp-cx-n'); if (c) c.textContent = n > 1 ? String(n) : '';
    }
    // Reset layout shows only while there is something to reset.
    var moved = P.nav.w != null || P.nav.folded || P.cx.w != null || P.cx.folded;
    document.querySelectorAll('[data-panel-reset]').forEach(function (b) { b.hidden = !moved; });
    // The edges' values for a screen reader: the width now, and how far it can go in this window.
    document.querySelectorAll('[data-panel-grip]').forEach(function (g) {
      var id = g.getAttribute('data-panel-grip'), min = id === 'nav' ? LIM.navMin : LIM.cxMin;
      var max = hubPanelClamp(id, 1e6, innerWidth, others(id), LIM);
      g.setAttribute('aria-valuemin', String(min)); g.setAttribute('aria-valuemax', String(max));
      g.setAttribute('aria-valuenow', String(Math.min(max, Math.max(min, Math.round(widthOf(id)) || min))));
    });
  }
  // A fold hides what had the focus (an edge, a button in the panel): put it on the button that undoes it.
  function toggle(id) {
    var had = document.activeElement;
    P[id].folded = !P[id].folded; save(); apply();
    if (!had || had === document.body || shown(had)) return;
    var to = id === 'nav' ? document.querySelector('.axp-navfold') : document.querySelector(P.cx.folded ? '.axp-reopen' : '.axp-grip--cx');
    if (shown(to)) to.focus();
  }
  function reset() { P = { nav: { w: null, folded: false }, cx: { w: null, folded: false } }; save(); apply(); }
  function setW(id, w) { P[id].w = hubPanelClamp(id, w, innerWidth, others(id), LIM); P[id].folded = false; apply(); }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-panel-toggle],[data-hist],[data-panel-reset]');
    if (!t) return;
    if (t.hasAttribute('data-panel-reset')) { reset(); return; }
    if (t.hasAttribute('data-panel-toggle')) { toggle(t.getAttribute('data-panel-toggle')); return; }
    if (t.getAttribute('data-hist') !== 'back') { history.forward(); return; }
    // Nothing behind in this tab (a post opened from a link): the post's own Back opens the feed.
    var own = document.getElementById('wall-back');
    if (!canBack() && own && !own.hidden) own.click(); else history.back();
  });
  // Drag an edge; double-click it for the default width; ← → and Enter from the keyboard.
  document.addEventListener('pointerdown', function (ev) {
    var g = ev.target.closest && ev.target.closest('[data-panel-grip]');
    if (!g || ev.button !== 0) return;
    ev.preventDefault();
    var id = g.getAttribute('data-panel-grip'), x0 = ev.clientX, w0 = widthOf(id);
    g.classList.add('is-drag'); document.body.classList.add('axp-dragging');
    try { g.setPointerCapture(ev.pointerId); } catch (e) { /* an old browser: the document listeners still follow */ }
    function move(e) { setW(id, hubPanelDrag(id, w0, x0, e.clientX, innerWidth, others(id), LIM)); }
    function up() {
      g.classList.remove('is-drag'); document.body.classList.remove('axp-dragging');
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      save(); apply();
    }
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  document.addEventListener('dblclick', function (ev) {
    var g = ev.target.closest && ev.target.closest('[data-panel-grip]');
    if (!g) return;
    var id = g.getAttribute('data-panel-grip');
    if (id === 'cx' && !cxOpen()) return;
    P[id].w = null; P[id].folded = false; save(); apply();
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
    var tg = ev.target || {}, tag = tg.tagName || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!tg.isContentEditable;
    // Esc inside the right panel (C16): on a computer it collapses, and the focus goes to the
    // button that brings it back; under 1180 px, where it is a sheet, its open tab closes.
    // Not while typing (a line comment), and not when something in the panel already used the Esc.
    if (ev.key === 'Escape' && !typing && !ev.defaultPrevented && cxOpen() && tg.closest && tg.closest('#wall-ctx')) {
      if (innerWidth > 1180) { if (!P.cx.folded) { ev.preventDefault(); toggle('cx'); } return; }
      var x = document.querySelector('#wcx-tabs .wcx__tab.is-on [data-cx="close"]');
      if (x) { ev.preventDefault(); x.click(); var top = document.querySelector('#wcx-tabs [role="tab"]'); if (top) top.focus(); }
      return;
    }
    var id2 = hubPanelKey(ev, { mac: MAC, typing: typing, viewport: innerWidth, cxOpen: cxOpen() });
    if (!id2) return;
    ev.preventDefault();
    toggle(id2);
  });
  // Fit the widths again when the window changes size.
  var rz = 0;
  window.addEventListener('resize', function () { if (!rz) rz = requestAnimationFrame(function () { rz = 0; apply(); }); });
  // The panel opens and closes as tabs come and go: keep the Panel button in step,
  // and expand a folded panel when something new is opened in it.
  var seen = cxSeen();
  function tabsChanged() {
    var now = cxSeen();
    if (P.cx.folded && hubCxOpened(seen, now)) { P.cx.folded = false; save(); }
    seen = now; apply();
  }
  new MutationObserver(apply).observe(wall, { attributes: true, attributeFilter: ['class'] });
  var tabs = document.getElementById('wcx-tabs');
  if (tabs) new MutationObserver(tabsChanged).observe(tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
  var ownBack = document.getElementById('wall-back');
  if (ownBack) new MutationObserver(function () { hist(); }).observe(ownBack, { attributes: true, attributeFilter: ['hidden'] });

  // Back and Forward: enabled when the browser has somewhere to go in this tab.
  var nav = window.navigation, useNav = !!(nav && 'canGoBack' in nav && nav.addEventListener);
  // Without the Navigation API, each entry keeps its index in history.state (hubHistStep):
  // a Back or a swipe lands on an entry that has one, a new page gets the next one.
  var H = { idx: 0, top: 0 }, TOP = 'ax.hub.histTop', rs = history.replaceState, ps = history.pushState;
  function stIdx() { var s = history.state; return s && typeof s === 'object' ? s.axIdx : undefined; }
  function withIdx(s, i) {
    if (s == null) return { axIdx: i };
    if (typeof s !== 'object' || Array.isArray(s)) return s;
    var o = {}; for (var k in s) o[k] = s[k]; o.axIdx = i; return o;
  }
  function keepTop() { try { sessionStorage.setItem(TOP, String(H.top)); } catch (e) { /* the top is then this page's only */ } }
  // Bring H to the entry the browser is on; stamp a new entry with its index.
  function sync() {
    var s = stIdx();
    if (typeof s === 'number' && s === H.idx) return;
    H = hubHistStep(H, s); keepTop();
    if (typeof s !== 'number') rs.call(history, withIdx(history.state, H.idx), '');
  }
  function canBack() { return useNav ? nav.canGoBack : H.idx > 0; }
  function hist() {
    var own = document.getElementById('wall-back');
    var back = canBack() || !!(own && !own.hidden);
    var fwd = useNav ? nav.canGoForward : H.idx < H.top;
    document.querySelectorAll('[data-hist="back"]').forEach(function (b) { b.disabled = !back; });
    document.querySelectorAll('[data-hist="fwd"]').forEach(function (b) { b.disabled = !fwd; });
  }
  if (useNav) nav.addEventListener('currententrychange', hist);
  else {
    var s0 = stIdx(), t0 = 0;
    try { t0 = Number(sessionStorage.getItem(TOP)) || 0; } catch (e) { t0 = 0; }
    // A reload or a return from another site lands on an entry with its index; a fresh page starts at 0.
    if (typeof s0 === 'number') H = { idx: s0, top: Math.max(s0, t0) };
    else { H = { idx: 0, top: 0 }; rs.call(history, withIdx(history.state, 0), ''); }
    keepTop();
    // The Hub's own replaceState and pushState keep the index (they pass null).
    history.replaceState = function (s, t, u) { sync(); return rs.call(history, withIdx(s, H.idx), t, u); };
    history.pushState = function (s, t, u) { sync(); H = hubHistStep(H, undefined); keepTop(); var r = ps.call(history, withIdx(s, H.idx), t, u); hist(); return r; };
    window.addEventListener('popstate', function () { sync(); hist(); });
    window.addEventListener('hashchange', function () { sync(); hist(); });
  }
  apply(); hist();
})();
`
