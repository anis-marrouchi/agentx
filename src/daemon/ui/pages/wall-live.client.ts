// --- Wall v2 live sessions, browser side (#1355) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), when(), until(), stamp(), avatar(), nameOf(), allAgents(),
// wallTaskHref(), act(), note(), paintSpace() and pollSpace().
//
// The Live page (#page=live) lists every live session on every machine,
// as Spaces do on X: the live ones on top (a Space, a lesson on a
// machine's screen), then the sessions and jobs running now, as the
// classic /live shows them (#1381): each card names the agent, what it is
// on, how long it has run and the last line it wrote, and opens the run's
// Task page (wall-task.client.ts). Then what comes up next (the next
// scheduled jobs), then a form to start a Space. Joining a Space on this
// computer opens it here, with its transcript and a box to say something
// into it. A Space on another machine plays there, so it is named with
// its machine. While the page is open the snapshot streams in, so the
// cards move as the runs do.
//
// What the classic /live and /monitor did for the owner is here too
// (#1439): the tasks a stop paused, each with its resume plan, Resume and
// Drop; and one card per machine with Restart when idle (or the restart
// it waits on, with Cancel), the Claude Code sessions attached to it, each
// with its agent and start time, and Connect a CLI session (the monitor's
// discover and register). The Task page reuses them: Resume on a paused
// run, Pause on a live one. Drop, Pause and Restart ask once more on the
// button itself. Every one of these writes goes through the dashboard's
// token gate, so only the owner's Wall can make them.
//
// Also here: who an @mention in a comment names, and the call and join
// buttons of an agent's page and profile.

