import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { appendFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"
import type { DaemonConfig } from "./config"
import type { BoardConfig, BoardColumn } from "@/boards/config"
import { deriveStage, transitionDiff } from "@/boards/config"
import type { WorkSource, WorkItem } from "@/business/work-pool"
import { GitLabWorkSource } from "@/business/work-pool"
import { SORTABLE_JS } from "./vendor/sortable"

// --- Kanban Board Dashboard ---
//
// Zero-build web UI, served on its own port (default 4202, bound 127.0.0.1).
// Mirrors src/daemon/usage-dashboard.ts — inline HTML/CSS/JS, manual routing,
// no framework.
//
// Column kinds (see src/boards/config.ts):
//   - open-backlog: opened issues with no Status::* scoped label
//   - scoped-label: opened issues with a specific Status::X label
//   - closed:       closed issues (bounded by closedWindowDays)
//   - label:        opened issues with a flat mapsToLabel (legacy)
//
// Drag-drop produces a ColumnTransition that may: add/remove labels, close,
// or reopen an issue (via GitLab `state_event`).

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
      await handleRequest(req, res, { boards, sources, token, config })
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

interface Ctx {
  boards: BoardConfig[]
  sources: Map<string, WorkSource>
  token?: string
  config: DaemonConfig
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost")
  const path = url.pathname
  const method = (req.method || "GET").toUpperCase()

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return }

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

  if (path.startsWith("/api/") && ctx.token) {
    const authHeader = req.headers.authorization || ""
    const got = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (got !== ctx.token) { sendJson(res, 401, { error: "unauthorized" }); return }
  }

  const isWrite = method === "POST" || method === "PATCH" || method === "DELETE"
  if (isWrite && path.startsWith("/api/")) {
    const xr = req.headers["x-requested-with"]
    if (xr !== "agentx-board") { sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" }); return }
  }

  if (method === "GET" && path === "/api/boards") {
    sendJson(res, 200, ctx.boards.map((b) => ({
      id: b.id, name: b.name, source: b.source,
      primaryToolLabel: b.primaryToolLabel, labels: b.labels,
      columns: b.columns, timeRangeDays: b.timeRangeDays,
    })))
    return
  }

  // /api/boards/:id/members — project members (for assignee picker)
  const membersMatch = path.match(/^\/api\/boards\/([a-z0-9_-]+)\/members$/)
  if (membersMatch && method === "GET") {
    const source = ctx.sources.get(membersMatch[1]) as GitLabWorkSource | undefined
    if (!source) { sendJson(res, 404, { error: "unknown board" }); return }
    try {
      const members = typeof source.listMembers === "function" ? await source.listMembers() : []
      sendJson(res, 200, members)
    } catch (e: any) { sendJson(res, 502, { error: e.message }) }
    return
  }

  // /api/boards/:id/milestones — project milestones (for milestone picker)
  const milestonesMatch = path.match(/^\/api\/boards\/([a-z0-9_-]+)\/milestones$/)
  if (milestonesMatch && method === "GET") {
    const source = ctx.sources.get(milestonesMatch[1]) as GitLabWorkSource | undefined
    if (!source) { sendJson(res, 404, { error: "unknown board" }); return }
    try {
      const ms = typeof source.listMilestones === "function" ? await source.listMilestones() : []
      sendJson(res, 200, ms)
    } catch (e: any) { sendJson(res, 502, { error: e.message }) }
    return
  }

  // /api/boards/:id/items[/...]
  // Legacy shape: /items/:itemId/move (move-only). New shape: /items/:itemId (GET/PATCH), /items (POST, GET).
  const moveMatch = path.match(/^\/api\/boards\/([a-z0-9_-]+)\/items\/(.+?)\/move$/)
  const itemOpMatch = path.match(/^\/api\/boards\/([a-z0-9_-]+)\/items(?:\/(.+))?$/)

  if (moveMatch && method === "PATCH") {
    const [, boardId, itemId] = moveMatch
    const board = ctx.boards.find((b) => b.id === boardId)
    if (!board) { sendJson(res, 404, { error: `unknown board: ${boardId}` }); return }
    const source = ctx.sources.get(boardId)
    if (!source) { sendJson(res, 503, { error: `board "${boardId}" source unavailable` }); return }
    const body = await readJson(req)
    const toCol = board.columns.find((c) => c.id === body.to)
    const fromCol = board.columns.find((c) => c.id === body.from)
    if (!toCol) { sendJson(res, 400, { error: `unknown 'to' column: ${body.to}` }); return }
    try {
      await applyTransition(source, itemId, fromCol, toCol)
      audit({ actor: auditActor(req), action: "move", boardId, itemId, payload: { from: body.from, to: body.to } })
      sendJson(res, 200, { ok: true })
    } catch (e: any) { sendJson(res, 502, { error: e.message || "transition failed" }) }
    return
  }

  if (itemOpMatch) {
    const [, boardId, itemId] = itemOpMatch
    const board = ctx.boards.find((b) => b.id === boardId)
    if (!board) { sendJson(res, 404, { error: `unknown board: ${boardId}` }); return }
    const source = ctx.sources.get(boardId) as GitLabWorkSource | undefined
    if (!source) { sendJson(res, 503, { error: `board "${boardId}" source unavailable` }); return }

    // GET /items — column dump
    if (method === "GET" && !itemId) {
      const { columns, totals } = await loadBoardColumns(board, source, url.searchParams)
      sendJson(res, 200, { columns, totals })
      return
    }

    // GET /items/:itemId — full detail
    if (method === "GET" && itemId) {
      try {
        const detail = typeof source.getItem === "function" ? await source.getItem(itemId) : null
        if (!detail) { sendJson(res, 404, { error: "not found" }); return }
        sendJson(res, 200, detail)
      } catch (e: any) { sendJson(res, 502, { error: e.message }) }
      return
    }

    // PATCH /items/:itemId — update
    if (method === "PATCH" && itemId) {
      const body = await readJson(req)
      try {
        const updated = typeof source.updateItem === "function"
          ? await source.updateItem(itemId, body)
          : null
        if (!updated) { sendJson(res, 501, { error: "update unsupported" }); return }
        audit({ actor: auditActor(req), action: "update", boardId, itemId, payload: body })
        sendJson(res, 200, updated)
      } catch (e: any) { sendJson(res, 502, { error: e.message }) }
      return
    }

    // POST /items — create new issue
    if (method === "POST" && !itemId) {
      const body = await readJson(req)
      if (!body.title) { sendJson(res, 400, { error: "title required" }); return }
      if (!source.capabilities.create || !source.create) {
        sendJson(res, 400, { error: `source ${source.type} does not support create` }); return
      }
      try {
        const created = await source.create({
          title: body.title,
          description: body.description,
          labels: body.labels,
          assigneeUsernames: body.assigneeUsernames,
          milestoneTitle: body.milestoneTitle,
          projectHint: body.projectHint,
        })
        audit({ actor: auditActor(req), action: "create", boardId, itemId: created.id, payload: { title: body.title } })
        sendJson(res, 201, created)
      } catch (e: any) { sendJson(res, 502, { error: e.message }) }
      return
    }
  }

  sendJson(res, 404, { error: "not found", path })
}

// --- Column loading ---

async function loadBoardColumns(
  board: BoardConfig,
  source: WorkSource,
  query: URLSearchParams,
): Promise<{ columns: Record<string, WorkItem[]>; totals: Record<string, number> }> {
  if (!source.capabilities.listAll || !source.listAll) {
    const empty: Record<string, WorkItem[]> = {}
    for (const c of board.columns) empty[c.id] = []
    return { columns: empty, totals: Object.fromEntries(board.columns.map((c) => [c.id, 0])) }
  }

  const baseLabels: string[] = []
  if (board.primaryToolLabel) baseLabels.push(board.primaryToolLabel)
  const extraLabel = query.get("label") || undefined
  if (extraLabel) baseLabels.push(extraLabel)
  const search = query.get("q") || undefined
  const milestone = query.get("milestone") || undefined
  const assignee = query.get("assignee") || undefined
  const openDays = parseInt(query.get("days") || String(board.timeRangeDays), 10)
  const closedDays = parseInt(query.get("closedDays") || String(board.closedWindowDays ?? 30), 10)

  // One query per column kind type. We batch all scoped-label/label/open-backlog
  // columns into a single "opened" query (client-side bucket them), and the
  // closed column (if any) into a second "closed" query.
  const hasOpen = board.columns.some((c) => c.kind !== "closed")
  const hasClosed = board.columns.some((c) => c.kind === "closed")

  const open: WorkItem[] = hasOpen
    ? await source.listAll({
        sinceDays: openDays, labels: baseLabels.length ? baseLabels : undefined,
        search, milestone, state: "opened",
      })
    : []
  const closed: WorkItem[] = hasClosed
    ? await source.listAll({
        sinceDays: closedDays, labels: baseLabels.length ? baseLabels : undefined,
        search, milestone, state: "closed",
      })
    : []

  const columns: Record<string, WorkItem[]> = {}
  for (const c of board.columns) columns[c.id] = []

  // Closed items → the closed column (if any).
  const closedCol = board.columns.find((c) => c.kind === "closed")
  for (const item of closed) {
    if (closedCol) columns[closedCol.id].push({ ...item, stage: closedCol.id })
  }

  // Open items → bucket by deriveStage over the open columns only.
  // Items with a scoped Status::* label that no column claims are dropped
  // (they're off-board workflow states like Status::Done when no Done column exists).
  const openColumns = board.columns.filter((c) => c.kind !== "closed")
  for (const item of open) {
    const stage = deriveStage(item, openColumns)
    if (!stage) continue
    const list = columns[stage]
    if (list) list.push({ ...item, stage })
  }

  // Assignee filter (post-query).
  if (assignee) {
    for (const k of Object.keys(columns)) {
      columns[k] = columns[k].filter((i) => i.assignee === assignee)
    }
  }

  // Deterministic in-column ordering: priority asc, updatedAt desc.
  for (const k of Object.keys(columns)) {
    columns[k].sort((a, b) => {
      const p = (a.priority ?? 99) - (b.priority ?? 99)
      if (p !== 0) return p
      return (b.updatedAt || "").localeCompare(a.updatedAt || "")
    })
  }

  const totals = Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v.length]))
  return { columns, totals }
}

