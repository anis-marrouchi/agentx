// --- Phone app: the Agents tab (#2101 C1a) ---
//
// The Hub's left column on the phone: the same rows (hub-agents.ts
// hubAgentRows, sent by GET /api/app/hub/agents) drawn by the same
// haListHtml, with the Hub's styles (hub-nav.ts HUB_NAV_CSS). A tap on an
// agent opens a new Chat with it: the agent is looked up in the Chat
// picker's list (GET /api/app/agents) for the node the Chat sends to.
//
// Needs haListHtml, haRowHtml and haRunsHtml through injectFns (app.ts).
// No runHref: on the phone every row opens a Chat, so no row links a run.
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_AGENTS_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-agents');
  if (!panel) return;
  var box = document.createElement('div');
  box.className = 'lt ha ag';
  // The server renders the shared loader (afLoaderHtml) as the placeholder.
  var wait = panel.querySelector('.ax-af-loader');
  if (wait) wait.replaceWith(box); else panel.appendChild(box);
  box.innerHTML = '<p class="ha__empty">Loading the agents…</p>';
  // open: the folds the reader opened (haListHtml's HaOpen); Working starts open, the rest folded.
  var S = { model: null, filter: 'all', open: { needs: false, working: false, idle: false, work: true, done: false, needsAll: false }, loading: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function age(ms) {
    var s = Math.max(0, ms / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    return Math.round(s / 86400) + ' d';
  }
  function paint() {
    if (!S.model) return;
    var cur = window.AXChat && window.AXChat.target() ? window.AXChat.target().agent : '';
    box.innerHTML = haListHtml(S.model, S.filter, cur || '', S.open, esc, age);
  }
  function refresh() {
    if (panel.hidden || S.loading || document.visibilityState !== 'visible') return;
    S.loading = true;
    var d = new Date(); d.setHours(0, 0, 0, 0);
    fetch('/api/app/hub/agents?dayStart=' + d.getTime(), { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (m) {
      S.loading = false;
      if (!m) return;
      S.model = m;
      paint();
    }).catch(function () {
      S.loading = false;
      if (!S.model) box.innerHTML = '<p class="ha__empty">Could not reach the machines just now; trying again.</p>';
    });
  }

  // A tap opens a new Chat with the agent, on the computer it runs on.
  function openChat(row) {
    fetch('/api/app/agents', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : { nodes: [] }; }).then(function (data) {
      var nodes = (data.nodes || []).filter(function (n) {
        return n.target && (n.agents || []).some(function (a) { return a.id === row.id; });
      });
      var n = nodes.filter(function (x) { return x.name === row.node; })[0] || nodes[0];
      if (!n || !window.AXChat || !window.AXChat.with) { flash('Chat cannot reach ' + row.name + ' from this phone.'); return; }
      var a = n.agents.filter(function (x) { return x.id === row.id; })[0];
      window.AXChat.with({ node: n.target, nodeName: n.name, agent: a.id, agentName: a.name, color: a.color });
      var tab = document.getElementById('tab-chat');
      if (tab) tab.click();
    }).catch(function () { flash('Could not open the chat. Check the connection and try again.'); });
  }
  function flash(text) {
    var p = panel.querySelector('.ag-note');
    if (!p) { p = document.createElement('p'); p.className = 'ag-note'; p.setAttribute('role', 'status'); panel.insertBefore(p, box); }
    p.textContent = text;
  }

  box.addEventListener('click', function (ev) {
    var chip = ev.target.closest('[data-ha-filter]');
    if (chip) { S.filter = chip.getAttribute('data-ha-filter'); paint(); return; }
    var more = ev.target.closest('[data-ha-more]');
    if (more) { var mk = more.getAttribute('data-ha-more') === 'needs' ? 'needsAll' : 'working'; S.open[mk] = !S.open[mk]; paint(); return; }
    var a = ev.target.closest('[data-ha-agent]');
    if (!a || !S.model) return;
    ev.preventDefault();
    var id = a.getAttribute('data-ha-agent');
    var row = S.model.rows.filter(function (r) { return r.id === id; })[0];
    if (row) openChat(row);
  });
  box.addEventListener('toggle', function (ev) {
    var k = ev.target.getAttribute && ev.target.getAttribute('data-ha-open');
    if (k) S.open[k] = ev.target.open;
  }, true);

  document.addEventListener('ax-tab', function () { setTimeout(refresh, 0); });
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  setInterval(refresh, 15000);
  refresh();
})();
`

export const APP_AGENTS_CSS = `
.ag { margin: 0; }
.ag .ha__row { padding: 10px 8px; }
.ag .ha__name { font-size: 15px; }
.ag .ha__line { font-size: 13.5px; }
.ag .ha__chip { min-height: 36px; padding: 4px 12px; }
.ag-note { margin: 0 0 8px; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
`
