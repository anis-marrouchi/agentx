// --- Phone app: an agent calls (#1605) ---
//
// A voice call an agent places rings the phone with a call push that opens
// /app#call=<id>, and the app polls /api/app/calls while it is on screen.
// A ringing call shows a bar under the header with the caller, its reason,
// and Answer / Decline, and rings in the page (our own two-tone ring, made
// with Web Audio) while the app is open. Answer takes the call on the
// daemon, so the AgentX Voice widget stops ringing, then opens Chat with
// the caller: a new conversation, answers read aloud, and the call's
// opener as its first turn so the agent speaks first. The owner talks with
// the orb as usual; Hang up ends the call, and the agent summarises that
// conversation.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const CALLS_BODY = `
<div id="call-bar" class="call-bar" role="alert" hidden>
  <div class="call-bar-text">
    <span id="call-what" class="call-bar-what">Incoming call</span>
    <strong id="call-who">An agent</strong>
    <span id="call-why" class="call-bar-why"></span>
  </div>
  <div class="call-bar-btns">
    <button type="button" id="call-answer" class="call-bar-yes">Answer</button>
    <button type="button" id="call-decline" class="call-bar-no">Decline</button>
    <button type="button" id="call-hangup" class="call-bar-no" hidden>Hang up</button>
    <button type="button" id="call-close" class="call-bar-no" hidden>Close</button>
  </div>
