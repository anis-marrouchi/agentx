// --- The Hub's right panel: Changes · Plan · File (#2101 R15) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure after WALL_DIFF_SCRIPT, so it uses
// that script's S, $, esc(), findPost(), isOpen(), planHtml(), loadThread(),
// headers() and the Diff view's diffOf(), diffInner(), diffLoad().
//
// No fixed third column: the right side opens only when something in the
// main view calls for it, and the main view takes the full width
// otherwise, as in Orca.
//   - Changes: the Diff view of a post's pull or merge request (#2102),
//     from the post's Diff button or the chat's work line. Line comments
//     work as they did under the post.
//   - Plan: the request's plan steps (the post's thread read), from the
//     chat's work line.
//   - File: one file the PR changes, whole, at the PR's head, with the
//     lines it adds marked (GET /api/admin/wall/diff-file), from a file's
//     File button in Changes.
// More than one open: they are tabs in the panel, each with its ×. Closing
// the last one gives the width back to the main view.
//
// The chat's work line (#hc-work, under the agent strip): the open request
// the agent in view works on (it owns it, or owns its active plan step),
// newest first, with Changes when it has a forge home and Plan. With more
// than one, a picker. The chat script asks for it through window.AXCtx.

import { HUB_NAME } from "../hub-name"
import { injectFns } from "../inject"
import { chAgo, chDate, chReqMetaHtml } from "./wall-chat-head.client"

