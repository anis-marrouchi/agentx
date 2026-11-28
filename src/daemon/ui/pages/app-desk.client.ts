// --- Phone app: Desk tab body (#959) ---
//
// Vanilla browser JS inlined into /app (app.ts), after app-fleet.client.ts:
// it asks through that script's bottom sheet (window.AXAsk). Reads
// /api/app/desk, which works every card's column out from its source, so
// this script keeps no state of its own beyond the column on screen. Yes,
// no, a choice and "later" go to /api/app/approvals/decide; a written
// answer on a request goes to /api/app/desk/reply.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_DESK_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-desk');
  var ax = window.AXAsk;
  if (!panel || !ax) return;
  var esc = ax.esc, ago = ax.ago;
  // One card at a time (#2499 part 2), loaded just before this script.
  var wz = window.AXDeskWizard;
  var COLS = [['yours', 'Your turn'], ['agent', 'With agents'], ['quiet', 'No news'], ['done', 'Done']];
  var EMPTY = {
    yours: ['Nothing waits for you.', 'An answer an agent asks for shows here.'],
    agent: ['No agent is working on a request right now.', 'A request an agent takes on shows here.'],
    quiet: ['Nothing open has gone quiet.', 'An open request with no news shows here.'],
    done: ['Nothing ended in the last 7 days.', 'A finished request shows here for 7 days.'],
  };
  var col = 'yours';

  function pill(c) {
    if (c.column === 'yours') return '<span class="ax-af-state" data-state="waiting">Waiting</span>';
    if (c.column === 'agent') return c.live ? '<span class="ax-af-state" data-state="running">Working now</span>' : '<span class="ax-af-state">Active</span>';
    if (c.column === 'quiet') return '<span class="ax-af-state">No news</span>';
    return '';
  }
  function when(c) {
    if (c.column === 'yours') return (c.askedAt ? 'asked ' + ago(c.askedAt) : '') + (c.expires ? ' · answer by ' + new Date(c.expires).toLocaleString() : '');
    if (c.column === 'done') return c.changedAt ? 'ended ' + ago(c.changedAt) : '';
    return c.changedAt ? 'last change ' + ago(c.changedAt) : '';
  }
  function option(act, k, label, means, extra) {
    return '<button type="button" class="fx-btn dk-opt' + (extra && extra.cls ? ' ' + extra.cls : '') + '" data-act="' + act + '" data-k="' + k + '"' +
      (extra && extra.attr ? ' ' + extra.attr : '') + '>' + label + (means ? '<small>' + esc(means) + '</small>' : '') + '</button>';
  }
  function answers(c, k) {
    var h = '';
    if (c.can.answer) {
      if (c.choices) {
        var rec = ax.advised(c);
        c.choices.forEach(function (label, n) {
          h += option('pick', k, esc(label) + (n === rec ? ' <em>· suggested</em>' : ''), '', { cls: n === rec ? 'fx-primary' : '', attr: 'data-n="' + n + '"' });
        });
      } else {
        h += option('decide', k, 'Yes', c.yes, { cls: 'fx-primary', attr: 'data-v="yes"' });
      }
      h += option('decide', k, 'No', c.no, { attr: 'data-v="no"' });
    }
    if (c.can.reply) h += option('reply', k, c.column === 'yours' ? 'Write an answer' : 'Write to the agent', c.column === 'yours' ? '' : 'It gets your words and goes on.');
    if (c.can.later) h += option('decide', k, 'Later', 'Nothing is answered. It is shown again later.', { attr: 'data-v="later"' });
    return h ? '<div class="dk-answers">' + h + '</div>' : '';
  }
  function card(c, k, openKeys) {
    var key = c.node + '|' + c.key;
    return '<article class="fx-card" data-card="' + k + '"><div class="fx-row"><h4>' + esc(c.title) + '</h4>' + pill(c) + '</div>' +
      (c.ask ? '<p>' + esc(c.ask) + '</p>' : '') +
      (c.need && !c.ask ? '<p class="fx-muted">Needed from you: ' + esc(c.need) + '</p>' : '') +
      (c.said ? '<details data-key="' + esc(key + '|said') + '"' + (openKeys[key + '|said'] ? ' open' : '') + '><summary>You said</summary><p class="fx-muted" dir="auto">' + esc(c.said) + '</p></details>' : '') +
      (c.outcome ? '<p><strong>' + esc(c.outcome) + '</strong>' + (c.evidence ? ' · ' + esc(c.evidence) : '') + '</p>' : '') +
      (c.recommend ? '<p class="fx-muted">Suggested: ' + esc(c.recommend) + '</p>' : '') +
      (c.facts ? '<details data-key="' + esc(key) + '"' + (openKeys[key] ? ' open' : '') + '><summary>What is known</summary><p class="fx-muted">' + esc(c.facts) + '</p></details>' : '') +
      '<p class="fx-muted">' + [c.agent, c.nodeName, when(c)].filter(Boolean).map(esc).join(' · ') + '</p>' +
      answers(c, k) + '</article>';
  }
  function render(data) {
    // "Go through them" is open (app-desk-wizard.client.ts): it keeps the
    // panel and only learns what still waits.
    if (wz && wz.active()) { panel._data = data; wz.live(data.cards); return; }
    // Redraws every 15 seconds; keep the facts the owner opened open.
    var openKeys = {};
    panel.querySelectorAll('details[open]').forEach(function (d) { openKeys[d.getAttribute('data-key')] = true; });
    var f = data.figures;
    var steps = wz ? wz.count(data.cards) : 0;
    var html = '<div class="fx-head"><h2>Desk</h2><div class="fx-row fx-gap">' +
      (steps ? '<button type="button" class="fx-btn fx-primary" data-act="wizard">Go through them</button>' : '') +
      '<button type="button" class="fx-btn" data-act="refresh">Refresh</button></div></div>' +
      ax.statusLine(panel, data.ts) +
      '<p class="fx-muted dk-figures">Waits for you: <strong>' + f.yours.count + '</strong>' + (f.yours.oldest ? ', the oldest asked ' + esc(ago(f.yours.oldest)) : '') +
      (f.yours.later ? ' (' + f.yours.later + ' put off for later)' : '') +
      '. With agents: <strong>' + f.agent.count + '</strong>. No news: <strong>' + f.quiet.count + '</strong>' + (f.quiet.oldest ? ', the longest since ' + esc(ago(f.quiet.oldest)) : '') + '.</p>' +
      '<div class="dk-cols" role="group" aria-label="Column">' + COLS.map(function (x) {
        return '<button type="button" class="dk-col" aria-pressed="' + (x[0] === col) + '" data-act="col" data-col="' + x[0] + '">' + x[1] + ' <span class="ax-af-count"' + (x[0] === 'yours' ? ' data-tone="warn"' : '') + ' data-n="' + f[x[0]].count + '">' + f[x[0]].count + '</span></button>';
      }).join('') + '</div>';
    data.errors.forEach(function (e) { html += '<p class="fx-muted fx-bad">' + esc(e) + '</p>'; });
    var shown = 0;
    data.cards.forEach(function (c, k) {
      if (c.column !== col) return;
      html += card(c, k, openKeys);
      shown++;
    });
    if (!shown) html += '<div class="ax-af-empty"><strong>' + EMPTY[col][0] + '</strong>' + EMPTY[col][1] + '<button type="button" class="fx-btn" data-act="refresh">Refresh</button></div>';
    panel.innerHTML = html;
    panel._data = data;
  }

  function decide(c, v, n) {
    var word = { yes: 'Yes', no: 'No', later: 'Later' }[v];
    var pick = n != null ? { choices: c.choices, draft: c.draft, rec: ax.advised(c), sel: n } : null;
    ax.ask({ panel: panel, refresh: refresh, pick: pick, danger: v === 'no',
      title: pick ? c.title : word + ': ' + c.title + '?', ok: pick ? 'Choose' : word,
      text: pick ? (c.ask || '') : v === 'yes' ? (c.yes || '') : v === 'no' ? (c.no || '') : 'Nothing is answered. It is shown again later.',
      path: '/api/app/approvals/decide',
      body: function (text, choice) {
        var b = { node: c.node, key: c.key, action: v };
        if (choice) { b.choice = choice; if (c.draft && text) b.text = text; }
        // A content draft: the post shown, so a changed one is not published.
        if (v === 'yes' && c.textHash) b.seen = c.textHash;
        return b;
      },
      done: function () { return v === 'later' ? 'Put off: ' + c.title + '.' : 'Answered ' + (pick ? '' : word + ': ') + c.title + '.'; } });
  }
  function reply(c, voice) {
    ax.ask({ panel: panel, refresh: refresh, input: true, ok: 'Send', mic: true, voice: !!voice,
      title: (c.column === 'yours' ? 'Answer ' : 'Write to ') + (c.agent || 'the agent'),
      text: c.ask || c.title,
      path: '/api/app/desk/reply',
      body: function (text) { return { id: c.key.slice(c.key.indexOf(':') + 1), text: text }; },
      done: function (b) { return b.message || 'Sent.'; } });
  }
  panel.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'refresh') return refresh();
    if (act === 'col') { col = b.getAttribute('data-col'); if (panel._data) render(panel._data); return; }
    if (act === 'wizard') {
      // At the end (or Stop) the Desk is drawn again and read afresh.
      if (panel._data) wz.start(panel, panel._data.cards, function () { col = 'yours'; render(panel._data); refresh(); });
      return;
    }
    var c = panel._data.cards[+b.getAttribute('data-k')];
    if (act === 'pick') decide(c, 'yes', +b.getAttribute('data-n'));
    if (act === 'decide') decide(c, b.getAttribute('data-v'));
    if (act === 'reply') reply(c);
  });

  var loading = false, again = 0;
  function refresh() {
    // Never redraw under an open sheet or a finger pulling the next tab in.
    if (loading || ax.open() || panel.hidden || document.visibilityState !== 'visible') return;
    if (document.querySelector('main.sw-on')) { clearTimeout(again); again = setTimeout(refresh, 300); return; }
    loading = true;
    ax.api('GET', '/api/app/desk').then(render).then(openWanted)
      .catch(function (e) { ax.flash(panel, 'Could not load the desk: ' + e.message, true); })
      .then(function () { loading = false; });
  }

  // A notification opens /app#desk=<key>, with &voice=1 from "Reply by
  // voice" (#2103): that card, in its column, and its answer box with the
  // mic ready. Read once, then the hash goes back to #desk.
  var wanted = null;
  function fromHash() {
    var t = parseOpenHash(location.hash);
    if (!t || t.tab !== 'desk') return;
    wanted = t;
    try { history.replaceState(null, '', '#desk'); } catch (e) {}
    // A load already on its way opens it when it lands.
    refresh();
  }
  function openWanted() {
    var t = wanted;
    if (!t || !panel._data) return;
    wanted = null;
    var k = -1;
    panel._data.cards.forEach(function (c, n) { if (k < 0 && c.key === t.id && (c.can.reply || !t.voice)) k = n; });
    if (k < 0) panel._data.cards.forEach(function (c, n) { if (k < 0 && c.key === t.id) k = n; });
    if (k < 0) { ax.flash(panel, 'That item is no longer waiting for you.', false); return; }
    var c = panel._data.cards[k];
    if (c.column !== col) { col = c.column; render(panel._data); }
    var art = panel.querySelector('article[data-card="' + k + '"]');
    if (art) { art.scrollIntoView({ block: 'center' }); art.classList.add('dk-wanted'); }
    if (!t.voice) return;
    // Written answers go only to this node's requests: a card from another
    // node keeps its own buttons and says where to write.
    if (c.can.reply) reply(c, true);
    else ax.flash(panel, c.can.answer ? 'Answer this card with its buttons. Written answers for it go on ' + (c.nodeName || 'its computer') + '.' : 'This item takes no written answer here.', false);
  }
  window.addEventListener('hashchange', fromHash);
  if (!panel.querySelector('.fx-status')) panel.insertAdjacentHTML('beforeend', '<p class="fx-status" role="status" aria-live="polite"></p>');
  document.addEventListener('ax-tab', function () { setTimeout(refresh, 0); });
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  setInterval(refresh, 15000);
  if (parseOpenHash(location.hash)) fromHash();
  else refresh();
})();
`
