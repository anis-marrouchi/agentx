// --- Wall Settings: Schedules and Webhooks (#1428 phase 2) ---
//
// Spliced into WALL_SETTINGS_SCRIPT, so it shares that script's S.st,
// stNoteHtml(), stNote(), stVal(), stOptions(), stConfirmHtml(),
// settingsLoad() and the Wall's esc(), act() and axCronValueHtml().
//
// Each section does what its classic /admin tab does, with the same calls
// under the Settings prefix (wall-actions.ts), so the owner guard holds:
//   Schedules  list (when, agent, prompt, value line), add with a live
//              preview of the next runs, delete after a confirm.
//   Webhooks   list (source, agent, secret, URL to copy, receiving or not),
//              add, turn on/off, delete after a confirm, and the routing:
//              event-type triggers and the default workflow.
// The classic guided builder becomes presets that fill the cron field.
// WhatsApp triage, on the classic Webhooks tab, moves with Channels.
// Phase 3: the classic Schedules tab's Wiki notes inbox, below the
// schedules: on/off, the inbox agent, the schedules and the absorb pass
// that read it (POST wiki-notes), and the recent notes (a read).

export const WALL_SETTINGS_JOBS_SCRIPT = String.raw`
  /** Presets for the schedule field, as the classic guided builder offers. */
  var ST_CRON_PRESETS = [['0 9 * * *', 'Every day at 9:00'], ['0 9 * * 1-5', 'Weekdays at 9:00'], ['0 9 * * 1', 'Mondays at 9:00'], ['0 * * * *', 'Every hour'], ['*/15 * * * *', 'Every 15 minutes']];
  /** Webhook sources, in the classic order: id, label, where its secret is set. */
  var ST_WH_SOURCES = [['gitlab', 'GitLab'], ['github', 'GitHub'], ['sentry', 'Sentry'], ['stripe', 'Stripe'], ['vercel', 'Vercel'], ['odoo', 'Odoo'],
    ['hubspot', 'HubSpot'], ['discord', 'Discord'], ['slack', 'Slack'], ['custom', 'Custom']];
  var stCronPreviewTimer = null;

  function stAgentOptions(current) {
    return stOptions(((S.st.data && S.st.data.agents) || []).map(function (a) { return [a.id, (a.name || a.id) + ' (' + a.id + ')']; }), current);
  }

  // --- Schedules ---
  function stCronsHtml() {
    var list = (S.st.data && S.st.data.crons) || [];
    var rows = list.length ? '<ul class="wsj">' + list.map(function (c) {
      var k = 'cron:' + c.id;
      return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(c.id) + '</b> <code>' + esc(c.schedule) + '</code> <small>runs @' + esc(c.agent) + '</small>' +
        (c.prompt ? '<p class="wsj__sub">' + esc(c.prompt.length > 120 ? c.prompt.slice(0, 120) + '…' : c.prompt) + '</p>' : '') +
        '<p class="wsj__sub">' + axCronValueHtml(c.value, esc) + '</p></div>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Delete</button>' +
        stConfirmHtml(k, 'Delete the schedule <b>' + esc(c.id) + '</b>? It stops running.', 'Delete ' + c.id) + '</li>';
    }).join('') + '</ul>' : '<p class="ax-wall__empty">No schedules yet. Add one below to have an agent do something on a timer.</p>';
    return '<header class="wst__h"><h2>Schedules</h2><p>Make an agent do something on a timer: daily summaries, weekly reports, hourly checks.</p></header>' +
      stNoteHtml('cron') + rows +
      '<details class="wsc" open><summary><h3>Add a schedule</h3></summary>' +
      '<form class="wsf" data-st-form="cron">' +
        '<label>Name<input id="st-c-id" placeholder="weekly-report" autocomplete="off"></label>' +
        '<label>Agent<select id="st-c-agent">' + stAgentOptions('') + '</select></label>' +
        '<label>When <small>(five-field cron, in the machine\'s time zone)</small><input id="st-c-schedule" placeholder="0 9 * * 1" autocomplete="off" data-st-cron></label>' +
        '<div class="wsj__presets">' + ST_CRON_PRESETS.map(function (p) { return '<button type="button" class="ax-chip" data-st-act="cron-preset" data-cron="' + esc(p[0]) + '">' + esc(p[1]) + '</button>'; }).join('') + '</div>' +
        '<p class="wsj__sub" id="st-c-preview" aria-live="polite"></p>' +
        '<label>What to do<textarea id="st-c-prompt" rows="3" placeholder="Send me this week\'s numbers."></textarea></label>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add schedule</button>' + stNoteHtml('cron-add') + '</div>' +
      '</form></details>';
  }
  function stCronPreviewSoon() {
    if (stCronPreviewTimer) clearTimeout(stCronPreviewTimer);
    stCronPreviewTimer = setTimeout(stCronPreview, 300);
  }
  async function stCronPreview() {
    var box = $('st-c-preview'), expr = stVal('st-c-schedule').trim();
    if (!box) return;
    if (!expr) { box.textContent = ''; return; }
    var r = await act('POST', '/api/admin/wall/settings/crons/preview', { schedule: expr });
    if (!$('st-c-preview') || stVal('st-c-schedule').trim() !== expr) return;
    if (!r.ok) { box.className = 'wsj__sub wst__err'; box.textContent = r.error; return; }
    var next = (r.body.next || []).slice(0, 3).map(function (iso) { return new Date(iso).toLocaleString(); });
    box.className = 'wsj__sub';
    box.innerHTML = '<b>' + esc(r.body.human || expr) + '</b>' + (next.length ? ' · next (' + esc(r.body.timezone || '') + '): ' + next.map(esc).join(' · ') : '');
  }
  async function stAddCron() {
    var body = { id: stVal('st-c-id').trim(), schedule: stVal('st-c-schedule').trim(), agent: stVal('st-c-agent'), prompt: stVal('st-c-prompt').trim() };
    stNote('cron-add', '', 'Adding…');
    var r = await act('POST', '/api/admin/wall/settings/crons', body);
    if (!r.ok) { stNote('cron-add', 'err', 'Not added: ' + r.error); return; }
    S.st.notes.cron = { kind: 'ok', text: r.body.summary || 'Added ' + body.id + '.' };
    await settingsLoad();
  }

  // --- Wiki notes inbox (classic Schedules tab) ---
  function stWikiNotesHtml() {
    var d = S.st.data || {}, n = d.wikiNotes || {}, picked = n.crons || [], crons = d.crons || [], l = S.st.wnList;
    var agents = '<datalist id="st-wn-agents">' + (d.agents || []).map(function (a) { return '<option value="' + esc(a.id) + '"></option>'; }).join('') + '</datalist>';
    var list = !l ? '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="wn-list">Show recent notes</button>'
      : l.loading ? '<p class="ax-wall__empty">Loading…</p>'
      : l.error ? '<p class="wst__err">Could not read them: ' + esc(l.error) + '</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="wn-list">Try again</button>'
      : l.notes.length ? '<ul class="wsj__trig">' + l.notes.map(function (x) {
          return '<li><b>' + esc(x.status) + '</b> <code>' + esc(x.id) + '</code> <small>from ' + esc(x.from) + ' · ' + esc(x.date) + '</small><p class="wsj__sub">' + esc(x.change) + '</p>' +
            (x.handled ? '<p class="wsj__sub">' + esc(x.handled.outcome) + ' by ' + esc(x.handled.by) + ': ' + esc(x.handled.reason) + '</p>' : '') + '</li>';
        }).join('') + '</ul>' : '<p class="ax-wall__empty">No notes on this machine.</p>';
    return '<section class="wsc"><h3>Wiki notes inbox ' + stChState(n.enabled) + '</h3>' +
      '<p class="wsj__sub">Agents leave short notes (what changed, the source, the date) for the agent that runs your wiki schedule. The schedules and the absorb pass you pick read them first. The same as <code>agentx wiki notes config</code>.</p>' +
      '<form class="wsf" data-st-form="wn">' + agents +
        '<label class="wsf__check"><input type="checkbox" id="st-wn-on"' + (n.enabled ? ' checked' : '') + '> Wiki notes on</label>' +
        '<label>Inbox agent <small>(runs the wiki schedule; may be on another machine)</small><input id="st-wn-inbox" list="st-wn-agents" value="' + esc(n.inbox || '') + '" placeholder="agent id" autocomplete="off"></label>' +
        '<fieldset class="wst-scopes"><legend>Schedules on this machine that read the inbox</legend>' + (crons.length ? crons.map(function (c, i) {
          return '<label class="wsf__check"><input type="checkbox" id="st-wn-cron-' + i + '"' + (picked.indexOf(c.id) >= 0 ? ' checked' : '') + '> <code>' + esc(c.id) + '</code> runs as @' + esc(c.agent || '?') + '</label>';
        }).join('') : '<p class="wsf__hint">No schedules on this machine.</p>') + '</fieldset>' +
        '<label>Absorb that reads the inbox <small>(the agent whose wiki absorb pass answers the notes; empty for none)</small><input id="st-wn-absorb" list="st-wn-agents" value="' + esc(n.absorbAgent || '') + '" placeholder="agent id" autocomplete="off"></label>' +
        '<div class="wsf__row">' + stChField('st-wn-max', 'Most notes per run', String(n.maxNotesPerRun || 20), '20', '(1 to 100)') +
        stChField('st-wn-defer', 'Deferrals before a note expires', String(n.maxDeferrals || 3), '3', '(1 to 20)') + '</div>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button>' + stNoteHtml('wn') + '</div></form>' +
      '<h4>Recent notes</h4>' + list + '</section>';
  }
  function stWikiNotesSave() {
    var crons = ((S.st.data && S.st.data.crons) || []).filter(function (c, i) { return stChecked('st-wn-cron-' + i); }).map(function (c) { return c.id; });
    stSetSave('wn', 'POST', 'wiki-notes', {
      enabled: stChecked('st-wn-on'), inbox: stVal('st-wn-inbox').trim(), crons: crons, absorbAgent: stVal('st-wn-absorb').trim(),
      maxNotesPerRun: Number(stVal('st-wn-max')), maxDeferrals: Number(stVal('st-wn-defer')),
    });
  }
  async function stWikiNotesList() {
    S.st.wnList = { loading: true };
    stPaint();
    try { S.st.wnList = { notes: (await stGet('/api/admin/wiki-notes/list')).notes || [] }; }
    catch (e) { S.st.wnList = { error: String(e.message || e) }; }
    stPaint();
  }

  // --- Webhooks ---
  function stHookUrl(w) {
    var base = String((S.st.data && S.st.data.daemonUrl) || '').replace(/\/+$/, '');
    return base + '/webhook/' + encodeURIComponent(w.agentId) + '/' + encodeURIComponent(w.source);
  }
  function stHooksHtml() {
    var list = (S.st.data && S.st.data.webhooks) || [];
    var rows = list.length ? '<ul class="wsj">' + list.map(function (w) {
      var k = 'wh:' + w.id, url = stHookUrl(w), missing = w.source !== 'custom' && !w.secretEnv;
      var state = missing ? '<span class="wsj__pill is-warn">signing secret missing</span>' : w.enabled ? '<span class="wsj__pill is-ok">receiving</span>' : '<span class="wsj__pill">off</span>';
      var label = (ST_WH_SOURCES.find(function (s) { return s[0] === w.source; }) || [w.source, w.source])[1];
      var trig = w.triggers && typeof w.triggers === 'object' ? w.triggers : {};
      var trigRows = Object.keys(trig).map(function (evt) {
        return '<li><code>' + esc(evt) + ' → ' + esc(trig[evt]) + '</code> <button type="button" class="ax-btn ax-btn--ghost" data-st-act="wh-trig-rm" data-id="' + esc(w.id) + '" data-event="' + esc(evt) + '">Remove</button></li>';
      }).join('');
      return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(w.id) + '</b> ' + state +
        '<p class="wsj__sub">' + esc(label) + ' · goes to @' + esc(w.agentId) + (w.secretEnv ? ' · secret: <code>\${' + esc(w.secretEnv) + '}</code>' : '') + (w.description ? ' · ' + esc(w.description) : '') + '</p>' +
        '<p class="wsj__url"><span>POST</span> <code>' + esc(url) + '</code> <button type="button" class="ax-btn ax-btn--ghost" data-st-act="wh-copy" data-url="' + esc(url) + '">Copy</button></p>' +
        '<details class="wsj__route" data-st-wh="' + esc(w.id) + '"' + (S.st.whOpen === w.id ? ' open' : '') + '><summary>Routing: event triggers and the default workflow</summary>' +
          (trigRows ? '<ul class="wsj__trig">' + trigRows + '</ul>' : '<p class="wsj__sub">No triggers: every event runs the default workflow.</p>') +
          '<form class="wsj__inline" data-st-form="wh-trig" data-id="' + esc(w.id) + '"><input id="st-wt-ev-' + esc(w.id) + '" placeholder="event type, e.g. issues.opened" aria-label="Event type">' +
          '<input id="st-wt-wf-' + esc(w.id) + '" placeholder="workflow id" aria-label="Workflow id"><button type="submit" class="ax-btn">Add trigger</button></form>' +
          '<form class="wsj__inline" data-st-form="wh-default" data-id="' + esc(w.id) + '"><input id="st-wd-' + esc(w.id) + '" value="' + esc(w.defaultWorkflow || '') + '" placeholder="(none)" aria-label="Default workflow">' +
          '<button type="submit" class="ax-btn">Save default</button></form>' +
        '</details></div>' +
        '<div class="wsj__acts"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="wh-toggle" data-id="' + esc(w.id) + '">' + (w.enabled ? 'Turn off' : 'Turn on') + '</button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Delete</button></div>' +
        stConfirmHtml(k, 'Delete the webhook <b>' + esc(w.id) + '</b>? Calls to its address stop working.', 'Delete ' + w.id) + '</li>';
    }).join('') + '</ul>' : '<p class="ax-wall__empty">No webhooks yet. Add one below and paste its address into the other service.</p>';
    return '<header class="wst__h"><h2>Webhooks</h2><p>Addresses other services (GitHub, Stripe, Sentry…) call when something happens, each going to an agent.</p></header>' +
      stNoteHtml('wh') + rows +
      '<details class="wsc" open><summary><h3>Add a webhook</h3></summary>' +
      '<form class="wsf" data-st-form="wh">' +
        '<label>Name <small>(lowercase)</small><input id="st-w-id" placeholder="main-repo" autocomplete="off"></label>' +
        '<label>Source<select id="st-w-source">' + stOptions(ST_WH_SOURCES, 'gitlab') + '</select></label>' +
        '<label>Agent<select id="st-w-agent">' + stAgentOptions('') + '</select></label>' +
        '<label>Signing secret, as an environment variable name <small>(optional)</small><input id="st-w-secret" placeholder="GITLAB_WEBHOOK_SECRET" autocomplete="off"></label>' +
        '<label>Description <small>(optional)</small><input id="st-w-desc" autocomplete="off"></label>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add webhook</button>' + stNoteHtml('wh-add') + '</div>' +
      '</form></details>';
  }
  function stHookOf(id) { return ((S.st.data && S.st.data.webhooks) || []).find(function (w) { return w.id === id; }); }
  async function stAddHook() {
    var body = { id: stVal('st-w-id').trim(), source: stVal('st-w-source'), agentId: stVal('st-w-agent'), secretEnv: stVal('st-w-secret').trim(), description: stVal('st-w-desc').trim() };
    stNote('wh-add', '', 'Adding…');
    var r = await act('POST', '/api/admin/wall/settings/webhooks', body);
    if (!r.ok) { stNote('wh-add', 'err', 'Not added: ' + r.error); return; }
    S.st.notes.wh = { kind: 'ok', text: r.body.summary || 'Added ' + body.id + '.' };
    await settingsLoad();
  }
  async function stToggleHook(id) {
    var w = stHookOf(id);
    if (!w) return;
    stNote('wh', '', w.enabled ? 'Turning off…' : 'Turning on…');
    var r = await act('PATCH', '/api/admin/wall/settings/webhooks', { id: id, patch: { enabled: !w.enabled } });
    if (!r.ok) { stNote('wh', 'err', 'Not changed: ' + r.error); return; }
    S.st.notes.wh = { kind: 'ok', text: id + (w.enabled ? ' is off: calls to it are refused.' : ' is on: it receives calls.') };
    await settingsLoad();
  }
  async function stHookRouting(id, patch, done) {
    S.st.whOpen = id;
    stNote('wh', '', 'Saving…');
    var r = await act('POST', '/api/admin/wall/settings/webhooks/triggers', Object.assign({ id: id }, patch));
    if (!r.ok) { stNote('wh', 'err', 'Not saved: ' + r.error); return; }
    S.st.notes.wh = { kind: 'ok', text: done };
    await settingsLoad();
  }
  function stHookTriggers(id) {
    var w = stHookOf(id);
    return Object.assign({}, (w && w.triggers && typeof w.triggers === 'object') ? w.triggers : {});
  }

  /** Confirmed deletes of this file's sections; false for any other key. */
  async function stJobsConfirmed(key) {
    var cron = key.indexOf('cron:') === 0, wh = key.indexOf('wh:') === 0;
    if (!cron && !wh) return false;
    var id = key.slice(cron ? 5 : 3), note = cron ? 'cron' : 'wh';
    stPaint();
    stNote(note, '', 'Deleting…');
    var r = await act('DELETE', '/api/admin/wall/settings/' + (cron ? 'crons' : 'webhooks'), { id: id });
    if (!r.ok) { stNote(note, 'err', 'Not deleted: ' + r.error); return true; }
    S.st.notes[note] = { kind: 'ok', text: 'Deleted ' + id + '.' };
    await settingsLoad();
    return true;
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (!t) return;
    var a = t.getAttribute('data-st-act'), id = t.getAttribute('data-id');
    if (a === 'wn-list') { stWikiNotesList(); return; }
    if (a === 'cron-preset') { var f = $('st-c-schedule'); if (f) { f.value = t.getAttribute('data-cron'); stCronPreview(); } }
    else if (a === 'wh-toggle') stToggleHook(id);
    else if (a === 'wh-copy') {
      var url = t.getAttribute('data-url');
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { stNote('wh', 'ok', 'Address copied.'); }, function () { stNote('wh', 'err', 'Could not copy: select the address and copy it.'); });
    }
    else if (a === 'wh-trig-rm') {
      var trig = stHookTriggers(id), evt = t.getAttribute('data-event');
      delete trig[evt];
      stHookRouting(id, { triggers: trig }, 'Removed the trigger for ' + evt + '.');
    }
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form) return;
    var kind = form.getAttribute('data-st-form'), id = form.getAttribute('data-id');
    if (kind !== 'cron' && kind !== 'wn' && kind.indexOf('wh') !== 0) return;
    ev.preventDefault();
    if (kind === 'cron') stAddCron();
    else if (kind === 'wn') stWikiNotesSave();
    else if (kind === 'wh') stAddHook();
    else if (kind === 'wh-trig') {
      var evt = stVal('st-wt-ev-' + id).trim(), wf = stVal('st-wt-wf-' + id).trim();
      if (!evt || !wf) { stNote('wh', 'err', 'Write the event type and the workflow id.'); return; }
      var trig = stHookTriggers(id);
      trig[evt] = wf;
      stHookRouting(id, { triggers: trig }, evt + ' now runs ' + wf + '.');
    }
    else if (kind === 'wh-default') {
      var d = stVal('st-wd-' + id).trim();
      stHookRouting(id, { defaultWorkflow: d }, d ? 'Default workflow: ' + d + '.' : 'No default workflow.');
    }
  });
  document.addEventListener('input', function (ev) {
    if (S.page === 'settings' && ev.target && ev.target.hasAttribute && ev.target.hasAttribute('data-st-cron')) stCronPreviewSoon();
  });
  document.addEventListener('toggle', function (ev) {
    var d = ev.target, id = d && d.getAttribute && d.getAttribute('data-st-wh');
    if (id) S.st.whOpen = d.open ? id : (S.st.whOpen === id ? '' : S.st.whOpen);
  }, true);
`

