// --- Hub Settings: Guests (#1449, from classic /guests, #380) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Diagnostics script, so it
// shares S.st, stGet(), stPaint(), stNote(), stNoteHtml(), stConfirmHtml()
// and the Hub's esc() and act().
//
// Every grant this node opened to another organisation, as the classic page
// showed it: what it may reach, how much it was used, its trail, with Pause,
// Resume and End. It reads GET /api/guests (the daemon's /mesh/guests); a
// change goes to POST /api/admin/wall/settings/guests/<id>/<pause|resume|end>,
// so the Hub's owner guard holds it (wall-actions.ts wallGuestsTarget).
// Opening, widening and narrowing a grant stay in the terminal.

export const WALL_SETTINGS_GUESTS_SCRIPT = String.raw`
  // --- Guests ---
  var ST_GU_STATE = { active: 'active', pending: 'waiting for your approval', paused: 'paused', ended: 'ended' };
  var ST_GU_LEVEL = { report: 'report: read only', propose: 'propose: no merge, deploy or delete', act: 'act: free inside the grant' };
  function stGu() { return S.st.gu || (S.st.gu = { data: null, error: '', loading: false }); }
  function stGuWhen(s) { return s ? String(s).slice(0, 16).replace('T', ' ') + ' UTC' : '-'; }
  async function stGuLoad() {
    var g = stGu();
    g.loading = true; g.error = '';
    try { g.data = await stGet('/api/guests'); if (g.data && g.data.error) throw new Error(g.data.error); }
    catch (e) { g.data = null; g.error = String(e.message || e); }
    g.loading = false;
    stPaint();
  }
  function stGuRow(x) {
    var k = 'guest:' + x.id, u = x.usage || {};
    var state = x.state === 'pending' && !x.guestNode ? 'not joined yet' : (ST_GU_STATE[x.state] || x.state);
    var pill = '<span class="wsj__pill' + (x.state === 'active' ? ' is-ok' : x.state === 'ended' ? '' : ' is-warn') + '">' + esc(state) + '</span>';
    function list(a) { return esc((a || []).join(', ') || 'none'); }
    var btns = (x.state === 'active' ? '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="gu" data-op="pause" data-id="' + esc(x.id) + '">Pause</button>' : '') +
      (x.state === 'paused' ? '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="gu" data-op="resume" data-id="' + esc(x.id) + '">Resume</button>' : '') +
      (x.state !== 'ended' ? '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">End</button>' +
        stConfirmHtml(k, 'End <b>' + esc(x.name) + '</b> for good? The guest loses access at once.', 'End') : '');
    var trail = (x.trail || []).map(function (e) { return '<li>' + esc(stGuWhen(e.at)) + ' · ' + esc(e.event) + (e.detail ? ' · ' + esc(e.detail) : '') + '</li>'; }).join('');
    return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(x.name) + '</b> ' + pill +
      '<p class="wsj__sub">Guest: ' + esc(x.guest) + (x.guestNode && x.guestNode.name ? ' (' + esc(x.guestNode.name) + ')' : '') + ' · agent ' + esc(x.agentId) +
        ' · until ' + esc(String(x.expiresAt || '').slice(0, 10)) + ' · ' + esc(u.turns || 0) + ' turn(s), ' + esc(u.tokens || 0) + ' tokens' + (u.lastAt ? ' · last ' + esc(stGuWhen(u.lastAt)) : '') + '</p>' +
      '<p class="wsj__sub">Freedom: ' + esc(ST_GU_LEVEL[x.level] || x.level) + ' · folders ' + list(x.folders) + ' · skills ' + list(x.skills) + ' · commands ' + list(x.commands) + '</p>' +
      (trail ? '<details><summary class="wsj__sub">What happened</summary><ul class="wsj__sub">' + trail + '</ul></details>' : '') +
      '</div>' + btns + '</li>';
  }
  function stGuestsHtml() {
    var g = stGu();
    if (!g.data && !g.loading && !g.error) { stGuLoad(); }
    var grants = (g.data && g.data.grants) || [];
    var body = g.loading && !g.data ? '<p class="ax-wall__empty">Loading…</p>'
      : g.error ? '<p class="wst__err">Could not read the grants: ' + esc(g.error) + '.</p>'
      : !grants.length ? '<p class="ax-wall__empty">No guest grants yet.</p>'
      : '<ul class="wsj">' + grants.map(stGuRow).join('') + '</ul>';
    return '<header class="wst__h"><h2>Guests</h2><p>Other organisations let into part of this mesh. Each grant names one agent of yours, what it may touch for them, how much freedom it has and until when. Nothing is shared until you open it.</p></header>' +
      stNoteHtml('gu') + body +
      '<p class="wsj__sub">Open a grant from a terminal: <code>agentx mesh guests invite --name "…" --guest "…" --agent &lt;id&gt;</code>. The guest joins with the code; its join arrives as a card in Needs you. Widen or narrow one with <code>agentx mesh guests set</code>.</p>' +
      '<div class="wsf__foot"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="gu-load">Refresh</button></div>';
  }
  async function stGuAct(id, op) {
    stNote('gu', '', op === 'end' ? 'Ending…' : op === 'pause' ? 'Pausing…' : 'Resuming…');
    var r = await act('POST', '/api/admin/wall/settings/guests/' + encodeURIComponent(id) + '/' + op, {});
    if (!r.ok) { stNote('gu', 'err', 'Not done: ' + r.error); return; }
    var x = (r.body && r.body.grant) || {};
    S.st.notes.gu = { kind: 'ok', text: (x.name || id) + ': ' + (ST_GU_STATE[x.state] || x.state || op) + (r.body && r.body.stopped ? ', ' + r.body.stopped + ' running turn(s) stopped' : '') + '.' };
    await stGuLoad();
  }
  async function stGuestsConfirmed(key) {
    if (key.indexOf('guest:') !== 0) return false;
    stPaint();
    await stGuAct(key.slice(6), 'end');
    return true;
  }
  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (!t) return;
    var a = t.getAttribute('data-st-act');
    if (a === 'gu') stGuAct(t.getAttribute('data-id'), t.getAttribute('data-op'));
    else if (a === 'gu-load') stGuLoad();
  });
`
