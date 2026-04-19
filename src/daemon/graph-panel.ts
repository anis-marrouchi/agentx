import type { IncomingMessage, ServerResponse } from "http"
import { resolve } from "path"
import { loadDaemonConfig } from "./config"
import { GraphStore, type GraphNode, type Classification } from "@/graph"
import { renderTopbar, TOPBAR_HEAD, TOPBAR_CSS, TOPBAR_SCRIPT, type TopbarPeer } from "./topbar"

// --- /admin/graph panel: Intent Knowledge Graph management ---
//
// Three surfaces:
//   1. Pending queue — LLM-proposed classifications awaiting human approval.
//      Approve / reject / edit-path inline.
//   2. Tree view — current nodes grouped by level, editable axes.
//   3. Schema — raw JSON editor for the level definitions (advanced).
//
// Matches admin-panel.ts in chrome + form-driven style. All persistence goes
// through GraphStore so the disk layout stays canonical.

export function handleGraphGet(
  _req: IncomingMessage,
  res: ServerResponse,
  peers: TopbarPeer[] = [],
  localToken?: string,
): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderGraphHtml(peers, localToken))
}

export async function handleGraphApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  try {
    const body = req.method === "GET" ? undefined : await readJsonBody(req)
    const store = openStore()
    const dispatch: Record<string, () => unknown> = {
      "GET /api/admin/graph/state": () => getGraphState(store),
      "POST /api/admin/graph/classifications/approve": () => approveClassification(store, body),
      "POST /api/admin/graph/classifications/reject": () => rejectClassification(store, body),
      "POST /api/admin/graph/nodes": () => createNode(store, body),
      "PATCH /api/admin/graph/nodes": () => updateNode(store, body),
      "DELETE /api/admin/graph/nodes": () => deleteNode(store, body),
      "PUT /api/admin/graph/schema": () => saveSchema(store, body),
    }
    const key = `${req.method} ${path}`
    const handler = dispatch[key]
    if (!handler) {
      sendJson(res, 404, { error: `unknown graph endpoint: ${key}` })
      return
    }
    const result = await handler()
    sendJson(res, 200, result)
  } catch (e: any) {
    sendJson(res, 400, { error: e?.message || "graph op failed" })
  }
}

// ========================================================================
// Store open — reads graph.baseDir out of agentx.json each call (cheap).
// ========================================================================

function openStore(): GraphStore {
  const cfg = loadDaemonConfig()
  const baseDir = resolve(process.cwd(), cfg.graph.baseDir)
  return new GraphStore({ baseDir })
}

// ========================================================================
// Read side
// ========================================================================

function getGraphState(store: GraphStore) {
  const cfg = loadDaemonConfig()
  const schema = store.loadSchema()
  const nodes = store.loadNodes().nodes
  const recent = store.readRecentClassifications(100)
  const index = store.loadIndex().entries

  // A classification is "pending" if its fingerprint hasn't landed in the
  // snap-to-path index yet AND its latest log row isn't rejected. We scan the
  // recent log newest-first so later entries (approved/rejected) win over
  // earlier pending ones for the same msgHash.
  const seen = new Map<string, Classification>()
  for (const c of recent) {
    if (!seen.has(c.msgHash)) seen.set(c.msgHash, c)
  }
  const pending: Classification[] = []
  for (const c of seen.values()) {
    if (c.status === "pending" && !index[c.msgHash]) pending.push(c)
  }

  return {
    enabled: cfg.graph.enabled,
    schema,
    nodes,
    pending,
    recent: recent.slice(0, 25),
    counts: {
      nodes: nodes.length,
      pending: pending.length,
      fingerprints: Object.keys(index).length,
    },
  }
}

// ========================================================================
// Mutations
// ========================================================================

