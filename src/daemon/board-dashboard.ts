import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { appendFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"
import type { DaemonConfig } from "./config"
import type { BoardConfig } from "@/boards/config"
import { deriveStage, transitionLabelDiff } from "@/boards/config"
import type { WorkSource, WorkItem } from "@/business/work-pool"
import { GitLabWorkSource } from "@/business/work-pool"
import { SORTABLE_JS } from "./vendor/sortable"

// --- Kanban Board Dashboard ---
//
// Zero-build web UI, served on its own port (default 4202, bound 127.0.0.1).
// Mirrors src/daemon/usage-dashboard.ts — inline HTML/CSS/JS, manual routing,
// no framework. Write routes mutate the configured WorkSource (GitLab only in
// Phase 1), audit every mutation to .agentx/board-audit.jsonl.
//
// Launch: agentx board serve (see src/commands/board.ts).

export function startBoardDashboard(config: DaemonConfig): void {
  const dashboard = config.dashboard
  const boards = config.boards
  if (boards.length === 0) {
    console.log("  No boards configured in agentx.json (boards[]). Nothing to serve.")
    return
  }

  const port = dashboard.port
  const bind = dashboard.bind
  const token = dashboard.token

  // Eager-initialize one WorkSource per board (Phase 1: GitLab only).
  const sources = new Map<string, WorkSource>()
  for (const board of boards) {
    try {
      sources.set(board.id, buildWorkSource(board, config))
    } catch (e: any) {
      console.error(`  Board "${board.id}" failed to initialize: ${e.message}`)
    }
  }

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, { boards, sources, token })
    } catch (e: any) {
      sendJson(res, 500, { error: e.message || "internal error" })
    }
  })

  server.listen(port, bind, () => {
    const displayHost = bind === "0.0.0.0" ? "localhost" : bind
    console.log(`\n  Kanban dashboard: http://${displayHost}:${port}\n`)
    console.log(`  Boards: ${boards.map((b) => b.id).join(", ")}`)
    if (bind === "127.0.0.1" && !token) {
      console.log("  (bound to localhost; no auth token — safe default)")
    } else if (bind !== "127.0.0.1" && !token) {
      console.log("  ⚠ bound to a non-loopback address without a token — writes are UNAUTHENTICATED")
    }
  })
}

// --- Routing ---

interface Ctx {
  boards: BoardConfig[]
  sources: Map<string, WorkSource>
  token?: string
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost")
  const path = url.pathname
  const method = (req.method || "GET").toUpperCase()

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return }

  // Static / HTML
  if (method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderBoardHtml())
    return
  }
  if (method === "GET" && path === "/sortable.min.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" })
    res.end(SORTABLE_JS)
    return
  }

  // Auth gate: applies to /api/* only. Reads require token if configured;
  // writes are always token-checked if configured.
  if (path.startsWith("/api/") && ctx.token) {
    const authHeader = req.headers.authorization || ""
    const got = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (got !== ctx.token) { sendJson(res, 401, { error: "unauthorized" }); return }
  }

  // Write-specific CSRF defense-in-depth
  const isWrite = method === "POST" || method === "PATCH" || method === "DELETE"
  if (isWrite && path.startsWith("/api/")) {
    const xr = req.headers["x-requested-with"]
    if (xr !== "agentx-board") { sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" }); return }
  }

  // /api/boards
  if (method === "GET" && path === "/api/boards") {
    sendJson(res, 200, ctx.boards.map((b) => ({
      id: b.id,
      name: b.name,
      source: b.source,
      primaryToolLabel: b.primaryToolLabel,
      labels: b.labels,
      columns: b.columns,
      timeRangeDays: b.timeRangeDays,
    })))
    return
  }

  // /api/boards/:id/items or /api/boards/:id/items/:itemId/move
  const itemsMatch = path.match(/^\/api\/boards\/([a-z0-9_-]+)\/items(?:\/(.+?)\/(move|assign))?$/)
  if (itemsMatch) {
    const [, boardId, itemId, action] = itemsMatch
    const board = ctx.boards.find((b) => b.id === boardId)
    if (!board) { sendJson(res, 404, { error: `unknown board: ${boardId}` }); return }
    const source = ctx.sources.get(boardId)
    if (!source) { sendJson(res, 503, { error: `board "${boardId}" source unavailable` }); return }

    if (method === "GET" && !itemId) {
      const items = await listBoardItems(board, source, url.searchParams)
      const columns: Record<string, WorkItem[]> = {}
      for (const col of board.columns) columns[col.id] = []
      for (const item of items) {
        const stage = item.stage || deriveStage(item.labels, board.columns)
        const arr = columns[stage] || columns.triage
        arr.push({ ...item, stage })
      }
      // Deterministic in-column ordering: priority asc, updatedAt desc
      for (const col of board.columns) {
        columns[col.id].sort((a, b) => {
          const p = (a.priority ?? 99) - (b.priority ?? 99)
          if (p !== 0) return p
          return (b.updatedAt || "").localeCompare(a.updatedAt || "")
        })
      }
      sendJson(res, 200, { columns, totals: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v.length])) })
      return
    }

    if (method === "PATCH" && itemId && action === "move") {
      const body = await readJson(req)
      const toCol = board.columns.find((c) => c.id === body.to)
      const fromCol = board.columns.find((c) => c.id === body.from)
      if (!toCol) { sendJson(res, 400, { error: `unknown 'to' column: ${body.to}` }); return }
      if (!source.capabilities.transition || !source.transition) {
        sendJson(res, 400, { error: `source ${source.type} does not support transitions` })
        return
      }
      const diff = transitionLabelDiff(fromCol, toCol)
      try {
        await source.transition(itemId, diff.add, diff.remove)
        audit({ actor: auditActor(req), action: "move", boardId, itemId, payload: { from: body.from, to: body.to } })
        sendJson(res, 200, { ok: true })
      } catch (e: any) {
        sendJson(res, 502, { error: e.message || "transition failed" })
      }
      return
    }
  }

  sendJson(res, 404, { error: "not found", path })
}

