// --- Wall Settings, browser side (#1428) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), avatar(), headers(), act(), PAGES and render().
//
// The Wall page that changes settings. The owner replaced rule 4 of #1180
// ("the Wall writes nothing"): the Wall may write, owner-only, wherever a
// classic page wrote (#1449). This page writes what classic /admin wrote,
// with the endpoints it calls (admin-panel.ts), so no settings logic lives
// here; the /api/admin/* gate checks the owner server-side.
//
// The server says who the owner is: it sets window.AX_WALL_SETTINGS and
// draws the nav entry only for them (wall.ts). Without it, #page=settings
// is the Wall, and the APIs refuse anyone else as they always have.
//
// Phase 1 of #1428: the shell (a list of sections, the chosen one beside
// it; on a phone the list is its own screen) and the Agents section. The
// other sections link to their classic tab until they are ported.
//
// A section repaints when it opens or after a save, never on the Wall's
// minute refresh, so a field being typed in stays as it is. A save that
// fails only writes its note line, keeping what was typed.

export const WALL_SETTINGS_SCRIPT = String.raw`
  // --- Settings (#1428) ---
  var ST = window.AX_WALL_SETTINGS || null;
  /** Section id, label, classic /admin tab ('' once it is on the Wall). */
  var ST_SECTIONS = [
    ['agents', 'Agents', ''], ['channels', 'Channels', 'channels'], ['schedules', 'Schedules', 'crons'],
    ['webhooks', 'Webhooks', 'webhooks'], ['mesh', 'Mesh', 'mesh'], ['business', 'Business', 'business'],
    ['boards', 'Boards', 'boards-cfg'], ['actions', 'Actions', 'actions'], ['tokens', 'Tokens', 'tokens'], ['advanced', 'Advanced', 'advanced'],
  ].filter(function (s) { return s[0] !== 'business' || (ST && ST.business); });
  var ST_ENGINES = [['claude-code', 'Claude Code'], ['codex-cli', 'Codex CLI'], ['opencode', 'OpenCode'], ['sdk', 'Anthropic API (SDK)'], ['orchestrator', 'Orchestrator']];
  var ST_PERMS = ['default', 'bypassPermissions', 'plan'];
  var ST_INT_KINDS = ['telegram-bot', 'whatsapp', 'slack-bot', 'discord-bot', 'gitlab-user', 'github-user', 'gmail', 'hotmail', 'smtp',
    'hubspot', 'salesforce', 'pipedrive', 'odoo', 'trello', 'linear', 'asana', 'jira', 'notion', 'stripe', 'sentry', 'vercel', 'twilio', 'custom'];
  /** The biggest file the editor or a new skill takes, as in classic Settings. */
  var ST_FILE_MAX = 200 * 1024;
  /** Agent fields the daemon applies only after a restart (detectAgentRestartFields in daemon/index.ts). */
  var ST_RESTART_FIELDS = [['tier', 'engine'], ['model', 'model'], ['permissionMode', 'permission mode']];
  var ST_RESTART = 'agentx daemon restart --when-idle';
  if (ST) PAGES.push('settings');
  S.st = { section: '', agent: '', data: null, org: null, error: '', loading: false, v: 0, painted: '', key: '', notes: {}, flash: '', confirm: '', files: null, td: null };

  function settingsReadHash(q) {
    S.st.section = S.page === 'settings' && q.get('section') || '';
    S.st.agent = S.page === 'settings' && S.st.section === 'agents' && q.get('agent') || '';
  }
  function settingsHashInto(q) {
    if (S.st.section) q.set('section', S.st.section);
    if (S.st.agent) q.set('agent', S.st.agent);
  }
  function stHref(section, agent) {
    return '#page=settings' + (section ? '&section=' + encodeURIComponent(section) : '') + (agent ? '&agent=' + encodeURIComponent(agent) : '');
  }
  /** An agent's settings link: its Wall Settings page for the owner when it
   *  is on this machine (this node's org view lists it), else the classic page. */
  function agentPageLink(id) {
    var here = false;
    function walk(list) { (list || []).forEach(function (n) { if (n.id === id) here = true; walk(n.reports); }); }
    if (ST && S.org) { walk(S.org.roots); walk(S.org.outside); }
    return here ? '<a href="' + esc(stHref('agents', id)) + '">Settings</a>' : '<a href="/admin/agents/' + encodeURIComponent(id) + '">Agent page</a>';
  }
  function stEngine(tier) { var e = ST_ENGINES.find(function (x) { return x[0] === tier; }); return e ? e[1] : (tier || 'Claude Code'); }
  function stAgentOf(id) { return ((S.st.data && S.st.data.agents) || []).find(function (a) { return a.id === id; }) || null; }
  /** The agent's place in the org view: its title and paused or waiting. */
  function stOrgNode(id) {
    var found = null;
    function walk(list) { (list || []).forEach(function (n) { if (n.id === id) found = n; walk(n.reports); }); }
    if (S.st.org) { walk(S.st.org.roots); walk(S.st.org.outside); }
    return found || {};
  }
  function stNoteHtml(key) {
    var n = S.st.notes[key] || { kind: '', text: '' };
    return '<p class="wst__n' + (n.kind ? ' is-' + n.kind : '') + '" id="st-n-' + esc(key) + '" role="status">' + esc(n.text) + '</p>';
  }
  /** Write one note line in place, so the fields around it keep what was typed. */
  function stNote(key, kind, text) {
    S.st.notes[key] = { kind: kind, text: text };
    var el = $('st-n-' + key);
    if (el) { el.textContent = text; el.className = 'wst__n' + (kind ? ' is-' + kind : ''); }
  }
  function stVal(id) { var el = $(id); return el ? String(el.value == null ? '' : el.value) : ''; }
  function stChecked(id) { var el = $(id); return !!(el && el.checked); }
  function stOptions(list, current) {
    return list.map(function (o) { var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o; return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
  }

  async function stGet(url) {
    var r = await fetch(url, { headers: headers() });
    var b = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(b.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return b;
  }
  async function settingsLoad() {
    S.st.loading = true;
    try {
      var both = await Promise.all([stGet('/api/admin/state'), stGet('/api/admin/org').catch(function () { return null; })]);
      S.st.data = both[0];
      S.st.org = both[1];
      S.st.error = '';
    } catch (e) {
      S.st.error = e.status === 401 || e.status === 403 ? 'owner' : String(e.message || e);
    }
    S.st.loading = false;
    stPaint();
  }
  function stPaint() { S.st.v++; settingsShow(); }

  /** Called from render(): paints only when the section, the agent or the data changed. */
  function settingsShow() {
    if (!ST || S.page !== 'settings' || S.post) return;
    var box = $('wall-settings');
    var key = S.st.section + '|' + S.st.agent;
    if (key !== S.st.key) {
      // A new section or agent starts clean: no notes, no open confirmation.
      S.st.key = key;
      // A delete's note rides along to the list it returns to.
      S.st.notes = S.st.flash ? { list: { kind: 'ok', text: S.st.flash } } : {};
      S.st.flash = '';
      S.st.confirm = '';
      if (S.st.files && S.st.files.agent !== S.st.agent) S.st.files = null;
      if (S.st.td && S.st.td.agent !== S.st.agent) S.st.td = null;
    }
    if (!S.st.data && !S.st.error && !S.st.loading) { settingsLoad(); }
    var painted = key + '|' + S.st.v;
    if (S.st.painted === painted) return;
    S.st.painted = painted;
    box.innerHTML = settingsHtml();
    stPaintTest();
  }

  function settingsHtml() {
    var sec = S.st.section || 'agents';
    var count = S.st.data && S.st.data.agents ? S.st.data.agents.length : null;
    var menu = '<nav class="wst__menu" aria-label="Settings sections">' +
      '<p class="wst__lead">Only you, the owner, see this page. Changes save to this machine\'s agentx.json.</p>' +
      ST_SECTIONS.map(function (s) {
        var on = s[0] === sec;
        return '<a href="' + esc(stHref(s[0])) + '" class="wst__sec' + (on ? ' is-on' : '') + '"' + (on ? ' aria-current="page"' : '') + '>' +
          '<span>' + esc(s[1]) + '</span>' + (s[2] ? '<small>classic</small>' : count != null ? '<small>' + count + '</small>' : '') + '</a>';
      }).join('') + '</nav>';
    return '<div class="wst' + (S.st.section ? ' has-section' : '') + '">' + menu +
      '<div class="wst__body">' + (S.st.agent ? '' : '<a class="wst__up" href="' + esc(stHref('')) + '">← All settings</a>') + stSectionHtml(sec) + '</div></div>';
  }
  function stSectionHtml(sec) {
    if (S.st.error === 'owner') return '<p class="wst__err">Only the owner can change settings. <a href="/login">Sign in</a> as the owner and open this page again.</p>';
    if (S.st.error) return '<p class="wst__err">Could not load the settings: ' + esc(S.st.error) + '.</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="reload">Try again</button>';
    if (!S.st.data) return '<p class="ax-wall__empty">Loading…</p>';
    if (!S.st.data.exists) return '<p class="wst__err">This machine has no agentx.json yet. <a href="/setup">Run the setup</a> first.</p>';
    var s = ST_SECTIONS.find(function (x) { return x[0] === sec; }) || ST_SECTIONS[0];
    if (s[2]) {
      return '<header class="wst__h"><h2>' + esc(s[1]) + '</h2></header>' +
        '<p class="wst__todo">' + esc(s[1]) + ' is not on the Wall yet: it comes in a later step of #1428. Until then, change it in classic Settings.</p>' +
        '<a class="ax-btn" href="/admin#tab=' + esc(s[2]) + '">Open ' + esc(s[1]) + ' in classic Settings</a>';
    }
    return S.st.agent ? stAgentHtml(S.st.agent) : stAgentsHtml();
  }

  // --- Agents: one card each, then add one, then the wiki page curator ---
  function stSwitchHtml(a) {
    var o = stOrgNode(a.id);
    if (o.status === 'waiting') return '<a class="chip chip--warn wsa__wait" href="/approvals" title="It starts once you approve it in Approvals">Waits for approval</a>';
    var on = o.status !== 'paused';
    return '<button type="button" class="wsa__sw" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-st-hold="' + esc(a.id) + '"' +
      ' title="' + (on ? 'On. Turn off: it starts no run until you turn it back on.' : 'Off: it starts no run. Turn on to let it work again.') + '">' +
      '<i aria-hidden="true"></i><span>' + (on ? 'On' : 'Off') + '</span><span class="wst__sr"> ' + esc(a.name || a.id) + '</span></button>';
  }
  function stCardHtml(a) {
    var o = stOrgNode(a.id);
    return '<article class="wsa" id="st-agent-' + esc(a.id) + '">' + avatar(a.id, 'md') +
      '<div class="wsa__b"><a class="wsa__open" href="' + esc(stHref('agents', a.id)) + '"><b>' + esc(a.name || a.id) + '</b></a>' +
        '<small>@' + esc(a.id) + (o.title ? ' · ' + esc(o.title) : '') + '</small>' +
        '<small>' + esc(stEngine(a.tier)) + (a.model ? ' · ' + esc(a.model) : '') + (a.access === 'public' ? ' · public API' : '') + '</small>' +
        stNoteHtml('hold-' + a.id) + '</div>' +
      stSwitchHtml(a) + '</article>';
  }
  function stAgentsHtml() {
    var list = S.st.data.agents || [];
    return '<header class="wst__h"><h2>Agents</h2><p>Each agent is a role with its own trigger words and workspace. Tap one to change it. Off stops it starting new runs.</p></header>' + stNoteHtml('list') +
      '<div class="wsa-list">' + (list.length ? list.map(stCardHtml).join('') : '<p class="ax-wall__empty">No agents yet. Add the first one below.</p>') + '</div>' +
      stAddHtml() + stCuratorHtml();
  }
  function stAddHtml() {
    return '<details class="wsx"' + (S.st.addOpen ? ' open' : '') + ' data-st-details="add"><summary>Add an agent</summary>' +
      '<form class="wsf" data-st-form="add">' +
        '<div class="wsf__row"><label><span>Agent id <small>lowercase letters, digits, - and _</small></span><input id="st-a-id" maxlength="40" placeholder="sales" autocomplete="off"></label>' +
        '<label>Name<input id="st-a-name" maxlength="80" placeholder="Sales Desk"></label></div>' +
        '<label><span>Trigger words <small>comma or space separated</small></span><input id="st-a-triggers" placeholder="@sales, sales"></label>' +
        '<div class="wsf__row"><label>AI engine<select id="st-a-tier">' + stOptions(ST_ENGINES, 'claude-code') + '</select></label>' +
        '<label><span>Model <small>optional</small></span><input id="st-a-model" placeholder="the engine\'s default"></label></div>' +
        '<label><span>Personality / instructions <small>optional</small></span><textarea id="st-a-personality" rows="3" placeholder="You answer pricing questions and pass support questions to @support."></textarea></label>' +
        '<label class="wsf__check"><input type="checkbox" id="st-a-public"> Answer on the public API (a token with agent:&lt;id&gt; scope can reach it)</label>' +
        '<p class="wsf__hint">A new agent starts working after a daemon restart: ' + esc(ST_RESTART) + '.</p>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add agent</button>' + stNoteHtml('add') + '</div>' +
      '</form></details>';
  }
  function stCuratorHtml() {
    var c = S.st.data.wikiCurator || { enabled: true, agent: '' };
    var agents = (S.st.data.agents || []).map(function (a) { return [a.id, (a.name || a.id) + ' (' + a.id + ')']; });
    return '<details class="wsx" data-st-details="curator"' + (S.st.curatorOpen ? ' open' : '') + '><summary>Wiki page curator</summary>' +
      '<form class="wsf" data-st-form="curator">' +
        '<p class="wsf__hint">A chat bubble on every wiki page: type an instruction and an agent edits the open page. Every change can be undone.</p>' +
        '<label class="wsf__check"><input type="checkbox" id="st-wc-on"' + (c.enabled !== false ? ' checked' : '') + '> Show the bubble on wiki pages</label>' +
        '<label>Agent that answers<select id="st-wc-agent">' + stOptions([['', 'The agent that owns the page']].concat(agents), c.agent || '') + '</select></label>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button>' + stNoteHtml('curator') + '</div>' +
      '</form></details>';
  }

  // --- One agent: its settings, integrations, files, test drive, delete ---
  function stAgentHtml(id) {
    var a = stAgentOf(id);
    if (!a) return '<a class="wst__up wst__up--all" href="' + esc(stHref('agents')) + '">← Agents</a><p class="ax-wall__empty">No agent @' + esc(id) + ' on this machine.</p>';
    var o = stOrgNode(id);
    return '<a class="wst__up wst__up--all" href="' + esc(stHref('agents')) + '">← Agents</a>' +
      '<header class="wsa-head">' + avatar(id, 'md') + '<div class="wsa__b"><h2>' + esc(a.name || a.id) + '</h2>' +
        '<small>@' + esc(a.id) + (o.title ? ' · ' + esc(o.title) : '') + '</small>' + stNoteHtml('hold-' + a.id) + '</div>' + stSwitchHtml(a) + '</header>' +
      stEditHtml(a) + stAccessHtml(a) + stIntegrationsHtml(a) + stFilesHtml(a) + stTestHtml(a) + stDeleteHtml(a) +
      '<p class="wsf__hint"><a href="/admin/agents/' + encodeURIComponent(a.id) + '">The full agent page</a> has the same files with a Markdown preview.</p>';
  }
  function stEditHtml(a) {
    return '<form class="wsf wsc" data-st-form="edit" data-id="' + esc(a.id) + '"><h3>Settings</h3>' +
      '<label>Name<input id="st-e-name" maxlength="80" value="' + esc(a.name || '') + '"></label>' +
      '<div class="wsf__row"><label>AI engine<select id="st-e-tier">' + stOptions(ST_ENGINES, a.tier || 'claude-code') + '</select></label>' +
      '<label><span>Model <small>optional</small></span><input id="st-e-model" placeholder="the engine\'s default" value="' + esc(a.model || '') + '"></label></div>' +
      '<p class="wsf__hint">Changing the engine, the model or the permission mode needs a daemon restart before it applies. A schedule of this agent that names its own model keeps that model: check its schedules so they match.</p>' +
      '<label><span>Trigger words <small>comma or space separated</small></span><input id="st-e-triggers" value="' + esc((a.mentions || []).join(', ')) + '"></label>' +
      '<label>Personality / instructions<textarea id="st-e-personality" rows="6">' + esc(a.systemPrompt || '') + '</textarea></label>' +
      '<div class="wsf__row"><label>Tasks at once<input id="st-e-max-concurrent" type="number" min="1" max="20" value="' + esc(a.maxConcurrent || 1) + '"></label>' +
      '<label>Longest run, minutes<input id="st-e-max-exec" type="number" min="1" max="240" value="' + esc(a.maxExecutionMinutes || 20) + '"></label></div>' +
      '<label>Permission mode<select id="st-e-perm">' + stOptions(ST_PERMS, a.permissionMode || 'default') + '</select></label>' +
      '<label class="wsf__check"><input type="checkbox" id="st-e-access"' + (a.access === 'public' ? ' checked' : '') + '> Answer on the public API</label>' +
      '<label class="wsf__check"><input type="checkbox" id="st-e-wiki"' + (a.wikiAbsorb !== false ? ' checked' : '') + '> Include in the wiki absorb <small>off: agentx wiki absorb skips this agent; its conversations are still kept</small></label>' +
      '<div class="wsf__foot"><button type="submit" class="ax-btn">Save</button>' + stNoteHtml('edit') + '</div>' +
      '<p class="wsf__hint">The other fields need no restart: the daemon reloads agentx.json, and they apply from the agent\'s next run.</p>' +
    '</form>';
  }
  function stAccessHtml(a) {
    var pub = a.access === 'public';
    return '<section class="wsc"><h3>Public API</h3><p class="wsf__hint">' + (pub
      ? 'On: a token with agent:' + esc(a.id) + ' scope can send it messages.'
      : 'Off: only this dashboard, its channels and the mesh reach it.') + '</p>' +
      '<div class="wsf__foot"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="access" data-id="' + esc(a.id) + '" data-access="' + (pub ? 'private' : 'public') + '">' + (pub ? 'Make private' : 'Make public') + '</button>' + stNoteHtml('access') + '</div></section>';
  }
  function stConfirmHtml(key, text, yes) {
    if (S.st.confirm !== key) return '';
    return '<div class="wsk" role="alertdialog" aria-label="Confirm"><p>' + text + '</p>' +
      '<button type="button" class="ax-btn wsk__yes" data-st-act="confirm" data-key="' + esc(key) + '">' + esc(yes) + '</button> ' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="cancel">Cancel</button></div>';
  }
  function stIntegrationsHtml(a) {
    var list = Array.isArray(a.integrations) ? a.integrations : [];
    var rows = list.map(function (i, n) {
      var status = Object.keys(i.credStatus || {}).map(function (k) {
        var st = i.credStatus[k];
        return '<span class="chip ' + (st === 'set' ? 'chip--done' : st === 'unset' ? 'chip--warn' : 'chip--ghost') + '">' + esc(k) + (st === 'set' ? ' set' : st === 'unset' ? ' not set' : '') + '</span>';
      }).join(' ');
      var refs = Object.keys(i.credentials || {}).map(function (k) { return k + '=' + i.credentials[k]; }).join(', ');
      var meta = Object.keys(i.metadata || {}).map(function (k) { return k + '=' + i.metadata[k]; }).join(' · ');
      return '<li class="wsi"><div><b>' + esc(i.label) + '</b> <code>' + esc(i.kind) + '</code>' + (i.enabled === false ? ' <span class="chip chip--ghost">off</span>' : '') +
        (status ? '<div>' + status + '</div>' : '') + (refs ? '<small>' + esc(refs) + '</small>' : '') + (meta ? '<small>' + esc(meta) + '</small>' : '') + '</div>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="int:' + n + '">Remove</button>' +
        stConfirmHtml('int:' + n, 'Remove ' + esc(i.kind) + ' "' + esc(i.label) + '" from @' + esc(a.id) + '?', 'Remove') + '</li>';
    }).join('');
    return '<section class="wsc"><h3>Integrations <small>' + list.length + '</small></h3>' +
      '<p class="wsf__hint">Credentials for outside services. Only the names of environment variables are kept here; the secrets stay in the environment or the keyring.</p>' +
      (rows ? '<ul class="wsi-list">' + rows + '</ul>' : '<p class="ax-wall__empty">None yet.</p>') + stNoteHtml('int') +
      '<details class="wsx"><summary>Add an integration</summary><form class="wsf" data-st-form="int" data-id="' + esc(a.id) + '">' +
        '<div class="wsf__row"><label>Kind<select id="st-i-kind">' + stOptions(ST_INT_KINDS, '') + '</select></label>' +
        '<label>Label<input id="st-i-label" maxlength="80" placeholder="Team CRM"></label></div>' +
        '<div class="wsf__row"><label><span>Token environment variable <small>UPPERCASE</small></span><input id="st-i-env" placeholder="CRM_TOKEN" autocomplete="off"></label>' +
        '<label><span>Details <small>optional, key=value,key=value</small></span><input id="st-i-meta"></label></div>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add integration</button>' + stNoteHtml('int-add') + '</div>' +
      '</form></details></section>';
  }
  function stFmtBytes(n) { return !n ? '0 B' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1).replace(/\.0$/, '') + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
  function stFilesHtml(a) {
    var f = S.st.files;
    var head = '<section class="wsc" id="st-files"><h3>Files and skills</h3><p class="wsf__hint">The agent\'s instruction files and its skills, in its workspace.</p>';
    if (!f) return head + '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="files" data-id="' + esc(a.id) + '">Show files</button></section>';
    if (f.error) return head + '<p class="wst__err">Could not list the files: ' + esc(f.error) + '</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="files" data-id="' + esc(a.id) + '">Try again</button></section>';
    if (!f.overview) return head + '<p class="ax-wall__empty">Loading…</p></section>';
    var ov = f.overview;
    var ident = (ov.identity || []).map(function (x) {
      return '<li><button type="button" class="wsl__f' + (f.path === x.path ? ' is-on' : '') + '" data-st-act="open-file" data-path="' + esc(x.path) + '">' + esc(x.title) + '<small>' + (x.exists ? stFmtBytes(x.size) : 'not made yet') + '</small></button></li>';
    }).join('');
    var skills = (ov.skills || []).map(function (x, n) {
      return '<li><button type="button" class="wsl__f' + (f.path === x.path ? ' is-on' : '') + '" data-st-act="open-file" data-path="' + esc(x.path) + '">' + esc(x.title) + '<small>' + esc(x.slug) + '</small></button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="skill:' + n + '">Delete</button>' +
        stConfirmHtml('skill:' + n, 'Delete the skill "' + esc(x.slug) + '"? Its folder and SKILL.md are removed from disk.', 'Delete') + '</li>';
    }).join('');
    var editor = f.path ? '<div class="wse"><p class="wse__p"><code>' + esc(f.path) + '</code></p>' +
        '<textarea id="st-f-text" rows="14" spellcheck="false" aria-label="' + esc(f.path) + '">' + esc(f.text) + '</textarea>' +
        '<div class="wsf__foot"><button type="button" class="ax-btn" data-st-act="save-file">Save</button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="revert-file">Revert</button>' +
        '<label class="ax-btn ax-btn--ghost wse__up">Load a file<input type="file" id="st-f-up" accept=".md,.markdown,.txt,text/markdown,text/plain"></label>' + stNoteHtml('file') + '</div></div>' : '';
    return head + '<div class="wsl"><div><h4>Instruction files</h4><ul>' + (ident || '<li class="ax-wall__empty">None.</li>') + '</ul>' +
        '<h4>Skills</h4><ul>' + (skills || '<li class="ax-wall__empty">No skills yet.</li>') + '</ul></div>' + editor + '</div>' +
      '<details class="wsx"><summary>Add a skill</summary><form class="wsf" data-st-form="skill">' +
        '<div class="wsf__row"><label><span>Slug <small>lowercase</small></span><input id="st-s-slug" maxlength="60" placeholder="weekly-report"></label>' +
        '<label><span>Title <small>optional</small></span><input id="st-s-title" maxlength="120"></label></div>' +
        '<label><span>SKILL.md <small>optional: without one, a template is made</small></span><input type="file" id="st-s-file" accept=".md,.markdown,.txt,text/markdown,text/plain"></label>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add skill</button>' + stNoteHtml('skill') + '</div>' +
      '</form></details></section>';
  }
  function stTestHtml(a) {
    return '<section class="wsc"><h3>Test drive</h3><p class="wsf__hint">Send @' + esc(a.id) + ' a message and read its answer here, before it answers on a real channel. It runs for real.</p>' +
      '<ol class="wtd" id="st-td-log" aria-live="polite"></ol>' +
      '<div class="wdo__row"><textarea id="st-td-text" class="wdo__t" rows="2" maxlength="4000" placeholder="Message ' + esc(a.name || a.id) + '… (Ctrl+Enter sends)" aria-label="Test drive message"></textarea>' +
      '<button type="button" class="ax-btn" data-st-act="td-send" data-id="' + esc(a.id) + '">Send</button></div></section>';
  }
  function stPaintTest() {
    var log = $('st-td-log');
    if (!log) return;
    var t = S.st.td;
    log.innerHTML = t && t.msgs.length ? t.msgs.map(function (m) { return '<li class="wtd__m is-' + m.kind + '">' + esc(m.text) + '</li>'; }).join('') : '';
  }
  function stDeleteHtml(a) {
    return '<section class="wsc wsc--danger"><h3>Delete</h3><p class="wsf__hint">Removes @' + esc(a.id) + ' from agentx.json and unbinds its Telegram accounts. Its workspace folder stays on disk. The daemon stops it after a restart.</p>' +
      '<div class="wsf__foot"><button type="button" class="ax-btn wsk__yes" data-st-act="ask" data-key="delete">Delete @' + esc(a.id) + '</button>' + stNoteHtml('delete') + '</div>' +
      stConfirmHtml('delete', 'Delete @' + esc(a.id) + ' for good? This cannot be undone from here.', 'Delete @' + a.id) + '</section>';
  }

  // --- Saves: each calls the classic endpoint and writes its note line ---
  async function stHold(id) {
    var pause = stOrgNode(id).status !== 'paused';
    stNote('hold-' + id, '', pause ? 'Turning off…' : 'Turning on…');
    var r = await act('POST', '/api/admin/org/hold', { agent: id, paused: pause });
    if (!r.ok) { stNote('hold-' + id, 'err', 'Not changed: ' + r.error); return; }
    S.st.notes['hold-' + id] = { kind: 'ok', text: pause ? 'Off: it starts no run until you turn it back on.' : 'On: it works again.' };
    await settingsLoad();
  }
  function stList(xs) { return xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs.join(''); }
  function stInt(id) { var n = parseInt(stVal(id), 10); return isFinite(n) ? n : undefined; }
  async function stSaveEdit(id) {
    var patch = {
      name: stVal('st-e-name').trim(), tier: stVal('st-e-tier'), model: stVal('st-e-model').trim(),
      triggerWords: stVal('st-e-triggers').trim(), systemPrompt: stVal('st-e-personality'),
      maxConcurrent: stInt('st-e-max-concurrent'), maxExecutionMinutes: stInt('st-e-max-exec'),
      permissionMode: stVal('st-e-perm'), access: stChecked('st-e-access') ? 'public' : 'private', wikiAbsorb: stChecked('st-e-wiki'),
    };
    if (!patch.name) { stNote('edit', 'err', 'Not saved: the name cannot be empty.'); return; }
    stNote('edit', '', 'Saving…');
    var r = await act('PATCH', '/api/admin/agents', { id: id, patch: patch });
    if (!r.ok) { stNote('edit', 'err', 'Not saved: ' + r.error); return; }
    var a = stAgentOf(id) || {}, restart = ST_RESTART_FIELDS.filter(function (f) { return (patch[f[0]] || '') !== (a[f[0]] || (f[0] === 'permissionMode' ? 'default' : '')); });
    S.st.notes.edit = restart.length
      ? { kind: 'warn', text: 'Saved. Restart the daemon for the new ' + stList(restart.map(function (f) { return f[1]; })) + ' to apply: ' + ST_RESTART + '.' }
      : { kind: 'ok', text: 'Saved. It applies from the agent\'s next run.' };
    await settingsLoad();
  }
  async function stAdd() {
    var body = {
      id: stVal('st-a-id').trim(), name: stVal('st-a-name').trim(), triggerWords: stVal('st-a-triggers').trim(), tier: stVal('st-a-tier') || 'claude-code',
      model: stVal('st-a-model').trim() || undefined, personality: stVal('st-a-personality').trim() || undefined, access: stChecked('st-a-public') ? 'public' : 'private',
    };
    stNote('add', '', 'Adding…');
    var r = await act('POST', '/api/admin/agents', body);
    if (!r.ok) { stNote('add', 'err', 'Not added: ' + r.error); return; }
    var note = 'Added @' + body.id + '. It starts working after a daemon restart: ' + ST_RESTART + '.';
    if (body.access === 'public') {
      var p = await act('POST', '/api/admin/agents/access', { id: body.id, access: 'public' });
      if (!p.ok) note += ' It stays private: ' + p.error;
    }
    S.st.addOpen = true;
    S.st.notes.add = { kind: 'ok', text: note };
    await settingsLoad();
  }
  async function stSaveCurator() {
    stNote('curator', '', 'Saving…');
    var r = await act('POST', '/api/admin/wiki/curator', { enabled: stChecked('st-wc-on'), agent: stVal('st-wc-agent') });
    if (!r.ok) { stNote('curator', 'err', 'Not saved: ' + r.error); return; }
    S.st.curatorOpen = true;
    S.st.notes.curator = { kind: 'ok', text: 'Saved.' };
    await settingsLoad();
  }
  async function stAccess(id, access) {
    stNote('access', '', 'Saving…');
    var r = await act('POST', '/api/admin/agents/access', { id: id, access: access });
    if (!r.ok) { stNote('access', 'err', 'Not changed: ' + r.error); return; }
    S.st.notes.access = { kind: 'ok', text: access === 'public' ? 'Public: it answers on the public API.' : 'Private.' };
    await settingsLoad();
  }
  async function stAddInt(id) {
    var kind = stVal('st-i-kind'), label = stVal('st-i-label').trim(), env = stVal('st-i-env').trim(), metaRaw = stVal('st-i-meta').trim();
    if (!kind || !label) { stNote('int-add', 'err', 'Pick a kind and write a label.'); return; }
    if (!env) { stNote('int-add', 'err', 'Write the token\'s environment variable name. Keyring and session folders are set with the agentx CLI.'); return; }
    var metadata = {};
    metaRaw.split(',').forEach(function (pair) {
      var i = pair.indexOf('='), k = (i < 0 ? pair : pair.slice(0, i)).trim();
      if (k) metadata[k] = i < 0 ? '' : pair.slice(i + 1).trim();
    });
    stNote('int-add', '', 'Adding…');
    var r = await act('POST', '/api/admin/agents/integrations', { agentId: id, kind: kind, label: label, credentials: { tokenEnv: env }, metadata: metadata });
    if (!r.ok) { stNote('int-add', 'err', 'Not added: ' + r.error); return; }
    S.st.notes.int = { kind: 'ok', text: 'Added ' + kind + ' "' + label + '".' };
    await settingsLoad();
  }
  async function stConfirmed(key) {
    var id = S.st.agent, a = stAgentOf(id);
    S.st.confirm = '';
    if (key === 'delete') {
      stPaint();
      stNote('delete', '', 'Deleting…');
      var r = await act('DELETE', '/api/admin/agents', { id: id });
      if (!r.ok) { stNote('delete', 'err', 'Not deleted: ' + r.error); return; }
      S.st.flash = 'Deleted @' + id + '. Its workspace folder is still on disk. Restart the daemon to stop it: ' + ST_RESTART + '.';
      S.st.data = null;
      location.hash = stHref('agents');
      settingsLoad();
      return;
    }
    if (key.indexOf('int:') === 0) {
      var i = a && (a.integrations || [])[+key.slice(4)];
      stPaint();
      if (!i) return;
      stNote('int', '', 'Removing…');
      var ri = await act('DELETE', '/api/admin/agents/integrations', { agentId: id, kind: i.kind, label: i.label });
      if (!ri.ok) { stNote('int', 'err', 'Not removed: ' + ri.error); return; }
      S.st.notes.int = { kind: 'ok', text: 'Removed ' + i.kind + ' "' + i.label + '".' };
      await settingsLoad();
      return;
    }
    if (key.indexOf('skill:') === 0) {
      var s = S.st.files && S.st.files.overview && S.st.files.overview.skills[+key.slice(6)];
      stPaint();
      if (!s) return;
      stNote('file', '', 'Deleting…');
      var rs = await act('DELETE', '/api/admin/files/skill', { agent: id, slug: s.slug });
      if (!rs.ok) { stNote('file', 'err', 'Not deleted: ' + rs.error); return; }
      if (S.st.files.path && S.st.files.path.indexOf('/' + s.slug + '/') >= 0) S.st.files.path = '';
      await stLoadFiles(id);
    }
  }
  async function stLoadFiles(id) {
    var keep = S.st.files && S.st.files.agent === id ? S.st.files : null;
    S.st.files = { agent: id, overview: null, path: keep ? keep.path : '', text: keep ? keep.text : '', original: keep ? keep.original : '', error: '' };
    stPaint();
    try { S.st.files.overview = await stGet('/api/admin/files?agent=' + encodeURIComponent(id)); }
    catch (e) { S.st.files.error = String(e.message || e); }
    stPaint();
  }
  async function stOpenFile(path) {
    var f = S.st.files;
    if (!f) return;
    try {
      var r = await stGet('/api/admin/files/read?agent=' + encodeURIComponent(f.agent) + '&path=' + encodeURIComponent(path));
      f.path = path; f.text = r.content || ''; f.original = f.text;
      stPaint();
    } catch (e) { stNote('file', 'err', 'Could not open it: ' + (e.message || e)); }
  }
  async function stSaveFile() {
    var f = S.st.files;
    if (!f || !f.path) return;
    f.text = stVal('st-f-text');
    stNote('file', '', 'Saving…');
    var r = await act('PUT', '/api/admin/files', { agent: f.agent, path: f.path, content: f.text });
    if (!r.ok) { stNote('file', 'err', 'Not saved: ' + r.error); return; }
    f.original = f.text;
    S.st.notes.file = { kind: 'ok', text: r.body.summary || 'Saved.' };
    await stLoadFiles(f.agent);
  }
  function stReadText(file) {
    return new Promise(function (ok, no) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result || '')); };
      r.onerror = function () { no(r.error || new Error('read failed')); };
      r.readAsText(file);
    });
  }
  async function stAddSkill() {
    var f = S.st.files, slug = stVal('st-s-slug').trim(), title = stVal('st-s-title').trim();
    if (!f) return;
    var input = $('st-s-file'), file = input && input.files && input.files[0], content;
    if (file) {
      try { content = await stReadText(file); } catch (e) { stNote('skill', 'err', 'Could not read the file: ' + (e.message || e)); return; }
      if (content.length > ST_FILE_MAX) { stNote('skill', 'err', 'The file is over 200 KB. Add the skill, then edit it here.'); return; }
    }
    var body = { agent: f.agent, slug: slug, title: title };
    if (content != null) body.content = content;
    stNote('skill', '', 'Adding…');
    var r = await act('POST', '/api/admin/files/skill', body);
    if (!r.ok) { stNote('skill', 'err', 'Not added: ' + r.error); return; }
    S.st.notes.file = { kind: 'ok', text: r.body.summary || 'Skill added.' };
    await stLoadFiles(f.agent);
    if (r.body.path) stOpenFile(r.body.path);
  }
  async function stSendTest(id) {
    var t = S.st.td && S.st.td.agent === id ? S.st.td : (S.st.td = { agent: id, chatId: 'wall-settings-' + Date.now(), msgs: [], busy: false });
    var text = stVal('st-td-text').trim();
    if (!text || t.busy) return;
    $('st-td-text').value = '';
    t.msgs.push({ kind: 'you', text: text }, { kind: 'wait', text: 'Thinking…' });
    t.busy = true;
    stPaintTest();
    var r = await act('POST', '/api/admin/agents/test', { agent: id, message: text, chatId: t.chatId });
    t.busy = false;
    t.msgs.pop();
    var reply = r.ok ? (r.body.response && (r.body.response.content || r.body.response.error)) || '(no answer)' : r.error;
    t.msgs.push({ kind: r.ok && !(r.body.response && r.body.response.error) ? 'agent' : 'err', text: reply });
    stPaintTest();
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act],[data-st-hold]');
    if (!t) return;
    if (t.hasAttribute('data-st-hold')) { ev.preventDefault(); stHold(t.getAttribute('data-st-hold')); return; }
    var a = t.getAttribute('data-st-act'), id = t.getAttribute('data-id');
    if (a === 'reload') { S.st.error = ''; settingsLoad(); }
    else if (a === 'ask') { S.st.confirm = t.getAttribute('data-key'); stPaint(); }
    else if (a === 'cancel') { S.st.confirm = ''; stPaint(); }
    else if (a === 'confirm') stConfirmed(t.getAttribute('data-key'));
    else if (a === 'access') stAccess(id, t.getAttribute('data-access'));
    else if (a === 'files') stLoadFiles(id);
    else if (a === 'open-file') stOpenFile(t.getAttribute('data-path'));
    else if (a === 'save-file') stSaveFile();
    else if (a === 'revert-file') { if (S.st.files) { S.st.files.text = S.st.files.original; S.st.notes.file = { kind: '', text: '' }; stPaint(); } }
    else if (a === 'td-send') stSendTest(id);
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form) return;
    ev.preventDefault();
    var kind = form.getAttribute('data-st-form'), id = form.getAttribute('data-id');
    if (kind === 'edit') stSaveEdit(id);
    else if (kind === 'add') stAdd();
    else if (kind === 'curator') stSaveCurator();
    else if (kind === 'int') stAddInt(id);
    else if (kind === 'skill') stAddSkill();
  });
  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.id === 'st-f-text' && S.st.files) S.st.files.text = ev.target.value;
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || t.id !== 'st-f-up' || !S.st.files) return;
    var file = t.files && t.files[0];
    if (!file) return;
    stReadText(file).then(function (text) {
      if (text.length > ST_FILE_MAX) throw new Error('the file is over 200 KB');
      S.st.files.text = text;
      S.st.notes.file = { kind: '', text: 'Loaded into the editor. Save to keep it.' };
      stPaint();
    }).catch(function (e) { stNote('file', 'err', 'Not loaded: ' + (e.message || e)); });
  });
  document.addEventListener('keydown', function (ev) {
    if (S.page !== 'settings' || !ev.target) return;
    if (ev.target.id === 'st-td-text' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); stSendTest(S.st.agent); }
    else if (ev.target.id === 'st-f-text' && ev.key === 's' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); stSaveFile(); }
    else if (ev.key === 'Escape' && S.st.confirm) { S.st.confirm = ''; stPaint(); }
  });
  // The open Add and curator boxes stay open across a repaint.
  document.addEventListener('toggle', function (ev) {
    var d = ev.target, k = d && d.getAttribute && d.getAttribute('data-st-details');
    if (k === 'add') S.st.addOpen = d.open;
    else if (k === 'curator') S.st.curatorOpen = d.open;
  }, true);
`

