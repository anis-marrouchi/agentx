// --- Wall Settings, browser side (#1428, design #1451 frame 2) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), avatar(), headers(), act(), getJson(), PAGES, render(), the
// picture buttons (wall-pictures.client.ts), the fleet snapshot (S.live)
// and the build line (buildLast, wall-build.client.ts).
//
// The Wall page that changes settings. The owner replaced rule 4 of #1180
// ("the Wall writes nothing"): the Wall may write, owner-only, wherever a
// classic page wrote (#1449). This page writes what classic /admin and
// /admin/agents/<id> wrote, with the endpoints they call (admin-panel.ts,
// agent-panel.ts), so no settings logic lives here. Each write goes to
// /api/admin/wall/settings/<route>: the Wall's owner-only guard (#1454)
// checks it, then the classic route runs (wall-actions.ts).
//
// The server says who the owner is: it sets window.AX_WALL_SETTINGS and
// draws the nav entry only for them (wall.ts). Anyone else who opens
// #page=settings gets the server's one line, "Settings are for the owner".
//
// The accepted screen (notes/design/wall-v2-round-2.md §2):
// - the sections, grouped Fleet / Access / Machines, beside the chosen one;
//   on a phone the list is its own screen, with Health on top of it;
// - one agent keeps the classic tabs (Overview, Personality, Skills,
//   Channels, Handovers), its picture and its on/off switch on top;
// - a changed field turns blue and says what it was; a bar counts the
//   changes and says whether they need a restart, with Discard and Save…;
// - Save… opens a confirm with the before and after of each change, what
//   else moves (the agent's recurring jobs, spend against its cap), then
//   Save changes, then "Saved" or the error with the form kept.
//
// Phase 1 of #1428 builds Agents and Health. The other sections link to
// their classic place until they are ported.
//
// A section repaints when it opens or after a save, never on the Wall's
// minute refresh, so a field being typed in stays as it is. What is typed
// in the agent form lives in S.st.drafts until it is saved or discarded.

