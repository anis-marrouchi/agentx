// --- Approvals page (/approvals) ---
//
// One inbox for every decision waiting for the operator: decision cards
// agents raise, schedule requests, held memory facts, wiki proposals. Each
// item answers "what is it, what is asked, what does the agent advise, and
// what happens if I say nothing", with Yes / No / Later.
//
// API lives in approvals-panel.ts (dashboard side, token-gated like the
// rest of /api/admin). This file owns only the HTML, CSS and client JS.
// Client JS avoids backslash escapes: they collapse inside this template
// literal.

import { renderShell, type TopbarPeer } from ".."

export interface ApprovalsPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
  localToken?: string
}

export function renderApprovalsPage(opts: ApprovalsPageOpts = {}): string {
  const tokenScript = opts.localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>`
    : ""

  const body = `<div class="apv">
  <header class="apv__head">
    <div>
      <h1>Approvals</h1>
      <p class="apv__lead">Everything waiting for your yes or no, most urgent first. Cards that say <b>Expires</b> decide themselves when time runs out.</p>
    </div>
    <div class="apv__filters" role="group" aria-label="Show">
      <button type="button" class="ax-chip apv__f is-on" data-kind="" aria-pressed="true">All <span id="n-all"></span></button>
      <button type="button" class="ax-chip apv__f" data-kind="card" aria-pressed="false">Cards <span id="n-card"></span></button>
      <button type="button" class="ax-chip apv__f" data-kind="schedule" aria-pressed="false">Schedules <span id="n-schedule"></span></button>
      <button type="button" class="ax-chip apv__f" data-kind="memory" aria-pressed="false">Memory <span id="n-memory"></span></button>
      <button type="button" class="ax-chip apv__f" data-kind="wiki" aria-pressed="false">Wiki <span id="n-wiki"></span></button>
    </div>
  </header>

  <div id="apv-msg" class="apv__msg" role="status" aria-live="polite"></div>
  <div id="apv-errors"></div>
  <ol id="apv-list" class="apv__list" aria-label="Waiting for you"></ol>
  <p id="apv-snoozed" class="apv__foot"></p>

  <details class="apv__settings" id="apv-settings">
    <summary>Settings: expiry, later, daily digest</summary>
    <form id="apv-form" class="apv__form">
      <label>Cards expire after (days)<input type="number" min="1" step="1" name="defaultExpiryDays" required></label>
      <label>Longest a card may wait (days)<input type="number" min="1" step="1" name="maxExpiryDays" required></label>
      <label>"Later" hides an item for (hours)<input type="number" min="1" step="1" name="laterHours" required></label>
      <label class="apv__check"><input type="checkbox" name="notifyAgent"> Tell the agent the result</label>
      <label class="apv__check"><input type="checkbox" name="digestEnabled"> Send one digest a day</label>
      <label>Digest time (24-hour)<input type="time" name="digestTime" required></label>
      <label>Digest goes to (channel:chat id, empty for the notifications destination)<input type="text" name="destination" placeholder="telegram:123456" autocomplete="off"></label>
      <div><button type="submit" class="ax-btn ax-btn--primary">Save settings</button></div>
    </form>
  </details>
</div>`

  return renderShell({
    title: "AgentX · Approvals",
    activeTab: "approvals",
    subtitle: "Approvals",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: APPROVALS_CSS,
    scripts: `${tokenScript}<script>${APPROVALS_SCRIPT}</script>`,
  })
}

const APPROVALS_CSS = `
.apv { max-width: 860px; margin: 0 auto; padding: 20px 16px 64px; color: var(--ax-text); }
.apv__head { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: flex-end; margin-bottom: 14px; }
.apv__head h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.apv__lead { margin: 0; color: var(--ax-muted); font-size: 13px; line-height: 1.5; max-width: 52ch; }
.apv__filters { display: flex; flex-wrap: wrap; gap: 6px; }
.apv__f { cursor: pointer; font: inherit; font-size: 12px; }
.apv__f.is-on { border-color: var(--ax-accent); color: var(--ax-text); background: var(--ax-accent-t); }
.apv__f span { color: var(--ax-muted); font-family: var(--ax-mono); font-size: 11px; }
.apv__msg { min-height: 20px; font-size: 13px; margin: 4px 0 8px; }
.apv__msg.is-err { color: var(--ax-err); }
.apv__msg.is-ok { color: var(--ax-ok); }
.apv__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.apv__item { background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 14px 16px; }
.apv__item:focus-within { border-color: var(--ax-accent); }
.apv__item.is-done { opacity: 0.55; }
.apv__meta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 11px; color: var(--ax-muted); margin-bottom: 6px; }
.apv__kind { text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--ax-mono); }
.apv__title { margin: 0 0 4px; font-size: 15px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.apv__ask { margin: 0 0 8px; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
.apv__rec { margin: 0 0 8px; font-size: 13px; color: var(--ax-text-2); line-height: 1.45; }
.apv__rec b { color: var(--ax-ok); font-weight: 600; }
.apv__exp { display: inline-block; font-size: 12px; margin: 0 0 8px; padding: 2px 8px; border-radius: var(--ax-radius-pill); background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.apv__exp.is-soon { background: var(--ax-red-t); color: var(--ax-red-ink); }
.apv__detail { font-size: 12px; color: var(--ax-text-2); margin: 0 0 10px; }
.apv__detail summary { cursor: pointer; color: var(--ax-muted); }
.apv__detail p { margin: 6px 0 0; line-height: 1.5; overflow-wrap: anywhere; }
.apv__detail code { font-family: var(--ax-mono); font-size: 11px; }
.apv__detail a { color: var(--ax-accent); overflow-wrap: anywhere; }
.apv__acts { display: flex; flex-wrap: wrap; gap: 8px; }
.apv__acts .ax-btn { min-height: 40px; min-width: 88px; }
.apv__hint { font-size: 11px; color: var(--ax-muted); margin-top: 6px; }
.apv__empty { text-align: center; padding: 40px 12px; color: var(--ax-muted); border: 1px dashed var(--ax-border); border-radius: var(--ax-radius); }
.apv__empty h2 { font-size: 15px; color: var(--ax-text); margin: 0 0 4px; }
.apv__foot { font-size: 12px; color: var(--ax-muted); }
.apv__foot button { font: inherit; color: var(--ax-accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
.apv__err { font-size: 12px; color: var(--ax-err); margin: 0 0 8px; }
.apv__settings { margin-top: 28px; border-top: 1px solid var(--ax-border); padding-top: 12px; }
.apv__settings summary { cursor: pointer; font-size: 13px; color: var(--ax-text-2); }
.apv__form { display: grid; gap: 10px; margin-top: 12px; max-width: 460px; }
.apv__form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ax-text-2); }
.apv__form label.apv__check { flex-direction: row; align-items: center; gap: 8px; }
.apv__form input[type=number], .apv__form input[type=time], .apv__form input[type=text] {
  font: inherit; font-size: 14px; padding: 8px 10px; border-radius: var(--ax-radius-sm);
  border: 1px solid var(--ax-border); background: var(--ax-bg); color: var(--ax-text);
}
@media (max-width: 560px) {
  .apv__acts .ax-btn { flex: 1 1 0; }
}
`

const APPROVALS_SCRIPT = `
(function(){
var state = { items: [], snoozed: 0, kind: '', showAll: false };
var LABEL = { card: 'Card', schedule: 'Schedule', memory: 'Memory fact', wiki: 'Wiki lesson' };
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function headers(json){
  var h = { 'X-Requested-With': 'agentx-board' };
  if (json) h['Content-Type'] = 'application/json';
  if (window.AX_LOCAL_TOKEN) h['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
  return h;
}
function say(text, kind){ var m = $('apv-msg'); m.textContent = text || ''; m.className = 'apv__msg' + (kind ? ' is-' + kind : ''); }
function rel(iso){
  var ms = Date.parse(iso) - Date.now();
  if (isNaN(ms)) return '';
  var past = ms < 0; ms = Math.abs(ms);
  var h = Math.round(ms / 3600000);
  var t = h < 1 ? Math.max(1, Math.round(ms / 60000)) + ' min' : h < 48 ? h + ' h' : Math.round(h / 24) + ' days';
  return past ? t + ' ago' : 'in ' + t;
}
function safeLink(u){ return /^https?:[/][/]/i.test(u || '') ? u : ''; }

async function load(){
  try {
    var r = await fetch('/api/admin/approvals' + (state.showAll ? '?all=1' : ''), { headers: headers(false) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    state.items = d.items || []; state.snoozed = d.snoozed || 0;
    $('apv-errors').innerHTML = (d.errors || []).map(function(e){ return '<p class="apv__err">Couldn&#39;t read ' + esc(e.kind) + ': ' + esc(e.error) + '. The list may be incomplete.</p>'; }).join('');
    render();
    if (d.settings) fillSettings(d.settings);
  } catch (e) { say('Couldn’t load approvals: ' + e.message, 'err'); }
}

function counts(){
  var c = { card: 0, schedule: 0, memory: 0, wiki: 0 };
  state.items.forEach(function(i){ c[i.kind] = (c[i.kind] || 0) + 1; });
  $('n-all').textContent = state.items.length;
  Object.keys(c).forEach(function(k){ $('n-' + k).textContent = c[k]; });
}

function render(){
  counts();
  var list = state.items.filter(function(i){ return !state.kind || i.kind === state.kind; });
  var ol = $('apv-list');
  if (!list.length) {
    ol.innerHTML = '<li class="apv__empty"><h2>Nothing waiting for you</h2><p>New requests from agents, schedules, memory and the wiki show up here.</p></li>';
  } else {
    ol.innerHTML = list.map(item).join('');
  }
  var foot = $('apv-snoozed');
  foot.innerHTML = state.snoozed && !state.showAll
    ? state.snoozed + ' put off for later. <button type="button" id="apv-show-all">Show them</button>'
    : (state.showAll ? '<button type="button" id="apv-hide-later">Hide items put off for later</button>' : '');
}

function item(i){
  var soon = i.expires && (Date.parse(i.expires) - Date.now()) < 86400000;
  var link = safeLink(i.source);
  var more = [];
  if (i.detail) more.push('<p>' + esc(i.detail) + '</p>');
  if (i.source) more.push('<p>Source: ' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(i.source) + '</a>' : esc(i.source)) + '</p>');
  if (i.more) more.push('<p>Full record: <code>' + esc(i.more) + '</code></p>');
  more.push('<p>Yes: ' + esc(i.yes) + '. No: ' + esc(i.no) + '.</p>');
  return '<li class="apv__item" data-key="' + esc(i.key) + '">'
    + '<div class="apv__meta"><span class="apv__kind">' + esc(LABEL[i.kind] || i.kind) + '</span><span>from ' + esc(i.raised_by) + '</span>'
    + (i.created_at ? '<span>' + esc(rel(i.created_at)) + '</span>' : '')
    + (i.snoozed_until ? '<span>put off until ' + esc(new Date(i.snoozed_until).toLocaleString()) + '</span>' : '') + '</div>'
    + '<h2 class="apv__title">' + esc(i.title) + '</h2>'
    + '<p class="apv__ask">' + esc(i.ask) + '</p>'
    + (i.recommend ? '<p class="apv__rec"><b>Recommends:</b> ' + esc(i.recommend) + '</p>' : '')
    + (i.expires ? '<p class="apv__exp' + (soon ? ' is-soon' : '') + '" title="' + esc(new Date(i.expires).toLocaleString()) + '">Expires ' + esc(rel(i.expires)) + ', then: ' + esc(i.if_silent) + '</p>' : '')
    + '<details class="apv__detail"><summary>Details</summary>' + more.join('') + '</details>'
    + '<div class="apv__acts">'
    + '<button type="button" class="ax-btn ax-btn--primary" data-act="yes">Yes</button>'
    + '<button type="button" class="ax-btn ax-btn--danger" data-act="no">No</button>'
    + '<button type="button" class="ax-btn ax-btn--ghost" data-act="later">Later</button>'
    + '</div></li>';
}

async function act(li, action){
  var key = li.getAttribute('data-key');
  var btns = li.querySelectorAll('button[data-act]');
  btns.forEach(function(b){ b.disabled = true; });
  try {
    var r = await fetch('/api/admin/approvals/decide', { method: 'POST', headers: headers(true), body: JSON.stringify({ key: key, action: action }) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    say(d.message, 'ok');
    li.classList.add('is-done');
    var next = li.nextElementSibling;
    state.items = state.items.filter(function(i){ return i.key !== key; });
    if (action === 'later') state.snoozed++;
    setTimeout(function(){ render(); var f = next && document.querySelector('[data-key="' + next.getAttribute('data-key') + '"] button[data-act=yes]'); if (f) f.focus(); }, 350);
  } catch (e) {
    say(e.message, 'err');
    btns.forEach(function(b){ b.disabled = false; });
  }
}

function fillSettings(s){
  var f = $('apv-form');
  f.defaultExpiryDays.value = s.defaultExpiryDays;
  f.maxExpiryDays.value = s.maxExpiryDays;
  f.laterHours.value = s.laterHours;
  f.notifyAgent.checked = !!s.notifyAgent;
  f.digestEnabled.checked = !!(s.digest && s.digest.enabled);
  f.digestTime.value = (s.digest && s.digest.time) || '09:00';
  var d = s.digest && s.digest.destination;
  f.destination.value = d ? d.channel + ':' + d.chatId : '';
}

document.addEventListener('click', function(ev){
  var t = ev.target;
  var b = t.closest && t.closest('button[data-act]');
  if (b) { act(b.closest('.apv__item'), b.getAttribute('data-act')); return; }
  var f = t.closest && t.closest('.apv__f');
  if (f) {
    state.kind = f.getAttribute('data-kind');
    document.querySelectorAll('.apv__f').forEach(function(x){ var on = x === f; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    render(); return;
  }
  if (t.id === 'apv-show-all') { state.showAll = true; load(); }
  if (t.id === 'apv-hide-later') { state.showAll = false; load(); }
});

$('apv-form').addEventListener('submit', async function(ev){
  ev.preventDefault();
  var f = ev.target;
  var body = {
    defaultExpiryDays: Number(f.defaultExpiryDays.value),
    maxExpiryDays: Number(f.maxExpiryDays.value),
    laterHours: Number(f.laterHours.value),
    notifyAgent: f.notifyAgent.checked,
    digestEnabled: f.digestEnabled.checked,
    digestTime: f.digestTime.value,
    destination: f.destination.value.trim()
  };
  try {
    var r = await fetch('/api/admin/approvals/settings', { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    fillSettings(d.settings);
    say('Settings saved.', 'ok');
  } catch (e) { say('Settings not saved: ' + e.message, 'err'); }
});

load();
setInterval(function(){ if (document.visibilityState === 'visible' && !document.querySelector('.apv__item:focus-within')) load(); }, 60000);
})();
`
