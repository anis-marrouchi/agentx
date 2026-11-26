// --- The Hub's folds, "Show all" caps, Back with its scroll, Reset layout (#2352) ---
//
// Anis, 2026-11-26: the menus "shall not be that visible, but shall be
// present and collapsible ... we give the control to the user to decide
// what he wants to focus on." That is orca-design principle 11, checks
// C22 and C23; C21 (panels that resize and collapse) is hub-panels.ts.
//
// One helper for every page, so no page writes its own:
//   - a section that folds is `<details data-fold="<key>">` with a
//     `<summary>` of chevron, title and count (hubFoldHtml). A page sets
//     `data-fold-start="closed"` on a noisy one. What the reader opens or
//     closes is kept per browser (localStorage, one key) and given back each
//     time the page draws the section again.
//   - a live list is a box with `data-cap="<key>"` whose children are the
//     rows. It shows the first 3, then a "Show all (N)" button after the box;
//     "Show fewer" folds it again. The choice is kept the same way.
//   - Back and Forward give a page back the scroll it had (C23): the
//     position is kept per history entry for this tab (sessionStorage).
//   - Reset layout ([data-hub-reset], in Settings › Layout) forgets the
//     widths and folds of the panels (hub-panels.ts), these folds and caps,
//     and the side menu's own folds (hub-nav.client.ts), then reloads.
//
// The side menu keeps its own fold state (ax.hub.agentOpen), as it redraws
// its groups from its own model; Reset layout clears it with the rest.

import { HUB_PANELS_KEY } from "./hub-panels"

export const HUB_FOLDS_KEY = "ax.hub.folds"
/** Everything Reset layout forgets: the panels, the folds and caps, the side menu's folds. */
export const HUB_LAYOUT_KEYS = [HUB_PANELS_KEY, HUB_FOLDS_KEY, "ax.hub.agentOpen"]
/** Rows a live list shows before "Show all (N)". */
export const HUB_CAP = 3
/** Where Back's scroll positions are kept, for this tab only. */
export const HUB_SCROLL_KEY = "ax.hub.scroll"
/** The most positions kept; the oldest go first. */
export const HUB_SCROLL_MAX = 100

/** What the reader chose: `open` per fold, `all` per capped list. */
export interface HubFolds { open: Record<string, boolean>; all: Record<string, boolean> }

/** The saved choices, read safely: anything broken gives none. */
export function hubFoldsRead(raw: string | null | undefined): HubFolds {
  const out: HubFolds = { open: {}, all: {} }
  let v: unknown = null
  try { v = raw ? JSON.parse(raw) : null } catch { v = null }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out
  for (const part of ["open", "all"] as const) {
    const src = (v as Record<string, unknown>)[part]
    if (!src || typeof src !== "object" || Array.isArray(src)) continue
    for (const k of Object.keys(src)) {
      const b = (src as Record<string, unknown>)[k]
      if (typeof b === "boolean") out[part][k] = b
    }
  }
  return out
}

/** Is this fold open: the reader's choice, else how the page starts it. */
export function hubFoldIsOpen(f: HubFolds, key: string, start?: string | null): boolean {
  if (key && typeof f.open[key] === "boolean") return f.open[key]
  return start !== "closed"
}

/** The cap button's text: "Show all (N)" while capped, "Show fewer" when
 *  all show, or "" when the list is short enough to need none. */
export function hubCapLabel(n: number, all: boolean, cap?: number): string {
  const c = typeof cap === "number" && cap > 0 ? cap : 3
  if (!(n > c)) return ""
  return all ? "Show fewer" : "Show all (" + n + ")"
}

/** Forgets the layout: removes each key, and says which ones were set. */
export function hubLayoutReset(store: { getItem(k: string): string | null; removeItem(k: string): void }, keys: string[]): string[] {
  const gone: string[] = []
  for (const k of keys) {
    try {
      if (store.getItem(k) != null) gone.push(k)
      store.removeItem(k)
    } catch { /* private mode: nothing was kept */ }
  }
  return gone
}