async function listBoardItems(
  board: BoardConfig,
  source: WorkSource,
  query: URLSearchParams,
): Promise<WorkItem[]> {
  if (!source.capabilities.listAll || !source.listAll) return []
  const labels: string[] = []
  if (board.primaryToolLabel) labels.push(board.primaryToolLabel)
  const extraLabel = query.get("label")
  if (extraLabel) labels.push(extraLabel)
  const items = await source.listAll({
    sinceDays: parseInt(query.get("days") || String(board.timeRangeDays), 10),
    labels: labels.length ? labels : undefined,
    search: query.get("q") || undefined,
  })
  // Stage derivation happens at response build time; also filter by assignee if requested
  const assignee = query.get("assignee")
  return assignee ? items.filter((i) => i.assignee === assignee) : items
}

// --- WorkSource construction ---

function buildWorkSource(board: BoardConfig, daemon: DaemonConfig): WorkSource {
  if (board.source.type === "gitlab") {
    const gl = daemon.channels.gitlab
    if (!gl?.token) throw new Error("channels.gitlab.token is required for gitlab boards")
    const agentUsernames: Record<string, string[]> = {}
    for (const mapping of gl.agentMappings) {
      if (mapping.gitlabUsernames.length) {
        agentUsernames[mapping.agentId] = mapping.gitlabUsernames
      }
    }
    return new GitLabWorkSource(gl.host, gl.token, board.source.projects, agentUsernames, (...args) => console.log("[board]", ...args))
  }
  throw new Error(`unsupported board source: ${(board.source as any).type}`)
}

// --- Audit log ---

function audit(entry: { actor: string; action: string; boardId: string; itemId?: string; payload?: unknown }): void {
  try {
    const dir = resolve(process.cwd(), ".agentx")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
    appendFileSync(resolve(dir, "board-audit.jsonl"), line)
  } catch {
    // Audit failures are non-fatal — don't surface to the client.
  }
}

function auditActor(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"]
  return (Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0]) || req.socket.remoteAddress || "unknown"
}

// --- HTTP helpers ---

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8")
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) { reject(e) }
    })
    req.on("error", reject)
  })
}

// --- HTML ---

function renderBoardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentX Kanban</title>
<style>${BOARD_CSS}</style>
</head>
<body>
<header>
  <div class="brand">AgentX</div>
  <select id="boardPicker"></select>
  <input id="filterSearch" type="search" placeholder="Filter…" />
  <select id="filterAssignee"><option value="">All assignees</option></select>
  <div id="filterLabels"></div>
  <div class="spacer"></div>
  <div id="conn" class="conn ok" title="ready">●</div>
</header>
<main id="columns"></main>
<script src="/sortable.min.js"></script>
<script>${BOARD_JS}</script>
</body>
</html>`
}

const BOARD_CSS = `
:root {
  --bg: #0f1117; --card: #1a1d27; --col: #141722; --border: #2a2d3a;
  --text: #e1e4ed; --muted: #8b8fa3; --accent: #6366f1;
  --green: #22c55e; --yellow: #f59e0b; --orange: #fb7a35; --red: #ef4444; --gray: #6b7280;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  background: var(--card); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
header .brand { font-weight: 600; letter-spacing: 0.5px; color: var(--accent); }
header select, header input { background: var(--col); color: var(--text);
  border: 1px solid var(--border); padding: 6px 10px; border-radius: 6px; font: inherit; }
header input[type="search"] { width: 200px; }
header .spacer { flex: 1; }
header .conn { font-size: 20px; line-height: 1; }
header .conn.ok { color: var(--green); }
header .conn.warn { color: var(--yellow); }
header .conn.err { color: var(--red); }
main#columns { display: grid; grid-template-columns: repeat(6, minmax(220px, 1fr));
  gap: 12px; padding: 12px; align-items: start; min-height: calc(100vh - 52px); }
