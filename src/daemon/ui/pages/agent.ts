// --- Agent page (/admin/agents/<id>) ---
//
// One dedicated page per agent. Tabs:
//   Overview   — editable metadata + system prompt
//   Identity   — CLAUDE.md / SOUL.md / IDENTITY.md etc via EasyMDE
//   Skills     — per-skill directory tree, file editor, install actions
//   Channels   — read-only list of bindings
//   Handovers  — manual routing to/from this agent
//   Activity   — recent tasks
//
// API is in agent-panel.ts (keeps file-ops + handover-store imports in one
// place); this file owns ONLY the HTML/CSS/client JS.

import { renderShell, esc, type TopbarPeer } from ".."

export interface AgentPageOpts {
  agentId: string
  peers?: TopbarPeer[]
  currentPeerId?: string
  localToken?: string
}

export function renderAgentPage(opts: AgentPageOpts): string {
  const agentId = opts.agentId
  const tokenScript = opts.localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>`
    : ""
  const agentIdScript = `<script>window.AGENT_ID = ${JSON.stringify(agentId)};</script>`

  // Body HTML — copied verbatim from the old renderAgentHtml, with the
  // ${escapeHtml(agentId)} interpolations re-wired to our esc() helper.
  const body = AGENT_PAGE_BODY.replace(/__AGENT_ID__/g, esc(agentId))

  return renderShell({
    title: `AgentX · ${esc(agentId)}`,
    activeTab: "admin",
    subtitle: `Agent · ${esc(agentId)}`,
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    // The extracted body already carries its own <main> tag plus the
    // confirm-modal <div> that sits alongside it at the same level.
    noMain: true,
    body,
    css: AGENT_PAGE_CSS,
    headExtras: `<link rel="stylesheet" href="https://unpkg.com/easymde/dist/easymde.min.css">`,
    scripts: `${agentIdScript}${tokenScript}<script src="https://unpkg.com/easymde/dist/easymde.min.js"></script><script>${AGENT_PAGE_SCRIPT}</script>`,
  })
}

const AGENT_PAGE_BODY = `
<main>
  <a class="back-link" href="/admin">← Back to Settings</a>
  <div id="msg" class="msg"></div>

  <div class="card header-card">
    <div style="flex:1">
      <h1 id="a-name">__AGENT_ID__</h1>
      <div class="sub" id="a-id">__AGENT_ID__</div>
      <div class="chips" id="a-chips"></div>
    </div>
    <div style="display:flex;gap:8px">
      <button id="btn-test-drive">Test drive</button>
      <button id="btn-save-meta" class="primary">Save</button>
    </div>
  </div>

  <nav class="tabs">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="identity">Identity</button>
    <button data-tab="skills">Skills</button>
    <button data-tab="channels">Channels</button>
    <button data-tab="handovers">Handovers</button>
    <button data-tab="activity">Activity</button>
  </nav>

  <!-- Overview -->
  <section class="tab active" id="tab-overview">
    <div class="card">
      <label>System prompt</label>
      <textarea id="sp-editor" placeholder="# Who the agent is, what it does, how it communicates"></textarea>
    </div>
    <div class="card">
      <div class="row">
        <div class="field"><label>Name</label><input id="f-name" /></div>
        <div class="field"><label>Tier</label>
          <select id="f-tier">
            <option value="claude-code">claude-code</option>
            <option value="sdk">sdk</option>
            <option value="orchestrator">orchestrator</option>
          </select>
        </div>
        <div class="field"><label>Model</label><input id="f-model" /></div>
      </div>
      <div class="row">
        <div class="field"><label>Access</label>
          <select id="f-access">
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
        </div>
        <div class="field"><label>Max concurrent</label><input id="f-maxc" type="number" min="1" /></div>
        <div class="field"><label>Max execution (min)</label><input id="f-maxt" type="number" min="1" /></div>
        <div class="field"><label>Permission mode</label>
          <select id="f-pmode">
            <option value="default">default</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="plan">plan</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Mentions (comma-separated)</label>
        <input id="f-mentions" placeholder="@noqta_foo_bot, foo" />
      </div>
    </div>
  </section>

  <!-- Identity -->
  <section class="tab" id="tab-identity">
    <div class="card">
      <div class="editor-wrap">
        <div class="toolbar">
          <label style="margin:0">File</label>
          <select id="id-select" style="width:260px"></select>
          <span class="path" id="id-path"></span>
          <button id="btn-save-id" class="primary">Save file</button>
        </div>
        <textarea id="id-editor"></textarea>
      </div>
    </div>
  </section>

  <!-- Skills -->
  <section class="tab" id="tab-skills">
    <div class="card">
      <div class="row" style="align-items:center">
        <div style="flex:1"></div>
        <input id="pkg-input" placeholder="owner/repo (or owner/repo/skill)" style="flex:0 0 320px" />
        <button id="btn-install-pkg">Install package…</button>
        <button id="btn-new-skill">+ New skill</button>
      </div>
      <div class="task-output" id="dispatch-output"></div>
    </div>
    <div class="skills-grid">
      <div class="skill-pane">
        <h3>Skills</h3>
        <div id="skills-list"></div>
      </div>
      <div class="skill-pane">
        <h3>Tree <span style="float:right"><button id="btn-install-deps" style="font-size:10px;padding:3px 8px" disabled>Install deps…</button> <button id="btn-delete-skill" class="danger" style="font-size:10px;padding:3px 8px" disabled>Delete</button></span></h3>
        <div id="skill-tree"></div>
      </div>
      <div class="skill-pane" style="padding:14px">
        <div class="editor-wrap" id="sk-editor-wrap" style="display:none">
          <div class="toolbar">
            <span class="path" id="sk-path">—</span>
            <button id="btn-save-sk" class="primary">Save file</button>
          </div>
          <textarea id="sk-editor"></textarea>
        </div>
        <div class="empty" id="sk-editor-empty">Select a file in the tree to edit.</div>
      </div>
    </div>
  </section>

  <!-- Channels -->
  <section class="tab" id="tab-channels">
    <div class="card"><div id="channels-list" class="empty">loading…</div></div>
  </section>

  <!-- Handovers -->
  <section class="tab" id="tab-handovers">
    <div class="card">
      <h2 style="margin:0 0 4px;font-size:14px">Hand this agent's chat to someone else</h2>
      <p class="muted" style="margin:0 0 12px">Routes every subsequent message from (channel, chatId) to the target agent. A one-shot briefing is injected into the target agent's first context.</p>
      <div class="row">
        <div class="field" style="flex:0 0 140px"><label>Channel</label>
          <select id="ho-channel"><option value="telegram">telegram</option><option value="whatsapp">whatsapp</option></select>
        </div>
        <div class="field" style="flex:1 1 180px"><label>Chat id</label>
          <input id="ho-chatid" placeholder="1816212449 or +21612345678" />
        </div>
        <div class="field" style="flex:0 0 140px"><label>Account (optional)</label>
          <input id="ho-account" placeholder="default" />
        </div>
        <div class="field" style="flex:1 1 180px"><label>Transfer to</label>
          <select id="ho-target"></select>
        </div>
      </div>
      <div class="field">
        <label>Briefing summary (one-shot note for the receiving agent)</label>
        <textarea id="ho-summary" style="min-height:90px" placeholder="Customer is asking about enterprise pricing. They've already seen the standard tier..."></textarea>
      </div>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:0 0 200px"><label>Expires (optional ISO)</label>
          <input id="ho-expires" placeholder="2026-04-20T00:00:00Z" />
        </div>
        <button id="btn-handover" class="primary">Hand off</button>
      </div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 8px;font-size:14px">Incoming — chats routed TO this agent</h2>
      <div id="ho-incoming" class="empty">loading…</div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 8px;font-size:14px">Outgoing — chats routed AWAY from this agent</h2>
      <div id="ho-outgoing" class="empty">loading…</div>
    </div>
  </section>

  <!-- Activity -->
  <section class="tab" id="tab-activity">
    <div class="card"><div id="activity" class="empty">loading…</div></div>
  </section>
</main>

<!-- Confirm modal -->
<div class="modal" id="confirm-modal" aria-hidden="true">
  <div class="modal-card">
    <h3 id="confirm-title">Confirm</h3>
    <div class="detail" id="confirm-detail"></div>
    <div class="row">
      <button id="confirm-cancel">Cancel</button>
      <button id="confirm-ok" class="primary">Run</button>
    </div>
  </div>
`
const AGENT_PAGE_CSS = `
    main{max-width:1280px;margin:0 auto;padding:18px 20px 60px}
    .msg{font-size:12px;padding:8px 12px;border-radius:4px;margin-bottom:12px;display:none}
    .msg.ok{background:rgba(74,222,128,0.12);color:var(--ax-green);display:block}
    .msg.err{background:rgba(248,113,113,0.12);color:var(--ax-red);display:block}
    .back-link{display:inline-flex;align-items:center;gap:6px;color:var(--ax-muted);
      text-decoration:none;font-size:12px;margin-bottom:12px}
    .back-link:hover{color:var(--ax-accent)}
    .card{background:var(--ax-bg-elev);border:1px solid var(--ax-border);
      border-radius:8px;padding:18px;margin-bottom:16px}
    .header-card{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
    .header-card h1{margin:0 0 6px;font-size:20px;font-weight:600;letter-spacing:-0.02em}
    .header-card .sub{color:var(--ax-muted);font-size:12px;font-family:var(--ax-mono)}
    .chips{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
    .chip{padding:2px 10px;border-radius:3px;font-size:11px;background:var(--ax-surface);
      color:var(--ax-text-2);border:1px solid var(--ax-border);font-family:var(--ax-mono)}
    .chip.accent{background:rgba(122,162,247,0.12);color:var(--ax-accent);border-color:transparent}
    nav.tabs{display:flex;gap:2px;margin-bottom:16px;border-bottom:1px solid var(--ax-border);
      padding:0 4px}
    nav.tabs button{background:transparent;border:none;color:var(--ax-muted);padding:10px 14px;
      font:inherit;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;
      letter-spacing:-0.005em;white-space:nowrap}
    nav.tabs button:hover{color:var(--ax-text)}
    nav.tabs button.active{color:var(--ax-text);border-bottom-color:var(--ax-accent)}
    section.tab{display:none}
    section.tab.active{display:block}
    button,.btn{font:inherit;font-size:12px;padding:7px 14px;border-radius:4px;
      border:1px solid var(--ax-border-2);background:var(--ax-surface);
      color:var(--ax-text);cursor:pointer}
    button:hover{border-color:var(--ax-accent);color:var(--ax-accent)}
    button.primary{background:var(--ax-accent);color:#0a0b0f;border-color:var(--ax-accent);font-weight:600}
    button.primary:hover{filter:brightness(1.08);color:#0a0b0f}
    button.danger{color:var(--ax-red);border-color:var(--ax-red)}
    button.danger:hover{background:var(--ax-red);color:#fff}
    button[disabled]{opacity:0.5;cursor:not-allowed}
    input,select,textarea{font:inherit;font-size:12px;padding:7px 10px;
      background:var(--ax-surface);color:var(--ax-text);
      border:1px solid var(--ax-border);border-radius:4px;width:100%;
      font-family:var(--ax-mono)}
    label{display:block;font-size:11px;color:var(--ax-muted);margin-bottom:4px;
      text-transform:uppercase;letter-spacing:0.05em;font-weight:600}
    .field{margin-bottom:12px}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .row > .field{flex:1 1 200px;min-width:0}
    .empty{color:var(--ax-muted);font-style:italic;padding:14px;text-align:center}
    .kv{display:flex;gap:8px;font-size:12px;color:var(--ax-text-2);margin:4px 0}
    .kv b{color:var(--ax-text);font-weight:500;min-width:80px}
    /* Skills browser */
    .skills-grid{display:grid;gap:14px;grid-template-columns:260px 260px 1fr;min-height:520px}
    @media(max-width:1000px){.skills-grid{grid-template-columns:1fr}}
    .skill-pane{background:var(--ax-surface);border:1px solid var(--ax-border);
      border-radius:6px;padding:10px;overflow:auto;max-height:620px}
    .skill-pane h3{font-size:11px;margin:0 0 10px;text-transform:uppercase;
      letter-spacing:0.06em;color:var(--ax-muted)}
    .skill-row{padding:6px 8px;border-radius:4px;cursor:pointer;display:flex;
      justify-content:space-between;align-items:center;font-size:12px;gap:6px}
    .skill-row:hover{background:var(--ax-bg-elev)}
    .skill-row.active{background:rgba(122,162,247,0.14);color:var(--ax-accent)}
    .skill-row .slug{font-family:var(--ax-mono);color:var(--ax-muted);font-size:11px}
    .tree-entry{display:flex;justify-content:space-between;padding:4px 6px;border-radius:3px;
      cursor:pointer;font-family:var(--ax-mono);font-size:11px;color:var(--ax-text-2)}
    .tree-entry:hover{background:var(--ax-bg-elev);color:var(--ax-text)}
    .tree-entry.active{background:rgba(122,162,247,0.14);color:var(--ax-accent)}
    .tree-entry.dir{color:var(--ax-muted);font-weight:500}
    .tree-entry.readonly{opacity:0.55;cursor:default}
    .editor-wrap{display:flex;flex-direction:column;gap:8px}
    .editor-wrap .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .editor-wrap .path{font-family:var(--ax-mono);font-size:11px;color:var(--ax-muted);flex:1}
    /* EasyMDE theme tweaks for dark mode */
    .EasyMDEContainer .editor-toolbar{border-color:var(--ax-border);background:var(--ax-surface)}
    .EasyMDEContainer .editor-toolbar button{color:var(--ax-text-2)}
    .EasyMDEContainer .editor-toolbar button:hover,
    .EasyMDEContainer .editor-toolbar button.active{background:var(--ax-bg-elev);color:var(--ax-accent)}
    .EasyMDEContainer .CodeMirror{border-color:var(--ax-border);background:var(--ax-bg);
      color:var(--ax-text)}
    .EasyMDEContainer .CodeMirror-cursor{border-left-color:var(--ax-accent)}
    .EasyMDEContainer .editor-statusbar{color:var(--ax-muted)}
    .plain-editor{width:100%;min-height:420px;font-family:var(--ax-mono);font-size:12px;
      line-height:1.5;resize:vertical}
    /* Confirm modal */
    .modal{position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;
      align-items:center;justify-content:center;z-index:100}
    .modal[aria-hidden="true"]{display:none}
    .modal-card{background:var(--ax-bg-elev);border:1px solid var(--ax-border);
      border-radius:8px;padding:20px;max-width:560px;width:94vw}
    .modal-card h3{margin:0 0 10px;font-size:15px}
    .modal-card .detail{color:var(--ax-muted);font-size:12px;margin-bottom:14px;
      font-family:var(--ax-mono);background:var(--ax-surface);padding:10px;
      border-radius:4px;white-space:pre-wrap;word-break:break-word}
    .modal-card .row{justify-content:flex-end}
    .task-output{font-family:var(--ax-mono);font-size:11px;background:var(--ax-bg);
      border:1px solid var(--ax-border);border-radius:4px;padding:10px;
      max-height:300px;overflow:auto;white-space:pre-wrap;display:none;margin-top:10px}
`
const AGENT_PAGE_SCRIPT = `
const $ = (id) => document.getElementById(id);
const state = { agent: null, activeSkill: null, activeSkillFile: null, identityPath: null };

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (window.AX_LOCAL_TOKEN) headers['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function showMsg(kind, text){ const m = $('msg'); m.className='msg '+kind; m.textContent=text; setTimeout(()=>{m.className='msg';}, 4000); }

// --- confirm modal ---
function confirmAction(title, detail, onConfirm){
  $('confirm-title').textContent = title;
  $('confirm-detail').textContent = detail;
  const modal = $('confirm-modal');
  modal.setAttribute('aria-hidden', 'false');
  const cleanup = () => {
    modal.setAttribute('aria-hidden', 'true');
    $('confirm-ok').onclick = null;
    $('confirm-cancel').onclick = null;
  };
  $('confirm-ok').onclick = () => { cleanup(); onConfirm(); };
  $('confirm-cancel').onclick = cleanup;
}

// --- Tabs ---
for (const btn of document.querySelectorAll('nav.tabs button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('section.tab').forEach(s=>s.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'skills' && !state.agent?.skillsLoaded) loadSkills();
    if (btn.dataset.tab === 'identity' && !state.agent?.identityLoaded) loadIdentity();
    if (btn.dataset.tab === 'channels') loadChannels();
    if (btn.dataset.tab === 'handovers') loadHandovers();
    if (btn.dataset.tab === 'activity') loadActivity();
  });
}

// --- EasyMDE instances ---
let spMde, idMde, skMde;
function makeMde(el){
  return new EasyMDE({
    element: el, spellChecker: false, status: ['lines','words'],
    autoDownloadFontAwesome: true, autofocus: false,
    toolbar: ['bold','italic','heading','|','quote','code','unordered-list','ordered-list','|','link','image','table','|','preview','side-by-side','fullscreen','|','guide'],
  });
}

// --- Overview ---
async function loadAgent(){
  try {
    const a = await req('GET', '/api/admin/agent/' + AGENT_ID);
    state.agent = a;
    $('a-name').textContent = a.name || AGENT_ID;
    $('a-id').textContent = AGENT_ID + ' · ' + (a.workspace || '—');
    const chips = [
      a.tier && '<span class="chip accent">'+esc(a.tier)+'</span>',
      a.model && '<span class="chip">'+esc(a.model)+'</span>',
      a.access && '<span class="chip">'+esc(a.access)+'</span>',
      ...(a.mentions || []).map(m => '<span class="chip">'+esc(m)+'</span>'),
    ].filter(Boolean).join('');
    $('a-chips').innerHTML = chips;
    $('f-name').value = a.name || '';
    $('f-tier').value = a.tier || 'claude-code';
    $('f-model').value = a.model || '';
    $('f-access').value = a.access || 'private';
    $('f-maxc').value = a.maxConcurrent ?? 1;
    $('f-maxt').value = a.maxExecutionMinutes ?? 20;
    $('f-pmode').value = a.permissionMode || 'default';
    $('f-mentions').value = (a.mentions || []).join(', ');
    if (!spMde) spMde = makeMde($('sp-editor'));
    spMde.value(a.systemPrompt || '');
  } catch (e) { showMsg('err', e.message); }
}

$('btn-save-meta').addEventListener('click', async () => {
  const body = {
    name: $('f-name').value.trim(),
    tier: $('f-tier').value,
    model: $('f-model').value.trim(),
    access: $('f-access').value,
    maxConcurrent: Number($('f-maxc').value) || 1,
    maxExecutionMinutes: Number($('f-maxt').value) || 20,
    permissionMode: $('f-pmode').value,
    mentions: $('f-mentions').value.split(',').map(s=>s.trim()).filter(Boolean),
    systemPrompt: spMde ? spMde.value() : '',
  };
  try {
    await req('PATCH', '/api/admin/agent/' + AGENT_ID, body);
    showMsg('ok', 'Saved. Restart the daemon for tier/model changes to take effect.');
  } catch (e) { showMsg('err', e.message); }
});

// --- Identity ---
async function loadIdentity(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/identity');
    const sel = $('id-select');
    sel.innerHTML = r.identity.map(f =>
      '<option value="'+esc(f.path)+'" '+(f.exists?'':'data-new="1"')+'>'+esc(f.title)+(f.exists?'':' (new)')+'</option>'
    ).join('');
    sel.onchange = loadIdentityFile;
    if (!idMde) idMde = makeMde($('id-editor'));
    if (r.identity.length) {
      sel.value = r.identity[0].path;
      await loadIdentityFile();
    }
    state.agent.identityLoaded = true;
  } catch (e) { showMsg('err', e.message); }
}

async function loadIdentityFile(){
  const p = $('id-select').value;
  $('id-path').textContent = p;
  state.identityPath = p;
  try {
    const f = await req('GET', '/api/admin/agent/' + AGENT_ID + '/identity/file?path=' + encodeURIComponent(p));
    idMde.value(f.content || '');
  } catch (e) { showMsg('err', e.message); idMde.value(''); }
}

$('btn-save-id').addEventListener('click', async () => {
  if (!state.identityPath) return;
  try {
    await req('PUT', '/api/admin/agent/' + AGENT_ID + '/identity/file', {
      path: state.identityPath, content: idMde.value(),
    });
    showMsg('ok', 'Saved ' + state.identityPath);
  } catch (e) { showMsg('err', e.message); }
});

// --- Skills ---
async function loadSkills(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills');
    const list = $('skills-list');
    if (!r.skills.length) {
      list.innerHTML = '<div class="empty">No skills. Install a package or create one below.</div>';
    } else {
      list.innerHTML = r.skills.map(s =>
        '<div class="skill-row" data-slug="'+esc(s.slug)+'">'
        + '<span>'+esc(s.title)+'<br><span class="slug">'+esc(s.slug)+'</span></span>'
        + '</div>'
      ).join('');
      list.querySelectorAll('[data-slug]').forEach(r=>r.addEventListener('click', ()=>selectSkill(r.dataset.slug)));
    }
    state.agent.skillsLoaded = true;
  } catch (e) { showMsg('err', e.message); }
}

async function selectSkill(slug){
  state.activeSkill = slug;
  state.activeSkillFile = null;
  document.querySelectorAll('#skills-list [data-slug]').forEach(r=>{
    r.classList.toggle('active', r.dataset.slug === slug);
  });
  $('btn-delete-skill').disabled = false;
  $('btn-install-deps').disabled = true;
  $('sk-editor-wrap').style.display = 'none';
  $('sk-editor-empty').style.display = 'block';
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/tree?slug=' + encodeURIComponent(slug));
    $('btn-install-deps').disabled = !r.deps?.manager;
    $('btn-install-deps').title = r.deps?.command || 'No package manifest detected';
    const host = $('skill-tree');
    host.innerHTML = r.tree.map(e => {
      const depth = (e.path.match(/\\//g) || []).length;
      const pad = 'padding-left:' + (depth * 10) + 'px';
      const icon = e.kind === 'dir' ? '▸' : '·';
      const cls = 'tree-entry ' + e.kind + (e.editable ? '' : ' readonly');
      return '<div class="'+cls+'" style="'+pad+'" data-path="'+esc(e.path)+'" data-editable="'+(e.editable?'1':'0')+'">'
        + '<span>'+icon+' '+esc(e.path.split('/').filter(Boolean).pop() || e.path)+'</span>'
        + '<span style="color:var(--ax-muted);font-size:10px">'+(e.kind==='file'?formatBytes(e.size):'')+'</span>'
      + '</div>';
    }).join('');
    host.querySelectorAll('[data-path]').forEach(r=>r.addEventListener('click', ()=>{
      if (r.dataset.editable === '1') openSkillFile(r.dataset.path);
    }));
    // Auto-open SKILL.md
    const skillMd = r.tree.find(e => e.path === 'SKILL.md' && e.editable);
    if (skillMd) openSkillFile('SKILL.md');
  } catch (e) { showMsg('err', e.message); }
}

function formatBytes(n){ if (!n) return ''; if (n < 1024) return n+'b'; if (n<1048576) return (n/1024).toFixed(1)+'k'; return (n/1048576).toFixed(1)+'M'; }

async function openSkillFile(path){
  state.activeSkillFile = path;
  $('sk-path').textContent = state.activeSkill + '/' + path;
  $('sk-editor-empty').style.display = 'none';
  $('sk-editor-wrap').style.display = 'flex';
  document.querySelectorAll('#skill-tree [data-path]').forEach(r=>r.classList.toggle('active', r.dataset.path === path));
  try {
    const f = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/file?slug=' + encodeURIComponent(state.activeSkill) + '&path=' + encodeURIComponent(path));
    // Use EasyMDE for .md, plain textarea for everything else
    const isMd = path.toLowerCase().endsWith('.md') || path.toLowerCase().endsWith('.markdown');
    $('sk-editor').classList.toggle('plain-editor', !isMd);
    if (skMde) { skMde.toTextArea(); skMde = null; }
    if (isMd) {
      skMde = makeMde($('sk-editor'));
      skMde.value(f.content || '');
    } else {
      $('sk-editor').value = f.content || '';
    }
  } catch (e) { showMsg('err', e.message); }
}

$('btn-save-sk').addEventListener('click', async () => {
  if (!state.activeSkill || !state.activeSkillFile) return;
  const content = skMde ? skMde.value() : $('sk-editor').value;
  try {
    await req('PUT', '/api/admin/agent/' + AGENT_ID + '/skills/file', {
      slug: state.activeSkill, path: state.activeSkillFile, content,
    });
    showMsg('ok', 'Saved ' + state.activeSkill + '/' + state.activeSkillFile);
  } catch (e) { showMsg('err', e.message); }
});

$('btn-new-skill').addEventListener('click', async () => {
  const slug = prompt('New skill slug (lowercase, letters/digits/-/_):');
  if (!slug) return;
  try {
    await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills', { slug });
    showMsg('ok', 'Skill created: ' + slug);
    await loadSkills();
    selectSkill(slug);
  } catch (e) { showMsg('err', e.message); }
});

$('btn-delete-skill').addEventListener('click', () => {
  if (!state.activeSkill) return;
  const slug = state.activeSkill;
  confirmAction(
    'Delete skill "' + slug + '"?',
    'This removes .claude/skills/' + slug + ' and all files inside it. This cannot be undone.',
    async () => {
      try {
        await req('DELETE', '/api/admin/agent/' + AGENT_ID + '/skills', { slug });
        state.activeSkill = null;
        state.activeSkillFile = null;
        $('skill-tree').innerHTML = '';
        $('sk-editor-wrap').style.display = 'none';
        $('sk-editor-empty').style.display = 'block';
        $('btn-delete-skill').disabled = true;
        $('btn-install-deps').disabled = true;
        showMsg('ok', 'Deleted ' + slug);
        loadSkills();
      } catch (e) { showMsg('err', e.message); }
    }
  );
});

$('btn-install-pkg').addEventListener('click', () => {
  const pkg = $('pkg-input').value.trim();
  if (!pkg) { showMsg('err', 'Enter a package like "owner/repo".'); return; }
  const worker = state.agent?.draftAgent || state.agent?.defaultWorker || 'devops-agent';
  confirmAction(
    'Install skills.sh package?',
    'Package: ' + pkg + '\\n\\nWorker agent: ' + worker + '\\n\\nThe worker will run: npx skills add ' + pkg + '\\n\\nInside: ' + (state.agent?.workspace || '(agent workspace)') + '\\n\\nOutput will appear below.',
    async () => {
      $('dispatch-output').style.display = 'block';
      $('dispatch-output').textContent = 'Dispatching to ' + worker + '…';
      try {
        const r = await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills/install', { package: pkg });
        $('dispatch-output').textContent = (r.content || '(no output)') + '\\n\\n-- done --';
        loadSkills();
      } catch (e) { $('dispatch-output').textContent = 'Error: ' + e.message; }
    }
  );
});

$('btn-install-deps').addEventListener('click', async () => {
  if (!state.activeSkill) return;
  const slug = state.activeSkill;
  try {
    const hint = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/deps?slug=' + encodeURIComponent(slug));
    if (!hint.manager) { showMsg('err', 'No package manifest in skill dir.'); return; }
    const worker = state.agent?.draftAgent || state.agent?.defaultWorker || 'devops-agent';
    confirmAction(
      'Install dependencies?',
      'Skill: ' + slug + '\\nManifest: ' + hint.file + '\\nCommand: ' + hint.command + '\\n\\nWorker agent: ' + worker + '\\n\\nRunning install scripts executes third-party code. Confirm only if you trust this skill\\'s source.',
      async () => {
        $('dispatch-output').style.display = 'block';
        $('dispatch-output').textContent = 'Dispatching to ' + worker + '…';
        try {
          const r = await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills/deps', { slug });
          $('dispatch-output').textContent = (r.content || '(no output)') + '\\n\\n-- done --';
        } catch (e) { $('dispatch-output').textContent = 'Error: ' + e.message; }
      }
    );
  } catch (e) { showMsg('err', e.message); }
});

// --- Channels + Activity ---
async function loadChannels(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/channels');
    const host = $('channels-list');
    if (!r.bindings.length) { host.innerHTML = '<div class="empty">No channel bindings.</div>'; return; }
    host.classList.remove('empty');
    host.innerHTML = r.bindings.map(b =>
      '<div class="kv"><b>'+esc(b.channel)+'</b>'
      + (b.account ? ' · <span class="chip">'+esc(b.account)+'</span>' : '')
      + ' · ' + esc(b.detail) + '</div>'
    ).join('');
  } catch (e) { showMsg('err', e.message); }
}

async function loadHandovers(){
  try {
    // Populate the "Transfer to" dropdown with every local agent except self.
    const targets = $('ho-target');
    if (!targets.options.length) {
      const raw = await fetch('/api/admin/state', { headers: window.AX_LOCAL_TOKEN ? { Authorization: 'Bearer ' + window.AX_LOCAL_TOKEN } : {} });
      const st = await raw.json();
      targets.innerHTML = (st.agents || [])
        .filter(a => a.id !== AGENT_ID)
        .map(a => '<option value="'+esc(a.id)+'">'+esc(a.name || a.id)+' ('+esc(a.id)+')</option>')
        .join('');
    }
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/handovers');
    renderHandoverList($('ho-incoming'), r.incoming, 'incoming');
    renderHandoverList($('ho-outgoing'), r.outgoing, 'outgoing');
  } catch (e) { showMsg('err', e.message); }
}

function renderHandoverList(host, list, direction){
  if (!list.length) {
    host.classList.add('empty');
    host.innerHTML = direction === 'incoming'
      ? 'No chats are currently routed to this agent.'
      : 'No chats are currently routed away from this agent.';
    return;
  }
  host.classList.remove('empty');
  host.innerHTML = list.map(o => {
    const who = direction === 'incoming' ? ('from ' + esc(o.fromAgent)) : ('to ' + esc(o.toAgent));
    const expires = o.expiresAt ? ' · expires ' + esc(o.expiresAt) : '';
    const consumed = o.summaryConsumedAt ? ' · briefing delivered' : (o.summary ? ' · briefing pending' : '');
    return '<div class="node-row">'
      + '<span class="chip">'+esc(o.channel)+'</span>'
      + '<span class="mono">'+esc(o.chatId)+(o.accountId ? ':'+esc(o.accountId) : '')+'</span>'
      + '<span class="muted" style="flex:1">'+who+' · since '+esc(o.createdAt)+expires+consumed+'</span>'
      + '<button class="danger" data-release="'+esc(o.channel)+'::'+esc(o.chatId)+'::'+esc(o.accountId || '')+'">Release</button>'
      + '</div>';
  }).join('');
  host.querySelectorAll('[data-release]').forEach(btn => btn.addEventListener('click', () => {
    const [ch, cid, acct] = btn.dataset.release.split('::');
    releaseHandover(ch, cid, acct || undefined);
  }));
}

async function releaseHandover(channel, chatId, accountId){
  if (!confirm('Release the handover for ' + channel + ':' + chatId + '? Routing will revert to the config default on the next message.')) return;
  try {
    await req('DELETE', '/api/admin/agent/' + AGENT_ID + '/handovers', { channel, chatId, accountId });
    showMsg('ok', 'Handover released.');
    loadHandovers();
  } catch (e) { showMsg('err', e.message); }
}

$('btn-handover').addEventListener('click', () => {
  const channel = $('ho-channel').value;
  const chatId = $('ho-chatid').value.trim();
  const accountId = $('ho-account').value.trim() || undefined;
  const toAgent = $('ho-target').value;
  const summary = $('ho-summary').value.trim() || undefined;
  const expiresAt = $('ho-expires').value.trim() || undefined;
  if (!chatId || !toAgent) { showMsg('err', 'chat id and target agent are required'); return; }
  confirmAction(
    'Hand off this chat?',
    channel + ':' + chatId + (accountId ? ':'+accountId : '') + '\\n\\n'
    + 'From: ' + AGENT_ID + '\\nTo: ' + toAgent + '\\n\\n'
    + 'Every next message from this chat will be routed to ' + toAgent + ' until you release the handover. '
    + (summary ? 'The target agent will see your briefing note on its first reply.' : 'No briefing note set — the target agent will not know why.'),
    async () => {
      try {
        await req('POST', '/api/admin/agent/' + AGENT_ID + '/handovers',
          { channel, chatId, accountId, toAgent, summary, expiresAt });
        $('ho-summary').value = '';
        showMsg('ok', 'Handed off.');
        loadHandovers();
      } catch (e) { showMsg('err', e.message); }
    }
  );
});

async function loadActivity(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/activity');
    const host = $('activity');
    host.classList.remove('empty');
    host.innerHTML =
      '<div class="kv"><b>Active</b>' + (r.activeTasks ?? 0) + '</div>' +
      '<div class="kv"><b>Total</b>' + (r.totalTasks ?? 0) + '</div>' +
      '<div class="kv"><b>Errors</b>' + (r.errors ?? 0) + '</div>' +
      '<div class="kv"><b>Last active</b>' + (r.lastActive || '—') + '</div>' +
      (r.lastSummary ? '<div class="kv"><b>Last task</b><span>'+esc((r.lastSummary.text || '').slice(0, 240))+'</span></div>' : '');
  } catch (e) { showMsg('err', e.message); }
}

$('btn-test-drive').addEventListener('click', () => {
  window.location.href = '/admin#agent=' + encodeURIComponent(AGENT_ID);
});

loadAgent();
`
