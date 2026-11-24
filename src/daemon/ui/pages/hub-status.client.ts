// Spliced into WALL_PAGE_SCRIPT's closure. Uses $, esc, headers, S and
// buildLast from the existing Hub script. Read-only every minute.
export const HUB_STATUS_SCRIPT = String.raw`
  function hsPaintRunning() {
    var el = $('hs-running');
    if (!el) return;
    if (!S.live) { el.textContent = 'Running agents —'; return; }
    var seen = {};
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      if (n.reachable === false) return;
      (n.agents || []).forEach(function (a) { if ((a.runningTasks || []).length) seen[a.id] = true; });
    });
    var count = Object.keys(seen).length;
    el.textContent = count + (count === 1 ? ' agent running' : ' agents running');
  }
  function hsPaintVersion() {
    var el = $('hs-version');
    if (el && buildLast && buildLast.version) el.textContent = 'v' + buildLast.version;
  }
  function hsLoadUsage() {
    fetch('/api/admin/hub/usage', { headers: headers() }).then(function (r) { if (!r.ok) throw new Error('usage read failed'); return r.json(); }).then(function (data) {
      var el = $('hs-claude');
      if (!el) return;
      el.textContent = 'Claude: ' + hubUsageText(data.windows || [], Date.now());
      el.title = data.readAt ? 'Last read ' + new Date(data.readAt).toLocaleString() : 'Based on the latest CLI report; no fresh plan reading';
    }).catch(function () {
      var el = $('hs-claude'); if (el) el.textContent = 'Claude: usage not known';
    });
  }
  // CLI accounts (#2101 P9b): owner only; a 403 leaves the button hidden.
  var hsAcct = null;
  function hsPaintAccounts() {
    var b = $('hs-acct'), pop = $('hs-acct-pop');
    if (!b || !hsAcct) return;
    b.hidden = false;
    b.textContent = 'Accounts · ' + hubAccountsText(hsAcct);
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
  hsLoadUsage();
  setInterval(hsLoadUsage, 60e3);
  setInterval(hsPaintVersion, 60e3);
`
