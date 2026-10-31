// --- Hub Events view, browser side (#1648) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's esc(),
// when(), getJson(), nameOf(), taskHref() and render(). Reads only
// /api/admin/wall/events: the named events and announcements every machine
// holds, the wakes each one caused, and the events sent in reply, grouped
// under the event that caused them. Nothing here sends anything.
//
// One card per event that started something. Its wakes are one chip per
// subscriber (ran / waited N min / held / timed out / skipped); the replies
// sit under it, each with its own wakes. Errors and skip reasons open on
// demand (progressive disclosure), so the list stays compact.
//
// renderEvents(view) is the one call the Wall's render() makes. It loads
// the feed the first time the view opens; refreshEvents() runs with the
// Wall's own refresh.

export const WALL_EVENTS_SCRIPT = String.raw`
  var EV = { data: null, loading: false, open: {} };
  function evDur(ms) {
    if (ms == null) return '';
    var s = Math.round(ms / 1000);
    if (s < 90) return s + ' s';
    if (s < 5400) return Math.round(s / 60) + ' min';
    return (Math.round(s / 360) / 10) + ' h';
  }
  var EV_LABEL = { waiting: 'waiting', held: 'held', running: 'running', ran: 'ran', failed: 'failed', 'timed-out': 'timed out', dropped: 'gave up', skipped: 'skipped' };
  var EV_CLS = { ran: 'chip--done', failed: 'chip--err', 'timed-out': 'chip--err', dropped: 'chip--err', held: 'chip--warn', waiting: 'chip--warn', running: '', skipped: 'chip--ghost' };
  /** Waited this long before its turn began: shown when it is worth saying. */
  var EV_LATE_MS = 60000;
  function evNodeOf(name) {
    return ((S.live && S.live.nodes) || []).filter(function (n) { return n.name === name; })[0] || null;
  }
  function evWake(w, multi) {
    var late = w.waitedMs != null && w.waitedMs >= EV_LATE_MS;
    var label = EV_LABEL[w.status] || w.status;
    if (late && (w.status === 'ran' || w.status === 'running' || w.status === 'failed')) label += ', waited ' + evDur(w.waitedMs);
    else if (w.status === 'waiting' || w.status === 'held' || w.status === 'timed-out') label += w.waitedMs != null ? ' ' + evDur(w.waitedMs) : '';
    if (w.attempts > 1) label += ' · try ' + w.attempts;
    var tip = [w.reason, w.error].filter(Boolean).join(' — ');
    var who = esc(nameOf(w.agentId)) + (multi ? '<span class="k">@' + esc(w.node) + '</span>' : '');
    var chip = '<span class="chip ' + (EV_CLS[w.status] || '') + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(label) + '</span>';
    var run = w.taskId ? ' <a href="' + esc(taskHref(w.taskId, w.agentId, evNodeOf(w.node), w.status !== 'running')) + '">run</a>' : '';
    return '<li class="wev__wake is-' + esc(w.status) + '"><span class="wev__who">' + who + '</span> ' + chip + run +
      (tip ? '<div class="wev__why">' + esc(tip) + '</div>' : '') + '</li>';
  }
  function evWakes(id, wakes, multi, reply) {
    // A reply that woke nobody says nothing: the list stays compact.
    if (!wakes.length) return reply ? '' : '<p class="wev__none">No subscriber was woken.</p>';
    var key = 'w:' + id, open = !!EV.open[key];
    var counts = {};
    wakes.forEach(function (w) { counts[w.status] = (counts[w.status] || 0) + 1; });
    var line = Object.keys(counts).map(function (k) { return counts[k] + ' ' + (EV_LABEL[k] || k); }).join(' · ');
    return '<div class="wev__wakes"><button type="button" class="wev__toggle" data-evopen="' + esc(key) + '" aria-expanded="' + open + '">' +
      wakes.length + ' wake' + (wakes.length === 1 ? '' : 's') + ': ' + esc(line) + '</button>' +
      '<ul class="wev__list"' + (open ? '' : ' hidden') + '>' + wakes.map(function (w) { return evWake(w, multi); }).join('') + '</ul></div>';
  }
  function evHead(e, multi) {
    var who = e.agentId ? esc(nameOf(e.agentId)) : '<span class="k">' + esc(e.node) + '</span>';
    return '<div class="wev__head"><span class="wev__type">' + esc(e.type) + '</span>' +
      '<span class="wev__by">by ' + who + (multi && e.agentId ? '<span class="k">@' + esc(e.node) + '</span>' : '') + '</span>' +
      '<span class="k">' + when(Date.parse(e.at)) + '</span>' +
      (e.ref ? '<span class="wev__ref" title="ref">ref ' + esc(e.ref) + '</span>' : '') +
      '<span class="k wev__id" title="' + esc(e.id) + '">' + esc(e.id.slice(0, 8)) + '</span></div>' +
      (e.summary && e.summary !== e.type ? '<p class="wev__sum">' + esc(e.summary) + '</p>' : '');
  }
  function evCard(t, multi) {
    var replies = t.replies || [];
    return '<article class="wev" id="event-' + esc(t.event.id) + '">' + evHead(t.event, multi) + evWakes(t.event.id, t.wakes || [], multi) +
      (replies.length ? '<ol class="wev__replies" aria-label="Replies to ' + esc(t.event.type) + '">' + replies.map(function (r) {
        return '<li class="wev__reply">' + evHead(r.event, multi) + '<p class="wev__to">in reply to ' + esc(t.event.type) + ' ' + esc(t.event.id.slice(0, 8)) + '</p>' +
          evWakes(r.event.id, r.wakes || [], multi, true) + '</li>';
      }).join('') + '</ol>' : '') + '</article>';
  }
  function evList() {
    var v = EV.data;
    if (!v) return '<p class="ax-wall__empty">Loading…</p>';
    if (v.error) return '<p class="ax-wall__empty">Could not load the events: ' + esc(v.error) + ' <button type="button" class="ax-btn ax-btn--ghost" data-evretry>Try again</button></p>';
    var nodes = v.nodes || [], down = nodes.filter(function (n) { return !n.ok; });
    var multi = nodes.length > 1;
    var c = v.counts || {};
    var head = '<p class="ax-wall__count">' + (c.events || 0) + ' events · ' + (c.wakes || 0) + ' wakes: ' + (c.ran || 0) + ' ran, ' + (c.waiting || 0) + ' waiting, ' +
      (c.timedOut || 0) + ' timed out or gave up, ' + (c.failed || 0) + ' failed, ' + (c.skipped || 0) + ' skipped' +
      (v.total > (v.threads || []).length ? ' · newest ' + v.threads.length + ' of ' + v.total + ' shown' : '') + '</p>' +
      (down.length ? '<p class="ax-wall__count wev__down" role="status">' + down.map(function (n) { return esc(n.name) + ': ' + esc(n.error || 'did not answer'); }).join(' · ') +
        '. Its events and wakes are missing; the rest still shows.</p>' : '');
    var list = v.threads || [];
    if (!list.length) return head + '<p class="ax-wall__empty">No named event or announcement since the daemons last started. Send one with <code>agentx events emit &lt;name&gt;</code>.</p>';
    return head + list.map(function (t) { return evCard(t, multi); }).join('');
  }
  async function loadEvents() {
    EV.loading = true;
    try { EV.data = await getJson('/api/admin/wall/events'); } catch (e) { EV.data = { error: e.message }; }
    EV.loading = false;
    render();
  }
  function refreshEvents() { if (EV.data) loadEvents(); }
  /** Called from the Wall's render(), after its own views are painted. */
  function renderEvents(view) {
    var on = view === 'events';
    $('wall-events').hidden = !on;
    if (on) {
      $('wall-count').hidden = true;
      $('wall-profile').hidden = true;
      if (!EV.data && !EV.loading) loadEvents();
      $('wall-events').innerHTML = evList();
    }
    var n = EV.data && EV.data.counts ? EV.data.counts.events : 0;
    $('wall-ev-n').textContent = n ? String(n) : '';
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-evopen],[data-evretry]');
    if (!t) return;
    if (t.hasAttribute('data-evretry')) { EV.data = null; loadEvents(); return; }
    var k = t.getAttribute('data-evopen');
    EV.open[k] = !EV.open[k];
    render();
  });
`

