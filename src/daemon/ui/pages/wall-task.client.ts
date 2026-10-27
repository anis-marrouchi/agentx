// --- Wall v2 Task page, browser side (#1381) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), avatar(), nameOf(), headers(), progressHtml(), planHtml(),
// factsHtml(), plainPost() and plainMarkerText().
//
// The classic task page (task.ts) on the Wall: one run, at its own link
// (#page=task&task=<id>&agent=<id>&node=<url>). On top, the request and,
// when the run belongs to a tracked request, its status strip, plan and
// facts as in #1377. Under it, the run's conversation, streaming live
// (GET /api/task/stream), or the stored record of a finished run. Last, a
// steer box: a message goes in as the next turn (POST /api/task/action
// kind=followup), and Stop cancels the turn (kind=cancel). The stream,
// steer box and Stop are task.ts's own code (TASK_MOUNT_FN), with its
// rules: a finished cron run can be continued, other finished runs are
// read-only.
//
// While Live or a Task is open, the Wall follows /api/live/stream (a
// snapshot every two seconds) instead of its one-minute refresh.

import { TASK_MOUNT_FN } from "./task"

export const WALL_TASK_SCRIPT = String.raw`
  ${TASK_MOUNT_FN}
  /** The query keys of a Task page's hash. */
  var TASK_KEYS = ['task', 'agent', 'node', 'trace', 'ch', 'ask', 'at', 'done'];
  /** The Wall's link to a run's Task page. t: { id, traceId?, channel?, message?, startedAt? } */
  function wallTaskHref(t, agentId, nodeUrl, done) {
    var q = new URLSearchParams();
    q.set('page', 'task');
    q.set('task', t.id);
    q.set('agent', agentId);
    if (nodeUrl) q.set('node', nodeUrl);
    if (t.traceId) q.set('trace', t.traceId);
    if (t.channel) q.set('ch', t.channel);
    // A live run's stream never replays what was asked: carry it, capped.
    var ask = plainMarkerText(t.message || t.messagePreview || '').slice(0, 400);
    if (ask) q.set('ask', ask);
    if (t.startedAt) q.set('at', t.startedAt);
    if (done) q.set('done', '1');
    return '#' + q.toString();
  }
  function readTask(q) {
    var t = {};
    TASK_KEYS.forEach(function (k) { t[k] = q.get(k) || ''; });
    return t.task && t.agent ? t : null;
  }
  function taskKey(t) { return t ? t.node + '|' + t.agent + '|' + t.task : ''; }
  /** The node a run is on, from the live snapshot: index 0 is this one. */
  function taskNode(t) {
    var nodes = (S.live && S.live.nodes) || [];
    var i = nodes.findIndex(function (n) { return n.url === t.node; });
    return { i: i, n: nodes[i] || null };
  }

  function taskSkeleton(t) {
    var who = nameOf(t.agent);
    return '<div class="ax-task-page wtask" id="wtask-root" data-task-id="' + esc(t.task) + '" data-agent-id="' + esc(t.agent) + '" data-node-url="' + esc(t.node) + '"' +
      ' data-archived="' + (t.done ? '1' : '') + '" data-ask="' + esc(t.ask) + '" data-ask-at="' + esc(t.at) + '">' +
      '<header class="wtask__head">' + avatar(t.agent) + '<div class="wtask__who"><div><b id="wtask-name">' + esc(who) + '</b> <span class="h">@' + esc(t.agent) + '</span></div>' +
        '<div class="wtask__meta">' + (t.ch ? '<span class="chip chip--ghost">' + esc(t.ch) + '</span>' : '') +
        '<span class="ax-badge ax-badge--mono" id="task-status">connecting…</span><span class="ax-mono" id="task-elapsed"></span>' +
        '<span id="wtask-where"></span></div></div>' +
        '<a class="wtask__classic" href="/tasks/' + encodeURIComponent(t.task) + '?agent=' + encodeURIComponent(t.agent) + (t.node ? '&node=' + encodeURIComponent(t.node) : '') + (t.done ? '&archived=1' : '') + '" title="This run on the classic dashboard">Classic page</a>' +
      '</header>' +
      '<section class="ax-task-page__ask" id="task-ask" hidden><div class="ax-task-page__ask-head"><span class="ax-ev__label ax-ev__label--soft">request</span>' +
        '<span class="ax-task-page__ask-who" id="task-ask-who"></span><span class="ax-task-page__ask-when" id="task-ask-when"></span></div>' +
        '<div class="ax-task-page__ask-body" id="task-ask-body"></div></section>' +
      '<div id="wtask-details"></div>' +
      '<h2 class="wtask__h">Conversation</h2>' +
      '<div class="ax-task-page__output wtask__out" id="task-output" aria-live="polite"></div>' +
      '<footer class="ax-task-page__compose wtask__steer" id="wtask-steer"' + (t.done ? ' hidden' : '') + '>' +
        '<textarea id="task-input" class="ax-task-page__input" rows="2" aria-label="Steer ' + esc(who) + '" placeholder="Message ' + esc(who) + ': it goes in as the next turn, the current one keeps running. ⌘/Ctrl+Enter sends."></textarea>' +
        '<div class="ax-task-page__actions"><span class="ax-task-page__hint" id="task-hint" role="status"></span>' +
          '<button type="button" id="task-stop" class="ax-btn ax-btn--ghost wtask__stop">Stop</button>' +
          '<button type="button" id="task-send" class="ax-btn">Send</button></div>' +
      '</footer>' +
      '<p class="wtask__ro">This run is finished. Its chat goes on where it came from' + (t.ch ? ' (' + esc(t.ch) + ')' : '') + ', so this page only reads it.</p>' +
    '</div>';
  }

  /** The tracked request the run belongs to, if any: status strip, plan, facts. */
  function taskDetailsHtml() {
    var d = S.taskDetail;
    if (!d || !d.post) return '';
    var p = d.post;
    return '<section class="wtask__req" aria-label="Tracked request"><h2 class="wtask__h">' + esc(p.headline || p.id) +
      ' <a class="wtask__open" href="#post=' + encodeURIComponent(p.id) + '">Open the post</a></h2>' +
      progressHtml(p) + (d.plan && d.plan.length ? planHtml(d.plan) : '') + factsHtml(p) + '</section>';
  }
  async function loadTaskDetail(t) {
    var at = taskNode(t);
    if (!S.live) return;
    S.taskDetail = { loading: true };
    var peer = at.i > 0 ? at.n.url : null;
    var tries = t.trace && t.trace !== t.task ? [t.trace, t.task] : [t.task];
    for (var i = 0; i < tries.length; i++) {
      try {
        var r = await fetch('/api/admin/wall/thread?task=' + encodeURIComponent(tries[i]), { headers: headers(peer) });
        var b = r.ok ? await r.json() : null;
        if (b && b.post) {
          if (taskKey(S.task) !== taskKey(t)) return;
          plainPost(b.post);
          b.post.node = b.post.node || { name: at.n ? at.n.name : '', peer: peer, daemonUrl: t.node };
          S.taskDetail = { post: b.post, plan: b.plan || [] };
          render();
          return;
        }
      } catch (e) { /* not tracked, or the node did not answer: the run alone */ }
    }
    if (taskKey(S.task) === taskKey(t)) S.taskDetail = { none: true };
  }

  /** Open, keep or close the mounted run as the page changes. */
  function paintTask(page) {
    var want = page === 'task' ? S.task : null;
    if (taskKey(want) !== S.taskMounted) {
      if (S.taskClose) { S.taskClose(); S.taskClose = null; }
      S.taskMounted = taskKey(want);
      S.taskDetail = null;
      if (!want) { $('wall-task').innerHTML = ''; return; }
      $('wall-task').innerHTML = taskSkeleton(want);
      S.taskClose = mountTaskPage($('wtask-root'), {
        href: function (id, channel) { return wallTaskHref({ id: id, channel: channel }, want.agent, want.node, false); },
        plain: plainMarkerText,
      });
    }
    if (!want) return;
    if (!S.taskDetail && S.live) loadTaskDetail(want);
    var at = taskNode(want);
    $('wtask-name').textContent = nameOf(want.agent);
    $('wtask-where').textContent = at.n && S.live.nodes.length > 1 ? 'on ' + at.n.name : '';
    $('wtask-details').innerHTML = taskDetailsHtml();
  }

  /** While Live or a Task is open, follow the live snapshot stream. */
  function followLive(page) {
    var want = page === 'live' || page === 'task';
    if (want && !S.liveEs) {
      try {
        S.liveEs = new EventSource('/api/live/stream');
        S.liveEs.addEventListener('snapshot', function (ev) {
          try { S.live = JSON.parse(ev.data); } catch (e) { return; }
          render();
        });
        // Dropped: close it; the next render (the one-minute refresh) reopens it.
        S.liveEs.addEventListener('error', function () { if (S.liveEs) { S.liveEs.close(); S.liveEs = null; } });
      } catch (e) { S.liveEs = null; }
    } else if (!want && S.liveEs) {
      S.liveEs.close();
      S.liveEs = null;
    }
  }
`

