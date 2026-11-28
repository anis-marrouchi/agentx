// --- The Agents manager in the Hub, browser side (#2144) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), act(), getJson(), agmRender(), agentStats() and the Needs you list
// (decAll(), wall-decide.client.ts), Settings' ST_ENGINES, and the
// markup and call plans of wall-agents.ts (agm*).
//
// #page=agents. Anyone sees each agent's status; the owner (the page has
// window.AX_WALL_SETTINGS, wall.ts) also gets New agent, and per agent
// Edit and Pause or Resume, with Test drive and Remove in its "…" menu.
// The form opens in a right Sheet; Remove asks in an alert dialog, and a
// busy agent (the server's 409) is paused and removed once idle. After a
// create the page waits for the restart and for /api/live to report the
// agent, then opens its Test drive. Its saved settings come from GET
// /api/admin/state, read only for the owner; holds and roles come from the
// org view the Hub already reads (S.org).
//
// A field in use is not repainted over (agmTyping), and what is typed is
// kept in AGM.form, so the Hub's refresh does not lose it.

export const WALL_AGENTS_SCRIPT = String.raw`
  var AGM = { state: null, at: 0, loading: false, error: '', open: '', form: {}, note: '', errors: {}, folds: {}, enter: false, flash: '', menu: '', ask: null, removeIdle: {}, test: '', td: null, draft: '', restart: '', waitFor: '', saved: null, force: false };
  var AGM_HELLO = 'Say hello in one line.';
  function agmOwner() { return !!window.AX_WALL_SETTINGS; }
  /** Which agent this machine's Slack and Discord bots answer as now. */
  function agmBound() {
    var st = AGM.state || {};
    return { slack: (st.slack && st.slack.agentBinding) || '', discord: (st.discord && st.discord.agentBinding) || '' };
  }
  /** An agent saved on this machine, from GET /api/admin/state. */
  function agmSaved(id) { return ((AGM.state && AGM.state.agents) || []).find(function (a) { return a.id === id; }) || null; }
  /** Its node in the org view: status (paused, waiting), title. */
  function agmOrgNode(id) {
    var found = null;
    function walk(list) { (list || []).forEach(function (n) { if (n.id === id) found = n; walk(n.reports); }); }
    if (S.org && !S.org.error) { walk(S.org.roots); walk(S.org.outside); }
    return found || {};
  }
  function agmMember(id) {
    return ((S.org && S.org.setup && S.org.setup.members) || []).find(function (m) { return m.ref === 'agent:' + id; }) || null;
  }
  function agmRole(id) { var m = agmMember(id); return (m && (m.title || m.role)) || agmOrgNode(id).title || ''; }
  function agmHold(id) { var s = agmOrgNode(id).status; return s === 'paused' || s === 'waiting' ? s : ''; }
  /** What waits on the owner from this agent: its Needs you cards, or its posts waiting on the owner. */
  function agmNeeds(a) {
    var cards = (typeof decAll === 'function' ? decAll() : []).filter(function (o) { return o.agent === a.id && !o.snoozed; }).length;
    return Math.max(cards, (a.stats && a.stats.owner) || 0);
  }
  function agmStatusOf(a) {
    return agmStatus({ running: a.running || 0, needs: agmNeeds(a), hold: agmHold(a.id), started: (a.nodes || []).length > 0 });
  }
  /** The live agents, and for the owner each saved agent no machine reports yet. */
  function agmMerge(list) {
    if (!AGM.state) return list;
    var seen = {};
    list.forEach(function (a) { seen[a.id] = true; });
    var stats = {};
    agentStats().forEach(function (s) { stats[s.id] = s; });
    (AGM.state.agents || []).forEach(function (s) {
      if (!seen[s.id]) list.push({ id: s.id, name: s.name || s.id, nodes: [], running: 0, errors: 0, lastActive: 0, tier: s.tier, model: s.model, stats: stats[s.id] });
    });
    return list;
  }
  function agmChip(a) { return agmStatusHtml(agmStatusOf(a)); }
  /** Under a card: the owner's buttons and "…" menu, and its test drive when open. */
  function agmTools(a) {
    if (!agmOwner() || !agmSaved(a.id)) return '';
    var html = agmActsHtml(a.id, a.name || a.id, agmStatusOf(a), agmHold(a.id), AGM.menu);
    if (AGM.test === a.id) html += agmTestHtml(a.id, a.name || a.id, AGM.td, AGM.draft);
    return html;
  }
  /** A repaint this page asked for itself: it draws over the open Sheet or dialog. */
  function agmRender() { AGM.force = true; try { render(); } finally { AGM.force = false; } }
  function agmFolders() { return (AGM.state && AGM.state.folders) || { base: '', home: '' }; }
  /** The top: New agent and the restart line; the Sheet and the Remove dialog float over the page. */
  function agmTop() {
    var top = agmHeadHtml(agmOwner(), AGM.flash, AGM.restart, AGM.error, AGM.waitFor);
    if (AGM.open) {
      top += agmFormHtml(AGM.form, AGM.open === 'new' ? 'new' : 'edit', ST_ENGINES,
        { note: AGM.note, bound: agmBound(), errors: AGM.errors, open: AGM.folds, base: agmFolders().base, home: agmFolders().home, enter: AGM.enter });
      AGM.enter = false;
    }
    if (AGM.ask) top += agmRemoveHtml(AGM.ask);
    return top;
  }
  /** A field in use, or the Sheet or the Remove dialog open: the Hub's refresh does not repaint over it. */
  function agmTyping() {
    if (AGM.force) return false;
    var el = document.activeElement;
    return !!(el && el.id && /^agm-/.test(el.id)) || !!AGM.open || !!AGM.ask;
  }
  /** After a create: once /api/live reports the agent on a machine, its Test drive opens with a first message ready. */
  function agmWatchStart() {
    if (!AGM.waitFor) return false;
    var a = agmMerge(allAgents()).find(function (x) { return x.id === AGM.waitFor; });
    if (!a || !(a.nodes || []).length) return false;
    AGM.test = a.id; AGM.td = null; AGM.draft = AGM_HELLO;
    AGM.flash = '@' + a.id + ' started. Send the message below to test it.';
    AGM.waitFor = ''; AGM.restart = '';
    return true;
  }
  /** After the restart is asked: reads /api/live at once, then every 5 s for
   *  up to 5 minutes, until the new agent runs (the live stream repaints only
   *  the side tree on this page). */
  function agmPollStart(left) {
    if (!AGM.waitFor || S.page !== 'agents') return;
    getJson('/api/live?quick=1').then(function (d) {
      S.live = d;
      if (agmWatchStart()) { agmRender(); return; }
      if (left > 0) { setTimeout(function () { agmPollStart(left - 1); }, 5000); return; }
      agmSay('@' + AGM.waitFor + ' has not started after 5 minutes. The daemon log says why: Settings › Diagnostics.');
    }).catch(function (e) {
      if (left > 0) setTimeout(function () { agmPollStart(left - 1); }, 5000);
      else agmSay('Could not read which agents run: ' + (e.message || e) + '.');
    });
  }
  /** Agents the owner chose to remove once idle: removed when none of their tasks runs. */
  function agmWatchIdle() {
    Object.keys(AGM.removeIdle).forEach(function (id) {
      var a = agmMerge(allAgents()).find(function (x) { return x.id === id; });
      if (a && (a.running || 0) > 0) return;
      delete AGM.removeIdle[id];
      agmRemove(id, false);
    });
  }
  async function agmLoad() {
    if (!agmOwner() || AGM.loading) return;
    AGM.loading = true;
    try { AGM.state = await getJson('/api/admin/state'); AGM.error = ''; }
    catch (e) { AGM.error = 'Could not read the agents\' settings: ' + (e.message || e) + '.'; }
    AGM.loading = false; AGM.at = Date.now();
    render();
  }
  /** Called from agmRender() on the Agents page: reads the settings at most every 30 s. */
  function agmEnsure() {
    if (!agmOwner()) return;
    agmWatchStart(); agmWatchIdle();
    if (!AGM.loading && Date.now() - AGM.at > 30000) agmLoad();
  }
  function agmSay(text) { AGM.flash = text; var el = $('agm-n'); if (el) el.textContent = text; }
  function agmFormNote(text) { AGM.note = text; var el = $('agm-n-form'); if (el) el.textContent = text; }
  /** The Sheet again with each field's error under it; focus on the first wrong field. */
  function agmShowErrors(errors, note) {
    AGM.errors = errors || {}; AGM.note = note || '';
    var first = Object.keys(AGM.errors)[0];
    if (AGM.errors.telegramEnv || AGM.errors.discordEnv || AGM.errors.slackBotEnv || AGM.errors.slackAppEnv || AGM.errors.moveSlack || AGM.errors.moveDiscord) AGM.folds.channels = true;
    if (AGM.errors.triggers) AGM.folds.advanced = true;
    agmRender();
    agmFormNote(AGM.note);
    var el = first && $('agm-f-' + first);
    if (el) el.focus();
  }
  function agmCloseSheet() { AGM.open = ''; AGM.form = {}; AGM.note = ''; AGM.errors = {}; AGM.folds = {}; agmRender(); }
  async function agmReload() {
    AGM.at = 0;
    await agmLoad();
    getJson('/api/admin/org').then(function (d) { S.org = d; render(); }).catch(function () {});
  }
  /** Sends the steps in order; stops at the first refusal and says what was saved before it. */
  async function agmRun(plan) {
    var done = [];
    for (var i = 0; i < plan.steps.length; i++) {
      var s = plan.steps[i];
      var r = await act(s.method, s.path, s.body);
      if (!r.ok) return { ok: false, done: done, what: s.what, reason: r.error, field: r.body && r.body.field, error: (done.length ? 'Saved ' + done.join(', ') + '; not ' : 'Not saved ') + s.what + ': ' + r.error };
      done.push(s.what);
    }
    return { ok: true, done: done };
  }
  /** Creates the agent. On a refused step the form stays open with what is
   *  typed; the steps saved before it (AGM.saved) are not sent again when the
   *  owner fixes the field and presses Create agent once more. */
  async function agmCreate() {
    var plan = agmCreateSteps(AGM.form, agmBound());
    if (plan.error) { agmShowErrors(plan.errors, plan.error); return; }
    AGM.errors = {};
    var before = AGM.saved && AGM.saved.id === plan.id ? AGM.saved.done : [];
    var todo = { id: plan.id, steps: plan.steps.filter(function (s) { return before.indexOf(s.what) < 0; }), error: '' };
    agmFormNote('Creating @' + plan.id + '…');
    var r = await agmRun(todo);
    var done = before.concat(r.done);
    if (!r.ok) {
      AGM.saved = done.length ? { id: plan.id, done: done } : null;
      if (done.length) { AGM.restart = 'needed'; agmReload(); }
      var said = (done.length ? 'Saved ' + done.join(', ') + '; not ' : 'Not saved ') + r.what + ': ' + r.reason +
        (done.length ? ' Fix it and press Create agent again: what is saved is not sent again.' : '');
      // A refused workspace (a file, a folder AgentX cannot write) shows under its field.
      if (r.field === 'workspace') agmShowErrors({ workspace: r.reason }, said); else agmFormNote(said);
      return;
    }
    AGM.open = ''; AGM.form = {}; AGM.note = ''; AGM.errors = {}; AGM.folds = {}; AGM.saved = null;
    AGM.restart = 'needed'; AGM.waitFor = plan.id;
    AGM.test = ''; AGM.td = null;
    AGM.flash = 'Created @' + plan.id + '. Restart when idle to start it: its Test drive opens here once it runs.';
    await agmReload();
  }
  async function agmSaveEdit(id) {
    var a = agmSaved(id);
    if (!a) return;
    var plan = agmEditSteps(a, agmRole(id), !!agmMember(id), AGM.form);
    if (plan.error) { if (plan.errors) agmShowErrors(plan.errors, plan.error); else agmFormNote(plan.error); return; }
    agmFormNote('Saving…');
    var r = await agmRun(plan);
    if (!r.ok) { agmFormNote(r.error); if (r.done.length) agmReload(); return; }
    AGM.open = ''; AGM.form = {}; AGM.note = ''; AGM.errors = {}; AGM.folds = {};
    AGM.flash = 'Saved @' + id + ': ' + r.done.join(', ') + '.';
    await agmReload();
  }
  async function agmHoldSet(id, paused) {
    agmSay(paused ? 'Pausing @' + id + '…' : 'Resuming @' + id + '…');
    var r = await act('POST', '/api/admin/wall/settings/org/hold', { agent: id, paused: paused });
    agmSay(r.ok ? (r.body.summary || (paused ? 'Paused.' : 'Resumed.')) : 'Not changed: ' + r.error);
    if (r.ok) await agmReload();
  }
  /** The Remove dialog for an agent: what goes and what stays. */
  function agmAsk(id) {
    var a = agmSaved(id);
    if (!a) return;
    AGM.menu = '';
    AGM.ask = { id: id, name: a.name || id, workspace: a.workspace || '', running: 0 };
    agmRender();
    var go = $('agm-rm-go'); if (go) go.focus();
  }
  /** Removes it. Without force a busy agent comes back as 409 with its
   *  running count, and the dialog offers to pause it and remove it once idle. */
  async function agmRemove(id, force) {
    agmSay('Removing @' + id + '…');
    var r = await act('DELETE', '/api/admin/wall/settings/agents', force ? { id: id, force: true } : { id: id });
    if (!r.ok && r.status === 409 && r.body && r.body.running) {
      var a = agmSaved(id) || { name: id, workspace: '' };
      AGM.ask = { id: id, name: a.name || id, workspace: a.workspace || '', running: r.body.running };
      agmSay(''); agmRender();
      var go = $('agm-rm-go'); if (go) go.focus();
      return;
    }
    AGM.ask = null;
    if (!r.ok) { agmSay('Not removed: ' + r.error); agmRender(); return; }
    if (AGM.test === id) { AGM.test = ''; AGM.td = null; }
    if (AGM.open === 'edit:' + id) AGM.open = '';
    delete AGM.removeIdle[id];
    AGM.restart = 'needed';
    agmSay('Removed @' + id + '. Its workspace folder stays on disk.');
    await agmReload();
  }
  /** Remove once idle: pause it now (no new run starts), remove it when its tasks end. */
  async function agmRemoveWhenIdle(id) {
    AGM.ask = null;
    var r = await act('POST', '/api/admin/wall/settings/org/hold', { agent: id, paused: true });
    if (!r.ok) { agmSay('Not paused: ' + r.error); agmRender(); return; }
    AGM.removeIdle[id] = true;
    agmSay('Paused @' + id + '. It is removed once its tasks end, while this page stays open.');
    await agmReload();
  }
  async function agmRestart() {
    var here = (S.live && S.live.nodes || [])[0];
    if (!here || !here.url) { agmSay('This machine is not in the live list yet; try again in a moment.'); return; }
    agmSay('Asking for a restart…');
    var r = await act('POST', '/api/admin/wall/live/restart?node=' + encodeURIComponent(here.url), {});
    if (!r.ok) { agmSay('Not restarted: ' + r.error); return; }
    AGM.restart = 'asked';
    agmSay('Restart asked.');
    agmRender();
    agmPollStart(60);
  }
  async function agmSend(id) {
    var t = AGM.td && AGM.td.agent === id ? AGM.td : (AGM.td = { agent: id, chatId: 'hub-agents-' + Date.now(), msgs: [], busy: false });
    var box = $('agm-td-text'), text = box ? String(box.value || '').trim() : '';
    if (!text || t.busy) return;
    box.value = ''; AGM.draft = '';
    t.msgs.push({ kind: 'you', text: text }, { kind: 'wait', text: 'Thinking…' });
    t.busy = true;
    agmPaintTest();
    var r = await act('POST', '/api/admin/wall/settings/agents/test', { agent: id, message: text, chatId: t.chatId });
    t.busy = false;
    t.msgs.pop();
    var res = r.ok && r.body.response, err = !r.ok || (res && res.error);
    t.msgs.push({ kind: err ? 'err' : 'agent', text: r.ok ? (res && (res.content || res.error)) || '(no answer)' : r.error });
    agmPaintTest();
  }
  function agmPaintTest() { var log = $('agm-td-log'); if (log) log.innerHTML = agmTestLogHtml(AGM.td); }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'agents') return;
    var t = ev.target.closest('[data-agm-act]');
    if (!t) return;
    var k = t.getAttribute('data-agm-act'), id = t.getAttribute('data-id');
    if (k !== 'menu') AGM.menu = '';
    var opened = function () { AGM.enter = true; AGM.menu = ''; AGM.errors = {}; AGM.folds = {}; AGM.note = ''; agmRender(); var f = $('agm-f-name'); if (f) f.focus(); };
    if (k === 'new') { AGM.open = 'new'; AGM.form = { tier: 'claude-code' }; AGM.saved = null; opened(); }
    else if (k === 'edit') { var a = agmSaved(id); if (!a) return; AGM.open = 'edit:' + id; AGM.form = agmFormOf(a, agmRole(id)); opened(); }
    else if (k === 'close') { if (AGM.open) agmCloseSheet(); else { AGM.test = ''; AGM.draft = ''; agmRender(); } }
    else if (k === 'menu') { AGM.menu = AGM.menu === id ? '' : id; agmRender(); var m = AGM.menu && document.querySelector('#agm-menu [role=menuitem]'); if (m) m.focus(); }
    else if (k === 'pause' || k === 'resume') agmHoldSet(id, k === 'pause');
    else if (k === 'test') { AGM.menu = ''; AGM.test = id; AGM.draft = ''; agmRender(); }
    else if (k === 'send') agmSend(id);
    else if (k === 'ask') agmAsk(id);
    else if (k === 'cancel') { AGM.ask = null; agmRender(); }
    else if (k === 'remove') agmRemove(id, false);
    else if (k === 'remove-now') agmRemove(id, true);
    else if (k === 'remove-idle') agmRemoveWhenIdle(id);
    else if (k === 'restart') agmRestart();
  });
  // A click anywhere but on one of this page's buttons closes the open "…" menu
  // (its own buttons set the menu themselves).
  document.addEventListener('click', function (ev) {
    if (S.page !== 'agents' || !AGM.menu || ev.target.closest('[data-agm-act]')) return;
    AGM.menu = ''; agmRender();
  }, true);
  // The folds keep their state across repaints.
  document.addEventListener('toggle', function (ev) {
    var d = ev.target, k = d && d.getAttribute && d.getAttribute('data-agm-fold');
    if (k) AGM.folds[k] = d.open;
  }, true);
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-agm-form]');
    if (!form) return;
    ev.preventDefault();
    if (form.getAttribute('data-agm-form') === 'new') agmCreate(); else agmSaveEdit(form.getAttribute('data-id'));
  });
  document.addEventListener('input', function (ev) {
    var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-agm-f');
    if (k) AGM.form[k] = t.type === 'checkbox' ? !!t.checked : t.value;
    // The id the name gives shows as it is typed (the form is not repainted then).
    var idBox = k === 'name' && $('agm-f-id');
    if (idBox) idBox.placeholder = agmSlug(t.value) || 'sales';
    // Where the workspace resolves, as it is typed.
    var ws = (k === 'workspace' || k === 'name' || k === 'id') && $('agm-ws');
    if (ws) ws.innerHTML = agmWorkspaceLine(AGM.form, agmFolders().base, agmFolders().home);
    var mh = k === 'model' && $('agm-model-help');
    if (mh) mh.textContent = agmModelHelp(t.value);
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-agm-f');
    if (k) AGM.form[k] = t.type === 'checkbox' ? !!t.checked : t.value;
    // A new engine offers its own models.
    if (k === 'tier' && AGM.open) agmRender();
  });
  document.addEventListener('keydown', function (ev) {
    if (S.page !== 'agents' || !ev.target) return;
    if (ev.target.id === 'agm-td-text' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); agmSend(AGM.test); }
    else if (ev.key === 'Escape' && AGM.ask) { ev.preventDefault(); AGM.ask = null; agmRender(); }
    else if (ev.key === 'Escape' && AGM.menu) { ev.preventDefault(); var id = AGM.menu; AGM.menu = ''; agmRender(); var b = document.querySelector('[data-agm-act=menu][data-id="' + id + '"]'); if (b) b.focus(); }
    else if (ev.key === 'Escape' && AGM.open) { ev.preventDefault(); agmCloseSheet(); }
  });
`