export const WALL_SETTINGS_SCRIPT = String.raw`
  // --- Settings (#1428) ---
  var ST = window.AX_WALL_SETTINGS || null;
  /** The sections, grouped as on the accepted screen: id, label, where it
   *  is until it is on the Wall ('' once it is). */
  var ST_GROUPS = [
    ['Fleet', [['agents', 'Agents', ''], ['channels', 'Channels', '/admin#tab=channels'], ['schedules', 'Schedules', '/admin#tab=crons'],
      ['webhooks', 'Webhooks', '/admin#tab=webhooks'], ['mesh', 'Mesh', '/admin#tab=mesh'], ['business', 'Business', '/admin#tab=business'],
      ['boards', 'Boards', '/admin#tab=boards-cfg'], ['actions', 'Actions', '/admin#tab=actions'], ['inbox', 'Inbox', '/admin#tab=channels']]],
    ['Access', [['guests', 'Guests', '/guests'], ['people', 'People', '#page=people'], ['tokens', 'Tokens', '/admin#tab=tokens']]],
    ['Machines', [['health', 'Health', ''], ['advanced', 'Advanced', '/admin#tab=advanced']]],
  ].map(function (g) { return [g[0], g[1].filter(function (s) { return s[0] !== 'business' || (ST && ST.business); })]; });
  var ST_SECTIONS = [].concat.apply([], ST_GROUPS.map(function (g) { return g[1]; }));
  /** What each section not on the Wall yet holds, for its page and the phone list. */
  var ST_ABOUT = {
    channels: 'Chat apps and developer tools: Telegram, WhatsApp, Slack, Discord, email, GitLab.', schedules: 'Recurring jobs: when each runs, which agent, what it asks.',
    webhooks: 'Calls from outside services that start an agent.', mesh: 'The other machines this one talks to, and how often it checks them.',
    business: 'Org chart, projects, clients and contacts.', boards: 'Boards and their columns.', actions: 'Named actions an agent or a schedule can run.',
    inbox: 'How the inbox reaches you: where AgentX pings you when a task finishes, fails or runs long. It is under Notifications routing.',
    guests: 'Who has a guest grant, and which are waiting for approval.', people: 'The people the agents know, and which agents they may use. Add or change a person with agentx people in a terminal.',
    tokens: 'Keys for the API and other machines.', advanced: 'agentx.json as text.',
  };
  var ST_TABS = [['overview', 'Overview'], ['personality', 'Personality'], ['skills', 'Skills'], ['channels', 'Channels'], ['handovers', 'Handovers']];
  var ST_ENGINES = [['claude-code', 'Claude Code'], ['codex-cli', 'Codex CLI'], ['opencode', 'OpenCode'], ['sdk', 'Anthropic API (SDK)'], ['orchestrator', 'Orchestrator']];
  var ST_PERMS = [['default', 'Default: ask before risky tools'], ['bypassPermissions', 'Use every tool without asking'], ['plan', 'Plan only: change nothing']];
  var ST_INT_KINDS = ['telegram-bot', 'whatsapp', 'slack-bot', 'discord-bot', 'gitlab-user', 'github-user', 'gmail', 'hotmail', 'smtp',
    'hubspot', 'salesforce', 'pipedrive', 'odoo', 'trello', 'linear', 'asana', 'jira', 'notion', 'stripe', 'sentry', 'vercel', 'twilio', 'custom'];
  /** One agent's Overview fields: the PATCH /api/admin/agents key, label,
   *  input, its value in /api/admin/state, and why it needs a restart
   *  (detectAgentRestartFields in daemon/index.ts). */
  var ST_FIELDS = [
    { k: 'name', label: 'Display name', of: function (a) { return a.name || ''; } },
    { k: 'triggerWords', label: 'Wake words', hint: 'Comma or space separated, such as @support.', of: function (a) { return (a.mentions || []).join(', '); } },
    { k: 'tier', label: 'AI engine', opts: ST_ENGINES, of: function (a) { return a.tier || 'claude-code'; }, restart: 'engine' },
    { k: 'model', label: 'Model', place: 'The engine\'s default', of: function (a) { return a.model || ''; }, restart: 'model' },
    { k: 'maxConcurrent', label: 'Conversations at once', num: [1, 20], of: function (a) { return String(a.maxConcurrent || 1); } },
    { k: 'maxExecutionMinutes', label: 'Longest task, minutes', num: [1, 240], of: function (a) { return String(a.maxExecutionMinutes || 20); } },
    { k: 'access', label: 'Who can reach it', opts: [['private', 'This dashboard, its channels and the mesh'], ['public', 'Also the public API, with a token for it']], of: function (a) { return a.access === 'public' ? 'public' : 'private'; } },
    { k: 'permissionMode', label: 'Tool permissions', opts: ST_PERMS, of: function (a) { return a.permissionMode || 'default'; }, restart: 'permission mode' },
    { k: 'wikiAbsorb', label: 'Add its conversations to the wiki', opts: [['on', 'Yes'], ['off', 'No: the wiki absorb skips it']], of: function (a) { return a.wikiAbsorb !== false ? 'on' : 'off'; } },
    { k: 'systemPrompt', label: 'Instructions', long: true, of: function (a) { return a.systemPrompt || ''; } },
  ];
  /** The biggest file the editor or a new skill takes, as in classic Settings. */
  var ST_FILE_MAX = 200 * 1024;
  var ST_RESTART = 'agentx daemon restart --when-idle';
  PAGES.push('settings');
  S.st = { section: '', agent: '', tab: '', data: null, org: null, tokens: null, error: '', loading: false, v: 0, painted: '', key: '', healthSig: '', notes: {}, flash: '',
    confirm: '', files: null, td: null, drafts: {}, dialog: false, saving: false, ho: null };

  function settingsReadHash(q) {
    S.st.section = S.page === 'settings' && q.get('section') || '';
    S.st.agent = S.page === 'settings' && S.st.section === 'agents' && q.get('agent') || '';
    var tab = S.st.agent && q.get('tab') || '';
    S.st.tab = ST_TABS.some(function (t) { return t[0] === tab; }) ? tab : '';
  }
  function settingsHashInto(q) {
    if (S.st.section) q.set('section', S.st.section);
    if (S.st.agent) q.set('agent', S.st.agent);
    if (S.st.tab) q.set('tab', S.st.tab);
  }
  function stHref(section, agent, tab) {
    return '#page=settings' + (section ? '&section=' + encodeURIComponent(section) : '') + (agent ? '&agent=' + encodeURIComponent(agent) : '') + (tab && tab !== 'overview' ? '&tab=' + tab : '');
  }
  /** An agent's settings link: its Wall Settings page for the owner when it
   *  is on this machine (this node's org view lists it), else the classic page. */
  function agentPageLink(id) {
    var here = false;
    function walk(list) { (list || []).forEach(function (n) { if (n.id === id) here = true; walk(n.reports); }); }
    if (ST && S.org) { walk(S.org.roots); walk(S.org.outside); }
    return here ? '<a href="' + esc(stHref('agents', id)) + '">Settings</a>' : '<a href="/admin/agents/' + encodeURIComponent(id) + '">Agent page</a>';
  }
  /** The title row: the open agent's name, else Settings (§2). */
  function settingsTitle() {
    var a = ST && S.st.agent ? stAgentOf(S.st.agent) : null;
    return a ? (a.name || a.id) : 'Settings';
  }
  function stLabel(list, v) { var o = list.find(function (x) { return x[0] === v; }); return o ? o[1] : v; }
  function stEngine(tier) { return stLabel(ST_ENGINES, tier || 'claude-code'); }
  function stAgentOf(id) { return ((S.st.data && S.st.data.agents) || []).find(function (a) { return a.id === id; }) || null; }
  /** The agent's place in the org view: its title and paused or waiting. */
  function stOrgNode(id) {
    var found = null;
    function walk(list) { (list || []).forEach(function (n) { if (n.id === id) found = n; walk(n.reports); }); }
    if (S.st.org) { walk(S.st.org.roots); walk(S.st.org.outside); }
    return found || {};
  }
  function stNodeName() { return (S.st.data && S.st.data.nodeName) || (buildLast && buildLast.node) || 'this machine'; }
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
  function stList(xs) { return xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs.join(''); }

  async function stGet(url) {
    var r = await fetch(url, { headers: headers() });
    var b = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(b.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return b;
  }
  async function settingsLoad() {
    S.st.loading = true;
    try {
      var all = await Promise.all([stGet('/api/admin/state'), stGet('/api/admin/org').catch(function () { return null; }),
        stGet('/api/admin/tokens').catch(function () { return null; })]);
      S.st.data = all[0];
      S.st.org = all[1];
      S.st.tokens = Array.isArray(all[2]) ? all[2] : null;
      S.st.error = '';
    } catch (e) {
      S.st.error = e.status === 401 || e.status === 403 ? 'owner' : String(e.message || e);
    }
    S.st.loading = false;
    stPaint();
  }
  function stPaint() { S.st.v++; settingsShow(); }

  /** Called from render(): paints only when the section, the agent, the
   *  data or the agent's picture changed. */
  function settingsShow() {
    if (!ST || S.page !== 'settings' || S.post) return;
    var box = $('wall-settings');
    var key = S.st.section + '|' + S.st.agent + '|' + S.st.tab;
    if (key !== S.st.key) {
      // A new section, agent or tab starts clean: no notes, no open confirm.
      // What was typed in an agent's form stays in its draft.
      if (S.st.key.split('|')[1] !== S.st.agent) S.st.dialog = false;
      S.st.key = key;
      // A delete's note rides along to the list it returns to.
      S.st.notes = S.st.flash ? { list: { kind: 'ok', text: S.st.flash } } : {};
      S.st.flash = '';
      S.st.confirm = '';
      if (S.st.files && S.st.files.agent !== S.st.agent) S.st.files = null;
      if (S.st.td && S.st.td.agent !== S.st.agent) S.st.td = null;
      if (S.st.ho && S.st.ho.agent !== S.st.agent) S.st.ho = null;
    }
    if (!S.st.data && !S.st.error && !S.st.loading) settingsLoad();
    // A tab's own read starts once the agent is known (each sets its slot first).
    if (S.st.agent && S.st.data && (S.st.tab === 'personality' || S.st.tab === 'skills') && !S.st.files) stLoadFiles(S.st.agent);
    if (S.st.agent && S.st.data && S.st.tab === 'handovers' && !S.st.ho) stLoadHandovers(S.st.agent);
    var pic = S.st.agent ? pictureOf(S.st.agent) + '|' + (S.picNote ? S.picNote.text : '') : '';
    var painted = key + '|' + S.st.v + '|' + pic;
    var health = stHealthSig();
    if (S.st.painted === painted) {
      // The machines changed: repaint Health alone, so nothing typed is lost.
      if (health !== S.st.healthSig) {
        S.st.healthSig = health;
        var hp = $('st-health-phone'), hm = $('st-health-main');
        if (hp) hp.innerHTML = stHealthHtml(true);
        if (hm) hm.innerHTML = stHealthHtml(false);
      }
      return;
    }
    S.st.painted = painted;
    S.st.healthSig = health;
    var focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : '';
    box.innerHTML = settingsHtml();
    $('wall-title').textContent = settingsTitle();
    stPaintTest();
    stBarPaint();
    if (focus && $(focus)) $(focus).focus();
    if (S.st.dialog) stDialogFocus();
  }

  function stAttention() {
    var nodes = (S.live && S.live.nodes) || [];
    return { health: stHealthIssues().length, agents: 0, mesh: nodes.filter(nodeDown).length };
  }
  function settingsHtml() {
    var sec = S.st.section || 'agents';
    var att = stAttention();
    var count = S.st.data && S.st.data.agents ? S.st.data.agents.length : null;
    var menu = '<nav class="wst__menu" aria-label="Settings sections">' + ST_GROUPS.map(function (g) {
      return '<h2 class="wst__grp">' + esc(g[0]) + '</h2>' + g[1].map(function (s) {
        var on = s[0] === sec, n = s[0] === 'agents' && count != null ? '<b class="wst__c">' + count + '</b>' : att[s[0]] ? '<b class="wst__c is-warn" title="Needs attention">' + att[s[0]] + '</b>' : '';
        return '<a href="' + esc(stHref(s[0])) + '" class="wst__sec' + (on ? ' is-on' : '') + '"' + (on ? ' aria-current="page"' : '') + '>' +
          '<span>' + esc(s[1]) + '</span>' + n + (s[2] && s[2].charAt(0) !== '#' ? '<small>classic</small>' : '') + '<i class="wst__about">' + esc(stAboutOf(s[0])) + '</i></a>';
      }).join('');
    }).join('') + '</nav>';
    // On a phone the list is its own screen, with Health on top (§2).
    var phoneHealth = S.st.section ? '' : '<div class="wst__phonehealth" id="st-health-phone">' + stHealthHtml(true) + '</div>';
    return '<div class="wst' + (S.st.section ? ' has-section' : '') + '">' + '<div class="wst__side">' + phoneHealth + menu + '</div>' +
      '<div class="wst__body">' + (S.st.agent ? '' : '<a class="wst__up" href="' + esc(stHref('')) + '">← All settings</a>') + stSectionHtml(sec) + '</div></div>';
  }
  /** One line under a section on the phone's list. */
  function stAboutOf(id) {
    if (id === 'agents') { var n = S.st.data && S.st.data.agents ? S.st.data.agents.length : null; return (n != null ? n + (n === 1 ? ' agent' : ' agents') + ', their' : 'The agents, their') + ' pictures, models and on/off'; }
    if (id === 'health') return 'Machines, channels and what needs fixing';
    return ST_ABOUT[id] || '';
  }
  function stSectionHtml(sec) {
    if (S.st.error === 'owner') return '<p class="wst__err">Settings are for the owner. Sign in with the dashboard token at <code>/login</code> and open this page again.</p>';
    if (S.st.error) return '<p class="wst__err">Could not load the settings: ' + esc(S.st.error) + '.</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="reload">Try again</button>';
    if (sec === 'health') return '<header class="wst__h"><h2>Health</h2><p>The machines, the channels and what needs fixing, as in classic Settings.</p></header><div id="st-health-main">' + stHealthHtml(false) + '</div>';
    if (!S.st.data) return '<p class="ax-wall__empty" aria-busy="true">Loading…</p>';
    if (!S.st.data.exists) return '<p class="wst__err">This machine has no agentx.json yet. <a href="/setup">Run the setup</a> first.</p>';
    var s = ST_SECTIONS.find(function (x) { return x[0] === sec; }) || ST_SECTIONS[0];
    if (s[2]) {
      var where = s[2].indexOf('/admin') === 0 ? 'classic Settings' : s[2].charAt(0) === '#' ? 'the Wall' : 'its classic page';
      return '<header class="wst__h"><h2>' + esc(s[1]) + '</h2><p>' + esc(ST_ABOUT[s[0]] || '') + '</p></header>' +
        '<p class="wst__todo">' + esc(s[1]) + ' is not in Settings yet: it comes in a later step of #1428. Until then, ' + (s[2].charAt(0) === '#' ? 'see it on ' : 'change it in ') + where + '.</p>' +
        '<a class="ax-btn" href="' + esc(s[2]) + '">Open ' + esc(s[1]) + ' on ' + where + '</a>';
    }
    return S.st.agent ? stAgentHtml(S.st.agent) : stAgentsHtml();
  }

  // --- Health: the classic health strip, one line per machine, what to fix ---
  function stHealthSig() {
    var nodes = (S.live && S.live.nodes) || [];
    return nodes.map(function (n) { return n.name + (nodeDown(n) ? 'd' : nodeChecking(n) ? 'c' : 'u') + (n.restart ? n.restart.state : ''); }).join(',') + (buildLast && buildLast.diskNewer ? '!' : '');
  }
  function stChannels() {
    var d = S.st.data || {};
    var kinds = [['telegram', 'Telegram'], ['whatsapp', 'WhatsApp'], ['slack', 'Slack'], ['discord', 'Discord'], ['email', 'Email'], ['gitlab', 'GitLab']];
    var set = kinds.filter(function (k) { var c = d[k[0]]; return c && (c.enabled || (c.accounts && c.accounts.length) || c.tokenRef || c.botTokenRef || c.host); });
    return { set: set.length, on: set.filter(function (k) { return d[k[0]].enabled; }).length };
  }
  /** What needs fixing, each with a link: machines not answering, a restart waiting. */
  function stHealthIssues() {
    var out = [];
    ((S.live && S.live.nodes) || []).forEach(function (n) {
      if (nodeDown(n)) out.push({ text: n.name + ' does not answer' + (n.error ? ': ' + n.error : '') + '.', href: '#page=live', link: 'See it on Live' });
    });
    if (buildLast && buildLast.diskNewer) out.push({ text: 'The code on disk is newer than the running daemon on ' + (buildLast.node || 'this machine') + '.', href: '#page=live', link: 'Restart when idle on Live' });
    return out;
  }
  function stHealthHtml(compact) {
    var nodes = (S.live && S.live.nodes) || [];
    var agentsAll = 0, agentsUp = 0;
    nodes.forEach(function (n) { var k = (n.agents || []).length; agentsAll += k; if (!nodeDown(n) && !nodeChecking(n)) agentsUp += k; });
    var ch = S.st.data ? stChannels() : null, issues = stHealthIssues();
    var tokens = S.st.tokens ? S.st.tokens.filter(function (t) { return !t.revokedAt && !(t.expiresAt && Date.parse(t.expiresAt) < Date.now()); }).length : null;
    function stat(num, label, warn) { return '<div class="wsh__s' + (warn ? ' is-warn' : '') + '"><b>' + esc(num) + '</b><span>' + esc(label) + '</span></div>'; }
    var strip = '<div class="wsh__strip">' +
      stat(nodes.length ? agentsUp + ' of ' + agentsAll : '—', 'agents online') +
      stat(ch ? ch.on + ' of ' + ch.set : '—', 'channels on') +
      stat(String(issues.length), 'needs attention', issues.length > 0) +
      stat(tokens == null ? '—' : String(tokens), 'active tokens') + '</div>';
    var lines = nodes.length ? '<ul class="wsh__nodes">' + nodes.map(function (n) {
      var down = nodeDown(n), checking = nodeChecking(n);
      var what = checking ? 'checking…' : down ? (n.stale && n.staleSince ? 'not answering since ' + stamp(Date.parse(n.staleSince)) : 'not answering') : 'answering' + (n.version ? ' · v' + n.version : '');
      var restart = n.restart && n.restart.state && n.restart.state !== 'none' ? '<span class="ax-badge ax-badge--warn">Restart ' + esc(n.restart.state) + '</span>' : '';
      return '<li class="' + (down ? 'is-down' : checking ? 'is-check' : 'is-up') + '"><i aria-hidden="true"></i><b>' + esc(n.name) + '</b><span>' + esc(what) + '</span>' + restart + '</li>';
    }).join('') + '</ul>' : '<p class="ax-wall__empty">' + (S.liveError ? 'Could not reach the machines just now; trying again.' : 'Loading the machines…') + '</p>';
    var fix = issues.length ? '<ul class="wsh__fix">' + issues.map(function (x) { return '<li>' + esc(x.text) + ' <a href="' + esc(x.href) + '">' + esc(x.link) + '</a></li>'; }).join('') + '</ul>'
      : nodes.length ? '<p class="wsh__ok">Nothing to fix.</p>' : '';
    return '<section class="wsh' + (compact ? ' wsh--compact' : '') + '" aria-label="Health">' + (compact ? '<h2>Health</h2>' : '') + strip + lines + fix + '</section>';
  }

  // --- Agents: one card each, then add one, then the wiki page curator ---
  function stSwitchHtml(a) {
    var o = stOrgNode(a.id);
    if (o.status === 'waiting') return '<a class="chip chip--warn wsa__wait" href="/approvals" title="It starts once you approve it in Approvals">Waits for approval</a>';
    var on = o.status !== 'paused';
    return '<button type="button" class="wsa__sw" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-st-hold="' + esc(a.id) + '"' +
      ' title="' + (on ? 'On. Turn off: it starts no run until you turn it back on.' : 'Off: it starts no run. Turn on to let it work again.') + '">' +
      '<span>' + (on ? 'On' : 'Off') + '</span><i aria-hidden="true"></i><span class="wst__sr"> ' + esc(a.name || a.id) + '</span></button>';
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
    return '<header class="wst__h"><h2>Agents</h2><p>Each agent is a role with its own wake words and workspace, on ' + esc(stNodeName()) + '. Select one to change it. Off stops it starting new runs.</p></header>' + stNoteHtml('list') +
      '<div class="wsa-list">' + (list.length ? list.map(stCardHtml).join('') : '<p class="ax-wall__empty">No agents yet. Add the first one below.</p>') + '</div>' +
      stAddHtml() + stCuratorHtml();
  }
  function stAddHtml() {
    return '<details class="wsx"' + (S.st.addOpen ? ' open' : '') + ' data-st-details="add"><summary>Add an agent</summary>' +
      '<form class="wsf" data-st-form="add">' +
        '<div class="wsf__row"><label><span>Agent id <small>lowercase letters, digits, - and _</small></span><input id="st-a-id" maxlength="40" placeholder="sales" autocomplete="off"></label>' +
        '<label>Name<input id="st-a-name" maxlength="80" placeholder="Sales Desk"></label></div>' +
        '<label><span>Wake words <small>comma or space separated</small></span><input id="st-a-triggers" placeholder="@sales, sales"></label>' +
        '<div class="wsf__row"><label>AI engine<select id="st-a-tier">' + stOptions(ST_ENGINES, 'claude-code') + '</select></label>' +
        '<label><span>Model <small>optional</small></span><input id="st-a-model" placeholder="the engine\'s default"></label></div>' +
        '<label><span>Instructions <small>optional</small></span><textarea id="st-a-personality" rows="3" placeholder="You answer pricing questions and pass support questions to @support."></textarea></label>' +
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

  // --- One agent: the classic tabs, the picture and the switch on top ---
  function stAgentHtml(id) {
    var a = stAgentOf(id);
    if (!a) return '<a class="wst__up wst__up--all" href="' + esc(stHref('agents')) + '">← Agents</a><p class="ax-wall__empty">No agent @' + esc(id) + ' on this machine.</p>';
    var o = stOrgNode(id), tab = S.st.tab || 'overview';
    var tabs = '<div class="wst__tabs" role="tablist" aria-label="' + esc(a.name || a.id) + '">' + ST_TABS.map(function (t) {
      var on = t[0] === tab;
      return '<a role="tab" href="' + esc(stHref('agents', id, t[0])) + '" class="' + (on ? 'is-on' : '') + '" aria-selected="' + on + '">' + esc(t[1]) + '</a>';
    }).join('') + '</div>';
    var body = tab === 'personality' ? stFilesHtml(a, 'personality') : tab === 'skills' ? stFilesHtml(a, 'skills')
      : tab === 'channels' ? stIntegrationsHtml(a) : tab === 'handovers' ? stHandoversHtml(a)
      : stEditHtml(a) + stTestHtml(a) + stDeleteHtml(a);
    return '<nav class="wst__crumb" aria-label="Where you are"><a href="' + esc(stHref('agents')) + '">Agents</a> › ' + esc(a.name || a.id) + ' · on ' + esc(stNodeName()) + '</nav>' + tabs +
      '<header class="wsa-head">' + avatar(id, 'lg') + '<div class="wsa__b"><h2>' + esc(a.name || a.id) + '</h2>' +
        '<small>@' + esc(a.id) + (o.title ? ' · ' + esc(o.title) : '') + ' · on ' + esc(stNodeName()) + '</small>' + pictureActsHtml(id) + stNoteHtml('hold-' + a.id) + '</div>' + stSwitchHtml(a) + '</header>' +
      body;
  }

  // --- Overview: the edit state, the bar and the confirm (§2) ---
  function stDraft(id) { return S.st.drafts[id] || (S.st.drafts[id] = {}); }
  function stFieldOf(k) { return ST_FIELDS.find(function (f) { return f.k === k; }); }
  /** The fields whose typed value differs from the saved one. */
  function stChanges(id) {
    var a = stAgentOf(id), d = S.st.drafts[id] || {};
    if (!a) return [];
    return ST_FIELDS.filter(function (f) { return Object.prototype.hasOwnProperty.call(d, f.k) && d[f.k] !== f.of(a); })
      .map(function (f) { return { f: f, from: f.of(a), to: d[f.k] }; });
  }
  function stShow(f, v) {
    if (f.opts) return stLabel(f.opts, v);
    if (f.k === 'model' && !v) return 'the engine\'s default';
    return v === '' ? '(empty)' : v;
  }
  function stWasHtml(f, a, v) {
    var from = f.of(a);
    if (v === from) return '';
    return f.long ? 'Changed from the saved instructions.' : 'Changed from ' + stShow(f, from) + '.' + (f.restart ? ' Needs a restart.' : '');
  }
  function stFieldHtml(f, a) {
    var d = stDraft(a.id), v = Object.prototype.hasOwnProperty.call(d, f.k) ? d[f.k] : f.of(a), changed = v !== f.of(a);
    var id = 'st-e-' + f.k, attr = ' id="' + id + '" data-st-f="' + f.k + '" class="' + (changed ? 'is-changed' : '') + '" aria-describedby="' + id + '-was"';
    var input = f.opts ? '<select' + attr + '>' + stOptions(f.opts, v) + '</select>'
      : f.long ? '<textarea' + attr + ' rows="6">' + esc(v) + '</textarea>'
      : '<input' + attr + (f.num ? ' type="number" min="' + f.num[0] + '" max="' + f.num[1] + '"' : ' maxlength="' + (f.k === 'name' ? 80 : 400) + '"') + (f.place ? ' placeholder="' + esc(f.place) + '"' : '') + ' value="' + esc(v) + '">';
    return '<label class="wsf__fld' + (f.long ? ' is-long' : '') + '"><span>' + esc(f.label) + (f.hint ? ' <small>' + esc(f.hint) + '</small>' : '') + '</span>' + input +
      '<small class="wsf__was" id="' + id + '-was">' + esc(stWasHtml(f, a, v)) + '</small></label>';
  }
  function stEditHtml(a) {
    return '<form class="wsf wsc wse-form" data-st-form="edit" data-id="' + esc(a.id) + '" novalidate>' +
      '<div class="wsf__grid">' + ST_FIELDS.map(function (f) { return stFieldHtml(f, a); }).join('') + '</div>' +
      '<div class="wsb" id="st-bar" role="region" aria-label="Changes not saved" aria-live="polite"></div>' +
      '<div id="st-dialog"></div>' +
    '</form>';
  }
  function stRestartOf(changes) { return changes.filter(function (c) { return c.f.restart; }).map(function (c) { return c.f.restart; }); }
  /** The bottom bar: how many changes, whether they need a restart, Discard and Save…; or the last save's answer. */
  function stBarPaint() {
    var bar = $('st-bar');
    if (!bar || !S.st.agent) return;
    var ch = stChanges(S.st.agent), note = S.st.notes.save;
    if (!ch.length) {
      bar.className = 'wsb' + (note && note.text ? ' is-' + (note.kind || 'info') : ' is-empty');
      bar.innerHTML = note && note.text ? '<p>' + esc(note.text) + '</p>' : '';
      return;
    }
    var restart = stRestartOf(ch);
    var text = (note && note.kind === 'err' ? note.text + ' ' : '') + ch.length + (ch.length === 1 ? ' change' : ' changes') + ' not saved. ' +
      (restart.length ? 'The new ' + stList(restart) + ' need' + (restart.length === 1 ? 's' : '') + ' a restart.' : (ch.length === 1 ? 'It applies' : 'They apply') + ' without a restart.');
    bar.className = 'wsb is-dirty' + (note && note.kind === 'err' ? ' is-err' : '');
    // Only the line changes while the buttons are there: a field's change
    // event on blur must not swap Save… out from under the click.
    var line = $('st-bar-line');
    if (line && bar.querySelector('[data-st-act="review"]')) { line.textContent = text; return; }
    bar.innerHTML = '<p id="st-bar-line">' + esc(text) + '</p>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="discard">Discard</button>' +
      '<button type="button" class="ax-btn" data-st-act="review">Save…</button>';
  }
  /** What else moves with a change of model or engine: the agent's recurring jobs and its spend. */
  function stAlsoMoves(a, changes) {
    var out = [], name = a.name || a.id;
    var tierOrModel = changes.some(function (c) { return c.f.k === 'model' || c.f.k === 'tier'; });
    if (tierOrModel) {
      var jobs = ((S.st.data && S.st.data.crons) || []).filter(function (c) { return c.agent === a.id; });
      var follow = jobs.filter(function (c) { return !c.model; }), own = jobs.filter(function (c) { return c.model; });
      if (follow.length) out.push(name + '\'s ' + (follow.length === 1 ? 'recurring job follows' : follow.length + ' recurring jobs follow') + ' the agent\'s model, so ' + (follow.length === 1 ? 'it changes' : 'they change') + ' too.');
      if (own.length) out.push(own.length === 1 ? 'The job ' + own[0].id + ' names its own model (' + own[0].model + ') and keeps it: change it on Jobs to match.'
        : own.length + ' jobs name their own model and keep it (' + own.map(function (c) { return c.id; }).join(', ') + '): change them on Jobs to match.');
      var row = S.budgets && (S.budgets.agents || []).find(function (r) { return r.agentId === a.id; });
      if (S.budgets) out.push(row && row.capUsd ? 'Spend may change: ' + name + '\'s month cap is $' + Number(row.capUsd).toFixed(2).replace(/\.00$/, '') + '.' : 'Spend may change, and ' + name + ' has no month cap.');
    }
    var restart = stRestartOf(changes);
    out.push(restart.length ? 'The new ' + stList(restart) + ' ' + (restart.length === 1 ? 'applies' : 'apply') + ' after a restart: ' + ST_RESTART + '.' : 'No restart needed: it applies from the agent\'s next run.');
    return out;
  }
  function stDialogHtml() {
    var a = stAgentOf(S.st.agent), ch = stChanges(S.st.agent);
    if (!a || !ch.length) return '';
    var rows = ch.map(function (c) {
      var from = c.f.long ? 'the saved text' : stShow(c.f, c.from), to = c.f.long ? 'the new text (' + c.to.length + ' characters)' : stShow(c.f, c.to);
      return '<tr><th scope="row">' + esc(c.f.label) + '</th><td><s>' + esc(from) + '</s> → <b>' + esc(to) + '</b></td></tr>';
    }).join('');
    return '<div class="wsd__scrim" data-st-act="back"></div><div class="wsd" role="dialog" aria-modal="true" aria-labelledby="st-dlg-h">' +
      '<h3 id="st-dlg-h">Save ' + ch.length + (ch.length === 1 ? ' change' : ' changes') + ' to ' + esc(a.name || a.id) + '?</h3>' +
      '<table class="wsd__t">' + rows + '</table>' +
      '<p>' + stAlsoMoves(a, ch).map(esc).join(' ') + '</p>' +
      '<div class="wsf__foot"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="back">Back</button>' +
      '<button type="button" class="ax-btn" data-st-act="save"' + (S.st.saving ? ' disabled' : '') + '>' + (S.st.saving ? 'Saving…' : 'Save changes') + '</button></div></div>';
  }
  function stDialogFocus() { var b = document.querySelector('.wsd [data-st-act="save"]'); if (b) b.focus(); }
  function stOpenDialog(open) {
    S.st.dialog = open;
    var box = $('st-dialog');
    if (box) box.innerHTML = open ? stDialogHtml() : '';
    if (open) stDialogFocus();
    else { var b = document.querySelector('[data-st-act="review"]'); if (b) b.focus(); }
  }
  /** A typed value: the draft, the blue state and the "changed from" line, in place. */
  function stTyped(el) {
    var id = S.st.agent, a = stAgentOf(id), f = stFieldOf(el.getAttribute('data-st-f'));
    if (!a || !f) return;
    stDraft(id)[f.k] = String(el.value);
    var changed = el.value !== f.of(a);
    el.classList.toggle('is-changed', changed);
    var was = $(el.id + '-was');
    if (was) was.textContent = stWasHtml(f, a, String(el.value));
    if (S.st.notes.save && S.st.notes.save.kind !== 'err') S.st.notes.save = null;
    stBarPaint();
  }
  function stPatchOf(changes) {
    var patch = {};
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i], v = c.to;
      if (c.f.num) {
        var n = parseInt(v, 10);
        if (!isFinite(n) || n < c.f.num[0] || n > c.f.num[1]) return { error: c.f.label + ' must be a number from ' + c.f.num[0] + ' to ' + c.f.num[1] + '.' };
        patch[c.f.k] = n;
      } else if (c.f.k === 'wikiAbsorb') patch.wikiAbsorb = v === 'on';
      else if (c.f.k === 'name') { if (!v.trim()) return { error: 'The display name cannot be empty.' }; patch.name = v.trim(); }
      else patch[c.f.k] = c.f.long ? v : v.trim();
    }
    return { patch: patch };
  }
  async function stSaveEdit() {
    var id = S.st.agent, ch = stChanges(id);
    if (!ch.length || S.st.saving) return;
    var p = stPatchOf(ch);
    if (p.error) { S.st.notes.save = { kind: 'err', text: 'Not saved: ' + p.error }; stOpenDialog(false); stBarPaint(); return; }
    S.st.saving = true;
    stOpenDialog(true);
    var r = await act('PATCH', '/api/admin/wall/settings/agents', { id: id, patch: p.patch });
    S.st.saving = false;
    if (!r.ok) {
      // The form keeps what was typed; the bar says why.
      S.st.notes.save = { kind: 'err', text: 'Not saved: ' + r.error + '.' };
      stOpenDialog(false);
      stBarPaint();
      return;
    }
    var restart = stRestartOf(ch);
    S.st.drafts[id] = {};
    S.st.dialog = false;
    S.st.notes.save = restart.length
      ? { kind: 'warn', text: 'Saved. Restart the daemon for the new ' + stList(restart) + ' to apply: ' + ST_RESTART + '.' }
      : { kind: 'ok', text: 'Saved. It applies from the agent\'s next run.' };
    await settingsLoad();
  }

  function stConfirmHtml(key, text, yes) {
    if (S.st.confirm !== key) return '';
    return '<div class="wsk" role="alertdialog" aria-label="Confirm"><p>' + text + '</p>' +
      '<button type="button" class="ax-btn wsk__yes" data-st-act="confirm" data-key="' + esc(key) + '">' + esc(yes) + '</button> ' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="cancel">Keep it</button></div>';
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
        stConfirmHtml('int:' + n, 'Remove ' + esc(i.kind) + ' "' + esc(i.label) + '" from @' + esc(a.id) + '? Its environment variable stays as it is.', 'Remove') + '</li>';
    }).join('');
    return '<section class="wsc"><h3>Integrations <small>' + list.length + '</small></h3>' +
      '<p class="wsf__hint">Credentials for outside services. Only the names of environment variables are kept here; the secrets stay in the environment or the keyring. Which chat accounts answer as this agent is under Channels in classic Settings.</p>' +
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
  /** Personality: the instruction files. Skills: the skills. Both open in the same editor. */
  function stFilesHtml(a, which) {
    var f = S.st.files, skills = which === 'skills';
    var head = '<section class="wsc" id="st-files"><h3>' + (skills ? 'Skills' : 'Personality and instructions') + '</h3><p class="wsf__hint">' +
      (skills ? 'What the agent knows how to do, one folder with a SKILL.md each, in its workspace.' : 'The files the agent reads before every run, in its workspace.') + '</p>';
    if (!f) return head + '<p class="ax-wall__empty" aria-busy="true">Loading…</p></section>';
    if (f.error) return head + '<p class="wst__err">Could not list the files: ' + esc(f.error) + '</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="files" data-id="' + esc(a.id) + '">Try again</button></section>';
    if (!f.overview) return head + '<p class="ax-wall__empty" aria-busy="true">Loading…</p></section>';
    var ov = f.overview;
    var items = skills ? (ov.skills || []).map(function (x, n) {
      return '<li><button type="button" class="wsl__f' + (f.path === x.path ? ' is-on' : '') + '" data-st-act="open-file" data-path="' + esc(x.path) + '">' + esc(x.title) + '<small>' + esc(x.slug) + '</small></button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="skill:' + n + '">Delete</button>' +
        stConfirmHtml('skill:' + n, 'Delete the skill "' + esc(x.slug) + '"? Its folder and SKILL.md are removed from disk.', 'Delete') + '</li>';
    }).join('') : (ov.identity || []).map(function (x) {
      return '<li><button type="button" class="wsl__f' + (f.path === x.path ? ' is-on' : '') + '" data-st-act="open-file" data-path="' + esc(x.path) + '">' + esc(x.title) + '<small>' + (x.exists ? stFmtBytes(x.size) : 'not made yet') + '</small></button></li>';
    }).join('');
    var mine = f.path && (skills ? (ov.skills || []) : (ov.identity || [])).some(function (x) { return x.path === f.path; });
    var editor = mine ? '<div class="wse"><p class="wse__p"><code>' + esc(f.path) + '</code></p>' +
        '<textarea id="st-f-text" rows="14" spellcheck="false" aria-label="' + esc(f.path) + '">' + esc(f.text) + '</textarea>' +
        '<div class="wsf__foot"><button type="button" class="ax-btn" data-st-act="save-file">Save</button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="revert-file">Revert</button>' +
        '<label class="ax-btn ax-btn--ghost wse__up">Load a file<input type="file" id="st-f-up" accept=".md,.markdown,.txt,text/markdown,text/plain"></label>' + stNoteHtml('file') + '</div></div>'
      : '<p class="ax-wall__empty">' + (skills ? 'Pick a skill to read or change it.' : 'Pick a file to read or change it.') + '</p>' + stNoteHtml('file');
    return head + '<div class="wsl"><ul>' + (items || '<li class="ax-wall__empty">' + (skills ? 'No skills yet.' : 'None.') + '</li>') + '</ul>' + editor + '</div>' +
      (skills ? '<details class="wsx"><summary>Add a skill</summary><form class="wsf" data-st-form="skill">' +
        '<div class="wsf__row"><label><span>Slug <small>lowercase</small></span><input id="st-s-slug" maxlength="60" placeholder="weekly-report"></label>' +
        '<label><span>Title <small>optional</small></span><input id="st-s-title" maxlength="120"></label></div>' +
        '<label><span>SKILL.md <small>optional: without one, a template is made</small></span><input type="file" id="st-s-file" accept=".md,.markdown,.txt,text/markdown,text/plain"></label>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Add skill</button>' + stNoteHtml('skill') + '</div>' +
      '</form></details>' : '') +
      '<p class="wsf__hint"><a href="/admin/agents/' + encodeURIComponent(a.id) + '">The classic agent page</a> has the same files with a Markdown preview.</p></section>';
  }
  // --- Handovers: chats routed to or from this agent (agent-panel.ts) ---
  function stHandoversHtml(a) {
    var h = S.st.ho;
    var head = '<section class="wsc"><h3>Handovers</h3><p class="wsf__hint">Pass a chat to another agent. Every message from that chat goes to the new agent until you release the handover.</p>';
    if (!h || (!h.data && !h.error)) return head + '<p class="ax-wall__empty" aria-busy="true">Loading…</p></section>';
    if (h.error) return head + '<p class="wst__err">Could not read the handovers: ' + esc(h.error) + '</p><button type="button" class="ax-btn ax-btn--ghost" data-st-act="ho-load">Try again</button></section>';
    function rows(list, dir) {
      if (!list.length) return '<p class="ax-wall__empty">' + (dir === 'out' ? 'No chat is routed away from this agent.' : 'No chat is routed to this agent.') + '</p>';
      return '<ul class="wsi-list">' + list.map(function (o, n) {
        var key = 'ho:' + dir + ':' + n;
        return '<li class="wsi"><div><b>' + esc(o.channel) + ' · ' + esc(o.chatId) + '</b><small>' + (dir === 'out' ? 'handed to ' + esc(o.toAgent) : 'from ' + esc(o.fromAgent)) +
          ' · ' + (o.expiresAt ? 'until ' + esc(o.expiresAt) : 'no end') + (o.summary ? (o.summaryConsumedAt ? ' · note delivered' : ' · note waiting') : '') + '</small></div>' +
          '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + key + '">Release</button>' +
          stConfirmHtml(key, 'Release ' + esc(o.channel) + ' ' + esc(o.chatId) + '? Its next message goes where agentx.json routes it.', 'Release') + '</li>';
      }).join('') + '</ul>';
    }
    var others = (S.st.data.agents || []).filter(function (x) { return x.id !== a.id; }).map(function (x) { return [x.id, x.name || x.id]; });
    return head + stNoteHtml('ho') +
      '<h4>Routed away from ' + esc(a.name || a.id) + '</h4>' + rows(h.data.outgoing || [], 'out') +
      '<h4>Routed to ' + esc(a.name || a.id) + '</h4>' + rows(h.data.incoming || [], 'in') +
      '<details class="wsx"><summary>Hand a chat to another agent</summary><form class="wsf" data-st-form="ho">' +
        '<div class="wsf__row"><label>Channel<select id="st-h-ch">' + stOptions([['telegram', 'Telegram'], ['whatsapp', 'WhatsApp']], 'telegram') + '</select></label>' +
        '<label><span>Chat id <small>who it is with</small></span><input id="st-h-chat" autocomplete="off"></label></div>' +
        '<div class="wsf__row"><label>Hand to<select id="st-h-to">' + stOptions([['', 'Pick an agent']].concat(others), '') + '</select></label>' +
        '<label><span>Account <small>optional</small></span><input id="st-h-acct" placeholder="default"></label></div>' +
        '<label><span>A note for the agent that takes it <small>optional, read once</small></span><textarea id="st-h-note" rows="3"></textarea></label>' +
        '<label><span>Until <small>optional date, such as 2026-12-01; empty means until you release it</small></span><input id="st-h-until"></label>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Hand over</button>' + stNoteHtml('ho-add') + '</div>' +
      '</form></details></section>';
  }
  function stTestHtml(a) {
    return '<section class="wsc"><h3>Test drive</h3><p class="wsf__hint">Send @' + esc(a.id) + ' a message and read its answer here, before it answers on a real channel. It runs for real, with the saved settings.</p>' +
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
    var r = await act('POST', '/api/admin/wall/settings/org/hold', { agent: id, paused: pause });
    if (!r.ok) { stNote('hold-' + id, 'err', 'Not changed: ' + r.error); return; }
    S.st.notes['hold-' + id] = { kind: 'ok', text: pause ? 'Off: it starts no run until you turn it back on.' : 'On: it works again.' };
    await settingsLoad();
  }
  async function stAdd() {
    var body = {
      id: stVal('st-a-id').trim(), name: stVal('st-a-name').trim(), triggerWords: stVal('st-a-triggers').trim(), tier: stVal('st-a-tier') || 'claude-code',
      model: stVal('st-a-model').trim() || undefined, personality: stVal('st-a-personality').trim() || undefined, access: stChecked('st-a-public') ? 'public' : 'private',
    };
    stNote('add', '', 'Adding…');
    var r = await act('POST', '/api/admin/wall/settings/agents', body);
    if (!r.ok) { stNote('add', 'err', 'Not added: ' + r.error); return; }
    var note = 'Added @' + body.id + '. It starts working after a daemon restart: ' + ST_RESTART + '.';
    if (body.access === 'public') {
      var p = await act('POST', '/api/admin/wall/settings/agents/access', { id: body.id, access: 'public' });
      if (!p.ok) note += ' It stays private: ' + p.error;
    }
    S.st.addOpen = true;
    S.st.notes.add = { kind: 'ok', text: note };
    await settingsLoad();
  }
  async function stSaveCurator() {
    stNote('curator', '', 'Saving…');
    var r = await act('POST', '/api/admin/wall/settings/wiki/curator', { enabled: stChecked('st-wc-on'), agent: stVal('st-wc-agent') });
    if (!r.ok) { stNote('curator', 'err', 'Not saved: ' + r.error); return; }
    S.st.curatorOpen = true;
    S.st.notes.curator = { kind: 'ok', text: 'Saved.' };
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
    var r = await act('POST', '/api/admin/wall/settings/agents/integrations', { agentId: id, kind: kind, label: label, credentials: { tokenEnv: env }, metadata: metadata });
    if (!r.ok) { stNote('int-add', 'err', 'Not added: ' + r.error); return; }
    S.st.notes.int = { kind: 'ok', text: 'Added ' + kind + ' "' + label + '".' };
    await settingsLoad();
  }
  async function stLoadHandovers(id) {
    S.st.ho = { agent: id, data: null, error: '' };
    stPaint();
    try { S.st.ho.data = await stGet('/api/admin/agent/' + encodeURIComponent(id) + '/handovers'); }
    catch (e) { S.st.ho.error = String(e.message || e); }
    stPaint();
  }
  async function stAddHandover(id) {
    var body = { channel: stVal('st-h-ch'), chatId: stVal('st-h-chat').trim(), toAgent: stVal('st-h-to'), accountId: stVal('st-h-acct').trim() || undefined,
      summary: stVal('st-h-note').trim() || undefined, expiresAt: stVal('st-h-until').trim() || undefined };
    if (!body.chatId || !body.toAgent) { stNote('ho-add', 'err', 'Write the chat id and pick the agent that takes it.'); return; }
    stNote('ho-add', '', 'Handing over…');
    var r = await act('POST', '/api/admin/wall/settings/agent/' + encodeURIComponent(id) + '/handovers', body);
    if (!r.ok) { stNote('ho-add', 'err', 'Not handed over: ' + r.error); return; }
    S.st.notes.ho = { kind: 'ok', text: 'Handed ' + body.channel + ' ' + body.chatId + ' to ' + body.toAgent + '.' };
    await stLoadHandovers(id);
  }
  async function stConfirmed(key) {
    var id = S.st.agent, a = stAgentOf(id);
    S.st.confirm = '';
    if (key === 'delete') {
      stPaint();
      stNote('delete', '', 'Deleting…');
      var r = await act('DELETE', '/api/admin/wall/settings/agents', { id: id });
      if (!r.ok) { stNote('delete', 'err', 'Not deleted: ' + r.error); return; }
      S.st.flash = 'Deleted @' + id + '. Its workspace folder is still on disk. Restart the daemon to stop it: ' + ST_RESTART + '.';
      S.st.data = null;
      delete S.st.drafts[id];
      location.hash = stHref('agents');
      settingsLoad();
      return;
    }
    if (key.indexOf('int:') === 0) {
      var i = a && (a.integrations || [])[+key.slice(4)];
      stPaint();
      if (!i) return;
      stNote('int', '', 'Removing…');
      var ri = await act('DELETE', '/api/admin/wall/settings/agents/integrations', { agentId: id, kind: i.kind, label: i.label });
      if (!ri.ok) { stNote('int', 'err', 'Not removed: ' + ri.error); return; }
      S.st.notes.int = { kind: 'ok', text: 'Removed ' + i.kind + ' "' + i.label + '".' };
      await settingsLoad();
      return;
    }
    if (key.indexOf('ho:') === 0) {
      var parts = key.split(':'), list = S.st.ho && S.st.ho.data && S.st.ho.data[parts[1] === 'out' ? 'outgoing' : 'incoming'], o = list && list[+parts[2]];
      stPaint();
      if (!o) return;
      stNote('ho', '', 'Releasing…');
      var rh = await act('DELETE', '/api/admin/wall/settings/agent/' + encodeURIComponent(id) + '/handovers', { channel: o.channel, chatId: o.chatId, accountId: o.accountId || undefined });
      if (!rh.ok) { stNote('ho', 'err', 'Not released: ' + rh.error); return; }
      S.st.notes.ho = { kind: 'ok', text: 'Released ' + o.channel + ' ' + o.chatId + '.' };
      await stLoadHandovers(id);
      return;
    }
    if (key.indexOf('skill:') === 0) {
      var s = S.st.files && S.st.files.overview && S.st.files.overview.skills[+key.slice(6)];
      stPaint();
      if (!s) return;
      stNote('file', '', 'Deleting…');
      var rs = await act('DELETE', '/api/admin/wall/settings/files/skill', { agent: id, slug: s.slug });
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
    var r = await act('PUT', '/api/admin/wall/settings/files', { agent: f.agent, path: f.path, content: f.text });
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
    var r = await act('POST', '/api/admin/wall/settings/files/skill', body);
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
    var r = await act('POST', '/api/admin/wall/settings/agents/test', { agent: id, message: text, chatId: t.chatId });
    t.busy = false;
    t.msgs.pop();
    var reply = r.ok ? (r.body.response && (r.body.response.content || r.body.response.error)) || '(no answer)' : r.error;
    t.msgs.push({ kind: r.ok && !(r.body.response && r.body.response.error) ? 'agent' : 'err', text: reply });
    stPaintTest();
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings' || !ST) return;
    var t = ev.target.closest('[data-st-act],[data-st-hold]');
    if (!t) return;
    if (t.hasAttribute('data-st-hold')) { ev.preventDefault(); stHold(t.getAttribute('data-st-hold')); return; }
    var a = t.getAttribute('data-st-act'), id = t.getAttribute('data-id');
    if (a === 'reload') { S.st.error = ''; settingsLoad(); }
    else if (a === 'ask') { S.st.confirm = t.getAttribute('data-key'); stPaint(); var y = document.querySelector('.wsk__yes[data-st-act="confirm"]'); if (y) y.focus(); }
    else if (a === 'cancel') { S.st.confirm = ''; stPaint(); }
    else if (a === 'confirm') stConfirmed(t.getAttribute('data-key'));
    else if (a === 'discard') { S.st.drafts[S.st.agent] = {}; S.st.notes.save = null; stPaint(); }
    else if (a === 'review') { S.st.notes.save = null; stOpenDialog(true); }
    else if (a === 'back') { if (!S.st.saving) stOpenDialog(false); }
    else if (a === 'save') stSaveEdit();
    else if (a === 'files') stLoadFiles(id);
    else if (a === 'ho-load') stLoadHandovers(S.st.agent);
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
    // Enter in a field of the agent form opens the confirm, as Save… does.
    if (kind === 'edit') { if (stChanges(S.st.agent).length) stOpenDialog(true); }
    else if (kind === 'add') stAdd();
    else if (kind === 'curator') stSaveCurator();
    else if (kind === 'int') stAddInt(id);
    else if (kind === 'skill') stAddSkill();
    else if (kind === 'ho') stAddHandover(S.st.agent);
  });
  function stOnTyped(ev) {
    var t = ev.target;
    if (!t) return;
    if (t.getAttribute && t.getAttribute('data-st-f')) stTyped(t);
    else if (t.id === 'st-f-text' && S.st.files) S.st.files.text = t.value;
  }
  document.addEventListener('input', stOnTyped);
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t && t.getAttribute && t.getAttribute('data-st-f')) { stTyped(t); return; }
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
    if (S.page !== 'settings' || !ev.target || !ST) return;
    if (ev.target.id === 'st-td-text' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); stSendTest(S.st.agent); }
    else if (ev.target.id === 'st-f-text' && ev.key === 's' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); stSaveFile(); }
    else if (ev.key === 'Escape' && S.st.dialog) { if (!S.st.saving) stOpenDialog(false); }
    else if (ev.key === 'Escape' && S.st.confirm) { S.st.confirm = ''; stPaint(); }
    else if (ev.key === 'Tab' && S.st.dialog) {
      // Focus stays in the confirm while it is open.
      var btns = Array.prototype.slice.call(document.querySelectorAll('.wsd button:not([disabled])'));
      if (!btns.length) return;
      var i = btns.indexOf(document.activeElement);
      if (ev.shiftKey && i <= 0) { ev.preventDefault(); btns[btns.length - 1].focus(); }
      else if (!ev.shiftKey && i === btns.length - 1) { ev.preventDefault(); btns[0].focus(); }
    }
  });
  // Leaving the page with changes not saved asks first.
  window.addEventListener('beforeunload', function (ev) {
    if (!ST) return;
    var dirty = Object.keys(S.st.drafts).some(function (id) { return stChanges(id).length > 0; });
    if (dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });
  // The open Add and curator boxes stay open across a repaint.
  document.addEventListener('toggle', function (ev) {
    var d = ev.target, k = d && d.getAttribute && d.getAttribute('data-st-details');
    if (k === 'add') S.st.addOpen = d.open;
    else if (k === 'curator') S.st.curatorOpen = d.open;
  }, true);
`

