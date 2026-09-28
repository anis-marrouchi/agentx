// --- Phone app: Chat's agent picker and History sheets ---
//
// Loaded before APP_CHAT_SCRIPT, which calls window.AXChatSheets once with
// the two sheet elements and what a tap should do. The picker lists every
// node's agents (GET /api/app/agents); History lists past conversations
// (GET /api/app/conversations), or the phone's saved copies when offline.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_CHAT_SHEETS_SCRIPT = `
window.AXChatSheets = function (o) {
  var V = o.V, picker = o.picker, hist = o.hist;
  function loadPicker() {
    picker.innerHTML = '<p class="cx-note">Looking for agents…</p>';
    o.api('/api/app/agents').then(function (r) { return r.json(); }).then(function (data) {
      var nodes = picker._data = data.nodes || [];
      if (!nodes.length) { picker.innerHTML = '<p class="cx-note">No machines answered. Check that AgentX is running.</p>'; return; }
      picker.innerHTML = nodes.map(function (n, i) {
        var can = n.target && n.online;
        var why = !n.target ? 'Not linked to this computer’s mesh' : n.online ? 'Online' : 'Offline';
        var rows = n.agents.length ? n.agents.map(function (a, j) {
          return '<li><button type="button" data-n="' + i + '" data-a="' + j + '"' + (can ? '' : ' disabled') + '>' +
            '<span>' + V.esc(a.name) + '<span class="cx-sub">' + V.esc(a.id) + '</span></span>' +
            '<span class="cx-state' + (a.busy ? ' cx-busy' : '') + '">' + (a.busy ? 'busy' + (a.running > 1 ? ' · ' + a.running : '') : 'idle') + '</span></button></li>';
        }).join('') : '<li class="cx-note">No agents</li>';
        return '<h3><span class="cx-dot' + (n.online ? ' cx-on' : '') + '"></span>' + V.esc(n.name) + ' <span class="cx-sub">' + V.esc(why) + '</span></h3><ul>' + rows + '</ul>';
      }).join('');
    }).catch(function () { picker.innerHTML = '<p class="cx-note cx-bad">Could not load agents. Check the connection and try again.</p>'; });
  }
  picker.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-a]');
    if (!b || !picker._data) return;
    var n = picker._data[+b.getAttribute('data-n')], a = n.agents[+b.getAttribute('data-a')];
    o.onPick({ node: n.target, nodeName: n.name, agent: a.id, agentName: a.name, color: a.color });
  });
  function when(ms) { var d = new Date(ms); return isNaN(d.getTime()) ? '' : d.toLocaleString(); }
  function loadHistory() {
    hist.innerHTML = '<p class="cx-note">Loading…</p>';
    o.api('/api/app/conversations').then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { paintHistory(d.conversations || [], false); })
      .catch(function () { V.cacheAll().then(function (all) { paintHistory(all, true); }); });
  }
  function paintHistory(list, offline) {
    if (!list.length) { hist.innerHTML = '<p class="cx-note">' + (offline ? 'Offline, and nothing is saved on this phone yet.' : 'No conversations yet.') + '</p>'; return; }
    hist.innerHTML = (offline ? '<p class="cx-note">Offline: showing the conversations saved on this phone.</p>' : '') + '<ul>' + list.map(function (c) {
      return '<li><button type="button" data-c="' + V.esc(c.id) + '"><span>' + V.esc(c.title) +
        '<span class="cx-sub">' + V.esc((c.agentName || c.agent) + ' · ' + c.nodeName + ' · ' + when(c.updatedAt)) + '</span></span></button></li>';
    }).join('') + '</ul>';
  }
  hist.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-c]');
    if (b) o.onOpen(b.getAttribute('data-c'));
  });
  return { loadPicker: loadPicker, loadHistory: loadHistory };
};
`
