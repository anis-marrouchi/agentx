// --- Wall v2 live sessions, browser side (#1355) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), when(), until(), stamp(), avatar(), nameOf(), allAgents(),
// taskHref(), act(), note(), paintSpace() and pollSpace().
//
// The Live page (#page=live) lists every live session on every machine,
// as Spaces do on X: the live ones on top (a Space, a lesson on a
// machine's screen, an agent at work), each with Join; then what comes up
// next (the next scheduled jobs); then a form to start a Space. Joining a
// Space on this computer opens it here, with its transcript and a box to
// say something into it. A Space on another machine plays there, so it is
// named with its machine. Joining an agent at work opens its live task.
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
  function sessionHtml(s) {
    var who = s.agents.map(function (id) { return avatar(id, 'sm'); }).join('');
    var names = s.agents.map(function (id) { return esc(nameOf(id)); }).join(' and ');
    var label = s.kind === 'space' ? 'Space' : s.kind === 'lesson' ? 'Lesson' : 'Working';
    var join = s.kind === 'space'
      ? (s.here ? '<button type="button" class="ax-btn" data-join-space>Join</button>' : '<span class="wls__k">Plays on ' + esc(s.node.name) + '</span>')
      : s.kind === 'lesson' ? '<span class="wls__k">On ' + esc(s.node.name) + '\'s screen</span>'
      : '<a class="ax-btn ax-btn--ghost" href="' + esc(taskHref(s.task.id, s.agent.id, { daemonUrl: s.node.url }, false)) + '">Join</a>';
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
    var live = liveSessions(), next = comingUp();
    var agents = allAgents().filter(function (a) { return a.nodes.length; });
    var opts = function (pick) { return agents.map(function (a, i) { return '<option value="' + esc(a.id) + '"' + (i === pick ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join(''); };
    return '<div class="wlv">' +
      '<h3>Live now <small>' + live.length + '</small></h3>' +
      (live.length ? live.map(sessionHtml).join('') : '<p class="ax-wall__empty">Nothing is live. Start a Space below, or open a post and start one about it.</p>') +
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

  // --- @mentions in a comment: the other agents it names ---
  function mentionedAgents(text, except) {
    var nodes = (S.live && S.live.nodes) || [], found = [];
    (String(text).match(/@[A-Za-z0-9_.:-]+/g) || []).forEach(function (m) {
      var name = m.slice(1).replace(/[.:]+$/, '').toLowerCase();
      nodes.forEach(function (n, i) {
        (n.agents || []).forEach(function (a) {
          if ((a.id.toLowerCase() === name || (a.name || '').toLowerCase() === name) && a.id !== except && !found.some(function (f) { return f.id === a.id; })) {
            found.push({ id: a.id, name: a.name || a.id, peer: i === 0 ? null : n.url });
          }
        });
      });
    });
    return found;
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
      (w ? '<a class="ax-btn" href="' + esc(taskHref(w.t.id, id, { daemonUrl: w.n.url }, false)) + '">● Join live</a>' : '');
  }
  async function callAgent(id) {
    var nodes = (S.live && S.live.nodes) || [];
    var home = nodes.findIndex(function (n) { return (n.agents || []).some(function (a) { return a.id === id; }); });
    var r = await act('POST', '/api/admin/wall/call', { agent: id }, home > 0 ? nodes[home].url : null);
    S.callNote = r.ok ? nameOf(id) + ' is calling you on AgentX Voice.' + (r.body && r.body.busy ? ' You look busy: it waits for you.' : '') : 'No call: ' + r.error;
    render();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-join-space],[data-live-start],[data-call-agent]');
    if (!t) return;
    if (t.hasAttribute('data-join-space')) joinSpace();
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
.wls.is-work .wls__t { font-weight: 500; font-size: var(--ax-fs); }
.wls__f { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.wls__who { display: inline-flex; align-items: center; gap: 4px; font-size: var(--ax-fs-sm); min-width: 0; }
.wls__who > span { margin-left: 4px; color: var(--ax-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wlv__next { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.wlv__next li { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wlv__next li > span:nth-child(2) { flex: 1; min-width: 0; }
.wlv__next small { color: var(--ax-muted); }
.wlv select { font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 5px 10px; }
.wag__acts, .wpf__acts { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.wag__acts .ax-btn, .wpf__acts .ax-btn { font-size: var(--ax-fs-xs); padding: 4px 14px; }
`