export const WALL_EVENTS_CSS = `
.wev { background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 10px 12px; margin-bottom: 10px; font-size: var(--ax-fs-sm); }
.wev__head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.wev__type { font-family: var(--ax-mono); font-weight: 600; overflow-wrap: anywhere; }
.wev__ref { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-text-2); overflow-wrap: anywhere; }
.wev .k, .wev__none, .wev__to, .wev__why { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wev__sum { margin: 4px 0 0; color: var(--ax-text-2); overflow-wrap: anywhere; }
.wev__none, .wev__to { margin: 4px 0 0; }
.wev__wakes { margin-top: 6px; }
.wev__toggle { font: inherit; font-size: var(--ax-fs-xs); background: none; border: 0; color: var(--ax-accent); cursor: pointer; padding: 2px 0; text-align: left; }
.wev__toggle::before { content: '▸ '; }
.wev__toggle[aria-expanded="true"]::before { content: '▾ '; }
.wev__toggle:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; }
.wev__list { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 4px; }
.wev__wake { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.wev__why { flex-basis: 100%; overflow-wrap: anywhere; }
.wev__replies { list-style: none; margin: 8px 0 0; padding: 0 0 0 12px; border-left: 2px solid var(--ax-border); display: grid; gap: 8px; }
.wev__down { color: var(--ax-amber-ink, var(--ax-muted)); }
`
