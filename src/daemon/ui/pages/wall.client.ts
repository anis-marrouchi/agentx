// --- Wall page script (#1180) ---
//
// Reads only: /api/admin/wall?peer=fleet (posts across the mesh),
// /api/admin/wall/thread (one post's timeline, sent to the node that owns
// it), /api/live (what runs on each node now, with its ops details) and
// /api/workflows/runs (failed workflow runs), /api/admin/org (each
// agent's role and who it reports to, #1398) and
// /api/admin/observability/budgets (an agent's month spend vs its cap on
// its profile, #1393, wall-spend.ts). Pending owner decision
// cards (#1185) come with their post and are shown without buttons:
// answering stays on the Desk. Filters live in the URL
// hash, so a view is a link; "Save as my view" keeps that link in this
// browser only. The only writes are an open post's actions (below). The Projects view
// (#1190) shows the overview rows the reply carries, one per project;
// each count links to the list with that project and status in the hash.
// Under it, weekly throughput (#1192): closures per week per project and
// per owner over four weeks, read once when the tab first opens.
// Between them, capacity per owner (#1191, wall-capacity.client.ts).
// Goals (#1392): the Goal filter shows the posts whose request serves a
// goal, under one line with the goal's progress and cost from the reply's
// goal rows (every node's, added up).
//
// The Reviews view (#1182) lives in wall-reviews.client.ts.
//
// Pages (#1316): selecting a post opens it on its own, with its thread, as
// on X (#post=<id> in the hash, so a post is a link and Back returns to the
// feed). The nav's Running now and Agents open pages of their own
// (#page=running, #page=agents), and each nav item carries its count.
// Results and thread lines render their Markdown through the shared
// renderer; links in them go to web, mail or same-site addresses only.
//
// The only writes (#1316, wall-actions.ts), from an open post: a comment
// that reaches the agent on the post (sent to the node that keeps it), a
// voice call from that agent, and a Space: two agents talk about the post
// out loud on this computer, with the owner's words going into it.

import { markdownToHtml } from "@/utils/markdown-html"
import { injectFns } from "../inject"
import { WALL_CAPACITY_SCRIPT } from "./wall-capacity.client"
import { WALL_REVIEWS_SCRIPT } from "./wall-reviews.client"
import { WALL_PAGES_SCRIPT } from "./wall-pages.client"
import { WALL_LIVE_SCRIPT } from "./wall-live.client"
import { WALL_TASK_SCRIPT } from "./wall-task.client"
import { profileSpendHtml } from "./wall-spend"
import { costPageHtml, costPageModel } from "./wall-cost"
import { WALL_COST_SCRIPT } from "./wall-cost.client"
import { WALL_PEOPLE_SCRIPT } from "./wall-people.client"

