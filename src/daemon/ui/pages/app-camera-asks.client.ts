// --- Phone app: an agent asks to see (#325 phase 3) ---
//
// Polls /api/app/camera/asks while the app is on screen. A waiting ask
// shows a bar under the header with the agent, its reason, and Show /
// Decline. Show answers the ask on the daemon and tells the camera sheet
// (an `ax-camera` event) to start with that agent and the ask's id, so the
// camera opens only on the owner's tap. Decline turns it down. An ask
// nobody answers counts as missed after calls.ringSeconds, on the daemon.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const CAMERA_ASKS_BODY = `
<div id="cam-ask-bar" class="cam-askbar" role="alert" hidden>
  <div class="cam-askbar-text">
    <strong id="cam-ask-who">An agent</strong> wants to see through your camera
    <span id="cam-ask-why" class="cam-askbar-why"></span>
  </div>
  <div class="cam-askbar-btns">
    <button type="button" id="cam-ask-show" class="cam-askbar-show">Show</button>
    <button type="button" id="cam-ask-no" class="cam-askbar-no">Decline</button>
  </div>
</div>`

export const CAMERA_ASKS_CSS = `
.cam-askbar[hidden] { display: none; }
.cam-askbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  margin: 0; padding: 12px calc(16px + env(safe-area-inset-right)) 12px calc(16px + env(safe-area-inset-left));
  background: var(--ax-accent); color: #fff; line-height: 1.4;
}
.cam-askbar-text { flex: 1 1 200px; }
.cam-askbar-why { display: block; opacity: .9; }
.cam-askbar-btns { display: flex; gap: 8px; }
.cam-askbar-show, .cam-askbar-no {
  min-height: 44px; padding: 0 16px; border-radius: var(--ax-radius-pill); font: inherit; font-weight: 700; cursor: pointer;
  border: 2px solid #fff; background: #fff; color: var(--ax-accent);
}
.cam-askbar-no { background: transparent; color: #fff; }
`

export const CAMERA_ASKS_SCRIPT = `
(function () {
  var bar = document.getElementById('cam-ask-bar');
  if (!bar) return;
  var who = document.getElementById('cam-ask-who');
  var why = document.getElementById('cam-ask-why');
  var showBtn = document.getElementById('cam-ask-show');
  var noBtn = document.getElementById('cam-ask-no');
  var current = null; // the ask on the bar: { id, agentId, reason }
  var names = {};     // agent id -> name, from the camera config once loaded
  var busy = false;

  function api(method, path, body) {
    return fetch(path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

  function paint(ask) {
    current = ask;
    if (!ask) { bar.hidden = true; return; }
    who.textContent = names[ask.agentId] || ask.agentId;
    why.textContent = ask.reason || '';
    bar.hidden = false;
  }

  function poll() {
    if (busy || document.visibilityState !== 'visible') return;
    api('GET', '/api/app/camera/asks').then(function (r) {
      var asks = r.asks || [];
      if (!asks.length) { paint(null); return; }
      if (!current || asks.every(function (a) { return a.id !== current.id; })) paint(asks[0]);
    }).catch(function () {});
  }

  function names_() {
    api('GET', '/api/app/camera/config').then(function (c) {
      (c.agents || []).forEach(function (a) { names[a.id] = a.name; });
      if (current) paint(current);
    }).catch(function () {});
  }

  showBtn.addEventListener('click', function () {
    if (!current || busy) return;
    var ask = current;
    busy = true;
    api('POST', '/api/app/camera/asks/' + encodeURIComponent(ask.id) + '/answer').then(function () {
      paint(null);
      // The camera sheet opens the camera now, with this agent and this id.
      document.dispatchEvent(new CustomEvent('ax-camera', { detail: { type: 'show', agentId: ask.agentId, callId: ask.id, reason: ask.reason } }));
    }).catch(function (e) {
      why.textContent = e.message || 'Could not accept.';
    }).then(function () { busy = false; });
  });

  noBtn.addEventListener('click', function () {
    if (!current || busy) return;
    var ask = current;
    busy = true;
    api('POST', '/api/app/camera/asks/' + encodeURIComponent(ask.id) + '/decline').catch(function () {})
      .then(function () { busy = false; paint(null); poll(); });
  });

  names_();
  poll();
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') poll(); });
})();
`