export const WALL_LIVE_SCRIPT = String.raw`
  // --- Live sessions, live ones first ---
  function liveSessions() {
    var out = [];
    ((S.live && S.live.nodes) || []).forEach(function (n, i) {
      if (!n.reachable || n.error) return;
      var here = i === 0;
      if (n.space) out.push({ kind: 'space', node: n, here: here, agents: n.space.agents || [], title: n.space.topic || 'A Space', at: Date.parse(n.space.startedAt) || 0 });
      if (n.lesson) out.push({ kind: 'lesson', node: n, here: here, agents: n.lesson.agentId ? [n.lesson.agentId] : [], title: n.lesson.goal || 'A lesson', at: Date.parse(n.lesson.startedAt) || 0 });
      (n.agents || []).forEach(function (a) {
        (a.runningTasks || []).forEach(function (t) {
          out.push({ kind: 'work', node: n, here: here, agents: [a.id], title: t.messagePreview || 'Working', at: Date.parse(t.startedAt) || 0, task: t, agent: a });
        });
      });
    });
    var rank = { space: 0, lesson: 1, work: 2 };
    return out.sort(function (x, y) { return rank[x.kind] - rank[y.kind] || y.at - x.at; });
  }
  function dur(ms) {
    var m = Math.floor(Math.max(0, ms) / 60000);
    return m < 1 ? Math.floor(Math.max(0, ms) / 1000) + ' s' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  /** The last line a run wrote, said plainly (task.ts's stream sigils). */
  function activityText(t) {
    var l = t.lastActivity || '';
    if (!l) return t.workflow && t.workflow.step ? 'Workflow step: ' + t.workflow.step : t.step ? 'Step: ' + t.step : 'Starting…';
    if (l.indexOf('→ ') === 0) return 'Using ' + l.slice(2).split('(')[0];
    if (l.indexOf('← [error] ') === 0) return 'Tool error: ' + l.slice(10);
    if (l.indexOf('← ') === 0) return 'Tool result: ' + l.slice(2);
    if (l.indexOf('💭 ') === 0) return 'Thinking: ' + l.slice(2).trim();
    if (l.indexOf('· ') === 0) return l.slice(2);
    if (l.indexOf('[error] ') === 0) return 'Error: ' + l.slice(8);
    return 'Writing: ' + l;
  }
  /** The workflow run a task is in and its step, as classic Live had it
   *  (#858). A task wrapped under workflows.required runs as "task"; its
   *  title is the request, already shown, so only the step is named. */
  function wfLine(w) {
    if (!w || !(w.runId || w.title)) return '';
    var name = w.workflowId === 'task' ? '' : esc(w.title || w.workflowId || '') + (w.runId ? ' · ' : '');
    return '<div class="wls__k">Workflow ' + name + (w.runId ? 'step ' + esc(w.step || '…') : '') + '</div>';
  }
  /** A session or job at work: the whole card opens its Task page. */
  function workHtml(s) {
    var t = s.task, job = t.channel === 'cron';
    var jobId = job ? String(t.sender || t.chatId || '').replace(/^cron:/, '') : '';
    return '<a class="wls is-work" href="' + esc(wallTaskHref(t, s.agent.id, s.node.url)) + '" title="Open this run: its conversation and a box to steer it">' +
      '<div class="wls__h"><span class="ax-badge ax-badge--live">● ' + (job ? 'Job' : 'Session') + '</span><span class="wls__k">' +
        esc(s.node.name) + (t.channel && !job ? ' · ' + esc(t.channel) : '') + ' · <span class="wls__dur">for ' + esc(dur(Date.now() - s.at)) + '</span></span></div>' +
      '<div class="wls__ag">' + avatar(s.agent.id, 'sm') + '<b>' + esc(nameOf(s.agent.id)) + '</b><span class="h">@' + esc(s.agent.id) + '</span>' +
        (jobId ? '<span class="chip chip--ghost">' + esc(jobId) + '</span>' : '') + '</div>' +
      '<p class="wls__t">' + esc(s.title) + '</p>' +
      wfLine(t.workflow) +
      '<div class="wls__act"><span class="wls__k">Latest</span> ' + esc(activityText(t)) + '</div></a>';
  }
  function sessionHtml(s) {
    if (s.kind === 'work') return workHtml(s);
    var who = s.agents.map(function (id) { return avatar(id, 'sm'); }).join('');
    var names = s.agents.map(function (id) { return esc(nameOf(id)); }).join(' and ');
    var label = s.kind === 'space' ? 'Space' : s.kind === 'lesson' ? 'Lesson' : 'Working';
    var join = s.kind === 'space'
      ? (s.here ? '<button type="button" class="ax-btn" data-join-space>Join</button>' : '<span class="wls__k">Plays on ' + esc(s.node.name) + '</span>')
      : '<span class="wls__k">On ' + esc(s.node.name) + '\'s screen</span>' + lvBtn('lesson', s.node.url, '', 'Stop', '', 'End the lesson and give the screen back', true);
    return '<article class="wls is-' + s.kind + '"><div class="wls__h"><span class="ax-badge ax-badge--live">● ' + label + '</span><span class="wls__k">' + esc(s.node.name) +
      (s.at ? ' · since ' + esc(stamp(s.at).slice(11, 16)) : '') + '</span></div>' +
      '<p class="wls__t">' + esc(s.title) + '</p>' +
      '<div class="wls__f"><span class="wls__who">' + who + '<span>' + names + '</span></span>' + join + '</div></article>';
  }
  function comingUp() {
    var next = [];
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      (n.crons || []).forEach(function (j) { if (j.enabled && j.nextRun) next.push({ j: j, n: n, at: Date.parse(j.nextRun) }); });
    });
    return next.filter(function (x) { return x.at > Date.now(); }).sort(function (a, b) { return a.at - b.at; }).slice(0, 5);
  }
  function livePageHtml() {
    if (!S.live) return '<p class="ax-wall__empty">Loading…</p>';
    var all = liveSessions(), next = comingUp(), stopped = stoppedList();
    var live = all.filter(function (s) { return s.kind !== 'work'; }), work = all.filter(function (s) { return s.kind === 'work'; });
    var agents = allAgents().filter(function (a) { return a.nodes.length; });
    var opts = function (pick) { return agents.map(function (a, i) { return '<option value="' + esc(a.id) + '"' + (i === pick ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join(''); };
    return '<div class="wlv">' + lvNoteHtml() +
      (live.length ? '<h3>Spaces and lessons <small>' + live.length + '</small></h3>' + live.map(sessionHtml).join('') : '') +
      '<h3>Running now <small>' + work.length + '</small></h3>' +
      (work.length ? '<div class="wlv__work">' + work.map(sessionHtml).join('') + '</div>' : '<p class="ax-wall__empty">No session or job is running.' + (live.length ? '' : ' Start a Space below, or open a post and start one about it.') + '</p>') +
      (stopped.length ? '<h3>Paused <small>' + stopped.length + '</small></h3><p class="ax-wall__count">Tasks a stop paused. Each kept a plan to go on from.</p>' + stopped.map(function (x) { return stoppedHtml(x); }).join('') : '') +
      machinesHtml() +
      '<div id="live-space">' + spaceHtml() + '</div>' +
      '<h3>Coming up</h3>' + (next.length ? '<ul class="wlv__next">' + next.map(function (x) {
        return '<li>' + avatar(x.j.agent, 'sm') + '<span><b>' + esc(x.j.id) + '</b> <small>@' + esc(x.j.agent) + ' on ' + esc(x.n.name) + '</small></span><span class="wls__k">' + esc(until(x.at)) + '</span></li>';
      }).join('') + '</ul>' : '<p class="ax-wall__empty">No scheduled job is due.</p>') +
      (agents.length > 1 ? '<h3>Start a Space</h3><p class="ax-wall__count">Two agents talk out loud on this computer; you listen and can join in.</p>' +
        '<div class="wdo__row"><select id="lv-a" aria-label="First agent">' + opts(0) + '</select><select id="lv-b" aria-label="Second agent">' + opts(1) + '</select>' +
        '<input id="lv-topic" class="wdo__t" maxlength="200" placeholder="What should they talk about?">' +
        '<button type="button" class="ax-btn" data-live-start>Start</button></div><p class="wdo__n" id="lv-note" role="status"></p>' : '') +
    '</div>';
  }
  function liveCount() { return S.live ? liveSessions().length : null; }
  async function joinSpace() {
    var r = await act('GET', '/api/admin/wall/space');
    if (!r.ok || !r.body || r.body.active === false || r.body.kind !== 'talk') { S.space = null; paintSpace(); return; }
    S.space = r.body;
    S.spaceTopic = r.body.topic || '';
    paintSpace();
    pollSpace();
  }
  async function startSpace() {
    var a = $('lv-a') && $('lv-a').value, b = $('lv-b') && $('lv-b').value, topic = ($('lv-topic') && $('lv-topic').value || '').trim();
    var say = function (t) { if ($('lv-note')) $('lv-note').textContent = t; };
    if (!a || !b || a === b) { say('Pick two different agents.'); return; }
    if (!topic) { say('Say what they should talk about.'); return; }
    say('Starting…');
    var r = await act('POST', '/api/admin/wall/space', { agent: a, with: b, topic: topic });
    if (!r.ok) { say('No Space: ' + r.error); return; }
    say('');
    S.space = r.body;
    S.spaceTopic = topic;
    paintSpace();
    pollSpace();
  }

  // --- The owner's controls (#1439): paused tasks, machines, CLI sessions ---
  /** Which button waits for its second press, which are at work, the last
   *  outcome, each machine's CLI search and which plans are open. Kept
   *  across repaints: Live repaints with every snapshot. */
  function lvState() { return S.lv || (S.lv = { armed: '', busy: {}, msg: '', cli: {}, open: {} }); }
  function lvKey(kind, node, id) { return kind + '|' + node + '|' + (id || ''); }
  /** A control. With a confirm label, the first press arms it and the
   *  second acts; it disarms by itself after a few seconds. */
  function lvBtn(kind, node, id, label, confirm, title, ghost) {
    var st = lvState(), key = lvKey(kind, node, id);
    if (st.busy[key]) return '<button type="button" class="ax-btn ax-btn--ghost wlv__b" disabled>' + esc(st.busy[key]) + '</button>';
    var armed = !!confirm && st.armed === key;
    return '<button type="button" class="ax-btn wlv__b' + (ghost && !armed ? ' ax-btn--ghost' : '') + (armed ? ' is-armed' : '') + '" data-lv="' + esc(kind) + '" data-lv-node="' + esc(node) + '" data-lv-id="' + esc(id || '') + '"' +
      (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(armed ? confirm : label) + '</button>';
  }
  function lvNoteHtml() {
    var m = lvState().msg;
    return '<p class="wlv__note' + (m ? '' : ' is-empty') + '" role="status" aria-live="polite">' + esc(m) + '</p>';
  }
  function hhmm(ms) { return ms ? stamp(ms).slice(11, 16) : ''; }

  /** Tasks a stop paused, newest first, on the machines that answer. */
  function stoppedList() {
    var out = [];
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      if (!n.reachable || n.error) return;
      (n.stoppedTasks || []).forEach(function (t) { out.push({ t: t, n: n }); });
    });
    return out.sort(function (a, b) { return (Date.parse(b.t.stoppedAt) || 0) - (Date.parse(a.t.stoppedAt) || 0); });
  }
  function stoppedOf(taskId, nodeUrl) {
    return stoppedList().filter(function (x) { return x.t.id === taskId && (!nodeUrl || x.n.url === nodeUrl); })[0] || null;
  }
  function stopperName(s) { return !s || /^owner\b/.test(s) ? 'you' : s; }
  /** A paused task: who stopped it and why, what it was asked, its plan, Resume and Drop. */
  function stoppedHtml(x, onTask) {
    var t = x.t, n = x.n, wf = t.workflow, at = Date.parse(t.stoppedAt) || 0, winding = t.state === 'winding-down';
    var planKey = n.url + '|' + t.id;
    var plan = t.plan
      ? '<details class="wls__plan" data-lv-plan="' + esc(planKey) + '"' + (lvState().open[planKey] ? ' open' : '') + '><summary>Resume plan, by ' + (t.plan.author === 'agent' ? esc(nameOf(t.agentId)) : 'AgentX' + (t.plan.note ? ' (' + esc(t.plan.note) + ')' : '')) + '</summary><pre>' + esc(t.plan.text) + '</pre></details>'
      : '<div class="wls__k">' + (winding ? esc(nameOf(t.agentId)) + ' is writing its resume plan…' : 'No resume plan was saved.') + '</div>';
    var acts = (t.state === 'stopped' && t.resumable
        ? lvBtn('resume', n.url, t.id, 'Resume', '', wf ? 'Resume this step from its plan: the workflow run goes on from it' : 'Resume this task from its plan, in the same chat')
        : '') +
      (!winding ? lvBtn('drop', n.url, t.id, 'Drop', 'Drop it for good?', 'Forget this paused task and its plan: it can no longer be resumed', true) : '');
    var open = onTask ? '' : '<a class="wls__k" href="' + esc(wallTaskHref({ id: t.id, channel: t.channel, message: t.request }, t.agentId, n.url, true)) + '">Open the run</a>';
    return '<article class="wls is-stopped" aria-label="Paused task of ' + esc(nameOf(t.agentId)) + '">' +
      '<div class="wls__h"><span class="ax-badge ax-badge--warn">' + (winding ? 'Pausing…' : '❚❚ Paused') + '</span><span class="wls__k">' + esc(n.name) +
        (t.channel ? ' · ' + esc(t.channel) : '') + ' · stopped by ' + esc(stopperName(t.stoppedBy)) + (at ? ' at ' + esc(hhmm(at)) + ' (' + esc(ago(at)) + ')' : '') + '</span></div>' +
      (onTask ? '' : '<div class="wls__ag">' + avatar(t.agentId, 'sm') + '<b>' + esc(nameOf(t.agentId)) + '</b><span class="h">@' + esc(t.agentId) + '</span></div>') +
      (onTask ? '' : '<p class="wls__t">' + esc(t.request || 'A task') + '</p>') +
      (wf ? '<div class="wls__k">A workflow step: its run waits here until this resumes.</div>' : '') +
      (t.reason ? '<div class="wls__k">Why: ' + esc(t.reason) + '</div>' : '') +
      plan +
      '<div class="wls__f wlv__acts">' + open + '<span class="wlv__btns">' + acts + '</span></div></article>';
  }

  // --- Machines: restart when idle, attached sessions, connect a CLI ---
  function machinesHtml() {
    var nodes = (S.live && S.live.nodes) || [];
    if (!nodes.length) return '';
    return '<h3>Machines <small>' + nodes.length + '</small></h3><div class="wlv__mc">' + nodes.map(machineHtml).join('') + '</div>';
  }
  function machineHtml(n) {
    var down = !n.reachable || n.error;
    var badge = down
      ? '<span class="ax-badge ax-badge--err">' + (n.stale ? 'not responding' : 'unreachable') + '</span>'
      : '<span class="ax-badge ax-badge--live">up' + (n.uptimeSec ? ' ' + esc(dur(n.uptimeSec * 1000)) : '') + '</span>';
    var head = '<div class="wls__h"><b>' + esc(n.name) + '</b>' + badge + '</div>';
    if (down) {
      return '<article class="wls wmc is-down">' + head + '<p class="wls__k">' + esc(n.error || 'It does not answer.') +
        (n.stale ? ' Shown from its last answer, ' + esc(ago(Date.parse(n.staleSince) || Date.now())) + '.' : '') + ' Its controls come back when it answers.</p></article>';
    }
    return '<article class="wls wmc" aria-label="Machine ' + esc(n.name) + '">' + head +
      '<div class="wmc__r">' + restartHtml(n) + '</div>' + attachedHtml(n) + connectHtml(n) + '</article>';
  }
  function restartHtml(n) {
    var r = n.restart;
    if (!r) return '<span class="wls__k">This machine does not say whether it can restart, so it cannot restart from here.</span>';
    if (r.state === 'restarting') return '<span class="ax-badge ax-badge--warn" role="status">Restarting…</span>';
    if (r.state === 'pending') {
      var dl = Date.parse(r.deadline || '') || 0;
      return '<span class="ax-badge ax-badge--warn" role="status" title="It restarts as soon as no task runs">Restart waiting · ' +
          (typeof n.inflight === 'number' ? n.inflight + ' running' : 'tasks running') + (dl ? ' · until ' + esc(hhmm(dl)) : '') + '</span>' +
        lvBtn('cancel', n.url, '', 'Cancel restart', '', 'Keep it running: forget the restart', true);
    }
    return lvBtn('restart', n.url, '', 'Restart when idle', 'Restart once idle?', 'Restart this machine as soon as no task runs. It waits up to 30 minutes, then restarts anyway.', true) +
      '<span class="wls__k">' + (typeof n.inflight === 'number' ? (n.inflight ? n.inflight + ' running now' : 'Nothing running now') : '') + '</span>';
  }
  var ATTACH_MODE = { manual: 'you read its inbox', notify: 'tells you about new messages', auto: 'answers new messages' };
  /** Claude Code sessions attached here. Only the machine the dashboard runs on reports them. */
  function attachedHtml(n) {
    var rows = n.attachSessions;
    if (!rows) return '';
    if (!rows.length) return '<section class="wmc__s"><p class="wls__k">No Claude Code session attached.</p></section>';
    var list = rows.length ? '<ul class="wmc__l">' + rows.map(function (r) {
      var who = r.agentIds.length
        ? r.agentIds.map(function (id) { return avatar(id, 'sm') + '<b>' + esc(nameOf(id)) + '</b>'; }).join(' ')
        : '<span class="wls__k">answers for no agent</span>';
      var time = r.waiting ? 'waiting for the session to report again'
        : (r.startedAt ? 'started ' + hhmm(r.startedAt) + ' (' + ago(r.startedAt) + ')' : '') + (r.lastSeenAt ? (r.startedAt ? ' · ' : '') + 'seen ' + ago(r.lastSeenAt) : '');
      return '<li><span class="wmc__who">' + who + '</span><span class="wmc__m"><b>' + esc(r.project || 'A session') + '</b> · ' + esc(time) +
        (ATTACH_MODE[r.mode] ? ' · ' + esc(ATTACH_MODE[r.mode]) : '') + (r.pending ? ' · ' + r.pending + ' waiting for it' : '') + '</span></li>';
    }).join('') + '</ul>' : '<p class="wls__k">None attached. Connect one below, or open Claude Code with the AgentX attach hooks.</p>';
    return '<section class="wmc__s"><h4>Claude Code sessions <small>' + rows.length + '</small></h4>' + list + '</section>';
  }
  function connectHtml(n) {
    var c = lvState().cli[n.url], body = '';
    if (c && c.error) body = '<p class="wls__k">Could not look: ' + esc(c.error) + '</p>';
    else if (c && c.items) {
      body = c.items.length ? '<ul class="wmc__l">' + c.items.map(function (x, j) {
        return '<li><span class="wmc__m"><b>' + esc(x.name) + '</b> · ' + esc(x.meta) + '</span>' +
          (x.done ? '<span class="ax-badge ax-badge--live">Connected</span>' : lvBtn('reg', n.url, String(j), 'Connect', '', x.title)) + '</li>';
      }).join('') + '</ul>' : '<p class="wls__k">No CLI found. Only the processes this machine\'s AgentX account runs show here.</p>';
    }
    return '<section class="wmc__s"><h4>Connect a CLI session</h4>' +
      lvBtn('find', n.url, '', c && c.items ? 'Look again' : 'Find CLI sessions', '', 'Look for Claude Code and other CLIs running on this machine. AgentX reviews each turn of a connected one and tells you what needs you.', true) + body + '</section>';
  }
  function cliItems(d) {
    var base = function (p) { return String(p || '').replace(/\/+$/, '').split('/').pop() || 'A folder'; };
    return (d.sessions || []).map(function (s) {
      return { name: 'Claude Code in ' + base(s.label), meta: 'reports its turns itself', title: 'Review this session\'s turns', body: { id: s.id, runtime: s.runtime || 'claude', label: s.label || s.id } };
    }).concat((d.processes || []).map(function (p) {
      return { name: p.runtime, meta: 'running since ' + p.started, title: 'Register this process; add a stop hook or send its transcript to review it',
        body: { id: p.runtime + ':' + p.pid + ':' + p.started, label: p.runtime + ' ' + p.pid, runtime: p.runtime, pid: p.pid, started: p.started } };
    }));
  }

  /** A control pressed: arm it, or send it to the machine that holds what it acts on. */
  async function lvAct(kind, node, id) {
    var st = lvState(), key = lvKey(kind, node, id);
    if ((kind === 'drop' || kind === 'restart' || kind === 'pause') && st.armed !== key) {
      st.armed = key;
      render();
      setTimeout(function () { if (st.armed === key) { st.armed = ''; render(); } }, 6000);
      return;
    }
    st.armed = '';
    var q = '?node=' + encodeURIComponent(node);
    var plan = {
      resume: ['/api/signals/resume', { id: id }, 'Resuming…', 'Resumed: it goes on from its plan.'],
      drop: ['/api/signals/drop', { id: id }, 'Dropping…', 'Dropped. It can no longer be resumed.'],
      pause: ['/api/signals/stop', { taskId: id }, 'Pausing…', 'Pausing: the agent writes its resume plan, then it shows under Paused on Live.'],
      restart: ['/api/node/restart', {}, 'Asking…', 'Restart waiting: it restarts once no task runs.'],
      cancel: ['/api/node/restart/cancel', {}, 'Cancelling…', 'Restart cancelled.'],
      lesson: ['/api/voice/stop', {}, 'Stopping…', 'Lesson stopped.'],
    }[kind];
    if (kind === 'find') {
      st.busy[key] = 'Looking…';
      render();
      var f = await act('GET', '/api/monitor/discover' + q);
      delete st.busy[key];
      st.cli[node] = f.ok ? { items: cliItems(f.body || {}) } : { error: f.error };
      render();
      return;
    }
    if (kind === 'reg') {
      var item = st.cli[node] && st.cli[node].items && st.cli[node].items[Number(id)];
      if (!item) return;
      st.busy[key] = 'Connecting…';
      render();
      var g = await act('POST', '/api/monitor/register' + q, item.body);
      delete st.busy[key];
      if (g.ok) item.done = true;
      st.msg = g.ok ? 'Connected ' + item.name + '. AgentX reviews its next turns.' : 'Not connected: ' + g.error;
      render();
      return;
    }
    if (!plan) return;
    st.busy[key] = plan[2];
    st.msg = '';
    render();
    var r = await act('POST', plan[0] + q, plan[1]);
    delete st.busy[key];
    st.msg = r.ok ? plan[3] : 'Not done: ' + r.error;
    render();
  }

  // --- @mentions in a comment: the other agents it names ---
  // A name may be several words ("@Far Agent"); it must end at a word
  // boundary, so @far does not name "farm" and "a@far" is not a mention.
  function mentionedAgents(text, except) {
    var nodes = (S.live && S.live.nodes) || [], t = String(text).toLowerCase(), found = [];
    function at(s) {
      if (!s) return -1;
      var tag = '@' + s.toLowerCase();
      for (var i = t.indexOf(tag); i !== -1; i = t.indexOf(tag, i + 1)) {
        var after = t.slice(i + tag.length);
        if ((i === 0 || !/[a-z0-9_]/.test(t.charAt(i - 1))) && !/^([a-z0-9_-]|[.:][a-z0-9_])/.test(after)) return i;
      }
      return -1;
    }
    nodes.forEach(function (n, i) {
      (n.agents || []).forEach(function (a) {
        if (a.id === except || found.some(function (f) { return f.id === a.id; })) return;
        var pos = [at(a.id), at(a.name)].filter(function (x) { return x !== -1; });
        if (pos.length) found.push({ id: a.id, name: a.name || a.id, peer: i === 0 ? null : n.url, pos: Math.min.apply(null, pos) });
      });
    });
    return found.sort(function (x, y) { return x.pos - y.pos; });
  }
  /** Each agent a comment names gets its own post about it, on its machine. */
  async function tellMentioned(p, text) {
    var told = [];
    for (var m of mentionedAgents(text, p.owner)) {
      var body = 'The owner mentioned you in a comment on Wall post ' + p.id + ' by @' + p.owner + ': "' + (p.headline || p.id) + '".\n\nTheir comment:\n' + text;
      var r = await act('POST', '/api/admin/wall/post', { agent: m.id, text: body }, m.peer);
      told.push(r.ok ? '@' + m.id : '@' + m.id + ' (not sent: ' + r.error + ')');
    }
    return told;
  }

  // --- Call and join from an agent's page ---
  /** Where an agent works now, if anywhere: its live task, on its machine. */
  function liveTaskOf(id) {
    var hit = null;
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      (n.agents || []).forEach(function (a) { if (!hit && a.id === id && (a.runningTasks || []).length) hit = { n: n, t: a.runningTasks[0] }; });
    });
    return hit;
  }
  function agentActsHtml(id) {
    var w = liveTaskOf(id);
    return '<button type="button" class="ax-btn ax-btn--ghost" data-call-agent="' + esc(id) + '" title="' + esc(nameOf(id)) + ' calls you on AgentX Voice">Call</button>' +
      (w ? '<a class="ax-btn" href="' + esc(wallTaskHref(w.t, id, w.n.url)) + '">● Join live</a>' : '');
  }
  async function callAgent(id) {
    var nodes = (S.live && S.live.nodes) || [];
    var home = nodes.findIndex(function (n) { return (n.agents || []).some(function (a) { return a.id === id; }); });
    var r = await act('POST', '/api/admin/wall/call', { agent: id }, home > 0 ? nodes[home].url : null);
    S.callNote = r.ok ? nameOf(id) + ' is calling you on AgentX Voice.' + (r.body && r.body.busy ? ' You look busy: it waits for you.' : '') : 'No call: ' + r.error;
    render();
  }
  document.addEventListener('click', function (ev) {
    // A plan opened or closed stays so through the next repaint.
    var pl = ev.target.closest('[data-lv-plan]');
    if (pl && ev.target.closest('summary')) lvState().open[pl.getAttribute('data-lv-plan')] = !pl.open;
    var t = ev.target.closest('[data-join-space],[data-live-start],[data-call-agent],[data-lv]');
    if (!t) return;
    if (t.hasAttribute('data-lv')) lvAct(t.getAttribute('data-lv'), t.getAttribute('data-lv-node'), t.getAttribute('data-lv-id'));
    else if (t.hasAttribute('data-join-space')) joinSpace();
    else if (t.hasAttribute('data-live-start')) startSpace();
    else callAgent(t.getAttribute('data-call-agent'));
  });
`