export const WALL_PAGE_SCRIPT = String.raw`
(function () {
  var OPEN = ['in_progress', 'waiting_owner', 'waiting_other', 'needs_attention'];
  var DAY = 864e5;
  var FILTERS = ['owner', 'asker', 'load', 'status', 'idle', 'project', 'goal', 'node', 'group', 'by', 'grp', 'time', 'conc', 'qa', 'q'];
  var SAVED_KEY = 'ax.wall.myView';
  /** The project filter's value for work with no project: "Other". */
  var OTHER = '-';
  /** The pages the nav opens besides the Wall itself (#1316). */
  var PAGES = ['running', 'agents', 'people', 'creator', 'live', 'task'];
  // threads: loaded threads by post id; shown: the ones open under their post in the feed.
  var S = { data: null, live: null, wf: null, org: null, view: 'feed', page: 'wall', post: '', sort: { key: 'idle', dir: -1 }, threads: {}, shown: {}, drafts: {}, doNote: '', space: null, spaceTimer: null, task: null, taskMounted: '', taskClose: null, taskDetail: null, liveEs: null, budgets: null };
  var $ = function (id) { return document.getElementById(id); };
  ${injectFns({ markdownToHtml, profileSpendHtml, costPageModel, costPageHtml })}
${WALL_REVIEWS_SCRIPT}
${WALL_COST_SCRIPT}
${WALL_PEOPLE_SCRIPT}
${WALL_CAPACITY_SCRIPT}
${WALL_PAGES_SCRIPT}
${WALL_LIVE_SCRIPT}
${WALL_TASK_SCRIPT}

  function headers(peer) {
    var h = { 'X-Requested-With': 'agentx-board' };
    if (window.AX_LOCAL_TOKEN) h.Authorization = 'Bearer ' + window.AX_LOCAL_TOKEN;
    if (peer) h['X-Agentx-Peer'] = peer;
    return h;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  /** Exact local time with its UTC offset, so it can be matched against logs. */
  function stamp(ms) {
    if (!ms) return '—';
    var d = new Date(ms), off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) +
      ' UTC' + sign + p2(Math.floor(off / 60)) + ':' + p2(off % 60);
  }
  function ago(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return Math.round(s) + 's ago';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function when(ms) {
    if (!ms) return '—';
    return '<time datetime="' + esc(new Date(ms).toISOString()) + '" title="' + esc(new Date(ms).toISOString()) + '">' + esc(stamp(ms)) + '</time> <small>(' + ago(ms) + ')</small>';
  }
  function until(ms) {
    var s = (ms - Date.now()) / 1000;
    if (s <= 0) return 'passed';
    if (s < 5400) return 'in ' + Math.max(1, Math.round(s / 60)) + ' min';
    if (s < 129600) return 'in ' + Math.round(s / 3600) + ' h';
    return 'in ' + Math.round(s / 86400) + ' d';
  }
  function cardsOf(p) { return p.ownerCards || []; }
  function waitsOnOwner(p) { return p.state === 'waiting_owner' || cardsOf(p).length > 0; }
  function mins(ms) { return Math.round((ms || 0) / 60000); }
  function isOpen(p) { return OPEN.indexOf(p.state) >= 0; }
  // The status tabs (#1355): Waiting is on the owner or on anyone else;
  // Failed is a post that needs attention or has a failed run.
  function waitsOnSomeone(p) { return isOpen(p) && (waitsOnOwner(p) || p.state === 'waiting_other' || !!p.blocked); }
  function isFailed(p) { return p.state === 'needs_attention' || p.failedRuns > 0; }
  function groupKey(p) { return p.group.channel + ' · ' + p.group.chatId; }
  function idleDays(p) { return Math.floor((Date.now() - p.lastMoveAt) / DAY); }
  function stateBadge(state) {
    var cls = state === 'needs_attention' ? 'chip--err' : state === 'waiting_owner' ? 'chip--warn'
      : state === 'done' ? 'chip--done' : OPEN.indexOf(state) >= 0 ? '' : 'chip--ghost';
    return '<span class="chip state ' + cls + '">' + esc(state.replace(/_/g, ' ')) + '</span>';
  }

  // --- Agents as feed authors (#1207): name, @handle, avatar ---
  /** Display names and who runs now, from the live snapshot of every node. */
  function agentInfo() {
    var info = {};
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      (n.agents || []).forEach(function (a) {
        var i = info[a.id] || (info[a.id] = { name: a.name || a.id, live: false });
        if (a.runningTasks && a.runningTasks.length) i.live = true;
      });
    });
    return info;
  }
  function nameOf(id) { var i = agentInfo()[id]; return i ? i.name : id; }

  // --- The org on the Wall (#1398): role and who each agent reports to ---
  /** Each agent's place in this node's org chart, from /api/admin/org. */
  function orgInfo() {
    var info = {};
    function walk(list) {
      (list || []).forEach(function (n) {
        info[n.id] = { title: n.title, reportsTo: n.reportsTo, reports: (n.reports || []).length };
        walk(n.reports);
      });
    }
    walk(S.org && S.org.roots);
    return info;
  }
  /** Role, boss and reports, read-only: Pause and Resume stay on /org. */
  function orgLineHtml(id) {
    var o = orgInfo()[id];
    if (!o || (!o.title && !o.reportsTo && !o.reports)) return '';
    var bits = [
      o.title ? '<b>' + esc(o.title) + '</b>' : '',
      o.reportsTo ? 'reports to <button type="button" data-agent="' + esc(o.reportsTo) + '">' + esc(nameOf(o.reportsTo)) + '</button>' : '',
      o.reports ? o.reports + (o.reports === 1 ? ' reports' : ' report') + ' to it' : '',
    ].filter(Boolean).map(function (x) { return '<span>' + x + '</span>'; }).join('');
    return '<div class="wp__meta wpf__org">' + bits + '<a href="/org">Org chart</a></div>';
  }
  function isAgent(id) {
    return !!agentInfo()[id] || ((S.data && S.data.posts) || []).some(function (p) { return p.owner === id; });
  }
  function hue(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return h;
  }
  function initials(name) {
    var words = String(name).replace(/[-_.@]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  }
  /** A round avatar. Agents open their profile; people get a plain grey one. */
  function avatar(id, size, person) {
    var cls = 'av' + (size ? ' av--' + size : '') + (person ? ' av--person' : '') + (!person && agentInfo()[id] && agentInfo()[id].live ? ' is-live' : '');
    var face = esc(initials(person ? id : nameOf(id)));
    if (person || size) return '<span class="' + cls + '" style="--av-h:' + hue(id) + '" aria-hidden="true">' + face + '</span>';
    return '<button type="button" class="' + cls + '" style="--av-h:' + hue(id) + '" data-agent="' + esc(id) + '" title="' + esc(nameOf(id)) + ': profile and posts">' + face + '</button>';
  }
  /** Short relative time, as on a social feed: 45s, 12m, 3h, 2d. */
  function short(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd';
  }
  function shortTime(ms) {
    return '<time datetime="' + esc(new Date(ms).toISOString()) + '" title="' + esc(stamp(ms)) + '">' + short(ms) + '</time>';
  }
  var ICON = {
    reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 12a8 8 0 0 1 8-8h1a7 7 0 0 1 0 14H9l-5 3v-9z"/></svg>',
    runs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 9h13l-3-3M20 15H7l3 3"/></svg>',
    time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/></svg>',
    proof: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>',
    trace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 19V5M4 19h16M8 15l4-4 3 3 5-6"/></svg>',
  };
  /** A run's link: the Wall's own Task page (#1381), which links on to the classic one. */
  function taskHref(taskId, agentId, node, done) {
    return wallTaskHref({ id: taskId }, agentId, node && node.daemonUrl, done);
  }
  /** Markdown from an agent, escaped first; links only to web, mail or this site. */
  function md(text) {
    var html;
    try { html = markdownToHtml(String(text == null ? '' : text)); } catch (e) { return '<p>' + esc(text) + '</p>'; }
    // "/" but not "//host" or "/\host": those open another site.
    return html.replace(/href="([^"]*)"/g, function (m, u) { return /^(https?:|mailto:|\/(?![\/\\])|#)/i.test(u) ? m : 'href="#"'; });
  }
  function linkOrText(ref) {
    return /^https?:\/\//.test(ref) ? '<a href="' + esc(ref) + '" target="_blank" rel="noopener">' + esc(ref) + '</a>' : esc(ref);
  }

  // --- Filters in the URL hash ---
  function readHash() {
    var q = new URLSearchParams(location.hash.slice(1));
    var f = {};
    FILTERS.forEach(function (k) { f[k] = q.get(k) || ''; });
    if (!q.has('status')) f.status = 'open';
    S.view = q.get('view') || S.view;
    S.page = PAGES.indexOf(q.get('page')) >= 0 ? q.get('page') : 'wall';
    // A Task page names its run (#1381); without one it is the Wall.
    S.task = S.page === 'task' ? readTask(q) : null;
    if (S.page === 'task' && !S.task) S.page = 'wall';
    S.post = q.get('post') || '';
    return f;
  }
  /** The hash for the current filters and view, on this page or post. */
  function hashOf(post) {
    var q = new URLSearchParams();
    FILTERS.forEach(function (k) {
      var el = $('f-' + k), v = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
      if (v || k === 'status') q.set(k, v);
    });
    if (S.view !== 'feed') q.set('view', S.view);
    if (S.page !== 'wall') q.set('page', S.page);
    if (S.page === 'task' && S.task) TASK_KEYS.forEach(function (k) { if (S.task[k]) q.set(k, S.task[k]); });
    if (post) q.set('post', post);
    return '#' + q.toString();
  }
  function writeHash() { history.replaceState(null, '', hashOf(S.post)); S.applied = location.hash; }
  function applyHash() {
    S.applied = location.hash;
    var was = S.post;
    var f = readHash();
    FILTERS.forEach(function (k) {
      var el = $('f-' + k);
      if (el.type === 'checkbox') el.checked = f[k] === '1';
      else el.value = f[k];
    });
    var back = null;
    if (S.post && S.post !== was) {
      // Opened from the feed in this tab: Back returns there, where it was.
      if (S.booted && !was) { S.pushed = true; S.backY = window.scrollY || 0; }
      loadThread(S.post);
    } else if (!S.post && was) {
      S.pushed = false;
      back = S.backY;
    }
    S.booted = true;
    setView(S.view, true);
    if (S.post && S.post !== was && window.scrollTo) window.scrollTo(0, 0);
    if (back != null && window.scrollTo) window.scrollTo(0, back);
  }
  /** Open one post on its own, with its thread (#1316). */
  function openPost(id) {
    location.hash = hashOf(id);
    applyHash();
  }
  function closePost() {
    if (S.pushed && history.back) { history.back(); return; }
    history.replaceState(null, '', hashOf(''));
    applyHash();
  }
  function current() {
    var f = {};
    FILTERS.forEach(function (k) { var el = $('f-' + k); f[k] = el.type === 'checkbox' ? el.checked : el.value; });
    return f;
  }
  function match(p, f) {
    if (f.owner && p.owner !== f.owner) return false;
    if (f.asker && p.askedBy !== f.asker) return false;
    if (f.load && !countsFor(p, f.load)) return false;
    if (f.status === 'open' && !isOpen(p)) return false;
    if (f.status === 'closed' && isOpen(p)) return false;
    if (f.status === 'blocked' && !p.blocked) return false;
    if (f.status === 'waiting_owner' && !waitsOnOwner(p)) return false;
    if (f.status === 'stalled' && !p.stalled) return false;
    if (f.status === 'waiting' && !waitsOnSomeone(p)) return false;
    if (f.status === 'failed' && !isFailed(p)) return false;
    if (f.status && ['open', 'closed', 'blocked', 'waiting_owner', 'stalled', 'waiting', 'failed'].indexOf(f.status) < 0 && p.state !== f.status) return false;
    if (+f.idle && idleDays(p) < +f.idle) return false;
    if (f.project && (f.project === OTHER ? p.project : p.project !== f.project)) return false;
    if (f.goal && !(p.goal && p.goal.id === f.goal)) return false;
    if (f.node && p.node.name !== f.node) return false;
    if (f.group && groupKey(p) !== f.group) return false;
    if (f.time && !p.timeFlag && !forgeFlags(p).length) return false;
    if (f.conc && !(p.concurrent && p.concurrent.length)) return false;
    if (f.qa && !p.awaitingQa) return false;
    if (f.q) {
      var hay = [p.result && p.result.text, p.headline, p.owner, p.id, p.project, p.goal && p.goal.title, p.home && p.home.link, p.askedBy]
        .concat(cardsOf(p).map(function (c) { return c.title + ' ' + c.ask; })).join(' ').toLowerCase();
      if (hay.indexOf(f.q.toLowerCase()) < 0) return false;
    }
    return true;
  }
  function fillSelect(id, values, label) {
    var el = $(id), keep = el.value;
    el.innerHTML = '<option value="">All</option>' + values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(label ? label(v) : v) + '</option>'; }).join('');
    el.value = keep && values.indexOf(keep) >= 0 ? keep : '';
  }
  // GitLab time tracking (#1189): logged vs estimate, its flags, or "unknown".
  function forgeFlags(p) { return (p.forgeTime && p.forgeTime.flags) || []; }
  function hm(m) { var h = Math.floor(m / 60), r = m % 60; return h ? h + ' h' + (r ? ' ' + r + ' min' : '') : r + ' min'; }
  function forgeTimeText(t, why) {
    if (t.unknown) return 'unknown' + (why ? ' (' + t.unknown + ')' : '');
    return hm(t.loggedMinutes) + ' logged' + (t.estimateMinutes ? ' of ' + hm(t.estimateMinutes) : ', no estimate');
  }
  // Forge home (#1184): its live state, who closed it, when that was checked;
  // its milestone and assignees (#1195).
  function forgeName(f) { return f.provider === 'github' ? 'GitHub' : 'GitLab'; }
  function forgeStateHtml(f) {
    var checked = f.checkedAt ? ' <small>checked ' + ago(f.checkedAt) + '</small>' : '';
    if (f.unknown) return forgeName(f) + ' <b title="' + esc(f.unknown) + '">state unknown</b>' + checked;
    return forgeName(f) + ' <b>' + esc(f.state) + '</b>' + (f.closedBy ? ' by <b>' + esc(f.closedBy) + '</b>' : '') +
      (f.closedAt && f.state !== 'open' ? ' ' + when(f.closedAt) : '') +
      (f.milestone ? ' · milestone <b>' + esc(f.milestone) + '</b>' : '') +
      (f.assignees && f.assignees.length ? ' · assigned to <b>' + f.assignees.map(esc).join(', ') + '</b>' : '') + checked;
  }
  // The forge and the post disagree (#1195): closed there and open here, so
  // nobody should pick it up; or open there and closed here.
  function forgeClosedOpen(p) { return !!p.forgeState && p.forgeState.mismatch === 'forge-closed'; }
  function forgeOpenClosed(p) { return !!p.forgeState && p.forgeState.mismatch === 'forge-open'; }
  function uniq(xs) { return xs.filter(function (x, i) { return x && xs.indexOf(x) === i; }).sort(); }

  // --- Concurrent sessions (#1187): two runs at once on one chat or worktree ---
  function concHtml(o, runLink) {
    var where = (o.on || []).map(function (k) { return k === 'chat' ? 'on chat ' + esc(o.chat) : 'in worktree ' + esc(o.worktree); }).join(' and ');
    return '<span class="ax-conc" role="note">⚠ Concurrent: run ' + runLink(o.runs[0], o.agents[0]) + ' (' + esc(o.agents[0]) + ') and run ' +
      runLink(o.runs[1], o.agents[1]) + ' (' + esc(o.agents[1]) + ') ' + where + ', from ' + when(o.from) +
      (o.to ? ' to ' + when(o.to) : ', both still running') + '</span>';
  }

  // --- Owner decision cards (#1185): read-only, answered on the Desk ---
  function cardHtml(c) {
    var expired = c.expiresAt <= Date.now();
    var soon = !expired && c.expiresAt - Date.now() < 864e5;
    return '<section class="wc' + (soon || expired ? ' is-soon' : '') + '" aria-label="Waiting on the owner: ' + esc(c.title) + '">' +
      '<div class="wc__head"><span class="ax-badge ax-badge--warn">Waiting on the owner</span> <b>' + esc(c.title) + '</b></div>' +
      (c.ask && c.ask !== c.title ? '<p class="wc__ask">' + esc(c.ask) + '</p>' : '') +
      '<dl class="wc__facts">' +
        '<dt>Recommends</dt><dd>' + esc(c.recommend || '—') + '</dd>' +
        '<dt>If no answer</dt><dd>' + esc(c.silence) + ' <span class="k">(' + esc(c.ifSilent) + ')</span></dd>' +
        '<dt>Expires</dt><dd>' + (expired ? 'Passed; the default applies at the next check. ' : until(c.expiresAt) + ', ') +
          '<time datetime="' + esc(new Date(c.expiresAt).toISOString()) + '">' + esc(stamp(c.expiresAt)) + '</time></dd>' +
      '</dl>' +
      '<div class="wc__foot"><span>Raised by <b>' + esc(c.raisedBy) + '</b> ' + when(c.createdAt) + '</span>' +
        (c.source ? '<span>Source: ' + linkOrText(c.source) + '</span>' : '') +
        '<span>Answer it on the Desk: <a href="/approvals">Approvals</a></span></div>' +
      '</section>';
  }

  // QA verdict (#1188): "PASS by qa-agent, <when>: note", or awaiting sign-off.
  function qaText(p, short) {
    if (p.qa) return p.qa.verdict.toUpperCase() + ' by ' + p.qa.by + (short ? '' : ', ' + stamp(p.qa.at) + (p.qa.note ? ': ' + p.qa.note : ''));
    return p.awaitingQa ? 'Awaiting QA sign-off' : '';
  }

  // --- Feed ---
  // A post leads with its result (#1242); the request it answers opens
  // from under it with one tap. No result recorded: the request alone.
  function leadHtml(p, via, full) {
    var r = p.result;
    if (!r) return '<div class="wp__via">' + via + '</div>' +
      '<p class="wp__title">' + esc(p.headline) + ' <span class="chip chip--ghost">No result yet</span></p>';
    var from = r.from === 'reply'
      ? 'Answered ' + shortTime(r.at) + (r.taskId && r.agentId ? ' · <a href="' + esc(taskHref(r.taskId, r.agentId, p.node, !isOpen(p))) + '">run ' + esc(r.taskId) + '</a>' : '')
      : 'Closed with ' + shortTime(r.at);
    return '<div class="wp__result ax-md">' + md(r.text) + '</div>' +
      '<div class="wp__from">' + from + '</div>' +
      '<details class="wp__ask"' + (full ? ' open' : '') + '><summary><span class="k">Request</span> ' + esc(p.headline) + '</summary>' +
        '<div class="wp__via">' + via + ' · <span title="Request id">' + esc(p.id) + '</span> · ' + when(p.createdAt) + '</div>' +
      '</details>';
  }
  /** A post. In the feed it opens on its own when selected; full, it is that page. */
  function postHtml(p, full) {
    var multi = S.data && S.data.nodes && S.data.nodes.length > 1;
    var conc = p.concurrent || [];
    var cls = 'wp' + (full ? ' wp--open' : '') + (p.blocked ? ' is-blocked' : '') + (p.failedRuns ? ' is-failed' : '') + (conc.length ? ' is-concurrent' : '');
    // Author line: name, @handle, time, as on a social feed; the status as a chip.
    var by = '<button type="button" class="name" data-agent="' + esc(p.owner) + '">' + esc(nameOf(p.owner)) + '</button>' +
      '<span class="h">@' + esc(p.owner) + '</span><span aria-hidden="true">·</span>' +
      (full ? shortTime(p.lastMoveAt) : '<a class="wp__link" href="' + esc(hashOf(p.id)) + '" data-open="' + esc(p.id) + '" title="Open this post and its thread">' + shortTime(p.lastMoveAt) + '</a>') +
      (multi ? '<span aria-hidden="true">·</span><span>' + esc(p.node.name) + '</span>' : '') + stateBadge(p.state);
    var via = [
      p.askedBy ? 'Asked by <b>' + esc(p.askedBy) + '</b>' : '',
      'in <b>' + esc(groupKey(p)) + '</b>',
      p.project ? 'project <b>' + esc(p.project) + '</b>' : '',
      p.goal ? 'goal <b>' + esc(p.goal.title) + '</b>' : '',
    ].filter(Boolean).join(' · ');
    // Action row: thread, runs, minutes, then the links out.
    var shown = full || S.shown[p.id];
    var acts = [
      full ? '' : '<button type="button" data-thread="' + esc(p.id) + '" aria-expanded="' + (shown ? 'true' : 'false') + '">' + ICON.reply + (shown ? 'Hide thread' : 'Thread') + '</button>',
      '<span title="Runs that worked on it"' + (p.failedRuns ? ' class="is-err"' : '') + '>' + ICON.runs + p.runs + (p.runs === 1 ? ' run' : ' runs') + (p.failedRuns ? ', ' + p.failedRuns + ' failed' : '') + '</span>',
      p.runMs ? '<span title="Minutes the runs took">' + ICON.time + mins(p.runMs) + ' min</span>' : '',
    ];
    // Compact in the feed (#1355): the author line, the result, one amber
    // line when it waits on someone, and one row of icons with the
    // project. Times, asker, group, GitLab time and the links are in the
    // opened post.
    if (!full) {
      if (p.project) acts.push('<span title="Project">' + ICON.link + esc(p.project) + '</span>');
      if (p.goal) acts.push('<button type="button" data-goal="' + esc(p.goal.id) + '" title="Show every post for this goal">Goal: ' + esc(p.goal.title) + '</button>');
      return '<article class="' + cls + '" id="post-' + esc(p.id) + '" data-post="' + esc(p.id) + '" tabindex="0">' + avatar(p.owner) + '<div class="wp__b">' +
        '<div class="wp__by">' + by + '</div>' +
        leadHtml(p, via, false) +
        (waitLine(p) ? '<div class="wp__block">' + waitLine(p) + '</div>' : '') +
        '<div class="wp__acts">' + acts.filter(Boolean).join('') + '</div>' +
        '<div class="wp__thread" data-for="' + esc(p.id) + '">' + (shown && S.threads[p.id] ? threadHtml(S.threads[p.id], p) : '') + '</div>' +
        '</div></article>';
    }
    if (p.home) acts.push(/^https?:\/\//.test(p.home.link)
      ? '<a href="' + esc(p.home.link) + '" target="_blank" rel="noopener" title="Home: ' + esc(p.home.link) + '">' + ICON.link + '<span class="home">Home: ' + esc(p.home.link.replace(/^https?:\/\//, '')) + '</span></a>'
      : '<span title="Home">' + ICON.link + 'Home: ' + esc(p.home.link) + '</span>');
    if (p.evidence) acts.push(/^https?:\/\//.test(p.evidence)
      ? '<a href="' + esc(p.evidence) + '" target="_blank" rel="noopener">' + ICON.proof + 'Proof</a>'
      : '<span>' + ICON.proof + 'Proof: ' + esc(p.evidence) + '</span>');
    (p.comments || []).slice(0, 3).forEach(function (c) {
      if (/^https?:\/\//.test(c.url)) acts.push('<a href="' + esc(c.url) + '" target="_blank" rel="noopener" title="Comment posted ' + esc(stamp(c.at)) + '">' + ICON.reply + 'Comment' + (c.agentId ? ' by ' + esc(c.agentId) : '') + ' ' + shortTime(c.at) + '</a>');
    });
    if (p.lastRun) {
      acts.push('<a href="' + esc(taskHref(p.lastRun.taskId, p.lastRun.agentId, p.node, !isOpen(p))) + '">' + ICON.trace + 'Task record and trace</a>');
      acts.push('<a href="/agents/' + encodeURIComponent(p.lastRun.agentId) + '/history">Agent history</a>');
    }
    // Opened, a post reads as a task (#1355): the request as its title,
    // where it stands, its plan, the result, then the facts and the thread.
    var t = S.threads[p.id];
    return '<article class="' + cls + ' wtk" id="open-' + esc(p.id) + '">' + avatar(p.owner) + '<div class="wp__b">' +
      '<div class="wp__by">' + by + '</div>' +
      '<h1 class="wtk__title">' + esc(p.headline) + '</h1>' +
      progressHtml(p, t && t.plan) +
      (p.blocked ? '<div class="wp__block" title="Since ' + esc(stamp(p.blocked.since)) + '">Why it waits: ' + esc(p.blocked.why) + '</div>' : '') +
      (t && t.plan && t.plan.length ? planHtml(t.plan) : '') +
      resultHtml(p) +
      (p.timeFlag ? '<div class="wp__flag">Time: ' + esc(p.timeFlag) + '</div>' : '') +
      (forgeClosedOpen(p) ? '<div class="wp__flag">' + esc(forgeName(p.forgeState)) + ' says ' + esc(p.forgeState.state) + (p.forgeState.closedBy ? ' by ' + esc(p.forgeState.closedBy) : '') + ', but this post is still open. Do not pick it up.</div>' : '') +
      (forgeOpenClosed(p) ? '<div class="wp__flag">' + esc(forgeName(p.forgeState)) + ' says open, but this post is ' + esc(p.state) + '. Close it there or reopen it here.</div>' : '') +
      (forgeFlags(p).length ? '<div class="wp__flag">GitLab time: ' + esc(forgeFlags(p).join('; ')) + '</div>' : '') +
      conc.map(function (o) { return concHtml(o, function (id, agent) { return '<a href="' + esc(taskHref(id, agent, p.node, true)) + '">' + esc(id) + '</a>'; }); }).join('') +
      cardsOf(p).map(cardHtml).join('') +
      (qaText(p) ? '<div class="wp__qa">QA: ' + esc(qaText(p)) + (p.awaitingQa && p.qa ? ' — new verdict asked' : '') + '</div>' : '') +
      factsHtml(p) +
      '<div class="wp__acts">' + acts.filter(Boolean).join('') + '</div>' +
      doHtml(p) +
      '<div class="wp__thread" data-for="' + esc(p.id) + '"><h2 class="wp__th">Thread</h2>' +
        (t ? threadHtml(t, p) : '') + '</div>' +
      '</div></article>';
  }

  // --- The opened task (#1355) ---
  /** Asked → Working → Waits → Done, each with when it happened. */
  function progressHtml(p, plan) {
    var open = isOpen(p), waits = open && waitsOnSomeone(p);
    var end = p.state === 'done' ? 'Done' : open ? 'Done' : p.state.replace(/_/g, ' ');
    // Open and never run: it still stands at Asked, not at Working.
    var asked = open && !waits && !p.runs;
    var steps = [
      { name: 'Asked', at: esc(ago(p.createdAt)), on: asked ? 'is-now' : 'is-done' },
      { name: 'Working', at: p.runs ? p.runs + (p.runs === 1 ? ' run' : ' runs') + (p.runMs ? ', ' + mins(p.runMs) + ' min' : '') : 'not picked up yet',
        on: !open || waits ? (p.runs ? 'is-done' : '') : asked ? '' : 'is-now' },
    ];
    if (waits) steps.push({ name: 'Waits', at: 'on ' + waitsOn(p, plan) + (p.blocked ? ' for ' + esc(ago(p.blocked.since).replace(' ago', '')) : ''), on: 'is-wait' });
    steps.push({ name: end, at: p.closedAt ? esc(ago(p.closedAt)) : p.estimateMinutes ? 'estimate ' + hm(p.estimateMinutes) : '', on: open ? '' : p.state === 'done' ? 'is-done' : 'is-end' });
    return '<ol class="wtk__prog" aria-label="Where it stands">' + steps.map(function (s) {
      return '<li class="' + s.on + '"' + (s.on === 'is-now' || s.on === 'is-wait' ? ' aria-current="step"' : '') + '><b>' + esc(s.name) + '</b><span>' + s.at + '</span></li>';
    }).join('') + '</ol>';
  }
  /** Who an open post waits on: the blocker, you, or another agent. */
  function waitsOn(p, plan) {
    if (p.blocked) return esc(p.blocked.who);
    if (waitsOnOwner(p)) return 'you';
    var step = (plan || []).filter(function (s) { return s.state === 'active' || s.state === 'blocked'; })[0];
    return step ? '@' + esc(step.agentId) : 'another agent';
  }
  var STEP_MARK = { done: '✓', active: '●', blocked: '!', skipped: '–', pending: '' };
  /** The plan, when the post has one: each step, who owns it, its proof. */
  function planHtml(plan) {
    var done = plan.filter(function (s) { return s.state === 'done' || s.state === 'skipped'; }).length;
    return '<section class="wtk__sec" aria-label="Plan"><h2>Plan <span class="k">' + done + ' of ' + plan.length + ' done</span></h2><ol class="wtk__plan">' +
      plan.map(function (s) {
        var proof = s.evidence ? (/^https?:\/\//.test(s.evidence) ? '<a href="' + esc(s.evidence) + '" target="_blank" rel="noopener">Proof</a>' : esc(s.evidence)) : '';
        return '<li class="is-' + esc(s.state) + '"><span class="wtk__mark" aria-hidden="true">' + (STEP_MARK[s.state] || '') + '</span><div>' +
          '<b>' + esc(s.name) + '</b> ' + avatar(s.agentId, 'sm') + '<span class="h">@' + esc(s.agentId) + '</span> <span class="chip ' + (s.state === 'blocked' ? 'chip--warn' : s.state === 'done' ? 'chip--done' : 'chip--ghost') + '">' + esc(s.state) + '</span>' +
          (s.doneWhen ? '<div class="k">Done when: ' + esc(s.doneWhen) + '</div>' : '') +
          (s.note ? '<div class="wtk__note">' + esc(s.note) + '</div>' : '') +
          (proof ? '<div class="k">' + proof + '</div>' : '') +
        '</div></li>';
      }).join('') + '</ol></section>';
  }
  function resultHtml(p) {
    var r = p.result;
    if (!r) return '<section class="wtk__sec"><h2>Result</h2><p class="k">No result yet.</p></section>';
    var from = r.from === 'reply'
      ? 'Answered ' + shortTime(r.at) + (r.taskId && r.agentId ? ' · <a href="' + esc(taskHref(r.taskId, r.agentId, p.node, !isOpen(p))) + '">run ' + esc(r.taskId) + '</a>' : '')
      : 'Closed with ' + shortTime(r.at);
    return '<section class="wtk__sec"><h2>Result</h2><div class="wp__result ax-md">' + md(r.text) + '</div><div class="wp__from">' + from + '</div></section>';
  }
  /** Who asked, where, and the clock, as a short list of facts. */
  function factsHtml(p) {
    var rows = [
      ['Asked by', p.askedBy ? esc(p.askedBy) : ''],
      ['In', esc(groupKey(p))],
      ['Project', p.project ? esc(p.project) : ''],
      ['Goal', p.goal ? '<a href="#" data-goal="' + esc(p.goal.id) + '">' + esc(p.goal.title) + '</a>' : ''],
      ['Opened', when(p.createdAt)],
      ['Last move', when(p.lastMoveAt)],
      ['Closed', p.closedAt ? when(p.closedAt) : ''],
      ['Time', (p.runMs ? mins(p.runMs) + ' min of runs' : 'no runs yet') + (p.estimateMinutes ? ' against ' + hm(p.estimateMinutes) : '') + (p.timeFlag ? ' <span class="is-warn">' + esc(p.timeFlag) + '</span>' : '')],
      ['Forge', p.forgeState ? forgeStateHtml(p.forgeState) : ''],
      ['GitLab time', p.forgeTime ? '<span' + (p.forgeTime.unknown ? ' title="' + esc(p.forgeTime.unknown) + '"' : '') + '>' + esc(forgeTimeText(p.forgeTime, true)) + '</span>' : ''],
      ['Request', esc(p.id)],
    ];
    return '<dl class="wtk__facts">' + rows.filter(function (x) { return x[1]; }).map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>';
  }

  /** The one amber line of a compact post: who it waits on, if anyone. */
  function waitLine(p) {
    if (p.blocked) return 'Waits on <b>' + esc(p.blocked.who) + '</b> for ' + esc(ago(p.blocked.since).replace(' ago', '')) + ' — ' + esc(p.blocked.why);
    var c = cardsOf(p)[0];
    if (c) return 'Waits on you: <b>' + esc(c.title) + '</b>, ' + (c.expiresAt <= Date.now() ? 'its card expired' : 'card expires ' + until(c.expiresAt));
    if (p.state === 'waiting_owner') return 'Waits on you';
    if (forgeClosedOpen(p)) return esc(forgeName(p.forgeState)) + ' says ' + esc(p.forgeState.state) + ': do not pick it up';
    return '';
  }

  // Repeats in a row (same kind, author, status and words) fold into one
  // line with a count; "show all" opens the originals again.
  function collapse(events) {
    var out = [];
    events.forEach(function (e) {
      var sig = e.kind + '|' + (e.who || '') + '|' + (e.status || '') + '|' + e.text;
      var last = out[out.length - 1];
      if (last && last.sig === sig) last.items.push(e);
      else out.push({ sig: sig, items: [e] });
    });
    return out;
  }
  function eventHtml(e, p) {
    var err = e.status === 'error' || e.status === 'timeout' || e.status === 'failed';
    var who = e.route ? esc(e.route.from) + ' → ' + esc(e.route.to) : esc(e.who || '');
    var ref = e.ref ? (e.kind === 'run' && e.who ? '<a href="' + esc(taskHref(e.ref, e.who, p.node, true)) + '">' + esc(e.ref) + '</a>' : linkOrText(e.ref)) : '';
    var ids = (e.mentions || []).map(function (m) { return '<span class="men">→ @' + esc(m) + '</span>'; })
      .concat((e.ids || []).map(function (id) { return /^https?:/.test(id) ? '<a href="' + esc(id) + '" target="_blank" rel="noopener">' + esc(id.replace(/^https?:\/\//, '').slice(0, 60)) + '</a>' : '<span>' + esc(id) + '</span>'; }));
    return '<span class="k">' + esc(e.kind) + '</span> <span class="who">' + who + '</span> ' + when(e.at) +
      (e.status ? ' <span class="k">' + esc(e.status) + '</span>' : '') +
      (e.durationMs ? ' <span class="k">' + Math.round(e.durationMs / 1000) + ' s</span>' : '') +
      (ref ? ' <span class="k">' + ref + '</span>' : '') +
      (e.text ? '<div class="txt ax-md">' + md(e.text) + '</div>' : '') +
      (ids.length ? '<div class="ids">' + ids.join('') + '</div>' : '');
  }
  /** One reply in the thread: a small avatar of who acted, then the line. */
  function replyHtml(e, p, extra) {
    var who = (e.route && e.route.from) || e.who || '';
    var err = e.status === 'error' || e.status === 'timeout' || e.status === 'failed';
    return '<li class="' + (err ? 'is-err' : '') + '">' + avatar(who || '?', 'sm', !isAgent(who)) +
      '<div class="wr">' + eventHtml(e, p) + (extra || '') + '</div></li>';
  }
  function threadHtml(t, p) {
    if (t.loading) return '<p class="ax-wall__empty">Loading thread…</p>';
    if (t.error) return '<p class="ax-wall__empty">Thread not available: ' + esc(t.error) + '</p>';
    if (!t.events.length) return '<p class="ax-wall__empty">Nothing recorded on this post yet.</p>';
    var groups = collapse(t.events);
    return '<ol class="wt">' + groups.map(function (g, gi) {
      var more = g.items.length > 1
        ? ' <button type="button" class="more" data-more="' + gi + '">×' + g.items.length + ' — show all</button><ol class="wt" hidden data-more-list="' + gi + '">' +
          g.items.map(function (x) { return replyHtml(x, p); }).join('') + '</ol>'
        : '';
      return replyHtml(g.items[0], p, more);
    }).join('') + '</ol>';
  }

  // --- Agents box and agent profile (#1207) ---
  function agentStats() {
    var by = {};
    ((S.data && S.data.posts) || []).forEach(function (p) {
      var a = by[p.owner] || (by[p.owner] = { id: p.owner, posts: 0, open: 0, owner: 0, done: 0, runs: 0, last: 0 });
      a.posts++; a.runs += p.runs || 0;
      if (isOpen(p)) a.open++;
      if (waitsOnOwner(p)) a.owner++;
      if (p.state === 'done') a.done++;
      a.last = Math.max(a.last, p.lastMoveAt || 0);
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (x, y) { return y.open - x.open || y.last - x.last; });
  }
  function agentsHtml() {
    var list = agentStats(), sel = $('f-owner').value;
    if (!list.length) return '<p class="ax-wall__empty">No agent has a post on the Wall.</p>';
    var shown = S.allAgents ? list : list.slice(0, 6);
    return shown.map(function (a) {
      return '<button type="button" class="wa' + (a.id === sel ? ' is-on' : '') + '" data-agent="' + esc(a.id) + '">' + avatar(a.id, 'side') +
        '<span class="wa__n"><b>' + esc(nameOf(a.id)) + '</b><small>@' + esc(a.id) + ' · ' + a.open + ' open · ' + a.posts + (a.posts === 1 ? ' post' : ' posts') + '</small></span></button>';
    }).join('') + (list.length > 6 ? '<button type="button" class="wa-more" data-agents-more>' + (S.allAgents ? 'Show fewer' : 'Show all ' + list.length) + '</button>' : '');
  }
  function profileHtml(id) {
    var a = agentStats().find(function (x) { return x.id === id; }) || { open: 0, owner: 0, done: 0, runs: 0, posts: 0 };
    var live = agentInfo()[id] && agentInfo()[id].live;
    return '<div class="wpf__banner" style="--av-h:' + hue(id) + '"></div><div class="wpf">' +
      '<div class="wpf__top">' + avatar(id, 'lg') + '<button type="button" class="ax-btn ax-btn--ghost" data-profile-clear>All posts</button></div>' +
      '<h2>' + esc(nameOf(id)) + '</h2><div class="h">@' + esc(id) + (live ? ' · running now' : '') + '</div>' + orgLineHtml(id) +
      '<div class="wpf__stats"><span><b>' + a.open + '</b> open</span><span><b>' + a.owner + '</b> waiting on the owner</span>' +
        '<span><b>' + a.done + '</b> done in 7 days</span><span><b>' + a.runs + '</b> runs on these</span></div>' +
      profileSpendHtml(S.budgets, id) +
      (agentInfo()[id] ? '<div class="wpf__acts">' + agentActsHtml(id) + (S.callNote ? '<span class="wdo__n" role="status">' + esc(S.callNote) + '</span>' : '') + '</div>' : '') +
      '<div class="wpf__links"><a href="/admin/agents/' + encodeURIComponent(id) + '">Agent page</a><a href="/agents/' + encodeURIComponent(id) + '/history">History</a></div></div>';
  }
  // --- Goals (#1392): the filter's line, with progress and cost ---
  function goalRow(id) { return ((S.data && S.data.goals) || []).find(function (g) { return g.id === id; }) || null; }
  function goalTitle(id) {
    var g = goalRow(id);
    if (g) return g.title;
    var p = ((S.data && S.data.posts) || []).find(function (x) { return x.goal && x.goal.id === id; });
    return p ? p.goal.title : id;
  }
  function money(n) { return '$' + (n > 0 && n < 0.01 ? n.toFixed(3) : n.toFixed(2)); }
  function goalHtml(id, shown) {
    var g = goalRow(id), title = goalTitle(id);
    var clear = '<button type="button" class="ax-btn ax-btn--ghost" data-goal-clear>All goals</button>';
    // A node older than #1392, or one that does not answer, sends no row.
    if (!g) return '<div class="wgl"><h2 dir="auto">' + esc(title) + '</h2><span class="wgl__n">' + shown + (shown === 1 ? ' post' : ' posts') + ' shown</span>' + clear + '</div>' +
      '<p class="wgl__note">No progress or cost for this goal: the machine that keeps it did not send them.</p>';
    var pct = g.progress == null ? null : Math.round(g.progress * 100);
    var cost = money(g.costUsd || 0) + (g.unpriced ? ' (' + g.unpriced + ' of ' + g.runs + ' runs without a cost)' : '');
    return '<div class="wgl"><h2 dir="auto">' + esc(title) + '</h2>' +
      (pct == null ? '' : '<span class="wgl__bar" role="progressbar" aria-label="' + esc(title) + ' progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></span>') +
      '<span class="wgl__n">' + g.done + ' of ' + (g.open + g.done) + ' done' + (pct == null ? '' : ' (' + pct + '%)') + ' · ' + g.open + ' open' + (g.dropped ? ' · ' + g.dropped + ' dropped' : '') + '</span>' +
      '<span class="wgl__n" title="What the runs of its requests cost">' + esc(cost) + '</span>' + clear + '</div>' +
      '<p class="wgl__note">Counts and cost cover every request kept for this goal on every machine that answered, not only the posts below.</p>';
  }
  /** Show the posts of one goal, open and closed alike. */
  function showGoal(id) {
    S.page = 'wall'; S.post = ''; S.pushed = false;
    if (S.view !== 'feed' && S.view !== 'list') S.view = 'feed';
    $('f-goal').value = id;
    if ($('f-goal').value !== id) { var o = document.createElement('option'); o.value = id; o.textContent = goalTitle(id); $('f-goal').appendChild(o); $('f-goal').value = id; }
    $('f-status').value = '';
    writeHash();
    setView(S.view, true);
  }
  function showAgent(id) {
    // From a post or another page, an agent opens its profile; on the feed it toggles.
    var away = S.page !== 'wall' || S.post;
    S.page = 'wall'; S.post = ''; S.pushed = false;
    $('f-owner').value = !away && $('f-owner').value === id ? '' : id;
    if ($('f-owner').value === id) $('f-status').value = '';
    writeHash();
    render();
    var el = document.querySelector('.ax-wall__main');
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
  }
  function findPost(id) {
    return ((S.data && S.data.posts) || []).find(function (x) { return x.id === id; }) || (S.extra && S.extra.id === id ? S.extra : null);
  }
  function toggleThread(id) {
    if (S.shown[id]) { delete S.shown[id]; render(); return; }
    S.shown[id] = true;
    loadThread(id);
  }
  /** Read a post's thread again, from the node that owns it. */
  async function loadThread(id) {
    var p = findPost(id);
    if (!p) { render(); return; }
    var had = S.threads[id];
    if (had && had.loading) return;
    S.threads[id] = had && had.events ? had : { loading: true };
    render();
    var next;
    try {
      var r = await fetch('/api/admin/wall/thread?id=' + encodeURIComponent(id), { headers: headers(p.node && p.node.peer) });
      var body = await r.json();
      next = r.ok ? { events: body.events || [], plan: body.plan || [] } : { error: body.error || ('HTTP ' + r.status) };
    } catch (e) { next = { error: String(e && e.message || e) }; }
    S.threads[id] = next.error && had && had.events ? had : next;
    render();
  }

  // --- One post on its own (#1316) ---
  function postPageHtml() {
    var p = findPost(S.post);
    if (p) return postHtml(p, true);
    if (!S.data) return '<p class="ax-wall__empty">Loading…</p>';
    return '<p class="ax-wall__empty">This post is not on the Wall: it may be older than seven days, or its node did not answer. <button type="button" class="wa-more" data-back>Back to the feed</button></p>';
  }

  // --- What the owner does from an open post (#1316) ---
  function doHtml(p) {
    var others = allAgents().filter(function (a) { return a.id !== p.owner; });
    var draft = S.drafts[p.id] || '';
    var live = liveTaskOf(p.owner);
    return '<div class="wdo" data-for="' + esc(p.id) + '">' +
      // Any post takes a comment (#1355): on a closed one it opens the post
      // again; an @name in it brings that agent in with a post of its own.
      '<label class="wdo__l" for="wdo-text">Comment to @' + esc(p.owner) + (isOpen(p) ? '' : ': this post is ' + esc(p.state) + ', so a comment opens it again') + '</label>' +
      '<textarea id="wdo-text" class="wdo__t" rows="2" maxlength="4000" placeholder="It reaches ' + esc(nameOf(p.owner)) + ' like a message on any channel. Use @name to bring in another agent.">' + esc(draft) + '</textarea>' +
      '<div class="wdo__row">' +
        '<button type="button" class="ax-btn" data-act="comment">Comment</button>' +
        (live ? '<a class="ax-btn ax-btn--ghost" href="' + esc(wallTaskHref(live.t, p.owner, live.n.url)) + '" title="' + esc(nameOf(p.owner)) + ' is working now">● Join live</a>' : '') +
        '<button type="button" class="ax-btn ax-btn--ghost" data-act="call" title="' + esc(nameOf(p.owner)) + ' calls you on AgentX Voice about this post">Call ' + esc(nameOf(p.owner)) + '</button>' +
        (others.length
          ? '<span class="wdo__sp"><select id="wdo-with" aria-label="Talks with">' + others.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }).join('') + '</select>' +
            '<button type="button" class="ax-btn ax-btn--ghost" data-act="space" title="Two agents talk about this post out loud on this computer">Start a Space</button></span>'
          : '') +
      '</div>' +
      '<p class="wdo__n" id="wdo-note" role="status">' + esc(S.doNote || '') + '</p>' +
      '<div id="wdo-space">' + spaceHtml() + '</div>' +
    '</div>';
  }
  async function act(method, path, body, peer) {
    try {
      var h = headers(peer);
      h['Content-Type'] = 'application/json';
      var r = await fetch(path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined });
      var b = await r.json().catch(function () { return {}; });
      return r.ok ? { ok: true, body: b } : { ok: false, error: b.error || ('HTTP ' + r.status) };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  function note(text) { S.doNote = text; var el = $('wdo-note'); if (el) el.textContent = text; }
  async function doAct(kind) {
    var p = findPost(S.post);
    if (!p) return;
    var peer = p.node && p.node.peer;
    if (kind === 'comment') {
      var text = ($('wdo-text') && $('wdo-text').value || '').trim();
      if (!text) { note('Write the comment first.'); return; }
      note('Sending…');
      var r = await act('POST', '/api/admin/wall/comment', { id: p.id, text: text }, peer);
      if (!r.ok) { note('Not sent: ' + r.error); return; }
      delete S.drafts[p.id];
      if ($('wdo-text')) $('wdo-text').value = '';
      note(r.body.message || 'Sent.');
      loadThread(p.id);
      var told = await tellMentioned(p, text);
      if (told.length) note((r.body.message || 'Sent.') + ' Also posted to ' + told.join(', ') + '.');
      if (r.body.reopened) load();
    } else if (kind === 'call') {
      note('Calling…');
      var c = await act('POST', '/api/admin/wall/call', { id: p.id }, peer);
      note(c.ok ? nameOf(p.owner) + ' is calling you on AgentX Voice.' + (c.body.busy ? ' You look busy: it waits for you.' : '') : 'No call: ' + c.error);
    } else if (kind === 'space') {
      var w = $('wdo-with') && $('wdo-with').value;
      note('Starting the Space…');
      // A Space always runs here, where the owner listens: no peer.
      var s = await act('POST', '/api/admin/wall/space', { id: p.id, agent: p.owner, with: w, topic: p.headline || p.id, context: (p.need || '').slice(0, 1500) });
      if (!s.ok) { note('No Space: ' + s.error); return; }
      note('');
      S.space = s.body;
      S.spaceTopic = p.headline || p.id;
      paintSpace();
      pollSpace();
    } else if (kind === 'space-say') {
      var said = ($('wdo-say') && $('wdo-say').value || '').trim();
      if (!said) return;
      var y = await act('POST', '/api/admin/wall/space/say', { text: said });
      if (!y.ok) { note('Not heard: ' + y.error); return; }
      $('wdo-say').value = '';
    } else if (kind === 'space-stop') {
      await act('POST', '/api/admin/wall/space/stop', {});
      S.space = null;
      paintSpace();
    }
  }
  function spaceHtml() {
    var t = S.space;
    if (!t || t.active === false || t.kind !== 'talk') return '';
    var lines = (t.transcript || []).slice(-12).map(function (x) { return '<li><b>' + esc(x.name) + '</b> ' + md(x.text) + '</li>'; }).join('');
    return '<section class="wsp" aria-label="Space">' +
      '<header><span class="ax-badge ax-badge--live">Live</span> <b>Space</b>' + (S.spaceTopic ? ' · ' + esc(S.spaceTopic) : '') + '</header>' +
      (lines ? '<ol class="wsp__t">' + lines + '</ol>' : '<p class="wdo__n">They are starting…</p>') +
      '<div class="wdo__row"><input id="wdo-say" class="wdo__t" maxlength="1000" placeholder="Say something into the Space">' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-act="space-say">Say</button>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-act="space-stop">End</button></div>' +
    '</section>';
  }
  /** Repaint only the Space, so what the owner types stays where it is. */
  function paintSpace() {
    var typed = $('wdo-say') && $('wdo-say').value;
    // On an open post, or on the Live page (#1355): whichever is shown.
    var el = S.page === 'live' && !S.post ? $('live-space') : $('wdo-space');
    if (!el) return;
    el.innerHTML = spaceHtml();
    if (typed && $('wdo-say')) $('wdo-say').value = typed;
  }
  function pollSpace() {
    if (S.spaceTimer) return;
    S.spaceTimer = setInterval(async function () {
      var r = await act('GET', '/api/admin/wall/space');
      S.space = r.ok ? r.body : S.space;
      if (!S.space || S.space.active === false || S.space.kind !== 'talk') { clearInterval(S.spaceTimer); S.spaceTimer = null; S.space = null; }
      paintSpace();
    }, 3000);
  }

  // --- The composer (#1355): a new post, to the agent its first @name picks ---
  function composeNote(text) { $('wc-note').textContent = text; }
  /** The agent a post is for: its first @name that is an agent, and its node. */
  function composeTarget(text) {
    var nodes = (S.live && S.live.nodes) || [];
    var names = (String(text).match(/@[A-Za-z0-9_.:-]+/g) || []).map(function (m) { return m.slice(1).replace(/[.:]+$/, ''); });
    for (var i = 0; i < names.length; i++) {
      for (var j = 0; j < nodes.length; j++) {
        var a = (nodes[j].agents || []).find(function (x) { return x.id === names[i] || (x.name || '').toLowerCase() === names[i].toLowerCase(); });
        // The first node is this one; an agent only on a peer goes there.
        if (a) return { id: a.id, name: a.name || a.id, peer: j === 0 ? null : nodes[j].url };
      }
    }
    return null;
  }
  async function compose() {
    // One post at a time: a double click or a second Enter would send it twice.
    if (S.posting) return;
    var text = ($('wc-text').value || '').trim();
    if (!text) { composeNote('Write the post first.'); return; }
    var to = composeTarget(text);
    if (!to) { composeNote(S.live ? 'Pick who it is for: put @ and an agent\'s name in the post.' : 'Still loading the agents…'); return; }
    composeNote('Posting to ' + to.name + '…');
    S.posting = true; $('wc-post').disabled = true;
    var r = await act('POST', '/api/admin/wall/post', { agent: to.id, text: text }, to.peer);
    S.posting = false; $('wc-post').disabled = false;
    if (!r.ok) { composeNote('Not posted: ' + r.error); return; }
    $('wc-text').value = '';
    composeNote(r.body.message || 'Posted.');
    load();
  }

  // --- Agents page (#1316): every agent the nodes report, with its posts ---
  function allAgents() {
    var by = {};
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      (n.agents || []).forEach(function (a) {
        var x = by[a.id] || (by[a.id] = { id: a.id, name: a.name || a.id, nodes: [], running: 0, errors: 0, lastActive: 0 });
        x.nodes.push(n.name);
        x.running += (a.runningTasks || []).length;
        x.errors += a.errors || 0;
        x.tier = x.tier || a.tier; x.model = x.model || a.model;
        if (a.skillCount != null) x.skills = Math.max(x.skills || 0, a.skillCount);
        var at = Date.parse(a.lastActive || '') || 0;
        if (at > x.lastActive) { x.lastActive = at; x.summary = a.lastSummary; }
      });
    });
    agentStats().forEach(function (s) {
      (by[s.id] || (by[s.id] = { id: s.id, name: nameOf(s.id), nodes: [], running: 0, errors: 0, lastActive: 0 })).stats = s;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (x, y) {
      return y.running - x.running || ((y.stats && y.stats.open) || 0) - ((x.stats && x.stats.open) || 0) || (x.name > y.name ? 1 : x.name < y.name ? -1 : 0);
    });
  }
  function agentsPageHtml() {
    var list = allAgents();
    var down = ((S.live && S.live.nodes) || []).filter(function (n) { return !n.reachable || n.error; });
    var note = down.length ? '<p class="ax-wall__count wag__note">' + esc(down.map(function (n) { return n.name; }).join(', ')) + (down.length === 1 ? ' does' : ' do') + ' not answer: agents only there are missing.</p>' : '';
    if (!list.length) return note + '<p class="ax-wall__empty">' + (S.live ? 'No node reports an agent.' : 'Loading…') + '</p>';
    var called = S.callNote ? '<p class="wdo__n wag__note" role="status">' + esc(S.callNote) + '</p>' : '';
    return note + called + list.map(function (a) {
      var s = a.stats || { open: 0, owner: 0, done: 0, runs: 0, posts: 0 };
      var meta = [
        a.nodes.length ? 'on ' + a.nodes.map(esc).join(', ') : 'no node answering',
        a.tier ? 'tier <b>' + esc(a.tier) + '</b>' : '',
        a.model ? 'model <b>' + esc(a.model) + '</b>' : '',
        a.skills != null ? a.skills + (a.skills === 1 ? ' skill' : ' skills') : '',
        a.lastActive ? 'last active ' + when(a.lastActive) : '',
      ].filter(Boolean).map(function (x) { return '<span>' + x + '</span>'; }).join('');
      return '<article class="wag" id="agent-' + esc(a.id) + '">' + avatar(a.id) + '<div class="wag__b">' +
        '<div class="wp__by"><button type="button" class="name" data-agent="' + esc(a.id) + '">' + esc(a.name) + '</button><span class="h">@' + esc(a.id) + '</span>' +
          (a.running ? '<span class="chip state">running ' + a.running + '</span>' : '') + '</div>' +
        orgLineHtml(a.id) + '<div class="wp__meta">' + meta + '</div>' +
        '<div class="wpf__stats"><span><b>' + s.open + '</b> open</span><span><b>' + s.owner + '</b> waiting on the owner</span>' +
          '<span><b>' + s.done + '</b> done in 7 days</span><span><b>' + s.runs + '</b> runs</span>' +
          (a.errors ? '<span class="is-err"><b>' + a.errors + '</b> errors</span>' : '') + '</div>' +
        (a.summary && a.summary.text ? '<details class="wp__ask"><summary><span class="k">Last summary</span> ' + esc(a.summary.text) + '</summary><div class="ax-md">' + md(a.summary.text) + '</div></details>' : '') +
        (a.nodes.length ? '<div class="wag__acts">' + agentActsHtml(a.id) + '</div>' : '') +
        '<div class="wpf__links">' + (s.posts ? '<button type="button" class="wa-more" data-agent="' + esc(a.id) + '">' + s.posts + (s.posts === 1 ? ' post' : ' posts') + '</button>' : '<span class="ax-wall__count">No posts in 7 days</span>') +
          '<a href="/admin/agents/' + encodeURIComponent(a.id) + '">Agent page</a><a href="/agents/' + encodeURIComponent(a.id) + '/history">History</a></div>' +
        '</div></article>';
    }).join('');
  }

  // --- The nav: which page is on, and its counts (#1316) ---
  function runningCount() {
    var n = 0;
    ((S.live && S.live.nodes) || []).forEach(function (x) { (x.agents || []).forEach(function (a) { n += (a.runningTasks || []).length; }); });
    return n;
  }
  function jobCount() {
    var n = 0;
    ((S.live && S.live.nodes) || []).forEach(function (x) { n += (x.crons || []).length; });
    return n;
  }
  function navHtml(page, f) {
    var side = ['projects', 'jobs', 'reviews', 'failures', 'cost'].indexOf(S.view) >= 0;
    var on = page === 'post' ? 'wall' : page === 'task' ? 'live' : page === 'wall' ? (side ? S.view : f.status === 'waiting_owner' ? 'needs' : 'wall') : page;
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      var me = a.getAttribute('data-nav') === on;
      a.classList.toggle('is-on', me);
      if (me) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var posts = S.data && S.data.posts;
    var counts = {
      wall: posts ? posts.filter(isOpen).length : null,
      needs: posts ? posts.filter(waitsOnOwner).length : null,
      running: S.live ? runningCount() : null,
      agents: S.live || posts ? allAgents().length : null,
      projects: S.data && S.data.projects ? S.data.projects.length : null,
      jobs: S.live ? jobCount() : null,
      live: liveCount(),
    };
    var title = { wall: 'open posts', needs: 'posts waiting on you', running: 'tasks running now', agents: 'agents', projects: 'projects with open work', jobs: 'recurring jobs', live: 'live sessions' };
    Object.keys(counts).forEach(function (k) {
      var el = $('nav-n-' + k), n = counts[k];
      el.textContent = n == null ? '' : String(n);
      el.classList.toggle('is-zero', !n);
      el.setAttribute('title', n == null ? '' : n + ' ' + title[k]);
    });
    var named = { projects: 'Projects', jobs: 'Jobs', reviews: 'Reviews', failures: 'Failures', cost: 'Cost', needs: 'Needs you' };
    $('wall-title').textContent = page === 'post' ? 'Post' : page === 'running' ? 'Running now' : page === 'agents' ? 'Agents' : page === 'people' ? 'People' : page === 'creator' ? 'New post' : page === 'live' ? 'Live' : page === 'task' ? 'Task' : named[on] || 'Wall';
  }

  // --- List: the table itself is in wall-pages.client.ts (#1355) ---
  function sortVal(p, k) {
    return k === 'idle' ? idleDays(p) : k === 'runs' ? p.runs : k === 'time' ? p.runMs : k === 'owner' ? p.owner
      : k === 'project' ? (p.project || '') : k === 'node' ? p.node.name : k === 'blocked' ? (p.blocked ? p.blocked.who : '')
      : k === 'state' ? p.state : p.headline;
  }
  // --- Blocked, grouped by what blocks it (#1193) ---
  // Only blockers a record names (a hand-off, another agent's plan step,
  // the owner, an outside person) are grouped; the rest are "No blocker
  // recorded". By project, an agent blocker goes under its own project.
  function blockKey(p, by) {
    var b = p.blockedBy;
    if (!b) return { key: '~none', label: 'No blocker recorded' };
    if (b.kind === 'owner') return { key: '~owner', label: 'The owner' };
    if (b.kind === 'person') return { key: 'person:' + b.who, label: b.who + ' (outside person)' };
    if (by === 'agent') return { key: 'agent:' + b.who, label: '@' + b.who };
    return b.project ? { key: 'project:' + b.project, label: b.project } : { key: '~noproject', label: 'Agents with no project' };
  }
  function blocksHtml(posts, by) {
    var groups = {}, order = [];
    posts.forEach(function (p) {
      var k = blockKey(p, by);
      if (!groups[k.key]) { groups[k.key] = { label: k.label, posts: [] }; order.push(k.key); }
      groups[k.key].posts.push(p);
    });
    // Named blockers first, oldest block first; then the owner, agents
    // with no project, and last the posts with no recorded blocker.
    var LAST = ['~owner', '~noproject', '~none'];
    function oldest(g) { return Math.min.apply(null, g.posts.map(function (p) { return p.blocked.since; })); }
    order.sort(function (a, b) {
      var x = LAST.indexOf(a), y = LAST.indexOf(b);
      return x !== y ? x - y : oldest(groups[a]) - oldest(groups[b]);
    });
    return order.map(function (k) {
      var g = groups[k];
      g.posts.sort(function (a, b) { return a.blocked.since - b.blocked.since; });
      return '<h3>' + esc(g.label) + ' <small>(' + g.posts.length + ')</small></h3>' +
        '<table class="wl"><thead><tr><th>Post</th><th>Owner</th><th>Project</th><th>Blocked by</th><th>Since</th></tr></thead><tbody>' +
        g.posts.map(function (p) {
          var b = p.blockedBy;
          return '<tr><td><a href="#" data-open="' + esc(p.id) + '">' + esc(p.headline) + '</a></td><td>' + esc(p.owner) + '</td><td>' + esc(p.project || '—') + '</td>' +
            '<td>' + (b ? esc(b.kind === 'agent' ? '@' + b.who : b.kind === 'owner' ? 'the owner' : b.who) + (b.crossProject ? ' <small class="chip chip--warn">other project</small>' : '') : '—') + '</td>' +
            '<td>' + ago(p.blocked.since) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).join('');
  }

  // --- Projects (#1190): one row per project, each count a link to the list ---
  function projectHref(project, status) {
    var q = new URLSearchParams();
    q.set('status', status);
    q.set('project', project === null ? OTHER : project);
    q.set('view', 'list');
    return '#' + q.toString();
  }
  // --- Throughput (#1192): closures per week, oldest first, and a sparkline ---
  var SPARK = '▁▂▃▄▅▆▇█';
  function spark(ws) {
    var max = Math.max.apply(null, ws.concat([1]));
    return ws.map(function (n) { return n ? SPARK[Math.max(1, Math.min(7, Math.round(n / max * 7)))] : SPARK[0]; }).join('');
  }
  function throughputHtml() {
    if (!S.tp) return '<p class="ax-wall__count">Loading throughput…</p>';
    var t = S.tp.throughput;
    if (!t) return '<p class="ax-wall__empty">Throughput is not available.</p>';
    var head = t.weeks.map(function (w) { return '<th>' + esc(stamp(w.from).slice(0, 10)) + '</th>'; }).join('');
    function table(title, rows, name) {
      if (!rows.length) return '<p class="ax-wall__empty">No closures in the last four weeks.</p>';
      return '<table class="wl"><thead><tr><th>' + title + '</th>' + head + '<th>Total</th><th aria-hidden="true"></th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + name(r) + '</td>' + r.weeks.map(function (n) { return '<td class="num">' + n + '</td>'; }).join('') +
            '<td class="num">' + r.total + '</td><td aria-hidden="true">' + spark(r.weeks) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    return '<h3>Closed per week</h3><p class="ax-wall__count">Last four weeks, oldest first; each week is seven days.</p>' +
      table('Project', t.projects, function (r) { return r.project === null ? '<i>Other</i>' : esc(r.project); }) +
      table('Owner', t.owners, function (r) { return esc(r.owner); });
  }
  function loadThroughput() {
    if (S.tp !== undefined) return;
    S.tp = null;
    getJson('/api/admin/wall/throughput?peer=fleet').then(function (d) { S.tp = d; render(); }).catch(function () { S.tp = {}; render(); });
  }
  function projectsHtml() {
    loadThroughput();
    return projectCardsHtml() + capacityHtml(S.data && S.data.capacity) + throughputHtml();
  }

  // --- Failures: agent runs, cron runs, workflow runs ---
  function cronFailures() {
    var out = [], since = Date.now() - DAY;
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      var byJob = {};
      (n.cronRuns || []).forEach(function (r) {
        if (r.status === 'success' || Date.parse(r.startedAt) < since) return;
        var g = byJob[r.jobId] || (byJob[r.jobId] = { node: n, run: r, count: 0 });
        g.count++;
        if (Date.parse(r.startedAt) > Date.parse(g.run.startedAt)) g.run = r;
      });
      Object.keys(byJob).forEach(function (k) { out.push(byJob[k]); });
    });
    return out;
  }
  function workflowFailures() {
    var since = Date.now() - DAY;
    return ((S.wf && S.wf.runs) || []).filter(function (r) { return r.status === 'failed' && Date.parse(r.updatedAt) >= since; });
  }
  // Open issues a reporting job opened, one row per dedupe signature (#1186).
  // Absent unless a node sets wall.reportedIssues.
  function reportedHtml() {
    var all = (S.data && S.data.reported) || [];
    function forge(f) { return f === 'github' ? 'GitHub' : 'GitLab'; }
    return all.map(function (r) {
      var rows = (r.groups || []).map(function (g) {
        var link = /^https?:\/\//.test(g.url) ? ' · <a href="' + esc(g.url) + '" target="_blank" rel="noopener" title="' + esc(g.title) + '">' + esc(g.ref) + '</a>' : '';
        return '<li><b>' + esc(g.signature) + '</b> ×' + esc(g.count) + ', last seen ' + when(g.lastAt) + link + '</li>';
      });
      var notes = (r.unread || []).map(function (u) { return '<p class="ax-wall__empty">Couldn\'t read ' + esc(u.project) + ' on ' + forge(u.forge) + ': ' + esc(u.why) + '</p>'; })
        .concat((r.truncated || []).map(function (t) { return '<p class="ax-wall__empty">' + esc(t.project) + ' on ' + forge(t.forge) + ': only the newest 100 issues are grouped.</p>'; }));
      var title = 'Reported issues labelled ' + esc(r.label) + (all.length > 1 && r.node ? ' on ' + esc(r.node.name) : '');
      return '<div class="wf"><h3>' + title + '</h3>' + (rows.length ? '<ul>' + rows.join('') + '</ul>' : (r.unread || []).length ? '' : '<p class="ax-wall__empty">No open issues with this label.</p>') + notes.join('') + '</div>';
    }).join('');
  }
  function failuresHtml() {
    var runs = (S.data && S.data.failures) || [], crons = cronFailures(), wfs = workflowFailures();
    function block(title, rows, empty) { return '<div class="wf"><h3>' + title + '</h3>' + (rows.length ? '<ul>' + rows.join('') + '</ul>' : '<p class="ax-wall__empty">' + empty + '</p>') + '</div>'; }
    return block('Agent runs, last 24 h', runs.map(function (f) {
      return '<li><b>' + esc(f.agentId) + '</b> ' + (f.count > 1 ? '×' + f.count + ' ' : '') + esc(f.status) + ', last ' + when(f.lastAt) +
        ' · <a href="' + esc(taskHref(f.lastTaskId, f.agentId, f.node, true)) + '">last run</a><div class="err">' + esc(f.error) + '</div></li>';
    }), 'No failed agent runs.') +
    reportedHtml() +
    block('Cron runs, last 24 h', crons.map(function (g) {
      var r = g.run, job = (g.node.crons || []).find(function (j) { return j.id === r.jobId; });
      return '<li><b>' + esc(r.jobId) + '</b> on ' + esc(g.node.name) + ' ' + (g.count > 1 ? '×' + g.count + ' ' : '') + esc(r.status) + ', last ' + when(Date.parse(r.startedAt)) +
        (r.taskId && job ? ' · <a href="' + esc(taskHref(r.taskId, job.agent, { daemonUrl: g.node.url }, true)) + '">full log</a>' : '') +
        '<div class="err">' + esc(r.errorSummary || r.responseSummary || '') + '</div></li>';
    }), (S.live ? 'No failed cron runs.' : 'Loading…')) +
    block('Workflow runs, last 24 h', wfs.map(function (r) {
      var last = (r.history || []).filter(function (h) { return h.status === 'failed' || h.status === 'timeout'; }).pop();
      return '<li><b><a href="/workflows#' + encodeURIComponent(r.workflowId) + '">' + esc(r.workflowId) + '</a></b> run ' + esc(r.id) + ', ' + when(Date.parse(r.updatedAt)) +
        (last ? '<div class="err">' + esc(last.nodeId + ': ' + (last.error || last.status)) + '</div>' : '') + '</li>';
    }), (S.wf ? 'No failed workflow runs.' : 'Loading…'));
  }
  function failCount() {
    var runs = ((S.data && S.data.failures) || []).reduce(function (n, f) { return n + f.count; }, 0);
    return runs + cronFailures().reduce(function (n, g) { return n + g.count; }, 0) + workflowFailures().length;
  }

  // --- Happening now (#1355): one line per machine, who runs what ---
  function happeningHtml() {
    var live = (S.live && S.live.nodes) || [];
    if (!live.length) return '<p class="ax-wall__empty">Loading…</p>';
    return live.map(function (n) {
      var down = !n.reachable || n.error, running = [];
      (n.agents || []).forEach(function (a) { (a.runningTasks || []).forEach(function (t) { running.push((a.name || a.id) + ': ' + (t.messagePreview || '').slice(0, 60)); }); });
      var what = down ? 'does not answer' : running.length ? running[0] + (running.length > 1 ? ' · +' + (running.length - 1) + ' more' : '') : 'nothing running';
      return '<div class="wh' + (down ? ' is-down' : '') + '"><b>' + esc(n.name) + '</b><span title="' + esc(running.join('\n')) + '">' + esc(what) + '</span></div>';
    }).join('') + '<a class="wa-more" href="#page=running">See all running</a>';
  }

  // --- Running now, per node, with ops details ---
  function nodesHtml() {
    var wallNodes = (S.data && S.data.nodes) || [];
    var live = (S.live && S.live.nodes) || [];
    if (!live.length && !wallNodes.length) return '<p class="ax-wall__empty">Loading…</p>';
    var cards = live.map(function (n) {
      var running = [];
      (n.agents || []).forEach(function (a) {
        (a.runningTasks || []).forEach(function (t) { running.push({ a: a, t: t }); });
      });
      var down = !n.reachable || n.error;
      var crons = (n.cronRuns || []).filter(function (r) { return r.status !== 'success' && Date.parse(r.startedAt) >= Date.now() - DAY; }).length;
      var ops = [
        n.uptimeSec != null ? 'Up ' + Math.round(n.uptimeSec / 3600) + ' h' : '',
        n.inflight != null ? n.inflight + ' in flight' : '',
        n.restart && n.restart.state !== 'none' ? 'Restart ' + n.restart.state : '',
        crons ? crons + ' failed cron runs (24 h)' : '',
        n.stoppedTasks && n.stoppedTasks.length ? n.stoppedTasks.length + ' stopped tasks' : '',
        n.attachSessions && n.attachSessions.length ? n.attachSessions.length + ' attached sessions' : '',
        n.commit ? 'Commit ' + n.commit.slice(0, 8) : '',
      ].filter(Boolean);
      return '<div class="wn' + (down ? ' is-down' : '') + '"><header><b>' + esc(n.name) + '</b>' +
        '<span class="' + (down ? 'ax-badge ax-badge--err' : 'ax-badge ax-badge--live') + '">' + (down ? (n.stale ? 'unreachable, last data ' + esc(stamp(Date.parse(n.staleSince))) : 'unreachable') : 'up') + '</span></header>' +
        '<div class="ver">' + esc(n.version ? 'v' + n.version : 'version unknown') + '</div>' +
        (running.length ? '<ul>' + running.map(function (x) {
          var rid = x.t.traceId || x.t.id;
          var conc = ((S.live && S.live.concurrent) || []).filter(function (o) { return o.runs.indexOf(rid) >= 0; });
          return '<li' + (conc.length ? ' class="is-concurrent"' : '') + '><a href="' + esc(wallTaskHref(x.t, x.a.id, n.url)) + '"><b>' + esc(x.a.name || x.a.id) + '</b> ' + esc((x.t.messagePreview || '').slice(0, 90)) + '</a> <small>since ' + esc(stamp(Date.parse(x.t.startedAt))) + '</small>' +
            conc.map(function (o) { return concHtml(o, function (id) { return esc(id); }); }).join('') + '</li>';
        }).join('') + '</ul>' : '<div class="idle">' + (down ? (n.error ? esc(n.error) : '') : 'Nothing running.') + '</div>') +
        (ops.length ? '<details><summary>Ops details</summary>' + ops.map(esc).join(' · ') + '</details>' : '') + '</div>';
    });
    wallNodes.filter(function (w) { return !w.ok; }).forEach(function (w) {
      cards.push('<div class="wn is-down"><header><b>' + esc(w.name) + '</b><span class="ax-badge ax-badge--err">posts not shown</span></header><div class="idle">' + esc(w.error || 'unreachable') + '</div></div>');
    });
    return cards.join('');
  }

  // --- Render ---
  function render() {
    // Running now draws from /api/live alone: it does not wait on the feed (#1252).
    $('wall-nodes').innerHTML = happeningHtml();
    var f = current();
    var page = S.post ? 'post' : S.page, onWall = page === 'wall';
    var posts_ = onWall && (S.view === 'feed' || S.view === 'list');
    navHtml(page, f);
    $('wall-back').hidden = page !== 'post';
    // Status tabs, search and the Feed / List switch belong to the posts (#1355).
    $('wall-views').hidden = !posts_;
    $('wall-switch').hidden = !posts_;
    $('wall-filters').hidden = !posts_;
    $('wall-compose').hidden = !(onWall && S.view === 'feed');
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      var me = b.getAttribute('data-tab') === f.status;
      b.classList.toggle('is-on', me);
      b.setAttribute('aria-selected', me ? 'true' : 'false');
    });
    $('wall-post').hidden = page !== 'post';
    $('wall-running').hidden = page !== 'running';
    // On its own page, Running now leaves the side column.
    $('wall-nodes').parentNode.hidden = page === 'running';
    $('wall-agents-page').hidden = page !== 'agents';
    $('wall-creator').hidden = page !== 'creator';
    $('wall-live').hidden = page !== 'live';
    $('wall-task').hidden = page !== 'task';
    paintTask(page);
    followLive(page);
    // Live repaints with the snapshot, but not over a field in use.
    if (page === 'live') {
      var busy = document.activeElement && document.activeElement.id && /^(lv-|wdo-say)/.test(document.activeElement.id);
      if (!busy) $('wall-live').innerHTML = livePageHtml();
    }
    // The Creator keeps what is typed: a refresh does not repaint a field in use.
    if (page === 'creator') {
      var typing = document.activeElement && document.activeElement.id && /^cr-/.test(document.activeElement.id);
      if (S.creator && S.creator.fresh) { S.creator.fresh = false; $('wall-creator').innerHTML = creatorHtml(); }
      else if (!typing) { creatorRead(); $('wall-creator').innerHTML = creatorHtml(); }
    }
    if (page === 'post') $('wall-post').innerHTML = postPageHtml();
    if (page === 'running') $('wall-running').innerHTML = nodesHtml();
    if (page === 'agents') $('wall-agents-page').innerHTML = agentsPageHtml();
    // The People page (#1441): wall-people.client.ts.
    renderPeople(page);
    if (!onWall) ['wall-feed', 'wall-list', 'wall-failures', 'wall-projects', 'wall-jobs', 'wall-reviews', 'wall-cost', 'wall-profile', 'wall-goal', 'wall-count'].forEach(function (id) { $(id).hidden = true; });
    if (!S.data) return;
    var posts = (S.data.posts || []).filter(function (p) { return match(p, f); });
    $('wall-count').textContent = posts.length + ' of ' + (S.data.posts || []).length + ' posts';
    // Opened from a person on the People page (#1441): say whose requests these are.
    if (f.asker) $('wall-count').innerHTML += '<span class="ax-wall__asker"> asked by ' + esc(personName(f.asker)) + ' · <button type="button" data-asker-clear>everyone</button></span>';
    document.querySelector('.ax-wall').classList.toggle('is-wide', S.view === 'list');
    $('wall-agents').innerHTML = agentsHtml();
    var n = failCount();
    $('wall-fail-n').textContent = n ? String(n) : '';
    $('wall-fail-n').classList.toggle('is-zero', !n);
    var synced = S.data.syncedAt;
    $('wall-synced').textContent = stamp(synced);
    $('wall-synced').setAttribute('datetime', new Date(synced).toISOString());
    $('wall-synced').parentNode.classList.toggle('is-stale', Date.now() - synced > 120000);
    if (!onWall) { renderReviews(''); renderCost(''); return; }
    var side = S.view === 'failures' || S.view === 'projects' || S.view === 'jobs';
    $('wall-profile').hidden = !f.owner || side;
    if (f.owner) $('wall-profile').innerHTML = profileHtml(f.owner);
    $('wall-goal').hidden = !f.goal || side;
    if (f.goal) $('wall-goal').innerHTML = goalHtml(f.goal, posts.length);
    $('wall-feed').hidden = S.view !== 'feed';
    $('wall-list').hidden = S.view !== 'list';
    $('wall-failures').hidden = S.view !== 'failures';
    $('wall-projects').hidden = S.view !== 'projects';
    $('wall-jobs').hidden = S.view !== 'jobs';
    $('wall-count').hidden = side;
    if (S.view === 'feed') $('wall-feed').innerHTML = posts.length ? posts.map(function (p) { return postHtml(p); }).join('') : '<p class="ax-wall__empty">No posts match these filters.</p>';
    if (S.view === 'list') $('wall-list').innerHTML = listBarHtml(f) + (!posts.length ? '<p class="ax-wall__empty">No posts match these filters.</p>'
      : f.status === 'blocked' && f.by ? blocksHtml(posts, f.by) : listHtml(posts));
    if (S.view === 'failures') $('wall-failures').innerHTML = failuresHtml();
    if (S.view === 'projects') $('wall-projects').innerHTML = projectsHtml();
    // Recurring jobs with their value line (#1183): cron-value.ts.
    if (S.view === 'jobs') $('wall-jobs').innerHTML = jobsPageHtml();
    renderReviews(S.view);
    // The Cost page (#1423): wall-cost.client.ts.
    renderCost(S.view);
  }
  function setView(v, quiet) {
    S.view = v;
    if (!quiet) { S.page = 'wall'; S.post = ''; }
    document.querySelectorAll('[data-view]').forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-view') === v); b.setAttribute('aria-selected', b.getAttribute('data-view') === v ? 'true' : 'false'); });
    if (!quiet) writeHash();
    render();
  }

  async function getJson(url, peer) {
    var r = await fetch(url, { headers: headers(peer) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function load() {
    // The quick reads go out first and draw as each answers; the feed is
    // the slow one and keeps its own "Loading…" (#1252).
    getJson('/api/live').then(function (d) { S.live = d; render(); }).catch(function () { S.live = { nodes: [] }; render(); });
    refreshReviews();
    refreshCost();
    refreshPeople();
    getJson('/api/admin/org').then(function (d) { S.org = d; render(); }).catch(function () { S.org = {}; render(); });
    // Month spend vs cap for the agent profile (#1393): the same read as the Cost page.
    getJson('/api/admin/observability/budgets').then(function (d) { S.budgets = d; render(); }).catch(function () { S.budgets = null; });
    getJson('/api/workflows/runs?summary=1&limit=100').then(function (d) { S.wf = d; render(); }).catch(function () { S.wf = { runs: [] }; render(); });
    try {
      S.data = await getJson('/api/admin/wall?peer=fleet&days=7');
      var posts = S.data.posts || [];
      fillSelect('f-owner', uniq(posts.map(function (p) { return p.owner; })));
      fillSelect('f-load', uniq(((S.data.capacity && S.data.capacity.owners) || []).map(function (r) { return r.owner; })));
      var other = posts.some(function (p) { return !p.project; }) ? [OTHER] : [];
      fillSelect('f-project', uniq(posts.map(function (p) { return p.project; })).concat(other), function (v) { return v === OTHER ? 'Other (no project)' : v; });
      var goalIds = uniq(((S.data.goals || []).map(function (g) { return g.id; })).concat(posts.map(function (p) { return p.goal && p.goal.id; })));
      fillSelect('f-goal', goalIds, goalTitle);
      fillSelect('f-node', uniq(posts.map(function (p) { return p.node.name; })));
      fillSelect('f-group', uniq(posts.map(groupKey)));
      fillAsker();
      applyHash();
    } catch (e) {
      $('wall-feed').innerHTML = '<p class="ax-wall__empty">Could not load the Wall: ' + esc(e.message) + '. The classic pages above still work.</p>';
    }
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act],[data-tab],[data-view],[data-thread],[data-more],[data-sort],[data-open],[data-agent],[data-agents-more],[data-profile-clear],[data-goal],[data-goal-clear],[data-back],[data-post]');
    if (!t) return;
    if (t.hasAttribute('data-act')) { doAct(t.getAttribute('data-act')); return; }
    if (t.hasAttribute('data-tab')) { $('f-status').value = t.getAttribute('data-tab'); writeHash(); render(); return; }
    if (t.hasAttribute('data-post')) {
      // A tap on the post itself opens it; its links, buttons and the
      // request summary keep their own job, and selecting text opens nothing.
      var inner = ev.target.closest('a,button,summary,input,select');
      if (inner && !inner.hasAttribute('data-post')) return;
      if (window.getSelection && String(window.getSelection())) return;
      openPost(t.getAttribute('data-post'));
    }
    else if (t.hasAttribute('data-back')) closePost();
    else if (t.hasAttribute('data-agent')) showAgent(t.getAttribute('data-agent'));
    else if (t.hasAttribute('data-agents-more')) { S.allAgents = !S.allAgents; render(); }
    else if (t.hasAttribute('data-profile-clear')) { $('f-owner').value = ''; writeHash(); render(); }
    else if (t.hasAttribute('data-goal')) { ev.preventDefault(); showGoal(t.getAttribute('data-goal')); }
    else if (t.hasAttribute('data-goal-clear')) { $('f-goal').value = ''; writeHash(); render(); }
    else if (t.hasAttribute('data-view')) setView(t.getAttribute('data-view'));
    else if (t.hasAttribute('data-thread')) toggleThread(t.getAttribute('data-thread'));
    else if (t.hasAttribute('data-more')) {
      var list = t.parentNode.querySelector('[data-more-list="' + t.getAttribute('data-more') + '"]');
      if (list) { list.hidden = !list.hidden; t.textContent = t.textContent.replace(list.hidden ? 'hide' : 'show all', list.hidden ? 'show all' : 'hide'); }
    } else if (t.hasAttribute('data-sort')) {
      var k = t.getAttribute('data-sort');
      S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : -1 };
      render();
    } else if (t.hasAttribute('data-open')) {
      // A post's time is a link: with a modifier key it opens in a new tab.
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
      ev.preventDefault();
      openPost(t.getAttribute('data-open'));
    }
  });
  // A comment being written survives the feed's refresh.
  document.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'wdo-text' && S.post) S.drafts[S.post] = ev.target.value; });
  // Keyboard: Enter on a post opens it, Escape goes back to the feed.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && ev.target.hasAttribute && ev.target.hasAttribute('data-post')) { ev.preventDefault(); openPost(ev.target.getAttribute('data-post')); }
    else if (ev.key === 'Escape' && S.post && !(ev.target && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName))) closePost();
  });
  FILTERS.forEach(function (k) {
    $('f-' + k).addEventListener(k === 'q' ? 'input' : 'change', function () { writeHash(); render(); });
  });
  $('wall-refresh').addEventListener('click', load);
  // The search button opens the filters, with the search box first (#1355).
  $('wall-search').addEventListener('click', function () {
    var open = $('wall-filters').classList.toggle('is-open');
    $('wall-search').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && $('f-q').focus) $('f-q').focus();
  });
  $('wall-compose').addEventListener('submit', function (ev) { ev.preventDefault(); compose(); });
  $('v-save').addEventListener('click', function () {
    writeHash();
    try { localStorage.setItem(SAVED_KEY, location.hash); $('v-save').textContent = 'Saved'; setTimeout(function () { $('v-save').textContent = 'Save as my view'; }, 1500); } catch (e) { /* private mode: nothing kept */ }
  });
  $('v-mine').addEventListener('click', function () {
    var h = null;
    try { h = localStorage.getItem(SAVED_KEY); } catch (e) { h = null; }
    if (!h) { $('v-mine').textContent = 'No saved view yet'; setTimeout(function () { $('v-mine').textContent = 'My view'; }, 1500); return; }
    history.replaceState(null, '', h);
    applyHash();
  });
  // openPost applies its own hash; skip the hashchange that follows it.
  window.addEventListener('hashchange', function () { if (location.hash !== S.applied) applyHash(); });

  // A link from the classic task page: /wall?task=<id> opens that post's thread.
  var fromTask = new URLSearchParams(location.search).get('task');
  load().then(function () {
    if (!fromTask || !S.data) return;
    fetch('/api/admin/wall/thread?task=' + encodeURIComponent(fromTask), { headers: headers() }).then(function (r) { return r.ok ? r.json() : null; }).then(function (b) {
      if (!b || !b.post) return;
      S.threads[b.post.id] = { events: b.events || [] };
      // Kept aside too, so a refresh that no longer lists it still shows it.
      if (!findPost(b.post.id)) S.extra = Object.assign({}, b.post, { node: { name: S.data.node, peer: null, daemonUrl: null } });
      S.post = b.post.id;
      writeHash();
      render();
    });
  });
  setInterval(function () { if (!document.hidden) load(); }, 60000);
})();
`
