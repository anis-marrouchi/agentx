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
  hsLoadUsage();
  setInterval(hsLoadUsage, 60e3);
  setInterval(hsPaintVersion, 60e3);
`