/** The key Back's scroll is kept under for one history entry: the
 *  Navigation API's own entry key, else the entry's index (hub-panels.ts
 *  keeps it in history.state) with the page's hash. */
export function hubScrollKey(navKey: unknown, idx: unknown, hash: string): string {
  if (typeof navKey === "string" && navKey) return "k:" + navKey
  return "i:" + (typeof idx === "number" && isFinite(idx) ? idx : "x") + hash
}

/** The positions with one more kept, the oldest dropped past `max`. */
export function hubScrollKeep(pos: Record<string, number>, key: string, y: number, max?: number): Record<string, number> {
  const m = typeof max === "number" && max > 0 ? max : 100
  const out: Record<string, number> = {}
  for (const k of Object.keys(pos)) if (k !== key) out[k] = pos[k]
  out[key] = Math.max(0, Math.round(y))
  const ks = Object.keys(out)
  for (let i = 0; i < ks.length - m; i++) delete out[ks[i]]
  return out
}

/** A section that folds: chevron, title and count in the header. `esc`
 *  escapes the title (the count is a number). Pages may also write the
 *  markup themselves; the script only needs `details[data-fold]`. */
export function hubFoldHtml(key: string, title: string, count: number | null, body: string, start?: string, esc?: (s: unknown) => string): string {
  const e = esc || ((s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]))
  return '<details class="axp-fold" data-fold="' + e(key) + '"' + (start === "closed" ? ' data-fold-start="closed"' : "") + ' open><summary class="axp-fold__h">' +
    '<span class="axp-fold__t">' + e(title) + "</span>" + (typeof count === "number" ? '<span class="axp-fold__n">' + count + "</span>" : "") +
    "</summary>" + body + "</details>"
}

/** The helpers HUB_FOLDS_SCRIPT calls, for injectFns() in the page. */
export const HUB_FOLDS_FNS = { hubFoldsRead, hubFoldIsOpen, hubCapLabel, hubLayoutReset, hubScrollKey, hubScrollKeep, hubFoldHtml }

export const HUB_FOLDS_CSS = `
/* Sections that fold, lists capped at 3 (#2352, hub-folds.ts). Same look as the side menu's folds. */
.axp-fold > summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; padding: 6px; margin: 8px 0 4px; border-radius: var(--ax-radius-sm);
  font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ax-muted); }
.axp-fold > summary::-webkit-details-marker { display: none; }
.axp-fold > summary::before { content: "›"; flex: none; width: 10px; font-size: 15px; font-weight: 400; line-height: 1; letter-spacing: 0; text-align: center; transition: transform 180ms ease-out; }
.axp-fold[open] > summary::before { transform: rotate(90deg); }
.axp-fold__n { margin-left: auto; font-weight: 500; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.axp-fold > summary:focus-visible { outline: 2px solid var(--ax-ring, var(--ax-accent)); outline-offset: 1px; }
@media (hover: hover) { .axp-fold > summary:hover { color: var(--ax-text-2); } }
[data-cap]:not(.is-all) > :nth-child(n+${HUB_CAP + 1}) { display: none; }
.axp-more { all: unset; box-sizing: border-box; display: block; margin: 4px 0 12px; padding: 4px 6px; border-radius: var(--ax-radius-sm); font-size: 13px; color: var(--ax-muted); cursor: pointer; }
.axp-more:hover { background: var(--ax-surface-3); color: var(--ax-text); }
.axp-more:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .axp-fold > summary::before { transition: none; } }
`