export const WALL_CONTEXT_SCRIPT = String.raw`
  // --- Right panel (#2101 R15) ---
  ${injectFns({ chAgo, chDate, chReqMetaHtml })}
  S.cx = { tabs: [], on: 0, painted: '', files: {}, pick: {} };
  var CX_MAX = 6;
  var CX_NAME = { changes: 'Changes', plan: 'Plan', file: 'File' };
  function cxKey(t) { return t.kind + '\n' + t.id + '\n' + (t.path || ''); }
  function cxFind(kind, id, path) {
    for (var i = 0; i < S.cx.tabs.length; i++) { var t = S.cx.tabs[i]; if (t.kind === kind && t.id === id && (t.path || '') === (path || '')) return i; }
    return -1;
  }
  function cxActive() { return S.cx.tabs[S.cx.on] || null; }
  /** The post the Diff view acts on: the open Changes tab's, else the open post's. */
  function diffPostId() { var t = cxActive(); return t && t.kind === 'changes' ? t.id : S.post; }
  function cxOpen(kind, id, extra) {
    var p = findPost(id);
    if (!p) return;
    var path = extra && extra.path || '';
    var i = cxFind(kind, id, path);
    if (i < 0) {
      S.cx.tabs.push({ kind: kind, id: id, path: path, pr: extra && extra.pr || '' });
      while (S.cx.tabs.length > CX_MAX) { var gone = S.cx.tabs.shift(); if (gone.kind === 'changes') diffOf(gone.id).open = false; }
      i = cxFind(kind, id, path);
    }
    S.cx.on = i;
    S.cx.painted = '';
    if (kind === 'changes') {
      var d = diffOf(id);
      d.open = true;
      cxPaint();
      // With drafts, the PR they were written on, whatever comes first now.
      if (!d.data && !d.loading) diffLoad(p, d.at && d.at.ref);
      else paintDiff();
      return;
    }
    if (kind === 'plan' && !S.threads[id]) { cxPaint(); loadThread(id); return; }
    if (kind === 'file') cxLoadFile(S.cx.tabs[i]);
    cxPaint();
  }
  function cxClose(i) {
    var t = S.cx.tabs[i];
    if (!t) return;
    if (t.kind === 'changes') diffOf(t.id).open = false;
    S.cx.tabs.splice(i, 1);
    if (S.cx.on >= S.cx.tabs.length) S.cx.on = Math.max(0, S.cx.tabs.length - 1);
    else if (i < S.cx.on) S.cx.on--;
    S.cx.painted = '';
    cxPaint();
    paintDiffButton();
  }
  /** The post's Diff button, opened or not. */
  function paintDiffButton() {
    var p = findPost(S.post), b = document.querySelector && document.querySelector('[data-wdf="toggle"]');
    if (p && b) b.outerHTML = diffButtonHtml(p);
  }
  function cxTitle(t) {
    var p = findPost(t.id);
    if (t.kind === 'file') return t.path.split('/').pop();
    return CX_NAME[t.kind] + (p && p.mergeRef && t.kind === 'changes' ? ' · ' + p.mergeRef : '');
  }
  function cxTabsHtml() {
    return S.cx.tabs.map(function (t, i) {
      var p = findPost(t.id), on = i === S.cx.on;
      return '<span class="wcx__tab' + (on ? ' is-on' : '') + '"><button type="button" role="tab" aria-selected="' + on + '" data-cx="tab" data-i="' + i + '" title="' + esc((t.path ? t.path + ' · ' : '') + (p ? p.headline : '')) + '">' +
        '<b>' + esc(t.kind === 'file' ? 'File' : CX_NAME[t.kind]) + '</b>' + (t.kind === 'file' ? ' ' + esc(cxTitle(t)) : p ? ' ' + esc(cxShort(p.headline)) : '') + '</button>' +
        '<button type="button" class="wcx__x" data-cx="close" data-i="' + i + '" aria-label="Close ' + esc(CX_NAME[t.kind]) + '">×</button></span>';
    }).join('');
  }
  function cxShort(s) { s = String(s || ''); return s.length > 28 ? s.slice(0, 27) + '…' : s; }
  function cxHeadHtml(p, t) {
    return '<div class="wcx__h"><a href="#post=' + encodeURIComponent(p.id) + '" title="Open the request">' + esc(p.headline) + '</a>' +
      (t.kind === 'file' ? '<code>' + esc(t.path) + '</code>' : '') + cxMetaHtml(p) + '</div>';
  }
  /** When it started, its last move, its project, its home and History (#2101). */
  function cxMetaHtml(p) {
    return chReqMetaHtml({ id: p.id, createdAt: p.createdAt, movedAt: p.lastMoveAt || p.updatedAt, project: p.project, home: p.home }, Date.now());
  }
  function cxPlanHtml(p) {
    var th = S.threads[p.id];
    if (!th || th.loading) return '<p class="ax-wall__empty">Loading the plan…</p>';
    if (th.error) return '<p class="ax-wall__empty">Plan not available: ' + esc(th.error) + '</p>';
    if (!th.plan || !th.plan.length) return '<p class="ax-wall__empty">This request has no plan steps.' + (p.mergeRef ? ' Its changes are under Changes.' : '') + '</p>';
    return planHtml(th.plan);
  }
  function cxLoadFile(t) {
    var k = cxKey(t), f = S.cx.files[k];
    if (f && (f.loading || f.data)) return;
    var p = findPost(t.id);
    if (!p) return;
    S.cx.files[k] = { loading: true };
    fetch('/api/admin/wall/diff-file?id=' + encodeURIComponent(t.id) + '&path=' + encodeURIComponent(t.path) + (t.pr ? '&pr=' + encodeURIComponent(t.pr) : ''), { headers: headers(p.node && p.node.peer) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { S.cx.files[k] = r.ok ? { data: b } : { error: b.error || ('HTTP ' + r.status) }; }); })
      .catch(function (e) { S.cx.files[k] = { error: String(e && e.message || e) }; })
      .then(function () { S.cx.painted = ''; cxPaint(); });
  }
  function cxFileHtml(t) {
    var f = S.cx.files[cxKey(t)];
    if (!f || f.loading) return '<p class="ax-wall__empty">Loading the file…</p>';
    if (f.error) return '<p class="ax-wall__empty">File not available: ' + esc(f.error) + '</p>';
    var d = f.data;
    if (d.status === 'removed') return '<p class="ax-wall__empty">' + esc(d.ref) + ' removes this file.</p>';
    if (d.status === 'binary') return '<p class="ax-wall__empty">Binary file: not shown.</p>';
    var changed = {};
    (d.changed || []).forEach(function (n) { changed[n] = true; });
    var rows = (d.lines || []).map(function (l, i) {
      var n = i + 1;
      return '<tr' + (changed[n] ? ' class="is-add"' : '') + '><td class="wdf__n">' + n + '</td><td class="wdf__c">' + esc(l) + '</td></tr>';
    }).join('');
    return '<p class="wcx__at">' + esc(d.ref) + (d.headSha ? ' at <span class="wdf__sha">' + esc(String(d.headSha).slice(0, 12)) + '</span>' : '') +
      ' · ' + (d.changed || []).length + ' lines added or changed</p>' +
      '<div class="wdf__w"><table class="wdf__t wcx__file"><tbody>' + rows + '</tbody></table></div>' +
      (d.truncated ? '<p class="wdf__cut">The file is long: only its first lines are shown.</p>' : '');
  }
  /** Draws the panel. The body is drawn again only when its tab changed,
   *  or for Plan and File, and never over a line comment being typed. */
  function cxPaint() {
    var box = $('wall-ctx'), n = S.cx.tabs.length;
    document.querySelector('.ax-wall').classList.toggle('cx-open', n > 0);
    box.hidden = !n;
    if (!n) { $('wcx-tabs').innerHTML = ''; $('wcx-body').innerHTML = ''; S.cx.painted = ''; return; }
    $('wcx-tabs').innerHTML = cxTabsHtml();
    var t = cxActive(), p = findPost(t.id), k = cxKey(t);
    if (t.kind === 'changes' && (S.cx.painted === k || diffTyping())) return;
    S.cx.painted = k;
    if (!p) { $('wcx-body').innerHTML = '<p class="ax-wall__empty">This request is not on the ${HUB_NAME} any more.</p>'; return; }
    if (t.kind === 'changes') {
      $('wcx-body').innerHTML = cxHeadHtml(p, t) + '<div id="wdf"></div>';
      paintDiff();
    } else if (t.kind === 'plan') {
      $('wcx-body').innerHTML = cxHeadHtml(p, t) + cxPlanHtml(p);
    } else {
      $('wcx-body').innerHTML = cxHeadHtml(p, t) + cxFileHtml(t);
    }
  }

  // --- The chat's work line ---
  /** The open requests an agent works on, newest first. */
  function cxWorkOf(agent) {
    if (!agent || !S.data) return [];
    return (S.data.posts || []).filter(function (p) { return isOpen(p) && (p.owner === agent || p.stepAgent === agent); })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, 8);
  }
  function cxPaintWork() {
    var chat = window.AXHubChat;
    if (!chat || typeof chat.agent !== 'function') return;
    var w = $('hc-work');
    if (!w) return;
    var agent = chat.agent(), list = cxWorkOf(agent);
    if (!list.length) { w.hidden = true; w.innerHTML = ''; return; }
    var id = S.cx.pick[agent], p = list.filter(function (x) { return x.id === id; })[0] || list[0];
    var what = list.length > 1
      ? '<select data-cx="pick" aria-label="The request in view">' + list.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === p.id ? ' selected' : '') + '>' + esc(x.headline) + (x.project ? ' · ' + esc(x.project) : '') + ' · ' + esc(chAgo(x.lastMoveAt || x.updatedAt, Date.now())) + '</option>'; }).join('') + '</select>'
      : '<a href="#post=' + encodeURIComponent(p.id) + '" title="Open the request">' + esc(p.headline) + '</a>';
    var on = function (kind) { return cxFind(kind, p.id) >= 0 ? ' aria-pressed="true"' : ' aria-pressed="false"'; };
    w.innerHTML = '<span class="hc__worklbl">Working on</span>' + what +
      (p.mergeRef ? '<button type="button" class="hc__ib" data-cx="open" data-kind="changes" data-id="' + esc(p.id) + '"' + on('changes') + ' title="The changes in ' + esc(p.mergeRef) + '">Changes</button>' : '') +
      '<button type="button" class="hc__ib" data-cx="open" data-kind="plan" data-id="' + esc(p.id) + '"' + on('plan') + '>Plan</button>';
    w.hidden = false;
  }
  /** A request's place and times, for the chat's Plan tab (wall-chat-head.client.ts). */
  function cxPost(id) {
    var p = findPost(id);
    return p ? { project: p.project, home: p.home, createdAt: p.createdAt, lastMoveAt: p.lastMoveAt || p.updatedAt } : null;
  }
  window.AXCtx = { open: cxOpen, paintWork: cxPaintWork, post: cxPost };

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-cx]');
    if (!t) return;
    var what = t.getAttribute('data-cx'), i = +t.getAttribute('data-i');
    if (what === 'tab') { S.cx.on = i; S.cx.painted = ''; cxPaint(); return; }
    if (what === 'close') { cxClose(i); cxPaintWork(); return; }
    if (what === 'open') {
      var kind = t.getAttribute('data-kind'), id = t.getAttribute('data-id'), at = cxFind(kind, id);
      // A second press on an open one closes it, as the post's Diff does.
      if (at >= 0 && at === S.cx.on) cxClose(at); else cxOpen(kind, id);
      cxPaintWork();
      return;
    }
    if (what === 'file') {
      var did = diffPostId(), d = did && diffOf(did);
      cxOpen('file', did, { path: t.getAttribute('data-path'), pr: d && d.data && d.data.ref || '' });
    }
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute || t.getAttribute('data-cx') !== 'pick') return;
    var chat = window.AXHubChat;
    if (chat && chat.agent) S.cx.pick[chat.agent()] = t.value;
    cxPaintWork();
  });
`

