// --- Hub Settings: Mesh and Tokens (#1428 phase 3) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Inbox script, so it shares
// S.st, stNoteHtml(), stNote(), stVal(), stChecked(), stConfirmHtml(),
// stChField(), stChState(), stSetSave(), stPaint(), settingsLoad(),
// ST_ENV_NAME and the Hub's esc() and act().
//
// What the classic /admin Mesh and Tokens tabs do, with the same calls:
//   Mesh    on/off (POST mesh/toggle), the peers (POST/DELETE mesh/peers)
//           and the health-check cadence (POST mesh/health). A peer's token
//           is taken as the NAME of the .env variable that holds it,
//           written as a reference the daemon expands, never as a value.
//   Tokens  the list (read with the page), mint (POST tokens) and revoke
//           (DELETE tokens). A new token is shown once, right after it is
//           made, as classic Settings does; leaving the section forgets it.

export const WALL_SETTINGS_MESH_SCRIPT = String.raw`
  // --- Mesh ---
  function stMeshHtml() {
    var d = S.st.data || {}, m = d.mesh || { enabled: false, peers: [] }, hc = m.healthCheck || {}, peers = m.peers || [], n = peers.length;
    var lead = !m.enabled ? 'Mesh is off. Turn it on to share work between AgentX machines.'
      : !n ? 'Mesh is on, but there are no peers yet. Add one below to link another machine.'
      : 'This machine (<b>' + esc(d.nodeName || 'this machine') + '</b>) is linked to ' + n + ' peer' + (n === 1 ? '' : 's') + '. Work from any of them can land here, and the other way round.';
    var rows = peers.map(function (p, i) {
      var k = 'peer:' + i;
      return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(p.name) + '</b> ' + (p.hasToken ? '<span class="wsj__pill is-ok">token set</span>' : '<span class="wsj__pill is-warn">no token</span>') +
        '<p class="wsj__sub"><code>' + esc(p.url) + '</code></p></div>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Remove</button>' +
        stConfirmHtml(k, 'Remove the peer <b>' + esc(p.name) + '</b> at <code>' + esc(p.url) + '</code>? Work stops going between the two machines.', 'Remove ' + p.name) + '</li>';
    }).join('');
    return '<header class="wst__h"><h2>Mesh</h2><p>Link this AgentX to your other machines so they share work. Only if you run AgentX in more than one place. The same as <code>agentx mesh</code>.</p></header>' +
      stNoteHtml('mesh') +
      '<section class="wsc"><h3>Mesh ' + stChState(m.enabled) + '</h3><p class="wsj__sub">' + lead + '</p>' +
        '<label class="wsf__check"><input type="checkbox" data-st-mesh-toggle' + (m.enabled ? ' checked' : '') + '> Mesh on</label></section>' +
      '<section class="wsc"><h3>Peers <small>' + n + '</small></h3>' + (rows ? '<ul class="wsj">' + rows + '</ul>' : '<p class="ax-wall__empty">No peers yet.</p>') +
      '<details class="wsc"><summary><h3>Add a peer</h3></summary><form class="wsf" data-st-form="mesh-peer">' +
        '<div class="wsf__row">' + stChField('st-m-name', 'Peer name', '', 'office-server') + stChField('st-m-url', 'Address', '', 'http://192.168.1.50:18800') + '</div>' +
        stChField('st-m-token', 'Token, as an environment variable name', '', 'PEER_TOKEN', '(optional: the .env variable that holds a token with the <code>mesh:peer</code> scope)') +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add peer</button>' + stNoteHtml('mesh-add') + '</div></form></details></section>' +
      '<section class="wsc"><h3>Health check</h3><p class="wsj__sub">How often this machine checks that each peer answers, as <code>agentx mesh health</code>. A shorter interval finds a peer that is down sooner.</p>' +
      '<form class="wsf" data-st-form="mesh-health"><div class="wsf__row">' +
        stChField('st-mh-interval', 'Every (seconds)', String(hc.interval == null ? 60 : hc.interval), '60', '(5 to 3600)') +
        stChField('st-mh-timeout', 'Gives up after (seconds)', String(hc.timeout == null ? 10 : hc.timeout), '10', '(1 to 60)') + '</div>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button>' + stNoteHtml('mesh-health') + '</div></form></section>';
  }
  function stMeshAddPeer() {
    var env = stVal('st-m-token').trim();
    // A token typed here would be stored as it is: only a name goes.
    if (env && !ST_ENV_NAME.test(env)) { stNote('mesh-add', 'err', 'Not added: type the name of the .env variable, such as PEER_TOKEN, not the token itself.'); return; }
    var body = { name: stVal('st-m-name').trim(), url: stVal('st-m-url').trim() };
    if (env) body.token = '$' + '{' + env + '}';
    stSetSave('mesh-add', 'POST', 'mesh/peers', body, '', 'mesh');
  }
  function stMeshHealth() {
    var interval = parseInt(stVal('st-mh-interval'), 10), timeout = parseInt(stVal('st-mh-timeout'), 10), body = {};
    if (isFinite(interval)) body.interval = interval;
    if (isFinite(timeout)) body.timeout = timeout;
    if (!Object.keys(body).length) { stNote('mesh-health', 'err', 'Not saved: give an interval or a timeout.'); return; }
    stSetSave('mesh-health', 'POST', 'mesh/health', body, 'Saved.');
  }

  // --- Tokens ---
  var ST_SCOPES = [['dashboard:read', 'Read the dashboard and Live'], ['dashboard:write', 'Change settings: full control'], ['agent:*', 'Message any public agent'], ['mesh:peer', 'A mesh peer (another machine)']];
  var ST_DAY = 24 * 3600 * 1000;
  function stTokenScopes() {
    return ST_SCOPES.concat(((S.st.data && S.st.data.agents) || []).filter(function (a) { return a.access === 'public'; }).map(function (a) {
      return ['agent:' + a.id, 'Message ' + (a.name || a.id) + ' (' + a.id + ')'];
    }));
  }
  function stTokensHtml() {
    var list = S.st.tokens, now = Date.now();
    var rows = !list ? '<p class="wst__err">Could not read the tokens.</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="reload">Try again</button>'
      : !list.length ? '<p class="ax-wall__empty">No tokens yet. Make one below to let a script, a chat bridge or another AgentX machine talk to this one.</p>'
      : '<ul class="wsj">' + list.map(function (t) {
        var expired = t.expiresAt && Date.parse(t.expiresAt) < now, stale = !t.revokedAt && t.lastUsedAt && now - Date.parse(t.lastUsedAt) > 30 * ST_DAY, k = 'tok:' + t.id;
        var pill = t.revokedAt ? '<span class="wsj__pill">revoked</span>' : expired ? '<span class="wsj__pill is-warn">expired</span>' : stale ? '<span class="wsj__pill is-warn">not used for 30 days</span>' : '<span class="wsj__pill is-ok">active</span>';
        return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(t.name) + '</b> ' + pill +
          '<p class="wsj__sub"><code>' + esc(t.prefix) + '…</code> · ' + esc((t.scopes || []).length ? (t.scopes || []).join(', ') : 'no scopes') + '</p>' +
          '<p class="wsj__sub">' + (t.lastUsedAt ? 'last used ' + esc(new Date(t.lastUsedAt).toLocaleString()) : 'never used') + ' · ' + (t.expiresAt ? 'expires ' + esc(new Date(t.expiresAt).toLocaleDateString()) : 'no expiry') + '</p></div>' +
          (t.revokedAt ? '' : '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Revoke</button>' +
            stConfirmHtml(k, 'Revoke <b>' + esc(t.name) + '</b>? Anything that uses it fails at once.', 'Revoke')) + '</li>';
      }).join('') + '</ul>';
    var fresh = S.st.newToken;
    var reveal = fresh ? '<div class="wsc wst-reveal" role="status"><h3>Copy it now: it is not shown again</h3><code id="st-tk-secret">' + esc(fresh.token) + '</code>' +
      '<div class="wsf__foot"><button type="button" class="ax-btn" data-st-act="tk-copy">Copy</button><button type="button" class="ax-btn ax-btn--ghost" data-st-act="tk-done">Done</button></div></div>' : '';
    return '<header class="wst__h"><h2>Tokens</h2><p>Passwords for software: anything that talks to AgentX from outside (a chat bridge, another AgentX machine, a script) uses one. Give each the fewest scopes that work.</p></header>' +
      stNoteHtml('tok') + reveal + rows +
      '<details class="wsc"' + (fresh ? '' : ' open') + '><summary><h3>Make a token</h3></summary><form class="wsf" data-st-form="token">' +
        stChField('st-tk-name', 'Name', '', 'Chat bridge', '(who or what it is for)') +
        '<fieldset class="wst-scopes"><legend>Scopes</legend>' + stTokenScopes().map(function (s, i) {
          return '<label class="wsf__check"><input type="checkbox" id="st-tk-scope-' + i + '" data-scope="' + esc(s[0]) + '"> <code>' + esc(s[0]) + '</code> ' + esc(s[1]) + '</label>';
        }).join('') + '</fieldset>' +
        stChField('st-tk-days', 'Expires after (days)', '', '90', '(empty: never)') +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Make token</button>' + stNoteHtml('tok-add') + '</div></form></details>';
  }
  async function stMakeToken() {
    var scopes = stTokenScopes().filter(function (s, i) { return stChecked('st-tk-scope-' + i); }).map(function (s) { return s[0]; });
    var days = stVal('st-tk-days').trim(), body = { name: stVal('st-tk-name').trim(), scopes: scopes };
    if (days) body.expiresInDays = parseInt(days, 10);
    stNote('tok-add', '', 'Making…');
    var r = await act('POST', '/api/admin/wall/settings/tokens', body);
    if (!r.ok) { stNote('tok-add', 'err', 'Not made: ' + r.error); return; }
    S.st.newToken = { token: r.body.token || '' };
    S.st.notes.tok = { kind: 'ok', text: 'Made the token ' + body.name + '.' };
    await settingsLoad();
  }

  async function stMeshConfirmed(key) {
    if (key.indexOf('peer:') === 0) {
      var p = (((S.st.data || {}).mesh || {}).peers || [])[+key.slice(5)];
      stPaint();
      if (p) await stSetSave('mesh', 'DELETE', 'mesh/peers', { url: p.url }, 'Removed the peer ' + p.name + '.');
      return true;
    }
    if (key.indexOf('tok:') === 0) {
      var id = key.slice(4);
      stPaint();
      await stSetSave('tok', 'DELETE', 'tokens', { id: id });
      return true;
    }
    return false;
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (!t) return;
    var a = t.getAttribute('data-st-act');
    if (a === 'tk-done') { S.st.newToken = null; stPaint(); }
    else if (a === 'tk-copy' && S.st.newToken) {
      (navigator.clipboard ? navigator.clipboard.writeText(S.st.newToken.token) : Promise.reject()).then(function () { stNote('tok', 'ok', 'Copied.'); }, function () { stNote('tok', 'err', 'Could not copy: select the token and copy it.'); });
    }
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (S.page !== 'settings' || !t || !t.hasAttribute || !t.hasAttribute('data-st-mesh-toggle')) return;
    var on = !!t.checked;
    stSetSave('mesh', 'POST', 'mesh/toggle', { enabled: on }, 'Mesh is ' + (on ? 'on.' : 'off.')).then(function (ok) { if (!ok) t.checked = !on; });
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form) return;
    var kind = form.getAttribute('data-st-form');
    if (kind !== 'mesh-peer' && kind !== 'mesh-health' && kind !== 'token') return;
    ev.preventDefault();
    if (kind === 'mesh-peer') stMeshAddPeer();
    else if (kind === 'mesh-health') stMeshHealth();
    else stMakeToken();
  });
`

export const WALL_SETTINGS_MESH_CSS = `
.wst-scopes { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.wst-scopes legend { font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-bottom: 4px; }
.wst-reveal { border-color: var(--ax-green); background: var(--ax-surface); }
.wst-reveal code { display: block; padding: 8px; border-radius: var(--ax-radius); background: var(--ax-bg); font-family: var(--ax-mono); font-size: 13px; overflow-wrap: anywhere; user-select: all; }
`