export const WALL_SETTINGS_CSS = `
/* Settings (#1428): the sections beside the chosen one; on a phone, one at a time. */
.wst { display: grid; grid-template-columns: 180px minmax(0, 1fr); align-items: start; }
.wst__menu { position: sticky; top: 0; display: flex; flex-direction: column; padding: 8px 0; border-right: 1px solid var(--ax-border); min-height: 60vh; }
.wst__lead { margin: 4px 12px 8px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wst__sec { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; padding: 10px 12px; color: var(--ax-text); text-decoration: none; font-weight: 600; border-left: 3px solid transparent; }
.wst__sec:hover { background: var(--ax-surface); }
.wst__sec.is-on { border-left-color: var(--ax-accent); background: var(--ax-surface); }
.wst__sec small { color: var(--ax-muted); font-weight: 400; font-size: var(--ax-fs-xs); }
.wst__body { padding: 12px 16px 32px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.wst__up { display: none; color: var(--ax-accent); text-decoration: none; font-size: var(--ax-fs-sm); }
.wst__up--all { display: inline; }
.wst__h h2, .wsa-head h2 { margin: 0; font-size: 20px; font-weight: 800; }
.wst__h p { margin: 4px 0 0; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.wst__err { margin: 0; padding: 10px 12px; border-radius: var(--ax-radius); background: var(--ax-red-t); color: var(--ax-red-ink); font-size: var(--ax-fs-sm); }
.wst__todo { margin: 0; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.wst__body > .ax-btn { align-self: flex-start; }
.wst__n { margin: 0; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.wst__n:empty { display: none; }
.wst__n.is-ok { color: var(--ax-green-d); }
.wst__n.is-err { color: var(--ax-red-ink); }
.wst__n.is-warn { color: var(--ax-amber-ink); }
.wst__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.av--md { cursor: default; }

/* Agent cards: the whole card opens the agent; the switch keeps its own job. */
.wsa-list { display: flex; flex-direction: column; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); overflow: hidden; }
.wsa { position: relative; display: flex; gap: 12px; align-items: center; padding: 12px; border-top: 1px solid var(--ax-border); }
.wsa:first-child { border-top: 0; }
.wsa:hover { background: var(--ax-surface); }
.wsa__b { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.wsa__b small { color: var(--ax-muted); font-size: var(--ax-fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsa__open { color: var(--ax-text); text-decoration: none; }
.wsa__open::after { content: ""; position: absolute; inset: 0; }
.wsa__open:focus-visible { outline: none; }
.wsa:focus-within { box-shadow: inset 0 0 0 2px var(--ax-accent); }
.wsa__sw, .wsa__wait { position: relative; z-index: 1; flex: none; }
.wsa__sw { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-text); background: none; border: 0; padding: 6px 0; cursor: pointer; }
.wsa__sw i { width: 36px; height: 20px; border-radius: var(--ax-radius-pill); background: var(--ax-border-2); position: relative; transition: background .15s; }
.wsa__sw i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
.wsa__sw[aria-checked="true"] i { background: var(--ax-green); }
.wsa__sw[aria-checked="true"] i::after { transform: translateX(16px); }
.wsa__sw:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; border-radius: var(--ax-radius); }
.wsa__wait { text-decoration: none; }
.wsa-head { display: flex; gap: 12px; align-items: center; }

/* Forms and boxes */
.wsc { border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.wsc h3 { margin: 0; font-size: var(--ax-fs); font-weight: 800; }
.wsc h3 small { color: var(--ax-muted); font-weight: 400; }
.wsc h4 { margin: 8px 0 4px; font-size: var(--ax-fs-xs); color: var(--ax-muted); font-weight: 600; }
.wsc--danger { border-color: color-mix(in srgb, var(--ax-red) 40%, var(--ax-border)); }
.wsf { display: flex; flex-direction: column; gap: 8px; margin: 0; }
.wsf label { display: flex; flex-direction: column; gap: 4px; font-size: var(--ax-fs-xs); color: var(--ax-muted); flex: 1; min-width: 0; }
.wsf label small, .wsf__check small { font-size: 12px; }
.wsf input:not([type=checkbox]):not([type=file]), .wsf select, .wsf textarea, .wse textarea {
  font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius); padding: 8px 10px; width: 100%; }
.wsf input:focus, .wsf select:focus, .wsf textarea:focus, .wse textarea:focus { outline: 2px solid var(--ax-accent); outline-offset: -1px; }
.wsf .wsf__check { flex-direction: row; align-items: baseline; gap: 8px; color: var(--ax-text); font-size: var(--ax-fs-sm); flex-wrap: wrap; }
.wsf__row { display: flex; gap: 10px; flex-wrap: wrap; }
.wsf__row > label { flex: 1 1 180px; }
.wsf__hint { margin: 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wsf__foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.wsx { border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 10px 12px; }
.wsx > summary { cursor: pointer; font-weight: 700; }
.wsx[open] > summary { margin-bottom: 8px; }
.wsc .wsx { border-style: dashed; }
.wsk { margin-top: 6px; padding: 10px 12px; border-radius: var(--ax-radius); background: var(--ax-red-t); color: var(--ax-red-ink); font-size: var(--ax-fs-sm); flex-basis: 100%; }
.wsk p { margin: 0 0 8px; }
.ax-btn.wsk__yes { background: var(--ax-red); color: #fff; }
.wsi-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wsi { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; justify-content: space-between; padding: 8px 10px; background: var(--ax-surface); border-radius: var(--ax-radius); font-size: var(--ax-fs-sm); }
.wsi > div { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
.wsi small { color: var(--ax-muted); font-family: var(--ax-mono); font-size: 12px; }

/* Files: the list, then the open file */
.wsl { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 12px; }
.wsl ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.wsl li { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.wsl__f { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; font: inherit; font-size: var(--ax-fs-sm); text-align: left; color: var(--ax-text); background: none; border: 0; border-radius: var(--ax-radius); padding: 6px 8px; cursor: pointer; overflow-wrap: anywhere; }
.wsl__f small { color: var(--ax-muted); font-size: 12px; }
.wsl__f:hover, .wsl__f.is-on { background: var(--ax-surface); }
.wsl__f.is-on { box-shadow: inset 3px 0 0 var(--ax-accent); }
.wsl li .ax-btn { font-size: var(--ax-fs-xs); padding: 2px 10px; }
.wse { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.wse__p { margin: 0; font-size: var(--ax-fs-xs); overflow-wrap: anywhere; }
.wse textarea { font-family: var(--ax-mono); font-size: 13px; resize: vertical; min-height: 240px; }
.wse__up { position: relative; overflow: hidden; }
.wse__up input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }

/* Test drive */
.wtd { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; }
.wtd:empty { display: none; }
.wtd__m { padding: 8px 10px; border-radius: var(--ax-radius); font-size: var(--ax-fs-sm); white-space: pre-wrap; overflow-wrap: anywhere; max-width: 90%; }
.wtd__m.is-you { align-self: flex-end; background: var(--ax-blue-t); }
.wtd__m.is-agent { align-self: flex-start; background: var(--ax-surface); }
.wtd__m.is-wait { align-self: flex-start; color: var(--ax-muted); }
.wtd__m.is-err { align-self: flex-start; background: var(--ax-red-t); color: var(--ax-red-ink); }

@media (max-width: 640px) {
  .wst { grid-template-columns: minmax(0, 1fr); }
  .wst__menu { position: static; border-right: 0; min-height: 0; }
  .wst__sec { padding: 14px 16px; border-left: 0; border-top: 1px solid var(--ax-border); }
  .wst__sec.is-on { background: none; }
  .wst__sec::after { content: "›"; color: var(--ax-muted); margin-left: auto; padding-left: 8px; }
  .wst:not(.has-section) .wst__body, .wst.has-section .wst__menu { display: none; }
  .wst__up { display: inline; }
  .wst__body { padding: 12px; }
  .wsl { grid-template-columns: minmax(0, 1fr); }
  .wsa { padding: 12px 10px; }
}
`
