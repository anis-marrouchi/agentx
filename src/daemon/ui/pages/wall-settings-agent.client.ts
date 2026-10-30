// --- Wall Settings, one agent (#1428, design #1451 frame 2) ---
//
// Spliced into WALL_SETTINGS_SCRIPT, so it shares that script's S.st,
// stHref(), stNoteHtml() and the Wall's esc(), avatar() and act().
//
// The agent's page keeps the classic agent page's tabs (Overview,
// Personality, Skills, Channels, Handovers) under its picture (#1425) and
// on/off switch. The Overview form does not save field by field: a changed
// field turns blue and says what it was, a bar at the bottom counts the
// changes and says whether they need a restart, and Save… shows each
// change before and after (with what else moves: the agent's recurring
// jobs and its spend against its cap) before one PATCH saves them all.
//
// The draft lives in S.st.draft, not in the fields, so a repaint (the
// Wall's refresh, a tab switch, the switch) keeps what was typed, and a
// failed save leaves the form as it was.
//
// Handovers lists the chats routed to and away from the agent, releases one
// after a confirm, and hands a chat to another agent, with the classic agent
// page's calls (agent-panel.ts) under the Settings prefix.

import { HUB_NAME } from "../hub-name"

export const WALL_SETTINGS_AGENT_SCRIPT = String.raw`
  var ST_TABS = [['overview', 'Overview'], ['personality', 'Personality'], ['skills', 'Skills'], ['channels', 'Channels'], ['handovers', 'Handovers']];
  /** The Overview fields: key in the PATCH, label, kind. */
  var ST_FIELDS = [
    ['name', 'Display name', 'text'], ['triggerWords', 'Wake words', 'text'],
    ['tier', 'AI engine', 'select'], ['model', 'Model', 'text'],
    ['maxConcurrent', 'Conversations at once', 'number'], ['maxExecutionMinutes', 'Longest task, minutes', 'number'],
    ['permissionMode', 'Tool permissions', 'select'], ['access', 'Answers on the public API', 'check'],
    ['wikiAbsorb', 'In the wiki absorb', 'check'], ['systemPrompt', 'Instructions', 'area'],
  ];
  function stField(k) { return ST_FIELDS.find(function (f) { return f[0] === k; }); }
  /** The saved value of a field, as the form holds it (a string). */
  function stOrig(a, k) {
    if (k === 'name') return a.name || '';
    if (k === 'triggerWords') return (a.mentions || []).join(', ');
    if (k === 'tier') return a.tier || 'claude-code';
    if (k === 'model') return a.model || '';
    if (k === 'maxConcurrent') return String(a.maxConcurrent || 1);
    if (k === 'maxExecutionMinutes') return String(a.maxExecutionMinutes || 20);
    if (k === 'permissionMode') return a.permissionMode || 'default';
    if (k === 'access') return a.access === 'public' ? 'on' : 'off';
    if (k === 'wikiAbsorb') return a.wikiAbsorb !== false ? 'on' : 'off';
    return a.systemPrompt || '';
  }
  function stDraftOf(id) { return S.st.draft && S.st.draft.agent === id ? S.st.draft.v : {}; }
  function stCur(a, k) { var d = stDraftOf(a.id); return k in d ? d[k] : stOrig(a, k); }
  function stSame(k, x, y) { return stField(k)[2] === 'area' ? x === y : String(x).trim() === String(y).trim(); }
  /** The fields whose draft differs from what is saved, in form order. */
  function stChanges(a) {
    return ST_FIELDS.filter(function (f) { return !stSame(f[0], stCur(a, f[0]), stOrig(a, f[0])); }).map(function (f) { return f[0]; });
  }
  /** A value as a person reads it. */
  function stShow(k, v) {
    if (k === 'tier') return stEngine(v);
    if (k === 'model') return v.trim() || 'the engine\'s default';
    if (k === 'access' || k === 'wikiAbsorb') return v === 'on' ? 'On' : 'Off';
    if (k === 'systemPrompt') return v.length + (v.length === 1 ? ' character' : ' characters');
    return v.trim() || '(empty)';
  }
  function stWasText(a, k) {
    return k === 'systemPrompt' ? 'Changed from the saved instructions (' + stShow(k, stOrig(a, k)) + ').' : 'Changed from ' + stShow(k, stOrig(a, k)) + '.';
  }
  function stRestartOf(changes) {
    return ST_RESTART_FIELDS.filter(function (f) { return changes.indexOf(f[0]) >= 0; }).map(function (f) { return f[1]; });
  }

  function stAgentHtml(id) {
    var a = stAgentOf(id);
    var up = '<nav class="wsa-crumb" aria-label="Breadcrumb"><a href="' + esc(stHref('agents')) + '">Agents</a> › <span>' + esc(a ? a.name || a.id : '@' + id) + '</span></nav>';
    if (!a) return up + '<p class="ax-wall__empty">No agent @' + esc(id) + ' on this machine.</p>';
    var o = stOrgNode(id), tab = S.st.tab || 'overview';
    var tabs = '<nav class="wsa-tabs" aria-label="' + esc(a.name || a.id) + ' settings">' + ST_TABS.map(function (t) {
      var on = t[0] === tab;
      return '<a href="' + esc(stHref('agents', id, t[0])) + '" class="' + (on ? 'is-on' : '') + '"' + (on ? ' aria-current="page"' : '') + '>' + esc(t[1]) + '</a>';
    }).join('') + '</nav>';
    var body = tab === 'personality' ? stFilesHtml(a, 'identity') : tab === 'skills' ? stFilesHtml(a, 'skills')
      : tab === 'channels' ? stIntegrationsHtml(a) + stClassicHtml(a, 'Which chats and bots reach @' + a.id + ' (its Telegram bots and routes)')
      : tab === 'handovers' ? stHandoversHtml(a)
      : stEditHtml(a) + stTestHtml(a) + stDeleteHtml(a);
    return up + '<header class="wsa-head">' + avatar(id, 'lg') + '<div class="wsa__b"><h2>' + esc(a.name || a.id) + '</h2>' +
        '<small>@' + esc(a.id) + (o.title ? ' · ' + esc(o.title) : '') + '</small>' + pictureActsHtml(id) + stNoteHtml('hold-' + a.id) + '</div>' + stSwitchHtml(a) + '</header>' +
      tabs + '<div class="wsa-tab">' + body + '</div>' +
      '<div class="wsb" id="st-bar" role="region" aria-label="Changes not saved"' + (stChanges(a).length || (S.st.notes.edit && S.st.notes.edit.text) ? '' : ' hidden') + '>' + stBarHtml(a) + '</div>' +
      '<div id="st-dlg"></div>';
  }
  function stClassicHtml(a, what) {
    return '<section class="wsc"><p class="wst__todo">' + esc(what) + ' is not on the ${HUB_NAME} yet: it comes in a later step of #1428.</p>' +
      '<a class="ax-btn ax-btn--ghost" href="/admin/agents/' + encodeURIComponent(a.id) + '">Open the classic agent page</a></section>';
  }

  // --- Handovers: chats routed to or from this agent ---
  function stHandoversHtml(a) {
    var h = S.st.ho && S.st.ho.agent === a.id ? S.st.ho : null, name = a.name || a.id;
    var head = '<section class="wsc"><h3>Handovers</h3><p class="wsf__hint">Pass a chat to another agent. Every message from that chat goes to the new agent until you release the handover.</p>';
    if (!h || (!h.data && !h.error)) return head + '<p class="ax-wall__empty" aria-busy="true">Loading…</p></section>';
    if (h.error) return head + '<p class="wst__err">Could not read the handovers: ' + esc(h.error) + '</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="ho-load">Try again</button></section>';
    function rows(list, dir) {
      if (!list.length) return '<p class="ax-wall__empty">' + (dir === 'out' ? 'No chat is routed away from ' + esc(name) + '.' : 'No chat is routed to ' + esc(name) + '.') + '</p>';
      return '<ul class="wsi-list">' + list.map(function (o, n) {
        var key = 'ho:' + dir + ':' + n;
        return '<li class="wsi"><div><b>' + esc(o.channel) + ' · ' + esc(o.chatId) + (o.accountId ? ' · ' + esc(o.accountId) : '') + '</b><small>' +
          (dir === 'out' ? 'handed to @' + esc(o.toAgent) : 'from @' + esc(o.fromAgent)) + ' · ' + (o.expiresAt ? 'until ' + esc(o.expiresAt) : 'no end') +
          (o.summary ? (o.summaryConsumedAt ? ' · note read' : ' · note not read yet') : '') + '</small></div>' +
          '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + key + '">Release</button>' +
          stConfirmHtml(key, 'Release ' + esc(o.channel) + ' ' + esc(o.chatId) + '? Its next message goes where agentx.json routes it.', 'Release') + '</li>';
      }).join('') + '</ul>';
    }
    var others = (S.st.data.agents || []).filter(function (x) { return x.id !== a.id; }).map(function (x) { return [x.id, (x.name || x.id) + ' (' + x.id + ')']; });
    return head + stNoteHtml('ho') +
      '<h4>Routed away from ' + esc(name) + '</h4>' + rows(h.data.outgoing || [], 'out') +
      '<h4>Routed to ' + esc(name) + '</h4>' + rows(h.data.incoming || [], 'in') +
      '<details class="wsx"><summary>Hand a chat to another agent</summary><form class="wsf" data-st-form="ho">' +
        '<div class="wsf__row"><label>Channel<select id="st-h-ch">' + stOptions([['telegram', 'Telegram'], ['whatsapp', 'WhatsApp']], 'telegram') + '</select></label>' +
        '<label><span>Chat id <small>the person or group</small></span><input id="st-h-chat" autocomplete="off"></label></div>' +
        '<div class="wsf__row"><label>Hand to<select id="st-h-to">' + stOptions([['', 'Pick an agent']].concat(others), '') + '</select></label>' +
        '<label><span>Bot account <small>optional, when the channel has several</small></span><input id="st-h-acct" placeholder="default"></label></div>' +
        '<label><span>A note for the agent that takes it <small>optional, read once with the next message</small></span><textarea id="st-h-note" rows="3"></textarea></label>' +
        '<label><span>Until <small>optional date, such as 2026-12-01; empty means until you release it</small></span><input id="st-h-until"></label>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Hand over</button>' + stNoteHtml('ho-add') + '</div>' +
      '</form></details></section>';
  }
  async function stLoadHandovers(id) {
    S.st.ho = { agent: id, data: null, error: '' };
    stPaint();
    try { S.st.ho.data = await stGet('/api/admin/agent/' + encodeURIComponent(id) + '/handovers'); }
    catch (e) { S.st.ho.error = String(e.message || e); }
    stPaint();
  }
  async function stAddHandover(id) {
    var body = { channel: stVal('st-h-ch') || 'telegram', chatId: stVal('st-h-chat').trim(), toAgent: stVal('st-h-to'), accountId: stVal('st-h-acct').trim() || undefined,
      summary: stVal('st-h-note').trim() || undefined, expiresAt: stVal('st-h-until').trim() || undefined };
    if (!body.chatId || !body.toAgent) { stNote('ho-add', 'err', 'Write the chat id and pick the agent that takes it.'); return; }
    stNote('ho-add', '', 'Handing over…');
    var r = await act('POST', '/api/admin/wall/settings/agent/' + encodeURIComponent(id) + '/handovers', body);
    if (!r.ok) { stNote('ho-add', 'err', 'Not handed over: ' + r.error); return; }
    S.st.notes.ho = { kind: 'ok', text: 'Handed ' + body.channel + ' ' + body.chatId + ' to @' + body.toAgent + '.' };
    await stLoadHandovers(id);
  }
  /** Release the handover a confirm named ('ho:out:0'), then read the list again. */
  async function stReleaseHandover(id, key) {
    var parts = key.split(':'), list = S.st.ho && S.st.ho.data && S.st.ho.data[parts[1] === 'out' ? 'outgoing' : 'incoming'], o = list && list[+parts[2]];
    stPaint();
    if (!o) return;
    stNote('ho', '', 'Releasing…');
    var r = await act('DELETE', '/api/admin/wall/settings/agent/' + encodeURIComponent(id) + '/handovers', { channel: o.channel, chatId: o.chatId, accountId: o.accountId || undefined });
    if (!r.ok) { stNote('ho', 'err', 'Not released: ' + r.error); return; }
    S.st.notes.ho = { kind: 'ok', text: 'Released ' + o.channel + ' ' + o.chatId + '. Its next message goes where agentx.json routes it.' };
    await stLoadHandovers(id);
  }

  // --- Overview: the form, saved all at once ---
  function stInputHtml(a, f) {
    var k = f[0], v = stCur(a, k), changed = !stSame(k, v, stOrig(a, k)), ctl;
    var attr = ' id="st-e-' + k + '" data-st-f="' + k + '"';
    if (k === 'tier') ctl = '<select' + attr + '>' + stOptions(ST_ENGINES, v) + '</select>';
    else if (k === 'permissionMode') ctl = '<select' + attr + '>' + stOptions(ST_PERMS, v) + '</select>';
    else if (f[2] === 'check') ctl = '<input type="checkbox"' + attr + (v === 'on' ? ' checked' : '') + '>';
    else if (f[2] === 'area') ctl = '<textarea' + attr + ' rows="6">' + esc(v) + '</textarea>';
    else if (f[2] === 'number') ctl = '<input type="number" min="1" max="' + (k === 'maxConcurrent' ? 20 : 240) + '"' + attr + ' value="' + esc(v) + '">';
    else ctl = '<input' + attr + ' value="' + esc(v) + '"' + (k === 'model' ? ' placeholder="the engine\'s default"' : '') + (k === 'name' ? ' maxlength="80"' : '') + '>';
    var was = '<small class="wsf__was" id="st-fh-' + k + '">' + (changed ? esc(stWasText(a, k)) : '') + '</small>';
    if (f[2] === 'check') return '<label class="wsf__check wsf__f' + (changed ? ' is-changed' : '') + '" id="st-fw-' + k + '">' + ctl + ' ' + esc(f[1]) + was + '</label>';
    return '<label class="wsf__f' + (changed ? ' is-changed' : '') + (f[2] === 'area' ? ' wsf__f--wide' : '') + '" id="st-fw-' + k + '"><span>' + esc(f[1]) + '</span>' + ctl + was + '</label>';
  }
  function stEditHtml(a) {
    return '<form class="wsf wsc" data-st-form="edit" data-id="' + esc(a.id) + '"><div class="wsf__grid">' +
      ST_FIELDS.map(function (f) { return stInputHtml(a, f); }).join('') + '</div>' +
      '<p class="wsf__hint">Wake words are the words that call it, such as @support, comma or space separated. Off for the wiki absorb: agentx wiki absorb skips it; its conversations are still kept.</p></form>';
  }
  function stBarHtml(a) {
    var ch = stChanges(a), restart = stRestartOf(ch);
    var text = !ch.length ? '' : (ch.length === 1 ? '1 change not saved. ' : ch.length + ' changes not saved. ') +
      (restart.length ? 'The new ' + stList(restart) + ' needs a daemon restart.' : ch.length === 1 ? 'It applies without a restart.' : 'They apply without a restart.');
    return '<p class="wsb__t">' + esc(text) + '</p>' + stNoteHtml('edit') +
      (ch.length ? '<span class="wsb__acts"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="discard">Discard</button>' +
        '<button type="button" class="ax-btn" data-st-act="review">Save…</button></span>' : '');
  }
  /** Repaint only the marks and the bar, so the field in use keeps its focus. */
  function stMark(a, k) {
    var w = $('st-fw-' + k), h = $('st-fh-' + k), changed = !stSame(k, stCur(a, k), stOrig(a, k));
    if (w) w.classList.toggle('is-changed', changed);
    if (h) h.textContent = changed ? stWasText(a, k) : '';
    var bar = $('st-bar');
    if (bar) { bar.innerHTML = stBarHtml(a); bar.hidden = !stChanges(a).length && !(S.st.notes.edit && S.st.notes.edit.text); }
  }
  function stOnField(t) {
    var a = stAgentOf(S.st.agent), k = t.getAttribute('data-st-f');
    if (!a || !stField(k)) return;
    if (!S.st.draft || S.st.draft.agent !== a.id) S.st.draft = { agent: a.id, v: {} };
    S.st.draft.v[k] = t.type === 'checkbox' ? (t.checked ? 'on' : 'off') : String(t.value == null ? '' : t.value);
    S.st.notes.edit = { kind: '', text: '' };
    stMark(a, k);
  }

  // --- Save…: the before and after of each change, then one PATCH ---
  function stMoney(n) { n = Number(n) || 0; return '$' + (n >= 100 ? Math.round(n) : n.toFixed(2)); }
  function stAlsoHtml(a, ch) {
    var name = a.name || a.id, lines = [];
    if (ch.indexOf('model') >= 0 || ch.indexOf('tier') >= 0) {
      var jobs = ((S.st.data && S.st.data.crons) || []).filter(function (c) { return c.agent === a.id; });
      var own = jobs.filter(function (c) { return c.model; }).length, follow = jobs.length - own;
      lines.push(!jobs.length ? 'No recurring job runs as ' + name + '.'
        : !own ? name + '\'s ' + (jobs.length === 1 ? 'recurring job follows' : jobs.length + ' recurring jobs follow') + ' the agent\'s model, so ' + (jobs.length === 1 ? 'it changes' : 'they change') + ' too.'
        : !follow ? name + '\'s ' + (jobs.length === 1 ? 'recurring job names its own model and keeps it.' : jobs.length + ' recurring jobs name their own model and keep it.')
        : follow + ' of ' + name + '\'s recurring jobs follow the agent\'s model and change too; ' + own + ' name their own model and keep it.');
      var row = S.budgets && (S.budgets.agents || []).find(function (r) { return r.agentId === a.id; });
      lines.push(!S.budgets ? 'Spend may change. Its cap could not be read: see the Cost page.'
        : row && row.capUsd ? 'Spend may change: ' + name + ' has spent ' + stMoney(row.spentUsd) + ' of its ' + stMoney(row.capUsd) + ' cap this month.'
        : 'Spend may change: ' + name + ' has spent ' + stMoney(row ? row.spentUsd : 0) + ' this month, with no cap.');
    }
    var restart = stRestartOf(ch);
    lines.push(restart.length ? 'The new ' + stList(restart) + ' applies after a daemon restart: ' + ST_RESTART + '.' : 'No restart needed.');
    return '<p class="wsd__also">' + lines.map(esc).join(' ') + '</p>';
  }
  function stDialogHtml(a) {
    var ch = stChanges(a);
    var rows = ch.map(function (k) {
      return '<tr><th scope="row">' + esc(stField(k)[1]) + '</th><td><s>' + esc(stShow(k, stOrig(a, k))) + '</s> → <b>' + esc(stShow(k, stCur(a, k))) + '</b></td></tr>';
    }).join('');
    return '<div class="wsd" role="dialog" aria-modal="true" aria-labelledby="st-dlg-h"><button type="button" class="wsd__scrim" data-st-act="back" aria-label="Back to the form" tabindex="-1"></button>' +
      '<div class="wsd__box"><h3 id="st-dlg-h">Save ' + (ch.length === 1 ? '1 change' : ch.length + ' changes') + ' to ' + esc(a.name || a.id) + '?</h3>' +
      '<table class="wsd__t"><tbody>' + rows + '</tbody></table>' + stAlsoHtml(a, ch) + stNoteHtml('dlg') +
      '<div class="wsd__acts"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="back">Back</button>' +
      '<button type="button" class="ax-btn" id="st-dlg-save" data-st-act="save">Save changes</button></div></div></div>';
  }
  function stReview() {
    var a = stAgentOf(S.st.agent), box = $('st-dlg');
    if (!a || !box || !stChanges(a).length) return;
    S.st.notes.dlg = { kind: '', text: '' };
    box.innerHTML = stDialogHtml(a);
    var b = $('st-dlg-save');
    if (b) b.focus();
  }
  function stCloseDialog() { var box = $('st-dlg'); if (box) box.innerHTML = ''; }
  async function stSaveEdit() {
    var a = stAgentOf(S.st.agent);
    if (!a) return;
    var ch = stChanges(a), cur = function (k) { return stCur(a, k); };
    if (!cur('name').trim()) { stNote('dlg', 'err', 'Not saved: the display name cannot be empty.'); return; }
    var patch = {
      name: cur('name').trim(), tier: cur('tier'), model: cur('model').trim(), triggerWords: cur('triggerWords').trim(), systemPrompt: cur('systemPrompt'),
      maxConcurrent: parseInt(cur('maxConcurrent'), 10) || undefined, maxExecutionMinutes: parseInt(cur('maxExecutionMinutes'), 10) || undefined,
      permissionMode: cur('permissionMode'), access: cur('access') === 'on' ? 'public' : 'private', wikiAbsorb: cur('wikiAbsorb') === 'on',
    };
    stNote('dlg', '', 'Saving…');
    var r = await act('PATCH', '/api/admin/wall/settings/agents', { id: a.id, patch: patch });
    stCloseDialog();
    if (!r.ok) { stNote('edit', 'err', 'Not saved: ' + String(r.error).replace(/\.$/, '') + '. The form keeps what you typed.'); return; }
    var restart = stRestartOf(ch);
    S.st.draft = null;
    S.st.notes.edit = restart.length
      ? { kind: 'warn', text: 'Saved. Restart the daemon for the new ' + stList(restart) + ' to apply: ' + ST_RESTART + '.' }
      : { kind: 'ok', text: 'Saved. It applies from the agent\'s next run.' };
    await settingsLoad();
  }
  function stDiscard() {
    S.st.draft = null;
    S.st.notes.edit = { kind: '', text: '' };
    stPaint();
  }
`