async function applyTransition(
  source: WorkSource,
  itemId: string,
  fromCol: BoardColumn | undefined,
  toCol: BoardColumn,
): Promise<void> {
  const diff = transitionDiff(fromCol, toCol)
  const gl = source as GitLabWorkSource
  // Close/reopen first (so the issue exists in the right state before label edits).
  if (diff.closeIssue && typeof gl.setState === "function") {
    await gl.setState(itemId, "close")
  } else if (diff.reopen && typeof gl.setState === "function") {
    await gl.setState(itemId, "reopen")
  }
  if ((diff.addLabels?.length || diff.removeLabels?.length) && typeof gl.transitionMany === "function") {
    await gl.transitionMany(itemId, diff.addLabels || [], diff.removeLabels || [])
  } else if (diff.addLabels?.length && source.transition) {
    await source.transition(itemId, diff.addLabels[0], diff.removeLabels?.[0])
  }
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
  } catch { /* non-fatal */ }
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
<title>AgentX Boards</title>
<style>${BOARD_CSS}</style>
</head>
<body>
<header>
  <div class="brand">AgentX</div>
  <select id="boardPicker" title="Switch board"></select>
  <div class="search">
    <span class="icon">⌕</span>
    <input id="filterSearch" type="search" placeholder="Search or filter…" autocomplete="off" />
  </div>
  <select id="filterAssignee" title="Assignee"><option value="">All assignees</option></select>
  <select id="filterMilestone" title="Milestone"><option value="">Any milestone</option></select>
  <div id="filterLabels" class="chips"></div>
  <div class="spacer"></div>
  <button id="newIssueBtn" title="New issue">+ New</button>
  <button id="refreshBtn" title="Refresh (r)">↻</button>
  <div id="conn" class="conn ok" title="ready">●</div>
