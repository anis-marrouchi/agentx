// --- Hub Settings: Channels › WhatsApp (#1428 phase 2) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Channels script, so it shares
// S.st, stNoteHtml(), stNote(), stVal(), stChecked(), stOptions(), stGet(),
// stConfirmHtml(), stPaint(), settingsLoad(), stAgentOptions(), stChState()
// and the Hub's esc(), act() and headers().
//
// What the classic /admin Channels tab shows for WhatsApp, and the
// WhatsApp triage block of its Webhooks tab, with the same calls:
//   Pairing   the connection state and the pairing code, read every 3 s
//             while the tab is open (GET channels/whatsapp/state, qr.svg)
//   Chats     the chats and contacts the daemon sees (reads), and the
//             sweep into an agent's wiki (POST channels/whatsapp/ingest)
//   Watched chats   triage on/off and its watch rules
//             (POST whatsapp-triage, POST/PATCH/DELETE whatsapp-triage/rules)
// Each write goes under the Settings prefix (wall-actions.ts), so the owner
// guard holds it. The triage secret is shown only as its variable's name and
// whether it is set; the pairing code is drawn from the daemon's SVG as an
// image, never as markup.

export const WALL_SETTINGS_WHATSAPP_SCRIPT = String.raw`
  /** A Settings write under the owner guard: the classic path after /api/admin. */
  async function stSetSave(note, method, path, body, done, noteTo) {
    stNote(note, '', 'Saving…');
    var r = await act(method, '/api/admin/wall/settings/' + path, body);
    if (!r.ok) { stNote(note, 'err', 'Not saved: ' + r.error); return false; }
    S.st.notes[noteTo || note] = { kind: 'ok', text: done || (r.body && r.body.summary) || 'Saved.' };
    await settingsLoad();
    return true;
  }

  function stWhatsAppHtml() {
    var w = (S.st.data && S.st.data.whatsapp) || { enabled: false, routeCount: 0 };
    if (w.enabled) stWaWatch();
    return '<section class="wsc"><h3>WhatsApp ' + stChState(w.enabled) + '</h3>' +
      '<p class="wsj__sub">' + (w.sessionDir ? 'session folder <code>' + esc(w.sessionDir) + '</code> · ' : '') + (w.routeCount || 0) + ' route(s)</p>' +
      '<h4>Pairing</h4><div id="st-wa-pair" aria-live="polite">' + stWaPairHtml() + '</div>' +
      '<p class="wsj__sub">Routes, phone numbers and allow-lists are under <code>channels.whatsapp</code> in <a href="' + esc(stHref('advanced')) + '">Advanced</a>. Pairing needs <code>@whiskeysockets/baileys</code> installed where the daemon runs.</p></section>' +
      stWaChatsHtml() + stWaTriageHtml();
  }

  // --- Pairing: read while the tab is open ---
  function stWaPairHtml() {
    var w = (S.st.data && S.st.data.whatsapp) || {}, s = S.st.wa;
    if (!w.enabled) return '<p class="ax-wall__empty">WhatsApp is off in agentx.json. Turn on <code>channels.whatsapp.enabled</code> in Advanced and restart the daemon: the pairing code shows here once WhatsApp asks for one.</p>';
    if (!s) return '<p class="ax-wall__empty">Checking…</p>';
    if (s.error) return '<p class="wst__err">Could not read the pairing state: ' + esc(s.error) + '</p>';
    var detail = s.detail ? ' (' + esc(s.detail) + ')' : '';
    if (s.connection === 'open') return '<p><span class="wsj__pill is-ok">connected</span> Paired: the daemon is signed in to WhatsApp.</p>';
    if (s.qr) return '<p><span class="wsj__pill is-warn">waiting for scan</span>' + detail + '</p>' +
      (S.st.waQrSrc ? '<img class="wsw__qr" id="st-wa-qr" alt="WhatsApp pairing code" src="' + esc(S.st.waQrSrc) + '">' : '<p class="ax-wall__empty">Loading the code…</p>') +
      '<p class="wsj__sub">On your phone, open WhatsApp › <b>Settings</b> › <b>Linked devices</b> › <b>Link a device</b>, and scan. The code changes about every 20 seconds.</p>';
    return '<p class="wsj__sub">' + esc(s.connection || 'init') + detail + ': waiting for the daemon to show a pairing code…</p>';
  }
  function stWaWatch() {
    if (S.st.waTimer != null) return;
    S.st.waTimer = setInterval(stWaPoll, 3000);
    stWaPoll();
  }
  function stWaStop() {
    if (S.st.waTimer != null) clearInterval(S.st.waTimer);
    S.st.waTimer = null;
  }
  async function stWaPoll() {
    if (S.page !== 'settings' || S.st.section !== 'channels' || S.st.ch !== 'whatsapp') { stWaStop(); return; }
    try { S.st.wa = await stGet('/api/admin/channels/whatsapp/state'); }
    catch (e) { S.st.wa = { error: String(e.message || e) }; }
    if (S.st.wa.qr && S.st.wa.qrUpdatedAt !== S.st.waQrAt) {
      // The code is fetched with the page's key and shown as an image, so
      // its SVG never runs as part of the page.
      try {
        var r = await fetch('/api/admin/channels/whatsapp/qr.svg', { headers: headers() });
        S.st.waQrSrc = r.status === 200 ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(await r.text()) : '';
        S.st.waQrAt = S.st.waQrSrc ? S.st.wa.qrUpdatedAt : '';
      } catch (e) { S.st.waQrSrc = ''; S.st.waQrAt = ''; }
    }
    var box = $('st-wa-pair');
    if (box) box.innerHTML = stWaPairHtml();
  }

  // --- Chats: what the daemon sees, and the sweep into a wiki ---
  function stWaChatsHtml() {
    var l = S.st.waLists;
    var lists = !l ? '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="wa-lists">Show chats and contacts</button>'
      : l.loading ? '<p class="ax-wall__empty">Loading…</p>'
      : l.error ? '<p class="wst__err">Could not read them: ' + esc(l.error) + '</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="wa-lists">Try again</button>'
      : '<div class="wsw__lists"><div><h4>Chats <small>' + l.chats.length + '</small></h4>' + stWaListHtml(l.chats.slice(0, 100).map(function (c) {
          return esc(c.name || c.jid) + ' <small>' + (c.isGroup ? 'group' : 'chat') + (c.unreadCount ? ' · ' + c.unreadCount + ' unread' : '') + '</small>';
        })) + '</div><div><h4>Contacts <small>' + l.contacts.length + '</small></h4>' + stWaListHtml(l.contacts.slice(0, 100).map(function (c) {
          return esc(c.name || c.phone || c.jid) + (c.phone && c.name !== c.phone ? ' <small>' + esc(c.phone) + '</small>' : '');
        })) + '</div></div><button type="button" class="ax-btn ax-btn--ghost" data-st-act="wa-lists">Refresh</button>';
    return '<section class="wsc"><h3>Chats</h3><p class="wsj__sub">The chats and contacts WhatsApp shows this daemon (the first 100 of each), and a sweep that writes them into an agent\'s wiki, as <code>agentx whatsapp ingest-all</code> does.</p>' + lists +
      '<form class="wsf" data-st-form="wa-ingest"><h4>Sweep into a wiki</h4>' +
        '<label>Agent whose wiki gets them<select id="st-wa-ing-agent">' + stOptions([['', 'WhatsApp\'s default agent']], '') + stAgentOptions('') + '</select></label>' +
        '<label class="wsf__check"><input type="checkbox" id="st-wa-ing-dry" checked> Dry run: count what would be written, write nothing</label>' +
        '<label class="wsf__check"><input type="checkbox" id="st-wa-ing-force"> Sweep even when <code>channels.whatsapp.ingest.enabled</code> is off</label>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Sweep now</button>' + stNoteHtml('wa-ingest') + '</div></form></section>';
  }
  function stWaListHtml(items) {
    return items.length ? '<ul class="wsj__trig wsw__list">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : '<p class="ax-wall__empty">None.</p>';
  }
  async function stWaLoadLists() {
    S.st.waLists = { loading: true };
    stPaint();
    try {
      var both = await Promise.all([stGet('/api/admin/channels/whatsapp/chats'), stGet('/api/admin/channels/whatsapp/contacts')]);
      S.st.waLists = { chats: both[0].chats || [], contacts: both[1].contacts || [] };
    } catch (e) { S.st.waLists = { error: String(e.message || e) }; }
    stPaint();
  }
  async function stWaIngest() {
    var body = { dryRun: stChecked('st-wa-ing-dry'), force: stChecked('st-wa-ing-force') }, agent = stVal('st-wa-ing-agent');
    if (agent) body.agent = agent;
    stNote('wa-ingest', '', 'Sweeping…');
    var r = await act('POST', '/api/admin/wall/settings/channels/whatsapp/ingest', body);
    if (!r.ok) { stNote('wa-ingest', 'err', 'Not swept: ' + r.error); return; }
    var x = r.body || {}, wrote = (x.wroteContacts || 0) + (x.wroteGroups || 0) + (x.wroteDmWindows || 0) + (x.wroteGroupWindows || 0);
    stNote('wa-ingest', 'ok', (body.dryRun ? 'Dry run: ' : 'Done: ') + (x.scannedContacts || 0) + ' contacts and ' + (x.scannedGroups || 0) + ' groups read, ' +
      (body.dryRun ? ((x.dryRunEntries || []).length) + ' entries would be written' : wrote + ' entries written') + ', ' + (x.skippedUnchanged || 0) + ' unchanged' +
      ((x.errors || []).length ? ', ' + x.errors.length + ' failed' : '') + '.');
  }

  // --- Watched chats (WhatsApp triage) ---
  function stWaTriageHtml() {
    var d = S.st.data || {}, t = d.whatsappTriage || { enabled: false, rules: [] };
    var url = String(d.daemonUrl || '').replace(/\/+$/, '') + '/webhook/wacli';
    var rows = (t.rules || []).map(function (r) {
      var k = 'wa:' + r.id, on = r.enabled !== false;
      return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(r.id) + '</b> ' + stChState(on) + '<p class="wsj__sub">goes to @' + esc(r.agent) +
        (r.quietHours ? ' · quiet ' + esc(r.quietHours.start) + '–' + esc(r.quietHours.end) : '') + '</p>' +
        '<p class="wsj__sub">' + esc([].concat(r.chats || [], r.senders || []).join(', ') || 'no chat') + '</p></div>' +
        '<div class="wsj__acts"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="wa-rule" data-id="' + esc(r.id) + '" data-on="' + (on ? '0' : '1') + '">' + (on ? 'Turn off' : 'Turn on') + '</button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Delete</button></div>' +
        stConfirmHtml(k, 'Delete the watch rule <b>' + esc(r.id) + '</b>? Messages from its chats no longer reach @' + esc(r.agent) + '.', 'Delete ' + r.id) + '</li>';
    }).join('');
    return '<section class="wsc"><h3>Watched chats ' + stChState(t.enabled) + '</h3>' +
      '<p class="wsj__sub">Messages from watched WhatsApp chats go to an agent, which sorts them and drafts replies. Nothing is sent to the contact until you approve it in Approvals. Needs <code>wacli sync --webhook</code>.</p>' +
      '<label class="wsf__check"><input type="checkbox" data-st-wa-triage' + (t.enabled ? ' checked' : '') + '> Watched chats on</label>' +
      '<p class="wsj__url">Address for wacli <code>' + esc(url) + '</code></p>' +
      '<p class="wsj__sub">Secret <code>' + esc(t.secretEnv || 'WACLI_WEBHOOK_SECRET') + '</code> in .env: ' + (t.secretSet ? 'set' : '<b>not set</b>. Every message is refused until it is.') + '</p>' +
      (t.error ? '<p class="wst__err">' + esc(t.error) + '</p>' : '') +
      (rows ? '<ul class="wsj">' + rows + '</ul>' : '<p class="ax-wall__empty">No watch rule yet.</p>') +
      '<details class="wsc"><summary><h3>Add a watch rule</h3></summary><form class="wsf" data-st-form="wa-rule">' +
        stChField('st-wa-id', 'Rule name', '', 'test-contact', '(lowercase)') +
        '<label>Agent<select id="st-wa-agent">' + stAgentOptions('') + '</select></label>' +
        stChField('st-wa-chats', 'Chats', '', '+1 555 000 1111', '(phone numbers or chat ids, comma-separated)') +
        stChField('st-wa-senders', 'Only from', '', '', '(optional: people in those chats)') +
        '<label>Instructions for the agent <small>(optional)</small><textarea id="st-wa-prompt" rows="3" placeholder="Who this contact is, where issues go, how to reply."></textarea></label>' +
        '<div class="wsf__row">' + stChField('st-wa-quiet-start', 'Quiet from', '', '22:00', '(optional)') + stChField('st-wa-quiet-end', 'Quiet until', '', '07:00') + '</div>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add watch rule</button>' + stNoteHtml('wa-add') + '</div></form></details></section>';
  }
  async function stWhatsAppConfirmed(key) {
    if (key.indexOf('wa:') !== 0) return false;
    var id = key.slice(3);
    stPaint();
    await stSetSave('ch', 'DELETE', 'whatsapp-triage/rules', { id: id }, 'Deleted the watch rule ' + id + '.');
    return true;
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (!t) return;
    var a = t.getAttribute('data-st-act');
    if (a === 'wa-lists') stWaLoadLists();
    else if (a === 'wa-rule') {
      var id = t.getAttribute('data-id'), on = t.getAttribute('data-on') === '1';
      stSetSave('ch', 'PATCH', 'whatsapp-triage/rules', { id: id, patch: { enabled: on } }, 'The watch rule ' + id + (on ? ' is on.' : ' is off.'));
    }
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (S.page !== 'settings' || !t || !t.hasAttribute || !t.hasAttribute('data-st-wa-triage')) return;
    var on = !!t.checked;
    stSetSave('ch', 'POST', 'whatsapp-triage', { enabled: on }, 'Watched chats are ' + (on ? 'on.' : 'off.')).then(function (ok) { if (!ok) t.checked = !on; });
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form) return;
    var kind = form.getAttribute('data-st-form');
    if (kind !== 'wa-rule' && kind !== 'wa-ingest') return;
    ev.preventDefault();
    if (kind === 'wa-ingest') { stWaIngest(); return; }
    stSetSave('wa-add', 'POST', 'whatsapp-triage/rules', {
      id: stVal('st-wa-id').trim(), agent: stVal('st-wa-agent'), chats: stVal('st-wa-chats'), senders: stVal('st-wa-senders'),
      prompt: stVal('st-wa-prompt'), quietStart: stVal('st-wa-quiet-start').trim(), quietEnd: stVal('st-wa-quiet-end').trim(),
    }, '', 'ch');
  });
`

export const WALL_SETTINGS_WHATSAPP_CSS = `
.wsw__qr { width: 240px; max-width: 100%; aspect-ratio: 1; background: #fff; padding: 8px; border-radius: 8px; border: 1px solid var(--ax-border); }
.wsw__lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.wsw__list { max-height: 220px; overflow-y: auto; border: 1px solid var(--ax-border); border-radius: 8px; padding: 6px 10px; }
.wsw__list small { color: var(--ax-muted); }
`