export const WALL_CONTEXT_CSS = `
/* The right panel (#2101 R15): only while a tab is open. */
.wcx { grid-column: 3; grid-row: 1 / span 4; position: sticky; top: 0; height: 100vh; min-width: 0; display: flex; flex-direction: column; background: var(--ax-bg); border-left: 1px solid var(--ax-border); }
.ax-wall.cx-open, .ax-wall.cx-open.is-wide, .ax-wall.cx-open.is-settings, .ax-wall.hc-open.cx-open { grid-template-columns: 280px minmax(0, 1fr) minmax(380px, 42vw); justify-content: stretch; }
.ax-wall.cx-open .ax-wall__aside { display: none !important; }
.wcx__tabs { flex: none; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; padding: 8px 8px 0; border-bottom: 1px solid var(--ax-border); }
.wcx__tabs::-webkit-scrollbar { display: none; }
.wcx__tab { flex: none; display: inline-flex; align-items: center; max-width: 240px; border: 1px solid transparent; border-bottom: 0; border-radius: var(--ax-radius-sm) var(--ax-radius-sm) 0 0; margin-bottom: -1px; }
.wcx__tab.is-on { background: var(--ax-bg); border-color: var(--ax-border); }
.wcx__tab > button[role="tab"] { all: unset; cursor: pointer; padding: 7px 4px 7px 10px; font-size: 13px; color: var(--ax-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.wcx__tab > button[role="tab"] b { font-weight: 600; color: var(--ax-text-2); }
.wcx__tab.is-on > button[role="tab"] b { color: var(--ax-text); }
.wcx__tab > button:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: -2px; }
.wcx__x { font: inherit; font-size: 16px; line-height: 1; padding: 2px 8px 4px 4px; background: none; border: 0; color: var(--ax-muted); cursor: pointer; }
.wcx__x:hover { color: var(--ax-text); }
.wcx__body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px 16px; }
.wcx__body #wdf > .wdf { margin-top: 0; padding-top: 0; border-top: 0; }
.wcx__body #wdf .wdf > .wp__th { margin-top: 0; padding-top: 0; border-top: 0; }
.wcx__h { display: flex; flex-direction: column; gap: 2px; margin: 0 0 10px; font-size: 13px; }
.wcx__h a { font-weight: 600; color: var(--ax-text); text-decoration: none; }
.wcx__h a:hover { color: var(--ax-accent); }
.wcx__h code { font-family: var(--ax-mono); font-size: 12px; color: var(--ax-muted); overflow-wrap: anywhere; }
.wcx__at { margin: 0 0 8px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wcx__file tr.is-add { background: color-mix(in srgb, var(--ax-green) 12%, transparent); }
.wdf__fhr { display: flex; align-items: stretch; background: var(--ax-surface-2); }
.wdf__fhr .wdf__fh { flex: 1; min-width: 0; }
.wdf__open { font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-accent); background: none; border: 0; border-left: 1px solid var(--ax-border); padding: 0 10px; cursor: pointer; }
.wdf__open:hover { background: var(--ax-surface-3); }
/* The chat's work line: the request the agent in view works on. */
.hc__work { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--ax-border); font-size: 13px; min-width: 0; }
.hc__work[hidden] { display: none; }
.hc__worklbl { flex: none; color: var(--ax-muted); }
.hc__work > a, .hc__work > select { flex: 1; min-width: 0; font: inherit; font-size: 13px; font-weight: 600; color: var(--ax-text); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hc__work > select { background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 3px 10px; }
.hc__work .hc__ib { flex: none; }
.hc__work .hc__ib[aria-pressed="true"] { background: var(--ax-blue-t); border-color: var(--ax-accent); color: var(--ax-accent); }

/* Under 1180 px the panel slides over the page from the right. */
@media (max-width: 1180px) {
  .ax-wall.cx-open, .ax-wall.cx-open.is-wide, .ax-wall.cx-open.is-settings { grid-template-columns: 72px minmax(0, 600px); }
  .ax-wall.hc-open.cx-open { grid-template-columns: 72px minmax(0, 1fr); }
  .ax-wall.cx-open .ax-wall__aside { display: contents !important; }
  .wcx { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 92vw); height: auto; z-index: 12; box-shadow: -8px 0 24px rgb(0 0 0 / 22%); }
}
/* Phone: a full sheet over the page, above the bottom bar. */
@media (max-width: 640px) {
  .ax-wall.cx-open, .ax-wall.cx-open.is-wide, .ax-wall.cx-open.is-settings, .ax-wall.hc-open.cx-open { grid-template-columns: minmax(0, 1fr); }
  .wcx { left: 0; width: auto; bottom: 56px; box-shadow: none; border-left: 0; z-index: 30; }
  /* The chat has no bottom bar: the panel covers its ask box too. */
  .ax-wall.hc-open .wcx { bottom: 0; }
  .wcx__body { padding: 10px 12px 12px; }
}
`

/** The panel itself, empty and hidden until a tab opens. */
export function wallContextHtml(): string {
  return `<aside class="wcx" id="wall-ctx" aria-label="Changes, plan and files" hidden>
    <div class="wcx__tabs" id="wcx-tabs" role="tablist" aria-label="Open in the panel"></div>
    <div class="wcx__body" id="wcx-body" role="tabpanel"></div>
  </aside>`
}
