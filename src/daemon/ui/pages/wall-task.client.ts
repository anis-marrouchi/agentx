// --- Wall v2 Task page, browser side (#1381) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), md(), avatar(), nameOf(), isAgent(), shortTime(), stateBadge(),
// progressHtml(), planHtml(), factsHtml(), hashOf(), headers(), act() and
// applyHash().
//
// The Wall's own version of the classic task page (task.ts): one session or
// job, at #page=task&task=<id>&agent=<id>&node=<daemon url>, so it is a link.
// From the top:
//   - who runs it, on which machine, its state and how long it has run;
//   - the request it works on, when it belongs to one the Wall tracks: where
//     it stands, its plan and its facts (from GET /api/admin/wall/thread);
//   - the conversation: the ask, then what the agent does, streaming live
//     (GET /api/task/stream), or the stored record of a finished run
//     (GET /api/task/history, &done=1 in the link);
//   - the steer box, as a chat under it: Send queues the message as the
//     next turn (POST /api/task/action kind=followup), Stop ends the turn
//     (kind=cancel).
//
// task.ts's rules hold: a finished scheduled (cron) run can be continued,
// which starts a new turn in its session and moves the page to it; a
// finished run from any other channel is read-only, since its replies
// belong in its own chat.

export const WALL_TASK_SCRIPT = String.raw`
  // --- Where a task page is: its link ---
  /** The Task page's hash for a run of an agent on a machine (a daemon URL). */
  function taskPageHash(id, agent, node, o) {
    var q = new URLSearchParams();
    q.set('page', 'task');
    q.set('task', id);
    q.set('agent', agent);
    if (node) q.set('node', node);
    if (o && o.channel) q.set('ch', o.channel);
    if (o && o.trace && o.trace !== id) q.set('trace', o.trace);
    if (o && o.done) q.set('done', '1');
    return '#' + q.toString();
  }
  /** The task the hash names, or null. */
  function readTaskHash(q) {
    if (!q.get('task') || !q.get('agent') || !q.get('node')) return null;
    return { id: q.get('task'), agent: q.get('agent'), node: q.get('node'), channel: q.get('ch') || '', trace: q.get('trace') || '', done: q.get('done') === '1' };
  }
  function writeTaskHash(q) {
    var t = S.task;
    if (!t) return;
    var h = new URLSearchParams(taskPageHash(t.id, t.agent, t.node, t).slice(1));
    h.forEach(function (v, k) { if (k !== 'page') q.set(k, v); });
  }

  // --- A run's state on the page ---
  function dur(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return h ? h + 'h ' + p2(m) + 'm' : m ? m + 'm ' + p2(s % 60) + 's' : s + 's';
  }
  function liveRunOf(t) {
    var hit = null;
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      if (n.url !== t.node) return;
      (n.agents || []).forEach(function (a) {
        if (a.id !== t.agent) return;
        (a.runningTasks || []).forEach(function (r) { if (r.id === t.id) hit = r; });
      });
    });
    return hit;
  }
  function nodeNameOf(url) {
    var n = ((S.live && S.live.nodes) || []).find(function (x) { return x.url === url; });
    return n ? n.name : String(url || '').replace(/^https?:\/\//, '');
  }
  /** What the steer box offers: send and stop, send only, or nothing. */
  function steerMode(tk) {
    if (tk.loading) return 'loading';
    if (!tk.finished) return 'live';
    return tk.channel === 'cron' ? 'continue' : 'readonly';
  }

  // --- The conversation, from the stream's lines (see task.ts) ---
  function taskLine(tk, line) {
    var last = tk.events[tk.events.length - 1];
    var open = last && last.k === 'text';
    if (line.indexOf('· ') === 0) tk.events.push({ k: 'sys', text: line.slice(2) });
    else if (line.indexOf('→ ') === 0) {
      var call = line.slice(2), o = call.indexOf('('), c = call.lastIndexOf(')');
      tk.events.push({ k: 'tool', name: o > 0 ? call.slice(0, o) : call, args: o > 0 && c > o ? call.slice(o + 1, c) : '' });
    } else if (line.indexOf('← ') === 0) {
      var res = line.slice(2), err = res.indexOf('[error] ') === 0;
      tk.events.push({ k: 'result', err: err, text: err ? res.slice(8) : res });
    } else if (line.indexOf('💭 ') === 0) tk.events.push({ k: 'thought', text: line.slice(2).trim() });
    else if (line.indexOf('[error] ') === 0) tk.events.push({ k: 'error', text: line.slice(8) });
    else if (line.indexOf('[task finished]') === 0) tk.events.push({ k: 'sys', text: 'Task finished', end: true });
    else if (line === '') { if (open) last.text += '\n'; }
    else if (open) last.text += '\n' + line;
    else tk.events.push({ k: 'text', text: line });
  }
  function feedTask(tk, text) {
    if (!text) return;
    tk.lineBuf += text;
    var lines = tk.lineBuf.split('\n');
    tk.lineBuf = lines.pop();
    lines.forEach(function (l) { taskLine(tk, l); });
  }
  function drainTask(tk) { if (tk.lineBuf) { taskLine(tk, tk.lineBuf); tk.lineBuf = ''; } }

  /** What a person asked, out of the prompt that hands a tracked request to
   *  its agent (requests/sweep.ts pickupText); other text as it is. */
  function askOf(text) {
    var t = String(text || '');
    var m = /^\[agentx:request-pickup id=([^\]]+)\]/.exec(t);
    if (!m) return t;
    var at = t.indexOf('What they asked:\n');
    if (at < 0) return 'Picks up request ' + m[1];
    return t.slice(at + 17).split('\n\n')[0].trim() || 'Picks up request ' + m[1];
  }
  function senderLabel(s) {
    if (!s) return 'Request';
    if (/^cron:/.test(s)) return 'Scheduled job ' + s.slice(5);
    return isAgent(s) ? nameOf(s) : s;
  }
  function convHtml(tk) {
    var out = [];
    if (tk.ask && tk.ask.text) {
      var who = tk.ask.sender || '';
      // A tracked request's hand-over prompt shows as the words asked; the
      // whole prompt stays one tap away.
      var said = askOf(tk.ask.text);
      out.push('<li class="wcv is-ask">' + avatar(who || 'request', 'sm', !isAgent(who)) + '<div class="wcv__b"><div class="wcv__h"><b>' + esc(senderLabel(who)) + '</b>' +
        (tk.ask.at ? ' · ' + shortTime(tk.ask.at) : '') + '</div><div class="ax-md">' + md(said) + '</div>' +
        (said !== tk.ask.text ? '<details class="wcv__full"><summary>The whole message the agent got</summary><div class="ax-md">' + md(tk.ask.text) + '</div></details>' : '') + '</div></li>');
    }
    tk.events.forEach(function (e) {
      if (e.k === 'text') out.push('<li class="wcv is-agent">' + avatar(tk.agent, 'sm') + '<div class="wcv__b"><div class="wcv__h"><b>' + esc(nameOf(tk.agent)) + '</b></div><div class="ax-md">' + md(e.text.replace(/\n+$/, '')) + '</div></div></li>');
      else if (e.k === 'tool') out.push('<li class="wcv is-tool">' + (e.args
        ? '<details><summary>Used <b>' + esc(e.name) + '</b></summary><pre>' + esc(e.args) + '</pre></details>'
        : '<span>Used <b>' + esc(e.name) + '</b></span>') + '</li>');
      else if (e.k === 'result') out.push('<li class="wcv is-tool' + (e.err ? ' is-err' : '') + '"><details><summary>' + (e.err ? 'Tool error' : 'Tool result') + '</summary><pre>' + esc(e.text) + '</pre></details></li>');
      else if (e.k === 'thought') out.push('<li class="wcv is-thought"><details><summary>Thinking: ' + esc(e.text.slice(0, 90)) + (e.text.length > 90 ? '…' : '') + '</summary><p>' + esc(e.text) + '</p></details></li>');
      else if (e.k === 'error') out.push('<li class="wcv is-err"><b>Error</b><pre>' + esc(e.text) + '</pre></li>');
      else out.push('<li class="wcv is-sys' + (e.end ? ' is-end' : '') + '">' + esc(e.text) + '</li>');
    });
    tk.mine.forEach(function (m) {
      out.push('<li class="wcv is-you"><div class="wcv__b"><div class="wcv__h"><b>You</b> · ' + shortTime(m.at) + ' · ' + esc(m.note) + '</div><div class="ax-md">' + md(m.text) + '</div></div></li>');
    });
    if (!tk.events.length && !tk.mine.length) out.push('<li class="wcv is-sys">' + (tk.loading ? 'Loading the record…' : tk.finished ? 'Nothing was recorded for this run.' : 'Waiting for its first output…') + '</li>');
    return '<ol class="wcv__list">' + out.join('') + '</ol>';
  }

  // --- The page and its parts ---
  function statusChip(tk) {
    var label = { connecting: 'Connecting…', live: '● Live', finished: 'Finished', failed: 'Failed', disconnected: 'Disconnected', loading: 'Loading…' }[tk.status] || tk.status;
    var cls = tk.status === 'live' ? 'ax-badge ax-badge--live' : tk.status === 'finished' ? 'chip chip--done' : tk.status === 'connecting' || tk.status === 'loading' ? 'chip chip--ghost' : 'chip chip--err';
    return '<span class="' + cls + '" id="tk-status">' + esc(label) + '</span>';
  }
  function taskHeadHtml(tk) {
    var ms = tk.finished ? tk.durationMs : tk.startedAt ? Date.now() - tk.startedAt : 0;
    return statusChip(tk) +
      (tk.channel ? '<span class="chip chip--ghost">' + esc(tk.channel === 'cron' ? 'scheduled job' : tk.channel) + '</span>' : '') +
      (ms ? '<span class="wtp__el" title="How long it has run">' + (tk.finished ? 'Ran ' : 'Running for ') + '<b id="tk-elapsed">' + esc(dur(ms)) + '</b></span>' : '');
  }
  function taskReqHtml(tk) {
    var r = tk.req;
    if (!r || !r.post) return '';
    var p = r.post;
    return '<section class="wtp__req" aria-label="The request it works on">' +
      '<div class="wtp__reqh"><span class="k">Request</span> <a href="' + esc(hashOf(p.id)) + '" data-open="' + esc(p.id) + '">' + esc(p.headline) + '</a> ' + stateBadge(p.state) + '</div>' +
      progressHtml(p) + (r.plan && r.plan.length ? planHtml(r.plan) : '') +
      '<details class="wtp__facts"><summary>Details</summary>' + factsHtml(p) + '</details></section>';
  }
  function steerHtml(tk, typed) {
    var mode = steerMode(tk);
    if (mode === 'loading') return '';
    if (mode === 'readonly') return '<p class="wtp__ro" role="note">This run came from ' + esc(tk.channel || 'another channel') + ' and has finished: it is read-only here. Its replies belong in its own chat' +
      (tk.req && tk.req.post ? '; to follow it up, comment on its post (<a href="' + esc(hashOf(tk.req.post.id)) + '" data-open="' + esc(tk.req.post.id) + '">open the post</a>).' : '.') + '</p>';
    var cont = mode === 'continue';
    return '<label class="wdo__l" for="tk-text">' + (cont ? 'Continue this scheduled run: your message starts a new turn in the same session.' : 'Steer ' + esc(nameOf(tk.agent)) + ': your message goes in as the next turn; the current turn keeps running.') + '</label>' +
      '<div class="wtp__box"><textarea id="tk-text" class="wdo__t" rows="2" maxlength="4000" placeholder="' + (cont ? 'Ask a follow-up…' : 'Message ' + esc(nameOf(tk.agent)) + '…') + ' Ctrl+Enter sends.">' + esc(typed || '') + '</textarea>' +
      '<div class="wdo__row">' + (cont ? '' : '<button type="button" class="ax-btn ax-btn--ghost wtp__stop" data-tk="stop" title="Stop the turn it runs now">Stop</button>') +
        '<button type="button" class="ax-btn" data-tk="send">Send</button></div></div>' +
      '<p class="wdo__n" id="tk-note" role="status">' + esc(tk.note || '') + '</p>';
  }
  /** Who runs it and where: names from the snapshot, once it has come. */
  function taskWhoHtml(tk) {
    return '<button type="button" class="name" data-agent="' + esc(tk.agent) + '">' + esc(nameOf(tk.agent)) + '</button><span class="h">@' + esc(tk.agent) + '</span><span aria-hidden="true">·</span><span>' + esc(nodeNameOf(tk.node)) + '</span>';
  }
  function taskShellHtml(tk) {
    var t = S.task;
    return '<div class="wtp">' +
      '<header class="wtp__h">' + avatar(t.agent) + '<div class="wtp__who">' +
        '<div class="wp__by" id="tk-who">' + taskWhoHtml(tk) + '</div>' +
        '<div class="wtp__meta" id="tk-head">' + taskHeadHtml(tk) + '</div></div></header>' +
      '<div id="tk-req">' + taskReqHtml(tk) + '</div>' +
      '<h2 class="wp__th">Conversation</h2>' +
      '<div id="tk-conv" class="wtp__conv" aria-live="polite">' + convHtml(tk) + '</div>' +
      '<div id="tk-steer" class="wtp__steer">' + steerHtml(tk) + '</div>' +
      '<div class="wpf__links wtp__links"><a href="/tasks/' + encodeURIComponent(t.id) + '?agent=' + encodeURIComponent(t.agent) + '&amp;node=' + encodeURIComponent(t.node) + (t.done ? '&amp;archived=1' : '') + '">Classic task page</a>' +
        '<a href="/agents/' + encodeURIComponent(t.agent) + '/history">History</a><a href="#page=live">All live sessions</a></div>' +
    '</div>';
  }
  function paintTaskHead() {
    var el = $('tk-head');
    if (el && S.tk) el.innerHTML = taskHeadHtml(S.tk);
    if ($('tk-who') && S.tk) $('tk-who').innerHTML = taskWhoHtml(S.tk);
  }
  function paintTaskReq() { var el = $('tk-req'); if (el && S.tk) el.innerHTML = taskReqHtml(S.tk); }
  /** The steer box, drawn again only when what it offers changes. */
  function paintSteer() {
    var tk = S.tk, el = $('tk-steer');
    if (!el || !tk) return;
    var mode = steerMode(tk);
    if (tk.steerMode === mode) return;
    tk.steerMode = mode;
    var typed = $('tk-text') && $('tk-text').value;
    el.innerHTML = steerHtml(tk, typed);
  }
  function steerNote(text) { if (S.tk) S.tk.note = text; var el = $('tk-note'); if (el) el.textContent = text; }
  function paintTaskConv() {
    var tk = S.tk, el = $('tk-conv');
    if (!el || !tk) return;
    // Follow the live output while the reader is at the bottom of the page.
    var follow = false;
    try { var d = document.documentElement; follow = !tk.finished && window.innerHeight + window.scrollY >= d.scrollHeight - 120; } catch (e) { follow = false; }
    el.innerHTML = convHtml(tk);
    if (follow) try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) { /* no window to scroll */ }
  }
  function paintTaskParts() { paintTaskHead(); paintTaskReq(); paintTaskConv(); paintSteer(); }
  /** Many chunks a second become one repaint. */
  function scheduleConv(tk) {
    if (tk.convT) return;
    var later = window.requestAnimationFrame || function (f) { return setTimeout(f, 0); };
    tk.convT = later(function () { tk.convT = 0; if (S.tk === tk) paintTaskConv(); });
  }

  // --- Reading the run: live stream or stored record ---
  function taskQuery(tk) { return 'node=' + encodeURIComponent(tk.node) + '&agent=' + encodeURIComponent(tk.agent) + '&task=' + encodeURIComponent(tk.id); }
  function endTask(tk, status) {
    tk.finished = true;
    tk.status = status;
    if (tk.startedAt) tk.durationMs = tk.durationMs || Date.now() - tk.startedAt;
    if (tk.es) { try { tk.es.close(); } catch (e) { /* closed */ } tk.es = null; }
  }
  async function loadTaskRecord(tk, quiet) {
    if (!quiet) { tk.loading = true; tk.status = 'loading'; }
    var rec = null, why = '';
    try {
      var r = await fetch('/api/task/history?' + taskQuery(tk), { headers: headers() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      rec = await r.json();
    } catch (e) { why = String(e && e.message || e); }
    if (S.tk !== tk) return;
    tk.loading = false;
    // A record's own error is the run's; a failed read has no record.
    if (!rec) {
      if (!quiet) endTask(tk, 'No record: ' + why);
      paintTaskParts();
      return;
    }
    tk.rec = rec;
    tk.channel = rec.channel || tk.channel;
    if (rec.message) tk.ask = { text: rec.message, sender: rec.sender, at: Date.parse(rec.startedAt) || 0 };
    if (rec.durationMs) tk.durationMs = rec.durationMs;
    if (!quiet) {
      endTask(tk, rec.ok === false ? 'failed' : 'finished');
      tk.events = []; tk.lineBuf = '';
      var tx = rec.transcript || '';
      feedTask(tk, tx);
      drainTask(tk);
      // The final reply, unless the transcript already carries it.
      if (rec.responseText && tx.indexOf(rec.responseText) === -1) tk.events.push({ k: 'text', text: rec.responseText });
      if (rec.error) tk.events.push({ k: 'error', text: rec.error });
    }
    paintTaskParts();
  }
  function streamTask(tk) {
    var ES = window.EventSource;
    if (!ES) { endTask(tk, 'This browser cannot follow a live run'); paintTaskParts(); return; }
    var es;
    try { es = new ES('/api/task/stream?' + taskQuery(tk)); } catch (e) { endTask(tk, 'Could not connect'); paintTaskParts(); return; }
    tk.es = es;
    es.addEventListener('start', function (ev) {
      if (S.tk !== tk) return;
      var d = {};
      try { d = JSON.parse(ev.data); } catch (e) { d = {}; }
      tk.status = 'live';
      if (d.message) tk.ask = { text: d.message, sender: d.sender, at: Date.parse(d.startedAt) || 0 };
      if (d.startedAt) tk.startedAt = Date.parse(d.startedAt) || tk.startedAt;
      // The start event carries the whole output so far: after a reconnect
      // it is drawn again, not added twice.
      tk.events = []; tk.lineBuf = '';
      feedTask(tk, d.initial || '');
      if (d.done) { drainTask(tk); endTask(tk, 'finished'); if (!tk.channel) loadTaskRecord(tk, true); }
      paintTaskParts();
    });
    es.addEventListener('chunk', function (ev) {
      if (S.tk !== tk) return;
      try { feedTask(tk, JSON.parse(ev.data).text || ''); } catch (e) { /* a broken chunk */ }
      scheduleConv(tk);
    });
    es.addEventListener('end', function () {
      if (S.tk !== tk) return;
      drainTask(tk);
      endTask(tk, 'finished');
      // What the box offers next depends on the channel.
      if (!tk.channel) loadTaskRecord(tk, true);
      paintTaskParts();
    });
    es.addEventListener('error', function (ev) {
      if (S.tk !== tk || tk.finished) return;
      // The daemon no longer holds the run's output: read its stored record.
      var d = null;
      try { d = ev && ev.data ? JSON.parse(ev.data) : null; } catch (e) { d = null; }
      if (d && d.message) { endTask(tk, 'loading'); tk.done = true; loadTaskRecord(tk); return; }
      tk.status = 'disconnected';
      paintTaskHead();
    });
  }
  /** The tracked request the run belongs to, if the Wall keeps one for it. */
  async function loadTaskRequest(tk) {
    tk.reqAsked = true;
    var nodes = (S.live && S.live.nodes) || [];
    // The first node is this one; a run on a peer is looked up there.
    var peer = nodes.length && nodes[0].url === tk.node ? null : tk.node;
    var ids = [tk.trace, tk.id].filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    for (var i = 0; i < ids.length; i++) {
      try {
        var r = await fetch('/api/admin/wall/thread?task=' + encodeURIComponent(ids[i]), { headers: headers(peer) });
        if (!r.ok) continue;
        var b = await r.json();
        if (!b || !b.post) continue;
        tk.req = { post: b.post, plan: b.plan || [] };
        // Kept aside, so the request opens from here even when the feed does not list it.
        if (!findPost(b.post.id)) S.extra = Object.assign({}, b.post, { node: { name: b.node || nodeNameOf(tk.node), peer: peer, daemonUrl: peer } });
        S.threads[b.post.id] = { events: b.events || [], plan: b.plan || [] };
        break;
      } catch (e) { /* not tracked, or the node did not answer */ }
    }
    if (S.tk !== tk) return;
    paintTaskReq();
    if (tk.req && steerMode(tk) === 'readonly') { tk.steerMode = null; paintSteer(); }
  }
  function openTask(t, key) {
    closeTask();
    var run = liveRunOf(t);
    var tk = S.tk = {
      key: key, id: t.id, agent: t.agent, node: t.node, trace: t.trace || (run && run.traceId) || '', done: t.done,
      channel: t.channel || (run && run.channel) || '', status: t.done ? 'loading' : 'connecting', finished: !!t.done, loading: !!t.done,
      startedAt: run ? Date.parse(run.startedAt) || 0 : 0, durationMs: 0,
      ask: run && (run.message || run.messagePreview) ? { text: run.message || run.messagePreview, sender: run.sender, at: Date.parse(run.startedAt) || 0 } : null,
      events: [], lineBuf: '', mine: [], note: '', req: null, reqAsked: false, steerMode: null,
    };
    $('wall-task').innerHTML = taskShellHtml(tk);
    paintTaskParts();
    if (t.done) loadTaskRecord(tk); else streamTask(tk);
    if (S.live) loadTaskRequest(tk);
  }
  /** Leaving the page closes its stream. */
  function closeTask() {
    if (!S.tk) return;
    if (S.tk.es) { try { S.tk.es.close(); } catch (e) { /* closed */ } }
    S.tk.closed = true;
  }
  function paintTask() {
    var t = S.task;
    if (!t) { $('wall-task').innerHTML = '<p class="ax-wall__empty">This link names no task. Open one from <a href="#page=live">Live</a>.</p>'; return; }
    var key = [t.id, t.agent, t.node, t.done ? 1 : 0].join('|');
    if (!S.tk || S.tk.key !== key || S.tk.closed) { openTask(t, key); return; }
    if (S.live && !S.tk.reqAsked) loadTaskRequest(S.tk);
    if (S.live && !S.tk.named) { S.tk.named = true; paintTaskHead(); }
  }

  // --- Steer: send a message in, or stop the turn ---
  function taskActionUrl(tk, kind) { return '/api/task/action?node=' + encodeURIComponent(tk.node) + '&task=' + encodeURIComponent(tk.id) + '&kind=' + kind; }
  async function steerSend() {
    var tk = S.tk;
    if (!tk || tk.sending) return;
    var mode = steerMode(tk);
    if (mode !== 'live' && mode !== 'continue') return;
    var text = ($('tk-text') && $('tk-text').value || '').trim();
    if (!text) { steerNote('Write the message first.'); return; }
    tk.sending = true;
    steerNote('Sending…');
    var r = await act('POST', taskActionUrl(tk, 'followup'), { message: text, agent: tk.agent });
    tk.sending = false;
    var b = (r.ok && r.body) || {};
    if (!r.ok || b.error) { steerNote('Not sent: ' + (r.error || b.error)); return; }
    if ($('tk-text')) $('tk-text').value = '';
    // A finished scheduled run goes on as a new turn: follow it there.
    if (b.resumed && b.taskId) {
      location.hash = taskPageHash(b.taskId, tk.agent, tk.node, { channel: b.channel || tk.channel });
      applyHash();
      return;
    }
    var said = b.resumed && b.answeredBy === 'attached' ? 'answered by the attached session, no new run here'
      : b.resumed && b.answeredBy ? 'delivered and answered, no new run on this machine'
      : b.resumed ? 'the agent is busy: queued as the next turn in this chat'
      : 'queued as the next turn';
    tk.mine.push({ text: text, at: Date.now(), note: said });
    steerNote('Sent: ' + said + '.');
    paintTaskConv();
  }
  async function steerStop() {
    var tk = S.tk;
    if (!tk || steerMode(tk) !== 'live') return;
    steerNote('Stopping…');
    var r = await act('POST', taskActionUrl(tk, 'cancel'), {});
    var b = (r.ok && r.body) || {};
    steerNote(!r.ok || b.error ? 'Not stopped: ' + (r.error || b.error) : 'Stop asked: the turn ends at its next step.');
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-tk]');
    if (!t) return;
    if (t.getAttribute('data-tk') === 'send') steerSend(); else steerStop();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.target && ev.target.id === 'tk-text' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); steerSend(); }
  });
  // How long each run has run, every second, on Live and on the Task page.
  setInterval(function () {
    if (document.hidden) return;
    if (S.page === 'task' && S.tk && !S.tk.finished && S.tk.startedAt && $('tk-elapsed')) $('tk-elapsed').textContent = dur(Date.now() - S.tk.startedAt);
    if (S.page === 'live' && document.querySelectorAll) document.querySelectorAll('[data-since]').forEach(function (el) { el.textContent = dur(Date.now() - Number(el.getAttribute('data-since'))); });
  }, 1000);
`

