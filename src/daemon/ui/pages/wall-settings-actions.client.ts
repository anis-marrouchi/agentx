// --- Hub Settings: Actions (#1428 phase 3) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Business script, so it shares
// S.st, stNoteHtml(), stNote(), stVal(), stChecked(), stOptions(),
// stConfirmHtml(), stChField(), stSetSave(), stPaint() and the Hub's esc()
// and act().
//
// What the classic /admin Actions tab does, with the same calls: the
// registered shell commands and web calls, add or update one (Edit fills
// the form), remove one (POST/DELETE actions), and run one now with its
// inputs, showing what it printed (POST actions/run). Running is a write
// too: it goes under the Settings prefix, so only the owner runs one.

export const WALL_SETTINGS_ACTIONS_SCRIPT = String.raw`
  var ST_HTTP_METHODS = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'];
  function stActionInputHtml(a, inp, n) {
    var id = 'st-ar-' + a.id + '-' + n, def = inp.defaultValue !== undefined ? String(inp.defaultValue) : '';
    if (inp.type === 'boolean') return '<label class="wsf__check"><input type="checkbox" id="' + esc(id) + '"' + (def === 'true' ? ' checked' : '') + '> ' + esc(inp.name) + '</label>';
    return '<label>' + esc(inp.name) + (inp.required ? ' <small>(required)</small>' : '') + '<input id="' + esc(id) + '"' + (inp.type === 'number' ? ' type="number"' : '') +
      ' value="' + esc(def) + '" placeholder="' + esc(inp.description || inp.name) + '" autocomplete="off"></label>';
  }
  function stActionsHtml() {
    var list = (S.st.data && S.st.data.actions) || [], ed = list.find(function (a) { return a.id === S.st.acEdit; }) || null, runs = S.st.acRuns || {};
    var rows = list.map(function (a) {
      var k = 'ac:' + a.id, run = runs[a.id];
      var target = a.kind === 'shell' ? 'shell <code>' + esc(String(a.command || '').slice(0, 90)) + '</code>' : esc(a.method || 'POST') + ' <code>' + esc(String(a.url || '').slice(0, 90)) + '</code>';
      var inputs = (a.inputs || []).map(function (i) { return '<span class="wsj__pill">' + esc(i.name) + (i.required ? '*' : '') + ': ' + esc(i.type) + '</span>'; }).join(' ');
      return '<li class="wsj__row"><div class="wsj__main"><b>' + esc(a.title) + '</b> <code>' + esc(a.id) + '</code> <span class="wsj__pill">' + esc(a.kind) + '</span>' +
        '<p class="wsj__sub">' + target + '</p>' + (a.description ? '<p class="wsj__sub">' + esc(a.description) + '</p>' : '') + (inputs ? '<p class="wsj__sub">' + inputs + '</p>' : '') +
        '<details class="wsj__route"' + (run ? ' open' : '') + '><summary>Run</summary><form class="wsf" data-st-form="ac-run" data-id="' + esc(a.id) + '">' +
          ((a.inputs || []).map(function (i, n) { return stActionInputHtml(a, i, n); }).join('') || '<p class="wsf__hint">No inputs: it runs as written.</p>') +
          '<div class="wsf__foot"><button type="submit" class="ax-btn">Run now</button>' + stNoteHtml('ac-run-' + a.id) + '</div>' +
          (run && run.out != null ? '<pre class="wst-out">' + esc(run.out) + '</pre>' : '') + '</form></details></div>' +
        '<div class="wsj__acts"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="ac-edit" data-id="' + esc(a.id) + '">Edit</button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="ask" data-key="' + esc(k) + '">Remove</button></div>' +
        stConfirmHtml(k, 'Remove the action <b>' + esc(a.title) + '</b>? Workflows that call ' + esc(a.id) + ' fail until it is back.', 'Remove ' + a.id) + '</li>';
    }).join('');
    var kind = ed ? ed.kind : (S.st.acKind || 'shell'), v = function (k) { return ed && ed[k] != null ? String(ed[k]) : ''; };
    return '<header class="wst__h"><h2>Actions</h2><p>Shell commands and web calls that workflows run by id, and that you can run here to try them. Inputs fill <code>{{name}}</code>; <code>$VAR</code> comes from the daemon\'s environment. The same as <code>agentx actions</code>.</p></header>' +
      stNoteHtml('ac') + (rows ? '<ul class="wsj">' + rows + '</ul>' : '<p class="ax-wall__empty">No action yet. Add one below.</p>') +
      '<details class="wsc"' + (ed ? ' open' : '') + '><summary><h3>' + (ed ? 'Update ' + esc(ed.title) : 'Add or update an action') + '</h3></summary><form class="wsf" data-st-form="ac">' +
        '<div class="wsf__row">' + stChField('st-ac-id', 'Id', v('id'), 'deploy-staging') + stChField('st-ac-title', 'Title', v('title'), 'Deploy staging') + '</div>' +
        stChField('st-ac-desc', 'Description', v('description'), 'Build, push, restart staging', '(optional)') +
        '<label>Kind<select id="st-ac-kind" data-st-ac-kind>' + stOptions([['shell', 'shell: a command on this machine'], ['http', 'http: a web call']], kind) + '</select></label>' +
        '<div id="st-ac-shell" class="wsf"' + (kind === 'shell' ? '' : ' hidden') + '>' +
          stChField('st-ac-command', 'Command', v('command'), 'git pull && make deploy VERSION={{version}}') +
          stChField('st-ac-cwd', 'Working folder', '', '/srv/staging', '(optional)') + '</div>' +
        '<div id="st-ac-http" class="wsf"' + (kind === 'http' ? '' : ' hidden') + '>' +
          stChField('st-ac-url', 'Address', v('url'), 'https://api.example.com/deploy') +
          '<label>Method<select id="st-ac-method">' + stOptions(ST_HTTP_METHODS, (ed && ed.method) || 'POST') + '</select></label>' +
          stChField('st-ac-headers', 'Headers', '', '{"Authorization":"Bearer $DEPLOY_TOKEN"}', '(a JSON object, optional; a secret goes in as its $VAR)') +
          '<label>Body <small>(a template, skipped on GET and DELETE)</small><textarea id="st-ac-body" rows="3" placeholder="{&quot;version&quot;:&quot;{{version}}&quot;}"></textarea></label></div>' +
        stChField('st-ac-inputs', 'Inputs', ed ? (ed.inputs || []).map(function (i) { return i.name + ':' + i.type + (i.required ? '!' : ''); }).join(',') : '', 'version:string!,dryRun:boolean',
          '(comma-separated name:type, ! for required)') +
        stChField('st-ac-timeout', 'Timeout (ms)', ed ? String(ed.timeoutMs == null ? 30000 : ed.timeoutMs) : '30000', '30000') +
        '<div class="wsf__foot"><button type="submit" class="ax-btn">Save action</button>' + stNoteHtml('ac-add') + '</div></form></details>';
  }
  function stActionSave() {
    var id = stVal('st-ac-id').trim(), title = stVal('st-ac-title').trim(), kind = stVal('st-ac-kind') || 'shell';
    if (!id) { stNote('ac-add', 'err', 'Not saved: give it an id.'); return; }
    if (!title) { stNote('ac-add', 'err', 'Not saved: give it a title.'); return; }
    var csv = stVal('st-ac-inputs').trim();
    var inputs = csv ? csv.split(',').map(function (s) { return s.trim(); }).filter(Boolean).map(function (part) {
      var required = part.slice(-1) === '!', clean = required ? part.slice(0, -1) : part, at = clean.indexOf(':');
      return { name: at >= 0 ? clean.slice(0, at) : clean, type: at >= 0 ? clean.slice(at + 1) : 'string', required: required };
    }) : [];
    var body = { id: id, title: title, kind: kind, inputs: inputs, timeoutMs: parseInt(stVal('st-ac-timeout'), 10) || 30000 };
    var desc = stVal('st-ac-desc').trim();
    if (desc) body.description = desc;
    if (kind === 'shell') {
      body.command = stVal('st-ac-command').trim();
      if (!body.command) { stNote('ac-add', 'err', 'Not saved: a shell action needs a command.'); return; }
      var cwd = stVal('st-ac-cwd').trim();
      if (cwd) body.cwd = cwd;
    } else {
      body.url = stVal('st-ac-url').trim();
      if (!body.url) { stNote('ac-add', 'err', 'Not saved: a web call needs an address.'); return; }
      body.method = stVal('st-ac-method') || 'POST';
      var h = stVal('st-ac-headers').trim();
      if (h) { try { body.headers = JSON.parse(h); } catch (e) { stNote('ac-add', 'err', 'Not saved: the headers are not a JSON object.'); return; } }
      var b = stVal('st-ac-body');
      if (b) body.body = b;
    }
    stSetSave('ac-add', 'POST', 'actions', body, 'Saved ' + id + '.', 'ac').then(function (ok) { if (ok) { S.st.acEdit = ''; stPaint(); } });
  }
  async function stActionRun(id) {
    var a = ((S.st.data && S.st.data.actions) || []).find(function (x) { return x.id === id; });
    if (!a) return;
    var inputs = {};
    (a.inputs || []).forEach(function (inp, n) {
      var el = 'st-ar-' + a.id + '-' + n;
      if (inp.type === 'boolean') inputs[inp.name] = stChecked(el);
      else if (stVal(el) !== '') inputs[inp.name] = stVal(el);
    });
    stNote('ac-run-' + id, '', 'Running…');
    var r = await act('POST', '/api/admin/wall/settings/actions/run', { id: id, inputs: inputs });
    S.st.acRuns = S.st.acRuns || {};
    if (!r.ok) { S.st.acRuns[id] = { out: null }; stNote('ac-run-' + id, 'err', 'Not run: ' + r.error); return; }
    var x = (r.body && r.body.result) || {}, out = (x.output || '') + (x.errors ? (x.output ? '\n--- stderr ---\n' : '') + x.errors : '');
    S.st.acRuns[id] = { out: out || '(no output)' };
    S.st.notes['ac-run-' + id] = { kind: x.ok ? 'ok' : 'err', text: (x.ok ? 'Done' : 'Failed') + ' · status ' + x.status + ' · ' + x.durationMs + ' ms' };
    stPaint();
  }

  async function stActionsConfirmed(key) {
    if (key.indexOf('ac:') !== 0) return false;
    var id = key.slice(3);
    stPaint();
    await stSetSave('ac', 'DELETE', 'actions', { id: id }, 'Removed the action ' + id + '.');
    return true;
  }

  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (t && t.getAttribute('data-st-act') === 'ac-edit') { S.st.acEdit = t.getAttribute('data-id') || ''; stPaint(); }
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (S.page !== 'settings' || !t || !t.hasAttribute || !t.hasAttribute('data-st-ac-kind')) return;
    S.st.acKind = t.value;
    var sh = $('st-ac-shell'), ht = $('st-ac-http');
    if (sh) sh.hidden = t.value !== 'shell';
    if (ht) ht.hidden = t.value !== 'http';
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.closest && ev.target.closest('[data-st-form]');
    if (!form) return;
    var kind = form.getAttribute('data-st-form');
    if (kind === 'ac') { ev.preventDefault(); stActionSave(); }
    else if (kind === 'ac-run') { ev.preventDefault(); stActionRun(form.getAttribute('data-id')); }
  });
`

export const WALL_SETTINGS_ACTIONS_CSS = `
.wsf[hidden] { display: none; }
.wst-out { margin: 0; padding: 8px; max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--ax-mono); font-size: 12px; background: var(--ax-bg); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); }
`