</header>
<main id="columns"></main>
<div id="toast"></div>
<div id="modal" class="modal" aria-hidden="true">
  <div class="modal-backdrop"></div>
  <div class="modal-panel" role="dialog" aria-modal="true">
    <header class="modal-h">
      <div class="modal-title-row">
        <span id="m-iid" class="iid"></span>
        <input id="m-title" type="text" placeholder="Issue title" />
      </div>
      <button id="m-close" class="x" title="Close (esc)">✕</button>
    </header>
    <div class="modal-body">
      <div class="m-main">
        <label class="fld">
          <span>Description</span>
          <textarea id="m-desc" rows="8" placeholder="Markdown supported"></textarea>
        </label>
        <div class="fld">
          <span>Labels</span>
          <div id="m-labels" class="chip-picker"></div>
        </div>
      </div>
      <aside class="m-side">
        <div class="fld">
          <span>State</span>
          <div id="m-state" class="state-toggle">
            <button data-state="opened">Open</button>
            <button data-state="closed">Closed</button>
          </div>
        </div>
        <div class="fld">
          <span>Assignees</span>
          <div id="m-assignees" class="chip-picker"></div>
        </div>
        <div class="fld">
          <span>Milestone</span>
          <select id="m-milestone"><option value="">None</option></select>
        </div>
        <div class="fld muted">
          <span>Author</span>
          <div id="m-author"></div>
        </div>
        <div class="fld muted">
          <span>Created</span>
          <div id="m-created"></div>
        </div>
        <div class="fld muted">
          <span>Updated</span>
          <div id="m-updated"></div>
        </div>
        <a id="m-link" class="ext-link" href="#" target="_blank" rel="noopener">Open in GitLab ↗</a>
      </aside>
    </div>
    <footer class="modal-f">
      <div id="m-hint" class="hint"></div>
      <div class="spacer"></div>
      <button id="m-cancel" class="btn-ghost">Cancel</button>
      <button id="m-save" class="btn-primary">Save</button>
    </footer>
  </div>
