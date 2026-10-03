// --- Phone app: Fleet and Activity tab bodies ---
//
// Vanilla browser JS inlined into /app (app.ts). Reads /api/app/fleet,
// /api/app/activity and /api/app/approvals; acts through the POST routes in
// app-fleet.ts. Every action asks first in a bottom sheet, because on a phone
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
  sheet.innerHTML = '<form method="dialog"><h3 id="fx-title"></h3><p id="fx-text"></p>' +
    '<label id="fx-field" hidden><span>Message</span><textarea id="fx-input" rows="3"></textarea></label>' +
    '<p id="fx-error" class="fx-error" role="alert"></p>' +
    '<div class="fx-actions"><button value="cancel" class="fx-btn">Cancel</button>' +
    '<button value="ok" id="fx-ok" class="fx-btn fx-primary">OK</button></div></form>';
  document.body.appendChild(sheet);
  var pending = null;
  function ask(opts) {
    document.getElementById('fx-title').textContent = opts.title;
    document.getElementById('fx-text').textContent = opts.text || '';
    document.getElementById('fx-ok').textContent = opts.ok || 'OK';
    document.getElementById('fx-ok').className = 'fx-btn ' + (opts.danger ? 'fx-danger' : 'fx-primary');
    document.getElementById('fx-error').textContent = '';
    var field = document.getElementById('fx-field');
    var input = document.getElementById('fx-input');
    field.hidden = !opts.input;
    input.value = '';
    pending = opts;
    if (sheet.showModal) { sheet.showModal(); if (opts.input) input.focus(); }
    else if (window.confirm(opts.title)) run(opts, opts.input ? window.prompt('Message') || '' : '');
  }
  sheet.addEventListener('close', function () {
    var opts = pending;
    pending = null;
    if (!opts || sheet.returnValue !== 'ok') return;
    run(opts, document.getElementById('fx-input').value.trim());
  });
  function run(opts, text) {
    if (opts.input && !text) { flash(opts.panel, 'Nothing sent: the message was empty.', true); return; }
    api('POST', opts.path, opts.body(text)).then(function (b) {
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
    if (!n.reachable) return '<span class="fx-pill fx-off">Offline</span>';
    if (n.restart) return '<span class="fx-pill fx-warn">Restart ' + esc(n.restart.state) + '</span>';
    return '<span class="fx-pill fx-on">Online</span>';
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
      html += '<article class="fx-card"><div class="fx-row"><h3>' + esc(n.name) + '</h3>' + statusPill(n) + '</div>';
      if (!n.reachable) {
        html += '<p class="fx-muted">Not reachable' + (n.error ? ': ' + esc(n.error) : '') + '. The rest of the fleet still works.</p></article>';
        return;
      }
      html += '<p class="fx-muted">' + esc(uptime(n.uptimeSec)) + ' · ' + plural(n.agents.length, 'agent') + ' · ' + running + ' running · schedules today: ' +
        n.crons.today.success + ' ok, ' + n.crons.today.failed + ' failed</p>';
      html += '<div class="fx-row fx-gap"><button type="button" class="fx-btn" data-act="reload" data-i="' + i + '">Reload config</button>' +
        (n.restart ? '<button type="button" class="fx-btn" data-act="unrestart" data-i="' + i + '">Cancel restart</button>'
          : '<button type="button" class="fx-btn fx-danger-o" data-act="restart" data-i="' + i + '">Restart when idle</button>') + '</div>';
      html += '<details data-key="' + esc(n.url) + '|agents"' + (openKeys[n.url + '|agents'] ? ' open' : '') + '><summary>Agents (' + n.agents.length + ')</summary><ul class="fx-list">';
      n.agents.forEach(function (a) {
        html += '<li><div class="fx-row"><strong>' + esc(a.name) + '</strong><span class="fx-muted">' +
          (a.active ? a.active + ' running' : (a.lastActive ? ago(a.lastActive) : 'idle')) + (a.errors ? ' · ' + a.errors + ' errors' : '') + '</span></div>' +
          (a.last ? '<p class="fx-muted' + (a.last.ok ? '' : ' fx-bad') + '">' + esc(a.last.text) + '</p>' : '') + '</li>';
      });
      html += '</ul></details><details data-key="' + esc(n.url) + '|crons"' + (openKeys[n.url + '|crons'] ? ' open' : '') + '><summary>Schedules (' + n.crons.items.length + ')</summary><ul class="fx-list">';
      n.crons.items.forEach(function (c, j) {
        var last = c.last ? '<span class="fx-pill ' + (c.last.status === 'success' ? 'fx-on' : 'fx-off') + '">' + esc(c.last.status) + '</span>' : '';
        html += '<li><div class="fx-row"><strong>' + esc(c.id) + '</strong>' +
          '<button type="button" class="fx-switch" role="switch" aria-checked="' + c.enabled + '" aria-label="' + (c.enabled ? 'Turn off ' : 'Turn on ') + esc(c.id) +
          '" data-act="cron" data-i="' + i + '" data-j="' + j + '"><span></span></button></div>' +
          '<p class="fx-muted">' + esc(c.schedule) + ' · ' + esc(c.agent) + (c.consecutiveErrors ? ' · failed ' + c.consecutiveErrors + ' times in a row' : '') + ' ' + last + '</p>' +
          (c.last && c.last.text ? '<p class="fx-muted">' + esc(c.last.text) + '</p>' : '') + '</li>';
      });
      html += '</ul></details></article>';
    });
    fleetPanel.innerHTML = html;
    fleetPanel._data = data;
  }

  function renderActivity(act, appr) {
    var html = '<div class="fx-head"><h2>Activity</h2><button type="button" class="fx-btn" data-act="refresh">Refresh</button></div>' +
      statusLine(activityPanel, act.ts);
    var items = [];
    appr.nodes.forEach(function (n) { n.items.forEach(function (it) { items.push({ node: n, it: it }); }); });
    html += '<h3 class="fx-sub">Needs you (' + items.length + ')</h3>';
    if (!items.length) html += '<p class="fx-muted">Nothing is waiting for a decision.</p>';
    items.forEach(function (x, k) {
      html += '<article class="fx-card"><h4>' + esc(x.it.title) + '</h4><p>' + esc(x.it.ask) + '</p>' +
        (x.it.recommend ? '<p class="fx-muted">Suggested: ' + esc(x.it.recommend) + '</p>' : '') +
        '<p class="fx-muted">' + esc(x.it.raisedBy || '') + ' · ' + esc(x.node.nodeName) + '</p>' +
        '<div class="fx-row fx-gap"><button type="button" class="fx-btn fx-primary" data-act="decide" data-k="' + k + '" data-v="yes">Yes</button>' +
        '<button type="button" class="fx-btn" data-act="decide" data-k="' + k + '" data-v="no">No</button>' +
        '<button type="button" class="fx-btn" data-act="decide" data-k="' + k + '" data-v="later">Later</button></div></article>';
    });
    appr.nodes.forEach(function (n) { if (n.error) html += '<p class="fx-muted fx-bad">Approvals on ' + esc(n.nodeName) + ' could not be read: ' + esc(n.error) + '</p>'; });
    html += '<h3 class="fx-sub">Running now (' + act.tasks.length + ')</h3>';
    if (!act.tasks.length) html += '<p class="fx-muted">No agent is working right now.</p>';
    act.tasks.forEach(function (t, k) {
      html += '<article class="fx-card"><div class="fx-row"><h4>' + esc(t.agentName) + '</h4><span class="fx-muted">' + esc(ago(t.startedAt)) + '</span></div>' +
        '<p>' + esc(t.preview) + '</p><p class="fx-muted">' + esc(t.nodeName) + ' · ' + esc(t.channel) + '</p>' +
        '<div class="fx-row fx-gap"><button type="button" class="fx-btn" data-act="followup" data-k="' + k + '">Follow up</button>' +
        '<button type="button" class="fx-btn fx-danger-o" data-act="cancel" data-k="' + k + '">Stop</button></div></article>';
    });
    activityPanel.innerHTML = html;
    activityPanel._act = act;
    activityPanel._items = items;
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
      ask({ panel: activityPanel, title: word + ': ' + x.it.title + '?', ok: word, danger: v === 'no',
        text: v === 'yes' ? (x.it.yes || '') : v === 'no' ? (x.it.no || '') : 'Ask again later.',
        path: '/api/app/approvals/decide', body: function () { return { node: x.node.node, key: x.it.key, action: v }; },
        done: function () { return v === 'later' ? 'Put off: ' + x.it.title + '.' : 'Answered ' + word + ': ' + x.it.title + '.'; } });
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

  var loading = false;
  function visible(panel) { return !panel.hidden && document.visibilityState === 'visible'; }
  function refresh() {
    // Never redraw under an open sheet: the rows it refers to would move.
    if (loading || sheet.open) return;
    var q = '?timezone=' + encodeURIComponent(tz);
    var jobs = [];
    loading = true;
    if (visible(fleetPanel)) {
      jobs.push(api('GET', '/api/app/fleet' + q).then(renderFleet).catch(function (e) { flash(fleetPanel, 'Could not load the fleet: ' + e.message, true); }));
    }
    if (visible(activityPanel)) {
      jobs.push(Promise.all([api('GET', '/api/app/activity' + q), api('GET', '/api/app/approvals')])
        .then(function (r) { renderActivity(r[0], r[1]); })
        .catch(function (e) { flash(activityPanel, 'Could not load activity: ' + e.message, true); }));
    }
    Promise.all(jobs).then(function () { loading = false; }, function () { loading = false; });
  }
  [fleetPanel, activityPanel].forEach(function (p) {
    if (!p.querySelector('.fx-status')) p.insertAdjacentHTML('beforeend', '<p class="fx-status" role="status" aria-live="polite"></p>');
  });
  document.querySelectorAll('[role=tab]').forEach(function (t) { t.addEventListener('click', function () { setTimeout(refresh, 0); }); });
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  setInterval(refresh, 15000);
  refresh();
})();
`
