// --- The Agents manager in the Hub, browser side (#2144) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), act(), getJson(), render(), agentStats() and the Needs you list
// (decAll(), wall-decide.client.ts), Settings' ST_ENGINES, and the
// markup and call plans of wall-agents.ts (agm*).
//
// #page=agents. Anyone sees each agent's status; the owner (the page has
// window.AX_WALL_SETTINGS, wall.ts) also gets New agent, and per agent
// Edit, Pause or Resume, Test drive and Remove. Its saved settings come
// from GET /api/admin/state, read only for the owner; holds and roles come
// from the org view the Hub already reads (S.org).
//
// A field in use is not repainted over (agmTyping), and what is typed is
// kept in AGM.form, so the Hub's refresh does not lose it.

export const WALL_AGENTS_SCRIPT = String.raw`
  var AGM = { state: null, at: 0, loading: false, error: '', open: '', form: {}, note: '', flash: '', confirm: '', test: '', td: null, restart: '', saved: null };
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
  /** Under a card: the owner's buttons, and the edit form or test drive when open. */
  function agmTools(a) {
    if (!agmOwner() || !agmSaved(a.id)) return '';
    var html = agmActsHtml(a.id, a.name || a.id, agmStatusOf(a), agmHold(a.id), AGM.confirm);
    if (AGM.open === 'edit:' + a.id) html += agmFormHtml(AGM.form, 'edit', ST_ENGINES, AGM.note);
    if (AGM.test === a.id) html += agmTestHtml(a.id, a.name || a.id, AGM.td);
    return html;
  }
  function agmTop() {
    var top = agmHeadHtml(agmOwner(), AGM.flash, AGM.restart, AGM.error);
    return top + (AGM.open === 'new' ? agmFormHtml(AGM.form, 'new', ST_ENGINES, AGM.note, agmBound()) : '');
  }
  function agmTyping() {
    var el = document.activeElement;
    return !!(el && el.id && /^agm-/.test(el.id));
  }
  async function agmLoad() {
    if (!agmOwner() || AGM.loading) return;
    AGM.loading = true;
    try { AGM.state = await getJson('/api/admin/state'); AGM.error = ''; }
    catch (e) { AGM.error = 'Could not read the agents\' settings: ' + (e.message || e) + '.'; }
    AGM.loading = false; AGM.at = Date.now();
    render();
  }
  /** Called from render() on the Agents page: reads the settings at most every 30 s. */
  function agmEnsure() { if (agmOwner() && !AGM.loading && Date.now() - AGM.at > 30000) agmLoad(); }
  function agmSay(text) { AGM.flash = text; var el = $('agm-n'); if (el) el.textContent = text; }
  function agmFormNote(text) { AGM.note = text; var el = $('agm-n-form'); if (el) el.textContent = text; }
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
      if (!r.ok) return { ok: false, done: done, what: s.what, reason: r.error, error: (done.length ? 'Saved ' + done.join(', ') + '; not ' : 'Not saved ') + s.what + ': ' + r.error };
      done.push(s.what);
    }
    return { ok: true, done: done };
  }
  /** Creates the agent. On a refused step the form stays open with what is
   *  typed; the steps saved before it (AGM.saved) are not sent again when the
   *  owner fixes the field and presses Create agent once more. */
  async function agmCreate() {
    var plan = agmCreateSteps(AGM.form, agmBound());
    if (plan.error) { agmFormNote(plan.error); return; }
    var before = AGM.saved && AGM.saved.id === plan.id ? AGM.saved.done : [];
    var todo = { id: plan.id, steps: plan.steps.filter(function (s) { return before.indexOf(s.what) < 0; }), error: '' };
    agmFormNote('Creating @' + plan.id + '…');
    var r = await agmRun(todo);
    var done = before.concat(r.done);
    if (!r.ok) {
      AGM.saved = done.length ? { id: plan.id, done: done } : null;
      if (done.length) { AGM.restart = 'needed'; agmReload(); }
      agmFormNote((done.length ? 'Saved ' + done.join(', ') + '; not ' : 'Not saved ') + r.what + ': ' + r.reason +
        (done.length ? ' Fix it and press Create agent again: what is saved is not sent again.' : ''));
      return;
    }
    AGM.open = ''; AGM.form = {}; AGM.note = ''; AGM.saved = null;
    AGM.restart = 'needed';
    AGM.test = plan.id; AGM.td = null;
    AGM.flash = 'Created @' + plan.id + '. Restart when idle to start it, then test drive it below.';
    await agmReload();
  }
  async function agmSaveEdit(id) {
    var a = agmSaved(id);
    if (!a) return;
    var plan = agmEditSteps(a, agmRole(id), !!agmMember(id), AGM.form);
    if (plan.error) { agmFormNote(plan.error); return; }
    agmFormNote('Saving…');
    var r = await agmRun(plan);
    if (!r.ok) { agmFormNote(r.error); if (r.done.length) agmReload(); return; }
    AGM.open = ''; AGM.form = {}; AGM.note = '';
    AGM.flash = 'Saved @' + id + ': ' + r.done.join(', ') + '.';
    await agmReload();
  }
  async function agmHoldSet(id, paused) {
    agmSay(paused ? 'Pausing @' + id + '…' : 'Resuming @' + id + '…');
    var r = await act('POST', '/api/admin/wall/settings/org/hold', { agent: id, paused: paused });
    agmSay(r.ok ? (r.body.summary || (paused ? 'Paused.' : 'Resumed.')) : 'Not changed: ' + r.error);
    if (r.ok) await agmReload();
  }
  async function agmRemove(id) {
    AGM.confirm = '';
    agmSay('Removing @' + id + '…');
    var r = await act('DELETE', '/api/admin/wall/settings/agents', { id: id });
    if (!r.ok) { agmSay('Not removed: ' + r.error); render(); return; }
    if (AGM.test === id) { AGM.test = ''; AGM.td = null; }
    if (AGM.open === 'edit:' + id) AGM.open = '';
    AGM.restart = 'needed';
    agmSay('Removed @' + id + '. Its workspace folder stays on disk.');
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
    render();
  }
  async function agmSend(id) {
    var t = AGM.td && AGM.td.agent === id ? AGM.td : (AGM.td = { agent: id, chatId: 'hub-agents-' + Date.now(), msgs: [], busy: false });
    var box = $('agm-td-text'), text = box ? String(box.value || '').trim() : '';
    if (!text || t.busy) return;
    box.value = '';
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
    if (k === 'new') { AGM.open = 'new'; AGM.form = { tier: 'claude-code' }; AGM.note = ''; AGM.saved = null; render(); }
    else if (k === 'edit') { var a = agmSaved(id); if (!a) return; AGM.open = 'edit:' + id; AGM.form = agmFormOf(a, agmRole(id)); AGM.note = ''; AGM.test = ''; render(); }
    else if (k === 'close') { AGM.open = ''; AGM.test = ''; AGM.note = ''; render(); }
    else if (k === 'pause' || k === 'resume') agmHoldSet(id, k === 'pause');
    else if (k === 'test') { AGM.test = id; if (AGM.open.indexOf('edit:') === 0) AGM.open = ''; render(); }
    else if (k === 'send') agmSend(id);
    else if (k === 'ask') { AGM.confirm = id; render(); }
    else if (k === 'cancel') { AGM.confirm = ''; render(); }
    else if (k === 'remove') agmRemove(id);
    else if (k === 'restart') agmRestart();
  });
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
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-agm-f');
    if (k) AGM.form[k] = t.type === 'checkbox' ? !!t.checked : t.value;
  });
  document.addEventListener('keydown', function (ev) {
    if (S.page !== 'agents' || !ev.target) return;
    if (ev.target.id === 'agm-td-text' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); agmSend(AGM.test); }
    else if (ev.key === 'Escape' && AGM.confirm) { AGM.confirm = ''; render(); }
  });
`

