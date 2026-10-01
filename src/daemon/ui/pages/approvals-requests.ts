// --- The "Open requests" section of the Approvals page (#356) ---
//
// Everything you asked for that is not finished, oldest first, with Done
// and Drop, and the `requests` settings. Requests that need attention are
// also in the inbox list above, as the "Request" kind.

export const REQUESTS_HTML = `
  <section class="apv__req" id="req-section" aria-labelledby="req-h">
    <h2 id="req-h">Open requests <span id="req-n"></span></h2>
    <p class="apv__lead">What you asked agents for that is not finished, oldest first. Nothing leaves this list by getting old: close it as done, or drop it.</p>
    <p id="req-off" class="apv__foot" hidden>Requests are off. Turn them on in the settings below.</p>
    <ol id="req-list" class="apv__list" aria-label="Open requests"></ol>
    <details class="apv__settings" id="req-settings">
      <summary>Settings: open requests</summary>
      <form id="req-form" class="apv__form">
        <label class="apv__check"><input type="checkbox" name="enabled"> Record and follow my requests</label>
        <label>Counts as me on shared channels (channel:id, separated by commas)<input type="text" name="from" placeholder="telegram:123456789, github:your-login" autocomplete="off"></label>
        <label>Channels to record on (separated by commas; empty for all)<input type="text" name="channels" placeholder="voice, app, telegram" autocomplete="off"></label>
        <label>Comes back after this many hours without activity<input type="number" min="1" step="1" name="staleAfterHours" required></label>
        <label>Keep closed requests for (days)<input type="number" min="1" step="1" name="retentionDays" required></label>
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
.apv__req input[type=text].apv__evidence { flex: 1 1 220px; min-width: 0; font: inherit; font-size: 13px; padding: 8px 10px; border-radius: var(--ax-radius-sm); border: 1px solid var(--ax-border); background: var(--ax-bg); color: var(--ax-text); }
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

function item(r){
  var extra = r.state === 'waiting_owner' && r.question ? '<p class="apv__rec"><b>Question:</b> ' + esc(r.question) + '</p>'
    : r.state === 'needs_attention' && r.attentionReason ? '<p class="apv__exp is-soon">' + esc(r.attentionReason) + '</p>' : '';
  return '<li class="apv__item" data-id="' + esc(r.id) + '">' +
    '<div class="apv__meta"><span class="apv__state is-' + esc(r.state) + '">' + esc(STATE[r.state] || r.state) + '</span>' +
    '<span>' + esc(when(r.createdAt)) + '</span><span>' + esc(r.channel) + '</span><span>' + esc(r.agentId) + '</span><code>' + esc(r.id) + '</code></div>' +
    '<p class="apv__ask">' + esc(r.text) + '</p>' + extra +
    '<div class="apv__acts">' +
    '<input type="text" class="apv__evidence" placeholder="Link to the evidence (PR, issue, message, deploy)" aria-label="Link to the evidence for ' + esc(r.id) + '">' +
    '<button type="button" class="ax-btn ax-btn--primary" data-req="done">Done</button>' +
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
  $('req-off').hidden = !!s.enabled;
}

async function load(){
  try {
    var r = await fetch('/api/admin/approvals/requests', { headers: headers(false) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    var items = d.items || [];
    $('req-n').textContent = items.length;
    $('req-list').innerHTML = items.length ? items.map(item).join('')
      : '<li class="apv__empty"><h2>No open requests</h2>Everything you asked for is closed.</li>';
    if (d.settings && !$('req-form').contains(document.activeElement)) fill(d.settings);
  } catch (e) { say('Couldn’t load open requests: ' + e.message, 'err'); }
}

async function close(li, action){
  var body = { id: li.getAttribute('data-id'), action: action };
  if (action === 'done') {
    body.evidence = li.querySelector('.apv__evidence').value.trim();
    if (!body.evidence) { say('Add a link to the evidence before closing a request as done.', 'err'); li.querySelector('.apv__evidence').focus(); return; }
  }
  try {
    var r = await fetch('/api/admin/approvals/requests/close', { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    say(d.message, 'ok');
    load();
  } catch (e) { say(e.message, 'err'); }
}

$('req-section').addEventListener('click', function(ev){
  var b = ev.target.closest && ev.target.closest('button[data-req]');
  if (b) close(b.closest('.apv__item'), b.getAttribute('data-req'));
});

$('req-form').addEventListener('submit', async function(ev){
  ev.preventDefault();
  var f = ev.target;
  var body = {
    enabled: f.enabled.checked,
    from: f.from.value,
    channels: f.channels.value,
    staleAfterHours: Number(f.staleAfterHours.value),
    retentionDays: Number(f.retentionDays.value)
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
setInterval(function(){ if (document.visibilityState === 'visible' && !$('req-section').contains(document.activeElement)) load(); }, 60000);
})();
`
