// --- The Hub's right panel: Files · Changes · Plan · File (#2101 R15, R17) ---
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
//   - Files (#2101 R17): what the selected run or chat touched, the files
//     its runs read, edited or wrote, the files it sent and the files the
//     owner attached (wall-files.ts), from the Task page's Files button or
//     the chat header's. Its source is the run or the chat, not a post:
//     { key, kind, label, href?, runs: [{ node, agent, task }], attached,
//     changes? }, read from each run's record (GET /api/task/history), so
//     nothing new is stored. A file in the list opens in its own tab
//     (kind wfile) with the run's own before and after. Files tabs are
//     listed first (#2226: the right tabs, files first).
//     Below them, the agent's workspace (GET /api/task/workspace, read
//     only, workspace-files-api.ts on the node): one folder at a time, a
//     file opening in its own tab (kind wsfile) as it is now. A changed
//     file's tab offers the same, when its path is in the workspace.
// More than one open: they are tabs in the panel, each with its ×. Closing
// the last one gives the width back to the main view.
//
// The chat's work line (#hc-work, under the agent strip): the open request
// the agent in view works on (it owns it, or owns its active plan step),
// newest first, with Changes when it has a forge home and Plan. One request,
// named, never a picker: the one of the question a Needs you row opened
// (ask=request:<id>, #2505), else the newest. The chat script asks for it through window.AXCtx.

import { HUB_NAME } from "../hub-name"
import { hubPanelGripHtml } from "./hub-panels"
import { injectFns } from "../inject"
import { afLoaderHtml } from "../affect.css"
import { chAgo, chDate, chReqMetaHtml } from "./wall-chat-head.client"
import { attachedOf, fileOpOf, filesTabHtml, mergeRunFiles, runFileHtml, runFilesOf, wflIcon, wflLoader, workspaceFileHtml, workspaceHtml, workspaceRel } from "./wall-files"