export const WALL_TASK_CSS = `
/* The Task page (#1381): one session or job, its conversation and the steer box. */
.wtp { padding: 12px 16px 24px; }
.wtp__h { display: flex; gap: 12px; align-items: center; }
.wtp__who { min-width: 0; flex: 1; }
.wtp__meta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 4px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wtp__el b { color: var(--ax-text); font-variant-numeric: tabular-nums; }
.wtp__req { margin-top: 14px; padding: 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); }
.wtp__reqh { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; margin-bottom: 10px; font-weight: 700; }
.wtp__reqh a { color: var(--ax-text); text-decoration: none; overflow-wrap: anywhere; }
.wtp__reqh a:hover { text-decoration: underline; }
.wtp__reqh .k { color: var(--ax-muted); font-weight: 400; font-size: var(--ax-fs-xs); }
.wtp__req .wtk__prog { margin-bottom: 0; }
.wtp__facts { margin-top: 10px; font-size: var(--ax-fs-xs); }
.wtp__facts summary { cursor: pointer; color: var(--ax-accent); }
.wcv__list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.wcv { display: flex; gap: 8px; align-items: flex-start; font-size: var(--ax-fs-sm); min-width: 0; }
.wcv__b { min-width: 0; max-width: 100%; padding: 8px 12px; border-radius: 16px; background: var(--ax-surface); overflow-wrap: anywhere; }
.wcv__h { font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-bottom: 2px; }
.wcv__h b { color: var(--ax-text); }
.wcv__full { margin-top: 6px; font-size: var(--ax-fs-xs); }
.wcv__full summary { cursor: pointer; color: var(--ax-accent); }
.wcv.is-ask .wcv__b { border-top-left-radius: 4px; background: var(--ax-blue-t); }
.wcv.is-agent .wcv__b { border-top-left-radius: 4px; }
.wcv.is-you { justify-content: flex-end; }
.wcv.is-you .wcv__b { background: var(--ax-accent); color: var(--ax-accent-ink, #fff); border-top-right-radius: 4px; }
.wcv.is-you .wcv__h, .wcv.is-you .wcv__h b { color: inherit; }
.wcv.is-tool, .wcv.is-thought, .wcv.is-sys { margin-left: 36px; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wcv.is-tool b { color: var(--ax-text-2); font-family: var(--ax-mono); font-weight: 500; }
.wcv details { min-width: 0; max-width: 100%; }
.wcv summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; }
.wcv pre { margin: 4px 0 0; padding: 6px 8px; background: var(--ax-surface-2); border-radius: var(--ax-radius); font-family: var(--ax-mono); font-size: var(--ax-fs-xs); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; color: var(--ax-text-2); }
.wcv.is-thought p { margin: 4px 0 0; font-style: italic; white-space: pre-wrap; }
.wcv.is-err { margin-left: 36px; display: block; color: var(--ax-red-ink, var(--ax-err)); font-size: var(--ax-fs-xs); }
.wcv.is-tool.is-err summary { color: var(--ax-red-ink, var(--ax-err)); }
.wcv.is-end { color: var(--ax-green-d, var(--ax-green)); }
/* The steer box stays in reach under a long conversation. */
.wtp__steer { position: sticky; bottom: 0; margin-top: 12px; padding: 10px 0; background: var(--ax-bg); border-top: 1px solid var(--ax-border); display: flex; flex-direction: column; gap: 6px; }
.wtp__steer:empty { display: none; }
.wtp__box { display: flex; flex-direction: column; gap: 8px; }
.wtp__box .wdo__row { justify-content: flex-end; }
.wtp__stop { color: var(--ax-red-ink, var(--ax-err)); border-color: color-mix(in srgb, var(--ax-red) 50%, var(--ax-border-2)); }
.wtp__ro { margin: 0; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.wtp__links { margin-top: 14px; flex-wrap: wrap; }
@media (max-width: 640px) {
  /* The round New post button would cover Send. */
  .ax-wall.is-task .ax-wall__newpost { display: none; }
  .wtp { padding: 10px 12px 16px; }
  .wtp__steer { bottom: 56px; }
  .wcv.is-tool, .wcv.is-thought, .wcv.is-sys, .wcv.is-err { margin-left: 0; }
}
`
