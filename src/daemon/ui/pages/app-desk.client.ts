// --- Phone app: the Desk tab body (#959) ---
//
// Vanilla browser JS inlined into /app (app.ts). Reads /api/app/desk and
// acts through /api/app/desk/act (app-desk.ts). One column on screen at a
// time, "Your turn" first, with the column switch kept in view; the other
// views group the same cards by agent or by day. Every action asks first
// in a bottom sheet that says exactly what it will do.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_DESK_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-desk');
  if (!panel) return;
  var COLS = [
    { id: 'yours', label: 'Your turn', empty: 'Nothing waits for you.' },
    { id: 'agent', label: 'With an agent', empty: 'No agent is working on anything of yours right now.' },
    { id: 'quiet', label: 'No news', empty: 'Nothing has gone quiet.' },
    { id: 'done', label: 'Done', empty: 'Nothing finished in the last 7 days.' },
  ];
  var VIEWS = [
    { id: 'next', label: 'Who acts next' },
    { id: 'agent', label: 'By agent' },
    { id: 'day', label: 'By day' },
  ];
  function load(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var state = { col: load('ax-desk-col', 'yours'), view: load('ax-desk-view', 'next'), data: null, msg: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function age(iso) {
    if (!iso) return '';
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    return Math.round(s / 86400) + ' d';
  }
  function ago(iso) { var a = age(iso); return a === 'just now' ? a : a + ' ago'; }
  function when(iso) {
    try { return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; }
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('not paired'); }
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status));
        return b;
      });
    });
  }

  // The bottom sheet every action goes through.
  var sheet = document.createElement('dialog');
  sheet.className = 'fx-sheet';
  sheet.setAttribute('aria-labelledby', 'dk-title');
  sheet.innerHTML = '<form method="dialog"><h3 id="dk-title"></h3><p id="dk-text"></p>' +
    '<label id="dk-field" hidden><span id="dk-field-label">Your answer</span><textarea id="dk-input" rows="4"></textarea></label>' +
    '<div class="fx-actions"><button value="cancel" class="fx-btn" formnovalidate>Cancel</button>' +
    '<button value="ok" id="dk-ok" class="fx-btn fx-primary">OK</button></div></form>';
  document.body.appendChild(sheet);
  window.AXSheet(sheet);
  var pending = null;
  var input = document.getElementById('dk-input');

  function ask(opts) {
    document.getElementById('dk-title').textContent = opts.title;
    document.getElementById('dk-text').textContent = opts.text || '';
    var ok = document.getElementById('dk-ok');
    ok.textContent = opts.ok;
    ok.className = 'fx-btn ' + (opts.danger ? 'fx-danger' : 'fx-primary');
    var field = document.getElementById('dk-field');
    field.hidden = !opts.field;
    if (opts.field) {
      document.getElementById('dk-field-label').textContent = opts.field.label;
      input.value = opts.field.value || '';
      input.required = !!opts.field.required;
    } else input.required = false;
    pending = opts;
    if (sheet.showModal) { sheet.showModal(); if (opts.field && opts.field.required) input.focus(); }
    else if (window.confirm(opts.title)) run(opts, opts.field ? (window.prompt(opts.field.label, opts.field.value || '') || '') : '');
  }
  sheet.addEventListener('close', function () {
    var opts = pending;
    pending = null;
    if (!opts || sheet.returnValue !== 'ok') return;
    run(opts, input.value.trim());
  });
  function run(opts, text) {
    if (opts.field && opts.field.required && !text) { flash('Nothing sent: write something first.', true); return; }
    var body = { node: opts.card.node, key: opts.card.key, action: opts.action };
    if (opts.option) body.option = opts.option;
    if (text) body.text = text;
    if (opts.action === 'call' && opts.card.source.kind === 'task') body.agent = opts.card.agent;
    api('POST', '/api/app/desk/act', body).then(function (b) {
      flash(b.message || 'Done.', false);
      refresh(true);
    }).catch(function (e) { flash('Not passed on: ' + e.message, true); });
  }
  function flash(text, bad) {
    state.msg = { text: text, bad: bad, at: Date.now() };
    var el = panel.querySelector('.fx-status');
    if (el) { el.textContent = text; el.className = 'fx-status' + (bad ? ' fx-bad' : ''); }
  }
  function statusLine(ts) {
    var m = state.msg;
    if (m && Date.now() - m.at < 10000) return '<p class="fx-status' + (m.bad ? ' fx-bad' : '') + '" role="status" aria-live="polite">' + esc(m.text) + '</p>';
    return '<p class="fx-status" role="status" aria-live="polite">Updated ' + esc(new Date(ts).toLocaleTimeString()) + '</p>';
  }

  function pill(c) {
    if (c.outcome) return '<span class="fx-pill ' + (c.outcome.word === 'done' || c.outcome.word === 'yes' ? 'fx-on' : 'dk-plain') + '">' + esc(c.outcome.word) + '</span>';
    if (c.staleSince) return '<span class="fx-pill dk-plain">Not read since ' + esc(age(c.staleSince)) + '</span>';
    if (c.deferredUntil) return '<span class="fx-pill dk-plain">Later: ' + esc(when(c.deferredUntil)) + '</span>';
    if (c.column === 'yours') return '<span class="fx-pill fx-warn">' + (c.attention ? 'Needs you' : 'Your turn') + '</span>';
    if (c.column === 'agent') return '<span class="fx-pill dk-agent">Working</span>';
    if (c.column === 'quiet') return '<span class="fx-pill dk-plain">No news ' + esc(age(c.changedAt)) + '</span>';
    return '';
  }
  function card(c, i) {
    var h = '<article class="fx-card dk-card dk-col-' + c.column + '"><div class="fx-row"><h4>' + esc(c.title) + '</h4>' + pill(c) + '</div>';
    if (c.ask) h += '<p class="dk-ask">' + esc(c.ask) + '</p>';
    if (c.recommend) h += '<p class="fx-muted">Suggested: ' + esc(c.recommend) + '</p>';
    if (c.progress) h += '<p class="fx-muted">' + esc(c.progress) + '</p>';
    if (c.facts) h += '<details class="dk-facts"><summary>Facts</summary><p>' + esc(c.facts) + '</p></details>';
    if (c.outcome && c.outcome.detail) h += '<p class="fx-muted">' + esc(c.outcome.detail) + '</p>';
    if (c.actions.indexOf('answer') >= 0 && c.options.length) {
      h += '<div class="dk-options">';
      c.options.forEach(function (o, j) {
        h += '<button type="button" class="dk-opt' + (o.id === 'no' ? ' dk-no' : '') + '" data-act="answer" data-i="' + i + '" data-j="' + j + '"><strong>' + esc(o.label) + '</strong><span>' + esc(o.means) + '</span></button>';
      });
      h += '</div>';
    }
    var acts = [];
    if (c.actions.indexOf('write') >= 0) acts.push('<button type="button" class="fx-btn" data-act="write" data-i="' + i + '">Write an answer</button>');
    if (c.actions.indexOf('defer') >= 0 && !c.deferredUntil) acts.push('<button type="button" class="fx-btn" data-act="defer" data-i="' + i + '">Later</button>');
    if (c.actions.indexOf('call') >= 0 && c.agent) acts.push('<button type="button" class="fx-btn" data-act="call" data-i="' + i + '">Call ' + esc(c.agent) + '</button>');
    if (acts.length) h += '<div class="fx-row fx-gap">' + acts.join('') + '</div>';
    var meta = [c.agent, c.nodeName, (c.column === 'yours' ? 'asked ' + ago(c.askedAt) : 'changed ' + ago(c.changedAt))];
    if (c.expiresAt && c.column === 'yours') meta.push('decides itself ' + when(c.expiresAt));
    h += '<p class="fx-muted dk-meta">' + meta.filter(Boolean).map(esc).join(' · ') + '</p></article>';
    return h;
  }

  function figures(f) {
    function tile(label, n, oldest) {
      return '<div class="dk-fig"><span class="dk-n">' + n + '</span><span class="dk-l">' + esc(label) + '</span>' +
        (oldest ? '<span class="dk-o">oldest ' + esc(age(oldest.since)) + '</span>' : '') + '</div>';
    }
    var h = '<div class="dk-figs" role="group" aria-label="Figures">' + tile('wait for you', f.yours.count, f.yours.oldest) +
      tile('with agents', f.agent.count) + tile('stuck', f.stuck.count, f.stuck.oldest) + '</div>';
    var blockers = [];
    if (f.yours.oldest) blockers.push('Waiting longest for you: ' + esc(f.yours.oldest.title));
    if (f.stuck.oldest) blockers.push('Stuck longest: ' + esc(f.stuck.oldest.title));
    if (blockers.length) h += '<p class="fx-muted dk-blockers">' + blockers.join('<br>') + '</p>';
    return h;
  }

  function render() {
    var d = state.data;
    if (!d) return;
    var openKeys = {};
    panel.querySelectorAll('details[open]').forEach(function (x) { openKeys[x.getAttribute('data-key') || ''] = true; });
    var h = '<div class="fx-head"><h2>Desk</h2><button type="button" class="fx-btn" data-act="refresh">Refresh</button></div>' + statusLine(d.ts) + figures(d.figures);
    h += '<label class="dk-view"><span>View</span><select id="dk-view">' + VIEWS.map(function (v) {
      return '<option value="' + v.id + '"' + (v.id === state.view ? ' selected' : '') + '>' + esc(v.label) + '</option>';
    }).join('') + '</select></label>';
    var cards = d.cards;
    if (state.view === 'next') {
      h += '<div class="dk-cols" role="tablist" aria-label="Columns">' + COLS.map(function (c) {
        var n = cards.filter(function (x) { return x.column === c.id && !(c.id === 'yours' && x.deferredUntil); }).length;
        var on = c.id === state.col;
        return '<button type="button" role="tab" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-col="' + c.id + '">' + esc(c.label) + ' <span class="dk-count">' + n + '</span></button>';
      }).join('') + '</div>';
      var col = COLS.filter(function (c) { return c.id === state.col; })[0] || COLS[0];
      var here = [], later = [];
      cards.forEach(function (c, i) { if (c.column === col.id) (c.deferredUntil ? later : here).push(card(c, i)); });
      h += '<div role="tabpanel" aria-label="' + esc(col.label) + '">' + (here.length ? here.join('') : '<p class="fx-muted">' + esc(col.empty) + '</p>');
      if (later.length) h += '<details data-key="later"' + (openKeys.later ? ' open' : '') + '><summary>Later: ' + later.length + '</summary>' + later.join('') + '</details>';
      h += '</div>';
    } else {
      var groups = {}, order = [];
      cards.forEach(function (c, i) {
        var g = state.view === 'agent' ? (c.agent || 'No agent') : new Date(c.changedAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push({ c: c, i: i });
      });
      if (state.view === 'agent') order.sort();
      else order.sort(function (a, b) { return Date.parse(groups[b][0].c.changedAt) - Date.parse(groups[a][0].c.changedAt); });
      if (!order.length) h += '<p class="fx-muted">Nothing on the desk.</p>';
      order.forEach(function (g) {
        var list = groups[g];
        if (state.view === 'day') list.sort(function (a, b) { return Date.parse(b.c.changedAt) - Date.parse(a.c.changedAt); });
        var mine = list.filter(function (x) { return x.c.column === 'yours'; }).length;
        h += '<h3 class="fx-sub">' + esc(g) + ' <span class="dk-count">' + list.length + '</span>' + (mine ? ' <span class="fx-pill fx-warn">' + mine + ' for you</span>' : '') + '</h3>';
        h += list.map(function (x) { return card(x.c, x.i); }).join('');
      });
    }
    d.errors.forEach(function (e) { h += '<p class="fx-muted fx-bad">' + esc(e.nodeName) + ': ' + esc(e.error) + '. The rest of the desk still works.</p>'; });
    panel.innerHTML = h;
  }

  panel.addEventListener('change', function (ev) {
    if (ev.target.id !== 'dk-view') return;
    state.view = ev.target.value; save('ax-desk-view', state.view); render();
    var v = document.getElementById('dk-view'); if (v) v.focus();
  });
  panel.addEventListener('keydown', function (ev) {
    var t = ev.target.closest('.dk-cols [role=tab]');
    if (!t) return;
    var i = COLS.map(function (c) { return c.id; }).indexOf(t.getAttribute('data-col')), n = -1;
    if (ev.key === 'ArrowRight') n = (i + 1) % COLS.length;
    else if (ev.key === 'ArrowLeft') n = (i - 1 + COLS.length) % COLS.length;
    if (n < 0) return;
    ev.preventDefault(); ev.stopPropagation();
    pickCol(COLS[n].id, true);
  });
  function pickCol(id, focus) {
    state.col = id; save('ax-desk-col', id); render();
    if (focus) { var b = panel.querySelector('.dk-cols [data-col=' + id + ']'); if (b) b.focus(); }
  }
  panel.addEventListener('click', function (ev) {
    var colBtn = ev.target.closest('[data-col]');
    if (colBtn) return pickCol(colBtn.getAttribute('data-col'), false);
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'refresh') return refresh(true);
    var c = state.data.cards[+b.getAttribute('data-i')];
    if (!c) return;
    if (act === 'answer') {
      var o = c.options[+b.getAttribute('data-j')];
      var draft = c.text && c.text.draft && o.id !== 'no' ? c.text.draft.split('{choice}').join(o.label) : '';
      ask({ card: c, action: 'answer', option: o.id, title: o.label + ': ' + c.title, text: o.means, ok: 'Answer ' + o.label, danger: o.id === 'no',
        field: { label: draft ? c.text.hint : (c.text ? c.text.hint : 'Words for the agent (optional)'), value: draft } });
    } else if (act === 'write') {
      ask({ card: c, action: 'write', title: 'Write to ' + (c.agent || 'the agent'), text: c.text ? c.text.hint : '', ok: 'Send',
        field: { label: 'Your answer', required: true } });
    } else if (act === 'defer') {
      ask({ card: c, action: 'defer', title: 'Later: ' + c.title, ok: 'Put off',
        text: 'It comes back after the time set for Later in the approvals settings (a day by default). Nothing is answered.' + (c.expiresAt ? ' It still decides itself ' + when(c.expiresAt) + '.' : '') });
    } else if (act === 'call') {
      ask({ card: c, action: 'call', title: 'Call ' + c.agent + '?', ok: 'Call',
        text: c.agent + ' calls you about this card on AgentX Voice. Nothing on the card is answered. Its calls permission, hourly limit and Focus apply.' });
    }
  });

  var loading = false, again = 0;
  function refresh(force) {
    if (loading || sheet.open) return;
    if (!force && (panel.hidden || document.visibilityState !== 'visible')) return;
    if (document.querySelector('main.sw-on')) { clearTimeout(again); again = setTimeout(function () { refresh(force); }, 300); return; }
    loading = true;
    api('GET', '/api/app/desk').then(function (d) { state.data = d; render(); })
      .catch(function (e) { if (state.data) flash('Could not load the desk: ' + e.message, true); else panel.innerHTML = '<h2>Desk</h2><p class="fx-status fx-bad" role="status">Could not load the desk: ' + esc(e.message) + '</p>'; })
      .then(function () { loading = false; });
  }
  document.addEventListener('ax-tab', function () { setTimeout(function () { refresh(false); }, 0); });
  document.addEventListener('visibilitychange', function () { refresh(false); });
  window.addEventListener('online', function () { refresh(false); });
  setInterval(function () { refresh(false); }, 15000);
  refresh(false);
})();
`