export const WALL_CONTEXT_SCRIPT = String.raw`
  // --- Right panel (#2101 R15) ---
  ${injectFns({ chAgo, chDate, chReqMetaHtml })}
  ${injectFns({ fileOpOf, runFilesOf, attachedOf, mergeRunFiles, wflIcon, wflLoader, filesTabHtml, runFileHtml, workspaceHtml, workspaceFileHtml, workspaceRel })}
  S.cx = { tabs: [], on: 0, painted: '', files: {}, src: {} };
  var CX_MAX = 6;
  var CX_NAME = { files: 'Files', wfile: 'File', wsfile: 'File', changes: 'Changes', plan: 'Plan', file: 'File' };
  /** A tab whose source is a run or a chat (S.cx.src), not a post. */
  function cxIsSrc(kind) { return kind === 'files' || kind === 'wfile' || kind === 'wsfile'; }
  function cxKey(t) { return t.kind + '\n' + t.id + '\n' + (t.path || ''); }
  function cxFind(kind, id, path) {
    for (var i = 0; i < S.cx.tabs.length; i++) { var t = S.cx.tabs[i]; if (t.kind === kind && t.id === id && (t.path || '') === (path || '')) return i; }
    return -1;
  }
  function cxActive() { return S.cx.tabs[S.cx.on] || null; }
  /** The post the Diff view acts on: the open Changes tab's, else the open post's. */
  function diffPostId() { var t = cxActive(); return t && t.kind === 'changes' ? t.id : S.post; }
  function cxOpen(kind, id, extra) {
    var p = cxIsSrc(kind) ? null : findPost(id);
    if (cxIsSrc(kind) ? !S.cx.src[id] : !p) return;
    var path = extra && extra.path || '';
    var i = cxFind(kind, id, path);
    if (i < 0) {
      var tab = { kind: kind, id: id, path: path, pr: extra && extra.pr || '' };
      // Files tabs go first, after the Files tabs already open.
      var at = S.cx.tabs.length;
      if (kind === 'files') { at = 0; while (at < S.cx.tabs.length && S.cx.tabs[at].kind === 'files') at++; }
      S.cx.tabs.splice(at, 0, tab);
      while (S.cx.tabs.length > CX_MAX) {
        // The oldest other tab goes.
        var g = S.cx.tabs[0] === tab ? 1 : 0, gone = S.cx.tabs.splice(g, 1)[0];
        if (gone.kind === 'changes') diffOf(gone.id).open = false;
      }
      i = S.cx.tabs.indexOf(tab);
    }
    S.cx.on = i;
    S.cx.painted = '';
    if (cxIsSrc(kind)) { cxPaint(); return; }
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
    var p = cxIsSrc(t.kind) ? null : findPost(t.id);
    if (t.kind === 'file' || t.kind === 'wfile' || t.kind === 'wsfile') return t.path.split('/').pop();
    return CX_NAME[t.kind] + (p && p.mergeRef && t.kind === 'changes' ? ' · ' + p.mergeRef : '');
  }
  function cxTabsHtml() {
    return S.cx.tabs.map(function (t, i) {
      var src = cxIsSrc(t.kind) ? S.cx.src[t.id] : null, p = src ? null : findPost(t.id), on = i === S.cx.on;
      var what = src ? src.label : p ? p.headline : '';
      return '<span class="wcx__tab' + (on ? ' is-on' : '') + '"><button type="button" role="tab" aria-selected="' + on + '" data-cx="tab" data-i="' + i + '" title="' + esc((t.path ? t.path + ' · ' : '') + what) + '">' +
        (t.kind === 'files' ? wflIcon('files') : '') +
        '<b>' + esc(CX_NAME[t.kind]) + '</b>' + (t.path ? ' ' + esc(cxTitle(t)) : what ? ' ' + esc(cxShort(what)) : '') + '</button>' +
        '<button type="button" class="wcx__x" data-cx="close" data-i="' + i + '" aria-label="Close ' + esc(CX_NAME[t.kind]) + '" title="Close ' + esc(CX_NAME[t.kind]) + '">' + wflIcon('x') + '</button></span>';
    }).join('');
  }
  function cxShort(s) { s = String(s || ''); return s.length > 28 ? s.slice(0, 27) + '…' : s; }
  function cxHeadHtml(p, t) {
    return '<div class="wcx__h"><a href="#post=' + encodeURIComponent(p.id) + '" title="Open the request">' + esc(p.headline) + '</a>' +
      (t.kind === 'file' ? '<code>' + esc(t.path) + '</code>' : '') + cxMetaHtml(p) + '</div>';
  }
  /** When it started, its last move, its project, its home and History (#2101). */
  function cxMetaHtml(p) {
    return chReqMetaHtml({ id: p.id, createdAt: p.createdAt, movedAt: p.lastMoveAt || p.updatedAt, project: p.project || null, repo: p.repo, home: p.home }, Date.now());
  }
  function cxPlanHtml(p) {
    var th = S.threads[p.id];
    if (!th || th.loading) return '${afLoaderHtml("Loading the plan…")}';
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
    if (!f || f.loading) return '${afLoaderHtml("Loading the file…")}';
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
    if (!n) { $('wcx-tabs').innerHTML = ''; $('wcx-body').innerHTML = ''; S.cx.painted = ''; cxPressed(); return; }
    $('wcx-tabs').innerHTML = cxTabsHtml();
    cxPressed();
    var t = cxActive(), k = cxKey(t);
    if (cxIsSrc(t.kind)) { S.cx.painted = k; $('wcx-body').innerHTML = cxSrcHtml(t); return; }
    var p = findPost(t.id);
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

  // --- Files: what a run or a chat touched (#2101 R17) ---
  /** The Task page's run, as a Files source. */
  function cxTaskSrc() {
    var t = S.task;
    if (!t) return null;
    var d = S.taskDetail, p = d && d.post ? findPost(d.post.id) || d.post : null;
    return {
      key: 'task:' + taskKey(t), kind: 'task', label: 'Run ' + t.task + ' · ' + nameOf(t.agent),
      href: wallTaskHref({ id: t.task, channel: t.ch }, t.agent, t.node, !!t.done),
      runs: [{ node: t.node, agent: t.agent, task: t.task }], attached: [], ws: { node: t.node, agent: t.agent },
      changes: p && p.mergeRef && findPost(p.id) ? { id: p.id, ref: p.mergeRef } : null,
    };
  }
  /** The source a Files button names: the Task page's run, or the chat in view. */
  function cxSrcOf(which) {
    if (which === 'task') return cxTaskSrc();
    var chat = window.AXHubChat;
    return which === 'chat' && chat && typeof chat.files === 'function' ? chat.files() : null;
  }
  /** Opens a source's Files tab; a second press while it is in view closes it. */
  function cxFiles(src) {
    if (!src || !src.key) return;
    var at = cxFind('files', src.key);
    if (at >= 0 && at === S.cx.on) { cxClose(at); return; }
    var had = S.cx.src[src.key];
    var wsAt = src.ws && src.ws.agent ? src.ws : null;
    S.cx.src[src.key] = { key: src.key, kind: src.kind, label: src.label || 'Files', href: src.href || '', runs: (src.runs || []).slice(-12), attached: src.attached || [], changes: src.changes || null,
      data: had && had.data, error: '', loading: false,
      ws: wsAt ? { node: wsAt.node || '', agent: wsAt.agent, dir: had && had.ws ? had.ws.dir : '', list: null, loading: false, error: '', files: had && had.ws ? had.ws.files : {} } : null };
    cxOpen('files', src.key);
    cxLoadSrc(src.key);
    if (wsAt) cxLoadDir(src.key, S.cx.src[src.key].ws.dir);
  }
  /** Reads each of the source's runs (GET /api/task/history) and adds their files up. */
  function cxLoadSrc(key) {
    var s = S.cx.src[key];
    if (!s || s.loading) return;
    s.loading = true; s.error = '';
    var why = '';
    var reads = s.runs.map(function (r) {
      return fetch('/api/task/history?node=' + encodeURIComponent(r.node || '') + '&agent=' + encodeURIComponent(r.agent) + '&task=' + encodeURIComponent(r.task) + '&live=1', { headers: headers() })
        .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { if (res.ok) return b; why = why || b.error || ('HTTP ' + res.status); return null; }); })
        .catch(function (e) { why = why || String(e && e.message || e); return null; });
    });
    Promise.all(reads).then(function (recs) {
      if (S.cx.src[key] !== s) return;
      var got = recs.filter(Boolean);
      s.loading = false;
      if (s.runs.length && !got.length) { s.error = why || 'no run record'; s.data = null; }
      else {
        var all = mergeRunFiles(got.map(function (rec) { return runFilesOf(rec.transcript || '', rec.responseText || ''); }));
        attachedOf(got.map(function (rec) { return rec.message || ''; })).concat(s.attached).forEach(function (a) { if (all.attached.indexOf(a) < 0) all.attached.push(a); });
        s.data = all;
      }
      // A run still going is read as far as it got (#2101 R17b): Reload reads more.
      s.live = got.some(function (rec) { return rec.live; });
      S.cx.painted = '';
      cxPaint();
    });
  }
  /** GET /api/task/workspace: one folder's list or one text file of the source's agent. */
  function cxWsGet(ws, path) {
    return fetch('/api/task/workspace?node=' + encodeURIComponent(ws.node) + '&agent=' + encodeURIComponent(ws.agent) + '&path=' + encodeURIComponent(path), { headers: headers() })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { if (!res.ok) throw new Error(b.error || ('HTTP ' + res.status)); return b; }); });
  }
  /** Reads a workspace folder into the Files tab. */
  function cxLoadDir(key, dir) {
    var s = S.cx.src[key], w = s && s.ws;
    if (!w) return;
    w.dir = dir || ''; w.list = null; w.error = ''; w.loading = true;
    var want = w.dir;
    cxWsGet(w, want).then(function (b) {
      if (S.cx.src[key] !== s || w.dir !== want) return;
      w.loading = false;
      if (b.kind === 'file') { w.error = 'not a folder'; }
      else w.list = { root: String(b.root || ''), entries: Array.isArray(b.entries) ? b.entries : [], more: !!b.more };
    }, function (e) {
      if (S.cx.src[key] !== s || w.dir !== want) return;
      w.loading = false; w.error = String(e && e.message || e);
    }).then(function () { S.cx.painted = ''; cxPaint(); });
  }
  /** Opens a workspace file in its own tab, read as it is now. */
  function cxOpenWsFile(key, path) {
    var s = S.cx.src[key], w = s && s.ws;
    if (!w || !path) return;
    var f = w.files[path] = { path: path, loading: true };
    cxOpen('wsfile', key, { path: path });
    cxWsGet(w, path).then(function (b) {
      if (b.kind !== 'file') throw new Error('not a file');
      f.loading = false; f.content = String(b.content || ''); f.size = b.size;
    }).catch(function (e) { f.loading = false; f.error = String(e && e.message || e); })
      .then(function () { if (w.files[path] === f) { S.cx.painted = ''; cxPaint(); } });
  }
  /** A Files or a file tab's body. */
  function cxSrcHtml(t) {
    var s = S.cx.src[t.id];
    if (!s) return '<p class="ax-wall__empty">Nothing to show here any more.</p>';
    var head = '<div class="wcx__h wcx__src">' + (s.href ? '<a href="' + esc(s.href) + '" title="Open it">' + esc(s.label) + '</a>' : '<b>' + esc(s.label) + '</b>') +
      (t.kind === 'files' ? '<button type="button" class="wcx__re" data-cx="freload" data-src="' + esc(s.key) + '"' + (s.loading ? ' disabled' : '') + '>Reload</button>' : '') + '</div>';
    if (t.kind === 'wsfile') return head + workspaceFileHtml(s.ws && s.ws.files[t.path]);
    if (!s.data && s.loading) return head + '${afLoaderHtml("Reading the runs…")}' + workspaceHtml(s.ws, s.key);
    if (!s.data) return head + '<p class="ax-wall__empty">Files not available: ' + esc(s.error || 'not read yet') + '.</p>' + workspaceHtml(s.ws, s.key);
    if (t.kind === 'wfile') {
      // The file as it is now, from the workspace, when the path is in it.
      var rel = s.ws && s.ws.list ? workspaceRel(t.path, s.ws.list.root) : null;
      var now = rel ? '<p class="wcx__now"><button type="button" class="wcx__re" data-cx="wsfile" data-src="' + esc(s.key) + '" data-path="' + esc(rel) + '">Open it as it is now</button></p>' : '';
      return head + now + runFileHtml(s.data.files.filter(function (f) { return f.path === t.path; })[0]);
    }
    var so = s.live ? '<p class="wcx__now">Still running: the files so far. Reload for more.</p>' : '';
    return head + so + filesTabHtml(s.data, { key: s.key, changes: s.changes }) + workspaceHtml(s.ws, s.key);
  }
  /** The Files buttons say whether their tab is open. */
  function cxPressed() {
    var on = {};
    S.cx.tabs.forEach(function (t) { if (t.kind === 'files') on[t.id] = true; });
    var b = S.taskMounted && S.task ? $('wtask-files') : null;
    if (b) b.setAttribute('aria-pressed', String(!!on['task:' + taskKey(S.task)]));
    var chat = window.AXHubChat, h = chat && typeof chat.files === 'function' ? $('hc-files') : null;
    if (h) { var c = chat.files(); h.setAttribute('aria-pressed', String(!!(c && on[c.key]))); }
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
    // A Needs you row opens on its question (#2505, ask=request:<id> in the
    // hash): Working on names that question's request. No select: one
    // request, named, as a link to its post; else the newest open one.
    // A question on no request (a draft, a card on no post): no work line,
    // never the newest request in its place (#2505 Q1).
    var ask = /[#&]ask=([^&]*)/.exec(location.hash || ''), askKey = '';
    try { askKey = ask ? decodeURIComponent(ask[1]) : ''; } catch (e) { askKey = ''; }
    var askId = askKey.indexOf('request:') === 0 ? askKey.slice(8) : '';
    var p = askKey
      ? (askId && list.filter(function (x) { return x.id === askId; })[0]) || (typeof decPostOf === 'function' ? decPostOf(askKey) : askId ? findPost(askId) : null)
      : list[0];
    if (!p) { w.hidden = true; w.innerHTML = ''; return; }
    var what = '<a href="#post=' + encodeURIComponent(p.id) + '" title="Open the request">' + esc(p.headline) + '</a>';
    var on = function (kind) { return cxFind(kind, p.id) >= 0 ? ' aria-pressed="true"' : ' aria-pressed="false"'; };
    w.innerHTML = '<span class="hc__worklbl">Working on</span>' + what +
      (p.mergeRef ? '<button type="button" class="hc__ib" data-cx="open" data-kind="changes" data-id="' + esc(p.id) + '"' + on('changes') + ' title="The changes in ' + esc(p.mergeRef) + '">Changes</button>' : '') +
      '<button type="button" class="hc__ib" data-cx="open" data-kind="plan" data-id="' + esc(p.id) + '"' + on('plan') + '>Plan</button>';
    w.hidden = false;
  }
  /** A request's place and times, for the chat's Plan tab (wall-chat-head.client.ts). */
  function cxPost(id) {
    var p = findPost(id);
    return p ? { project: p.project, repo: p.repo, home: p.home, createdAt: p.createdAt, lastMoveAt: p.lastMoveAt || p.updatedAt } : null;
  }
  /** What waits on the owner from this agent, oldest first: the Needs you
   *  row's own list (decAll, wall-decide.client.ts), put-off ones left out,
   *  so the chat lists the same questions the row counts (#2505). */
  function cxAsks(agent) {
    if (!agent || typeof decAll !== 'function') return [];
    return decAll().filter(function (o) { return o.agent === agent && !o.snoozed; })
      .sort(function (a, b) { return (a.at || 0) - (b.at || 0); })
      .map(function (o) { return { key: o.key, kind: o.kind, title: o.title, ask: o.ask, at: o.at }; });
  }
  window.AXCtx = { open: cxOpen, paintWork: cxPaintWork, post: cxPost, asks: cxAsks, files: function (src) { cxFiles(src); } };
  // Another Needs you row of the same agent: the work line follows its question (#2505).
  window.addEventListener('hashchange', function () { if (/[#&]ask=/.test(location.hash || '')) cxPaintWork(); });

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-cx]');
    if (!t) return;
    var what = t.getAttribute('data-cx'), i = +t.getAttribute('data-i');
    if (what === 'tab') { S.cx.on = i; S.cx.painted = ''; cxPaint(); return; }
    if (what === 'files') { cxFiles(cxSrcOf(t.getAttribute('data-src'))); return; }
    if (what === 'freload') { var rs = S.cx.src[t.getAttribute('data-src')]; if (rs) { rs.data = null; cxLoadSrc(rs.key); if (rs.ws) cxLoadDir(rs.key, rs.ws.dir); S.cx.painted = ''; cxPaint(); } return; }
    if (what === 'wsdir') { cxLoadDir(t.getAttribute('data-src'), t.getAttribute('data-path') || ''); S.cx.painted = ''; cxPaint(); return; }
    if (what === 'wsfile') { cxOpenWsFile(t.getAttribute('data-src'), t.getAttribute('data-path') || ''); return; }
    if (what === 'wfile') {
      var fs = S.cx.src[t.getAttribute('data-src')], f = fs && fs.data && fs.data.files[i];
      if (f) cxOpen('wfile', fs.key, { path: f.path });
      return;
    }
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
`