export const WALL_SETTINGS_JOBS_CSS = `
.wsj { list-style: none; margin: 0 0 18px; padding: 0; display: grid; gap: 10px; }
.wsj__row { border: 1px solid var(--ax-border); border-radius: 10px; padding: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
.wsj__main { flex: 1 1 260px; min-width: 0; }
.wsj__acts { display: flex; gap: 6px; flex-wrap: wrap; }
.wsj__row .wsk { flex-basis: 100%; }
.wsj__sub { margin: 4px 0 0; color: var(--ax-text-2); font-size: 13px; overflow-wrap: anywhere; }
.wsj__pill { font-size: 11px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--ax-border); color: var(--ax-text-2); }
.wsj__pill.is-ok { color: var(--ax-ok, #27ae60); border-color: currentColor; }
.wsj__pill.is-warn { color: var(--ax-warn, #b7791f); border-color: currentColor; }
.wsj__url { display: flex; gap: 6px; align-items: center; margin: 8px 0 0; font-size: 12px; min-width: 0; }
.wsj__url code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsj__route { margin-top: 8px; font-size: 13px; }
.wsj__route summary { cursor: pointer; color: var(--ax-accent); }
.wsj__trig { list-style: none; padding: 0; margin: 6px 0; }
.wsj__inline { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.wsj__inline input { flex: 1 1 140px; min-width: 0; }
.wsj__presets { display: flex; flex-wrap: wrap; gap: 6px; }
`
