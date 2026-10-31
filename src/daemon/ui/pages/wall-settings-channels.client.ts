// --- Wall Settings: Channels (#1428 phase 2) ---
//
// Spliced into WALL_SETTINGS_SCRIPT, so it shares that script's S.st,
// stNoteHtml(), stNote(), stVal(), stChecked(), stOptions(), stGet(),
// stConfirmHtml(), stPaint(), settingsLoad(), stAgentOptions() and the
// Wall's esc() and act().
//
// The chat apps and developer tools agents answer from, as the classic
// /admin Channels tab sets them, with the same calls under the Settings
// prefix (wall-actions.ts), so the owner guard holds every write:
//   Telegram  the connector on/off, accounts (add, edit, delete)
//   WhatsApp  pairing, chats, watched chats (wall-settings-whatsapp.client.ts)
//   Email     the connector on/off, mailboxes (add, delete)
//   Slack, Discord, GitLab   connect or edit, on/off
//   GitLab, GitHub           request status comments on/off
//   GitHub    its webhooks (added on Webhooks)
//   Calls     active and recent calls (reads only)
// A secret is never shown or sent: each form takes the NAME of the .env
// variable that holds it, as the classic tab does. When agentx.json holds a
// token as a literal value, /api/admin/state sends only { literal: true }
// (secretRef in admin-panel.ts): the row says to move it to .env and the
// edit field stays empty. WhatsApp (pairing, chats and watched chats) is in
// wall-settings-whatsapp.client.ts; notification routing is the Inbox
// section (wall-settings-inbox.client.ts).