</div>
<script src="/sortable.min.js"></script>
<script>${BOARD_JS}</script>
</body>
</html>`
}

const BOARD_CSS = `
:root {
  --bg: #0f1117; --card: #1a1d27; --col: #161922; --col-hdr: #1e2230;
  --border: #2a2d3a; --border-soft: #22253220;
  --text: #e6e8ef; --muted: #8b8fa3; --accent: #6366f1;
  --green: #22c55e; --yellow: #f59e0b; --orange: #fb7a35;
  --red: #ef4444; --blue: #3b82f6; --gray: #6b7280;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  background: var(--card); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10;
  flex-wrap: wrap; }
header .brand { font-weight: 600; letter-spacing: 0.5px; color: var(--accent); font-size: 14px; }
header select, header input, header button { background: var(--col); color: var(--text);
  border: 1px solid var(--border); padding: 6px 10px; border-radius: 6px; font: inherit; outline: none; }
header select:focus, header input:focus { border-color: var(--accent); }
header .search { position: relative; }
header .search .icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  color: var(--muted); pointer-events: none; font-size: 14px; }
header .search input { padding-left: 28px; width: 260px; }
header button { cursor: pointer; }
header button:hover { border-color: var(--accent); }
header .chips { display: flex; gap: 4px; flex-wrap: wrap; }
header .spacer { flex: 1; }
header .conn { font-size: 16px; line-height: 1; }
header .conn.ok { color: var(--green); }
header .conn.warn { color: var(--yellow); }
header .conn.err { color: var(--red); }

main#columns { display: flex; gap: 10px; padding: 12px; overflow-x: auto; align-items: stretch;
  min-height: calc(100vh - 60px); }
.col { background: var(--col); border: 1px solid var(--border); border-radius: 8px;
  min-width: 280px; max-width: 320px; flex: 1 0 280px; display: flex; flex-direction: column;
  max-height: calc(100vh - 84px); }
.col .accent { height: 3px; border-top-left-radius: 7px; border-top-right-radius: 7px; background: var(--gray); }
.col header.col-h { margin: 0; padding: 10px 12px; background: var(--col-hdr);
  border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px;
  position: sticky; top: 0; z-index: 1; border-radius: 0; }