function approveClassification(store: GraphStore, body: any) {
  const msgHash = String(body?.msgHash || "").trim()
  if (!msgHash) throw new Error("msgHash is required")
  const c = findPending(store, msgHash)
  // Allow the UI to override the path / axes before approving.
  if (Array.isArray(body?.path) && body.path.length > 0) {
    c.path = body.path.map((s: any) => String(s))
  }
  if (body?.proposedAxes && typeof body.proposedAxes === "object") {
    c.proposedAxes = sanitizeAxes(body.proposedAxes)
  }
  store.approveClassification(c)
  return { summary: `Approved ${c.msgHash}` }
}

function rejectClassification(store: GraphStore, body: any) {
  const msgHash = String(body?.msgHash || "").trim()
  if (!msgHash) throw new Error("msgHash is required")
  const c = findPending(store, msgHash)
  store.rejectClassification(c)
  return { summary: `Rejected ${c.msgHash}` }
}

function findPending(store: GraphStore, msgHash: string): Classification {
  const recent = store.readRecentClassifications(500)
  const hit = recent.find((c) => c.msgHash === msgHash)
  if (!hit) throw new Error(`No classification found for ${msgHash}`)
  return hit
}

function createNode(store: GraphStore, body: any): { node: GraphNode } {
  const id = slug(String(body?.id || ""))
  const level = String(body?.level || "").trim()
  const parentId = body?.parentId ? slug(String(body.parentId)) : null
  const axes = sanitizeAxes({ [id]: body?.axes || {} })[id] || {}
  if (!id) throw new Error("id is required")
  if (!level) throw new Error("level is required")
  const node: GraphNode = {
    id,
    level,
    parentId,
    axes,
    createdAt: new Date().toISOString(),
    createdBy: "admin-ui",
  }
  store.addNode(node)
  return { node }
}

function updateNode(store: GraphStore, body: any): { node: GraphNode } {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id is required")
  const axes = sanitizeAxes({ [id]: body?.axes || {} })[id] || {}
  const node = store.updateNodeAxes(id, axes)
  return { node }
}

function deleteNode(store: GraphStore, body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id is required")
  store.deleteNode(id)
  return { summary: `Deleted ${id}` }
}

function saveSchema(store: GraphStore, body: any) {
  if (!body?.schema || typeof body.schema !== "object") {
    throw new Error("schema object is required")
  }
  store.saveSchema(body.schema) // GraphStore validates via zod; throws on invalid
  return { summary: "Schema saved" }
}

// ========================================================================
// Helpers
// ========================================================================

function sanitizeAxes(
  src: Record<string, any>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const [nodeId, axes] of Object.entries(src || {})) {
    if (!axes || typeof axes !== "object") continue
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(axes as Record<string, unknown>)) {
      if (typeof v === "string") clean[k] = v
    }
    out[nodeId] = clean
  }
  return out
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok, err) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      try {
        ok(raw ? JSON.parse(raw) : {})
      } catch (e) {
        err(e)
      }
    })
    req.on("error", err)
  })
}

// ========================================================================
// HTML — tree + pending queue + schema editor, all in one page
// ========================================================================

