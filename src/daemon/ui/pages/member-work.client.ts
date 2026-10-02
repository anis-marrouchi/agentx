// --- The work page's script (/member) (#386, #489) ---
//
// One round every 30 seconds loads the work lists, and the name line too
// until it has loaded once. A round that fails is tried again after 20
// seconds, and the strip says which it is: the browser offline, or the
// server not answering (connectionNote in member-logic.ts). A load that
// worked hides the strip. A request that
// gets no answer in 15 seconds counts as failed, so a stalled server
// cannot stop the rounds.
//
// workState, ageText, connectionNote and plainPreview come from injectFns.
// No backticks, backslashes or dollar-brace in the script: it sits inside
// a TS template literal.

export const WORK_SCRIPT = `
(function () {
  var POLL_S = 30, RETRY_S = 20, GIVE_UP_MS = 15000;
  var who = document.getElementById('who');
  var strip = document.getElementById('offline');
  var stripText = document.getElementById('offline-text');
  var retry = document.getElementById('retry');
  var install = document.getElementById('install');
  var updated = document.getElementById('updated');
  var theme = document.getElementById('theme');
  // No network counts as a failed load until a load works (#496).
  var failed = navigator.onLine === false, loaded = false, named = false, busy = false, timer = null;
  theme.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem('ax-theme', cur); } catch (e) {}
  });
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/member/sw.js', { scope: '/member' }); } catch (e) {} }
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!standalone && /Windows|Macintosh|Linux/.test(navigator.userAgent) && !/Mobile/.test(navigator.userAgent)) install.hidden = false;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function showConn() {
    var note = connectionNote(failed, navigator.onLine !== false, RETRY_S, loaded);
    strip.hidden = !note;
    if (!note) return;
    // Same words are not written again: a screen reader would repeat them on every failed round.
    if (stripText.textContent !== note.text) stripText.textContent = note.text;
    retry.hidden = !note.retry;
  }
  window.addEventListener('online', function () { failed = false; showConn(); load(); });
  window.addEventListener('offline', function () { failed = true; showConn(); });
  retry.addEventListener('click', function () { load(); });
  // A 401 or 403 means this machine's key ended: /member then shows the pairing page.
  function get(url) {
    var ac = new AbortController();
    var giveUp = setTimeout(function () { ac.abort(); }, GIVE_UP_MS);
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ac.signal }).then(function (r) {
      if (r.status === 401 || r.status === 403) { location.replace('/member'); return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) { clearTimeout(giveUp); return j; }, function (e) { clearTimeout(giveUp); throw e; });
  }
  function where(r) {
    var label = esc(r.where && r.where.label || r.channel);
    return r.where && r.where.url ? '<a href="' + esc(r.where.url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
  }
  function item(r, now, closed) {
    var st = workState(r.state);
    var note = '';
    if (r.state === 'waiting_owner' && r.question) note = '<p class="note"><b>The owner is asked:</b> ' + esc(r.question) + '</p>';
    else if (r.state === 'needs_attention' && r.attentionReason) note = '<p class="note">' + esc(r.attentionReason) + '</p>';
    else if (closed && r.evidence) note = /^https?:\\/\\//i.test(r.evidence)
      ? '<p class="note"><a href="' + esc(r.evidence) + '" target="_blank" rel="noopener noreferrer">What was delivered</a></p>'
      : '<p class="note"><b>What was delivered:</b> ' + esc(r.evidence) + '</p>';
    var age = closed ? 'closed ' + ageText(r.closedAt || r.updatedAt, now) + ' ago' : 'for ' + ageText(r.createdAt, now);
    return '<li class="item"><p class="text">' + esc(r.text) + '</p>' +
      '<p class="meta"><span class="state ' + st.tone + '">' + esc(st.label) + '</span><span>' + esc(r.agentId) + '</span><span>' + age + '</span><span>asked on ' + where(r) + '</span></p>' + note + '</li>';
  }
  function run(r, now) {
    var mark = r.status === 'ok' ? 'finished' : r.status === 'in-flight' ? 'running' : esc(r.status);
    return '<li class="item"><p class="text">' + esc(plainPreview(r.messagePreview)) + '</p><p class="meta"><span class="state ' + (r.status === 'ok' ? 'ok' : r.status === 'in-flight' ? 'warn' : 'bad') + '">' + mark + '</span><span>' + esc(r.agentId) + '</span><span>' + ageText(r.startedAt, now) + ' ago</span><span>' + esc(r.channel || '') + '</span></p></li>';
  }
  function fill(id, html, empty) { document.getElementById(id).innerHTML = html || '<li class="muted">' + empty + '</li>'; }
  function loadName() {
    if (named) return;
    get('/api/member/me').then(function (me) {
      if (!me) return;
      named = true;
      who.textContent = me.name + ' · ' + me.device + (me.node ? ' · ' + me.node : '');
    }).catch(function () { /* the next round asks again; the work load of this round reports the failure */ });
  }
  function load() {
    if (busy) return;
    busy = true; retry.disabled = true; clearTimeout(timer);
    loadName();
    get('/api/member/work').then(function (w) {
      if (!w) return;
      failed = false;
      var now = Date.now();
      document.getElementById('n-open').textContent = w.open.length ? '(' + w.open.length + ')' : '';
      fill('open', w.open.map(function (r) { return item(r, now, false); }).join(''), 'Nothing open. What you ask the agents for shows up here while it is being worked on.');
      fill('recent', w.recent.map(function (r) { return item(r, now, true); }).join(''), 'Nothing finished in the last 7 days.');
      fill('runs', w.runs.map(function (r) { return run(r, now); }).join(''), 'No turns recorded yet.');
      updated.textContent = 'Updated ' + new Date(now).toLocaleTimeString();
      loaded = true;
    }).catch(function () { failed = true; }).then(function () {
      busy = false; retry.disabled = false; showConn();
      timer = setTimeout(load, (failed ? RETRY_S : POLL_S) * 1000);
    });
  }
  showConn();
  load();
})();
`
