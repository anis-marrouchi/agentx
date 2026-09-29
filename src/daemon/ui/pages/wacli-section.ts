// --- WhatsApp triage section of the Approvals page (#328) ---
//
// Drafted WhatsApp replies arrive in Approvals, so the chats that produce
// them are set up here too: on/off, the batch window, and the watch rules.
// API: src/daemon/wacli-panel.ts. Client JS avoids backslash escapes: they
// collapse inside this template literal. It reuses the page's $, esc,
// headers and say.

export const WACLI_SECTION_HTML = `
  <details class="apv__settings" id="wac">
    <summary>WhatsApp triage: watched chats</summary>
    <p class="wac__lead">Messages from these chats go to an agent that sorts them. Draft replies wait here for your yes; nothing is sent to a contact without it. <span id="wac-secret"></span></p>
    <form id="wac-form" class="apv__form">
      <label class="apv__check"><input type="checkbox" name="enabled"> Triage is on</label>
      <label>Messages this close together become one task (seconds)<input type="number" min="0" max="600" step="1" name="batchSeconds" required></label>
      <label class="apv__check"><input type="checkbox" name="media"> Read images and voice notes</label>
      <div><button type="submit" class="ax-btn ax-btn--primary">Save</button></div>
    </form>
    <ul id="wac-rules" class="wac__rules" aria-label="Watch rules"></ul>
    <form id="wac-add" class="apv__form">
      <p class="wac__lead">Add a rule. Fill in at least one of chat, sender or group.</p>
      <label>Rule name (lowercase, no spaces)<input type="text" name="ruleId" required pattern="[a-z0-9][a-z0-9_-]*" placeholder="support-team" autocomplete="off"></label>
      <label>Agent<input type="text" name="agent" required placeholder="support" autocomplete="off"></label>
      <label>Chat (phone number or JID)<input type="text" name="chat" placeholder="+1 555 123 4567" autocomplete="off"></label>
      <label>Sender, in any chat (phone number or JID)<input type="text" name="sender" autocomplete="off"></label>
      <label>Group (exact name or JID)<input type="text" name="group" autocomplete="off"></label>
      <label>Instructions for the agent<textarea name="prompt" rows="3" placeholder="Where the tracker is, what counts as a request, which language to reply in"></textarea></label>
      <label>Quiet hours start<input type="time" name="quietStart"></label>
      <label>Quiet hours end<input type="time" name="quietEnd"></label>
      <label class="apv__check"><input type="checkbox" name="autoAck"> Send acknowledgements without asking</label>
      <div><button type="submit" class="ax-btn">Add rule</button></div>
    </form>
  </details>`

export const WACLI_SECTION_CSS = `
.wac__lead { font-size: 12px; color: var(--ax-muted); margin: 8px 0; line-height: 1.5; }
.wac__rules { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 6px; }
.wac__rules li { display: flex; gap: 10px; align-items: center; justify-content: space-between; font-size: 13px; padding: 6px 10px; border: 1px solid var(--ax-border); border-radius: 8px; }
.wac__rules small { color: var(--ax-muted); }
`

export const WACLI_SECTION_SCRIPT = `
function wacFill(w){
  var f = $('wac-form');
  f.enabled.checked = !!w.enabled;
  f.batchSeconds.value = w.batchSeconds;
  f.media.checked = !!w.media;
  $('wac-secret').textContent = w.secretSet ? 'The webhook secret is set.' : 'No webhook secret yet: set ' + w.secretEnv + ' where the daemon runs.';
  var rules = w.rules || [];
  $('wac-rules').innerHTML = rules.length ? rules.map(function(r){
    var match = [r.chat && 'chat ' + r.chat, r.sender && 'sender ' + r.sender, r.group && 'group ' + r.group].filter(Boolean).join(', ');
    var extra = [r.quietHours && 'quiet ' + r.quietHours.start + '-' + r.quietHours.end, r.autoAck && 'sends acknowledgements', r.enabled === false && 'off'].filter(Boolean).join(', ');
    return '<li><span><b>' + esc(r.id) + '</b> ' + esc(match) + ' to ' + esc(r.agent) + (extra ? ' <small>(' + esc(extra) + ')</small>' : '') + '</span>'
      + '<button type="button" class="ax-btn ax-btn--ghost" data-wac-remove="' + esc(r.id) + '">Remove</button></li>';
  }).join('') : '<li><small>No chats watched yet.</small></li>';
}
async function wacCall(path, body){
  var r = await fetch('/api/admin/wacli' + path, body ? { method: 'POST', headers: headers(true), body: JSON.stringify(body) } : { headers: headers(false) });
  var d = await r.json();
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  wacFill(d.wacli);
}
$('wac').addEventListener('toggle', function(){ if ($('wac').open) wacCall('').catch(function(e){ say('Couldn’t load WhatsApp triage: ' + e.message, 'err'); }); });
$('wac-form').addEventListener('submit', function(ev){
  ev.preventDefault();
  var f = ev.target;
  wacCall('/settings', { enabled: f.enabled.checked, batchSeconds: Number(f.batchSeconds.value), media: f.media.checked })
    .then(function(){ say('WhatsApp triage saved.', 'ok'); }, function(e){ say('Not saved: ' + e.message, 'err'); });
});
$('wac-add').addEventListener('submit', function(ev){
  ev.preventDefault();
  var f = ev.target;
  var body = { id: f.ruleId.value, agent: f.agent.value, chat: f.chat.value, sender: f.sender.value, group: f.group.value, prompt: f.prompt.value, quietStart: f.quietStart.value, quietEnd: f.quietEnd.value, autoAck: f.autoAck.checked };
  wacCall('/rules', body).then(function(){ f.reset(); say('Rule saved.', 'ok'); }, function(e){ say('Rule not saved: ' + e.message, 'err'); });
});
$('wac-rules').addEventListener('click', function(ev){
  var b = ev.target.closest && ev.target.closest('[data-wac-remove]');
  if (!b) return;
  wacCall('/rules/remove', { id: b.getAttribute('data-wac-remove') }).then(function(){ say('Rule removed.', 'ok'); }, function(e){ say(e.message, 'err'); });
});
`
