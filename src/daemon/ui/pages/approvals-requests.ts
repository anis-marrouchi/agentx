// --- The "Open requests" section of the Approvals page (#356) ---
//
// Everything you asked for that is not finished, oldest first, one card
// each (#459): a short summary, where it stands and who has it, your words
// and the agent's last answer to open, then the decision: reply, hand it to
// an agent, done, or drop. Below, the `requests` settings. Requests that
// need attention are also in the inbox list above, as the "Request" kind.
// The card's rendered text comes from the server (requests/card-view.ts),
// which escapes before it marks up. Open loops (#1039): a card shows who
// it is owed to, when it is due and what check closes it; the stalled
// filter shows only the stalled ones, by what they wait on.

export const REQUESTS_HTML = `
  <section class="apv__req" id="req-section" aria-labelledby="req-h">
    <h2 id="req-h">Open requests <span id="req-n"></span></h2>
    <p class="apv__lead">What you asked agents for that is not finished, oldest first. Reply, hand it to an agent, close it as done, or drop it. Nothing leaves this list by getting old.</p>
    <p id="req-off" class="apv__foot" hidden>Requests are off. Turn them on in the settings below.</p>
    <div class="apv__stallbar" id="req-stall" role="group" aria-label="Show">
      <button type="button" class="ax-chip apv__f is-on" data-stall="" aria-pressed="true">All</button>
      <button type="button" class="ax-chip apv__f" data-stall="owner" aria-pressed="false">Stalled on you <span></span></button>
      <button type="button" class="ax-chip apv__f" data-stall="agent" aria-pressed="false">Stalled on an agent <span></span></button>
      <button type="button" class="ax-chip apv__f" data-stall="person" aria-pressed="false">Stalled on an outside person <span></span></button>
    </div>
    <ol id="req-list" class="apv__list" aria-label="Open requests"></ol>
    <details class="apv__settings" id="req-settings">
      <summary>Settings: open requests</summary>
      <form id="req-form" class="apv__form">
        <label class="apv__check"><input type="checkbox" name="enabled"> Record and follow my requests</label>
        <label>Counts as me on shared channels (channel:id, separated by commas)<input type="text" name="from" placeholder="telegram:123456789, github:your-login" autocomplete="off"></label>
        <label>Channels to record on (separated by commas; empty for all)<input type="text" name="channels" placeholder="voice, app, telegram" autocomplete="off"></label>
        <label>Comes back after this many hours without activity<input type="number" min="1" step="1" name="staleAfterHours" required></label>
        <label>Keep closed requests for (days)<input type="number" min="1" step="1" name="retentionDays" required></label>
        <label class="apv__check"><input type="checkbox" name="plansEnabled"> Follow requests of two or more steps as plans</label>
        <label>Nudge a plan step's agent after this many minutes without progress<input type="number" min="1" step="1" name="stallMinutes" required></label>
        <label>Nudges per step before you are told it is blocked<input type="number" min="0" step="1" name="maxNudges" required></label>
        <label>Step kinds you approve once, when the plan is made (separated by commas)<input type="text" name="approveKinds" placeholder="message" autocomplete="off"></label>
        <label>Agents that may not open a plan (separated by commas)<input type="text" name="plansOffFor" autocomplete="off"></label>
        <label>Kinds of work an agent must plan before it starts (separated by commas; empty for none)<input type="text" name="planForWork" placeholder="code" autocomplete="off"></label>
        <label>Work estimated over this many minutes needs a plan (0: never)<input type="number" min="0" step="1" name="planOverMinutes" required></label>
        <label>Checks agents may use to close a loop (separated by commas)<input type="text" name="checkKinds" placeholder="url, issue, git-ancestor, reply" autocomplete="off"></label>
        <label>Run each loop's check every this many minutes<input type="number" min="1" step="1" name="checkEveryMinutes" required></label>
        <div><button type="submit" class="ax-btn ax-btn--primary">Save settings</button></div>
      </form>
    </details>
  </section>`

