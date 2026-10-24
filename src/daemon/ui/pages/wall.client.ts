// --- Wall page script (#1180) ---
//
// Reads only: /api/admin/wall?peer=fleet (posts across the mesh),
// /api/admin/wall/thread (one post's timeline, sent to the node that owns
// it), /api/live (what runs on each node now, with its ops details) and
// /api/workflows/runs (failed workflow runs). Filters live in the URL
// hash, so a view is a link; "Save as my view" keeps that link in this
// browser only. Nothing is written to the daemon.

export const WALL_PAGE_SCRIPT = String.raw`
(function () {
  var OPEN = ['in_progress', 'waiting_owner', 'waiting_other', 'needs_attention'];
  var DAY = 864e5;
  var FILTERS = ['owner', 'status', 'idle', 'project', 'node', 'group', 'time', 'q'];
  var SAVED_KEY = 'ax.wall.myView';
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
  function mins(ms) { return Math.round((ms || 0) / 60000); }
  function isOpen(p) { return OPEN.indexOf(p.state) >= 0; }
  function groupKey(p) { return p.group.channel + ' · ' + p.group.chatId; }
  function idleDays(p) { return Math.floor((Date.now() - p.lastMoveAt) / DAY); }
  function stateBadge(state) {
    var cls = state === 'needs_attention' ? 'ax-badge--err' : state === 'waiting_owner' ? 'ax-badge--warn'
      : state === 'done' ? 'ax-badge--live' : OPEN.indexOf(state) >= 0 ? 'ax-badge--accent' : 'ax-badge--ghost';
    return '<span class="ax-badge ' + cls + '">' + esc(state.replace(/_/g, ' ')) + '</span>';
  }
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
    if (f.status && ['open', 'closed', 'blocked'].indexOf(f.status) < 0 && p.state !== f.status) return false;
    if (+f.idle && idleDays(p) < +f.idle) return false;
    if (f.project && p.project !== f.project) return false;
    if (f.node && p.node.name !== f.node) return false;
    if (f.group && groupKey(p) !== f.group) return false;
    if (f.time && !p.timeFlag) return false;
    if (f.q) {
      var hay = [p.headline, p.owner, p.id, p.project, p.home && p.home.link, p.askedBy].join(' ').toLowerCase();
      if (hay.indexOf(f.q.toLowerCase()) < 0) return false;
    }
    return true;
  }
  function fillSelect(id, values) {
    var el = $(id), keep = el.value;
    el.innerHTML = '<option value="">All</option>' + values.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
    el.value = keep && values.indexOf(keep) >= 0 ? keep : '';
  }
  function uniq(xs) { return xs.filter(function (x, i) { return x && xs.indexOf(x) === i; }).sort(); }

  // --- Feed ---
  function postHtml(p) {
    var multi = S.data && S.data.nodes && S.data.nodes.length > 1;
    var cls = 'wp' + (p.blocked ? ' is-blocked' : '') + (p.failedRuns ? ' is-failed' : '');
    var meta = [
      'Owner <b><a href="/admin/agents/' + encodeURIComponent(p.owner) + '">' + esc(p.owner) + '</a></b>',
      p.askedBy ? 'Asked by <b>' + esc(p.askedBy) + '</b>' : '',
      'Group <b>' + esc(groupKey(p)) + '</b>',
      p.project ? 'Project <b>' + esc(p.project) + '</b>' : '',
      multi ? 'Node <b>' + esc(p.node.name) + '</b>' : '',
      'Opened ' + when(p.createdAt),
      'Last move ' + when(p.lastMoveAt),
      p.closedAt ? 'Closed ' + when(p.closedAt) : '',
      'Runs <b>' + p.runs + '</b>' + (p.failedRuns ? ' (' + p.failedRuns + ' failed)' : '') + (p.runMs ? ', ' + mins(p.runMs) + ' min' : ''),
      p.estimateMinutes ? 'Estimate <b>' + p.estimateMinutes + ' min</b>' : '',
    ].filter(Boolean).map(function (x) { return '<span>' + x + '</span>'; }).join('');
    var links = [];
    if (p.home) links.push('Home: ' + linkOrText(p.home.link));
    if (p.evidence) links.push('Proof: ' + linkOrText(p.evidence));
    if (p.lastRun) {
      links.push('<a href="' + esc(taskHref(p.lastRun.taskId, p.lastRun.agentId, p.node, !isOpen(p))) + '">Task record and trace</a>');
      links.push('<a href="/agents/' + encodeURIComponent(p.lastRun.agentId) + '/history">Agent history</a>');
    }
    links.push('<button type="button" data-thread="' + esc(p.id) + '" aria-expanded="' + (S.threads[p.id] ? 'true' : 'false') + '">' + (S.threads[p.id] ? 'Hide thread' : 'Thread') + '</button>');
    return '<article class="' + cls + '" id="post-' + esc(p.id) + '">' +
      '<div class="wp__head">' + stateBadge(p.state) + '<span class="wp__title">' + esc(p.headline) + '</span></div>' +
      (p.blocked ? '<div class="wp__block">Waits on <b>' + esc(p.blocked.who) + '</b> since ' + when(p.blocked.since) + ' — ' + esc(p.blocked.why) + '</div>' : '') +
      (p.timeFlag ? '<div class="wp__flag">Time: ' + esc(p.timeFlag) + '</div>' : '') +
      '<div class="wp__meta">' + meta + '</div>' +
      '<div class="wp__links">' + links.join('') + '</div>' +
      '<div class="wp__thread" data-for="' + esc(p.id) + '">' + (S.threads[p.id] ? threadHtml(S.threads[p.id], p) : '') + '</div>' +
      '</article>';
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
  function threadHtml(t, p) {
    if (t.loading) return '<p class="ax-wall__empty">Loading thread…</p>';
    if (t.error) return '<p class="ax-wall__empty">Thread not available: ' + esc(t.error) + '</p>';
    var groups = collapse(t.events);
    return '<ol class="wt">' + groups.map(function (g, gi) {
      var e = g.items[0], err = e.status === 'error' || e.status === 'timeout';
      var more = g.items.length > 1
        ? ' <button type="button" class="more" data-more="' + gi + '">×' + g.items.length + ' — show all</button><ol class="wt" hidden data-more-list="' + gi + '">' +
          g.items.map(function (x) { return '<li>' + eventHtml(x, p) + '</li>'; }).join('') + '</ol>'
        : '';
      return '<li class="' + (err ? 'is-err' : '') + '">' + eventHtml(e, p) + more + '</li>';
    }).join('') + '</ol>';
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
    ['idle', 'Days since move'], ['blocked', 'Waits on'], ['time', 'Run / estimate'], ['runs', 'Runs'],
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
      return '<tr><td>' + stateBadge(p.state) + '</td>' +
        '<td><a href="#" data-open="' + esc(p.id) + '">' + esc(p.headline) + '</a></td>' +
        '<td>' + esc(p.owner) + '</td><td>' + esc(p.project || '—') + '</td><td>' + esc(p.node.name) + '</td>' +
        '<td class="num">' + idleDays(p) + '</td>' +
        '<td>' + (p.blocked ? esc(p.blocked.who) + ' <small>(' + ago(p.blocked.since) + ')</small>' : '—') + '</td>' +
        '<td>' + mins(p.runMs) + (p.estimateMinutes ? ' / ' + p.estimateMinutes : '') + ' min' + (p.timeFlag ? ' <small title="' + esc(p.timeFlag) + '">⚠</small>' : '') + '</td>' +
        '<td class="num">' + p.runs + (p.failedRuns ? ' <small>(' + p.failedRuns + ' failed)</small>' : '') + '</td></tr>';
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
          return '<li><a href="' + esc(taskHref(x.t.id, x.a.id, { daemonUrl: n.url }, false)) + '"><b>' + esc(x.a.name || x.a.id) + '</b> ' + esc((x.t.messagePreview || '').slice(0, 90)) + '</a> <small>since ' + esc(stamp(Date.parse(x.t.startedAt))) + '</small></li>';
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
    $('wall-feed').hidden = S.view !== 'feed';
    $('wall-list').hidden = S.view !== 'list';
    $('wall-failures').hidden = S.view !== 'failures';
    $('wall-count').hidden = S.view === 'failures';
    if (S.view === 'feed') $('wall-feed').innerHTML = posts.length ? posts.map(postHtml).join('') : '<p class="ax-wall__empty">No posts match these filters.</p>';
    if (S.view === 'list') $('wall-list').innerHTML = posts.length ? listHtml(posts) : '<p class="ax-wall__empty">No posts match these filters.</p>';
    if (S.view === 'failures') $('wall-failures').innerHTML = failuresHtml();
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
      fillSelect('f-project', uniq(posts.map(function (p) { return p.project; })));
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
    var t = ev.target.closest('[data-view],[data-thread],[data-more],[data-sort],[data-open]');
    if (!t) return;
    if (t.hasAttribute('data-view')) setView(t.getAttribute('data-view'));
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
