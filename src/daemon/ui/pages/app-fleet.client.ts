// --- Phone app: Fleet and Activity tab bodies ---
//
// Vanilla browser JS inlined into /app (app.ts). Reads /api/app/fleet,
// /api/app/activity, /api/app/approvals and /api/app/workflows (the
// progress widget's rows, #796); acts through the POST routes in
// app-fleet.ts and workflow-widget-api.ts. Every action asks first in a bottom sheet, because on a phone
// a mis-tap should never restart a machine.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_FLEET_SCRIPT = `
(function () {
  var fleetPanel = document.getElementById('panel-fleet');
  var activityPanel = document.getElementById('panel-activity');
  if (!fleetPanel || !activityPanel) return;
  var tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) {}

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ago(iso) {
    if (!iso) return '';
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function uptime(sec) {
    if (sec == null) return '';
    if (sec < 3600) return 'up ' + Math.round(sec / 60) + ' min';
    if (sec < 86400) return 'up ' + Math.round(sec / 3600) + ' h';
    return 'up ' + Math.round(sec / 86400) + ' d';
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

  // One shared bottom sheet for every confirmation and the follow-up box.
  var sheet = document.createElement('dialog');
  sheet.className = 'fx-sheet';
  sheet.setAttribute('aria-labelledby', 'fx-title');
  sheet.innerHTML = '<form method="dialog"><h3 id="fx-title"></h3><p id="fx-text"></p>' +
    '<fieldset id="fx-choices" class="fx-choices" hidden></fieldset>' +
    '<label id="fx-field" hidden><span id="fx-field-label">Message</span><textarea id="fx-input" rows="3"></textarea></label>' +
    '<p id="fx-error" class="fx-error" role="alert"></p>' +
    '<div class="fx-actions"><button value="cancel" class="fx-btn" formnovalidate>Cancel</button>' +
    '<button value="ok" id="fx-ok" class="fx-btn fx-primary">OK</button></div></form>';
  document.body.appendChild(sheet);
  window.AXSheet(sheet);
  var pending = null;
  // The choice a card's advice names: it starts the line, followed by its
  // end or a separator (same rule as the Mac card, approvals/card-page.ts).
  function advised(it) {
    var rec = String(it.recommend || '').trim(), low = rec.toLowerCase(), best = -1;
    (it.choices || []).forEach(function (c, n) {
      if (low.indexOf(c.toLowerCase()) !== 0) return;
      var r = rec.slice(c.length).replace(/^ +/, '');
      if (r && !(':,.;–—-'.indexOf(r.charAt(0)) >= 0 && (r.length === 1 || r.charAt(1) === ' '))) return;
      if (best < 0 || c.length > it.choices[best].length) best = n;
    });
    return best;
  }
  function fill(draft, label) { return label ? String(draft).split('{choice}').join(label) : String(draft || ''); }
  // opts.pick: { choices, draft, rec } for a card that offers choices. The
  // radios are required, so OK does nothing until one is picked; Cancel
  // skips the check (formnovalidate).
  function ask(opts) {
    document.getElementById('fx-title').textContent = opts.title;
    document.getElementById('fx-text').textContent = opts.text || '';
    document.getElementById('fx-ok').textContent = opts.ok || 'OK';
    document.getElementById('fx-ok').className = 'fx-btn ' + (opts.danger ? 'fx-danger' : 'fx-primary');
    document.getElementById('fx-error').textContent = '';
    var field = document.getElementById('fx-field');
    var input = document.getElementById('fx-input');
    var box = document.getElementById('fx-choices');
    var p = opts.pick;
    box.hidden = !p;
    box.innerHTML = p ? '<legend>Pick one</legend>' + p.choices.map(function (c, n) {
      return '<label class="fx-opt"><input type="radio" name="fx-choice" required value="' + (n + 1) + '"' + (n === p.rec ? ' checked' : '') + '><span>' + esc(c) + (n === p.rec ? ' <em>suggested</em>' : '') + '</span></label>';
    }).join('') : '';
    field.hidden = !opts.input && !(p && p.draft);
    document.getElementById('fx-field-label').textContent = p && p.draft ? 'Message the agent gets (you can edit it)' : 'Message';
    input.rows = p && p.draft ? 6 : 3;
    input.value = p && p.draft ? fill(p.draft, p.rec >= 0 ? p.choices[p.rec] : '') : '';
    delete input.dataset.edited;
    pending = opts;
    if (sheet.showModal) { sheet.showModal(); if (opts.input) input.focus(); }
    else if (p) flash(opts.panel, 'This card offers choices: answer it on the dashboard.', true);
    else if (window.confirm(opts.title)) run(opts, opts.input ? window.prompt('Message') || '' : '');
  }
  sheet.addEventListener('change', function (ev) {
    var t = ev.target, p = pending && pending.pick, input = document.getElementById('fx-input');
    if (!p || t.name !== 'fx-choice' || !p.draft || input.dataset.edited) return;
    input.value = fill(p.draft, p.choices[+t.value - 1]);
  });
  document.getElementById('fx-input').addEventListener('input', function (ev) { ev.target.dataset.edited = '1'; });
  sheet.addEventListener('close', function () {
    var opts = pending;
    pending = null;
    if (!opts || sheet.returnValue !== 'ok') return;
    var picked = sheet.querySelector('input[name=fx-choice]:checked');
    if (opts.pick && !picked) { flash(opts.panel, 'Nothing answered: pick one of the choices.', true); return; }
    run(opts, document.getElementById('fx-input').value.trim(), picked ? +picked.value : undefined);
  });
  function run(opts, text, choice) {
    if (opts.input && !text) { flash(opts.panel, 'Nothing sent: the message was empty.', true); return; }
    api('POST', opts.path, opts.body(text, choice)).then(function (b) {
      flash(opts.panel, opts.done(b), false);
      refresh();
    }).catch(function (e) { flash(opts.panel, opts.title + ' failed: ' + e.message, true); });
  }
  // The refresh that follows an action re-renders the panel, so the last
  // result is kept on the panel and shown again for a few seconds.
  function flash(panel, msg, bad) {
    panel._msg = { text: msg, bad: bad, at: Date.now() };
    var el = panel.querySelector('.fx-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'fx-status' + (bad ? ' fx-bad' : '');
  }
  function statusLine(panel, ts) {
    var m = panel._msg;
    if (m && Date.now() - m.at < 10000) return '<p class="fx-status' + (m.bad ? ' fx-bad' : '') + '" role="status" aria-live="polite">' + esc(m.text) + '</p>';
    return '<p class="fx-status" role="status" aria-live="polite">Updated ' + esc(new Date(ts).toLocaleTimeString()) + '</p>';
  }

  function statusPill(n) {
    if (!n.reachable) return '<span class="fx-pill fx-off"><span aria-hidden="true">⊘ </span>Offline</span>';
    if (n.restart) return '<span class="fx-pill fx-warn">Restart ' + esc(n.restart.state) + '</span>';
    return '<span class="fx-pill fx-on"><span aria-hidden="true">● </span>Online</span>';
  }
  function renderFleet(data) {
    // Redraws every 15 seconds; keep the sections the user opened open.
    var openKeys = {};
    fleetPanel.querySelectorAll('details[open]').forEach(function (d) { openKeys[d.getAttribute('data-key')] = true; });
    var html = '<div class="fx-head"><h2>Fleet</h2><button type="button" class="fx-btn" data-act="refresh">Refresh</button></div>' +
      statusLine(fleetPanel, data.ts);
    if (!data.nodes.length) html += '<p class="soon">No machines found.</p>';
    data.nodes.forEach(function (n, i) {
      var running = n.agents.reduce(function (sum, a) { return sum + (a.active || 0); }, 0);
      html += '<article class="fx-card' + (n.reachable ? '' : ' fx-offline') + '"><div class="fx-row"><h3 class="fx-machine"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v12H4zM2 20h20' + (n.reachable ? '' : 'M2 2l20 20') + '"/></svg>' + esc(n.name) + '</h3>' + statusPill(n) + '</div>';
      if (!n.reachable) {
        html += '<p class="fx-muted">Not reachable' + (n.error ? ': ' + esc(n.error) : '') + '. The rest of the fleet still works.</p></article>';
        return;
      }
      html += '<p class="fx-muted">' + esc(uptime(n.uptimeSec)) + ' · ' + plural(n.agents.length, 'agent') + ' · ' + running + ' running · schedules today: ' +
        n.crons.today.success + ' ok, ' + n.crons.today.failed + ' failed</p>';
      html += '<ul class="fx-list fx-agents">';
      n.agents.forEach(function (a) {
        html += '<li><div class="fx-row"><strong>' + esc(a.name) + '</strong><span class="fx-muted">' +
          (a.active ? a.active + ' running' : (a.lastActive ? ago(a.lastActive) : 'idle')) + (a.errors ? ' · ' + a.errors + ' errors' : '') + '</span></div>' +
          (a.last ? '<p class="fx-muted' + (a.last.ok ? '' : ' fx-bad') + '">' + esc(a.last.text) + '</p>' : '') + '</li>';
      });
      html += '</ul><details data-key="' + esc(n.url) + '|crons"' + (openKeys[n.url + '|crons'] ? ' open' : '') + '><summary>Schedules (' + n.crons.items.length + ')</summary><ul class="fx-list">';
      n.crons.items.forEach(function (c, j) {
        var last = c.last ? '<span class="fx-pill ' + (c.last.status === 'success' ? 'fx-on' : 'fx-off') + '">' + esc(c.last.status) + '</span>' : '';
        html += '<li><div class="fx-row"><strong>' + esc(c.id) + '</strong>' +
          '<button type="button" class="fx-switch" role="switch" aria-checked="' + c.enabled + '" aria-label="' + (c.enabled ? 'Turn off ' : 'Turn on ') + esc(c.id) +
          '" data-act="cron" data-i="' + i + '" data-j="' + j + '"><span></span></button></div>' +
          '<p class="fx-muted">' + esc(c.schedule) + ' · ' + esc(c.agent) + (c.consecutiveErrors ? ' · failed ' + c.consecutiveErrors + ' times in a row' : '') + ' ' + last + '</p>' +
          (c.last && c.last.text ? '<p class="fx-muted">' + esc(c.last.text) + '</p>' : '') + '</li>';
      });
      html += '</ul></details>';
      html += '<details data-key="' + esc(n.url) + '|manage"' + (openKeys[n.url + '|manage'] ? ' open' : '') + '><summary>Manage computer</summary><div class="fx-row fx-gap"><button type="button" class="fx-btn" data-act="reload" data-i="' + i + '">Reload config</button>' +
        (n.restart ? '<button type="button" class="fx-btn" data-act="unrestart" data-i="' + i + '">Cancel restart</button>'
          : '<button type="button" class="fx-btn fx-danger-o" data-act="restart" data-i="' + i + '">Restart when idle</button>') + '</div></details>';
      html += '</article>';
    });
    fleetPanel.innerHTML = html;
    fleetPanel._data = data;
  }

  // Followed workflows (#796): the same rows as the desktop widget.
  function workflowsHtml(wf) {
    if (!wf || !wf.enabled) return '';
    var html = '<h3 class="fx-sub">Workflows (' + wf.rows.length + ')</h3>';
    if (!wf.rows.length) return html + '<p class="fx-muted">Nothing is being followed right now.</p>';
    wf.rows.forEach(function (r, k) {
      var you = r.state === 'waiting-on-you' || r.state === 'blocked';
      var pill = { 'waiting-on-you': 'Needs you', blocked: 'Blocked', running: 'Running' }[r.state] || 'Waiting';
      html += '<article class="fx-card"><div class="fx-row"><h4>' + esc(r.title) + '</h4><span class="fx-pill' + (you ? ' fx-warn' : '') + '">' + esc(pill) + '</span></div>' +
        '<p>Step ' + esc(r.step) + ' · ' + esc(r.owner === 'you' ? 'waiting on you' : r.owner) + '</p>' +
        '<p class="fx-muted">' + esc(r.waitingOn) + '</p>' +
        '<p class="fx-muted">' + esc(ago(r.since)) + (r.tags.length ? ' · ' + esc(r.tags.join(', ')) : '') + ' · ' + esc(r.nodeName) + '</p>';
      if (r.answer && r.answer.kind === 'card') {
        html += '<div class="fx-row fx-gap"><button type="button" class="fx-btn fx-primary" data-act="wf" data-k="' + k + '" data-v="yes">Yes</button>' +
          '<button type="button" class="fx-btn" data-act="wf" data-k="' + k + '" data-v="no">No</button></div>';
      } else if (r.answer && r.answer.kind === 'reply') {
        html += '<div class="fx-row fx-gap"><button type="button" class="fx-btn fx-primary" data-act="wf" data-k="' + k + '" data-v="reply">Answer ' + esc(r.answer.agentId) + '</button></div>';
      }
      html += '</article>';
    });
    if (wf.unreachable && wf.unreachable.length) html += '<p class="fx-muted fx-bad">' + plural(wf.unreachable.length, 'node') + ' could not be read.</p>';
    return html;
  }

  function renderActivity(act, appr, wf) {
    var html = '<div class="fx-head"><h2>Activity</h2><button type="button" class="fx-btn" data-act="refresh">Refresh</button></div>' +
      statusLine(activityPanel, act.ts);
    var items = [];
    appr.nodes.forEach(function (n) { n.items.forEach(function (it) { items.push({ node: n, it: it }); }); });
    html += '<h3 class="fx-sub">Needs you (' + items.length + ')</h3>';
    if (!items.length) html += '<p class="fx-muted">Nothing is waiting for a decision.</p>';
    items.forEach(function (x, k) {
      html += '<article class="fx-card"><div class="fx-row"><h4>' + esc(x.it.title) + '</h4><span class="fx-pill fx-warn">Ⅱ Waiting</span></div><p>' + esc(x.it.ask) + '</p>' +
        (x.it.recommend ? '<p class="fx-muted">Suggested: ' + esc(x.it.recommend) + '</p>' : '') +
        '<p class="fx-muted">' + esc(x.it.raisedBy || '') + ' · ' + esc(x.node.nodeName) + '</p>' +
        (x.it.choices ? '<p class="fx-muted">' + plural(x.it.choices.length, 'choice') + ' on offer</p>' : '') +
        '<div class="fx-row fx-gap"><button type="button" class="fx-btn fx-primary" data-act="decide" data-k="' + k + '" data-v="yes">' + (x.it.choices ? 'Choose…' : 'Yes') + '</button>' +
        '<button type="button" class="fx-btn" data-act="decide" data-k="' + k + '" data-v="no">No</button>' +
        '<button type="button" class="fx-btn" data-act="decide" data-k="' + k + '" data-v="later">Later</button></div></article>';
    });
    appr.nodes.forEach(function (n) { if (n.error) html += '<p class="fx-muted fx-bad">Approvals on ' + esc(n.nodeName) + ' could not be read: ' + esc(n.error) + '</p>'; });
    html += workflowsHtml(wf);
    html += '<h3 class="fx-sub">Running now (' + act.tasks.length + ')</h3>';
    if (!act.tasks.length) html += '<p class="fx-muted">No agent is working right now.</p>';
    act.tasks.forEach(function (t, k) {
      html += '<article class="fx-card"><div class="fx-row"><h4>' + esc(t.agentName) + '</h4><span class="fx-muted">' + esc(ago(t.startedAt)) + '</span></div><p class="fx-working"><span aria-hidden="true">◔</span> Working</p>' +
        '<p>' + esc(t.preview) + '</p><p class="fx-muted">' + esc(t.nodeName) + ' · ' + esc(t.channel) + '</p>' +
        '<div class="fx-row fx-gap"><button type="button" class="fx-btn" data-act="followup" data-k="' + k + '">Follow up</button>' +
        '<button type="button" class="fx-btn fx-danger-o" data-act="cancel" data-k="' + k + '">Stop</button></div></article>';
    });
    activityPanel.innerHTML = html;
    activityPanel._act = act;
    activityPanel._items = items;
    activityPanel._wf = wf && wf.rows ? wf.rows : [];
  }

  fleetPanel.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'refresh') return refresh();
    var n = fleetPanel._data.nodes[+b.getAttribute('data-i')];
    if (act === 'reload') ask({ panel: fleetPanel, title: 'Reload config on ' + n.name + '?', text: 'Re-reads agentx.json. Running work continues.', ok: 'Reload',
      path: '/api/app/nodes/reload', body: function () { return { node: n.url }; }, done: function () { return n.name + ' reloaded its config.'; } });
    if (act === 'restart') ask({ panel: fleetPanel, title: 'Restart ' + n.name + '?', danger: true, ok: 'Restart when idle',
      text: 'It restarts as soon as no agent is working' + (n.inflight ? ' (' + n.inflight + ' tasks running now)' : '') + '. Agents on it are unavailable for a moment.',
      path: '/api/app/nodes/restart', body: function () { return { node: n.url }; }, done: function () { return n.name + ' will restart when idle.'; } });
    if (act === 'unrestart') ask({ panel: fleetPanel, title: 'Cancel the restart of ' + n.name + '?', ok: 'Cancel restart',
      path: '/api/app/nodes/restart', body: function () { return { node: n.url, cancel: true }; }, done: function () { return 'Restart cancelled.'; } });
    if (act === 'cron') {
      var c = n.crons.items[+b.getAttribute('data-j')];
      var on = !c.enabled;
      ask({ panel: fleetPanel, title: (on ? 'Turn on ' : 'Turn off ') + c.id + '?', ok: on ? 'Turn on' : 'Turn off', danger: !on,
        text: on ? 'It runs again on its schedule (' + c.schedule + ').' : 'It stops running until you turn it on again.',
        path: '/api/app/crons/toggle', body: function () { return { node: n.url, cronId: c.id, enabled: on }; },
        done: function () { return c.id + (on ? ' is on.' : ' is off.'); } });
    }
  });

  activityPanel.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'refresh') return refresh();
    var k = +b.getAttribute('data-k');
    if (act === 'decide') {
      var x = activityPanel._items[k];
      var v = b.getAttribute('data-v');
      var word = { yes: 'Yes', no: 'No', later: 'Later' }[v];
      var pick = v === 'yes' && x.it.choices ? { choices: x.it.choices, draft: x.it.draft, rec: advised(x.it) } : null;
      ask({ panel: activityPanel, title: pick ? x.it.title : word + ': ' + x.it.title + '?', ok: pick ? 'Choose' : word, danger: v === 'no', pick: pick,
        text: pick ? x.it.ask : v === 'yes' ? (x.it.yes || '') : v === 'no' ? (x.it.no || '') : 'Ask again later.',
        path: '/api/app/approvals/decide',
        body: function (text, choice) {
          var b = { node: x.node.node, key: x.it.key, action: v };
          if (choice) { b.choice = choice; if (x.it.draft && text) b.text = text; }
          return b;
        },
        done: function () { return v === 'later' ? 'Put off: ' + x.it.title + '.' : 'Answered ' + word + ': ' + x.it.title + '.'; } });
      return;
    }
    if (act === 'wf') {
      var r = activityPanel._wf[k];
      var how = b.getAttribute('data-v');
      if (!r) return;
      if (how === 'reply') ask({ panel: activityPanel, title: 'Answer ' + r.answer.agentId, input: true, ok: 'Send',
        text: r.title + ': ' + r.waitingOn,
        path: '/api/app/workflows/answer', body: function (text) { return { node: r.node, runId: r.runId, action: 'reply', text: text }; },
        done: function () { return 'Sent to ' + r.answer.agentId + '.'; } });
      else ask({ panel: activityPanel, title: (how === 'yes' ? 'Yes' : 'No') + ': ' + r.title + '?', ok: how === 'yes' ? 'Yes' : 'No', danger: how === 'no',
        text: 'Step ' + r.step + ' waits on ' + r.waitingOn + '.',
        path: '/api/app/workflows/answer', body: function () { return { node: r.node, runId: r.runId, action: how }; },
        done: function () { return 'Answered ' + how + ': ' + r.title + '.'; } });
      return;
    }
    var t = activityPanel._act.tasks[k];
    if (act === 'cancel') ask({ panel: activityPanel, title: 'Stop ' + t.agentName + '?', danger: true, ok: 'Stop',
      text: 'The current task is stopped. The agent keeps the conversation.',
      path: '/api/app/tasks/cancel', body: function () { return { node: t.node, taskId: t.taskId }; }, done: function () { return 'Stopped.'; } });
    if (act === 'followup') ask({ panel: activityPanel, title: 'Follow up with ' + t.agentName, input: true, ok: 'Send',
      text: 'Sent after the current step finishes.',
      path: '/api/app/tasks/followup', body: function (text) { return { node: t.node, taskId: t.taskId, message: text }; }, done: function () { return 'Follow-up queued.'; } });
  });

  var loading = false, again = 0;
  function visible(panel) { return !panel.hidden && document.visibilityState === 'visible'; }
  function refresh() {
    // Never redraw under an open sheet: the rows it refers to would move.
    if (loading || sheet.open) return;
    // Nor under a finger pulling the next tab in: the redraw would end the swipe.
    if (document.querySelector('main.sw-on')) { clearTimeout(again); again = setTimeout(refresh, 300); return; }
    var q = '?timezone=' + encodeURIComponent(tz);
    var jobs = [];
    loading = true;
    if (visible(fleetPanel)) {
      jobs.push(api('GET', '/api/app/fleet' + q).then(renderFleet).catch(function (e) { flash(fleetPanel, 'Could not load the fleet: ' + e.message, true); }));
    }
    if (visible(activityPanel)) {
      // Workflows are extra: an older computer without the route still shows the rest.
      var wf = api('GET', '/api/app/workflows').catch(function () { return null; });
      jobs.push(Promise.all([api('GET', '/api/app/activity' + q), api('GET', '/api/app/approvals'), wf])
        .then(function (r) { renderActivity(r[0], r[1], r[2]); })
        .catch(function (e) { flash(activityPanel, 'Could not load activity: ' + e.message, true); }));
    }
    Promise.all(jobs).then(function () { loading = false; }, function () { loading = false; });
  }
  [fleetPanel, activityPanel].forEach(function (p) {
    if (!p.querySelector('.fx-status')) p.insertAdjacentHTML('beforeend', '<p class="fx-status" role="status" aria-live="polite"></p>');
  });
  document.addEventListener('ax-tab', function () { setTimeout(refresh, 0); });
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  setInterval(refresh, 15000);
  refresh();
})();
`