</div>`

export const CALLS_CSS = `
.call-bar[hidden] { display: none; }
.call-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  margin: 0; padding: 14px calc(16px + env(safe-area-inset-right)) 14px calc(16px + env(safe-area-inset-left));
  background: var(--ax-ok); color: #fff; line-height: 1.4;
}
.call-bar.call-urgent { background: var(--ax-err); }
.call-bar.call-over { background: var(--ax-surface-2); color: var(--ax-text); }
.call-bar-text { flex: 1 1 200px; }
.call-bar-what { display: block; font-size: .85em; opacity: .9; }
.call-bar-why { display: block; opacity: .9; }
.call-bar-btns { display: flex; gap: 8px; }
.call-bar-yes, .call-bar-no {
  min-height: 48px; padding: 0 18px; border-radius: var(--ax-radius-pill); font: inherit; font-weight: 700; cursor: pointer;
  border: 2px solid currentColor; background: transparent; color: inherit;
}
.call-bar-yes { background: #fff; color: var(--ax-ok); border-color: #fff; }
.call-bar-yes:focus-visible, .call-bar-no:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
@media (prefers-reduced-motion: no-preference) {
  .call-bar.call-ringing .call-bar-yes { animation: call-pulse 1.2s ease-in-out infinite; }
}
@keyframes call-pulse { 50% { transform: scale(1.06); } }
`

export const CALLS_SCRIPT = `
(function () {
  var bar = document.getElementById('call-bar');
  if (!bar) return;
  function $(id) { return document.getElementById(id); }
  var what = $('call-what'), who = $('call-who'), why = $('call-why');
  var yes = $('call-answer'), no = $('call-decline'), hang = $('call-hangup'), close = $('call-close');
  var ringing = null; // the call on the bar: { id, agentId, reason, urgency }
  var live = null;    // the call answered here: { id, agentId }
  var busy = false, local = null;

  function api(method, path, body) {
    return fetch(path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  // This computer's node and agents, for the caller's name and the chat target.
  function loadLocal() {
    if (local) return Promise.resolve(local);
    return api('GET', '/api/app/agents').then(function (r) {
      var n = (r.nodes || []).filter(function (x) { return x.target === 'local'; })[0];
      local = { nodeName: n ? n.name : 'this computer', agents: {} };
      (n ? n.agents : []).forEach(function (a) { local.agents[a.id] = a; });
      return local;
    }).catch(function () { return { nodeName: 'this computer', agents: {} }; });
  }
  function nameOf(id) { return local && local.agents[id] ? local.agents[id].name : id; }

  // --- The ring: two short tones, every three seconds, while it rings ---
  var ac = null, ringTimer = 0;
  function ringOnce() {
    try {
      var A = window.AudioContext || window.webkitAudioContext;
      if (A) {
        ac = ac || new A();
        if (ac.state === 'suspended') ac.resume();
        var t = ac.currentTime;
        [0, 0.5].forEach(function (o) {
          var g = ac.createGain();
          g.gain.setValueAtTime(0, t + o);
          g.gain.linearRampToValueAtTime(0.16, t + o + 0.02);
          g.gain.setValueAtTime(0.16, t + o + 0.36);
          g.gain.linearRampToValueAtTime(0, t + o + 0.4);
          g.connect(ac.destination);
          [440, 480].forEach(function (f) { var os = ac.createOscillator(); os.frequency.value = f; os.connect(g); os.start(t + o); os.stop(t + o + 0.42); });
        });
      }
    } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate([400, 100, 400]); } catch (e) {}
  }
  function startRing() { if (ringTimer) return; ringOnce(); ringTimer = setInterval(ringOnce, 3000); }
  function stopRing() { clearInterval(ringTimer); ringTimer = 0; try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) {} }

  function buttons(mode) {
    yes.hidden = no.hidden = mode !== 'ringing';
    hang.hidden = mode !== 'live';
    close.hidden = mode !== 'over';
  }
  function hide() { stopRing(); ringing = null; bar.hidden = true; bar.className = 'call-bar'; }
  function showRinging(call) {
    ringing = call;
    bar.className = 'call-bar call-ringing' + (call.urgency === 'urgent' ? ' call-urgent' : '');
    what.textContent = call.urgency === 'urgent' ? 'Urgent call' : 'Incoming call';
    who.textContent = nameOf(call.agentId);
    why.textContent = call.reason || '';
    buttons('ringing');
    bar.hidden = false;
    startRing();
    loadLocal().then(function () { if (ringing && ringing.id === call.id) who.textContent = nameOf(call.agentId); });
  }
  function showLive(call) {
    bar.className = 'call-bar';
    what.textContent = 'On a call';
    who.textContent = nameOf(call.agentId);
    why.textContent = 'Hold the orb to talk. Answers are read aloud.';
    buttons('live');
    bar.hidden = false;
  }
  function showOver(call, text) {
    stopRing();
    ringing = null;
    bar.className = 'call-bar call-over';
    what.textContent = 'Call';
    who.textContent = nameOf(call.agentId);
    why.textContent = text;
    buttons('over');
    bar.hidden = false;
  }
  var OVER = { answered: 'Answered somewhere else.', ended: 'This call has ended.', declined: 'You declined this call.', missed: 'Missed call.', later: 'It calls back later.' };

  function poll() {
    if (busy || live || document.visibilityState !== 'visible') return;
    api('GET', '/api/app/calls').then(function (r) {
      if (busy || live) return;
      var calls = r.calls || [];
      if (!calls.length) { if (ringing) hide(); return; }
      if (!ringing || calls.every(function (c) { return c.id !== ringing.id; })) showRinging(calls[0]);
      else startRing();
    }).catch(function () {});
  }

  // A call push opens /app#call=<id>.
  function fromHash() {
    var m = /^#call=([A-Za-z0-9_-]{4,64})$/.exec(location.hash);
    if (!m) return;
    try { history.replaceState(null, '', '#chat'); } catch (e) {}
    if (live) return;
    loadLocal().then(function () { return api('GET', '/api/app/calls/' + m[1]); }).then(function (r) {
      if (r.call.status === 'ringing') showRinging(r.call);
      else showOver(r.call, OVER[r.call.status] || 'This call is over.');
    }).catch(function (e) {
      showOver({ agentId: 'An agent' }, e.message === 'no such call' || /No such call/.test(e.message) ? 'This call is not on this computer. Answer it in AgentX Voice.' : (e.message || 'Could not open the call.'));
    });
  }

  yes.addEventListener('click', function () {
    if (!ringing || busy) return;
    var call = ringing;
    busy = true;
    stopRing();
    // The tap is what lets the page play the agent's voice.
    try { if (window.AXVoiceIO) window.AXVoiceIO.unlock(); } catch (e) {}
    api('POST', '/api/app/calls/' + encodeURIComponent(call.id) + '/answer').then(function (r) {
      return loadLocal().then(function (l) {
        ringing = null;
        live = { id: call.id, agentId: call.agentId };
        var a = l.agents[call.agentId] || {};
        var tab = $('tab-chat');
        if (tab) tab.click();
        if (window.AXVoice && window.AXVoice.speaker) window.AXVoice.speaker(true);
        if (window.AXChat && window.AXChat.call) window.AXChat.call({ node: 'local', nodeName: l.nodeName, agent: call.agentId, agentName: a.name || call.agentId, color: a.color }, r.opener);
        showLive(call);
      });
    }).catch(function (e) {
      showOver(call, e.message || 'Could not answer.');
    }).then(function () { busy = false; });
  });

  no.addEventListener('click', function () {
    if (!ringing || busy) return;
    var call = ringing;
    busy = true;
    hide();
    api('POST', '/api/app/calls/' + encodeURIComponent(call.id) + '/decline').catch(function () {})
      .then(function () { busy = false; poll(); });
  });

  hang.addEventListener('click', function () {
    if (!live || busy) return;
    var call = live;
    busy = true;
    var conv = window.AXChat && window.AXChat.current ? window.AXChat.current() : null;
    api('POST', '/api/app/calls/' + encodeURIComponent(call.id) + '/hangup', conv ? { conversationId: conv } : {}).catch(function () {})
      .then(function () { busy = false; live = null; hide(); poll(); });
  });

  close.addEventListener('click', hide);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !bar.hidden && !close.hidden) hide(); });

  window.addEventListener('hashchange', fromHash);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') poll(); else stopRing(); });
  fromHash();
  poll();
  setInterval(poll, 4000);
})();
`