export const WALL_AGENTS_CSS = `
.agm-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px 0; }
.agm-restart { margin: 8px 16px 0; padding: 8px 12px; border-radius: var(--ax-radius); background: var(--ax-amber-t); color: var(--ax-amber-ink); font-size: var(--ax-fs-sm); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.agm-form, .agm-td { margin: 12px 16px; padding: 12px 14px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); }
.wag .agm-form, .wag .agm-td { margin: 10px 0 0; }
.agm-form h3, .agm-td h3 { margin: 0 0 6px; font-size: 15px; }
.agm-ch { border: 1px dashed var(--ax-border-2); border-radius: var(--ax-radius-sm); padding: 8px 10px; margin: 0; }
.agm-form label small, .agm-ch legend small { color: var(--ax-muted); font-weight: 400; margin-left: 4px; }
.agm-ch legend { font-weight: 600; font-size: var(--ax-fs-sm); padding: 0 4px; }
.agm-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.agm-acts .ax-btn { font-size: var(--ax-fs-xs); padding: 3px 10px; }
.agm-rm { color: var(--ax-red-ink); }
.agm-confirm { margin-top: 8px; }
.agm-st.is-needs { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.agm-st.is-working { background: color-mix(in srgb, var(--ax-green) 15%, transparent); color: var(--ax-green-d, var(--ax-green)); }
.agm-st.is-paused, .agm-st.is-off { background: var(--ax-surface-2); color: var(--ax-muted); }
.agm-st.is-idle { background: var(--ax-blue-t, var(--ax-surface-2)); color: var(--ax-accent); }
`