export const WALL_SETTINGS_CSS = `
/* Settings (#1428, design #1451 frame 2): the grouped sections beside the
   chosen one; on a phone, the list (with Health on top) is its own screen. */
.wst { display: grid; grid-template-columns: 200px minmax(0, 1fr); align-items: start; }
.wst__side { position: sticky; top: 0; border-right: 1px solid var(--ax-border); min-height: 60vh; }
.wst__menu { display: flex; flex-direction: column; padding: 8px 0 16px; }
.wst__grp { margin: 14px 16px 4px; font-size: var(--ax-fs-xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ax-muted); }
.wst__sec { display: flex; align-items: center; gap: 8px; padding: 9px 16px; color: var(--ax-text); text-decoration: none; border-left: 3px solid transparent; }
.wst__sec:hover { background: var(--ax-surface); }
.wst__sec:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: -2px; }
.wst__sec.is-on { border-left-color: var(--ax-accent); background: var(--ax-surface); font-weight: 700; }
.wst__sec small { color: var(--ax-muted); font-weight: 400; font-size: 12px; margin-left: auto; }
.wst__c { font-size: 12px; font-weight: 700; min-width: 20px; height: 20px; padding: 0 6px; border-radius: var(--ax-radius-pill); display: inline-flex; align-items: center; justify-content: center; background: var(--ax-surface-2); color: var(--ax-text-2); }
.wst__sec.is-on .wst__c:not(.is-warn) { background: var(--ax-accent); color: #fff; }
.wst__c.is-warn { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.wst__about { display: none; }
.wst__phonehealth { display: none; }
.wst__body { padding: 12px 20px 32px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.wst__up { display: none; color: var(--ax-accent); text-decoration: none; font-size: var(--ax-fs-sm); }
.wst__up--all { display: inline; }
.wst__crumb { font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.wst__crumb a { color: var(--ax-accent); text-decoration: none; }
.wst__tabs { display: flex; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--ax-border); margin: 0 -20px; padding: 0 12px; }
.wst__tabs a { flex: 1 0 auto; text-align: center; padding: 12px 14px 10px; color: var(--ax-muted); font-weight: 600; text-decoration: none; border-bottom: 3px solid transparent; white-space: nowrap; }
.wst__tabs a:hover { background: var(--ax-surface); }
.wst__tabs a.is-on { color: var(--ax-text); border-bottom-color: var(--ax-accent); }
.wst__tabs a:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: -2px; }
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

/* Health: the classic strip, one line per machine, what to fix. */
.wsh { display: flex; flex-direction: column; gap: 12px; }
.wsh h2 { margin: 0; font-size: 18px; font-weight: 800; }
.wsh__strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.wsh__s { border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 10px 12px; display: flex; flex-direction: column; }
.wsh__s b { font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; }
.wsh__s span { color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.wsh__s.is-warn b { color: var(--ax-amber-ink); }
.wsh__nodes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wsh__nodes li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: var(--ax-fs-sm); }
.wsh__nodes i { width: 10px; height: 10px; border-radius: 50%; background: var(--ax-green); flex: none; }
.wsh__nodes li.is-down i { background: var(--ax-red); }
.wsh__nodes li.is-down span { color: var(--ax-red-ink); }
.wsh__nodes li.is-check i { background: var(--ax-border-2); }
.wsh__nodes span { color: var(--ax-muted); }
.wsh__nodes .ax-badge { margin-left: auto; }
.wsh__fix { margin: 0; padding-left: 18px; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.wsh__fix a, .wsh__ok a { color: var(--ax-accent); }
.wsh__ok { margin: 0; color: var(--ax-muted); font-size: var(--ax-fs-sm); }

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
.wsa__sw { display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: none; border: 0; padding: 6px 0; cursor: pointer; }
.wsa__sw i { width: 44px; height: 24px; border-radius: var(--ax-radius-pill); background: var(--ax-border-2); position: relative; transition: background .15s; }
.wsa__sw i::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s; }
.wsa__sw[aria-checked="true"] i { background: var(--ax-green); }
.wsa__sw[aria-checked="true"] i::after { transform: translateX(20px); }
.wsa__sw:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; border-radius: var(--ax-radius); }
.wsa__wait { text-decoration: none; }
.wsa-head { display: flex; gap: 16px; align-items: flex-start; }
.wsa-head .wsa__b { gap: 2px; }
.wsa-head .av--lg { border: 0; }

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
/* The agent form: two columns, the instructions across both. */
.wsf__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.wsf__fld.is-long { grid-column: 1 / -1; }
.wsf__fld textarea { resize: vertical; min-height: 120px; }
/* A changed field turns blue and says what it was (§2). */
.wsf .is-changed { border-color: var(--ax-accent) !important; background: color-mix(in srgb, var(--ax-accent) 8%, var(--ax-bg)) !important; }
.wsf__was { color: var(--ax-text-2); min-height: 1em; }
.wsf__was:empty { display: none; }
/* The bar under the form: changes not saved, Discard and Save… */
.wsb { position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 4px -12px -12px; padding: 12px; border-top: 1px solid var(--ax-border); background: var(--ax-bg); border-radius: 0 0 var(--ax-radius-lg) var(--ax-radius-lg); }
.wsb.is-empty { display: none; }
.wsb p { margin: 0; flex: 1 1 220px; font-size: var(--ax-fs-sm); }
.wsb.is-dirty { background: color-mix(in srgb, var(--ax-accent) 10%, var(--ax-bg)); border-top-color: var(--ax-accent); }
.wsb.is-ok p { color: var(--ax-green-d); }
.wsb.is-warn p { color: var(--ax-amber-ink); }
.wsb.is-err p { color: var(--ax-red-ink); }
/* The confirm: before and after, what else moves, Back and Save changes. */
.wsd__scrim { position: fixed; inset: 0; z-index: 20; background: color-mix(in srgb, #000 35%, transparent); }
.wsd { position: fixed; z-index: 21; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto;
  background: var(--ax-bg); color: var(--ax-text); border-radius: var(--ax-radius-lg); padding: 20px; box-shadow: 0 12px 40px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 12px; }
.wsd h3 { margin: 0; font-size: 20px; font-weight: 800; }
.wsd p { margin: 0; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.wsd__t { width: 100%; border-collapse: collapse; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); font-size: var(--ax-fs-sm); }
.wsd__t th, .wsd__t td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--ax-border); vertical-align: top; overflow-wrap: anywhere; }
.wsd__t th { font-weight: 400; color: var(--ax-muted); width: 34%; }
.wsd__t s { color: var(--ax-muted); }
.wsd .wsf__foot { justify-content: flex-end; }
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

@media (max-width: 900px) {
  .wsf__grid { grid-template-columns: minmax(0, 1fr); }
  .wsh__strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .wst { grid-template-columns: minmax(0, 1fr); }
  .wst__side { position: static; border-right: 0; min-height: 0; }
  .wst__phonehealth { display: block; padding: 12px 16px 16px; border-bottom: 1px solid var(--ax-border); }
  .wst__grp { display: none; }
  .wst__sec { flex-wrap: wrap; padding: 14px 16px; border-left: 0; border-top: 1px solid var(--ax-border); font-weight: 700; }
  .wst__sec.is-on { background: none; font-weight: 700; }
  .wst__about { display: block; flex-basis: 100%; font-style: normal; font-weight: 400; font-size: var(--ax-fs-sm); color: var(--ax-muted); padding-right: 20px; }
  .wst__sec { position: relative; }
  .wst__sec::after { content: "›"; position: absolute; right: 16px; top: 50%; transform: translateY(-50%); color: var(--ax-muted); font-size: 20px; }
  .wst:not(.has-section) .wst__body, .wst.has-section .wst__side { display: none; }
  .wst__up { display: inline; }
  .wst__body { padding: 12px; }
  .wst__tabs { margin: 0 -12px; padding: 0; }
  .wsl { grid-template-columns: minmax(0, 1fr); }
  .wsa { padding: 12px 10px; }
  .wsa-head { flex-wrap: wrap; }
  .wsa-head .av--lg { width: 64px; height: 64px; font-size: 22px; }
  .wsb { position: fixed; left: 0; right: 0; bottom: 56px; margin: 0; border-radius: 0; }
}
`