/** Runs in the page after the Hub's own scripts and HUB_PANELS_SCRIPT. */
export const HUB_FOLDS_SCRIPT = String.raw`
(function () {
  var KEY = '${HUB_FOLDS_KEY}', KEYS = ${JSON.stringify(HUB_LAYOUT_KEYS)}, CAP = ${HUB_CAP};
  var F = hubFoldsRead(null);
  try { F = hubFoldsRead(localStorage.getItem(KEY)); } catch (e) { /* private mode: the defaults */ }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(F)); } catch (e) { /* private mode: this page only */ } }
  function capOne(box) {
    var k = box.getAttribute('data-cap'), all = F.all[k] === true;
    var label = hubCapLabel(box.children.length, all, CAP);
    if (box.classList.contains('is-all') !== all) box.classList.toggle('is-all', all);
    var b = box.nextElementSibling;
    if (!(b && b.getAttribute('data-cap-more') === k)) b = null;
    if (!label) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'axp-more'; b.setAttribute('data-cap-more', k); box.after(b); }
    if (b.textContent !== label) b.textContent = label;
    if (b.getAttribute('aria-expanded') !== String(all)) b.setAttribute('aria-expanded', String(all));
  }
  // Pages redraw their HTML: each new fold gets the reader's choice, each list its cap.
  // A MutationObserver runs before the next paint, so nothing flickers open first.
  function fit() {
    document.querySelectorAll('details[data-fold]:not([data-fold-on])').forEach(function (d) {
      d.setAttribute('data-fold-on', '');
      var o = hubFoldIsOpen(F, d.getAttribute('data-fold'), d.getAttribute('data-fold-start'));
      if (d.open !== o) d.open = o;
    });
    document.querySelectorAll('[data-cap]').forEach(capOne);
  }
  new MutationObserver(fit).observe(document.body, { childList: true, subtree: true });
  fit();
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d || !d.getAttribute || !d.hasAttribute('data-fold')) return;
    var k = d.getAttribute('data-fold');
    // Only the reader's own change is kept (fit() sets the same value it read).
    if (d.open === hubFoldIsOpen(F, k, d.getAttribute('data-fold-start'))) return;
    F.open[k] = d.open; save();
  }, true);
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-cap-more],[data-hub-reset]');
    if (!t) return;
    if (t.hasAttribute('data-hub-reset')) {
      ev.preventDefault();
      hubLayoutReset(localStorage, KEYS);
      location.reload();
      return;
    }
    var k = t.getAttribute('data-cap-more');
    F.all[k] = !(F.all[k] === true); save();
    var box = t.previousElementSibling;
    if (box && box.getAttribute('data-cap') === k) capOne(box);
  });

  // Back and Forward give the page its scroll back (C23). Kept per history
  // entry, so a new page opened by a link starts at the top as before.
  var nav = window.navigation, SK = '${HUB_SCROLL_KEY}', MAX = ${HUB_SCROLL_MAX}, pos = {}, restoring = 0, tick = 0;
  try { pos = JSON.parse(sessionStorage.getItem(SK) || '{}') || {}; } catch (e) { pos = {}; }
  function entry() {
    var s = history.state;
    return hubScrollKey(nav && nav.currentEntry ? nav.currentEntry.key : null, s && typeof s === 'object' ? s.axIdx : undefined, location.hash);
  }
  window.addEventListener('scroll', function () {
    if (tick || restoring) return;
    tick = requestAnimationFrame(function () {
      tick = 0;
      if (restoring) return;
      pos = hubScrollKeep(pos, entry(), window.scrollY || 0, MAX);
      try { sessionStorage.setItem(SK, JSON.stringify(pos)); } catch (e) { /* this page only */ }
    });
  }, { passive: true });
  // The page draws after the history moves; wait (up to about a second)
  // until it is tall enough, and stop if the reader scrolls first.
  function giveBack() {
    var y = pos[entry()];
    if (!y) return;
    var n = 0, stop = false;
    function cancel() { stop = true; }
    ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(function (e) { window.addEventListener(e, cancel, { once: true, passive: true }); });
    restoring = 1;
    (function go() {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (stop || max >= y || n++ > 60) {
        if (!stop) window.scrollTo(0, Math.min(y, Math.max(0, max)));
        restoring = 0;
        return;
      }
      requestAnimationFrame(go);
    })();
  }
  window.addEventListener('popstate', function () { requestAnimationFrame(giveBack); });
})();
`