function renderGraphHtml(peers: TopbarPeer[], localToken?: string): string {
  const topbar = renderTopbar({
    activeTab: "graph",
    subtitle: "Intent Graph",
    peers,
  })
  const tokenScript = localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(localToken)};</script>`
    : ""
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <title>AgentX · Intent Graph</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${TOPBAR_HEAD}
  <style>
    :root{
      --ax-bg:#0a0b0f; --ax-bg-elev:#101218; --ax-surface:#151823;
      --ax-text:#e5e7eb; --ax-text-2:#b1b4c0; --ax-muted:#7a7d8a;
      --ax-border:#1d212d; --ax-border-2:#262a38; --ax-accent:#7aa2f7;
      --ax-green:#4ade80; --ax-red:#f87171; --ax-yellow:#fbbf24;
      --ax-mono:'IBM Plex Mono',ui-monospace,monospace;
    }
    :root[data-theme="light"]{
      --ax-bg:#f8fafc;--ax-bg-elev:#ffffff;--ax-surface:#ffffff;
      --ax-text:#111827;--ax-text-2:#374151;--ax-muted:#6b7280;
      --ax-border:#e5e7eb;--ax-border-2:#d1d5db;--ax-accent:#2563eb;
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--ax-bg);color:var(--ax-text);
      font-family:'IBM Plex Sans',system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5}
    ${TOPBAR_CSS}
    main{max-width:1200px;margin:0 auto;padding:24px 20px 60px}
    h2{margin:0 0 12px;font-size:16px;font-weight:600;letter-spacing:-0.01em}
    .grid{display:grid;gap:20px;grid-template-columns:1fr}
    @media (min-width:920px){.grid-2{grid-template-columns:3fr 2fr}}
    .card{background:var(--ax-bg-elev);border:1px solid var(--ax-border);
      border-radius:8px;padding:16px}
    .card h2{margin-top:0}
    .muted{color:var(--ax-muted);font-size:12px}
    .mono{font-family:var(--ax-mono)}
    .chip{display:inline-block;padding:1px 8px;border-radius:3px;
      font-size:11px;background:var(--ax-surface);color:var(--ax-text-2);
      border:1px solid var(--ax-border);margin-right:4px}
    .chip.pending{background:rgba(251,191,36,0.15);color:var(--ax-yellow);border-color:transparent}
    .chip.approved{background:rgba(74,222,128,0.15);color:var(--ax-green);border-color:transparent}
    .chip.rejected{background:rgba(248,113,113,0.15);color:var(--ax-red);border-color:transparent}
    button,.btn{font:inherit;font-size:12px;padding:6px 12px;border-radius:4px;
      border:1px solid var(--ax-border-2);background:var(--ax-surface);
      color:var(--ax-text);cursor:pointer}
    button:hover{border-color:var(--ax-accent);color:var(--ax-accent)}
    button.primary{background:var(--ax-accent);color:#0a0b0f;border-color:var(--ax-accent);font-weight:600}
    button.primary:hover{filter:brightness(1.08);color:#0a0b0f}
    button.danger{color:var(--ax-red);border-color:var(--ax-red)}
    button.danger:hover{background:var(--ax-red);color:#fff}
    input,textarea,select{font:inherit;font-size:12px;padding:6px 10px;
      background:var(--ax-surface);color:var(--ax-text);
      border:1px solid var(--ax-border);border-radius:4px;width:100%;
      font-family:var(--ax-mono)}
    textarea{min-height:220px;white-space:pre;line-height:1.45}
    .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .row > *{flex:0 0 auto}
    .row > input,.row > select{flex:1 1 160px;min-width:0}
    .pending-item{border-bottom:1px solid var(--ax-border);padding:12px 0}
    .pending-item:last-child{border-bottom:none}
    .pending-preview{color:var(--ax-text-2);font-size:12px;margin:6px 0 8px;
      padding:8px 10px;background:var(--ax-surface);border-radius:4px;
      border-left:2px solid var(--ax-accent);white-space:pre-wrap}
    .path-crumbs{font-family:var(--ax-mono);font-size:12px;color:var(--ax-accent);
      margin:4px 0}
    .level-group{margin-bottom:16px}
    .level-group h3{font-size:12px;margin:0 0 6px;font-weight:600;
      text-transform:uppercase;letter-spacing:0.06em;color:var(--ax-muted)}
    .node-row{display:flex;align-items:center;gap:10px;padding:6px 0;
      border-bottom:1px dotted var(--ax-border)}
    .node-row:last-child{border:none}
    .node-id{font-family:var(--ax-mono);font-weight:600;min-width:180px}
    .axes{display:flex;gap:6px;flex-wrap:wrap;flex:1}
    .axis{font-size:11px;color:var(--ax-text-2)}
    .axis b{color:var(--ax-text);font-weight:500}
    .empty{color:var(--ax-muted);font-style:italic;padding:16px;text-align:center}
    .banner{padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:12px}
    .banner.warn{background:rgba(251,191,36,0.08);color:var(--ax-yellow);
      border:1px solid rgba(251,191,36,0.3)}
    .msg{font-size:11px;padding:6px 10px;border-radius:4px;margin-top:8px;display:none}
    .msg.ok{background:rgba(74,222,128,0.1);color:var(--ax-green);display:block}
    .msg.err{background:rgba(248,113,113,0.1);color:var(--ax-red);display:block}
    .counts{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap}
    .count{background:var(--ax-bg-elev);border:1px solid var(--ax-border);
      border-radius:6px;padding:10px 14px;min-width:110px}
    .count .n{font-size:20px;font-weight:600;line-height:1}
    .count .l{font-size:11px;color:var(--ax-muted);margin-top:4px}
    details{background:var(--ax-surface);border:1px solid var(--ax-border);
      border-radius:4px;padding:8px 12px;margin-top:8px}
    details summary{cursor:pointer;font-size:11px;color:var(--ax-muted);
      user-select:none}
    details[open] summary{margin-bottom:8px}
  </style>
</head>
<body>
${topbar}
<main>
  <div id="msg" class="msg"></div>

  <div id="disabled-banner" class="banner warn" style="display:none">
    <b>Graph is disabled.</b> Set <code class="mono">graph.enabled: true</code>
    in <code class="mono">agentx.json</code> to start classifying traffic.
    The admin UI works either way — nothing classifies until the daemon reloads with graph enabled.
  </div>

  <div class="counts">
    <div class="count"><div class="n" id="c-nodes">—</div><div class="l">Nodes</div></div>
    <div class="count"><div class="n" id="c-pending">—</div><div class="l">Pending</div></div>
    <div class="count"><div class="n" id="c-fp">—</div><div class="l">Cached fingerprints</div></div>
  </div>

  <div class="grid grid-2">
    <section class="card">
      <h2>Pending approval</h2>
      <p class="muted">The LLM proposed a path for these messages. Approve to add the fingerprint to the snap-to-path cache so similar messages don't hit the LLM again.</p>
      <div id="pending-list"></div>
    </section>

    <section class="card">
      <h2>Taxonomy</h2>
      <p class="muted">Current nodes, grouped by level. Edit axes inline; add nodes with the form below.</p>
      <div id="tree"></div>

      <details>
        <summary>Add node</summary>
        <div class="row" style="margin-top:10px">
          <select id="n-level"></select>
          <input id="n-id" placeholder="node id (e.g. noqta-devops)" />
          <select id="n-parent"><option value="">— no parent —</option></select>
        </div>
        <div class="row" style="margin-top:6px">
          <input id="n-axes" placeholder='axes JSON, e.g. {"name":"DevOps","orgKind":"team"}' />
          <button class="primary" id="btn-add-node">Add</button>
        </div>
      </details>
    </section>
  </div>

  <section class="card" style="margin-top:20px">
    <h2>Schema (advanced)</h2>
    <p class="muted">Levels and their required axes. Edit carefully — changing enum values or removing axes can orphan existing nodes.</p>
    <textarea id="schema-editor" spellcheck="false"></textarea>
    <div class="row" style="margin-top:10px;justify-content:flex-end">
      <button id="btn-reload-schema">Reload</button>
      <button class="primary" id="btn-save-schema">Save schema</button>
    </div>
  </section>

  <section class="card" style="margin-top:20px">
    <h2>Recent classifications</h2>
    <p class="muted">Last 25 log rows, newest first — approved / pending / rejected.</p>
    <div id="recent"></div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const state = { schema: null, nodes: [], pending: [], recent: [] };

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (window.AX_LOCAL_TOKEN) headers['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
  const r = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function showMsg(kind, text) {
  const m = $('msg');
  m.className = 'msg ' + kind;
  m.textContent = text;
  setTimeout(() => { m.className = 'msg'; }, 4000);
}

function pathLabel(path) {
  return path.map(id => {
    const n = state.nodes.find(x => x.id === id);
    return n ? (n.axes?.name || n.axes?.what || id) : id;
  }).join(' › ');
}

function renderCounts(counts, enabled) {
  $('c-nodes').textContent = counts.nodes;
  $('c-pending').textContent = counts.pending;
  $('c-fp').textContent = counts.fingerprints;
  $('disabled-banner').style.display = enabled ? 'none' : 'block';
}

function renderTree() {
  const host = $('tree');
  if (!state.schema || state.nodes.length === 0) {
    host.innerHTML = '<div class="empty">No nodes yet. The classifier populates these as new intents arrive.</div>';
    return;
  }
  let html = '';
  for (const level of state.schema.levels) {
    const nodes = state.nodes.filter(n => n.level === level.id);
    html += '<div class="level-group"><h3>' + esc(level.id) + '</h3>';
    if (!nodes.length) {
      html += '<div class="muted" style="padding-left:4px">—</div>';
    } else {
      for (const n of nodes) {
        const axes = Object.entries(n.axes || {}).map(([k, v]) =>
          '<span class="axis"><b>' + esc(k) + ':</b> ' + esc(v) + '</span>'
        ).join(' ');
        html += '<div class="node-row">'
          + '<span class="node-id">' + esc(n.id) + '</span>'
          + '<div class="axes">' + axes + '</div>'
          + '<button data-edit="' + esc(n.id) + '">Edit</button>'
          + '<button class="danger" data-del="' + esc(n.id) + '">Delete</button>'
          + '</div>';
      }
    }
    html += '</div>';
  }
  host.innerHTML = html;
  host.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => editNode(b.getAttribute('data-edit')))
  );
  host.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => deleteNode(b.getAttribute('data-del')))
  );
}

function renderPending() {
  const host = $('pending-list');
  if (!state.pending.length) {
    host.innerHTML = '<div class="empty">Nothing pending. New traffic will appear here when the classifier proposes a novel path.</div>';
    return;
  }
  host.innerHTML = state.pending.map(c => {
    const conf = c.confidence != null ? ' · confidence ' + (c.confidence * 100).toFixed(0) + '%' : '';
    const preview = c.preview || '(no preview)';
    const path = pathLabel(c.path);
    return '<div class="pending-item" data-hash="' + esc(c.msgHash) + '">'
      + '<div class="muted" style="font-size:11px">' + esc(c.channel || '?') + ' · ' + esc(c.sender || '?') + conf + ' · ' + esc(c.ts) + '</div>'
      + '<div class="path-crumbs">' + esc(path) + '</div>'
      + '<div class="pending-preview">' + esc(preview) + '</div>'
      + '<div class="row">'
      +   '<button class="primary" data-approve="' + esc(c.msgHash) + '">Approve</button>'
      +   '<button class="danger" data-reject="' + esc(c.msgHash) + '">Reject</button>'
      + '</div>'
      + '</div>';
  }).join('');
  host.querySelectorAll('[data-approve]').forEach(b =>
    b.addEventListener('click', () => approve(b.getAttribute('data-approve')))
  );
  host.querySelectorAll('[data-reject]').forEach(b =>
    b.addEventListener('click', () => reject(b.getAttribute('data-reject')))
  );
}

function renderRecent() {
  const host = $('recent');
  if (!state.recent.length) {
    host.innerHTML = '<div class="empty">No classifications yet.</div>';
    return;
  }
  host.innerHTML = state.recent.map(c =>
    '<div class="node-row">'
    + '<span class="chip ' + esc(c.status) + '">' + esc(c.status) + '</span>'
    + '<span class="mono muted" style="font-size:11px">' + esc(c.ts) + '</span>'
    + '<span style="flex:1">' + esc(pathLabel(c.path)) + '</span>'
    + '<span class="muted" style="font-size:11px">' + esc(c.source) + '</span>'
    + '</div>'
  ).join('');
}

function renderSchemaEditor() {
  $('schema-editor').value = JSON.stringify(state.schema, null, 2);
  const levelSel = $('n-level');
  levelSel.innerHTML = state.schema.levels.map(l =>
    '<option value="' + esc(l.id) + '">' + esc(l.id) + '</option>'
  ).join('');
  const parentSel = $('n-parent');
  parentSel.innerHTML = '<option value="">— no parent —</option>' +
    state.nodes.map(n => '<option value="' + esc(n.id) + '">'
      + esc(n.id) + ' (' + esc(n.level) + ')</option>').join('');
}

async function refresh() {
  try {
    const r = await req('GET', '/api/admin/graph/state');
    state.schema = r.schema;
    state.nodes = r.nodes;
    state.pending = r.pending;
    state.recent = r.recent;
    renderCounts(r.counts, r.enabled);
    renderTree();
    renderPending();
    renderRecent();
    renderSchemaEditor();
  } catch (e) { showMsg('err', e.message); }
}

async function approve(msgHash) {
  try {
    await req('POST', '/api/admin/graph/classifications/approve', { msgHash });
    showMsg('ok', 'Approved.');
    refresh();
  } catch (e) { showMsg('err', e.message); }
}

async function reject(msgHash) {
  if (!confirm('Reject this classification? It will not be committed and no fingerprint is cached.')) return;
  try {
    await req('POST', '/api/admin/graph/classifications/reject', { msgHash });
    showMsg('ok', 'Rejected.');
    refresh();
  } catch (e) { showMsg('err', e.message); }
}

async function editNode(id) {
  const n = state.nodes.find(x => x.id === id);
  if (!n) return;
  const current = JSON.stringify(n.axes || {}, null, 2);
  const next = prompt('Edit axes for "' + id + '" (JSON):', current);
  if (next == null) return;
  let axes;
  try { axes = JSON.parse(next); } catch { showMsg('err', 'Invalid JSON'); return; }
  try {
    await req('PATCH', '/api/admin/graph/nodes', { id, axes });
    showMsg('ok', 'Node updated.');
    refresh();
  } catch (e) { showMsg('err', e.message); }
}

async function deleteNode(id) {
  if (!confirm('Delete node "' + id + '"? Fails if it has children or references.')) return;
  try {
    await req('DELETE', '/api/admin/graph/nodes', { id });
    showMsg('ok', 'Deleted.');
    refresh();
  } catch (e) { showMsg('err', e.message); }
}

$('btn-add-node').addEventListener('click', async () => {
  const level = $('n-level').value;
  const id = $('n-id').value.trim();
  const parentId = $('n-parent').value || null;
  let axes = {};
  const raw = $('n-axes').value.trim();
  if (raw) {
    try { axes = JSON.parse(raw); }
    catch { showMsg('err', 'Axes JSON invalid.'); return; }
  }
  try {
    await req('POST', '/api/admin/graph/nodes', { id, level, parentId, axes });
    $('n-id').value = ''; $('n-axes').value = '';
    showMsg('ok', 'Node added.');
    refresh();
  } catch (e) { showMsg('err', e.message); }
});

$('btn-save-schema').addEventListener('click', async () => {
  let schema;
  try { schema = JSON.parse($('schema-editor').value); }
  catch { showMsg('err', 'Schema JSON invalid.'); return; }
  try {
    await req('PUT', '/api/admin/graph/schema', { schema });
    showMsg('ok', 'Schema saved.');
    refresh();
  } catch (e) { showMsg('err', e.message); }
});

$('btn-reload-schema').addEventListener('click', refresh);

refresh();
</script>
${tokenScript}
${TOPBAR_SCRIPT}
</body>
</html>`
}
