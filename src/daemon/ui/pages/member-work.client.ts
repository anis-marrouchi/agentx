// --- The work page's script (/member) (#386, #489, #443) ---
//
// Fills the summary line, "Needs a person", the agent cards and "What you
// sent", which opens with the person's messages still waiting in line. An
// opened agent card stays open across rounds. When an agent goes from
// Working to Free between two good loads, a notification says so, once the
// person has allowed them with the button under the cards; it is shown by
// this page only, so never with the page closed. When a round fails after
// a good one, the cards say the state is from the last load.
//
// A busy card says what the agent is doing whoever started it, and what
// waits in line behind it (the owner's decisions on #443, 2026-10-05).
//
// A round leaves keyboard focus where it was and does not make a screen
// reader read out the summary line again when its words are the same.
//
// One round every 30 seconds loads the work lists, and the name line too
// until it has loaded once. A round that fails is tried again after 20
// seconds, and the strip says which it is: the browser offline, or the
// server not answering (connectionNote in member-logic.ts). A load that
// worked hides the strip. A request that
// gets no answer in 15 seconds counts as failed, so a stalled server
// cannot stop the rounds.
//
// workState, ageText, connectionNote, plainPreview, agentLine, sentState,
// requestState, summaryLine and freedAgents come from injectFns.
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
  var notify = document.getElementById('notify');
  var canNotify = typeof Notification !== 'undefined';
  function showNotify() { notify.hidden = !canNotify || Notification.permission !== 'default'; }
  notify.addEventListener('click', function () {
    // Older Safari answers by callback only.
    var asked = Notification.requestPermission(showNotify);
    if (asked && asked.then) asked.then(showNotify, showNotify);
  });
  function tellFree(id) {
    if (!canNotify || Notification.permission !== 'granted') return;
    try {
      var n = new Notification(id + ' is free', { body: 'Ready for your next message.', tag: 'free-' + id });
      n.onclick = function () { window.focus(); n.close(); };
    } catch (e) { /* Chrome on Android shows them only from a service worker; the green card still says Free. */ }
  }
  showNotify();
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
  // Each round rebuilds the lists. A list whose markup did not change is
  // left alone; one that did keeps the keyboard where it was: the same
  // agent's button or the same link, else the link or button at the same
  // place, else the list's heading when nothing in it can take focus. A
  // heading whose section is now hidden hands over to "What you sent",
  // which is always shown (#443).
  function fill(list, html, head, box) {
    if (list.axHtml === html) return;
    list.axHtml = html;
    var f = document.activeElement, at = -1, attr = null, key = null, i;
    if (f && list.contains && list.contains(f)) {
      var was = list.querySelectorAll('a, button');
      for (i = 0; i < was.length; i++) if (was[i] === f) at = i;
      attr = f.getAttribute('data-agent') != null ? 'data-agent' : 'href';
      key = f.getAttribute(attr);
    }
    list.innerHTML = html;
    if (at < 0) return;
    var now = list.querySelectorAll('a, button'), to = null;
    // Several rows can link the same thread: take the one nearest the old place.
    for (i = 0; i < now.length && key != null; i++) if (now[i].getAttribute(attr) === key && (!to || Math.abs(i - at) < Math.abs(to.i - at))) to = { el: now[i], i: i };
    to = to ? to.el : now.length ? now[Math.min(at, now.length - 1)] : box && box.hidden ? document.getElementById('h-sent') : document.getElementById(head);
    if (to) to.focus();
  }
  function showConn() {
    var note = connectionNote(failed, navigator.onLine !== false, RETRY_S, loaded);
    strip.hidden = !note;
    if (!note) return;
    // Same words are not written again: a screen reader would repeat them on every failed round.
    if (stripText.textContent !== note.text) stripText.textContent = note.text;
    retry.hidden = !note.retry;
    // Agent states are now from the last load, not live.
    if (last && !shownStale) { shownStale = true; fill(agentsList, (last.agents || []).map(function (a) { return agent(a, Date.now(), true); }).join(''), 'h-agents', agentsBox); }
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
    // The full text comes only with the person's own request (agents.ts).
    var mine = a.state === 'working' && a.by === 'you' && !!a.fullText;
    var q = a.queue || { waiting: 0, yours: 0 };
    var line = !q.waiting ? 'Nothing waits behind this.' :
      q.waiting + (q.waiting === 1 ? ' message waits' : ' messages wait') + ' behind this' + (q.yours ? ', ' + (q.yours === q.waiting ? (q.yours === 1 ? 'yours' : 'all yours') : q.yours + ' of them yours') : '') + '.';
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
        '<p class="full">' + esc(a.fullText) + '</p><dl>' +
        '<dt>Started by</dt><dd>you</dd>' +
        '<dt>Sent</dt><dd>' + clock(a.at) + ', ' + ageText(a.at, now) + ' ago</dd>' +
        (a.where ? '<dt>Asked on</dt><dd>' + where(a) + '</dd><dt>Answer</dt><dd>It arrives on ' + where(a) + ' when the agent finishes.</dd>' : '') +
        '<dt>In line</dt><dd>' + line + '</dd>' +
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
  function delivered(ev) {
    if (!ev) return '';
    return /^https?:\\/\\//i.test(ev)
      ? '<p class="note"><a href="' + esc(ev) + '" target="_blank" rel="noopener noreferrer">What was delivered</a></p>'
      : '<p class="note"><b>What was delivered:</b> ' + esc(ev) + '</p>';
  }
  function sent(r, now) {
    var st = sentState(r);
    var note = delivered(r.request && r.request.evidence);
    var moved = st.tone === 'work' ? 'started ' + ageText(r.startedAt, now) + ' ago' : ageText(r.finishedAt || r.startedAt, now) + ' ago';
    return '<li class="row"><p class="text">' + esc(plainPreview(r.messagePreview)) + '</p>' + note +
      '<p class="meta"><span>' + esc(r.agentId) + '</span>' + (r.where ? '<span>from ' + where(r) + '</span>' : '') + '</p>' +
      '<p class="side"><span class="state ' + st.tone + '">' + esc(st.label) + '</span><span class="moved">' + moved + '</span></p></li>';
  }
  // One of the person's messages still waiting behind a busy agent.
  function queued(r, now) {
    var st = sentState({ status: 'queued' });
    var place = r.ahead === 0 ? 'next when the agent is free' : r.ahead + (r.ahead === 1 ? ' message' : ' messages') + ' ahead of it';
    return '<li class="row"><p class="text">' + esc(plainPreview(r.messagePreview)) + '</p>' +
      '<p class="meta"><span>' + esc(r.agentId) + '</span>' + (r.where ? '<span>from ' + where(r) + '</span>' : '') + '</p>' +
      '<p class="side"><span class="state ' + st.tone + '">' + esc(st.label) + '</span><span class="moved">' + place + '</span><span class="moved">sent ' + ageText(r.queuedAt, now) + ' ago</span></p></li>';
  }
  // A request no turn of the list stands for: its turn is older, or it has none.
  function request(r, now) {
    var st = requestState(r.state);
    var note = delivered(r.evidence);
    return '<li class="row"><p class="text">' + esc(plainPreview(r.text)) + '</p>' + note +
      '<p class="meta"><span>' + esc(r.agentId) + '</span><span>from ' + where(r) + '</span></p>' +
      '<p class="side"><span class="state ' + st.tone + '">' + esc(st.label) + '</span><span class="moved">' + ageText(r.closedAt || r.updatedAt || r.createdAt, now) + ' ago</span></p></li>';
  }
  function show(w, now) {
    var agents = w.agents || [], waiting = w.queued || [];
    // The line is read out by a screen reader: same words, no new announcement.
    var line = summaryLine(agents, w.runs.length + waiting.length);
    if (sum.textContent !== line) sum.textContent = line;
    agentsBox.hidden = !agents.length;
    fill(agentsList, agents.map(function (a) { return agent(a, now, false); }).join(''), 'h-agents', agentsBox);
    var asks = w.open.filter(function (r) { return r.state === 'waiting_owner' || r.state === 'needs_attention'; });
    need.hidden = !asks.length;
    fill(document.getElementById('need-list'), asks.map(function (r) { return needRow(r, now); }).join(''), 'h-need', need);
    fill(document.getElementById('sent'), waiting.map(function (r) { return queued(r, now); }).join('') +
      w.runs.map(function (r) { return sent(r, now); }).join('') +
      (w.other || []).map(function (r) { return request(r, now); }).join('') ||
      '<li class="blank"><p>Ask an agent for something on WhatsApp, Telegram, GitLab or GitHub. It shows up here as soon as the agent starts on it.</p><p>You see when it is running, when it is finished, and when the agent is free again.</p></li>', 'h-sent');
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
      freedAgents(last && last.agents, w.agents || []).forEach(tellFree);
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
