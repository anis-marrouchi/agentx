// --- Phone app: the conversation strip and finish banners (#265) ---
//
// Inlined into /app last, after the Chat and voice scripts. A row of chips
// at the top of Chat, one per conversation that is running or has an
// answer this phone hasn't opened, in the agent's orb colour with its state:
// thinking, answering, or a new answer. A tap switches to it through
// window.AXChat.open, which re-attaches to a running turn or shows the
// saved answer.
//
// It polls GET /api/app/chat/active (app-chat.ts) every 4 s while Chat is on
// screen and every 10 s on the other tabs, and stops while the app is in
// the background, telling the computer so (POST /api/app/chat/away) that a
// finish is announced by notification instead. When a conversation that
// isn't on screen finishes, a banner says so (tap to open, gone after 6 s,
// one after another) and a "background" ax-chat event lets the voice bar
// read the answer out.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_CHAT_STRIP_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-chat'), C = window.AXChat, V = window.AXChatView, O = window.AXOrb;
  var top = panel && panel.querySelector('.cx-top');
  if (!top || !C || !V) return;
  var nav = document.createElement('nav');
  nav.className = 'cs'; nav.hidden = true;
  nav.setAttribute('aria-label', 'Conversations');
  nav.innerHTML = '<ul class="cs-list"></ul>';
  top.insertBefore(nav, top.firstChild);
  var list = nav.firstChild;
  var shelf = document.createElement('div');
  shelf.className = 'cs-banners';
  shelf.setAttribute('aria-live', 'polite');
  document.body.appendChild(shelf);

  var HEX = /^#[0-9a-fA-F]{6}$/, ON_CHAT = 4000, ELSEWHERE = 10000, BANNER_MS = 6000;
  var SAY = { thinking: 'thinking', answering: 'answering', done: 'new answer', open: 'on screen' };
  // prev: each conversation's state at the last poll. watch: ones this phone
  // let go of while they ran, so a finish is noticed even between polls.
  var items = [], prev = {}, watch = {}, timer = 0, inflight = false, drawn = '';
  var waiting = [], shown = null, hideTimer = 0;

  function colorOf(c) { var x = O ? O.colorFor(c.agent, c.color) : c.color; return HEX.test(x || '') ? x : '#2563EB'; }
  function nameOf(c) { return c.agentName || c.agent || 'Agent'; }

  // --- The strip ---
  function render() {
    var cur = C.current(), all = items.slice();
    // The conversation on screen keeps a chip, so there is a way back to it.
    if (cur && !all.some(function (c) { return c.id === cur; })) {
      var t = C.target() || {};
      all.unshift({ id: cur, agent: t.agent, agentName: t.agentName, color: t.color, state: 'open', preview: '' });
    }
    nav.hidden = !all.some(function (c) { return c.id !== cur; });
    var html = nav.hidden ? '' : all.map(function (c) {
      var here = c.id === cur, fresh = c.state === 'done' && !here, label = nameOf(c) + ', ' + SAY[c.state] + (c.preview ? ': ' + c.preview : '');
      return '<li><button type="button" class="cs-chip cs-' + c.state + '" data-id="' + V.esc(c.id) + '" style="--cs-c:' + colorOf(c) + '"' +
        (here ? ' aria-current="true"' : '') + ' aria-label="' + V.esc(label) + '" title="' + V.esc(c.preview || '') + '">' +
        '<span class="cs-dot" aria-hidden="true"></span><span class="cs-name">' + V.esc(nameOf(c)) + '</span>' +
        (fresh ? '<span class="cs-new" aria-hidden="true">New</span>' : '<span class="cs-state" aria-hidden="true">' + V.esc(SAY[c.state] || '') + '</span>') + '</button></li>';
    }).join('');
    // Redrawn only when something changed, so a poll never steals focus
    // or a tap; a focused chip keeps focus across a redraw.
    if (html === drawn) return;
    var had = document.activeElement && list.contains(document.activeElement) ? document.activeElement.getAttribute('data-id') : null;
    list.innerHTML = drawn = html;
    var again = had && list.querySelector('button[data-id="' + had + '"]');
    if (again) again.focus();
  }
  list.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-id]');
    if (b && b.getAttribute('data-id') !== C.current()) C.open(b.getAttribute('data-id'));
  });
  // Arrow keys move along the strip; Tab leaves it.
  list.addEventListener('keydown', function (ev) {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft' && ev.key !== 'Home' && ev.key !== 'End') return;
    var bs = Array.prototype.slice.call(list.querySelectorAll('button')), i = bs.indexOf(document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    var j = ev.key === 'Home' ? 0 : ev.key === 'End' ? bs.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
    bs[j].focus();
    bs[j].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  // --- Polling ---
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
  function poll() {
    clearTimeout(timer);
    if (document.hidden) return;
    schedule(panel.hidden ? ELSEWHERE : ON_CHAT);
    if (inflight) return;
    inflight = true;
    fetch('/api/app/chat/active', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) update(d.conversations || []); })
      .catch(function () {}).then(function () { inflight = false; });
  }
  function update(next) {
    var now = {}, cur = C.current();
    delete watch[cur];
    next.forEach(function (c) {
      now[c.id] = c.state;
      var was = prev[c.id] || (watch[c.id] ? 'thinking' : null);
      if (c.state === 'done') { delete watch[c.id]; if (was === 'thinking' || was === 'answering') finished(c, cur); }
    });
    prev = now; items = next;
    render();
  }
  function finished(c, cur) {
    // On screen: the chat shows the answer (and says it) itself.
    if (c.id === cur) return;
    // Follow-ups typed for it while it ran go now.
    if (C.held(c.id)) C.flushHeld(c.id);
    banner(c);
    if (c.status === 'done') {
      document.dispatchEvent(new CustomEvent('ax-chat', { detail: { type: 'background', conversationId: c.id, agentName: nameOf(c), at: c.updatedAt } }));
    }
  }

  // --- Banners, one at a time ---
  function banner(c) { waiting.push(c); if (!shown) nextBanner(); }
  function nextBanner() {
    var c = waiting.shift();
    if (!c) return;
    var b = document.createElement('div');
    b.className = 'cs-banner';
    b.style.setProperty('--cs-c', colorOf(c));
    b.innerHTML = '<button type="button" class="cs-banner-open"><strong></strong><span></span></button>' +
      '<button type="button" class="cs-banner-x" aria-label="Dismiss">×</button>';
    b.querySelector('strong').textContent = nameOf(c) + (c.status === 'error' ? ' could not answer' : ' finished');
    b.querySelector('span').textContent = c.preview || '';
    b.querySelector('.cs-banner-open').addEventListener('click', function () {
      hide();
      var tab = document.getElementById('tab-chat');
      if (tab && panel.hidden) tab.click();
      C.open(c.id);
    });
    b.querySelector('.cs-banner-x').addEventListener('click', hide);
    // Held open while a finger or the keyboard is on it.
    b.addEventListener('focusin', function () { clearTimeout(hideTimer); });
    b.addEventListener('focusout', function () { hideTimer = setTimeout(hide, BANNER_MS); });
    shown = b;
    shelf.appendChild(b);
    hideTimer = setTimeout(hide, BANNER_MS);
  }
  function hide() {
    clearTimeout(hideTimer);
    if (shown) shown.remove();
    shown = null;
    if (waiting.length) setTimeout(nextBanner, 250);
  }

  document.addEventListener('ax-chat', function (ev) {
    var d = ev.detail || {};
    if (d.type === 'detached' && d.conversationId) { watch[d.conversationId] = 1; render(); }
    else if (d.type === 'target') render();
    // A new turn: show its chip soon rather than at the next tick.
    else if (d.type === 'busy' && d.on) schedule(800);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { poll(); return; }
    clearTimeout(timer);
    try { fetch('/api/app/chat/away', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(function () {}); } catch (e) {}
  });
  var tabs = document.querySelector('.tabs');
  if (tabs) tabs.addEventListener('click', function () { schedule(0); });
  window.AXStrip = { poll: poll, update: update, banner: banner };
  poll();
})();
`
