// --- Hub Settings: approval and request settings (#1428 phase 3) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Advanced script, so it shares
// S.st, stNoteHtml(), stNote(), stVal(), stChecked(), stOptions(),
// stChField(), stGet(), stPaint() and the Hub's esc() and act().
//
// The two settings forms /approvals still held (#1440), with their calls:
//   Inbox › Approvals  where new items go (phone, this computer), expiry,
//                      Later, the daily digest: GET /api/admin/approvals
//                      for the values, POST approvals/settings to save.
//   Requests           open requests and plans: GET
//                      /api/admin/approvals/requests for the values, POST
//                      approvals/requests/settings to save.
// Each save goes under the Settings prefix (wall-actions.ts), so the owner
// guard holds it; board-dashboard.ts hands it to approvals-panel.ts.

export const WALL_SETTINGS_APPROVALS_SCRIPT = String.raw`
  var ST_REACH = [['all', 'Everything new'], ['urgent', 'Only what expires within a day'], ['off', 'Nothing: the Desk and the digest only']];
  /** Reads one of the two, quietly when its section's paint asked for it. */
  async function stApvLoad(which, quiet) {
    S.st[which] = { loading: true };
    if (!quiet) stPaint();
    try {
      var r = await stGet(which === 'apv' ? '/api/admin/approvals' : '/api/admin/approvals/requests');
      S.st[which] = { settings: r.settings || {} };
    } catch (e) { S.st[which] = { error: String(e.message || e) }; }
    stPaint();
  }
  function stApvState(which) {
    var x = S.st[which];
    if (!x) { stApvLoad(which, true); x = S.st[which]; }
    if (x.loading) return '<p class="ax-wall__empty">Loading…</p>';
    if (x.error) return '<p class="wst__err">Could not read them: ' + esc(x.error) + '.</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="apv-load" data-which="' + which + '">Try again</button>';
    return '';
  }
  function stNum(id, label, v, hint) { return stChField(id, label, v == null ? '' : String(v), '', hint); }
  function stCheck(id, label, on) { return '<label class="wsf__check"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '> ' + label + '</label>'; }
  function stCsv(xs) { return (xs || []).join(', '); }

  // --- Inbox › Approvals ---
  function stApprovalsHtml() {
    var wait = stApvState('apv');
    var head = '<section class="wsc"><h3>Approvals</h3><p class="wsj__sub">Where a new answer card goes, how long it waits, and the daily digest.</p>';
    if (wait) return head + wait + '</section>';
    var s = S.st.apv.settings, desk = s.desk || {}, dg = s.digest || {}, d = dg.destination;
    return head + '<form class="wsf" data-st-form="apv">' +
      '<div class="wsf__row"><label>Sent to your phone at once<select id="st-apv-phone">' + stOptions(ST_REACH, desk.phone || 'off') + '</select></label>' +
      '<label>Shown on this computer at once<select id="st-apv-computer">' + stOptions(ST_REACH, desk.computer || 'all') + '</select></label></div>' +
      '<div class="wsf__row">' + stNum('st-apv-expiry', 'Cards expire after (days)', s.defaultExpiryDays) + stNum('st-apv-max', 'Longest a card may wait (days)', s.maxExpiryDays) +
      stNum('st-apv-later', 'Later hides an item for (hours)', s.laterHours) + '</div>' +
      stCheck('st-apv-notify', 'Tell the agent the result', !!s.notifyAgent) + stCheck('st-apv-digest', 'Send one digest a day', !!dg.enabled) +
      '<div class="wsf__row">' + stChField('st-apv-time', 'Digest time (24-hour)', dg.time || '09:00', '09:00') +
      stChField('st-apv-dest', 'Digest goes to', d ? d.channel + ':' + d.chatId : '', 'telegram:123456', '(channel:chat id; empty for the notifications destination)') + '</div>' +
      '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button>' + stNoteHtml('apv') + '</div></form></section>';
  }
  function stApprovalsSave() {
    stApvSave('apv', 'approvals/settings', {
      defaultExpiryDays: Number(stVal('st-apv-expiry')), maxExpiryDays: Number(stVal('st-apv-max')), laterHours: Number(stVal('st-apv-later')),
      notifyAgent: stChecked('st-apv-notify'), deskPhone: stVal('st-apv-phone'), deskComputer: stVal('st-apv-computer'),
      digestEnabled: stChecked('st-apv-digest'), digestTime: stVal('st-apv-time').trim(), destination: stVal('st-apv-dest').trim(),
    });
  }

  // --- Requests ---
  function stRequestsHtml() {
    var head = '<header class="wst__h"><h2>Requests</h2><p>What you ask an agent for is recorded and followed until it is done. These settings were on the Approvals page.</p></header>';
    var wait = stApvState('req');
    if (wait) return head + wait;
    var s = S.st.req.settings, p = s.plans || {}, c = s.checkers || {};
    return head + '<form class="wsf" data-st-form="req"><section class="wsc"><h3>Open requests</h3>' +
        stCheck('st-rq-on', 'Record and follow my requests', !!s.enabled) +
        stChField('st-rq-from', 'Counts as me on shared channels', stCsv(s.from), 'telegram:123456789, github:your-login', '(channel:id, comma-separated)') +
        stChField('st-rq-channels', 'Channels to record on', stCsv(s.channels), 'voice, app, telegram', '(comma-separated; empty for all)') +
        '<div class="wsf__row">' + stNum('st-rq-stale', 'Comes back after (hours without activity)', s.staleAfterHours) + stNum('st-rq-keep', 'Keep closed requests for (days)', s.retentionDays) + '</div>' +
        stCheck('st-rq-headlines', 'Write a headline when the agent gave none (one small model call per request)', !s.headlines || s.headlines.enabled !== false) + '</section>' +
      '<section class="wsc"><h3>Plans</h3>' +
        stCheck('st-rq-plans', 'Follow requests of two or more steps as plans', p.enabled !== false) +
        '<div class="wsf__row">' + stNum('st-rq-stall', 'Nudge a step\'s agent after (minutes without progress)', p.stallMinutes || 30) +
        stNum('st-rq-nudges', 'Nudges per step before you are told it is blocked', p.maxNudges == null ? 3 : p.maxNudges) + '</div>' +
        stChField('st-rq-approve', 'Step kinds you approve once, when the plan is made', stCsv(p.approveKinds), 'message', '(comma-separated)') +
        stChField('st-rq-off', 'Agents that may not open a plan', stCsv(p.disabledAgents), '', '(comma-separated)') +
        stChField('st-rq-work', 'Kinds of work an agent must plan before it starts', stCsv(p.requireForWork), 'code', '(comma-separated; empty for none)') +
        stNum('st-rq-over', 'Work estimated over this many minutes needs a plan', p.requireOverMinutes == null ? 30 : p.requireOverMinutes, '(0: never)') + '</section>' +
      '<section class="wsc"><h3>Loop checks</h3>' +
        stChField('st-rq-checks', 'Checks agents may use to close a loop', stCsv(c.enabled), 'url, issue, git-ancestor, reply', '(comma-separated)') +
        stNum('st-rq-every', 'Run each loop\'s check every (minutes)', c.checkEveryMinutes || 10) + '</section>' +
      '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button>' + stNoteHtml('req') + '</div></form>';
  }
  function stRequestsSave() {
    stApvSave('req', 'approvals/requests/settings', {
      enabled: stChecked('st-rq-on'), from: stVal('st-rq-from'), channels: stVal('st-rq-channels'),
      staleAfterHours: Number(stVal('st-rq-stale')), retentionDays: Number(stVal('st-rq-keep')), headlines: stChecked('st-rq-headlines'),
      plansEnabled: stChecked('st-rq-plans'), stallMinutes: Number(stVal('st-rq-stall')), maxNudges: Number(stVal('st-rq-nudges')),
      approveKinds: stVal('st-rq-approve'), plansOffFor: stVal('st-rq-off'), planForWork: stVal('st-rq-work'), planOverMinutes: Number(stVal('st-rq-over')),
      checkKinds: stVal('st-rq-checks'), checkEveryMinutes: Number(stVal('st-rq-every')),
    });
  }
  async function stApvSave(which, path, body) {
    stNote(which, '', 'Saving…');
    var r = await act('POST', '/api/admin/wall/settings/' + path, body);
    if (!r.ok) { stNote(which, 'err', 'Not saved: ' + r.error); return; }
    S.st[which] = { settings: (r.body && r.body.settings) || S.st[which].settings };
    S.st.notes[which] = { kind: 'ok', text: 'Saved.' };
    stPaint();
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (t && t.getAttribute('data-st-act') === 'apv-load') stApvLoad(t.getAttribute('data-which') === 'req' ? 'req' : 'apv', false);
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form) return;
    var kind = form.getAttribute('data-st-form');
    if (kind === 'apv') { ev.preventDefault(); stApprovalsSave(); }
    else if (kind === 'req') { ev.preventDefault(); stRequestsSave(); }
  });
`