// orca-design: the form is a right Sheet (C13), 300 ms in, no motion when
// reduced; one primary button; errors in red under the field; the "…" menu
// is the Hub's .ha-menu, placed under its button; Remove reuses Settings'
// dialog (.wsd) as an alert dialog.
export const WALL_AGENTS_CSS = `
.agm-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px 0; }
.agm-restart { margin: 8px 16px 0; padding: 8px 12px; border-radius: var(--ax-radius); background: var(--ax-amber-t); color: var(--ax-amber-ink); font-size: var(--ax-fs-sm); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.agm-td { margin: 12px 16px; padding: 12px 14px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); }
.wag .agm-td { margin: 10px 0 0; }
.agm-td h3 { margin: 0 0 6px; font-size: 15px; }
.agm-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.agm-acts .ax-btn { font-size: var(--ax-fs-xs); padding: 3px 10px; }
.agm-more { position: relative; display: inline-flex; }
.agm-more .ha__act { width: 28px; height: 28px; }
.agm-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 176px; animation: agm-pop 150ms ease-out; }
@keyframes agm-pop { from { opacity: 0; transform: scale(.98); } }
.agm-sheet { position: fixed; inset: 0; z-index: 40; display: flex; justify-content: flex-end; }
.agm-sheet__scrim { position: absolute; inset: 0; border: 0; padding: 0; background: rgb(0 0 0 / 35%); cursor: default; }
.agm-sheet__panel { position: relative; display: flex; flex-direction: column; width: min(440px, 100%); height: 100%; margin: 0; background: var(--ax-bg); color: var(--ax-text); border-left: 1px solid var(--ax-border); box-shadow: var(--ax-shadow-lg); }
.agm-sheet.is-enter .agm-sheet__panel { animation: agm-in 300ms cubic-bezier(.32,.72,0,1); }
.agm-sheet.is-enter .agm-sheet__scrim { animation: agm-fade 300ms ease-out; }
@keyframes agm-in { from { transform: translateX(100%); } }
@keyframes agm-fade { from { opacity: 0; } }
.agm-sheet__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 48px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--ax-border); flex: none; }
.agm-sheet__head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.agm-sheet__body { flex: 1 1 auto; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.agm-sheet__foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--ax-border); flex: none; }
.agm-sheet__foot .wdo__n { margin-right: auto; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.agm-fld { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.agm-fld > label, .agm-lbl { font-size: var(--ax-fs-sm); font-weight: 500; }
.agm-fld input:not([type=checkbox]), .agm-fld select, .agm-fld textarea { width: 100%; box-sizing: border-box; font-size: 16px; }
@media (min-width: 768px) { .agm-fld input:not([type=checkbox]), .agm-fld select, .agm-fld textarea { font-size: var(--ax-fs-sm); } }
.agm-fld [aria-invalid="true"] { border-color: var(--ax-red-ink); }
.agm-mono, .agm-path, .agm-help code { font-family: var(--ax-mono); }
.agm-path { font-size: var(--ax-fs-xs); overflow-wrap: anywhere; }
.agm-help { margin: 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); overflow-wrap: anywhere; }
.agm-err { margin: 0; font-size: var(--ax-fs-xs); color: var(--ax-red-ink); }
.agm-fold { border-top: 1px solid var(--ax-border); padding-top: 10px; }
.agm-fold[open] > .axp-fold__h { margin-bottom: 10px; }
.agm-fold > :not(summary) + :not(summary) { margin-top: 12px; }
.agm-rm .wsd__box p { margin: 0; font-size: var(--ax-fs-sm); }
.agm-rm .wsd__box h3 { font-size: 17px; font-weight: 600; }
.agm-rm .wsd__acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 640px) { .agm-sheet__panel { width: 100%; border-left: 0; } }
@media (prefers-reduced-motion: reduce) { .agm-sheet.is-enter .agm-sheet__panel, .agm-sheet.is-enter .agm-sheet__scrim, .agm-menu { animation: none; } }
`