export const WALL_LIVE_CSS = `
/* Live sessions (#1355), as Spaces on X: live first, with Join. */
.wlv { padding: 4px 16px 24px; }
.wlv h3 { font-size: var(--ax-fs); margin: 14px 0 8px; }
.wlv h3 small { color: var(--ax-muted); font-weight: 400; }
.wls { border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 12px 14px; margin-bottom: 10px; background: var(--ax-bg-elev); }
.wls.is-space { background: linear-gradient(120deg, color-mix(in srgb, var(--ax-accent) 14%, var(--ax-bg)), var(--ax-bg)); border-color: color-mix(in srgb, var(--ax-accent) 40%, var(--ax-border)); }
.wls__h { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.wls__k { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wls__t { margin: 6px 0 8px; font-weight: 700; font-size: 17px; overflow-wrap: anywhere; }
.wls.is-work { display: block; color: inherit; text-decoration: none; }
.wls.is-work:hover { border-color: var(--ax-accent); text-decoration: none; }
.wls.is-work .wls__t { font-weight: 500; font-size: var(--ax-fs); margin: 4px 0 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wls__ag { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: var(--ax-fs-sm); min-width: 0; }
.wls__ag .h { color: var(--ax-muted); }
.wls__act { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-top: 1px solid var(--ax-border); padding-top: 6px; }
.wls__act .wls__k { font-family: var(--ax-font, inherit); text-transform: uppercase; letter-spacing: .05em; font-size: 10px; }
.wls__f { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.wls__who { display: inline-flex; align-items: center; gap: 4px; font-size: var(--ax-fs-sm); min-width: 0; }
.wls__who > span { margin-left: 4px; color: var(--ax-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wlv__next { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.wlv__next li { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wlv__next li > span:nth-child(2) { flex: 1; min-width: 0; }
.wlv__next small { color: var(--ax-muted); }
.wlv select { font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 5px 10px; }
/* The owner's controls (#1439): paused tasks and machines. */
.wlv__note { margin: 8px 0 0; padding: 8px 12px; border-radius: var(--ax-radius-lg); background: var(--ax-bg-elev); border: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wlv__note.is-empty { display: none; }
.wls.is-stopped { border-color: color-mix(in srgb, var(--ax-warn) 45%, var(--ax-border)); }
.wls.is-stopped .wls__t { font-weight: 500; font-size: var(--ax-fs); margin: 4px 0 6px; overflow-wrap: anywhere; }
.wls__plan { margin: 6px 0; font-size: var(--ax-fs-sm); }
.wls__plan summary { cursor: pointer; color: var(--ax-text-2); }
.wls__plan pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--ax-mono); font-size: var(--ax-fs-xs); background: var(--ax-bg); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 8px; margin: 6px 0 0; max-height: 40vh; overflow: auto; }
.wlv__acts { flex-wrap: wrap; margin-top: 6px; }
.wlv__btns { display: inline-flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.wlv .wlv__b { font-size: var(--ax-fs-xs); padding: 4px 14px; }
.wlv .wlv__b.is-armed { background: var(--ax-err); border-color: var(--ax-err); color: #fff; }
.wlv__mc { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 10px; }
.wmc { margin: 0; min-width: 0; }
.wmc.is-down { opacity: .8; }
.wmc__r { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0 2px; }
.wmc__s { border-top: 1px solid var(--ax-border); margin-top: 10px; padding-top: 8px; }
.wmc__s h4 { margin: 0 0 6px; font-size: var(--ax-fs-sm); }
.wmc__s h4 small { color: var(--ax-muted); font-weight: 400; }
.wmc__s p { margin: 0 0 6px; }
.wmc__l { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wmc__l li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: var(--ax-fs-sm); min-width: 0; }
.wmc__who { display: inline-flex; gap: 4px; align-items: center; }
.wmc__m { flex: 1; min-width: 0; color: var(--ax-text-2); overflow-wrap: anywhere; }
.wls.is-lesson .wls__f .wlv__b { margin-left: 8px; }
.wag__acts, .wpf__acts { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.wag__acts .ax-btn, .wpf__acts .ax-btn { font-size: var(--ax-fs-xs); padding: 4px 14px; }
`