.col { background: var(--col); border: 1px solid var(--border); border-radius: 8px;
  min-height: 300px; display: flex; flex-direction: column; }
.col h3 { margin: 0; padding: 10px 12px; border-bottom: 1px solid var(--border);
  font-size: 13px; font-weight: 600; color: var(--muted); display: flex; justify-content: space-between; align-items: center; }
.col h3 .count { background: var(--border); color: var(--text);
  font-size: 11px; padding: 2px 8px; border-radius: 10px; }
.stack { padding: 8px; display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; cursor: grab; transition: border-color .15s; }
.card:hover { border-color: var(--accent); }
.card .top { display: flex; justify-content: space-between; gap: 6px; align-items: center;
  font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.card .iid { font-family: ui-monospace, monospace; }
.card .labels { display: flex; gap: 4px; flex-wrap: wrap; }
.card .label { font-size: 10px; padding: 1px 6px; border-radius: 3px;
  background: rgba(99, 102, 241, 0.2); color: #c5c8d6; }
.card .title { font-weight: 500; margin: 2px 0; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.card .meta { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; }
.card .assignee { color: var(--text); }
.sortable-ghost { opacity: 0.4; }
.sortable-drag { cursor: grabbing; }
.empty { color: var(--muted); font-style: italic; text-align: center; padding: 16px; font-size: 12px; }
#toast { position: fixed; right: 16px; bottom: 16px; padding: 10px 14px;
  background: var(--red); color: white; border-radius: 6px; font-size: 13px;
  max-width: 320px; display: none; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
#toast.show { display: block; }
`

const BOARD_JS = `
'use strict';
const state = { boards: [], current: null, items: {}, filter: { q: '', assignee: '', label: '' } };

function csrfHeaders(extra) {
  return Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'agentx-board' }, extra || {});
}

function toast(msg, kind) {
  const el = document.getElementById('toast') || (() => {
    const d = document.createElement('div'); d.id = 'toast'; document.body.appendChild(d); return d;
  })();
  el.textContent = msg;
  el.style.background = kind === 'ok' ? 'var(--green)' : 'var(--red)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

async function loadBoards() {
  const r = await fetch('/api/boards');
  if (!r.ok) throw new Error('failed to load boards');
  state.boards = await r.json();
  const picker = document.getElementById('boardPicker');
  picker.innerHTML = '';
  for (const b of state.boards) {
    const opt = document.createElement('option');
    opt.value = b.id; opt.textContent = b.name || b.id;
    picker.appendChild(opt);
  }
  picker.onchange = () => switchBoard(picker.value);
  if (state.boards.length) switchBoard(state.boards[0].id);
}

async function switchBoard(id) {
  state.current = state.boards.find(b => b.id === id);
  renderColumns();
  populateFilters();
  await loadItems();
}

function populateFilters() {
  if (!state.current) return;
  const labelsEl = document.getElementById('filterLabels');
  labelsEl.innerHTML = '';
  for (const lbl of state.current.labels || []) {
    const chip = document.createElement('span');
    chip.className = 'label';
    chip.style.cursor = 'pointer';
    chip.style.borderLeft = \`3px solid \${lbl.color}\`;
    chip.textContent = lbl.name;
    chip.onclick = () => { state.filter.label = state.filter.label === lbl.name ? '' : lbl.name; loadItems(); renderChipStates(); };
    labelsEl.appendChild(chip);
  }
}
function renderChipStates() {
  document.querySelectorAll('#filterLabels .label').forEach(chip => {
    chip.style.opacity = (state.filter.label && chip.textContent !== state.filter.label) ? '0.4' : '1';
  });
}

function renderColumns() {
  const main = document.getElementById('columns');
  main.innerHTML = '';
  if (!state.current) return;
  for (const col of state.current.columns) {
    const section = document.createElement('section');
    section.className = 'col';
    section.dataset.colId = col.id;
    section.innerHTML = \`<h3>\${escapeHtml(col.title)} <span class="count">0</span></h3><div class="stack" data-col-id="\${col.id}"></div>\`;
    main.appendChild(section);
  }
  // Attach SortableJS to each stack
  document.querySelectorAll('.stack').forEach(el => {
    Sortable.create(el, {
      group: 'board', animation: 150,
      onEnd: async (ev) => {
        const from = ev.from.dataset.colId;
        const to = ev.to.dataset.colId;
        if (from === to) return;
        const itemId = ev.item.dataset.id;
        try {
          const r = await fetch(\`/api/boards/\${state.current.id}/items/\${encodeURIComponent(itemId)}/move\`, {
            method: 'PATCH', headers: csrfHeaders(), body: JSON.stringify({ from, to })
          });
          if (!r.ok) throw new Error(await r.text());
          toast('Moved ✓', 'ok');
          updateCounts();
        } catch (e) {
          // Snap back
          ev.from.insertBefore(ev.item, ev.from.children[ev.oldIndex] || null);
          updateCounts();
          toast('Move failed: ' + (e.message || 'unknown'));
        }
      }
    });
  });
}

function updateCounts() {
  document.querySelectorAll('.col').forEach(col => {
    const n = col.querySelector('.stack').children.length;
    const count = col.querySelector('.count');
    if (count) count.textContent = n;
  });
}

async function loadItems() {
  const conn = document.getElementById('conn');
  conn.className = 'conn warn'; conn.title = 'loading…';
  if (!state.current) return;
  const params = new URLSearchParams();
  if (state.filter.q) params.set('q', state.filter.q);
  if (state.filter.assignee) params.set('assignee', state.filter.assignee);
  if (state.filter.label) params.set('label', state.filter.label);
  try {
    const r = await fetch(\`/api/boards/\${state.current.id}/items?\${params.toString()}\`);
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    state.items = data.columns;
    paintItems();
    populateAssigneeFilter();
    conn.className = 'conn ok'; conn.title = 'ok';
  } catch (e) {
    conn.className = 'conn err'; conn.title = 'load failed';
    toast('Load failed: ' + (e.message || 'unknown'));
  }
}

function populateAssigneeFilter() {
  const set = new Set();
  for (const list of Object.values(state.items)) {
    for (const item of list) if (item.assignee) set.add(item.assignee);
  }
  const sel = document.getElementById('filterAssignee');
  const current = sel.value;
  sel.innerHTML = '<option value="">All assignees</option>';
  for (const a of [...set].sort()) {
    const o = document.createElement('option'); o.value = a; o.textContent = a;
    sel.appendChild(o);
  }
  sel.value = current;
}

function paintItems() {
  if (!state.current) return;
  for (const col of state.current.columns) {
    const stack = document.querySelector(\`.stack[data-col-id="\${col.id}"]\`);
    if (!stack) continue;
    stack.innerHTML = '';
    const list = state.items[col.id] || [];
    if (list.length === 0) {
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '—';
      stack.appendChild(empty);
      continue;
    }
    for (const item of list) stack.appendChild(renderCard(item));
  }
  updateCounts();
}

function renderCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = item.id;
  const iid = item.id.split(':').slice(-1)[0];
  const labelChips = (item.labels || []).slice(0, 3).map(l =>
    \`<span class="label" title="\${escapeHtml(l)}">\${escapeHtml(l)}</span>\`).join('');
  const assignee = item.assignee ? \`<span class="assignee">@\${escapeHtml(item.assignee)}</span>\` : '<span>unassigned</span>';
  const est = item.estimatedSeconds ? fmtDuration(item.estimatedSeconds) : '';
  const updated = item.updatedAt ? fmtRelative(item.updatedAt) : '';
  const url = item.url ? \`<a href="\${escapeHtml(item.url)}" target="_blank" rel="noopener" title="open in GitLab" style="color:var(--muted);text-decoration:none">↗</a>\` : '';
  card.innerHTML = \`
    <div class="top">
      <span class="iid">#\${escapeHtml(iid)}</span>
      <div class="labels">\${labelChips}</div>
      \${url}
    </div>
    <div class="title">\${escapeHtml(item.title || '(untitled)')}</div>
    <div class="meta">\${assignee}<span>\${est} \${updated ? '· ' + updated : ''}</span></div>
  \`;
  return card;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); const rem = m % 60;
  return rem ? \`\${h}h\${rem}m\` : h + 'h';
}
function fmtRelative(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return min + 'm';
  const h = Math.round(min / 60);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

document.getElementById('filterSearch').oninput = debounce(e => { state.filter.q = e.target.value; loadItems(); }, 200);
document.getElementById('filterAssignee').onchange = e => { state.filter.assignee = e.target.value; loadItems(); };

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

loadBoards().catch(e => toast('Init failed: ' + e.message));
`
