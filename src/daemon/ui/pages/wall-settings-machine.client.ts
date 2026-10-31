// --- Hub Settings: Screen capture and Advanced (#1428 phase 3) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Actions script, so it shares
// S.st, stNoteHtml(), stNote(), stVal(), stChecked(), stChField(),
// stSetSave(), stGet(), stPaint(), settingsLoad() and the Hub's esc() and
// act().
//
//   Screen capture  the classic Channels tab's block of the same name: how
//                   agents capture the screen (POST screen), as
//                   `agentx screen config`.
//   Advanced        agentx.json itself, as the classic Advanced tab: read,
//                   edit, save with a backup (POST config/raw). It reads
//                   GET /api/admin/config/hidden, the file with each secret
//                   typed into it hidden; a hidden secret left in place
//                   keeps its value on save (config-hidden.ts), so the page
//                   never holds one. Invalid JSON is refused before the call.

export const WALL_SETTINGS_MACHINE_SCRIPT = String.raw`
  // --- Screen capture ---
  function stScreenHtml() {
    var s = (S.st.data && S.st.data.screen) || { regions: {}, buffer: {} }, b = s.buffer || {};
    var regions = Object.keys(s.regions || {}).map(function (n) { var r = s.regions[n]; return n + '=' + [r.x, r.y, r.width, r.height].join(','); }).join('\n');
    function num(id, label, v, hint) { return stChField(id, label, v == null ? '' : String(v), '', hint); }
    return '<header class="wst__h"><h2>Screen capture</h2><p>How agents capture the screen: cropped and scaled, when something changes or settles. The same as <code>agentx screen config</code>. Applies without a restart.</p></header>' +
      '<form class="wsf" data-st-form="screen"><section class="wsc"><h3>Each capture</h3>' +
        '<div class="wsf__row">' + num('st-sc-pixels', 'Pixel budget per frame', s.maxPixels, '(larger captures are scaled down)') + num('st-sc-timeout', 'Wait timeout (ms)', s.timeoutMs) + '</div>' +
        '<div class="wsf__row">' + num('st-sc-interval', 'Look every (ms)', s.intervalMs) + num('st-sc-threshold', 'Change threshold', s.changeThreshold, '(0 to 1)') + num('st-sc-stable', 'Settled after (ms)', s.stableMs) + '</div>' +
        '<label>Named regions <small>(one per line: name=x,y,width,height in screen points)</small><textarea id="st-sc-regions" rows="3" placeholder="chat=0,60,720,800">' + esc(regions) + '</textarea></label></section>' +
      '<section class="wsc"><h3>Recent frames</h3><p class="wsj__sub">Kept in memory only, off unless you turn it on.</p>' +
        '<label class="wsf__check"><input type="checkbox" id="st-sc-buffer"' + (b.enabled ? ' checked' : '') + '> Keep recent frames</label>' +
        stChField('st-sc-buf-region', 'Region', b.region || 'screen', 'screen', '(window, screen, menubar, notifications, a named region, or x,y,w,h)') +
        '<div class="wsf__row">' + num('st-sc-buf-seconds', 'Seconds kept', b.seconds) + num('st-sc-buf-fps', 'Frames per second', b.fps) + num('st-sc-buf-pixels', 'Pixel budget per frame', b.maxPixels) + '</div></section>' +
      '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button>' + stNoteHtml('screen') + '</div></form>';
  }
  function stScreenSave() {
    // A region taken out of the box is sent as null, so it is deleted.
    var regions = {}, bad = false;
    Object.keys(((S.st.data && S.st.data.screen) || {}).regions || {}).forEach(function (n) { regions[n] = null; });
    stVal('st-sc-regions').split('\n').forEach(function (line) {
      var t = line.trim(), at = t.indexOf('=');
      if (!t) return;
      if (at < 1) { bad = true; return; }
      regions[t.slice(0, at).trim()] = t.slice(at + 1).trim();
    });
    if (bad) { stNote('screen', 'err', 'Not saved: write each region as name=x,y,width,height.'); return; }
    stSetSave('screen', 'POST', 'screen', {
      maxPixels: stVal('st-sc-pixels'), timeoutMs: stVal('st-sc-timeout'), intervalMs: stVal('st-sc-interval'), changeThreshold: stVal('st-sc-threshold'), stableMs: stVal('st-sc-stable'),
      regions: regions,
      buffer: { enabled: stChecked('st-sc-buffer'), region: stVal('st-sc-buf-region').trim() || 'screen', seconds: stVal('st-sc-buf-seconds'), fps: stVal('st-sc-buf-fps'), maxPixels: stVal('st-sc-buf-pixels') },
    }, 'Saved.');
  }

  // --- Advanced: agentx.json ---
  /** Reads the file; quiet when the section's own paint asked for it. */
  async function stAdvLoad(quiet) {
    S.st.adv = { loading: true };
    if (!quiet) stPaint();
    try {
      var r = await stGet('/api/admin/config/hidden');
      S.st.adv = r.exists ? { raw: r.raw, text: r.raw, hidden: r.hidden || 0 } : { error: 'this machine has no agentx.json yet' };
    } catch (e) { S.st.adv = { error: String(e.message || e) }; }
    stPaint();
  }
  function stAdvancedHtml() {
    var a = S.st.adv;
    if (!a) { stAdvLoad(true); a = S.st.adv; }
    var head = '<header class="wst__h"><h2>Advanced</h2><p>agentx.json itself: every other section writes to it. Edit it here for bulk changes or a setting with no form yet. Saving keeps a backup next to it and reloads the daemon. Every setting is in the configuration reference.</p></header>';
    if (a.loading) return head + '<p class="ax-wall__empty">Loading…</p>';
    if (a.error) return head + '<p class="wst__err">Could not read agentx.json: ' + esc(a.error) + '.</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="adv-load">Try again</button>';
    return head + stNoteHtml('adv') +
      '<p class="wsj__sub">agentx.json · ' + (a.raw.length / 1024).toFixed(1) + ' KB' + (a.hidden ? ' · ' + a.hidden + ' secret' + (a.hidden === 1 ? '' : 's') + ' typed into the file, shown as <code>[hidden secret: kept on save]</code>. Leave those as they are, or put a <code>$' + '{NAME}</code> reference there and the secret in .env.' : '') + '</p>' +
      '<div class="wse"><textarea id="st-adv-text" rows="24" spellcheck="false" aria-label="agentx.json">' + esc(a.text) + '</textarea>' +
      '<div class="wsf__foot"><button type="button" class="ax-btn" data-st-act="adv-save">Save</button>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="adv-load">Reload from disk</button>' + stNoteHtml('adv-save') + '</div></div>';
  }
  async function stAdvSave() {
    var a = S.st.adv;
    if (!a || a.raw == null) return;
    a.text = stVal('st-adv-text');
    try { JSON.parse(a.text); } catch (e) { stNote('adv-save', 'err', 'Not saved: it is not valid JSON (' + (e.message || e) + ').'); return; }
    stNote('adv-save', '', 'Saving…');
    var r = await act('POST', '/api/admin/wall/settings/config/raw', { raw: a.text });
    if (!r.ok) { stNote('adv-save', 'err', 'Not saved: ' + r.error); return; }
    var bak = r.body && r.body.backupPath ? String(r.body.backupPath).split('/').pop() : '';
    await stAdvLoad(true);
    S.st.notes.adv = { kind: 'ok', text: 'Saved' + (bak ? ', with a backup in ' + bak : '') + '.' };
    stPaint();
    settingsLoad();
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (!t) return;
    var a = t.getAttribute('data-st-act');
    if (a === 'adv-load') stAdvLoad(false);
    else if (a === 'adv-save') stAdvSave();
  });
  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.id === 'st-adv-text' && S.st.adv) S.st.adv.text = ev.target.value;
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form || form.getAttribute('data-st-form') !== 'screen') return;
    ev.preventDefault();
    stScreenSave();
  });
`