.col header.col-h h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); flex: 1; }
.col header.col-h .count { background: rgba(255,255,255,0.08); color: var(--muted);
  font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
.stack { padding: 8px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto;
  flex: 1; min-height: 40px; }

.card { background: var(--card); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; cursor: grab; transition: border-color .15s, transform .15s;
  display: flex; flex-direction: column; gap: 6px; }
.card:hover { border-color: var(--accent); }
.card.closed { opacity: 0.75; }
.card .title { font-weight: 500; font-size: 13px; line-height: 1.4; color: var(--text);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: break-word; }
.card .labels { display: flex; gap: 4px; flex-wrap: wrap; }
.card .label { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 500;
  background: rgba(99, 102, 241, 0.25); color: #e6e8ef; white-space: nowrap; line-height: 1.4; }
.card .foot { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted);
  flex-wrap: wrap; }
.card .foot .iid { font-family: ui-monospace, monospace; }
.card .foot .milestone { background: rgba(99,102,241,0.15); color: var(--accent);
  padding: 1px 6px; border-radius: 3px; font-size: 10px; }
.card .foot .est { background: rgba(255,255,255,0.08); padding: 1px 6px; border-radius: 3px; font-size: 10px; }
.card .foot .date { margin-left: auto; }
.card .foot a.link { color: var(--muted); text-decoration: none; }
.card .foot a.link:hover { color: var(--accent); }

.avatar { display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 50%; font-size: 10px; font-weight: 600;
  color: white; flex-shrink: 0; }
.avatar.unassigned { background: var(--gray); }

.sortable-ghost { opacity: 0.4; }
.sortable-drag { cursor: grabbing; }
.sortable-chosen { border-color: var(--accent); }
.empty { color: var(--muted); font-style: italic; text-align: center; padding: 16px; font-size: 12px; }

#toast { position: fixed; right: 16px; bottom: 16px; padding: 10px 14px;
  background: var(--red); color: white; border-radius: 6px; font-size: 13px;
  max-width: 360px; display: none; z-index: 200; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
#toast.show { display: block; }

/* Multi-assignee stack on cards */
.avatar-stack { display: inline-flex; }
.avatar-stack .avatar { margin-left: -6px; border: 2px solid var(--card); }
.avatar-stack .avatar:first-child { margin-left: 0; }
.avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }

/* Column add button */
.col header.col-h .add { background: transparent; color: var(--muted); border: 1px solid var(--border);
  padding: 0 8px; line-height: 22px; border-radius: 4px; cursor: pointer; font-size: 14px; }
.col header.col-h .add:hover { color: var(--accent); border-color: var(--accent); }

/* Header buttons */
header #newIssueBtn { background: var(--accent); color: white; border-color: var(--accent); }
header #newIssueBtn:hover { filter: brightness(1.1); }

/* --- Modal --- */
.modal { position: fixed; inset: 0; z-index: 150; display: none; }
.modal.open { display: block; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(2px); }
.modal-panel { position: relative; max-width: 940px; width: calc(100% - 40px); height: calc(100vh - 60px);
  margin: 30px auto; background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  display: flex; flex-direction: column; box-shadow: 0 16px 48px rgba(0,0,0,0.55); overflow: hidden; }
.modal-h { display: flex; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); align-items: center; }
.modal-h .modal-title-row { flex: 1; display: flex; gap: 10px; align-items: center; }
.modal-h .iid { font-family: ui-monospace, monospace; color: var(--muted); font-size: 13px; }
.modal-h input[type="text"] { flex: 1; background: var(--col); border: 1px solid var(--border); color: var(--text);
  padding: 8px 10px; border-radius: 6px; font-size: 15px; font-weight: 500; outline: none; }
.modal-h input[type="text"]:focus { border-color: var(--accent); }
.modal-h .x { background: transparent; color: var(--muted); border: none; font-size: 18px; cursor: pointer; padding: 6px 8px; }
.modal-h .x:hover { color: var(--text); }

.modal-body { flex: 1; display: grid; grid-template-columns: 1fr 300px; gap: 0;
  overflow: hidden; min-height: 0; }
.modal-body .m-main { padding: 16px; overflow-y: auto; min-height: 0; }
.modal-body .m-side { padding: 16px; border-left: 1px solid var(--border); background: var(--col);
  overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 14px; }