export const WALL_SETTINGS_AGENT_CSS = `
/* One agent (#1451 frame 2): picture and switch on top, the classic tabs, the save bar. */
.wsa-crumb { font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.wsa-crumb a { color: var(--ax-accent); text-decoration: none; }
.wsa-head { display: flex; gap: 14px; align-items: flex-start; }
.wsa-head .wsa__b { gap: 4px; }
.wsa-head .wpc-pic { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; }
.wsa-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--ax-border); overflow-x: auto; }
.wsa-tabs a { padding: 10px 12px; color: var(--ax-text-2); text-decoration: none; font-weight: 600; white-space: nowrap; border-bottom: 3px solid transparent; }
.wsa-tabs a.is-on { color: var(--ax-text); border-bottom-color: var(--ax-accent); }
.wsa-tab { display: flex; flex-direction: column; gap: 12px; }
.wsf__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }
.wsf__grid .wsf__f--wide { grid-column: 1 / -1; }
.wsf__was { color: var(--ax-blue-ink, var(--ax-accent)); font-size: 12px; }
.wsf__was:empty { display: none; }
.wsf__f.is-changed input:not([type=checkbox]), .wsf__f.is-changed select, .wsf__f.is-changed textarea {
  border-color: var(--ax-accent); background: color-mix(in srgb, var(--ax-accent) 10%, var(--ax-bg)); }
.wsf .wsf__check.is-changed { color: var(--ax-accent); }
.wsf .wsf__check .wsf__was { flex-basis: 100%; }
.wsb { position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 12px 14px;
  border-top: 2px solid var(--ax-accent); background: color-mix(in srgb, var(--ax-accent) 10%, var(--ax-bg)); border-radius: var(--ax-radius); }
.wsb__t { margin: 0; flex: 1 1 240px; font-size: var(--ax-fs-sm); }
.wsb__t:empty { display: none; }
.wsb__acts { display: flex; gap: 8px; margin-left: auto; }
.wsd { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 16px; }
.wsd__scrim { position: absolute; inset: 0; border: 0; background: rgb(0 0 0 / 35%); cursor: default; }
.wsd__box { position: relative; width: min(520px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; background: var(--ax-bg); color: var(--ax-text);
  border-radius: var(--ax-radius-lg); padding: 18px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 8px 32px rgb(0 0 0 / 30%); }
.wsd__box h3 { margin: 0; font-size: 20px; font-weight: 800; }
.wsd__t { width: 100%; border-collapse: collapse; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); font-size: var(--ax-fs-sm); }
.wsd__t th { text-align: left; font-weight: 400; color: var(--ax-muted); padding: 8px 10px; width: 40%; border-top: 1px solid var(--ax-border); }
.wsd__t td { padding: 8px 10px; border-top: 1px solid var(--ax-border); overflow-wrap: anywhere; }
.wsd__t tr:first-child th, .wsd__t tr:first-child td { border-top: 0; }
.wsd__t s { color: var(--ax-muted); }
.wsd__also { margin: 0; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.wsd__acts { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 640px) {
  .wsf__grid { grid-template-columns: minmax(0, 1fr); }
  .wsb { bottom: 56px; }
}
`
