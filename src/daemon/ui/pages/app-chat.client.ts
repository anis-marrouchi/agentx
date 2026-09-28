// --- Phone app: Chat tab body ---
//
// Vanilla browser JS inlined into /app (app.ts), after APP_CHAT_VIEW_SCRIPT.
// Pick an agent (GET /api/app/agents), then POST /api/app/chat streams the
// reply as SSE (app-chat.ts). A message typed while the agent is answering
// waits on the phone and goes as the next turn, so its answer streams here
// too. The finished conversation is re-read from the server and kept in
// IndexedDB, so History opens with no connection (read-only).
//
// The voice bar (app-voice.client.ts) drives it through window.AXChat and
// follows it through "ax-chat" events on document: target, busy, final.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_CHAT_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-chat');
  var V = window.AXChatView;
  if (!panel || !V) return;
  // The head (agent, History, New) and its two sheets stay pinned at the top
  // of a long conversation, as the composer stays at the bottom.
  panel.innerHTML = '<h2 class="cx-sr">Chat</h2><div class="cx"><div class="cx-top">' +
    '<div class="cx-head"><button type="button" id="cx-pick" class="cx-pick" aria-controls="cx-picker" aria-expanded="false">' +
    '<span class="cx-pick-label">Choose an agent</span><span class="cx-pick-sub">Tap to see the agents on your machines</span></button>' +
    '<button type="button" id="cx-history-btn" class="fx-btn" aria-controls="cx-history" aria-expanded="false">History</button>' +
    '<button type="button" id="cx-new" class="fx-btn">New</button></div>' +
    '<div id="cx-picker" class="cx-sheet" role="region" aria-label="Agents" hidden></div>' +
    '<div id="cx-history" class="cx-sheet" role="region" aria-label="Past conversations" hidden></div></div>' +
    '<p id="cx-empty" class="soon">Pick an agent, then ask it anything. Its answer appears here as it writes.</p>' +
    '<div id="cx-log" class="cx-log" role="log" aria-live="polite"></div>' +
    '<form id="cx-form" class="cx-composer"><label for="cx-input" class="cx-sr">Message</label>' +
    '<textarea id="cx-input" rows="1" placeholder="Message" enterkeyhint="send" autocomplete="off"></textarea>' +
    '<button type="button" id="cx-stop" class="fx-btn fx-danger" hidden>Stop</button>' +
    '<button type="submit" id="cx-send" class="cx-send">Send</button></form></div>';

  function $(id) { return document.getElementById(id); }
  var log = $('cx-log'), empty = $('cx-empty'), form = $('cx-form'), input = $('cx-input'), stopBtn = $('cx-stop');
  var pickBtn = $('cx-pick'), picker = $('cx-picker'), hist = $('cx-history'), histBtn = $('cx-history-btn'), newBtn = $('cx-new');
  var state = { conv: null, target: null, busy: false, queue: [], stopWanted: false, view: 0 };
  var NOTES = { stopped: 'Stopped. What the agent wrote so far is kept.', error: 'The agent could not answer.',
    running: 'Still answering. The answer appears here when it is ready.',
    lost: 'Connection lost. The agent keeps answering; the answer appears here when the phone is back online.' };

  function remember(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function emit(type, detail) { document.dispatchEvent(new CustomEvent('ax-chat', { detail: Object.assign({ type: type }, detail || {}) })); }
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {})).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('not paired'); }
      return r;
    });
  }
  function post(path, body, signal) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal });
  }

  // --- The log ---
  function scrollDown() { var m = document.querySelector('main'); if (m) m.scrollTop = m.scrollHeight; }
  function clearLog() { log.innerHTML = ''; empty.hidden = false; }
  function bubble(cls) {
    var el = document.createElement('div');
    el.className = 'cx-msg ' + cls;
    log.appendChild(el);
    empty.hidden = true;
    return el;
  }
  function userMsg(text) { var el = bubble('cx-user'); el.textContent = text; return el; }
  function agentMsg() {
    var el = bubble('cx-agent');
    el.innerHTML = '<div class="md cx-typing">Thinking…</div><div class="cx-files"></div><div class="cx-ui"></div><p class="cx-note" hidden></p>';
    return el;
  }
  function setBody(el, text) { el.replaceChild(V.md(text), el.querySelector('.md')); }
  function setNote(el, text, bad) {
    var n = el.querySelector('.cx-note');
    n.hidden = !text; n.textContent = text || ''; n.className = 'cx-note' + (bad ? ' cx-bad' : '');
  }
  function renderUi(el, ui) { V.renderUi(el.querySelector('.cx-ui'), ui, send); }
  function renderFiles(el, files) { V.renderFiles(el.querySelector('.cx-files'), files); }
  function renderConversation(conv) {
    clearLog();
    (conv.messages || []).forEach(function (m) {
      if (m.role === 'user') { userMsg(m.content); return; }
      var el = agentMsg();
      setBody(el, m.content || '');
      V.setTools(el, m.tools);
      renderFiles(el, m.files);
      renderUi(el, m.ui);
      if (m.status && m.status !== 'done') setNote(el, m.error || NOTES[m.status] || '', m.status === 'error');
    });
    var live = null;
    if (conv.running) {
      // What the agent has written so far; the live stream carries on from it.
      live = agentMsg();
      if (conv.partial && conv.partial.text) setBody(live, V.preview(conv.partial.text));
      V.setTools(live, conv.partial && conv.partial.tools);
      setNote(live, NOTES.running);
    }
    // Follow-ups typed while it answers stay below, waiting to be sent.
    state.queue.forEach(function (x) { log.appendChild(x.el); });
    scrollDown();
    return live;
  }

  // --- Agent, conversation and the sheets ---
  function showTarget(t) {
    pickBtn.querySelector('.cx-pick-label').textContent = t ? (t.agentName || t.agent) : 'Choose an agent';
    pickBtn.querySelector('.cx-pick-sub').textContent = t ? 'on ' + t.nodeName : 'Tap to see the agents on your machines';
    emit('target', { target: t });
  }
  function useConversation(conv) {
    state.conv = conv;
    var color = state.target && state.target.agent === conv.agent ? state.target.color : undefined;
    state.target = { node: conv.node, nodeName: conv.nodeName, agent: conv.agent, agentName: conv.agentName, color: color };
    showTarget(state.target);
    remember('ax-chat-conv', conv.id);
    remember('ax-chat-target', state.target);
  }
  function toggle(sheet, open) {
    [[picker, pickBtn], [hist, histBtn]].forEach(function (p) {
      var on = p[0] === sheet && open;
      p[0].hidden = !on; p[1].setAttribute('aria-expanded', on ? 'true' : 'false');
    });
  }
  function loadPicker() {
    picker.innerHTML = '<p class="cx-note">Looking for agents…</p>';
    api('/api/app/agents').then(function (r) { return r.json(); }).then(function (data) {
      var nodes = picker._data = data.nodes || [];
      if (!nodes.length) { picker.innerHTML = '<p class="cx-note">No machines answered. Check that AgentX is running.</p>'; return; }
      picker.innerHTML = nodes.map(function (n, i) {
        var can = n.target && n.online;
        var why = !n.target ? 'Not linked to this computer’s mesh' : n.online ? 'Online' : 'Offline';
        var rows = n.agents.length ? n.agents.map(function (a, j) {
          return '<li><button type="button" data-n="' + i + '" data-a="' + j + '"' + (can ? '' : ' disabled') + '>' +
            '<span>' + V.esc(a.name) + '<span class="cx-sub">' + V.esc(a.id) + '</span></span>' +
            '<span class="cx-state' + (a.busy ? ' cx-busy' : '') + '">' + (a.busy ? 'busy' + (a.running > 1 ? ' · ' + a.running : '') : 'idle') + '</span></button></li>';
        }).join('') : '<li class="cx-note">No agents</li>';
        return '<h3><span class="cx-dot' + (n.online ? ' cx-on' : '') + '"></span>' + V.esc(n.name) + ' <span class="cx-sub">' + V.esc(why) + '</span></h3><ul>' + rows + '</ul>';
      }).join('');
    }).catch(function () { picker.innerHTML = '<p class="cx-note cx-bad">Could not load agents. Check the connection and try again.</p>'; });
  }
  picker.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-a]');
    if (!b || !picker._data) return;
    var n = picker._data[+b.getAttribute('data-n')], a = n.agents[+b.getAttribute('data-a')];
    state.target = { node: n.target, nodeName: n.name, agent: a.id, agentName: a.name, color: a.color };
    remember('ax-chat-target', state.target);
    startNew();
    toggle(picker, false);
    input.focus();
  });
  function startNew() {
    if (state.busy) return;
    state.view++;
    clearTimeout(pollTimer);
    state.conv = null;
    remember('ax-chat-conv', null);
    showTarget(state.target);
    clearLog();
    setBusy(false);
  }
  function when(ms) { var d = new Date(ms); return isNaN(d.getTime()) ? '' : d.toLocaleString(); }
  function loadHistory() {
    hist.innerHTML = '<p class="cx-note">Loading…</p>';
    api('/api/app/conversations').then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { paintHistory(d.conversations || [], false); })
      .catch(function () { V.cacheAll().then(function (all) { paintHistory(all, true); }); });
  }
  function paintHistory(list, offline) {
    if (!list.length) { hist.innerHTML = '<p class="cx-note">' + (offline ? 'Offline, and nothing is saved on this phone yet.' : 'No conversations yet.') + '</p>'; return; }
    hist.innerHTML = (offline ? '<p class="cx-note">Offline: showing the conversations saved on this phone.</p>' : '') + '<ul>' + list.map(function (c) {
      return '<li><button type="button" data-c="' + V.esc(c.id) + '"><span>' + V.esc(c.title) +
        '<span class="cx-sub">' + V.esc((c.agentName || c.agent) + ' · ' + c.nodeName + ' · ' + when(c.updatedAt)) + '</span></span></button></li>';
    }).join('') + '</ul>';
  }
  hist.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-c]');
    if (!b) return;
    toggle(hist, false);
    openConversation(b.getAttribute('data-c'));
  });
  var pollTimer = 0;
  function openConversation(id) {
    if (state.busy) return;
    clearTimeout(pollTimer);
    // The phone's copy first, so it opens at once and offline; the server's
    // copy replaces it when it arrives. A load that finishes after the user
    // moved on (New, another conversation, a send) is dropped.
    var mine = ++state.view, fromServer = false;
    V.cacheGet(id).then(function (c) { if (c && !fromServer && mine === state.view) { useConversation(c); renderConversation(c); } });
    return api('/api/app/conversations/' + encodeURIComponent(id)).then(function (r) {
      if (mine !== state.view) return null;
      if (r.status === 404) { fromServer = true; V.cacheDrop(id); startNew(); return null; }
      return r.ok ? r.json() : null;
    }).then(function (c) {
      if (!c || mine !== state.view) return;
      fromServer = true;
      useConversation(c);
      var live = renderConversation(c);
      if (!c.running) { V.cachePut(c); return; }
      // Still running: pick the live stream up where it is.
      follow(api('/api/app/chat/attach?conversationId=' + encodeURIComponent(id)), live, c.partial || {});
    }).catch(function () {});
  }

  // --- Sending, streaming, stopping ---
  function setBusy(on) {
    state.busy = on;
    stopBtn.hidden = !on;
    newBtn.disabled = on;
    log.setAttribute('aria-busy', on ? 'true' : 'false');
    emit('busy', { on: on });
  }
  function send(text) {
    text = String(text || '').trim();
    if (!text) return;
    if (state.busy) {
      // A follow-up while the agent answers: shown now, sent as the next
      // turn so its answer streams here as well.
      var q = userMsg(text);
      q.classList.add('cx-queued');
      state.queue.push({ text: text, el: q });
      input.value = ''; input.style.height = '';
      scrollDown();
      return;
    }
    if (!navigator.onLine) { flash('Offline. Messages can be sent once the phone is connected again.'); return; }
    if (!state.conv && !state.target) { toggle(picker, true); loadPicker(); return; }
    var body = state.conv
      ? { conversationId: state.conv.id, message: text }
      : { node: state.target.node, agent: state.target.agent, message: text };
    state.stopWanted = false;
    userMsg(text);
    input.value = ''; input.style.height = '';
    follow(post('/api/app/chat', body), agentMsg(), null);
  }
  // Streams one turn into the bubble el, from a send or from attaching
  // to a turn that is still running. The phone losing its connection does
  // not stop the agent: the answer is saved and shown when the phone is back.
  function follow(request, el, partial) {
    clearTimeout(pollTimer);
    state.view++;
    var raw = (partial && partial.text) || '', tools = ((partial && partial.tools) || []).slice(), ended = false, frame = 0;
    function paint() { frame = 0; if (!ended && raw) { setBody(el, V.preview(raw)); scrollDown(); } }
    function finish(content, note, bad, ui, files) {
      ended = true;
      setBody(el, content || '');
      renderFiles(el, files);
      renderUi(el, ui);
      setNote(el, note, bad);
      scrollDown();
      // own: a turn this phone sent now, not one it came back to.
      emit('final', { own: !partial, ok: !note, content: content || '', conversationId: state.conv && state.conv.id });
    }
    setBusy(true);
    scrollDown();
    return request.then(function (r) {
      // Attaching just after the turn ended: reload the saved answer.
      if (r.status === 404 && partial) { ended = true; return; }
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { finish(raw, j.error || ('Failed (HTTP ' + r.status + ')'), true); });
      return V.readStream(r.body, function (ev, d) {
        if (ev === 'conversation') { useConversation(d); if (state.stopWanted) { state.stopWanted = false; stop(); } }
        else if (ev === 'resume') { raw = d.text || ''; tools = (d.tools || []).slice(); V.setTools(el, tools); setNote(el, ''); paint(); }
        else if (ev === 'text' && typeof d.text === 'string') { raw += d.text; if (!frame) frame = requestAnimationFrame(paint); }
        else if (ev === 'tool' && d.status === 'start') { tools.push({ id: d.id, name: d.name, arg: d.arg }); V.setTools(el, tools); }
        else if (ev === 'tool' && d.error) { tools.forEach(function (t) { if (t.id === d.id) t.error = true; }); V.setTools(el, tools); }
        else if (ev === 'final') finish(d.content, d.status === 'done' ? '' : (d.error || NOTES[d.status]), d.status === 'error', d.ui, d.files);
      });
    }).catch(function () {}).then(function () {
      setBusy(false);
      if (!ended) {
        // The stream broke before the answer: the agent carries on.
        setNote(el, state.conv ? NOTES.lost : 'Could not reach AgentX. Check the connection and try again.', !state.conv);
        if (state.conv) { var id = state.conv.id; pollTimer = setTimeout(function () { if (state.conv && state.conv.id === id) openConversation(id); }, 5000); }
        return;
      }
      if (state.queue.length) {
        var next = state.queue.splice(0);
        next.forEach(function (x) { x.el.remove(); });
        send(next.map(function (x) { return x.text; }).join(V.NL + V.NL));
      } else if (state.conv) openConversation(state.conv.id);
    });
  }
  function stop() {
    // Only Stop cancels. Before the conversation exists, wait for its id.
    if (!state.conv) { state.stopWanted = true; return; }
    post('/api/app/chat/stop', { conversationId: state.conv.id }).catch(function () {});
  }
  function flash(text) {
    var el = bubble('cx-agent');
    el.innerHTML = '<p class="cx-note cx-bad"></p>';
    el.firstChild.textContent = text;
    scrollDown();
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  input.addEventListener('input', function () { input.style.height = ''; input.style.height = Math.min(input.scrollHeight, 240) + 'px'; });
  stopBtn.addEventListener('click', stop);
  pickBtn.addEventListener('click', function () { var open = picker.hidden; toggle(picker, open); if (open) loadPicker(); });
  histBtn.addEventListener('click', function () { var open = hist.hidden; toggle(hist, open); if (open) loadHistory(); });
  newBtn.addEventListener('click', function () { startNew(); input.focus(); });

  window.addEventListener('online', function () { if (state.conv && !state.busy) openConversation(state.conv.id); });
  window.AXChat = { send: send, busy: function () { return state.busy; }, target: function () { return state.target; },
    pick: function () { toggle(picker, true); loadPicker(); } };
  state.target = recall('ax-chat-target');
  showTarget(state.target);
  var last = recall('ax-chat-conv');
  if (last) openConversation(last);
})();
`
