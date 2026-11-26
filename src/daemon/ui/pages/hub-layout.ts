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
  // A post's steps and its plan (wall.client.ts progressHtml, planHtml).
  // Never the owner's decision card on a post (.wtk .wc, cardHtml) nor the
  // Desk (#wall-decide): a gate that waits on the owner is answered there.
  gates: [".wtk__prog", ".wtk__sec[aria-label=\"Plan\"]"],
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
.whl__opts { display: grid; gap: 8px; margin: 4px 0 0; }
.whl__opt { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); cursor: pointer; }
.whl__opt:has(input:checked) { border-color: var(--ax-accent); background: var(--ax-surface-2); }
.whl__opt b { display: block; }
.whl__opt span { color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.whl__item { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px solid var(--ax-border); }
.whl__item:first-of-type { border-top: 0; }
.whl__item input { margin-top: 3px; }
.whl__item p { margin: 2px 0 0; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.whl__own { margin-left: 6px; font: inherit; font-size: var(--ax-fs-xs); background: none; border: 0; padding: 0; color: var(--ax-accent); cursor: pointer; text-decoration: underline; }
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
    var opt = function (id, name, line) {
      return '<label class="whl__opt"><input type="radio" name="st-hl-layout" data-hl-layout="' + id + '"' + (v.layout === id ? ' checked' : '') + '>' +
        '<div><b>' + name + '</b><span>' + line + '</span></div></label>';
    };
    return '<header class="wst__h"><h2>Layout</h2><p>What the ${HUB_NAME} shows. Hidden items keep running: schedules, gates and workflows still run, and a gate that waits on you is still in Waiting on you. A change shows at once, with no restart.</p></header>' +
      '<section class="wsc"><h3>Layout</h3><div class="whl__opts" role="radiogroup" aria-label="Layout">' +
        opt('simple', 'Simple', 'The bare minimum: agents, chat, Waiting on you, Jobs and Settings. The default.') +
        opt('full', 'Full', 'Everything: workflows, plan gates and request steps, the mobile page, the hosts in the status bar, and every page in ⌘K.') +
      '</div><p class="wsj__sub">Picking a layout sets every switch below to that layout\'s default.</p></section>' +
      '<section class="wsc"><h3>Shown in the ${HUB_NAME}</h3>' +
        HL_ITEMS.map(function (i) {
          var mine = own.indexOf(i.id) >= 0;
          return '<label class="whl__item"><input type="checkbox" data-hl-item="' + esc(i.id) + '"' + (v.show && v.show[i.id] ? ' checked' : '') + '>' +
            '<div><b>' + esc(i.label) + '</b>' + (mine ? '<button type="button" class="whl__own" data-st-act="hl-reset" data-hl-item="' + esc(i.id) + '">As the layout</button>' : '') +
            '<p>' + esc(i.hint) + '</p></div></label>';
        }).join('') +
      '</section>' + stNoteHtml('hl');
  }
  async function stLayoutSave(body) {
    stNote('hl', '', 'Saving…');
    var r = await act('POST', '/api/admin/wall/settings/hub-layout', body);
    if (!r.ok) { stNote('hl', 'err', 'Not saved: ' + r.error); return; }
    var view = r.body && r.body.layout;
    hlApply(view);
    if (S.st.data && view) S.st.data.hubLayout = view;
    S.st.notes.hl = { kind: 'ok', text: 'Saved. The ${HUB_NAME} shows it now; no restart needed.' };
    stPaint();
  }
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (S.page !== 'settings' || !t || !t.getAttribute) return;
    var layout = t.getAttribute('data-hl-layout');
    if (layout) { if (t.checked) stLayoutSave({ layout: layout }); return; }
    var item = t.getAttribute('data-hl-item');
    if (item) { var show = {}; show[item] = !!t.checked; stLayoutSave({ show: show }); }
  });
  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings' || !ev.target || !ev.target.closest) return;
    var t = ev.target.closest('[data-st-act]');
    if (!t || t.getAttribute('data-st-act') !== 'hl-reset') return;
    if (ev.preventDefault) ev.preventDefault();
    var show = {}; show[t.getAttribute('data-hl-item')] = null;
    stLayoutSave({ show: show });
  });
`
