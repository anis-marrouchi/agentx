// --- The Hub's simple and full layouts, in the current Hub (#2226 S1) ---
//
// The keys and what they mean are in src/hub/layout.ts, shared with the
// React app. This file is the current Hub's side:
//
//   - hubLayoutBoot(): the view for this load, as window.AX_HUB_LAYOUT, and
//     the hidden items on <html data-hub-hide="…"> before the page paints.
//   - HUB_LAYOUT_CSS: one rule per item, so hiding is CSS only. Nothing is
//     taken out of the page and nothing stops: a hidden page still opens from
//     a link, and the Desk ("Waiting on you") keeps every owner gate.
//   - HUB_LAYOUT_SCRIPT: hlApply() to show or hide at once, hlNavHidden()
//     for the ⌘K switcher, and Settings › Layout, its switches saved to
//     POST /api/admin/wall/settings/hub-layout (admin-panel.ts). The page
//     applies the answer at once: no reload, no restart.

import { HUB_NAME } from "../hub-name"
import { HUB_SHOW_ITEMS, hubHiddenItems, hubLayoutSetting, type HubLayoutView, type HubShowItem } from "../../../hub/layout"

/** The nav keys (data-nav) each item hides, in the side menu, ⌘K and the
 *  phone's More sheet. `dash-*` are the classic pages' ⌘K entries. */
export const HUB_NAV_ITEM: Record<string, HubShowItem> = {
  mobile: "mobile",
  workflows: "workflows", "dash-workflows": "workflows",
  activity: "activity", "dash-activity": "activity",
  org: "org", "dash-org": "org",
  live: "sessions",
  cost: "usage",
}

/** What else each item hides, besides its nav keys. Wiki and Rules have no
 *  place in this Hub yet; the React app reads their switches. */
const HUB_HIDE_EXTRA: Partial<Record<HubShowItem, string[]>> = {
  // A post's steps and its plan: the parts wall.client.ts marks with
  // data-hub-item="gates" (progressHtml, planHtml). Never the owner's
  // decision card on a post nor the Desk (#wall-decide): a gate that waits
  // on the owner is answered there.
  gates: ['[data-hub-item="gates"]'],
  // The machines this Hub reads, in the status bar (hub-status.ts).
  hosts: ["#hs-node"],
}

/** The CSS selectors one item hides. */
export function hubHideSelectors(item: HubShowItem): string[] {
  const nav = Object.keys(HUB_NAV_ITEM).filter((k) => HUB_NAV_ITEM[k] === item).map((k) => `[data-nav="${k}"]`)
  return [...nav, ...(HUB_HIDE_EXTRA[item] ?? [])]
}

export const HUB_LAYOUT_CSS = "\n/* Simple and full layouts (#2226 S1, hub-layout.ts): hidden, still running. */\n" +
  HUB_SHOW_ITEMS.map(({ id }) => {
    const sels = hubHideSelectors(id)
    return sels.length ? `${sels.map((s) => `html[data-hub-hide~="${id}"] ${s}`).join(", ")} { display: none !important; }` : ""
  }).filter(Boolean).join("\n") + `
.whl { margin-top: 4px; }
.whl .wsa:hover { background: none; }
.whl .wsa__b small { white-space: normal; }
.whl__seg { display: inline-flex; flex: none; padding: 2px; gap: 2px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); }
.whl__seg button { font: inherit; font-size: var(--ax-fs-sm); font-weight: 600; color: var(--ax-muted); background: none; border: 0; border-radius: var(--ax-radius-sm); padding: 4px 12px; cursor: pointer; }
.whl__seg button[aria-checked="true"] { color: var(--ax-text); background: var(--ax-bg); box-shadow: 0 0 0 1px var(--ax-border); }
.whl__seg button:focus-visible, .whl__own:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; }
.whl__own { flex: none; font: inherit; font-size: var(--ax-fs-xs); color: var(--ax-muted); background: none; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); padding: 2px 8px; cursor: pointer; }
.whl__own:hover { color: var(--ax-text); }
`

/** JSON safe inside a <script>. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c")

/** The <head> script: this load's view, and the hidden items set on <html>
 *  before the body paints, so a hidden item never flashes in. */
export function hubLayoutBoot(view: HubLayoutView): string {
  const hide = hubHiddenItems(view).join(" ")
  return `<script>window.AX_HUB_LAYOUT = ${scriptJson({ ...view, setting: hubLayoutSetting(view) })};document.documentElement.setAttribute("data-hub-hide", ${scriptJson(hide)});</script>`
}

/** Spliced into WALL_PAGE_SCRIPT's closure (after Settings): uses S, $,
 *  esc, act, stNoteHtml, stNote and stPaint. */