export const WALL_SETTINGS_CHANNELS_SCRIPT = String.raw`
  var ST_CHANNELS = [['telegram', 'Telegram'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['slack', 'Slack'], ['discord', 'Discord'], ['gitlab', 'GitLab'], ['github', 'GitHub'], ['calls', 'Calls']];
  /** A token reference in agentx.json (dollar sign, {NAME}) → NAME, for the edit forms; empty for a literal. */
  function stEnvName(ref) { return typeof ref === 'string' ? ref.replace(/^\$\{|\}$/g, '') : ''; }
  /** How a secret reads in a row: its reference, or a warning when agentx.json holds the value itself ({ literal: true }, never sent). */
  function stRefHtml(ref, empty) {
    if (ref && typeof ref === 'object') return '<span class="wsj__pill is-warn">set in agentx.json as a literal value: move it to .env</span>';
    return ref ? '<code>' + esc(ref) + '</code>' : esc(empty || '');
  }
  function stChState(on, configured) {
    if (configured === false) return '<span class="wsj__pill">not set up</span>';
    return on ? '<span class="wsj__pill is-ok">on</span>' : '<span class="wsj__pill">off</span>';
  }
  function stChSwitch(endpoint, on, label) {
    return '<label class="wsf__check"><input type="checkbox" data-st-ch-toggle="' + esc(endpoint) + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>';
  }
  function stChField(id, label, value, placeholder, hint) {
    return '<label>' + esc(label) + (hint ? ' <small>' + hint + '</small>' : '') + '<input id="' + id + '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '" autocomplete="off"></label>';
  }

  function stChannelsHtml() {
    var ch = S.st.ch || 'telegram';
    var tabs = '<nav class="wsj__tabs" aria-label="Channels">' + ST_CHANNELS.map(function (c) {
      return '<button type="button" class="ax-chip" data-st-act="ch" data-ch="' + c[0] + '" aria-pressed="' + (c[0] === ch) + '">' + esc(c[1]) + '</button>';
    }).join('') + '</nav>';
    var body = ch === 'whatsapp' ? stWhatsAppHtml() : ch === 'email' ? stEmailHtml() : ch === 'slack' ? stSlackHtml() : ch === 'discord' ? stDiscordHtml()
      : ch === 'gitlab' ? stGitLabHtml() : ch === 'github' ? stGitHubHtml() : ch === 'calls' ? stCallsHtml() : stTelegramHtml();
    return '<header class="wst__h"><h2>Channels</h2><p>The chat apps and developer tools your agents answer from. Secrets stay in .env: each form takes the name of the variable that holds one.</p></header>' +
      tabs + stNoteHtml('ch') + body;
  }

  // --- Telegram ---
  function stTelegramHtml() {
    var t = (S.st.data && S.st.data.telegram) || { enabled: false, accounts: [] };
    var rows = (t.accounts || []).map(function (a) {
      var k = 'tg:' + a.id, editing = S.st.tgEdit === a.id;
      return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(a.id) + '</b>' +
        '<p class="wsj__sub">bot ' + esc(a.botUsername || '—') + ' · answers as @' + esc(a.agentBinding || '—') + ' · token ' + stRefHtml(a.botTokenRef, '—') + '</p>' +
        (editing ? '<form class="wsf" data-st-form="tg-edit" data-id="' + esc(a.id) + '">' +
          '<label>Agent<select id="st-tge-agent">' + stAgentOptions(a.agentBinding || '') + '</select></label>' +
          stChField('st-tge-user', 'Bot username', a.botUsername, 'my_bot', '(optional)') +
          stChField('st-tge-env', 'Bot token, as an environment variable name', stEnvName(a.botTokenRef), 'TG_SUPPORT_BOT_TOKEN') +
          '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button><button type="button" class="ax-btn ax-btn--ghost" data-st-act="tg-edit" data-id="">Cancel</button></div></form>' : '') +
        '</div><div class="wsj__acts">' + (editing ? '' : '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="tg-edit" data-id="' + esc(a.id) + '">Edit</button>') +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Delete</button></div>' +
        stConfirmHtml(k, 'Delete the Telegram account <b>' + esc(a.id) + '</b>? Its bot stops answering. The token stays in .env.', 'Delete ' + a.id) + '</li>';
    }).join('');
    return '<section class="wsc"><h3>Telegram ' + stChState(t.enabled) + '</h3>' + stChSwitch('telegram/toggle', t.enabled, 'Telegram connector on') +
      (rows ? '<ul class="wsj">' + rows + '</ul>' : '<p class="ax-wall__empty">No Telegram account yet.</p>') +
      '<details class="wsc"><summary><h3>Add a Telegram account</h3></summary><form class="wsf" data-st-form="tg">' +
        stChField('st-tg-id', 'Account name', '', 'support', '(lowercase)') +
        '<label>Agent<select id="st-tg-agent">' + stAgentOptions('') + '</select></label>' +
        stChField('st-tg-user', 'Bot username', '', 'my_bot', '(optional)') +
        stChField('st-tg-env', 'Bot token, as an environment variable name', '', 'TG_SUPPORT_BOT_TOKEN', '(the token from BotFather goes in .env)') +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add account</button>' + stNoteHtml('tg-add') + '</div></form></details></section>';
  }

  // --- Email ---
  function stEmailHtml() {
    var e = (S.st.data && S.st.data.email) || { enabled: false, accounts: [] }, list = e.accounts || [];
    var rows = list.map(function (a) {
      var k = 'em:' + a.id;
      return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(a.address) + '</b>' +
        '<p class="wsj__sub">answered by @' + esc(a.agent) + ' · IMAP ' + esc(a.imap) + ' · SMTP ' + esc(a.smtp) + '</p>' +
        '<p class="wsj__sub">who may write: ' + esc((a.allowFrom || []).length ? a.allowFrom.join(', ') : 'nobody') + ' · replies ' + (a.send === 'auto' ? 'sent at once' : 'wait for your approval') +
        ' · password ' + stRefHtml(a.passwordRef, 'not set') + '</p></div>' +
        '<div class="wsj__acts"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Delete</button></div>' +
        stConfirmHtml(k, 'Remove the mailbox <b>' + esc(a.address) + '</b>? Its password stays in .env.', 'Remove ' + a.id) + '</li>';
    }).join('');
    return '<section class="wsc"><h3>Email ' + stChState(e.enabled) + '</h3>' + (list.length ? stChSwitch('email/toggle', e.enabled, 'Email connector on') : '') +
      (rows ? '<ul class="wsj">' + rows + '</ul>' : '<p class="ax-wall__empty">No mailbox yet.</p>') +
      '<details class="wsc"><summary><h3>Add a mailbox</h3></summary><form class="wsf" data-st-form="em">' +
        stChField('st-em-id', 'Account name', '', 'support') +
        '<label>Answered by<select id="st-em-agent">' + stAgentOptions('') + '</select></label>' +
        stChField('st-em-address', 'Address customers write to', '', 'hello@example.com') +
        stChField('st-em-imap', 'IMAP server (incoming)', '', 'imap.example.com') + stChField('st-em-imap-port', 'IMAP port', '993') +
        stChField('st-em-smtp', 'SMTP server (outgoing)', '', 'smtp.example.com') + stChField('st-em-smtp-port', 'SMTP port', '465') +
        stChField('st-em-env', 'Password, as an environment variable name', '', 'EMAIL_SUPPORT_PASSWORD') +
        stChField('st-em-allow', 'Who may write', '*', '', '(addresses, @domain, or * for anyone)') +
        '<label class="wsf__check"><input type="checkbox" id="st-em-auto"> Send replies at once, without my approval</label>' +
        '<p class="wsj__sub">Only mail that arrives after the daemon starts reading is answered, and the mailbox is never changed. Each reply waits in Needs you unless you tick the box. To check the login first, run <code>agentx connect email</code>.</p>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add mailbox</button>' + stNoteHtml('em-add') + '</div></form></details></section>';
  }

  // --- Slack, Discord, GitLab: one connection each ---
  function stOneHtml(o) {
    return '<section class="wsc"><h3>' + esc(o.label) + ' ' + stChState(o.on, o.configured) + '</h3>' +
      (o.meta ? '<p class="wsj__sub">' + o.meta + '</p>' : '') + (o.configured ? stChSwitch(o.toggle, o.on, o.label + ' on') : '') +
      '<form class="wsf" data-st-form="' + o.form + '"><h3>' + (o.configured ? 'Edit ' : 'Connect ') + esc(o.label) + '</h3>' + o.fields +
      '<div class="wsf__foot"><button type="submit" class="ax-btn">' + (o.configured ? 'Save' : 'Connect') + '</button>' + stNoteHtml(o.form) + '</div>' +
      (o.hint ? '<p class="wsj__sub">' + o.hint + '</p>' : '') + '</form></section>' + (o.extra || '');
  }
  function stSlackHtml() {
    var s = (S.st.data && S.st.data.slack) || {};
    return stOneHtml({ label: 'Slack', form: 'slack', toggle: 'slack/toggle', on: s.enabled, configured: !!(s.botTokenRef && s.appTokenRef),
      meta: (s.botTokenRef ? 'bot ' + stRefHtml(s.botTokenRef) : '') + (s.appTokenRef ? ' · app ' + stRefHtml(s.appTokenRef) : '') + (s.agentBinding ? ' · default agent @' + esc(s.agentBinding) : ''),
      fields: stChField('st-sl-bot', 'Bot token (xoxb-…), as an environment variable name', stEnvName(s.botTokenRef), 'SLACK_BOT_TOKEN') +
        stChField('st-sl-app', 'App token (xapp-…, Socket Mode), as an environment variable name', stEnvName(s.appTokenRef), 'SLACK_APP_TOKEN') +
        '<label>Default agent <small>(optional)</small><select id="st-sl-agent">' + stOptions([['', '(none)']], s.agentBinding || '') + stAgentOptions(s.agentBinding || '') + '</select></label>',
      hint: 'Create the app at api.slack.com/apps, turn on Socket Mode and make an app-level token with <code>connections:write</code>. The bot needs <code>chat:write</code>, <code>app_mentions:read</code>, <code>channels:history</code> and <code>im:history</code>.' });
  }
  function stDiscordHtml() {
    var d = (S.st.data && S.st.data.discord) || {};
    return stOneHtml({ label: 'Discord', form: 'discord', toggle: 'discord/toggle', on: d.enabled, configured: !!d.tokenRef,
      meta: (d.tokenRef ? 'token ' + stRefHtml(d.tokenRef) : '') + (d.agentBinding ? ' · agent @' + esc(d.agentBinding) : ''),
      fields: stChField('st-dc-env', 'Bot token, as an environment variable name', stEnvName(d.tokenRef), 'DISCORD_BOT_TOKEN') +
        '<label>Default agent <small>(optional)</small><select id="st-dc-agent">' + stOptions([['', '(none)']], d.agentBinding || '') + stAgentOptions(d.agentBinding || '') + '</select></label>',
      hint: 'The bot needs the <code>MESSAGE_CONTENT</code> intent in the Discord Developer Portal. It answers when @-mentioned in channels, and always in direct messages.' });
  }
  function stRequestStatusHtml(channel, label) {
    var on = ((S.st.data && S.st.data.requestStatus) || []).indexOf(channel) >= 0;
    return '<section class="wsc"><h3>Request status</h3><p class="wsj__sub">When someone asks an agent for work on ' + esc(label) +
      ', AgentX posts one comment with the state of that request (queued, working, waiting, done, failed, timed out, cut off by a restart) and edits it as the work moves.</p>' +
      '<label class="wsf__check"><input type="checkbox" data-st-rs="' + esc(channel) + '"' + (on ? ' checked' : '') + '> Request status comments on ' + esc(label) + '</label></section>';
  }
  function stGitLabHtml() {
    var g = (S.st.data && S.st.data.gitlab) || {};
    return stOneHtml({ label: 'GitLab', form: 'gitlab', toggle: 'gitlab/toggle', on: g.enabled, configured: !!g.tokenRef,
      meta: (g.host ? '<code>' + esc(g.host) + '</code>' : '') + (g.tokenRef ? ' · token ' + stRefHtml(g.tokenRef) : '') +
        ' · ' + (g.routeCount || 0) + ' route(s) · ' + (g.agentMappingCount || 0) + ' agent mapping(s)',
      fields: stChField('st-gl-host', 'Host', g.host || 'https://gitlab.com', 'https://gitlab.com') +
        stChField('st-gl-env', 'Admin token (api scope), as an environment variable name', stEnvName(g.tokenRef), 'GITLAB_TOKEN') +
        stChField('st-gl-port', 'Webhook listen port', String(g.webhookPort || 18810), '18810'),
      hint: 'Routes per project and tokens per agent are set in Advanced. GitLab webhooks are added on <a href="' + esc(stHref('webhooks')) + '">Webhooks</a>, source GitLab.',
      extra: stRequestStatusHtml('gitlab', 'GitLab') });
  }
  function stGitHubHtml() {
    var hooks = ((S.st.data && S.st.data.webhooks) || []).filter(function (w) { return w.source === 'github'; });
    return '<section class="wsc"><h3>GitHub</h3><p class="wsj__sub">GitHub needs no bot: it calls a webhook. Add one on Webhooks with source GitHub, then paste its address in the repository\'s Settings › Webhooks.</p>' +
      (hooks.length ? '<ul class="wsj">' + hooks.map(function (w) {
        return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(w.id) + '</b> ' + stChState(w.enabled) + '<p class="wsj__url"><code>' + esc(stHookUrl(w)) + '</code></p><p class="wsj__sub">goes to @' + esc(w.agentId) + '</p></div></li>';
      }).join('') + '</ul>' : '<p class="ax-wall__empty">No GitHub webhook yet.</p>') +
      '<a class="ax-btn" href="' + esc(stHref('webhooks')) + '">Add a GitHub webhook</a></section>' + stRequestStatusHtml('github', 'GitHub');
  }

  // --- Calls: reads only ---
  function stCallsHtml() {
    var c = S.st.calls;
    if (!c) { stLoadCalls(); return '<p class="ax-wall__empty">Loading…</p>'; }
    if (c.error) return '<p class="wst__err">Could not read the calls: ' + esc(c.error) + '</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="calls">Try again</button>';
    function dur(s) { return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s'; }
    var active = c.active || [], recent = c.history || [];
    return '<section class="wsc"><h3>Calls</h3><p class="wsj__sub">Live calls happen on <a href="/call">/call</a>, where you can invite the transcribing bot. This lists the calls this daemon has in memory.</p>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="calls">Refresh</button>' +
      '<h3>Active</h3>' + (active.length ? '<ul class="wsj__trig">' + active.map(function (b) { return '<li>@' + esc(b.agentId) + ' with ' + esc(b.target) + ' · ' + dur(b.uptimeSec || 0) + '</li>'; }).join('') + '</ul>' : '<p class="ax-wall__empty">No active call.</p>') +
      '<h3>Recent</h3>' + (recent.length ? '<ul class="wsj__trig">' + recent.map(function (h) {
        return '<li>' + esc(new Date(h.startedAt).toLocaleString()) + ' · @' + esc(h.agentId) + ' with ' + esc(h.target) + ' · ' + dur(h.durationSec || 0) + ' · ' + (h.transcriptChunks || 0) + ' transcript parts</li>';
      }).join('') + '</ul>' : '<p class="ax-wall__empty">No finished call in this daemon\'s memory yet.</p>') + '</section>';
  }
  async function stLoadCalls() {
    if (S.st.callsLoading) return;
    S.st.callsLoading = true;
    try { S.st.calls = await stGet('/api/admin/channels/webrtc/history'); }
    catch (e) { S.st.calls = { error: String(e.message || e) }; }
    S.st.callsLoading = false;
    stPaint();
  }

  // --- Saves ---
  async function stChSave(note, method, path, body, done) {
    stNote(note, '', 'Saving…');
    var r = await act(method, '/api/admin/wall/settings/channels/' + path, body);
    if (!r.ok) { stNote(note, 'err', 'Not saved: ' + r.error); return false; }
    S.st.notes.ch = { kind: 'ok', text: done || ((r.body && r.body.summary) || 'Saved.') + (r.body && r.body.hint ? ' ' + r.body.hint : '') };
    await settingsLoad();
    return true;
  }
  async function stChannelsConfirmed(key) {
    var tg = key.indexOf('tg:') === 0, em = key.indexOf('em:') === 0;
    if (!tg && !em) return false;
    var id = key.slice(3);
    stPaint();
    await stChSave('ch', 'DELETE', tg ? 'telegram' : 'email', { id: id }, (tg ? 'Deleted the Telegram account ' : 'Removed the mailbox ') + id + '.');
    return true;
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (!t) return;
    var a = t.getAttribute('data-st-act');
    if (a === 'ch') { S.st.ch = t.getAttribute('data-ch'); S.st.notes.ch = { kind: '', text: '' }; stPaint(); }
    else if (a === 'tg-edit') { S.st.tgEdit = t.getAttribute('data-id') || ''; stPaint(); }
    else if (a === 'calls') { S.st.calls = null; stPaint(); }
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (S.page !== 'settings' || !t || !t.hasAttribute) return;
    if (t.hasAttribute('data-st-ch-toggle')) {
      var path = t.getAttribute('data-st-ch-toggle'), on = !!t.checked;
      stChSave('ch', 'POST', path, { enabled: on }, path.split('/')[0] + (on ? ' is on.' : ' is off.')).then(function (ok) { if (!ok) t.checked = !on; });
    } else if (t.hasAttribute('data-st-rs')) {
      var channel = t.getAttribute('data-st-rs'), rs = !!t.checked;
      stChSave('ch', 'POST', 'request-status', { channel: channel, enabled: rs }, 'Request status comments are ' + (rs ? 'on.' : 'off.')).then(function (ok) { if (!ok) t.checked = !rs; });
    }
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form) return;
    var kind = form.getAttribute('data-st-form'), id = form.getAttribute('data-id');
    var known = { tg: 1, 'tg-edit': 1, em: 1, slack: 1, discord: 1, gitlab: 1 };
    if (!known[kind]) return;
    ev.preventDefault();
    if (kind === 'tg') stChSave('tg-add', 'POST', 'telegram', { id: stVal('st-tg-id').trim(), agentBinding: stVal('st-tg-agent'), botUsername: stVal('st-tg-user').trim(), botTokenEnv: stVal('st-tg-env').trim() });
    else if (kind === 'tg-edit') stChSave('ch', 'PATCH', 'telegram', { id: id, patch: { agentBinding: stVal('st-tge-agent'), botUsername: stVal('st-tge-user').trim(), botTokenEnv: stVal('st-tge-env').trim() } }, 'Saved ' + id + '.')
      .then(function (ok) { if (ok) { S.st.tgEdit = ''; stPaint(); } });
    else if (kind === 'em') stChSave('em-add', 'POST', 'email', {
      id: stVal('st-em-id').trim(), agent: stVal('st-em-agent'), address: stVal('st-em-address').trim(),
      imapHost: stVal('st-em-imap').trim(), imapPort: stVal('st-em-imap-port').trim(), smtpHost: stVal('st-em-smtp').trim(), smtpPort: stVal('st-em-smtp-port').trim(),
      passwordEnv: stVal('st-em-env').trim(), allowFrom: stVal('st-em-allow'), send: stChecked('st-em-auto') ? 'auto' : 'approve',
    });
    else if (kind === 'slack') stChSave('slack', 'POST', 'slack', { botTokenEnv: stVal('st-sl-bot').trim(), appTokenEnv: stVal('st-sl-app').trim(), agentBinding: stVal('st-sl-agent') });
    else if (kind === 'discord') stChSave('discord', 'POST', 'discord', { tokenEnv: stVal('st-dc-env').trim(), agentBinding: stVal('st-dc-agent') });
    else if (kind === 'gitlab') stChSave('gitlab', 'POST', 'gitlab', { host: stVal('st-gl-host').trim(), tokenEnv: stVal('st-gl-env').trim(), webhookPort: parseInt(stVal('st-gl-port'), 10) });
  });
`

export const WALL_SETTINGS_CHANNELS_CSS = `
.wsj__tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
.wsj__tabs [aria-pressed="true"] { background: var(--ax-accent); color: #fff; border-color: var(--ax-accent); }
`
