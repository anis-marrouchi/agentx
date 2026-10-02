// --- The work page's script (/member) (#386, #489, #443) ---
//
// Fills the summary line, the agent cards, "Needs a person" and "What you
// sent". An opened agent card stays open across rounds. When a round
// fails after a good one, the cards say the state is from the last load.
//
// One round every 30 seconds loads the work lists, and the name line too
// until it has loaded once. A round that fails is tried again after 20
// seconds, and the strip says which it is: the browser offline, or the
// server not answering (connectionNote in member-logic.ts). A load that
// worked hides the strip. A request that
// gets no answer in 15 seconds counts as failed, so a stalled server
// cannot stop the rounds.
//
// workState, ageText, connectionNote, plainPreview, agentLine, sentState
// and summaryLine come from injectFns.
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
  var sum = document.getElementById('sum');
  var agentsBox = document.getElementById('agents-box');
  var agentsList = document.getElementById('agents');
  var need = document.getElementById('need');
  var opened = {}, last = null, lastAt = 0, shownStale = false;
  agentsList.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('button.more') : null;
    if (!b) return;
    var id = b.getAttribute('data-agent');
    opened[id] = !opened[id];
    b.setAttribute('aria-expanded', opened[id] ? 'true' : 'false');
    b.textContent = opened[id] ? 'Hide this request' : 'Show this request';
    b.parentNode.classList.toggle('open', !!opened[id]);
  });
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
    // Agent states are now from the last load, not live.
    if (last && !shownStale) { shownStale = true; agentsList.innerHTML = (last.agents || []).map(function (a) { return agent(a, Date.now(), true); }).join(''); }
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
  function clock(at) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function agent(a, now, stale) {
    var v = agentLine(a);
    var mine = a.state === 'working' && a.by === 'you';
    var id = 'd-' + esc(a.agentId).replace(/[^A-Za-z0-9_-]/g, '_');
    var moved = a.at ? (a.state === 'working' ? '' : a.state === 'blocked' ? 'stopped ' : 'finished ') + ageText(a.at, now) + ' ago' : '';
    var meta = (v.by ? '<span>started by ' + esc(v.by) + '</span>' : '') + (moved ? '<span class="moved">' + moved + '</span>' : '') + (a.where ? '<span>from ' + where(a) + '</span>' : '');
    var hint = stale ? v.label + ' when this page last loaded, at ' + clock(lastAt) + '.' : v.hint;
    var html = '<li class="agent' + (v.tone === 'free' ? ' free' : '') + (mine && opened[a.agentId] ? ' open' : '') + '">' +
      '<p class="top"><span class="name">' + esc(a.agentId) + '</span><span class="state ' + v.tone + (v.tone === 'work' && !stale ? ' live' : '') + '">' + v.label + '</span></p>' +
      (v.what ? '<p class="what">' + esc(plainPreview(v.what)) + '</p>' : '') +
      (meta ? '<p class="meta">' + meta + '</p>' : '') + '<p class="hint">' + esc(hint) + '</p>';
    if (mine) {
      html += '<button type="button" class="more" data-agent="' + esc(a.agentId) + '" aria-expanded="' + (opened[a.agentId] ? 'true' : 'false') + '" aria-controls="' + id + '">' + (opened[a.agentId] ? 'Hide' : 'Show') + ' this request</button>' +
        '<div class="detail" id="' + id + '">' +
        '<ol class="steps" aria-label="Where this request is"><li class="done"><span class="sr">Done: </span>Received</li><li class="now" aria-current="step">Working</li><li>Finished</li></ol>' +
        '<p class="full">' + esc(a.fullText || a.text) + '</p><dl>' +
        '<dt>Started by</dt><dd>you</dd>' +
        '<dt>Sent</dt><dd>' + clock(a.at) + ', ' + ageText(a.at, now) + ' ago</dd>' +
        (a.where ? '<dt>Asked on</dt><dd>' + where(a) + '</dd><dt>Answer</dt><dd>It arrives on ' + where(a) + ' when the agent finishes.</dd>' : '') +
        '</dl></div>';
    }
    return html + '</li>';
  }
  function needRow(r, now) {
    var ask = r.state === 'waiting_owner' ? r.question : r.attentionReason;
    return '<li><span class="state ' + (r.state === 'waiting_owner' ? 'wait' : 'stuck') + '">' + esc(workState(r.state).label) + '</span>' +
      (ask ? '<p class="q">' + esc(ask) + '</p>' : '') +
      '<p class="for">For <b>' + esc(plainPreview(r.text)) + '</b></p>' +
      '<p class="meta"><span>' + esc(r.agentId) + '</span><span class="moved">' + (r.state === 'waiting_owner' ? 'asked ' : 'stuck ') + ageText(r.updatedAt || r.createdAt, now) + ' ago</span><span>from ' + where(r) + '</span></p></li>';
  }
  function sent(r, now) {
    var st = sentState(r);
    var ev = r.request && r.request.evidence;
    var note = ev ? (/^https?:\\/\\//i.test(ev)
      ? '<p class="note"><a href="' + esc(ev) + '" target="_blank" rel="noopener noreferrer">What was delivered</a></p>'
      : '<p class="note"><b>What was delivered:</b> ' + esc(ev) + '</p>') : '';
    var moved = st.tone === 'work' ? 'started ' + ageText(r.startedAt, now) + ' ago' : ageText(r.finishedAt || r.startedAt, now) + ' ago';
    return '<li class="row"><p class="text">' + esc(plainPreview(r.messagePreview)) + '</p>' + note +
      '<p class="meta"><span>' + esc(r.agentId) + '</span>' + (r.where ? '<span>from ' + where(r) + '</span>' : '') + '</p>' +
      '<p class="side"><span class="state ' + st.tone + '">' + esc(st.label) + '</span><span class="moved">' + moved + '</span></p></li>';
  }
  function show(w, now) {
    var agents = w.agents || [];
    sum.textContent = summaryLine(agents, w.runs.length);
    agentsBox.hidden = !agents.length;
    agentsList.innerHTML = agents.map(function (a) { return agent(a, now, false); }).join('');
    var asks = w.open.filter(function (r) { return r.state === 'waiting_owner' || r.state === 'needs_attention'; });
    need.hidden = !asks.length;
    document.getElementById('need-list').innerHTML = asks.map(function (r) { return needRow(r, now); }).join('');
    document.getElementById('sent').innerHTML = w.runs.map(function (r) { return sent(r, now); }).join('') ||
      '<li class="blank"><p>Ask an agent for something on WhatsApp, Telegram, GitLab or GitHub. It shows up here as soon as the agent starts on it.</p><p>You see when it is running, when it is finished, and when the agent is free again.</p></li>';
  }
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
      show(w, now);
      last = w; lastAt = now; shownStale = false;
      updated.textContent = 'Updated ' + new Date(now).toLocaleTimeString() + '. This page refreshes by itself.';
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