export const WALL_TASK_CSS = `
/* The Task page (#1381): the classic task page in the Wall's column. */
.wtask { max-width: none; margin: 0; padding: 12px 16px 24px; min-height: 0; gap: 12px; }
.wtask__head { display: flex; gap: 10px; align-items: flex-start; }
.wtask__who { flex: 1; min-width: 0; }
.wtask__who .h { color: var(--ax-muted); }
.wtask__meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wtask__classic { font-size: var(--ax-fs-xs); white-space: nowrap; }
.wtask__h { font-size: var(--ax-fs); font-weight: 800; margin: 4px 0 0; }
.wtask__open { font-size: var(--ax-fs-xs); font-weight: 400; margin-left: 6px; }
.wtask__req { border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 12px 14px; }
.wtask__req .wtask__h { margin: 0 0 10px; }
.wtask__out { box-shadow: none; min-height: 260px; max-height: 62vh; }
/* A chat box right under the conversation, which scrolls on its own. */
.wtask__stop { color: var(--ax-err); border-color: color-mix(in srgb, var(--ax-err) 45%, var(--ax-border)); }
.wtask__ro { margin: 0; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.ax-task-page__compose:not([hidden]) ~ .wtask__ro { display: none; }
@media (max-width: 640px) { .wtask { padding: 10px 12px 18px; } .wtask__out { max-height: none; } }
`
