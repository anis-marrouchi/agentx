// --- Phone app: Chat tab body ---
//
// Vanilla browser JS inlined into /app (app.ts), after APP_CHAT_VIEW_SCRIPT,
// APP_CHAT_LOG_SCRIPT and APP_CHAT_SHEETS_SCRIPT. Pick an agent (GET /api/app/agents), then
// POST /api/app/chat streams the reply as SSE (app-chat.ts). A message typed
// while the agent is answering waits on the phone and goes as the next turn,
// so its answer streams here too. The finished conversation is re-read from
// the server and kept in IndexedDB, so History opens with no connection
// (read-only).
//
// Several conversations can run at once (#265). Switching away from one
// that is answering only lets go of its stream: the computer keeps the turn
// running, and follow-ups typed for it stay held on the phone until it is
// done. The conversation strip (app-chat-strip.client.ts) switches through
// window.AXChat.open, and a notification opens /app#chat=<id>.
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
  if (!panel || !V || !window.AXChatSheets || !window.AXChatLog) return;
  // History and New stay above the scrolling log. Voice moves the agent
  // picker into the bottom dock; its lists open in a native modal sheet.
  panel.innerHTML = '<h2 class="cx-sr">Chat</h2><div class="cx"><div class="cx-top">' +
    '<div class="cx-head"><button type="button" id="cx-pick" class="cx-pick" aria-haspopup="dialog" aria-controls="cx-picker" aria-expanded="false">' +
    '<span class="cx-pick-intro">Talking to</span><span class="cx-pick-label">Choose an agent</span><span class="cx-pick-sub">Tap to see the agents on your machines</span></button>' +
    '<button type="button" id="cx-history-btn" class="fx-btn" aria-haspopup="dialog" aria-label="History" title="History" aria-controls="cx-history" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2"/></svg></button>' +
    '<button type="button" id="cx-new" class="fx-btn" aria-label="New conversation" title="New conversation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>' +
    '</div><dialog id="cx-dialog" class="fx-sheet" aria-labelledby="cx-sheet-title"><div class="sheet-head"><h3 id="cx-sheet-title">Choose an agent</h3><button type="button" class="fx-btn" id="cx-sheet-done">Done</button></div><div id="cx-picker" class="cx-sheet" role="region" aria-label="Agents" hidden></div>' +
    '<div id="cx-history" class="cx-sheet" role="region" aria-label="Past conversations" hidden></div></dialog>' +
    '<p id="cx-empty" class="soon">Pick an agent, then ask it anything. Its answer appears here as it writes.</p>' +
    '<div id="cx-log" class="cx-log" role="log" aria-live="polite"></div>' +
    '<form id="cx-form" class="cx-composer"><label for="cx-input" class="cx-sr">Message</label>' +
    '<textarea id="cx-input" rows="1" placeholder="Message" enterkeyhint="send" autocomplete="off"></textarea>' +
    '<button type="button" id="cx-stop" class="fx-btn fx-danger" hidden>Stop</button>' +
    '<button type="submit" id="cx-send" class="cx-send">Send</button></form></div>';

  function $(id) { return document.getElementById(id); }
  var log = $('cx-log'), empty = $('cx-empty'), form = $('cx-form'), input = $('cx-input'), stopBtn = $('cx-stop');
  var pickBtn = $('cx-pick'), picker = $('cx-picker'), hist = $('cx-history'), histBtn = $('cx-history-btn'), newBtn = $('cx-new');
  var dialog = $('cx-dialog');
  document.body.appendChild(dialog);
  window.AXSheet(dialog, function () {
    [[picker, pickBtn], [hist, histBtn]].forEach(function (p) { p[0].hidden = true; p[1].setAttribute('aria-expanded', 'false'); });
  });
  $('cx-sheet-done').addEventListener('click', function () { dialog.close(); });
  // flow: the stream this view follows; a stream from before a switch is ignored.
  var state = { conv: null, target: null, busy: false, queue: [], stopWanted: false, view: 0, flow: 0, ac: null };
  // Follow-ups typed for a conversation the phone switched away from, and
  // the conversations sent from this phone (their answers are read out).
  var held = {}, sentHere = {};
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

  // --- The log (app-chat-log.client.ts) ---
  var L = window.AXChatLog({ V: V, log: log, empty: empty, notes: NOTES, send: function (t) { return send(t); }, queue: function () { return state.queue; } });
  var scrollDown = L.scrollDown, clearLog = L.clear, userMsg = L.userMsg, queuedMsg = L.queuedMsg, agentMsg = L.agentMsg;
  var setBody = L.setBody, setNote = L.setNote, renderUi = L.renderUi, renderFiles = L.renderFiles, renderConversation = L.renderConversation, flash = L.flash;

  // --- Agent, conversation and the sheets ---
  function showTarget(t) {
    pickBtn.querySelector('.cx-pick-intro').hidden = !t;
    pickBtn.querySelector('.cx-pick-label').textContent = t ? (t.agentName || t.agent) : 'Choose an agent';
    pickBtn.querySelector('.cx-pick-sub').textContent = t ? 'on ' + t.nodeName : 'Tap to see the agents on your machines';
    emit('target', { target: t, conversationId: state.conv && state.conv.id });
  }
  function useConversation(conv) {
    state.conv = conv;
    var color = conv.color || (state.target && state.target.agent === conv.agent ? state.target.color : undefined);
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
    if (open) {
      $('cx-sheet-title').textContent = sheet === picker ? 'Choose an agent' : 'Past conversations';
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) dialog.close();
  }
  var sheets = window.AXChatSheets({ V: V, api: api, picker: picker, hist: hist,
    onPick: function (t) { state.target = t; remember('ax-chat-target', t); startNew(); toggle(picker, false); if (document.querySelector('.cx').classList.contains('cx-typing-on')) input.focus(); },
    onOpen: function (id) { toggle(hist, false); openConversation(id); } });

  // Lets go of the stream being followed; the computer keeps the turn going.
  // Follow-ups typed for it stay held until it is done.
  function detach() {
    if (!state.busy) return;
    var id = state.conv && state.conv.id;
    if (id && state.queue.length) held[id] = (held[id] || []).concat(state.queue.map(function (x) { return x.text; }));
    state.queue = [];
    state.flow++;
    if (state.ac) { try { state.ac.abort(); } catch (e) {} }
    setBusy(false);
    if (id) emit('detached', { conversationId: id });
  }
  function startNew() {
    detach();
    state.view++;
    clearTimeout(pollTimer);
    state.conv = null;
    remember('ax-chat-conv', null);
    showTarget(state.target);
    clearLog();
    setBusy(false);
  }
  var pollTimer = 0;
  function openConversation(id) {
    if (state.busy && state.conv && state.conv.id === id) return;
    detach();
    clearTimeout(pollTimer);
    // The phone's copy first, so it opens at once and offline; the server's
    // copy replaces it when it arrives. A load that finishes after the user
    // moved on (New, another conversation, a send) is dropped.
    var mine = ++state.view, fromServer = false;
    // Held follow-ups come back as waiting bubbles.
    state.queue = (held[id] || []).map(queuedMsg);
    delete held[id];
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
      if (!c.running) { V.cachePut(c); sendQueued(); return; }
      // Still running: pick the live stream up where it is.
      follow(function (signal) { return api('/api/app/chat/attach?conversationId=' + encodeURIComponent(id), { signal: signal }); }, live, c.partial || {});
    }).catch(function () {});
  }

  // --- Sending, streaming, stopping ---
  function setBusy(on) {
    state.busy = on;
    stopBtn.hidden = !on;
    log.setAttribute('aria-busy', on ? 'true' : 'false');
    emit('busy', { on: on });
  }
  // Empties the box only for the text it held: a tapped quick reply keeps
  // a half-typed draft.
  function clearInput(sent) {
    if (input.value.trim() !== sent) return;
    input.value = ''; input.style.height = '';
  }
  // False when the text was neither sent nor queued, so a quick reply
  // stays tappable. opts.spoken: the text came from voice, which the
  // computer records as a spoken turn (Activity shows it as Voice).
  function send(text, opts) {
    text = String(text || '').trim();
    if (!text) return false;
    var spoken = !!(opts && opts.spoken);
    if (state.busy) {
      // A follow-up while the agent answers: shown now, sent as the next
      // turn so its answer streams here as well.
      var q = queuedMsg(text);
      q.spoken = spoken;
      state.queue.push(q);
      clearInput(text);
      scrollDown();
      return true;
    }
    if (!navigator.onLine) { flash('Offline. Messages can be sent once the phone is connected again.'); return false; }
    if (!state.conv && !state.target) { toggle(picker, true); sheets.loadPicker(); return false; }
    var body = state.conv
      ? { conversationId: state.conv.id, message: text }
      : { node: state.target.node, agent: state.target.agent, message: text };
    if (spoken) body.spoken = true;
    state.stopWanted = false;
    userMsg(text);
    clearInput(text);
    follow(function (signal) { return post('/api/app/chat', body, signal); }, agentMsg(), null);
    return true;
  }
  function sendQueued() {
    if (!state.queue.length || state.busy) return;
    var next = state.queue.splice(0);
    next.forEach(function (x) { x.el.remove(); });
    send(next.map(function (x) { return x.text; }).join(V.NL + V.NL), { spoken: next.every(function (x) { return x.spoken; }) });
  }
  // Streams one turn into the bubble el, from a send or from attaching
  // to a turn that is still running. The phone losing its connection does
  // not stop the agent: the answer is saved and shown when the phone is back.
  function follow(request, el, partial) {
    clearTimeout(pollTimer);
    state.view++;
    var flow = ++state.flow, ac = state.ac = window.AbortController ? new AbortController() : null;
    var raw = (partial && partial.text) || '', plain = !!(partial && partial.plain), tools = ((partial && partial.tools) || []).slice(), ended = false, frame = 0;
    function mine() { return flow === state.flow; }
    function paint() { frame = 0; if (!ended && raw && mine()) { setBody(el, V.preview(raw, plain)); scrollDown(); } }
    function finish(content, note, bad, ui, files) {
      ended = true;
      setBody(el, content || '');
      renderFiles(el, files);
      renderUi(el, ui);
      setNote(el, note, bad);
      scrollDown();
      var id = state.conv && state.conv.id;
      // own: a turn sent from this phone, not one it only came back to.
      emit('final', { own: !partial || !!sentHere[id], ok: !note, content: content || '', conversationId: id });
    }
    setBusy(true);
    scrollDown();
    return request(ac && ac.signal).then(function (r) {
      // Attaching just after the turn ended: reload the saved answer.
      if (r.status === 404 && partial) { ended = true; return; }
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { if (mine()) finish(raw, j.error || ('Failed (HTTP ' + r.status + ')'), true); });
      return V.readStream(r.body, function (ev, d) {
        if (!mine()) return;
        if (ev === 'conversation') { useConversation(d); if (!partial) sentHere[d.id] = 1; if (state.stopWanted) { state.stopWanted = false; stop(); } }
        else if (ev === 'start') plain = d.rich === false;
        else if (ev === 'resume') { raw = d.text || ''; plain = !!d.plain; tools = (d.tools || []).slice(); V.setTools(el, tools); setNote(el, ''); paint(); }
        else if (ev === 'text' && typeof d.text === 'string') { raw += d.text; if (!frame) frame = requestAnimationFrame(paint); }
        else if (ev === 'tool' && d.status === 'start') { tools.push({ id: d.id, name: d.name, arg: d.arg }); V.setTools(el, tools); }
        else if (ev === 'tool' && d.error) { tools.forEach(function (t) { if (t.id === d.id) t.error = true; }); V.setTools(el, tools); }
        else if (ev === 'final') finish(d.content, d.status === 'done' ? '' : (d.error || NOTES[d.status]), d.status === 'error', d.ui, d.files);
      });
    }).catch(function () {}).then(function () {
      // Switched to another conversation: this stream is no longer shown.
      if (!mine()) return;
      setBusy(false);
      if (!ended) {
        // The stream broke before the answer: the agent carries on.
        setNote(el, state.conv ? NOTES.lost : 'Could not reach AgentX. Check the connection and try again.', !state.conv);
        if (state.conv) { var id = state.conv.id; pollTimer = setTimeout(function () { if (state.conv && state.conv.id === id) openConversation(id); }, 5000); }
        return;
      }
      if (state.queue.length) sendQueued();
      else if (state.conv) openConversation(state.conv.id);
    });
  }
  function stop() {
    // Only Stop cancels. Before the conversation exists, wait for its id.
    if (!state.conv) { state.stopWanted = true; return; }
    post('/api/app/chat/stop', { conversationId: state.conv.id }).catch(function () {});
  }
  // Follow-ups held for a conversation that finished while the phone was
  // elsewhere go as its next turn now; its answer shows up in the strip.
  function flushHeld(id) {
    var texts = held[id];
    if (!texts || !texts.length || (state.conv && state.conv.id === id)) return;
    delete held[id];
    post('/api/app/chat', { conversationId: id, message: texts.join(V.NL + V.NL) }).then(function (r) {
      if (r.status === 409) { held[id] = texts.concat(held[id] || []); return; }
      sentHere[id] = 1;
      // The computer keeps the turn going without the phone reading it.
      if (r.body && r.body.cancel) r.body.cancel().catch(function () {});
    }).catch(function () { held[id] = texts.concat(held[id] || []); });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  input.addEventListener('input', function () { input.style.height = ''; input.style.height = Math.min(input.scrollHeight, 240) + 'px'; });
  stopBtn.addEventListener('click', stop);
  pickBtn.addEventListener('click', function () { var open = picker.hidden; toggle(picker, open); if (open) sheets.loadPicker(); });
  histBtn.addEventListener('click', function () { var open = hist.hidden; toggle(hist, open); if (open) sheets.loadHistory(); });
  newBtn.addEventListener('click', function () { startNew(); input.focus(); });

  // A notification opens /app#chat=<id>.
  function fromHash() {
    var m = /^#chat=(c[a-z0-9]{8,32})$/.exec(location.hash);
    if (!m) return false;
    try { history.replaceState(null, '', '#chat'); } catch (e) {}
    openConversation(m[1]);
    return true;
  }
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('online', function () { if (state.conv && !state.busy) openConversation(state.conv.id); });
  window.AXChat = { send: send, busy: function () { return state.busy; }, target: function () { return state.target; },
    pick: function () { toggle(picker, true); sheets.loadPicker(); },
    open: openConversation, current: function () { return state.conv && state.conv.id; },
    held: function (id) { return (held[id] || []).length; }, flushHeld: flushHeld, sentHere: function (id) { return !!sentHere[id]; } };
  state.target = recall('ax-chat-target');
  showTarget(state.target);
  var last = recall('ax-chat-conv');
  if (!fromHash() && last) openConversation(last);
})();
`
