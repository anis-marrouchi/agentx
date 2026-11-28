// --- Phone app: the Chat header (#2101 C1b, desktop look #2101 phone C1) ---
//
// Inlined into /app after the Chat, voice and strip scripts. The Hub chat
// header (wall-chat-head.client.ts) on the phone: back, the agent's face (a
// letter in its colour, with a state dot), its name, "computer · engine",
// a Working pill while a turn runs, and History · New · Changes as quiet
// icon buttons on the right. Under it the tabs Chat · Plan · Proofs: Plan
// and Proofs read the agent's open requests (GET /api/app/requests,
// app-chat-plan.ts draws them). A tap on the name or on back opens the
// agent picker, or the Agents tab when it exists (#2101 C1a).
//
// The orb, hold-to-talk, speaker and keyboard switch below stay as they are
// (approved voice work, #2464); only their borders and sizes follow the
// desktop tokens (APP_CHAT_HEAD_CSS).
//
// The engine comes from GET /api/app/agents (the picker's list, with each
// agent's tier), read once and again when the agent in view is not in it.
// The state follows Chat's own "ax-chat" events. window.AXChatHead.step(n, m)
// adds "step n of m" for a caller that knows the request's plan.
//
// Needs chFace, chEngine, appPlanHtml and appProofsHtml through injectFns.
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_CHAT_HEAD_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-chat'), C = window.AXChat, V = window.AXChatView;
  var cx = panel && panel.querySelector('.cx');
  if (!cx || !C || !V) return;
  var SVG = function (d) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>'; };
  var head = document.createElement('header');
  head.className = 'ch';
  head.innerHTML = '<div class="ch-top"><button type="button" id="ch-back" class="ch-btn" aria-label="All agents">' + SVG('<path d="M15 5l-7 7 7 7"/>') + '</button>' +
    '<span id="ch-face" class="ch-face" aria-hidden="true" hidden></span>' +
    '<button type="button" id="ch-who" class="ch-who" aria-haspopup="dialog"><span id="ch-name" class="ch-name">Choose an agent</span>' +
    '<span id="ch-sub" class="ch-sub">Tap to see your agents</span></button>' +
    '<span id="ch-pill" class="ch-pill" hidden>Working</span><span id="ch-acts" class="ch-acts"></span>' +
    '<button type="button" id="ch-changes" class="ch-btn" aria-label="Changes" title="Changes" disabled>' + SVG('<path d="M12 4v8M8 8h8M8 19h8"/>') + '</button></div>' +
    '<div class="ch-tabs" role="tablist" aria-label="Chat views">' +
    '<button type="button" role="tab" data-ch-tab="chat" aria-selected="true">Chat</button>' +
    '<button type="button" role="tab" data-ch-tab="plan" aria-selected="false">Plan</button>' +
    '<button type="button" role="tab" data-ch-tab="proofs" aria-selected="false">Proofs</button></div>';
  cx.insertBefore(head, cx.firstChild);
  function $(id) { return document.getElementById(id); }
  // History and New move into the header, keeping their own handlers.
  ['cx-history-btn', 'cx-new'].forEach(function (id) { var b = $(id); if (b) { b.className = 'ch-btn'; $('ch-acts').appendChild(b); } });
  var pane = document.createElement('div');
  pane.id = 'ch-pane'; pane.className = 'chp'; pane.setAttribute('role', 'tabpanel'); pane.hidden = true;
  var log = $('cx-log');
  if (log) log.parentNode.insertBefore(pane, log);
  var nameEl = $('ch-name'), subEl = $('ch-sub'), face = $('ch-face'), pill = $('ch-pill'), changes = $('ch-changes');
  var s = { target: null, busy: false, step: null, tiers: null, tiersFor: '', tab: 'chat', reqs: null, reqsFor: '' };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function key(t) { return t ? (t.node || 'local') + '|' + t.agent : ''; }
  function loadTiers(force) {
    if (s.tiers && !force) return;
    s.tiers = s.tiers || {};
    fetch('/api/app/agents', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : { nodes: [] }; }).then(function (d) {
      (d.nodes || []).forEach(function (n) { (n.agents || []).forEach(function (a) { if (a.tier) s.tiers[(n.target || '') + '|' + a.id] = a.tier; }); });
      paint();
    }).catch(function () {});
  }
  function paint() {
    var t = s.target;
    nameEl.textContent = t ? (t.agentName || t.agent) : 'Choose an agent';
    var st = !t ? 'none' : s.busy ? 'work' : 'ready';
    head.dataset.state = st;
    var bits = [];
    if (t && t.nodeName) bits.push(t.nodeName);
    var tier = t && s.tiers ? s.tiers[key(t)] : '';
    if (t && !tier && s.tiers && s.tiersFor !== key(t)) { s.tiersFor = key(t); loadTiers(true); }
    if (tier) bits.push(chEngine(tier));
    if (t && s.step) bits.push('step ' + s.step[0] + ' of ' + s.step[1]);
    subEl.textContent = !t ? 'Tap to see your agents' : bits.join(' · ');
    if (t) {
      var f = chFace(t.agent, t.agentName || t.agent);
      face.textContent = f.letter;
      face.style.background = t.color || f.colour;
      face.dataset.state = st;
    }
    face.hidden = !t;
    pill.hidden = !(t && s.busy);
    changes.disabled = !t;
    changes.setAttribute('aria-label', t ? 'Changes by ' + (t.agentName || t.agent) : 'Changes');
    if (s.tab !== 'chat') fill();
  }
  function fill() {
    var t = s.target;
    if (!t) { pane.innerHTML = '<p class="chp-empty">Choose an agent to see its plan and proofs.</p>'; return; }
    var who = t.agentName || t.agent;
    if (t.node && t.node !== 'local') { pane.innerHTML = '<p class="chp-empty">The plans of ' + esc(who) + ' are on ' + esc(t.nodeName || t.node) + '. Open its Hub to see them.</p>'; return; }
    if (s.reqsFor !== key(t)) { pane.innerHTML = '<p class="chp-empty">Loading…</p>'; load(); return; }
    pane.innerHTML = !s.reqs ? '<p class="chp-empty">The requests could not be read. Try again in a moment.</p>'
      : s.tab === 'plan' ? appPlanHtml(s.reqs, who, esc) : appProofsHtml(s.reqs, who, esc);
  }
  function load() {
    var k = key(s.target), t = s.target;
    fetch('/api/app/requests?agent=' + encodeURIComponent(t.agent), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (key(s.target) !== k) return;
      s.reqs = d && d.items ? d.items : null; s.reqsFor = k; fill();
    }).catch(function () { if (key(s.target) === k) { s.reqs = null; s.reqsFor = k; fill(); } });
  }
  function show(tab) {
    s.tab = tab;
    head.querySelectorAll('[data-ch-tab]').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-ch-tab') === tab ? 'true' : 'false'); });
    cx.classList.toggle('ch-on-pane', tab !== 'chat');
    pane.hidden = tab === 'chat';
    if (tab !== 'chat') { s.reqsFor = ''; fill(); }
  }
  head.querySelector('.ch-tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-ch-tab]');
    if (b) show(b.getAttribute('data-ch-tab'));
  });
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
      if (!was || !now || was.agent !== now.agent || was.node !== now.node) { s.step = null; s.reqsFor = ''; if (s.tab !== 'chat') show('chat'); }
      s.target = now; paint();
    } else if (d.type === 'busy') { s.busy = !!d.on; paint(); }
  });
  s.target = C.target(); s.busy = C.busy();
  loadTiers(false);
  paint();
  window.AXChatHead = { step: function (n, m) { s.step = n && m ? [n, m] : null; paint(); } };
})();
`

// The Hub chat header's values (wall-chat.css.ts .hc__head, .hc__face,
// .hc__pill, .hc__tabs, .hc__plan, .hc__comp) at phone width. Later rules
// here win over app-redesign.css.ts and app-voice.css.ts (APP_CHAT_HEAD_CSS
// comes after them in app.ts).
export const APP_CHAT_HEAD_CSS = `
.ch { flex: none; display: flex; flex-direction: column; margin: 0 -16px; border-bottom: 1px solid var(--ax-border); }
.ch-top { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 8px 12px 6px 8px; }
.ch-btn {
  flex: none; width: 36px; height: 36px; display: grid; place-items: center; padding: 0; cursor: pointer;
  border: 0; border-radius: 10px; background: none; color: var(--ax-text-2);
}
.ch-btn:hover, .ch-btn:active { background: var(--ax-surface-2); color: var(--ax-text); }
.ch-btn:focus-visible, .ch-tabs button:focus-visible { outline: 2px solid var(--ax-ring, var(--ax-accent)); outline-offset: 1px; }
.ch-btn:disabled { opacity: .45; cursor: default; background: none; }
.ch-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.ch-acts { display: flex; gap: 2px; }
.ch-face { flex: none; position: relative; display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--ax-blue-d); color: #fff; font: 700 15px var(--ax-font-head, var(--ax-font, inherit)); }
.ch-face[hidden] { display: none; }
.ch-face::after { content: ""; position: absolute; right: -3px; bottom: -3px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--ax-bg); background: var(--ax-green); }
.ch-face[data-state=work]::after { background: var(--ax-blue-d); }
.ch-who {
  flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 0;
  border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.ch-name { max-width: 100%; font-size: 15px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-sub { max-width: 100%; font-size: 12.5px; color: var(--ax-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-pill { flex: none; font-size: 12px; font-weight: 600; border-radius: var(--ax-radius-pill); padding: 2px 9px; background: var(--ax-blue-t); color: var(--ax-blue-d); white-space: nowrap; }
.ch-pill[hidden] { display: none; }
.ch-tabs { display: flex; gap: 4px; padding: 0 12px; }
.ch-tabs button { font: inherit; font-size: 13.5px; font-weight: 500; color: var(--ax-text-2); background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 10px; min-height: 40px; cursor: pointer; }
.ch-tabs button[aria-selected=true] { color: var(--ax-text); font-weight: 650; border-bottom-color: var(--ax-blue-d); }
/* The old "Talking to" button: History and New are in the header now, and
   the name opens the picker. The row stays for the conversations strip
   (app-chat-strip.client.ts) and shows only while it does. */
.cx-head, .vx .cx-pick { display: none; }
.cx-top { justify-content: flex-start; padding: 8px 0 0; }
.cx-top:has(> .cs[hidden]) { display: none; }
.ch-on-pane #cx-log, .ch-on-pane #cx-empty, .ch-on-pane .cs-list { display: none; }
.chp { flex: 1; overflow: auto; padding: 14px 2px; font-size: 14px; }
.chp[hidden] { display: none; }
.chp-empty { margin: 8px 0; color: var(--ax-text-2); font-size: 14px; }
.chp-req + .chp-req { margin-top: 18px; }
.chp-req h3 { margin: 0 0 8px; font-size: 14px; font-weight: 650; overflow-wrap: anywhere; }
.chp-req ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.chp-req li { display: flex; gap: 10px; align-items: flex-start; }
.chp-req li b, .chp-proofs b { font-weight: 550; }
.chp-req small, .chp-proofs small { display: block; color: var(--ax-text-2); font-size: 12.5px; }
.chp-no { flex: none; display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; border: 1px solid var(--ax-border); font-size: 11.5px; color: var(--ax-text-2); }
.chp-req li.is-done .chp-no { background: var(--ax-green); border-color: var(--ax-green); color: #fff; }
.chp-req li.is-active .chp-no { background: var(--ax-blue-d); border-color: var(--ax-blue-d); color: #fff; }
.chp-proofs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.chp-proofs a, .chp-proofs span { display: block; font-family: var(--ax-mono); font-size: 12.5px; overflow-wrap: anywhere; color: var(--ax-accent); }
.chp-proofs .chp-none { font-family: inherit; color: var(--ax-text-2); }
.vx-side { width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--ax-border); background: var(--ax-surface); color: var(--ax-text-2); }
.vx-side svg { width: 20px; height: 20px; }
.cx-typing-on .vx .cx-composer {
  flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px;
  border: 1px solid var(--ax-border); border-radius: 16px; background: var(--ax-surface); padding: 10px 12px;
  box-shadow: 0 1px 0 var(--ax-border), 0 8px 24px rgba(10,20,40,.06);
}
.cx-typing-on .vx .cx-composer:focus-within { border-color: var(--ax-blue-e, var(--ax-accent)); }
.cx-typing-on .cx-composer textarea { flex: 1 0 100%; min-height: 30px; max-height: 160px; padding: 4px 2px 6px; border: 0; outline: 0; border-radius: 0; background: none; font-size: 16px; line-height: 1.45; }
.cx-composer .fx-btn, .cx-composer .dc-mic { min-height: 32px; height: 32px; width: 32px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 10px; background: none; color: var(--ax-text-2); }
.cx-composer .fx-btn svg { width: 18px; height: 18px; }
.cx-composer #cx-stop { width: auto; padding: 0 10px; color: var(--ax-red-ink); }
.cx-send { min-height: 32px; height: 32px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--ax-blue-d); color: #fff; font-size: 13.5px; font-weight: 600; }
`