export const REQUESTS_CSS = `
.apv__req { margin-top: 32px; border-top: 1px solid var(--ax-border); padding-top: 16px; }
.apv__req h2 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
.apv__req h2 span { color: var(--ax-muted); font-family: var(--ax-mono); font-size: 12px; font-weight: 400; }
.apv__req .apv__lead { margin-bottom: 12px; }
.apv__state { text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--ax-mono); }
.apv__state.is-needs_attention { color: var(--ax-err); }
.apv__state.is-waiting_owner { color: var(--ax-amber-ink); }
.apv__with { color: var(--ax-text-2); }
.apv__with b { color: var(--ax-text); font-weight: 600; }
.apv__md { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.apv__md p { margin: 6px 0 0; }
.apv__md ul, .apv__md ol { margin: 6px 0 0; padding-left: 20px; }
.apv__md pre { margin: 6px 0 0; padding: 8px 10px; overflow-x: auto; background: var(--ax-bg); border-radius: var(--ax-radius-sm); }
.apv__md h1, .apv__md h2, .apv__md h3, .apv__md h4 { font-size: 13px; margin: 8px 0 0; }
.apv__reply { display: flex; gap: 8px; align-items: flex-end; margin: 0 0 8px; }
.apv__reply textarea, .apv__req select, .apv__req input[type=text].apv__evidence { font: inherit; font-size: 13px; padding: 8px 10px; border-radius: var(--ax-radius-sm); border: 1px solid var(--ax-border); background: var(--ax-bg); color: var(--ax-text); }
.apv__reply textarea { flex: 1 1 auto; min-width: 0; min-height: 40px; resize: vertical; }
.apv__req input[type=text].apv__evidence { flex: 1 1 180px; min-width: 0; }
.apv__req select { min-height: 40px; max-width: 100%; }
.apv__mic.is-on { border-color: var(--ax-err); color: var(--ax-err); }
.apv__acts + .apv__acts { margin-top: 8px; }
.apv__plan { margin: 8px 0; padding-left: 22px; font-size: 13px; line-height: 1.5; }
.apv__plan li { margin: 2px 0; overflow-wrap: anywhere; }
.apv__plan .apv__state { font-size: 11px; margin-left: 4px; }
.apv__plan .is-done { color: var(--ax-ok, inherit); }
.apv__plan .is-blocked { color: var(--ax-err); }
.apv__plan small { display: block; color: var(--ax-muted); }
.apv__stallbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
.apv__loop { margin: 6px 0 0; font-size: 13px; color: var(--ax-text-2); overflow-wrap: anywhere; }
.apv__loop b { color: var(--ax-text); font-weight: 600; }
.apv__loop .is-failed, .apv__loop .is-unverified { color: var(--ax-amber-ink); }
.apv__loop .is-verified { color: var(--ax-ok, inherit); }
.apv__stalled { color: var(--ax-err); }
`

