// --- Phone app: Desk "Go through them" (#2499 part 2) ---
//
// Vanilla browser JS inlined into /app (app.ts) before app-desk.client.ts,
// with the functions of app-desk-wizard-logic.ts injected ahead of it. The
// Desk's "Go through them" calls window.AXDeskWizard.start: one card at a
// time in the Desk panel, N left, a slide to the next. Each answer goes at
// once to POST /api/app/approvals/decide, the call the Desk's own buttons
// use. Two or more Not finished requests are one step: Restart all, Close
// all (asks once more) or One by one. The end says what went to which agent
// and what could not be sent.
//
// While it is open the Desk's 15 s read does not redraw the panel: it hands
// the fresh cards to live(), and a step answered somewhere else is passed
// over.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_DESK_WIZARD_SCRIPT = `
(function () {
  var ax = window.AXAsk;
  if (!ax) return;
  var esc = ax.esc, ago = ax.ago;
  var BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
  var FOLD = 3;
  var w = null;

  function btn(act, label, cls, extra) {
    return '<button type="button" class="fx-btn dk-opt' + (cls ? ' ' + cls : '') + '" data-wz="' + act + '"' + (extra || '') + (w.busy ? ' disabled' : '') + '>' + label + '</button>';
  }
  function left() {
    var n = 0;
    for (var i = w.at; i < w.steps.length; i++) n += w.steps[i].kind === 'one' ? 1 : w.steps[i].cards.length;
    return n;
  }
  function meta(c) {
    return [c.agent, c.nodeName, c.askedAt ? 'asked ' + ago(c.askedAt) : '', c.expires ? 'answer by ' + new Date(c.expires).toLocaleString() : ''].filter(Boolean).map(esc).join(' · ');
  }
  function confirmRow(text, act, label) {
    return '<div class="dk-wiz-confirm" role="group"><p>' + esc(text) + '</p><div class="dk-answers">' +
      btn(act, esc(label), 'fx-danger') + btn('cancel', 'Cancel', '') + '</div></div>';
  }
  function oneHtml(c) {
    var h = '<article class="fx-card"><h4>' + esc(c.title) + '</h4>' +
      (c.ask ? '<p dir="auto">' + esc(c.ask) + '</p>' : '') +
      (c.recommend ? '<p class="fx-muted">Suggested: ' + esc(c.recommend) + '</p>' : '') +
      (c.facts ? '<details><summary>What is known</summary><p class="fx-muted">' + esc(c.facts) + '</p></details>' : '') +
      '<p class="fx-muted">' + meta(c) + '</p>';
    if (w.confirm) return h + confirmRow(w.confirm.text, w.confirm.act, w.confirm.label) + '</article>';
    var a = '';
    if (c.kind === 'request') {
      a += btn('yes', 'Pick it up again', 'fx-primary') + btn('no', 'Close it', '');
    } else if (c.choices && c.choices.length) {
      var rec = ax.advised(c);
      c.choices.forEach(function (label, n) {
        a += btn('pick', esc(label) + (n === rec ? ' <em>· suggested</em>' : ''), n === rec ? 'fx-primary' : '', ' data-n="' + n + '"');
      });
      a += btn('no', 'No', '');
    } else {
      a += btn('yes', 'Yes' + (c.yes ? '<small>' + esc(c.yes) + '</small>' : ''), 'fx-primary') + btn('no', 'No' + (c.no ? '<small>' + esc(c.no) + '</small>' : ''), '');
    }
    a += btn('later', 'Later', 'dk-ghost') + btn('skip', 'Skip', 'dk-ghost');
    return h + '<div class="dk-answers">' + a + '</div></article>';
  }
  function reqLine(c) { return '<li>' + esc(c.title) + (c.agent ? ' <span class="fx-muted">· ' + esc(c.agent) + '</span>' : '') + '</li>'; }
  function requestsHtml(s) {
    var n = s.cards.length;
    var h = '<article class="fx-card"><h4>' + n + ' requests are not finished</h4>' +
      '<p class="fx-muted">Their agents stopped before the end. Pick them all up again, close them all, or go one by one.</p>' +
      '<ul class="dk-wiz-list">' + s.cards.slice(0, FOLD).map(reqLine).join('') + '</ul>' +
      (n > FOLD ? '<details><summary>Show all ' + n + '</summary><ul class="dk-wiz-list">' + s.cards.slice(FOLD).map(reqLine).join('') + '</ul></details>' : '');
    if (w.progress) return h + '<p class="fx-muted" role="status">' + esc(w.progress) + '</p></article>';
    if (w.confirm) return h + confirmRow(w.confirm.text, w.confirm.act, w.confirm.label) + '</article>';
    return h + '<div class="dk-answers">' + btn('all-yes', 'Restart all ' + n, 'fx-primary') + btn('all-no', 'Close all ' + n, '') +
      btn('each', 'One by one', '') + btn('skip', 'Skip', 'dk-ghost') + '</div></article>';
  }
  function group(list, line) {
    var h = '<ul class="dk-wiz-list">' + list.slice(0, FOLD).map(line).join('') + '</ul>';
    if (list.length > FOLD) h += '<details><summary>Show all ' + list.length + '</summary><ul class="dk-wiz-list">' + list.slice(FOLD).map(line).join('') + '</ul></details>';
    return h;
  }
  function summaryHtml() {
    var s = wizSummary(w.sent);
    var sentN = w.sent.length - s.failed.length;
    var h = '<article class="fx-card"><h4>' + (sentN ? sentN + (sentN === 1 ? ' answer sent' : ' answers sent') : 'Nothing sent') + '</h4>';
    if (!w.sent.length) h += '<p class="fx-muted">You skipped every step. Nothing was answered.</p>';
    s.byAgent.forEach(function (g) {
      h += '<h5>' + esc(g.agent || 'No agent named') + '</h5>' + group(g.answers, function (a) {
        return '<li>' + esc(a.title) + ' <span class="fx-muted">· ' + esc(a.words) + '</span></li>';
      });
    });
    if (s.failed.length) {
      h += '<h5 class="fx-bad">Not sent</h5>' + group(s.failed, function (a) {
        return '<li>' + esc(a.title) + ' <span class="fx-bad">· ' + esc(a.error) + '</span></li>';
      });
    }
    return h + '<div class="dk-answers">' + btn('stop', 'Back to the Desk', 'fx-primary') + '</div></article>';
  }
  function draw(slide) {
    // Passes over what was answered somewhere else since it was read.
    while (w.at < w.steps.length && wizGone(w.steps[w.at], w.live)) w.at++;
    var s = w.steps[w.at];
    var n = s ? left() : 0;
    var body = !s ? summaryHtml() : s.kind === 'one' ? oneHtml(s.card) : requestsHtml(s);
    w.panel.innerHTML = '<div class="dk-wiz"><div class="dk-wiz-head"><button type="button" class="fx-btn dk-wiz-back" data-wz="stop" aria-label="Stop and go back to the Desk">' + BACK + '</button>' +
      '<strong>' + (s ? 'Go through them' : 'Summary') + '</strong><span class="fx-muted" aria-live="polite">' + (s ? n + ' left' : '') + '</span></div>' +
      '<div class="dk-wiz-step' + (slide ? ' dk-wiz-in' : '') + '">' + body + '</div>' +
      (w.error ? '<p class="fx-status fx-bad" role="alert">' + esc(w.error) + '</p>' : '') + '</div>';
  }
  function next() {
    w.at++; w.confirm = null; w.error = ''; w.failed = null; w.progress = '';
    draw(true);
  }
  function record(c, action, choice, error) {
    w.sent.push({ id: wizId(c), title: c.title, agent: c.agent, words: wizWords(c, action, choice), error: error || undefined });
  }
  function send(c, action, choice) {
    return ax.api('POST', '/api/app/approvals/decide', wizBody(c, action, choice));
  }
  function answer(c, action, choice) {
    var cur = w;
    w.busy = true; w.confirm = null; w.error = ''; draw(false);
    send(c, action, choice).then(function () {
      // Stopped while it was sending: the answer went, nothing to draw.
      if (w !== cur) return;
      w.busy = false; record(c, action, choice); next();
    }).catch(function (e) {
      if (w !== cur) return;
      // Stays on the step to try again; Skip keeps it for the summary.
      w.busy = false; w.failed = { action: action, choice: choice, error: e.message };
      w.error = 'Not sent: ' + e.message; draw(false);
    });
  }
  function all(cards, action) {
    var live = cards.filter(function (c) { return !w.live || w.live[wizId(c)]; });
    var k = 0, cur = w;
    w.busy = true; w.confirm = null;
    function one() {
      // Stopped part way: what was sent stays sent; the rest is not sent.
      if (w !== cur) return;
      if (k >= live.length) { w.busy = false; next(); return; }
      var c = live[k++];
      w.progress = 'Sending ' + k + ' of ' + live.length + '…'; draw(false);
      send(c, action, null).then(function () { if (w === cur) record(c, action, null); }, function (e) { if (w === cur) record(c, action, null, e.message); }).then(one);
    }
    one();
  }
  function onClick(ev) {
    if (!w) return;
    var b = ev.target.closest('[data-wz]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-wz');
    if (act === 'stop') return stop();
    if (w.busy) return;
    var s = w.steps[w.at];
    if (act === 'cancel') { w.confirm = null; return draw(false); }
    if (act === 'skip') {
      if (w.failed && s && s.kind === 'one') record(s.card, w.failed.action, w.failed.choice, w.failed.error);
      return next();
    }
    if (!s) return;
    if (s.kind === 'requests') {
      if (act === 'each') { w.steps = wizOneByOne(w.steps, w.at); return draw(true); }
      if (act === 'all-yes') return all(s.cards, 'yes');
      if (act === 'all-no') { w.confirm = { text: 'Close all ' + s.cards.length + ' requests? Their agents stop work on them.', act: 'all-no-ok', label: 'Close all ' + s.cards.length }; return draw(false); }
      if (act === 'all-no-ok') return all(s.cards, 'no');
      return;
    }
    var c = s.card;
    var choice = act === 'pick' ? +b.getAttribute('data-n') : null;
    var action = act === 'pick' || act === 'yes' || act === 'yes-ok' ? 'yes' : act === 'no' ? 'no' : act === 'later' ? 'later' : '';
    if (!action) return;
    // A yes that sends or publishes outside asks once more.
    if (action === 'yes' && act !== 'yes-ok' && wizOutside(c.kind)) {
      w.pending = choice;
      w.confirm = { text: 'This sends it outside. Send it now?', act: 'yes-ok', label: 'Send it' };
      return draw(false);
    }
    answer(c, action, act === 'yes-ok' ? w.pending : choice);
  }
  function onKey(ev) { if (w && ev.key === 'Escape' && !ax.open()) stop(); }
  function stop() {
    var done = w && w.done;
    w = null;
    document.removeEventListener('keydown', onKey);
    if (done) done();
  }
  window.AXDeskWizard = {
    count: function (cards) { return wizSteps(cards || []).length; },
    active: function () { return !!w; },
    // A fresh read of the board while open: what still waits.
    live: function (cards) { if (w) w.live = wizLive(cards || []); },
    start: function (panel, cards, done) {
      if (!panel._wizBound) { panel.addEventListener('click', onClick); panel._wizBound = true; }
      w = { panel: panel, steps: wizSteps(cards || []), at: 0, sent: [], live: wizLive(cards || []), done: done, busy: false, confirm: null, error: '', failed: null, progress: '', pending: null };
      document.addEventListener('keydown', onKey);
      draw(false);
      var first = panel.querySelector('.dk-wiz-step [data-wz]');
      if (first) first.focus();
    },
  };
})();
`