.fld { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.fld > span { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.fld.muted > div { font-size: 12px; color: var(--muted); }
.fld textarea { background: var(--col); border: 1px solid var(--border); color: var(--text);
  padding: 10px; border-radius: 6px; font: 13px/1.5 ui-monospace, "SF Mono", monospace; outline: none; resize: vertical; }
.fld textarea:focus { border-color: var(--accent); }
.fld select { background: var(--col); border: 1px solid var(--border); color: var(--text);
  padding: 6px 10px; border-radius: 6px; font: inherit; outline: none; }

.chip-picker { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px;
  background: var(--col); border: 1px solid var(--border); border-radius: 6px; min-height: 36px; }
.chip-picker .chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
  border-radius: 10px; font-size: 11px; background: rgba(99,102,241,0.25); color: #e6e8ef; font-weight: 500; }
.chip-picker .chip .remove { cursor: pointer; color: rgba(255,255,255,0.7); margin-left: 2px; }
.chip-picker .chip .remove:hover { color: white; }
.chip-picker .add-chip { background: transparent; border: 1px dashed var(--border); color: var(--muted);
  padding: 3px 10px; border-radius: 10px; cursor: pointer; font: inherit; font-size: 11px; }
.chip-picker .add-chip:hover { border-color: var(--accent); color: var(--accent); }

.chip-picker .dropdown { position: relative; }
.chip-picker .dropdown .menu { position: absolute; top: 100%; left: 0; margin-top: 4px;
  background: var(--card); border: 1px solid var(--border); border-radius: 6px; min-width: 240px;
  max-height: 280px; overflow-y: auto; box-shadow: 0 8px 20px rgba(0,0,0,0.4); z-index: 10; padding: 4px; }
.chip-picker .dropdown .menu input.search { width: 100%; background: var(--col); border: 1px solid var(--border);
  color: var(--text); padding: 6px 10px; border-radius: 4px; font: inherit; margin-bottom: 4px; outline: none; }
.chip-picker .dropdown .menu .opt { padding: 6px 10px; cursor: pointer; border-radius: 4px;
  font-size: 12px; display: flex; align-items: center; gap: 8px; }
.chip-picker .dropdown .menu .opt:hover { background: var(--col); }
.chip-picker .dropdown .menu .opt.selected { background: rgba(99,102,241,0.15); color: var(--accent); }
.chip-picker .dropdown .menu .empty { padding: 10px; color: var(--muted); font-size: 12px; text-align: center; }

.state-toggle { display: inline-flex; background: var(--col); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.state-toggle button { background: transparent; border: none; color: var(--muted); padding: 6px 12px;
  cursor: pointer; font: inherit; font-size: 12px; }
.state-toggle button.active[data-state="opened"] { background: var(--green); color: white; }
.state-toggle button.active[data-state="closed"] { background: var(--gray); color: white; }

.ext-link { color: var(--muted); text-decoration: none; font-size: 12px; margin-top: auto; padding-top: 10px;
  border-top: 1px solid var(--border); }
.ext-link:hover { color: var(--accent); }

.modal-f { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.modal-f .spacer { flex: 1; }
.modal-f .hint { color: var(--muted); font-size: 12px; }
.btn-primary { background: var(--accent); color: white; border: 1px solid var(--accent);
  padding: 7px 16px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost { background: transparent; color: var(--text); border: 1px solid var(--border);
  padding: 7px 14px; border-radius: 6px; cursor: pointer; font: inherit; }
.btn-ghost:hover { border-color: var(--accent); color: var(--accent); }

@media (max-width: 720px) {
  .modal-body { grid-template-columns: 1fr; }
  .modal-body .m-side { border-left: none; border-top: 1px solid var(--border); }
}
`

const BOARD_JS = `
'use strict';
const state = {
  boards: [], current: null, items: {},
  filter: { q: '', assignee: '', label: '', milestone: '' },
  // Per-board caches — members + milestones + known labels.
  meta: { members: [], milestones: [], labels: [] },
  modal: { mode: null, id: null, original: null, draft: null }
};

function csrfHeaders(extra) {
  return Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'agentx-board' }, extra || {});
}
function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = kind === 'ok' ? 'var(--green)' : 'var(--red)';
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 4000);
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
  state.meta = { members: [], milestones: [], labels: [] };
  renderColumns();
  populateFilters();
  await loadItems();
  // Fetch members + milestones in the background for pickers.
  loadMeta();
}

async function loadMeta() {
  if (!state.current) return;
  try {
    const [mem, ms] = await Promise.all([
      fetch(\`/api/boards/\${state.current.id}/members\`).then(r => r.ok ? r.json() : []),
      fetch(\`/api/boards/\${state.current.id}/milestones\`).then(r => r.ok ? r.json() : []),
    ]);
    state.meta.members = mem;
    state.meta.milestones = ms;
    state.meta.labels = collectKnownLabels();
  } catch (e) { /* non-fatal */ }
}

function collectKnownLabels() {
  const set = new Set();
  for (const list of Object.values(state.items)) for (const i of list) {
    for (const l of (i.labels || [])) set.add(l);
  }
  return [...set].sort();
}

function populateFilters() {
  if (!state.current) return;
  const labelsEl = document.getElementById('filterLabels');
  labelsEl.innerHTML = '';
  for (const lbl of state.current.labels || []) {
    const chip = document.createElement('span');
    chip.className = 'label';
    chip.style.cursor = 'pointer';
    chip.style.background = lbl.color || labelColor(lbl.name);
    chip.style.color = pickTextColor(lbl.color);
    chip.textContent = lbl.name;
    chip.onclick = () => {
      state.filter.label = state.filter.label === lbl.name ? '' : lbl.name;
      renderChipStates(); loadItems();
    };
    labelsEl.appendChild(chip);
  }
}
function renderChipStates() {
  document.querySelectorAll('#filterLabels .label').forEach(chip => {
    chip.style.opacity = (state.filter.label && chip.textContent !== state.filter.label) ? '0.35' : '1';
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
    const canAdd = col.kind !== 'closed';
    section.innerHTML = \`
      <div class="accent" style="background:\${col.accent || 'var(--gray)'}"></div>
      <header class="col-h">
        <h3>\${escapeHtml(col.title)}</h3>
        <span class="count">0</span>
        \${canAdd ? \`<button class="add" data-col-id="\${col.id}" title="New issue in this column">+</button>\` : ''}
      </header>
      <div class="stack" data-col-id="\${col.id}"></div>
    \`;
    main.appendChild(section);
  }
  document.querySelectorAll('.col .add').forEach(btn => {
    btn.onclick = () => openCreateModal(btn.dataset.colId);
  });
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
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
          toast('Moved ✓', 'ok');
          updateCounts();
        } catch (e) {
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
    const empty = col.querySelector('.stack .empty');
    const real = empty ? 0 : n;
    col.querySelector('.count').textContent = real;
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
  if (state.filter.milestone) params.set('milestone', state.filter.milestone);
  try {
    const r = await fetch(\`/api/boards/\${state.current.id}/items?\${params.toString()}\`);
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    state.items = data.columns;
    paintItems();
    populateAssigneeFilter();
    populateMilestoneFilter();
    conn.className = 'conn ok'; conn.title = 'ok';
  } catch (e) {
    conn.className = 'conn err'; conn.title = 'load failed';
    toast('Load failed: ' + (e.message || 'unknown'));
  }
}

function populateAssigneeFilter() {
  const set = new Set();
  for (const list of Object.values(state.items)) for (const i of list) if (i.assignee) set.add(i.assignee);
  const sel = document.getElementById('filterAssignee');
  const current = sel.value;
  sel.innerHTML = '<option value="">All assignees</option>';
  for (const a of [...set].sort()) {
    const o = document.createElement('option'); o.value = a; o.textContent = a;
    sel.appendChild(o);
  }
  sel.value = current;
}
function populateMilestoneFilter() {
  const set = new Set();
  for (const list of Object.values(state.items)) for (const i of list) if (i.milestone) set.add(i.milestone);
  const sel = document.getElementById('filterMilestone');
  const current = sel.value;
  sel.innerHTML = '<option value="">Any milestone</option>';
  for (const m of [...set].sort()) {
    const o = document.createElement('option'); o.value = m; o.textContent = m;
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
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Empty';
      stack.appendChild(empty);
    } else {
      for (const item of list) stack.appendChild(renderCard(item, col));
    }
  }
  updateCounts();
}

function renderCard(item, col) {
  const card = document.createElement('div');
  card.className = 'card' + (item.state === 'closed' ? ' closed' : '');
  card.dataset.id = item.id;
  const iid = item.id.split(':').slice(-1)[0];

  // Filter out Status::* scoped labels from display (represented by the column).
  const details = (item.labelDetails || (item.labels || []).map(n => ({ name: n })))
    .filter(l => !/^Status::/i.test(l.name));
  const labelChips = details.slice(0, 5).map(l => {
    const bg = l.color || labelColor(l.name);
    const fg = l.text_color || pickTextColor(bg);
    return \`<span class="label" title="\${escapeHtml(l.name)}" style="background:\${bg};color:\${fg}">\${escapeHtml(l.name)}</span>\`;
  }).join('');

  const assignees = (item.assignees && item.assignees.length)
    ? item.assignees
    : (item.assignee ? [{ username: item.assignee }] : []);
  const avatarStack = assignees.length
    ? \`<span class="avatar-stack">\${assignees.slice(0, 3).map(renderAvatar).join('')}</span>\`
    : \`<span class="avatar unassigned" title="unassigned">?</span>\`;

  const milestone = item.milestone ? \`<span class="milestone" title="Milestone">🏁 \${escapeHtml(item.milestone)}</span>\` : '';
  const est = item.estimatedSeconds ? \`<span class="est" title="Estimate">⏱ \${fmtDuration(item.estimatedSeconds)}</span>\` : '';
  const date = item.updatedAt ? \`<span class="date" title="Updated \${escapeHtml(item.updatedAt)}">\${fmtDate(item.updatedAt)}</span>\` : '';
  const link = item.url ? \`<a class="link" href="\${escapeHtml(item.url)}" target="_blank" rel="noopener" title="Open in GitLab" onclick="event.stopPropagation()">↗</a>\` : '';

  card.innerHTML = \`
    <div class="title">\${escapeHtml(item.title || '(untitled)')}</div>
    \${labelChips ? \`<div class="labels">\${labelChips}</div>\` : ''}
    <div class="foot">
      \${avatarStack}
      <span class="iid">#\${escapeHtml(iid)}</span>
      \${milestone}
      \${est}
      \${date}
      \${link}
    </div>
  \`;
  card.addEventListener('click', (e) => {
    if (e.target.closest('a,button')) return;
    openDetailModal(item.id);
  });
  return card;
}

function renderAvatar(a) {
  const name = a.name || a.username || '?';
  const img = a.avatarUrl ? \`<img src="\${escapeHtml(a.avatarUrl)}" alt="">\` : '';
  const bg = labelColor(a.username || name);
  return \`<span class="avatar" title="\${escapeHtml(name)}" style="background:\${bg}">\${img || escapeHtml(initials(name))}</span>\`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(s) {
  const parts = String(s).replace(/[_\\-\\.]+/g, ' ').trim().split(/\\s+/);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function labelColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'hsl(' + (h % 360) + ', 55%, 45%)';
}
function pickTextColor(bg) {
  if (!bg) return '#fff';
  if (bg.startsWith('#') && bg.length >= 7) {
    const r = parseInt(bg.slice(1,3),16), g = parseInt(bg.slice(3,5),16), b = parseInt(bg.slice(5,7),16);
    return (r*299 + g*587 + b*114) / 1000 >= 160 ? '#111' : '#fff';
  }
  return '#fff';
}
function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); const rem = m % 60;
  return rem ? \`\${h}h\${rem}m\` : h + 'h';
}
function fmtDate(iso) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

document.getElementById('filterSearch').oninput = debounce(e => { state.filter.q = e.target.value; loadItems(); }, 250);
document.getElementById('filterAssignee').onchange = e => { state.filter.assignee = e.target.value; loadItems(); };
document.getElementById('filterMilestone').onchange = e => { state.filter.milestone = e.target.value; loadItems(); };
document.getElementById('refreshBtn').onclick = () => loadItems();
window.addEventListener('keydown', (e) => { if (e.key === 'r' && !e.target.matches('input,select,textarea')) loadItems(); });

loadBoards().catch(e => toast('Init failed: ' + e.message));
`