export const REQUESTS_SCRIPT = `
(function(){
var STATE = { in_progress: 'In progress', waiting_owner: 'Waiting on you', waiting_other: 'Waiting on another agent', needs_attention: 'Needs attention' };
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function headers(json){
  var h = { 'X-Requested-With': 'agentx-board' };
  if (json) h['Content-Type'] = 'application/json';
  if (window.AX_LOCAL_TOKEN) h['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
  return h;
}
function say(text, kind){ var m = $('apv-msg'); m.textContent = text || ''; m.className = 'apv__msg' + (kind ? ' is-' + kind : ''); }
function when(ms){ return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }

var AGENTS = [], ITEMS = [], SHOW = '';
var WAITS = { owner: 'you', agent: 'an agent', person: 'an outside person' };
var VERIFY = { verified: 'check met', unverified: 'check could not say', failed: 'check not met' };
var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
function agentName(id){ for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i].name; return id; }
var STEP = { pending: 'Not started', active: 'In progress', done: 'Done', blocked: 'Blocked', skipped: 'Skipped' };
// Each step of a tracked plan (#788), escaped here.
function plan(p){
  if (!p || !p.steps || !p.steps.length) return '';
  return '<ol class="apv__plan" aria-label="Plan">' + p.steps.map(function(s){
    var extra = s.state === 'done' && s.evidence ? s.evidence : (s.state === 'blocked' || s.state === 'skipped') && s.note ? s.note
      : s.approval && s.approval !== 'approved' ? 'Your approval: ' + s.approval : s.nudges ? s.nudges + ' nudge' + (s.nudges === 1 ? '' : 's') : '';
    return '<li>' + esc(s.name) + ' <span class="apv__with">(' + esc(agentName(s.agentId)) + ')</span>' +
      '<span class="apv__state is-' + esc(s.state) + '">' + esc(STEP[s.state] || s.state) + '</span>' +
      (extra ? '<small>' + esc(extra) + '</small>' : '') + '</li>';
  }).join('') + '</ol>';
}
// Who it is owed to, when it is due, what closes it, and why it is stalled (#1039).
function loop(r){
  var l = r.loop, bits = [];
  if (l && l.promise && l.owedTo) bits.push('Promised to <b>' + esc(l.owedTo === 'owner' ? 'you' : agentName(l.owedTo)) + '</b>');
  if (l && l.dueAt) bits.push('Due ' + esc(when(l.dueAt)));
  // What the agent declared when it accepted (#1048).
  if (r.work || r.estimateMinutes != null) bits.push('Work: ' + esc([r.work || '', r.estimateMinutes != null ? 'about ' + Math.round(r.estimateMinutes) + ' min' : ''].filter(Boolean).join(', ')));
  if (l && l.check) bits.push('Closes when ' + esc(l.check) + (l.verifyState ? ' <span class="is-' + esc(l.verifyState) + '">(' + esc(VERIFY[l.verifyState] || l.verifyState) + (l.verifyDetail ? ': ' + esc(l.verifyDetail) : '') + ')</span>' : ''));
  var stalled = r.stall ? '<p class="apv__loop apv__stalled">Stalled, waiting on ' + esc(r.stall.group === 'agent' ? agentName(r.stall.who) : r.stall.group === 'person' ? r.stall.who : 'you') + ': ' + esc(r.stall.why) + '</p>' : '';
  return (bits.length ? '<p class="apv__loop">' + bits.join(' · ') + '</p>' : '') + stalled;
}
function more(label, html){ return html ? '<details class="apv__detail"><summary>' + esc(label) + '</summary><div class="apv__md">' + html + '</div></details>' : ''; }

// summary, why and the ids are escaped here; textHtml, ownerNoteHtml and
// lastAnswer.html arrive rendered and escaped by requests/card-view.ts.
function item(r){
  var why = !r.why ? '' : r.state === 'waiting_owner' ? '<p class="apv__rec"><b>Question:</b> ' + esc(r.why) + '</p>'
    : '<p class="apv__exp is-soon">' + esc(r.why) + '</p>';
  var opts = AGENTS.map(function(a){ return '<option value="' + esc(a.id) + '"' + (a.id === r.agentId ? ' selected' : '') + '>' + esc(a.name) + (a.id === r.agentId ? ' (has it)' : '') + '</option>'; }).join('');
  return '<li class="apv__item" data-id="' + esc(r.id) + '">' +
    '<div class="apv__meta"><span class="apv__state is-' + esc(r.state) + '">' + esc(STATE[r.state] || r.state) + '</span>' +
    '<span class="apv__with">With <b>' + esc(agentName(r.agentId)) + '</b></span>' +
    '<span>' + esc(when(r.createdAt)) + '</span><span>' + esc(r.channel) + '</span><code>' + esc(r.id) + '</code></div>' +
    '<p class="apv__title" dir="auto">' + esc(r.summary) + '</p>' + why + loop(r) + plan(r.plan) +
    more(r.loop && r.loop.promise ? 'What ' + agentName(r.agentId) + ' promised' : r.channel === 'voice' ? 'What you said' : 'What you asked', r.textHtml) +
    more('Your last reply', r.ownerNoteHtml) +
    (r.lastAnswer ? more('Last answer from ' + agentName(r.lastAnswer.agentId) + ' (' + when(r.lastAnswer.at) + ')', r.lastAnswer.html) : '') +
    '<div class="apv__reply">' +
    '<textarea rows="1" class="apv__text" dir="auto" placeholder="Reply to ' + esc(agentName(r.agentId)) + ', or add a note for the hand-off" aria-label="Reply on ' + esc(r.id) + '"></textarea>' +
    (SpeechRec ? '<button type="button" class="ax-btn apv__mic" data-req="mic" title="Speak the reply" aria-label="Speak the reply">Speak</button>' : '') +
    '<button type="button" class="ax-btn ax-btn--primary" data-req="reply">Send reply</button>' +
    '</div>' +
    '<div class="apv__acts">' +
    (opts ? '<select class="apv__agent" aria-label="Agent to hand ' + esc(r.id) + ' to">' + opts + '</select><button type="button" class="ax-btn" data-req="handoff">Hand to agent</button>' : '') +
    '</div>' +
    '<div class="apv__acts">' +
    '<input type="text" class="apv__evidence" placeholder="' + (r.loop && r.loop.check ? 'Why you close it by hand (skips its check)' : 'Link to the evidence (optional)') + '" aria-label="' + (r.loop && r.loop.check ? 'Reason for closing ' : 'Link to the evidence for ') + esc(r.id) + '">' +
    '<button type="button" class="ax-btn" data-req="done">Done</button>' +
    '<button type="button" class="ax-btn" data-req="drop">Drop</button>' +
    '</div></li>';
}

function fill(s){
  var f = $('req-form');
  f.enabled.checked = !!s.enabled;
  f.from.value = (s.from || []).join(', ');
  f.channels.value = (s.channels || []).join(', ');
  f.staleAfterHours.value = s.staleAfterHours;
  f.retentionDays.value = s.retentionDays;
  var p = s.plans || {};
  f.plansEnabled.checked = p.enabled !== false;
  f.stallMinutes.value = p.stallMinutes || 30;
  f.maxNudges.value = p.maxNudges == null ? 3 : p.maxNudges;
  f.approveKinds.value = (p.approveKinds || []).join(', ');
  f.plansOffFor.value = (p.disabledAgents || []).join(', ');
  f.planForWork.value = (p.requireForWork || []).join(', ');
  f.planOverMinutes.value = p.requireOverMinutes == null ? 30 : p.requireOverMinutes;
  var c = s.checkers || {};
  f.checkKinds.value = (c.enabled || []).join(', ');
  f.checkEveryMinutes.value = c.checkEveryMinutes || 10;
  $('req-off').hidden = !!s.enabled;
}

async function load(){
  try {
    var r = await fetch('/api/admin/approvals/requests', { headers: headers(false) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    ITEMS = d.items || [];
    AGENTS = d.agents || [];
    $('req-n').textContent = ITEMS.length;
    var st = d.stalled || {};
    [].forEach.call($('req-stall').querySelectorAll('button[data-stall]'), function(b){
      var g = b.getAttribute('data-stall');
      if (g) b.querySelector('span').textContent = '(' + (st[g] || 0) + ')';
    });
    draw();
    if (d.settings && !$('req-form').contains(document.activeElement)) fill(d.settings);
  } catch (e) { say('Couldn’t load open requests: ' + e.message, 'err'); }
}

function draw(){
  var shown = SHOW ? ITEMS.filter(function(r){ return r.stall && r.stall.group === SHOW; }) : ITEMS;
  $('req-list').innerHTML = shown.length ? shown.map(item).join('')
    : SHOW ? '<li class="apv__empty"><h2>Nothing stalled on ' + esc(WAITS[SHOW]) + '</h2>Every open loop of this kind is moving or not due yet.</li>'
    : '<li class="apv__empty"><h2>No open requests</h2>Everything you asked for is closed.</li>';
}

$('req-stall').addEventListener('click', function(ev){
  var b = ev.target.closest && ev.target.closest('button[data-stall]');
  if (!b) return;
  SHOW = b.getAttribute('data-stall');
  [].forEach.call($('req-stall').querySelectorAll('button[data-stall]'), function(x){
    x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    x.classList.toggle('is-on', x === b);
  });
  draw();
});

async function post(path, body){
  try {
    var r = await fetch('/api/admin/approvals/requests/' + path, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    say(d.message, 'ok');
    load();
  } catch (e) { say(e.message, 'err'); }
}

// Dictation fills the reply box; nothing is sent until Send reply.
var hearing = null;
function speak(li, btn){
  if (hearing) { hearing.stop(); return; }
  var box = li.querySelector('.apv__text'), start = box.value.trim() ? box.value.trim() + ' ' : '';
  var rec = hearing = new SpeechRec();
  rec.interimResults = true;
  rec.onresult = function(ev){ var t = ''; for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; box.value = start + t; };
  rec.onerror = function(ev){ say('Could not hear you: ' + ev.error, 'err'); };
  rec.onend = function(){ hearing = null; btn.classList.remove('is-on'); btn.textContent = 'Speak'; };
  btn.classList.add('is-on'); btn.textContent = 'Stop';
  rec.start();
}

function act(li, action, btn){
  var id = li.getAttribute('data-id'), text = li.querySelector('.apv__text').value.trim();
  if (action === 'mic') return speak(li, btn);
  if (action === 'reply') {
    if (!text) { say('Write or speak the reply first.', 'err'); li.querySelector('.apv__text').focus(); return; }
    return post('reply', { id: id, text: text });
  }
  if (action === 'handoff') return post('handoff', { id: id, agentId: li.querySelector('.apv__agent').value, note: text });
  if (action === 'done') return post('close', { id: id, action: 'done', evidence: li.querySelector('.apv__evidence').value.trim() });
  post('close', { id: id, action: 'drop', reason: text });
}

$('req-section').addEventListener('click', function(ev){
  var b = ev.target.closest && ev.target.closest('button[data-req]');
  if (b) act(b.closest('.apv__item'), b.getAttribute('data-req'), b);
});

$('req-form').addEventListener('submit', async function(ev){
  ev.preventDefault();
  var f = ev.target;
  var body = {
    enabled: f.enabled.checked,
    from: f.from.value,
    channels: f.channels.value,
    staleAfterHours: Number(f.staleAfterHours.value),
    retentionDays: Number(f.retentionDays.value),
    plansEnabled: f.plansEnabled.checked,
    stallMinutes: Number(f.stallMinutes.value),
    maxNudges: Number(f.maxNudges.value),
    approveKinds: f.approveKinds.value,
    plansOffFor: f.plansOffFor.value,
    planForWork: f.planForWork.value,
    planOverMinutes: Number(f.planOverMinutes.value),
    checkKinds: f.checkKinds.value,
    checkEveryMinutes: Number(f.checkEveryMinutes.value)
  };
  try {
    var r = await fetch('/api/admin/approvals/requests/settings', { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    fill(d.settings);
    say('Request settings saved.', 'ok');
  } catch (e) { say('Request settings not saved: ' + e.message, 'err'); }
});

load();
// A yes or no in the inbox above changes a request: do not wait for the timer.
document.addEventListener('apv:decided', load);
// A refresh redraws the cards: not while one is being read, written or spoken into.
function busy(){
  if (hearing || $('req-section').contains(document.activeElement) || $('req-list').querySelector('details[open]')) return true;
  return [].some.call($('req-list').querySelectorAll('textarea, input'), function(el){ return el.value !== ''; });
}
setInterval(function(){ if (document.visibilityState === 'visible' && !busy()) load(); }, 60000);
})();
`