export const HUB_LAYOUT_SCRIPT = String.raw`
  // --- Simple and full layouts (#2226 S1, hub-layout.ts) ---
  var HL_ITEMS = ${scriptJson(HUB_SHOW_ITEMS)};
  var HL_NAV = ${scriptJson(HUB_NAV_ITEM)};
  var HL = { view: window.AX_HUB_LAYOUT || null };
  /** Is this item hidden now? No view (an old page): nothing is. */
  function hlHidden(item) { return !!(HL.view && HL.view.show && HL.view.show[item] === false); }
  /** Is this nav key (data-nav) hidden by the layout? */
  function hlNavHidden(key) { return !!HL_NAV[key] && hlHidden(HL_NAV[key]); }
  /** Shows and hides at once, from a view the server resolved. */
  function hlApply(view) {
    if (!view || !view.show) return;
    HL.view = view;
    window.AX_HUB_LAYOUT = view;
    var hide = HL_ITEMS.map(function (i) { return i.id; }).filter(hlHidden).join(' ');
    if (document.documentElement) document.documentElement.setAttribute('data-hub-hide', hide);
  }

  // --- Settings › Layout ---
  function stLayoutHtml() {
    var v = (S.st.data && S.st.data.hubLayout) || HL.view || { layout: 'simple', show: {}, overrides: [] };
    var own = v.overrides || [];
    // A radio group: one tab stop (the chosen one), arrow keys move the choice.
    var seg = function (id, name) {
      return '<button type="button" role="radio" aria-checked="' + (v.layout === id) + '" data-hl-layout="' + id + '" tabindex="' + (v.layout === id ? '0' : '-1') + '">' + name + '</button>';
    };
    var row = function (title, line, end) {
      return '<div class="wsa"><div class="wsa__b"><b>' + title + '</b><small>' + line + '</small></div>' + end + '</div>';
    };
    return '<header class="wst__h"><h2>Layout</h2><p>What the ${HUB_NAME} shows. Hidden items keep running.</p></header>' +
      '<div class="wsa-list whl">' +
        row('Layout', 'Simple shows agents, chat, Waiting on you, Jobs and Settings. Full shows everything.',
          '<div class="whl__seg" role="radiogroup" aria-label="Layout">' + seg('simple', 'Simple') + seg('full', 'Full') + '</div>') +
        HL_ITEMS.map(function (i) {
          var on = !!(v.show && v.show[i.id]);
          var mine = own.indexOf(i.id) >= 0;
          return row(esc(i.label), esc(i.hint),
            (mine ? '<button type="button" class="whl__own" data-st-act="hl-reset" data-hl-item="' + esc(i.id) + '" title="Use the layout\'s default">Reset</button>' : '') +
            '<button type="button" class="wsa__sw" role="switch" aria-checked="' + on + '" data-hl-item="' + esc(i.id) + '">' +
            '<i aria-hidden="true"></i><span>' + (on ? 'On' : 'Off') + '</span><span class="wst__sr"> ' + esc(i.label) + '</span></button>');
        }).join('') +
      '</div>' + stNoteHtml('hl') + (HL.failed ? '<button type="button" class="whl__own" data-st-act="hl-retry">Retry</button>' : '');
  }
  async function stLayoutSave(body) {
    HL.last = body;
    stNote('hl', '', 'Saving…');
    var r = await act('POST', '/api/admin/wall/settings/hub-layout', body);
    if (!r.ok) { HL.failed = true; stNote('hl', 'err', 'Not saved: ' + r.error); stPaint(); return; }
    HL.failed = false;
    var view = r.body && r.body.layout;
    hlApply(view);
    if (S.st.data && view) S.st.data.hubLayout = view;
    stNote('hl', 'ok', 'Saved.');
    stPaint();
  }
  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings' || !ev.target || !ev.target.closest) return;
    var t = ev.target.closest('[data-hl-layout],[data-hl-item],[data-st-act]');
    if (!t) return;
    var kind = t.getAttribute('data-st-act');
    if (!t.getAttribute('data-hl-layout') && !t.getAttribute('data-hl-item') && kind !== 'hl-retry') return;
    if (ev.preventDefault) ev.preventDefault();
    if (kind === 'hl-retry') { if (HL.last) stLayoutSave(HL.last); return; }
    var layout = t.getAttribute('data-hl-layout');
    if (layout) { if (t.getAttribute('aria-checked') !== 'true') stLayoutSave({ layout: layout }); return; }
    var item = t.getAttribute('data-hl-item');
    var show = {};
    show[item] = kind === 'hl-reset' ? null : t.getAttribute('aria-checked') !== 'true';
    stLayoutSave({ show: show });
  });
  /** Simple | Full by keyboard, as a radio group (#2226 S1 review): Left and
   *  Up go back, Right and Down go on, Home and End go to the ends. The new
   *  choice takes the focus and is saved as a click saves it. */
  var HL_LAYOUTS = ['simple', 'full'];
  function hlLayoutKey(ev) {
    if (S.page !== 'settings' || !ev || !ev.target || typeof ev.target.getAttribute !== 'function') return;
    var t = ev.target;
    var cur = t.getAttribute('data-hl-layout');
    var i = HL_LAYOUTS.indexOf(cur);
    if (i < 0) return;
    var n = HL_LAYOUTS.length;
    var k = ev.key;
    var next = k === 'ArrowRight' || k === 'ArrowDown' ? (i + 1) % n
      : k === 'ArrowLeft' || k === 'ArrowUp' ? (i + n - 1) % n
      : k === 'Home' ? 0 : k === 'End' ? n - 1 : -1;
    if (next < 0) return;
    if (ev.preventDefault) ev.preventDefault();
    var id = HL_LAYOUTS[next];
    var group = t.closest ? t.closest('[role="radiogroup"]') : null;
    var to = group && group.querySelector ? group.querySelector('[data-hl-layout="' + id + '"]') : null;
    if (to) {
      // Roving tabindex: the focused radio is the one tab stop.
      if (to !== t) { t.setAttribute('tabindex', '-1'); to.setAttribute('tabindex', '0'); }
      if (typeof to.focus === 'function') to.focus();
    }
    if (id === cur && t.getAttribute('aria-checked') === 'true') return;
    stLayoutSave({ layout: id });
  }
  document.addEventListener('keydown', hlLayoutKey);
`
