// Spliced into WALL_PAGE_SCRIPT's closure. Uses $, esc, headers, act, S,
// buildLast and haChatAgent from the existing Hub script, and the injected
// hubConnState, hubEngineName, hubCliText and hubCliHtml (hub-status.ts),
// and engineIcon (engine-icons.ts) for each engine's own logo (#2272).
// It is painted with the agent list; the plan usage is
// hub-status-usage.client.ts.
export const HUB_STATUS_SCRIPT = String.raw`
  // Connection and machine (R25): from the last live read.
  function hsPaintConn() {
    var el = $('hs-conn');
    if (!el) return;
    var c = hubConnState({ live: !!S.live, error: !!S.liveError, online: navigator.onLine !== false });
    el.setAttribute('data-state', c.state);
    $('hs-conn-t').textContent = c.text;
    var nodes = (S.live && S.live.nodes) || [];
    var t = $('hs-node-t');
    if (!t || !nodes.length) return;
    var up = nodes.filter(function (n) { return n.reachable !== false; }).length;
    t.textContent = nodes[0].name + (nodes.length > 1 ? ' +' + (nodes.length - 1) : '');
    $('hs-node').hidden = false;
    $('hs-node').title = nodes.map(function (n) { return n.name + (n.reachable === false ? ' (not reachable)' : ''); }).join(', ') + ' · ' + up + ' of ' + nodes.length + ' reachable';
  }
  window.addEventListener('online', hsPaintConn);
  window.addEventListener('offline', hsPaintConn);

  // The CLI drop-down (R25): the agent in view, or the one picked in it.
  // mark: the button's plain prompt icon, kept for when no agent is in view;
  // ico: the engine whose logo the button shows now ('' for the plain mark).
  var HSC = { open: false, agent: '', note: { kind: '', text: '' }, last: '', mark: null, ico: '' };
  function hsCliAgents() {
    var seen = {}, out = [];
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      (n.agents || []).forEach(function (a) {
        if (!a || !a.id || seen[a.id]) return;
        seen[a.id] = true;
        out.push({ id: a.id, name: a.name || a.id, tier: a.tier || 'claude-code', node: n.name,
          pendingTier: a.pendingTier || '', running: Math.max(a.active || 0, (a.runningTasks || []).length) });
      });
    });
    return out.sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
  }
  function hsCliCur() { return HSC.agent || (typeof haChatAgent === 'function' ? haChatAgent() : '') || ''; }
  function hsPaintCli() {
    var b = $('hs-cli');
    if (!b) return;
    // Owner only: Settings writes the engine (window.AX_WALL_SETTINGS is the owner's).
    var list = window.AX_WALL_SETTINGS ? hsCliAgents() : [];
    b.hidden = !list.length;
    if (!list.length) return;
    var cur = hsCliCur();
    var inView = list.find(function (x) { return x.id === cur; });
    $('hs-cli-t').textContent = hubCliText(inView);
    // The engine's own logo on the button (engine-icons.ts, #2272); the plain prompt mark while no agent is in view.
    var icoEl = $('hs-cli-i');
    var icoKey = inView ? inView.tier || 'claude-code' : '';
    if (icoEl && HSC.ico !== icoKey) {
      if (HSC.mark === null) HSC.mark = icoEl.innerHTML;
      HSC.ico = icoKey;
      icoEl.innerHTML = icoKey ? engineIcon(icoKey, 'ax-eng') : HSC.mark;
    }
    if (!HSC.open) return;
    var html = hubCliHtml(list, cur, HSC.note, esc, function (k) { return engineIcon(k, 'ax-eng'); });
    if (html === HSC.last) return;
    // Keep the engine the owner just picked across a repaint.
    var picked = document.querySelector('#hs-cli-pop input[name="hsc-eng"]:checked');
    $('hs-cli-pop').innerHTML = HSC.last = html;
    if (picked) { var again = document.querySelector('#hs-cli-pop input[name="hsc-eng"][value="' + picked.value + '"]'); if (again) again.checked = true; }
  }
  function hsCliOpen(on) {
    HSC.open = on;
    HSC.last = '';
    if (!on) { HSC.agent = ''; HSC.note = { kind: '', text: '' }; }
    $('hs-cli').setAttribute('aria-expanded', String(on));
    $('hs-cli-pop').hidden = !on;
    hsPaintCli();
  }
  async function hsCliSave() {
    var id = hsCliCur(), pick = document.querySelector('#hs-cli-pop input[name="hsc-eng"]:checked');
    var a = hsCliAgents().find(function (x) { return x.id === id; });
    if (!a || !pick) return;
    if (pick.value === (a.pendingTier || a.tier)) { HSC.note = { kind: '', text: a.name + (a.pendingTier ? ' already switches to ' : ' already runs on ') + hubEngineName(pick.value) + '.' }; HSC.last = ''; hsPaintCli(); return; }
    HSC.note = { kind: '', text: 'Switching…' }; HSC.last = ''; hsPaintCli();
    var r = await act('PATCH', '/api/admin/wall/settings/agents', { id: a.id, patch: { tier: pick.value } });
    HSC.note = r.ok ? { kind: 'ok', text: hubCliSavedText(a, pick.value) }
      : { kind: 'err', text: 'Not switched: ' + String(r.error).replace(/\.$/, '') + '.' };
    HSC.last = '';
    hsPaintCli();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    if (t.closest('#hs-cli')) { hsCliOpen(!HSC.open); return; }
    if (t.closest('[data-hsc-save]')) { hsCliSave(); return; }
    if (HSC.open && !t.closest('#hs-cli-pop')) hsCliOpen(false);
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t && t.matches && t.matches('[data-hsc-agent]')) { HSC.agent = t.value; HSC.note = { kind: '', text: '' }; HSC.last = ''; hsPaintCli(); }
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && HSC.open) { hsCliOpen(false); $('hs-cli').focus(); } });

  function hsPaintRunning() {
    hsPaintConn();
    hsPaintCli();
    var el = $('hs-running');
    if (!el) return;
    // No reading yet: the item stays hidden, as Version does (no "—").
    if (!S.live) { el.parentNode.hidden = true; return; }
    el.parentNode.hidden = false;
    // The Hub's Working count (liveWorkCount, #2258); "3 running" when narrow.
    var count = liveWorkCount(S.live.nodes || []).agents;
    el.innerHTML = count + '<span class="hs__long">' + (count === 1 ? ' agent' : ' agents') + '</span> running';
    // The engines in use and the drop-downs (hub-status-usage.client.ts, #2101 R28).
    if (typeof hsuPaint === 'function') hsuPaint();
  }
  function hsPaintVersion() {
    var el = $('hs-version');
    if (!el || !buildLast || !buildLast.version) return;
    // The one place the version shows on a computer (R27); hover tells the rest.
    el.textContent = 'v' + buildLast.version;
    el.parentNode.hidden = false;
    // An old answer (the dashboard or this page could not reach the daemon) says as of when (#2343 C1).
    var asOf = typeof buildAsOf !== 'undefined' && buildAsOf ? ' · as of ' + buildAsOf.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    el.parentNode.title = 'v' + buildLast.version + (buildLast.commit ? ' · ' + buildLast.commit : '') + (buildLast.startedAt ? ' · since ' + buildWhen(new Date(buildLast.startedAt)) : '') + asOf + '. ' + buildTitle(buildLast);
  }
  // CLI accounts (#2101 P9b): owner only; a 403 leaves the button hidden.
  var hsAcct = null;
  function hsPaintAccounts() {
    var b = $('hs-acct'), pop = $('hs-acct-pop');
    if (!b || !hsAcct) return;
    b.hidden = false;
    var said = hubAccountsText(hsAcct);
    b.title = 'Accounts · ' + said;
    b.innerHTML = 'Accounts<span class="hs__acct-s"> · ' + esc(said) + '</span>';
    if (!pop.hidden) pop.innerHTML = hubAccountsHtml(hsAcct, esc);
  }
  function hsAccounts(body) {
    return fetch('/api/admin/hub/accounts', body ? { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers()), body: JSON.stringify(body) } : { headers: headers() })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
      .then(function (d) { hsAcct = d.providers || []; hsPaintAccounts(); return true; })
      .catch(function (e) { var n = $('hsa-note'); if (n) n.textContent = 'Not changed: ' + e.message; return false; });
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('#hs-acct');
    if (b) { var pop = $('hs-acct-pop'); pop.hidden = !pop.hidden; b.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true'); hsPaintAccounts(); return; }
    var rm = ev.target.closest('[data-hsa-rm]');
    if (rm) { ev.preventDefault(); hsAccounts({ provider: rm.getAttribute('data-hsa-rm'), action: 'remove', name: rm.getAttribute('data-name') }); }
  });
  document.addEventListener('change', function (ev) {
    var r = ev.target.closest && ev.target.closest('[data-hsa-use]');
    if (r) hsAccounts({ provider: r.getAttribute('data-hsa-use'), action: 'use', name: r.value }).then(function (ok) { var n = $('hsa-note'); if (ok && n) n.textContent = 'New runs now use ' + r.value + '.'; });
  });
  document.addEventListener('submit', function (ev) {
    var f = ev.target.closest && ev.target.closest('[data-hsa-add]');
    if (!f) return;
    ev.preventDefault();
    hsAccounts({ provider: f.getAttribute('data-hsa-add'), action: 'add', name: f.elements.name.value, dir: f.elements.dir.value });
  });
  // Only the owner's page asks (window.AX_WALL_SETTINGS is set for the owner alone).
  if (window.AX_WALL_SETTINGS) hsAccounts();
  setInterval(hsPaintVersion, 60e3);
`
