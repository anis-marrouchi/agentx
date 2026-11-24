// --- Phone app: the Chat header (#2101 C1b, mock P2) ---
//
// Inlined into /app after the Chat, voice and strip scripts. One line at
// the top of Chat: back, the agent in view with its state and computer,
// and the Changes button (app-changes.client.ts) on the right. It takes the
// place of the "Talking to" button of the voice dock, which CSS hides; a
// tap on the name or on back still opens the agent picker. When the Agents
// tab exists (#2101 C1a), back goes there instead.
//
// The state follows Chat's own "ax-chat" events: Working while a turn
// runs, Ready otherwise. window.AXChatHead.step(n, m) adds "step n of m"
// for a caller that knows the request's plan (the Agents rows, C1a).
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_CHAT_HEAD_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-chat'), C = window.AXChat, V = window.AXChatView;
  var cx = panel && panel.querySelector('.cx');
  if (!cx || !C || !V) return;
  var BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  var DIFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v8M8 8h8M8 19h8"/></svg>';
  var head = document.createElement('header');
  head.className = 'ch';
  head.innerHTML = '<button type="button" id="ch-back" class="ch-btn" aria-label="All agents">' + BACK + '</button>' +
    '<button type="button" id="ch-who" class="ch-who" aria-haspopup="dialog"><span id="ch-name" class="ch-name">Choose an agent</span>' +
    '<span class="ch-sub"><span id="ch-dot" class="ch-dot" aria-hidden="true"></span><span id="ch-state">Tap to see your agents</span></span></button>' +
    '<button type="button" id="ch-changes" class="ch-btn" aria-label="Changes" title="Changes" disabled>' + DIFF + '</button>';
  cx.insertBefore(head, cx.firstChild);
  function $(id) { return document.getElementById(id); }
  var nameEl = $('ch-name'), stateEl = $('ch-state'), dot = $('ch-dot'), changes = $('ch-changes');
  var s = { target: null, busy: false, step: null };

  function paint() {
    var t = s.target;
    nameEl.textContent = t ? (t.agentName || t.agent) : 'Choose an agent';
    head.dataset.state = !t ? 'none' : s.busy ? 'working' : 'ready';
    var bits = !t ? ['Tap to see your agents'] : [s.busy ? 'Working' : 'Ready'];
    if (t && s.step) bits.push('step ' + s.step[0] + ' of ' + s.step[1]);
    if (t && t.nodeName) bits.push(t.nodeName);
    stateEl.textContent = bits.join(' · ');
    dot.hidden = !t;
    changes.disabled = !t;
    changes.setAttribute('aria-label', t ? 'Changes by ' + (t.agentName || t.agent) : 'Changes');
  }
  function back() {
    var agents = $('tab-agents');
    if (agents) agents.click(); else C.pick();
  }
  $('ch-back').addEventListener('click', back);
  $('ch-who').addEventListener('click', function () { C.pick(); });
  changes.addEventListener('click', function () { if (s.target && window.AXChanges) window.AXChanges.open(s.target); });
  document.addEventListener('ax-chat', function (ev) {
    var d = ev.detail || {};
    if (d.type === 'target') {
      var was = s.target, now = d.target || null;
      if (!was || !now || was.agent !== now.agent || was.node !== now.node) s.step = null;
      s.target = now; paint();
    } else if (d.type === 'busy') { s.busy = !!d.on; paint(); }
  });
  s.target = C.target(); s.busy = C.busy();
  paint();
  window.AXChatHead = { step: function (n, m) { s.step = n && m ? [n, m] : null; paint(); } };
})();
`

export const APP_CHAT_HEAD_CSS = `
.ch { flex: none; display: flex; align-items: center; gap: 12px; padding: 0 0 10px; }
.ch-btn {
  flex: none; width: 44px; height: 44px; display: grid; place-items: center; padding: 0; cursor: pointer;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: 12px; background: var(--ax-surface); color: var(--ax-text);
}
.ch-btn:disabled { opacity: .45; cursor: default; }
.ch-btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.ch-who {
  flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 0;
  border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.ch-name { max-width: 100%; font-size: 20px; font-weight: 700; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-sub { display: flex; align-items: center; gap: 6px; max-width: 100%; font-size: 14px; color: var(--ax-text-2); overflow: hidden; white-space: nowrap; }
.ch-sub > span:last-child { overflow: hidden; text-overflow: ellipsis; }
.ch-dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--ax-green); }
.ch[data-state=working] .ch-dot { background: var(--ax-accent); }
.vx .cx-pick { display: none; }
`
