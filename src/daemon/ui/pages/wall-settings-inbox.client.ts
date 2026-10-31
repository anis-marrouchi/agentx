// --- Hub Settings: Inbox, how the inbox reaches the owner (#1428 phase 2) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the WhatsApp script, so it shares
// S.st, stNoteHtml(), stNote(), stVal(), stChecked(), stOptions(),
// stChField(), stSetSave() and the Hub's esc().
//
// The "Notifications routing" block of the classic /admin Channels tab,
// with its one call (POST notifications, as `agentx notifications`):
// where a ping goes (channel, chat, account), which events send one, the
// long-task threshold, what `agentx notify` does on this machine (banner,
// sound) and phone push through ntfy. On ntfy the topic is the password,
// so the page shows only whether a topic or token is set, and takes the
// NAME of the .env variable that holds one, written as a reference the
// daemon expands. Only a real ntfy change is sent, since any write to
// channels.* asks for a daemon restart, as on the classic page.

export const WALL_SETTINGS_INBOX_SCRIPT = String.raw`
  var ST_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  var ST_NTFY_SERVER = 'https://ntfy.sh';

  function stInboxHtml() {
    var n = (S.st.data && S.st.data.notifications) || {}, d = n.destination, on = n.on || {}, local = n.local || {}, ntfy = n.ntfy || {};
    var channels = [['', '(none)'], ['telegram', 'Telegram'], ['whatsapp', 'WhatsApp']];
    if (d && d.channel && !channels.some(function (c) { return c[0] === d.channel; })) channels.push([d.channel, d.channel]);
    function check(id, label, checked) { return '<label class="wsf__check"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '> ' + label + '</label>'; }
    return '<header class="wst__h"><h2>Inbox</h2><p>Where AgentX tells you that a task finished, failed or runs long, and what <code>agentx notify</code> does on this machine. The same settings as <code>agentx notifications</code>.</p></header>' +
      stNoteHtml('inbox') +
      '<form class="wsf" data-st-form="inbox">' +
      '<section class="wsc"><h3>Where it goes</h3>' +
        '<p class="wsj__sub">' + (d ? 'Goes to <code>' + esc(d.channel) + ':' + esc(d.chatId) + '</code>' + (d.accountId ? ' (account ' + esc(d.accountId) + ')' : '') + '.'
          : 'No destination: notifications go to the daemon log only.') + '</p>' +
        '<div class="wsf__row"><label>Channel<select id="st-in-channel">' + stOptions(channels, d ? d.channel : '') + '</select></label>' +
        stChField('st-in-chat', 'Chat id', d && d.chatId, '-1001234567890') + '</div>' +
        stChField('st-in-account', 'Account', d && d.accountId, 'default', '(optional: when the channel has several bots)') +
        (d ? '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="inbox-clear">Clear the destination</button>' : '') + '</section>' +
      '<section class="wsc"><h3>When</h3>' +
        check('st-in-complete', 'A task is done', on.taskComplete !== false) + check('st-in-error', 'A task failed', on.taskError !== false) + check('st-in-queued', 'A task is queued', !!on.taskQueued) +
        stChField('st-in-threshold', 'A task runs longer than (seconds)', String(n.longTaskThreshold == null ? 30 : n.longTaskThreshold), '30', '(0: no long-task ping)') + '</section>' +
      '<section class="wsc"><h3>On this machine</h3><p class="wsj__sub">When <code>agentx notify</code> delivers on the machine that serves this dashboard.</p>' +
        check('st-in-banner', 'Show a banner', local.banner !== false) + check('st-in-sound', 'Play a sound', local.sound !== false) +
        '<div class="wsf__row">' + stChField('st-in-sound-name', 'Sound', local.soundName || 'Glass', 'Glass', '(a system sound, such as Glass, Ping or Tink)') +
        stChField('st-in-volume', 'Volume', String(local.volume == null ? 0.4 : local.volume), '0.4', '(0 to 1)') + '</div>' +
        stChField('st-in-icon', 'Banner icon', local.icon, '', '(the full path to a .png, .jpg or .icns; empty for the AgentX logo; applies on the next <code>agentx desktop install</code>)') + '</section>' +
      '<section class="wsc"><h3>Phone push (ntfy) ' + stChState(ntfy.enabled) + '</h3><p class="wsj__sub">Used by <code>agentx notify</code>. Restart the daemon after a change here.</p>' +
        check('st-in-ntfy', 'Phone push on', !!ntfy.enabled) +
        stChField('st-in-ntfy-server', 'Server', ntfy.server || ST_NTFY_SERVER, ST_NTFY_SERVER) +
        stChField('st-in-ntfy-topic', 'Topic, as an environment variable name', '', 'NTFY_TOPIC', ntfy.topicSet ? '(set; empty keeps it)' : '(not set: the topic goes in .env, it is a password)') +
        stChField('st-in-ntfy-token', 'Access token, as an environment variable name', '', 'NTFY_TOKEN', ntfy.tokenSet ? '(set; empty keeps it)' : '(optional, for a protected topic)') + '</section>' +
      '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button>' + stNoteHtml('inbox-save') + '</div></form>';
  }

  function stInboxSave() {
    var was = ((S.st.data && S.st.data.notifications) || {}).ntfy || {};
    var channel = stVal('st-in-channel').trim(), chat = stVal('st-in-chat').trim(), account = stVal('st-in-account').trim();
    if (!channel !== !chat) { stNote('inbox-save', 'err', 'Not saved: give both a channel and a chat id, or neither.'); return; }
    var topic = stVal('st-in-ntfy-topic').trim(), token = stVal('st-in-ntfy-token').trim();
    // A secret typed here would be sent and stored as it is: only a name goes.
    if ((topic && !ST_ENV_NAME.test(topic)) || (token && !ST_ENV_NAME.test(token))) {
      stNote('inbox-save', 'err', 'Not saved: type the name of the .env variable, such as NTFY_TOPIC, not the topic or token itself.');
      return;
    }
    var threshold = parseInt(stVal('st-in-threshold'), 10), volume = parseFloat(stVal('st-in-volume'));
    var body = {
      on: { taskComplete: stChecked('st-in-complete'), taskError: stChecked('st-in-error'), taskQueued: stChecked('st-in-queued') },
      longTaskThreshold: isFinite(threshold) ? threshold : 30,
      local: { banner: stChecked('st-in-banner'), sound: stChecked('st-in-sound'), soundName: stVal('st-in-sound-name').trim() || 'Glass',
        volume: isFinite(volume) ? volume : 0.4, icon: stVal('st-in-icon').trim() },
    };
    var ntfy = {}, enabled = stChecked('st-in-ntfy'), server = stVal('st-in-ntfy-server').trim() || ST_NTFY_SERVER;
    if (enabled !== !!was.enabled) ntfy.enabled = enabled;
    if (server !== (was.server || ST_NTFY_SERVER)) ntfy.server = server;
    if (topic) ntfy.topic = '$' + '{' + topic + '}';
    if (token) ntfy.token = '$' + '{' + token + '}';
    if (Object.keys(ntfy).length) body.ntfy = ntfy;
    if (channel) body.destination = account ? { channel: channel, chatId: chat, accountId: account } : { channel: channel, chatId: chat };
    stSetSave('inbox-save', 'POST', 'notifications', body, 'Saved.' + (body.ntfy ? ' Restart the daemon for phone push: ' + ST_RESTART + '.' : ''), 'inbox');
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (t && t.getAttribute('data-st-act') === 'inbox-clear') stSetSave('inbox-save', 'POST', 'notifications', { destination: null }, 'Cleared: notifications go to the daemon log only.', 'inbox');
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form || form.getAttribute('data-st-form') !== 'inbox') return;
    ev.preventDefault();
    stInboxSave();
  });
`
