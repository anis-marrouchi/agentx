// --- Wall page script (#1180) ---
//
// Reads only: /api/admin/wall?peer=fleet (posts across the mesh),
// /api/admin/wall/thread (one post's timeline, sent to the node that owns
// it), /api/live (what runs on each node now, with its ops details) and
// /api/workflows/runs (failed workflow runs). Pending owner decision
// cards (#1185) come with their post and are shown without buttons:
// answering stays on the Desk. Filters live in the URL
// hash, so a view is a link; "Save as my view" keeps that link in this
// browser only. Nothing is written to the daemon. The Projects view
// (#1190) shows the overview rows the reply carries, one per project;
// each count links to the list with that project and status in the hash.

export const WALL_PAGE_SCRIPT = String.raw`
(function () {
  var OPEN = ['in_progress', 'waiting_owner', 'waiting_other', 'needs_attention'];
  var DAY = 864e5;
  var FILTERS = ['owner', 'status', 'idle', 'project', 'node', 'group', 'time', 'conc', 'qa', 'q'];
  var SAVED_KEY = 'ax.wall.myView';
  /** The project filter's value for work with no project: "Other". */
  var OTHER = '-';
  var S = { data: null, live: null, wf: null, view: 'feed', sort: { key: 'idle', dir: -1 }, threads: {} };
  var $ = function (id) { return document.getElementById(id); };

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
  function taskHref(taskId, agentId, node, done) {
    var q = '?agent=' + encodeURIComponent(agentId);
    if (node && node.daemonUrl) q += '&node=' + encodeURIComponent(node.daemonUrl);
    if (done) q += '&archived=1';
    return '/tasks/' + encodeURIComponent(taskId) + q;
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
    return f;
  }
  function writeHash() {
    var q = new URLSearchParams();
    FILTERS.forEach(function (k) {
      var el = $('f-' + k), v = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
      if (v || k === 'status') q.set(k, v);
    });
    if (S.view !== 'feed') q.set('view', S.view);
    history.replaceState(null, '', '#' + q.toString());
  }
  function applyHash() {
    var f = readHash();
    FILTERS.forEach(function (k) {
      var el = $('f-' + k);
      if (el.type === 'checkbox') el.checked = f[k] === '1';
      else el.value = f[k];
    });
    setView(S.view, true);
  }
  function current() {
    var f = {};
    FILTERS.forEach(function (k) { var el = $('f-' + k); f[k] = el.type === 'checkbox' ? el.checked : el.value; });
    return f;
  }
  function match(p, f) {
    if (f.owner && p.owner !== f.owner) return false;
    if (f.status === 'open' && !isOpen(p)) return false;
    if (f.status === 'closed' && isOpen(p)) return false;
    if (f.status === 'blocked' && !p.blocked) return false;
    if (f.status === 'waiting_owner' && !waitsOnOwner(p)) return false;
    if (f.status === 'stalled' && !p.stalled) return false;
    if (f.status && ['open', 'closed', 'blocked', 'waiting_owner', 'stalled'].indexOf(f.status) < 0 && p.state !== f.status) return false;
    if (+f.idle && idleDays(p) < +f.idle) return false;
    if (f.project && (f.project === OTHER ? p.project : p.project !== f.project)) return false;
    if (f.node && p.node.name !== f.node) return false;
    if (f.group && groupKey(p) !== f.group) return false;
    if (f.time && !p.timeFlag && !forgeFlags(p).length) return false;
    if (f.conc && !(p.concurrent && p.concurrent.length)) return false;
    if (f.qa && !p.awaitingQa) return false;
    if (f.q) {
      var hay = [p.headline, p.owner, p.id, p.project, p.home && p.home.link, p.askedBy]
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
  // Forge home (#1184): its live state, who closed it, when that was checked.
  function forgeName(f) { return f.provider === 'github' ? 'GitHub' : 'GitLab'; }
  function forgeStateHtml(f) {
    var checked = f.checkedAt ? ' <small>checked ' + ago(f.checkedAt) + '</small>' : '';
    if (f.unknown) return forgeName(f) + ' <b title="' + esc(f.unknown) + '">state unknown</b>' + checked;
    return forgeName(f) + ' <b>' + esc(f.state) + '</b>' + (f.closedBy ? ' by <b>' + esc(f.closedBy) + '</b>' : '') +
      (f.closedAt && f.state !== 'open' ? ' ' + when(f.closedAt) : '') + checked;
  }
  // Closed on the forge while the post is still open: nobody should pick it up.
  function forgeClosedOpen(p) { return p.forgeState && !p.forgeState.unknown && p.forgeState.state !== 'open' && isOpen(p); }
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
  function postHtml(p) {
    var multi = S.data && S.data.nodes && S.data.nodes.length > 1;
    var conc = p.concurrent || [];
    var cls = 'wp' + (p.blocked ? ' is-blocked' : '') + (p.failedRuns ? ' is-failed' : '') + (conc.length ? ' is-concurrent' : '');
    // Author line: name, @handle, time, as on a social feed; the status as a chip.
    var by = '<button type="button" class="name" data-agent="' + esc(p.owner) + '">' + esc(nameOf(p.owner)) + '</button>' +
      '<span class="h">@' + esc(p.owner) + '</span><span aria-hidden="true">·</span>' + shortTime(p.lastMoveAt) +
      (multi ? '<span aria-hidden="true">·</span><span>' + esc(p.node.name) + '</span>' : '') + stateBadge(p.state);
    var via = [
      p.askedBy ? 'Asked by <b>' + esc(p.askedBy) + '</b>' : '',
      'in <b>' + esc(groupKey(p)) + '</b>',
      p.project ? 'project <b>' + esc(p.project) + '</b>' : '',
    ].filter(Boolean).join(' · ');
    var meta = [
      'Opened ' + when(p.createdAt),
      'Last move ' + when(p.lastMoveAt),
      p.closedAt ? 'Closed ' + when(p.closedAt) : '',
      p.estimateMinutes ? 'Estimate <b>' + p.estimateMinutes + ' min</b>' : '',
      p.forgeState ? forgeStateHtml(p.forgeState) : '',
      p.forgeTime ? 'GitLab time <b' + (p.forgeTime.unknown ? ' title="' + esc(p.forgeTime.unknown) + '"' : '') + '>' + esc(forgeTimeText(p.forgeTime, true)) + '</b>' : '',
    ].filter(Boolean).map(function (x) { return '<span>' + x + '</span>'; }).join('');
    // Action row: thread, runs, minutes, then the links out.
    var acts = [
      '<button type="button" data-thread="' + esc(p.id) + '" aria-expanded="' + (S.threads[p.id] ? 'true' : 'false') + '">' + ICON.reply + (S.threads[p.id] ? 'Hide thread' : 'Thread') + '</button>',
      '<span title="Runs that worked on it"' + (p.failedRuns ? ' class="is-err"' : '') + '>' + ICON.runs + p.runs + (p.runs === 1 ? ' run' : ' runs') + (p.failedRuns ? ', ' + p.failedRuns + ' failed' : '') + '</span>',
      p.runMs ? '<span title="Minutes the runs took">' + ICON.time + mins(p.runMs) + ' min</span>' : '',
    ];
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
    return '<article class="' + cls + '" id="post-' + esc(p.id) + '">' + avatar(p.owner) + '<div class="wp__b">' +
      '<div class="wp__by">' + by + '</div>' +
      '<div class="wp__via">' + via + '</div>' +
      '<p class="wp__title">' + esc(p.headline) + '</p>' +
      (p.blocked ? '<div class="wp__block">Waits on <b>' + esc(p.blocked.who) + '</b> since ' + when(p.blocked.since) + ' — ' + esc(p.blocked.why) + '</div>' : '') +
      (p.timeFlag ? '<div class="wp__flag">Time: ' + esc(p.timeFlag) + '</div>' : '') +
      (forgeClosedOpen(p) ? '<div class="wp__flag">' + esc(forgeName(p.forgeState)) + ' says ' + esc(p.forgeState.state) + (p.forgeState.closedBy ? ' by ' + esc(p.forgeState.closedBy) : '') + ', but this post is still open. Do not pick it up.</div>' : '') +
      (forgeFlags(p).length ? '<div class="wp__flag">GitLab time: ' + esc(forgeFlags(p).join('; ')) + '</div>' : '') +
      conc.map(function (o) { return concHtml(o, function (id, agent) { return '<a href="' + esc(taskHref(id, agent, p.node, true)) + '">' + esc(id) + '</a>'; }); }).join('') +
      cardsOf(p).map(cardHtml).join('') +
      (qaText(p) ? '<div class="wp__qa">QA: ' + esc(qaText(p)) + (p.awaitingQa && p.qa ? ' — new verdict asked' : '') + '</div>' : '') +
      '<div class="wp__meta">' + meta + '</div>' +
      '<div class="wp__acts">' + acts.filter(Boolean).join('') + '</div>' +
      '<div class="wp__thread" data-for="' + esc(p.id) + '">' + (S.threads[p.id] ? threadHtml(S.threads[p.id], p) : '') + '</div>' +
      '</div></article>';
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
      (e.text ? '<div class="txt">' + esc(e.text) + '</div>' : '') +
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
      '<h2>' + esc(nameOf(id)) + '</h2><div class="h">@' + esc(id) + (live ? ' · running now' : '') + '</div>' +
      '<div class="wpf__stats"><span><b>' + a.open + '</b> open</span><span><b>' + a.owner + '</b> waiting on the owner</span>' +
        '<span><b>' + a.done + '</b> done in 7 days</span><span><b>' + a.runs + '</b> runs on these</span></div>' +
      '<div class="wpf__links"><a href="/admin/agents/' + encodeURIComponent(id) + '">Agent page</a><a href="/agents/' + encodeURIComponent(id) + '/history">History</a></div></div>';
  }
  function showAgent(id) {
    $('f-owner').value = $('f-owner').value === id ? '' : id;
    if ($('f-owner').value === id) $('f-status').value = '';
    writeHash();
    render();
    var el = document.querySelector('.ax-wall__main');
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
  }
  async function toggleThread(id) {
    if (S.threads[id]) { delete S.threads[id]; render(); return; }
    var p = (S.data.posts || []).find(function (x) { return x.id === id; });
    if (!p) return;
    S.threads[id] = { loading: true };
    render();
    try {
      var r = await fetch('/api/admin/wall/thread?id=' + encodeURIComponent(id), { headers: headers(p.node && p.node.peer) });
      var body = await r.json();
      S.threads[id] = r.ok ? { events: body.events || [] } : { error: body.error || ('HTTP ' + r.status) };
    } catch (e) { S.threads[id] = { error: String(e && e.message || e) }; }
    render();
  }

  // --- List ---
  var COLS = [
    ['state', 'Status'], ['post', 'Post'], ['owner', 'Owner'], ['project', 'Project'], ['node', 'Node'],
    ['idle', 'Days since move'], ['blocked', 'Waits on'], ['time', 'Time / estimate'], ['runs', 'Runs'],
  ];
  function sortVal(p, k) {
    return k === 'idle' ? idleDays(p) : k === 'runs' ? p.runs : k === 'time' ? p.runMs : k === 'owner' ? p.owner
      : k === 'project' ? (p.project || '') : k === 'node' ? p.node.name : k === 'blocked' ? (p.blocked ? p.blocked.who : '')
      : k === 'state' ? p.state : p.headline;
  }
  function listHtml(posts) {
    var k = S.sort.key, dir = S.sort.dir;
    posts = posts.slice().sort(function (a, b) { var x = sortVal(a, k), y = sortVal(b, k); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    return '<table class="wl"><thead><tr>' + COLS.map(function (c) {
      return '<th data-sort="' + c[0] + '" aria-sort="' + (k === c[0] ? (dir > 0 ? 'ascending' : 'descending') : 'none') + '">' + c[1] + (k === c[0] ? (dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
    }).join('') + '</tr></thead><tbody>' + posts.map(function (p) {
      return '<tr><td>' + stateBadge(p.state) +
          (p.forgeState ? '<br><small' + (p.forgeState.unknown ? ' title="' + esc(p.forgeState.unknown) + '">' + esc(forgeName(p.forgeState)) + ' unknown' : '>' + esc(forgeName(p.forgeState)) + ' ' + esc(p.forgeState.state) + (p.forgeState.closedBy ? ' by ' + esc(p.forgeState.closedBy) : '')) + '</small>' +
            (forgeClosedOpen(p) ? ' <small title="Closed on the forge, still open here">⚠</small>' : '') : '') +
          (qaText(p, true) ? '<br><small' + (p.qa ? ' title="' + esc(qaText(p)) + '"' : '') + '>' + esc(p.awaitingQa ? 'Awaiting QA' : qaText(p, true)) + '</small>' : '') + '</td>' +
        '<td><a href="#" data-open="' + esc(p.id) + '">' + esc(p.headline) + '</a></td>' +
        '<td>' + esc(p.owner) + '</td><td>' + esc(p.project || '—') + '</td><td>' + esc(p.node.name) + '</td>' +
        '<td class="num">' + idleDays(p) + '</td>' +
        '<td>' + (p.blocked ? esc(p.blocked.who) + ' <small>(' + ago(p.blocked.since) + ')</small>' : cardsOf(p).length ? 'owner' : '—') +
          (cardsOf(p).length ? ' <small>card expires ' + until(cardsOf(p)[0].expiresAt) + '</small>' : '') + '</td>' +
        '<td>' + mins(p.runMs) + (p.estimateMinutes ? ' / ' + p.estimateMinutes : '') + ' min' + (p.timeFlag ? ' <small title="' + esc(p.timeFlag) + '">⚠</small>' : '') +
          (p.forgeTime ? '<br><small' + (p.forgeTime.unknown ? ' title="' + esc(p.forgeTime.unknown) + '"' : '') + '>GitLab ' + esc(forgeTimeText(p.forgeTime)) + '</small>' +
            (forgeFlags(p).length ? ' <small title="' + esc(forgeFlags(p).join('; ')) + '">⚠</small>' : '') : '') + '</td>' +
        '<td class="num">' + p.runs + (p.failedRuns ? ' <small>(' + p.failedRuns + ' failed)</small>' : '') +
        (p.concurrent && p.concurrent.length ? ' <small title="Concurrent runs: ' + esc(p.concurrent.map(function (o) { return o.runs.join(' + '); }).join(', ')) + '">⚠ concurrent</small>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  // --- Projects (#1190): one row per project, each count a link to the list ---
  function projectHref(project, status) {
    var q = new URLSearchParams();
    q.set('status', status);
    q.set('project', project === null ? OTHER : project);
    q.set('view', 'list');
    return '#' + q.toString();
  }
  function projectsHtml() {
    var rows = (S.data && S.data.projects) || [];
    if (!rows.length) return '<p class="ax-wall__empty">No open work.</p>';
    function cell(r, n, status) {
      return '<td class="num">' + (n ? '<a href="' + esc(projectHref(r.project, status)) + '">' + n + '</a>' : '0') + '</td>';
    }
    return '<p class="ax-wall__count">Open work on every node, by project. Stalled: no move for more than twice the project\'s normal rhythm.</p>' +
      '<table class="wl"><thead><tr><th>Project</th><th>Open</th><th>In progress</th><th>Blocked</th><th>Stalled</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + (r.project === null ? '<i>Other</i>' : esc(r.project)) + '</td>' + cell(r, r.open, 'open') + cell(r, r.inProgress, 'in_progress') +
          cell(r, r.blocked, 'blocked') + cell(r, r.stalled, 'stalled') + '</tr>';
      }).join('') + '</tbody></table>';
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
  function failuresHtml() {
    var runs = (S.data && S.data.failures) || [], crons = cronFailures(), wfs = workflowFailures();
    function block(title, rows, empty) { return '<div class="wf"><h3>' + title + '</h3>' + (rows.length ? '<ul>' + rows.join('') + '</ul>' : '<p class="ax-wall__empty">' + empty + '</p>') + '</div>'; }
    return block('Agent runs, last 24 h', runs.map(function (f) {
      return '<li><b>' + esc(f.agentId) + '</b> ' + (f.count > 1 ? '×' + f.count + ' ' : '') + esc(f.status) + ', last ' + when(f.lastAt) +
        ' · <a href="' + esc(taskHref(f.lastTaskId, f.agentId, f.node, true)) + '">last run</a><div class="err">' + esc(f.error) + '</div></li>';
    }), 'No failed agent runs.') +
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
          return '<li' + (conc.length ? ' class="is-concurrent"' : '') + '><a href="' + esc(taskHref(x.t.id, x.a.id, { daemonUrl: n.url }, false)) + '"><b>' + esc(x.a.name || x.a.id) + '</b> ' + esc((x.t.messagePreview || '').slice(0, 90)) + '</a> <small>since ' + esc(stamp(Date.parse(x.t.startedAt))) + '</small>' +
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
    if (!S.data) return;
    var f = current();
    var posts = (S.data.posts || []).filter(function (p) { return match(p, f); });
    $('wall-count').textContent = posts.length + ' of ' + (S.data.posts || []).length + ' posts';
    document.querySelector('.ax-wall').classList.toggle('is-wide', S.view === 'list');
    $('wall-profile').hidden = !f.owner || S.view === 'failures' || S.view === 'projects';
    if (f.owner) $('wall-profile').innerHTML = profileHtml(f.owner);
    $('wall-agents').innerHTML = agentsHtml();
    $('wall-feed').hidden = S.view !== 'feed';
    $('wall-list').hidden = S.view !== 'list';
    $('wall-failures').hidden = S.view !== 'failures';
    $('wall-projects').hidden = S.view !== 'projects';
    $('wall-count').hidden = S.view === 'failures' || S.view === 'projects';
    if (S.view === 'feed') $('wall-feed').innerHTML = posts.length ? posts.map(postHtml).join('') : '<p class="ax-wall__empty">No posts match these filters.</p>';
    if (S.view === 'list') $('wall-list').innerHTML = posts.length ? listHtml(posts) : '<p class="ax-wall__empty">No posts match these filters.</p>';
    if (S.view === 'failures') $('wall-failures').innerHTML = failuresHtml();
    if (S.view === 'projects') $('wall-projects').innerHTML = projectsHtml();
    var n = failCount();
    $('wall-fail-n').textContent = n ? '(' + n + ')' : '';
    $('wall-nodes').innerHTML = nodesHtml();
    var synced = S.data.syncedAt;
    $('wall-synced').textContent = stamp(synced);
    $('wall-synced').setAttribute('datetime', new Date(synced).toISOString());
    $('wall-synced').parentNode.classList.toggle('is-stale', Date.now() - synced > 120000);
  }
  function setView(v, quiet) {
    S.view = v;
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
    try {
      S.data = await getJson('/api/admin/wall?peer=fleet&days=7');
      var posts = S.data.posts || [];
      fillSelect('f-owner', uniq(posts.map(function (p) { return p.owner; })));
      var other = posts.some(function (p) { return !p.project; }) ? [OTHER] : [];
      fillSelect('f-project', uniq(posts.map(function (p) { return p.project; })).concat(other), function (v) { return v === OTHER ? 'Other (no project)' : v; });
      fillSelect('f-node', uniq(posts.map(function (p) { return p.node.name; })));
      fillSelect('f-group', uniq(posts.map(groupKey)));
      applyHash();
    } catch (e) {
      $('wall-feed').innerHTML = '<p class="ax-wall__empty">Could not load the Wall: ' + esc(e.message) + '. The classic pages above still work.</p>';
    }
    getJson('/api/live').then(function (d) { S.live = d; render(); }).catch(function () { S.live = { nodes: [] }; render(); });
    getJson('/api/workflows/runs?summary=1&limit=100').then(function (d) { S.wf = d; render(); }).catch(function () { S.wf = { runs: [] }; render(); });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-view],[data-thread],[data-more],[data-sort],[data-open],[data-agent],[data-agents-more],[data-profile-clear]');
    if (!t) return;
    if (t.hasAttribute('data-agent')) showAgent(t.getAttribute('data-agent'));
    else if (t.hasAttribute('data-agents-more')) { S.allAgents = !S.allAgents; render(); }
    else if (t.hasAttribute('data-profile-clear')) { $('f-owner').value = ''; writeHash(); render(); }
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
      ev.preventDefault();
      var id = t.getAttribute('data-open');
      setView('feed');
      if (!S.threads[id]) toggleThread(id);
      setTimeout(function () { var el = $('post-' + id); if (el) el.scrollIntoView({ block: 'start' }); }, 50);
    }
  });
  FILTERS.forEach(function (k) {
    $('f-' + k).addEventListener(k === 'q' ? 'input' : 'change', function () { writeHash(); render(); });
  });
  $('wall-refresh').addEventListener('click', load);
  $('f-toggle').addEventListener('click', function () {
    var open = $('f-toggle').parentNode.classList.toggle('is-open');
    $('f-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  });
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
  window.addEventListener('hashchange', applyHash);

  // A link from the classic task page: /wall?task=<id> opens that post's thread.
  var fromTask = new URLSearchParams(location.search).get('task');
  load().then(function () {
    if (!fromTask || !S.data) return;
    fetch('/api/admin/wall/thread?task=' + encodeURIComponent(fromTask), { headers: headers() }).then(function (r) { return r.ok ? r.json() : null; }).then(function (b) {
      if (!b || !b.post) return;
      $('f-status').value = ''; $('f-q').value = b.post.id; writeHash();
      S.threads[b.post.id] = { events: b.events || [] };
      if (!(S.data.posts || []).some(function (p) { return p.id === b.post.id; })) S.data.posts.push(Object.assign({}, b.post, { node: { name: S.data.node, peer: null, daemonUrl: null } }));
      render();
    });
  });
  setInterval(function () { if (!document.hidden) load(); }, 60000);
})();
`