export const WALL_CONTEXT_CSS = `
/* The right panel (#2101 R15): only while a tab is open. */
.wcx { grid-column: 3; grid-row: 1 / span 4; position: sticky; top: 0; height: 100vh; min-width: 0; display: flex; flex-direction: column; background: var(--ax-bg); border-left: 1px solid var(--ax-border); }
.ax-wall.cx-open, .ax-wall.cx-open.is-wide, .ax-wall.cx-open.is-settings, .ax-wall.hc-open.cx-open { grid-template-columns: var(--axp-nav-w, 280px) minmax(0, 1fr) var(--axp-cx-w, minmax(380px, 42vw)); justify-content: stretch; }
.ax-wall.cx-open .ax-wall__aside { display: none !important; }
.wcx__tabs { flex: none; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; padding: 8px 8px 0; border-bottom: 1px solid var(--ax-border); }
.wcx__tabs::-webkit-scrollbar { display: none; }
.wcx__tab { flex: none; display: inline-flex; align-items: center; max-width: 240px; border: 1px solid transparent; border-bottom: 0; border-radius: var(--ax-radius-sm) var(--ax-radius-sm) 0 0; margin-bottom: -1px; }
.wcx__tab.is-on { background: var(--ax-bg); border-color: var(--ax-border); }
.wcx__tab > button[role="tab"] { all: unset; cursor: pointer; padding: 7px 4px 7px 10px; font-size: 13px; color: var(--ax-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.wcx__tab > button[role="tab"] b { font-weight: 600; color: var(--ax-text-2); }
.wcx__tab.is-on > button[role="tab"] b { color: var(--ax-text); }
.wcx__tab > button:focus-visible { box-shadow: inset var(--ax-focus-ring); }
.wcx__x { display: inline-flex; align-items: center; padding: 3px 6px 3px 2px; background: none; border: 0; color: var(--ax-muted); cursor: pointer; }
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
  .ax-wall.cx-open, .ax-wall.cx-open.is-wide, .ax-wall.cx-open.is-settings { grid-template-columns: 56px minmax(0, 600px); }
  .ax-wall.hc-open.cx-open { grid-template-columns: 56px minmax(0, 1fr); }
  .ax-wall.cx-open .ax-wall__aside { display: contents !important; }
  .wcx { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 92vw); height: auto; z-index: 12; box-shadow: var(--ax-shadow-lg); }
}
/* Phone: a full sheet over the page (no bottom bar since the Sheet menu). */
@media (max-width: 640px) {
  .ax-wall.cx-open, .ax-wall.cx-open.is-wide, .ax-wall.cx-open.is-settings, .ax-wall.hc-open.cx-open { grid-template-columns: minmax(0, 1fr); }
  .wcx { left: 0; width: auto; bottom: 0; box-shadow: none; border-left: 0; z-index: 30; }
  .wcx__body { padding: 10px 12px 12px; }
}
`

/** The panel itself, empty and hidden until a tab opens. */
export function wallContextHtml(): string {
  return `<aside class="wcx" id="wall-ctx" aria-label="Changes, plan and files" hidden>
    ${hubPanelGripHtml("cx")}
    <div class="wcx__tabs" id="wcx-tabs" role="tablist" aria-label="Open in the panel"></div>
    <div class="wcx__body" id="wcx-body" role="tabpanel"></div>
  </aside>`
}
