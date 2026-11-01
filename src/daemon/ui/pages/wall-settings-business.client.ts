// --- Hub Settings: Business and Boards (#1428 phase 3) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Mesh script, so it shares
// S.st, stNoteHtml(), stNote(), stVal(), stOptions(), stConfirmHtml(),
// stChField(), stSetSave(), stPaint() and the Hub's esc().
//
// What the classic /admin Business and Boards tabs do, with the same calls:
//   Business  the org chart, projects, clients and the contact map, each
//             listed with add-or-update and remove
//             (POST/DELETE business/{orgchart,project,client,contact});
//             shown only when the business layer is on, as there.
//   Boards    the task boards with their columns: add or update a board
//             (Edit fills the form), remove one, add and remove a column
//             (POST/DELETE boards, boards/columns).

export const WALL_SETTINGS_BUSINESS_SCRIPT = String.raw`
  function stBizRow(main, act, key, confirm, yes) {
    return '<li class="wsj__row"><div class="wsj__main">' + main + '</div>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(key) + '">' + esc(act) + '</button>' + stConfirmHtml(key, confirm, yes) + '</li>';
  }
  function stBizList(rows, empty) { return rows.length ? '<ul class="wsj">' + rows.join('') + '</ul>' : '<p class="ax-wall__empty">' + esc(empty) + '</p>'; }
  /** Every client that resolves, set up or only named by a project or contact, as classic Settings lists them. */
  function stBizClients(b) {
    var ids = {};
    (b.projects || []).forEach(function (p) { ids[p.client || (p.id.indexOf('/') > 0 ? p.id.slice(0, p.id.indexOf('/')) : p.id)] = true; });
    (b.contactMap || []).forEach(function (c) { if (c.client) ids[c.client] = true; });
    Object.keys(b.clients || {}).forEach(function (id) { ids[id] = true; });
    return Object.keys(ids).sort();
  }
  function stBusinessHtml() {
    var b = (S.st.data && S.st.data.business) || {}, org = b.orgChart || {}, projects = b.projects || [], contacts = b.contactMap || [], cfg = b.clients || {};
    var orgRows = Object.keys(org).map(function (id) {
      var e = org[id] || {}, s = e.schedule;
      return stBizRow('<b>' + esc(e.role || id) + '</b> <code>' + esc(id) + '</code>' + (e.reportsTo ? ' <small>reports to ' + esc(e.reportsTo) + '</small>' : '') +
        (s ? '<p class="wsj__sub">' + esc((s.days || []).join(', ')) + ' ' + esc(s.start || '') + '–' + esc(s.end || '') + '</p>' : ''),
        'Remove', 'bo:' + id, 'Remove <b>' + esc(id) + '</b> from the org chart?', 'Remove');
    });
    var projRows = projects.map(function (p) {
      return stBizRow((p.name && p.name !== p.id ? '<b>' + esc(p.name) + '</b> ' : '') + '<code>' + esc(p.id) + '</code>' + (p.pm ? ' <small>PM ' + esc(p.pm) + '</small>' : '') +
        (p.lead ? ' <small>lead ' + esc(p.lead) + '</small>' : '') + (p.client ? ' <small>client ' + esc(p.client) + '</small>' : '') +
        (p.team && p.team.length ? '<p class="wsj__sub">Team: ' + esc(p.team.join(', ')) + '</p>' : ''),
        'Remove', 'bp:' + p.id, 'Remove the project <b>' + esc(p.id) + '</b>?', 'Remove');
    });
    var clientRows = stBizClients(b).map(function (id) {
      var c = cfg[id] || {}, set = !!cfg[id];
      var bits = [c.kind ? 'kind ' + c.kind : 'kind client (default)', c.respondWithin ? 'within ' + c.respondWithin : '', c.standing && c.standing.length ? 'standing ' + c.standing.join(' ') : '',
        c.name ? '"' + c.name + '"' : '', set ? '' : 'derived'].filter(Boolean).join(' · ');
      var main = '<code>' + esc(id) + '</code><p class="wsj__sub">' + esc(bits) + '</p>';
      return set ? stBizRow(main, 'Reset', 'bc:' + id, 'Reset <b>' + esc(id) + '</b> to the defaults?', 'Reset') : '<li class="wsj__row"><div class="wsj__main">' + main + '</div></li>';
    });
    var contactRows = contacts.map(function (c, i) {
      var key = c.chatId ? 'chat ' + c.chatId : c.username ? 'username ' + c.username : c.senderId ? 'sender ' + c.senderId : '?';
      return stBizRow((c.channel ? '<span class="wsj__pill">' + esc(c.channel) + '</span> ' : '') + '<code>' + esc(key) + '</code> <small>→ ' + esc(c.client) + (c.project ? '/' + esc(c.project) : '') + '</small>' +
        (c.displayName ? ' <small>(' + esc(c.displayName) + ')</small>' : ''), 'Remove', 'bm:' + i, 'Remove the mapping for <b>' + esc(key) + '</b>?', 'Remove');
    });
    var kinds = [['', '(default)'], ['client', 'client'], ['own', 'own'], ['internal', 'internal']];
    return '<header class="wst__h"><h2>Business</h2><p>The org chart, projects, clients and which chat belongs to which client: the data behind the PM gate and the activity graph. The same as <code>agentx business</code>. Restart the daemon after a change here.</p></header>' +
      stNoteHtml('biz') +
      '<section class="wsc"><h3>Org chart <small>' + orgRows.length + '</small></h3><p class="wsj__sub">Who reports to whom. The Org page changes it too.</p>' + stBizList(orgRows, 'No org chart entry.') +
      '<details class="wsc"><summary><h3>Add or update an entry</h3></summary><form class="wsf" data-st-form="biz-org">' +
        '<div class="wsf__row">' + stChField('st-bo-agent', 'Agent id', '', 'devops') + stChField('st-bo-role', 'Role', '', 'DevOps') + '</div>' +
        stChField('st-bo-reports', 'Reports to', '', 'coo', '(another agent id; empty for the top)') +
        '<div class="wsf__row">' + stChField('st-bo-start', 'Starts', '', '09:00') + stChField('st-bo-end', 'Ends', '', '17:00') + stChField('st-bo-days', 'Days', '', 'mon,tue,wed,thu,fri') + '</div>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save entry</button>' + stNoteHtml('biz-org') + '</div></form></details></section>' +
      '<section class="wsc"><h3>Projects <small>' + projRows.length + '</small></h3>' + stBizList(projRows, 'No project.') +
      '<details class="wsc"><summary><h3>Add or update a project</h3></summary><form class="wsf" data-st-form="biz-proj">' +
        stChField('st-bp-id', 'Project id', '', 'example/app', '(owner/repo for GitLab or GitHub)') +
        '<div class="wsf__row">' + stChField('st-bp-pm', 'PM', '', 'pm-agent', '(agent id: drives the PM gate)') + stChField('st-bp-client', 'Client', '', 'example') + '</div>' +
        '<div class="wsf__row">' + stChField('st-bp-name', 'Name', '', 'Example app', '(shown on the Org page)') + stChField('st-bp-lead', 'Lead', '', 'person:sam', '(the person who leads it)') + '</div>' +
        stChField('st-bp-team', 'Team', '', 'agent:dev-agent, person:kim', '(comma separated; replaces the team)') +
        '<p class="wsf__hint">Leave a field blank to keep what is saved. Tick Clear to remove a name, lead or team.</p>' +
        '<div class="wsf__row">' + ['name', 'lead', 'team'].map(function (k) { return '<label class="wsf__check"><input type="checkbox" id="st-bp-clear-' + k + '"> Clear ' + k + '</label>'; }).join('') + '</div>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save project</button>' + stNoteHtml('biz-proj') + '</div></form></details></section>' +
      '<section class="wsc"><h3>Clients <small>' + clientRows.length + '</small></h3><p class="wsj__sub">A client exists as soon as a project or a contact names it. Set one up only to treat it differently.</p>' + stBizList(clientRows, 'No client yet: add a project or a contact mapping.') +
      '<details class="wsc"><summary><h3>Set up a client</h3></summary><form class="wsf" data-st-form="biz-client">' +
        '<div class="wsf__row">' + stChField('st-bc-id', 'Client id', '', 'example') + stChField('st-bc-name', 'Display name', '', 'Example Co', '(optional)') + '</div>' +
        '<div class="wsf__row"><label>Kind <small>(client: someone waiting on you; own: your product; internal: machinery)</small><select id="st-bc-kind">' + stOptions(kinds, '') + '</select></label>' +
        stChField('st-bc-respond', 'Respond within', '', '4h', '(4h, 90m, 2d; empty for no clock)') + '</div>' +
        stChField('st-bc-standing', 'Standing authorizations', '', 'rebase-branch, open-followup-issue', '(comma-separated, * for all; ignored for kind client)') +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save client</button>' + stNoteHtml('biz-client') + '</div></form></details></section>' +
      '<section class="wsc"><h3>Contact map <small>' + contactRows.length + '</small></h3><p class="wsj__sub">Which client a Telegram or WhatsApp chat belongs to. Without it, chats count as internal.</p>' + stBizList(contactRows, 'No contact mapping.') +
      '<details class="wsc"><summary><h3>Add a contact mapping</h3></summary><form class="wsf" data-st-form="biz-contact">' +
        '<div class="wsf__row">' + stChField('st-bm-channel', 'Channel', '', 'telegram', '(telegram or whatsapp; optional)') + stChField('st-bm-chat', 'Chat id', '', '-1001234567890') + '</div>' +
        '<div class="wsf__row">' + stChField('st-bm-user', 'Username', '', 'alex') + stChField('st-bm-sender', 'Sender id', '', '123456789') + '</div>' +
        '<p class="wsf__hint">Give at least one of chat id, username and sender id.</p>' +
        '<div class="wsf__row">' + stChField('st-bm-client', 'Client', '', 'example') + stChField('st-bm-project', 'Project', '', 'example/app', '(optional)') + '</div>' +
        stChField('st-bm-name', 'Display name', '', 'Alex Rivera', '(optional)') +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save mapping</button>' + stNoteHtml('biz-contact') + '</div></form></details></section>';
  }
  function stBizSave(kind) {
    if (kind === 'biz-org') {
      stSetSave('biz-org', 'POST', 'business/orgchart', {
        agentId: stVal('st-bo-agent').trim(), role: stVal('st-bo-role').trim(), reportsTo: stVal('st-bo-reports').trim(),
        start: stVal('st-bo-start').trim() || '09:00', end: stVal('st-bo-end').trim() || '17:00',
        days: (stVal('st-bo-days').trim() || 'mon,tue,wed,thu,fri').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      }, 'Entry saved.', 'biz');
    } else if (kind === 'biz-proj') {
      // Name, lead and team (#1687) go only when filled, so a blank keeps what is saved.
      var proj = { id: stVal('st-bp-id').trim(), pm: stVal('st-bp-pm').trim(), client: stVal('st-bp-client').trim() };
      var team = stVal('st-bp-team').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (stVal('st-bp-name').trim()) proj.name = stVal('st-bp-name').trim();
      if (stVal('st-bp-lead').trim()) proj.lead = stVal('st-bp-lead').trim();
      if (team.length) proj.team = team;
      var clear = ['name', 'lead', 'team'].filter(function (k) { var c = $('st-bp-clear-' + k); return c && c.checked; });
      if (clear.length) proj.clear = clear;
      stSetSave('biz-proj', 'POST', 'business/project', proj, 'Project saved.', 'biz');
    } else if (kind === 'biz-client') {
      stSetSave('biz-client', 'POST', 'business/client', {
        id: stVal('st-bc-id').trim(), name: stVal('st-bc-name').trim(), kind: stVal('st-bc-kind'), respondWithin: stVal('st-bc-respond').trim(),
        standing: stVal('st-bc-standing').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      }, 'Client saved.', 'biz');
    } else {
      var body = { channel: stVal('st-bm-channel').trim(), chatId: stVal('st-bm-chat').trim(), username: stVal('st-bm-user').trim(), senderId: stVal('st-bm-sender').trim(),
        client: stVal('st-bm-client').trim(), project: stVal('st-bm-project').trim(), displayName: stVal('st-bm-name').trim() };
      if (!body.chatId && !body.username && !body.senderId) { stNote('biz-contact', 'err', 'Not saved: give a chat id, a username or a sender id.'); return; }
      stSetSave('biz-contact', 'POST', 'business/contact', body, 'Mapping saved.', 'biz');
    }
  }

  // --- Boards ---
  var ST_COL_KINDS = ['scoped-label', 'label', 'open-backlog', 'closed'];
  function stBoardsHtml() {
    var boards = (S.st.data && S.st.data.boards) || [], ed = boards.find(function (b) { return b.id === S.st.bdEdit; }) || null;
    var rows = boards.map(function (b) {
      var cols = (b.columns || []).map(function (c, i) {
        var map = c.kind === 'scoped-label' ? 'scoped ' + (c.scopedLabel || '') : c.kind === 'label' ? 'label ' + (c.mapsToLabel || '') : c.kind === 'open-backlog' ? 'prefix ' + (c.scopedPrefix || 'Status') : c.kind;
        var k = 'bdc:' + b.id + ':' + i;
        return '<li><b>' + esc(c.title) + '</b> <small>' + esc(map) + '</small> <button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '" aria-label="Remove the column ' + esc(c.title) + '">×</button>' +
          stConfirmHtml(k, 'Remove the column <b>' + esc(c.title) + '</b> from ' + esc(b.name) + '?', 'Remove') + '</li>';
      }).join('');
      var k = 'bd:' + b.id;
      return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(b.name) + '</b> <code>' + esc(b.id) + '</code>' +
        '<p class="wsj__sub">' + esc(((b.source && b.source.projects) || []).join(', ')) + (b.primaryToolLabel ? ' · label ' + esc(b.primaryToolLabel) : '') +
        ' · open ' + (b.timeRangeDays || 30) + ' days, closed ' + (b.closedWindowDays || 30) + ' days</p>' +
        '<h4>Columns</h4>' + (cols ? '<ul class="wsj__trig">' + cols + '</ul>' : '<p class="wsj__sub">None: the board uses the default flow.</p>') +
        '<form class="wsj__inline" data-st-form="bd-col" data-id="' + esc(b.id) + '">' +
          '<input id="st-bdc-id-' + esc(b.id) + '" placeholder="doing" aria-label="Column id">' +
          '<input id="st-bdc-title-' + esc(b.id) + '" placeholder="Doing" aria-label="Column title">' +
          '<select id="st-bdc-kind-' + esc(b.id) + '" aria-label="Column kind">' + stOptions(ST_COL_KINDS, 'scoped-label') + '</select>' +
          '<input id="st-bdc-value-' + esc(b.id) + '" placeholder="Status::Doing" aria-label="Scoped label or label">' +
          '<button type="submit" class="ax-btn ax-btn--ghost">Add column</button></form></div>' +
        '<div class="wsj__acts"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="bd-edit" data-id="' + esc(b.id) + '">Edit</button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Remove</button></div>' +
        stConfirmHtml(k, 'Remove the board <b>' + esc(b.name) + '</b>?', 'Remove ' + b.id) + '</li>';
    }).join('');
    var v = function (k, d) { return ed ? String(ed[k] == null ? d : ed[k]) : d; };
    return '<header class="wst__h"><h2>Boards</h2><p>The task boards the dashboard shows, each over one or more GitLab projects. Columns map a dropped card to a label. The same as <code>agentx board</code>.</p></header>' +
      stNoteHtml('bd') + (rows ? '<ul class="wsj">' + rows + '</ul>' : '<p class="ax-wall__empty">No board yet.</p>') +
      '<details class="wsc"' + (ed ? ' open' : '') + '><summary><h3>' + (ed ? 'Update ' + esc(ed.name) : 'Add or update a board') + '</h3></summary><form class="wsf" data-st-form="bd">' +
        '<div class="wsf__row">' + stChField('st-bd-id', 'Board id', v('id', ''), 'example') + stChField('st-bd-name', 'Name', v('name', ''), 'Example app') + '</div>' +
        stChField('st-bd-projects', 'GitLab projects', ed ? ((ed.source && ed.source.projects) || []).join(',') : '', 'example/app,example/site', '(comma-separated paths)') +
        stChField('st-bd-label', 'Main label', v('primaryToolLabel', ''), 'Tool::Agent', '(optional: every card has it)') +
        '<div class="wsf__row">' + stChField('st-bd-days', 'Open window (days)', v('timeRangeDays', '30'), '30') + stChField('st-bd-closed', 'Closed window (days)', v('closedWindowDays', '30'), '30') + '</div>' +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save board</button>' + stNoteHtml('bd-add') + '</div></form></details>';
  }
  function stBoardSave() {
    stSetSave('bd-add', 'POST', 'boards', {
      id: stVal('st-bd-id').trim(), name: stVal('st-bd-name').trim(), projects: stVal('st-bd-projects').trim(), primaryToolLabel: stVal('st-bd-label').trim(),
      timeRangeDays: parseInt(stVal('st-bd-days'), 10) || 30, closedWindowDays: parseInt(stVal('st-bd-closed'), 10) || 30,
    }, 'Board saved.', 'bd').then(function (ok) { if (ok) { S.st.bdEdit = ''; stPaint(); } });
  }
  function stColumnAdd(board) {
    var id = stVal('st-bdc-id-' + board).trim(), title = stVal('st-bdc-title-' + board).trim(), kind = stVal('st-bdc-kind-' + board) || 'scoped-label', value = stVal('st-bdc-value-' + board).trim();
    if (!id || !title) { stNote('bd', 'err', 'Not added: give the column an id and a title.'); return; }
    var body = { boardId: board, columnId: id, title: title, kind: kind };
    if (kind === 'scoped-label') body.scopedLabel = value;
    else if (kind === 'label') body.mapsToLabel = value;
    stSetSave('bd', 'POST', 'boards/columns', body, 'Added the column ' + title + '.');
  }

  async function stBizConfirmed(key) {
    var d = S.st.data || {}, b = d.business || {}, at = key.indexOf(':'), kind = key.slice(0, at), id = key.slice(at + 1);
    if (['bo', 'bp', 'bc', 'bm', 'bd', 'bdc'].indexOf(kind) < 0) return false;
    stPaint();
    if (kind === 'bo') await stSetSave('biz', 'DELETE', 'business/orgchart', { agentId: id }, 'Removed ' + id + ' from the org chart.');
    else if (kind === 'bp') await stSetSave('biz', 'DELETE', 'business/project', { id: id }, 'Removed the project ' + id + '.');
    else if (kind === 'bc') await stSetSave('biz', 'DELETE', 'business/client', { id: id }, id + ' is back to the defaults.');
    else if (kind === 'bm') {
      var c = (b.contactMap || [])[+id];
      if (!c) return true;
      var f = {};
      if (c.channel) f.channel = c.channel;
      if (c.chatId) f.chatId = c.chatId; else if (c.username) f.username = c.username; else if (c.senderId) f.senderId = c.senderId;
      await stSetSave('biz', 'DELETE', 'business/contact', f, 'Removed the mapping.');
    }
    else if (kind === 'bd') await stSetSave('bd', 'DELETE', 'boards', { id: id }, 'Removed the board ' + id + '.');
    else {
      var cut = id.lastIndexOf(':'), board = id.slice(0, cut), bd = (d.boards || []).find(function (x) { return x.id === board; }), col = bd && (bd.columns || [])[+id.slice(cut + 1)];
      if (col) await stSetSave('bd', 'DELETE', 'boards/columns', { boardId: board, columnId: col.id }, 'Removed the column ' + col.title + '.');
    }
    return true;
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (t && t.getAttribute('data-st-act') === 'bd-edit') { S.st.bdEdit = t.getAttribute('data-id') || ''; stPaint(); }
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form) return;
    var kind = form.getAttribute('data-st-form');
    if (kind.indexOf('biz-') === 0) { ev.preventDefault(); stBizSave(kind); }
    else if (kind === 'bd') { ev.preventDefault(); stBoardSave(); }
    else if (kind === 'bd-col') { ev.preventDefault(); stColumnAdd(form.getAttribute('data-id')); }
  });
`
