import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { appendFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"
import type { DaemonConfig } from "./config"
import type { BoardConfig, BoardColumn } from "@/boards/config"
import { deriveStage, transitionDiff } from "@/boards/config"
import type { WorkSource, WorkItem } from "@/business/work-pool"
import { GitLabWorkSource } from "@/business/work-pool"
import { SORTABLE_JS } from "./vendor/sortable"
import { UI_LABELS, GLOSSARY } from "./ui-labels"
import { handleWizardGet, handleWizardPost, wizardState } from "./setup-wizard"

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
    if (boards.length === 0) {
      console.log(`\n  Live dashboard: http://${displayHost}:${port}\n`)
      console.log("  (no boards configured — '/' serves the live view; add a board with 'agentx board add')")
    } else {
      console.log(`\n  Kanban dashboard: http://${displayHost}:${port}\n`)
      console.log(`  Boards: ${boards.map((b) => b.id).join(", ")}`)
    }
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
    // Routing priority:
    //   1. No agents yet → send operator to the setup wizard.
    //   2. Agents exist but no boards → live view.
    //   3. Boards configured → Kanban landing page.
    const wz = wizardState()
    if (!wz.configExists || wz.agentCount === 0) {
      res.writeHead(302, { Location: "/setup" })
      res.end()
      return
    }
    const html = ctx.boards.length === 0 ? renderLiveHtml() : renderBoardHtml()
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(html)
    return
  }
  if (method === "GET" && path === "/live") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderLiveHtml())
    return
  }
  if (method === "GET" && path === "/glossary") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderGlossaryHtml())
    return
  }

  // Setup wizard — form-driven first-run experience for non-technical operators.
  if (method === "GET" && path === "/setup") {
    handleWizardGet(req, res)
    return
  }
  if (method === "POST" && path === "/api/setup") {
    await handleWizardPost(req, res)
    return
  }
  if (method === "GET" && path === "/sortable.min.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" })
    res.end(SORTABLE_JS)
    return
  }

  // Live mesh view endpoints (JSON snapshot + SSE push every 2s)
  if (method === "GET" && path === "/api/live") {
    try {
      const snap = await buildLiveSnapshot(ctx.config)
      sendJson(res, 200, snap)
    } catch (e: any) { sendJson(res, 502, { error: e.message }) }
    return
  }
  if (method === "GET" && path === "/api/live/stream") {
    startLiveStream(req, res, ctx.config)
    return
  }

  // Cross-node SSE proxy for a single running task. Browser stays on
  // the dashboard origin; we connect back to the originating daemon URL.
  // GET /api/task/stream?node=<daemonUrl>&agent=<id>&task=<tid>
  if (method === "GET" && path === "/api/task/stream") {
    const u = new URL(req.url || "/", "http://localhost")
    const nodeUrl = u.searchParams.get("node")
    const agentId = u.searchParams.get("agent")
    const taskId = u.searchParams.get("task")
    if (!nodeUrl || !agentId || !taskId) {
      sendJson(res, 400, { error: "node, agent, task query params required" })
      return
    }
    await proxyTaskStream(req, res, ctx, nodeUrl, agentId, taskId)
    return
  }

  // Cross-node JSON proxy for the persisted task history (Recent Activities panel).
  // GET /api/task/history?node=<url>&agent=<id>&limit=N      → list
  // GET /api/task/history?node=<url>&agent=<id>&task=<tid>   → single record
  if (method === "GET" && path === "/api/task/history") {
    const u = new URL(req.url || "/", "http://localhost")
    const nodeUrl = u.searchParams.get("node")
    const agentId = u.searchParams.get("agent")
    const taskId = u.searchParams.get("task")
    const limit = u.searchParams.get("limit") || "50"
    if (!nodeUrl || !agentId) {
      sendJson(res, 400, { error: "node and agent query params required" })
      return
    }
    await proxyTaskHistory(res, ctx, nodeUrl, agentId, taskId, limit)
    return
  }

  // Agent roster (proxy to configured daemon) — used by draft-agent picker.
  if (method === "GET" && path === "/api/agents") {
    try {
      const headers: Record<string, string> = {}
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const r = await fetch(ctx.config.dashboard.daemonUrl.replace(/\/+$/, "") + "/agents", { headers })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const list = await r.json()
      sendJson(res, 200, list)
    } catch (e: any) { sendJson(res, 502, { error: e.message || "agents fetch failed" }) }
    return
  }

  // AI-assisted issue draft — proxies to daemon /task with convention-aware prompt.
  if (method === "POST" && path === "/api/draft") {
    const body = await readJson(req)
    try {
      const drafted = await draftIssue(ctx.config, body)
      sendJson(res, 200, drafted)
    } catch (e: any) { sendJson(res, 502, { error: e.message || "draft failed" }) }
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
    const [, boardId, rawItemId] = moveMatch
    const itemId = decodeURIComponent(rawItemId)
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
    const [, boardId, rawItemId] = itemOpMatch
    const itemId = rawItemId ? decodeURIComponent(rawItemId) : undefined
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

// --- Live mesh snapshot ---
//
// Aggregates /agents + /mesh from the configured primary daemon, then fans out
// to each mesh peer to collect their /agents (running tasks included) so the
// dashboard can show a single cross-node view of what every agent is doing.

interface NodeLive {
  id: string
  name: string
  url: string
  reachable: boolean
  error?: string
  uptimeSec?: number
  agents: Array<{
    id: string
    name: string
    tier: string
    model?: string
    active: number
    total: number
    errors: number
    lastActive?: string
    lastSummary?: { text: string; at: string; ok: boolean }
    runningTasks?: Array<{
      id: string
      messagePreview: string
      channel: string
      chatId?: string
      sender?: string
      startedAt: string
    }>
  }>
  /** Today's per-agent usage rollup pulled from /health. */
  usage?: {
    date: string
    agents: Record<string, {
      tasks: number
      totalDuration: number
      errors: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreateTokens: number
      byChannel?: Record<string, { tasks: number }>
    }>
  }
}
interface LiveSnapshot {
  ts: string
  nodes: NodeLive[]
}

async function fetchDaemonAgents(url: string, token?: string, signal?: AbortSignal): Promise<NodeLive> {
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`
  const base: NodeLive = { id: url, name: url, url, reachable: false, agents: [] }
  try {
    const [healthRes, agentsRes, meshRes] = await Promise.all([
      fetch(url + "/health", { headers, signal }).catch(() => null),
      fetch(url + "/agents", { headers, signal }).catch(() => null),
      fetch(url + "/mesh", { headers, signal }).catch(() => null),
    ])
    if (!agentsRes || !agentsRes.ok) {
      base.error = agentsRes ? `HTTP ${agentsRes.status}` : "unreachable"
      return base
    }
    const agents: any[] = await agentsRes.json()
    base.agents = agents.map((a) => ({
      id: a.id, name: a.name, tier: a.tier, model: a.model,
      active: a.active || 0, total: a.total || 0, errors: a.errors || 0,
      lastActive: a.lastActive,
      lastSummary: a.lastSummary,
      runningTasks: Array.isArray(a.runningTasks) ? a.runningTasks : [],
    }))
    if (healthRes && healthRes.ok) {
      const h: any = await healthRes.json()
      base.uptimeSec = h.uptime
      base.name = h.node?.name || h.node?.id || url
      base.id = h.node?.id || url
      // /health already embeds today's usage rollup — reuse it so the
      // dashboard doesn't need a separate /usage call per node.
      if (h.usage) base.usage = h.usage
    }
    base.reachable = true
    // Expose mesh peer info for discovery, but the caller does fan-out separately.
    ;(base as any)._peers = Array.isArray(meshRes && await meshResSafe(meshRes)) ? (base as any)._peers : undefined
  } catch (e: any) {
    base.error = e.message || String(e)
  }
  return base
}

// Tiny helper to double-json a Response only once.
let _meshJsonCache = new WeakMap<Response, any>()
async function meshResSafe(r: Response): Promise<any> {
  if (_meshJsonCache.has(r)) return _meshJsonCache.get(r)
  try { const j = r.ok ? await r.json() : null; _meshJsonCache.set(r, j); return j } catch { return null }
}

async function fetchMeshPeers(primaryUrl: string, token?: string, signal?: AbortSignal): Promise<Array<{ url: string; name: string; token?: string }>> {
  try {
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    const r = await fetch(primaryUrl + "/mesh", { headers, signal })
    if (!r.ok) return []
    const peers: any[] = await r.json()
    return peers
      .filter((p) => p && p.peerUrl)
      .map((p) => ({ url: String(p.peerUrl).replace(/\/+$/, ""), name: p.peer || p.peerUrl }))
  } catch { return [] }
}

async function buildLiveSnapshot(daemon: DaemonConfig): Promise<LiveSnapshot> {
  const dash = daemon.dashboard
  const primaryUrl = dash.daemonUrl.replace(/\/+$/, "")
  const primaryToken = dash.token
  // Sources: primary + configured extras + auto-discovered mesh peers.
  const seen = new Map<string, { name: string; url: string; token?: string }>()
  seen.set(primaryUrl, { name: "primary", url: primaryUrl, token: primaryToken })
  for (const d of dash.daemons) {
    const key = d.url.replace(/\/+$/, "")
    if (!seen.has(key)) seen.set(key, { name: d.name, url: key, token: d.token })
  }
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), 3000)
  try {
    const meshPeers = await fetchMeshPeers(primaryUrl, primaryToken, ac.signal)
    for (const p of meshPeers) if (!seen.has(p.url)) seen.set(p.url, p)
    const nodes = await Promise.all([...seen.values()].map((d) => fetchDaemonAgents(d.url, d.token, ac.signal)))
    return { ts: new Date().toISOString(), nodes }
  } finally { clearTimeout(timeout) }
}

function startLiveStream(req: IncomingMessage, res: ServerResponse, daemon: DaemonConfig): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  })
  let closed = false
  const send = (ev: string, data: unknown) => {
    if (closed) return
    res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const tick = async () => {
    try {
      const snap = await buildLiveSnapshot(daemon)
      send("snapshot", snap)
    } catch (e: any) {
      send("error", { message: e.message })
    }
  }
  // Initial tick immediately, then every 2s.
  tick()
  const timer = setInterval(tick, 2000)
  req.on("close", () => { closed = true; clearInterval(timer); res.end() })
}

/**
 * Proxy SSE from a daemon's task-stream endpoint back to the dashboard
 * client. Whitelists the target URL against the dashboard's known nodes
 * to avoid being turned into an open SSE proxy.
 */
async function proxyTaskStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { config: DaemonConfig },
  nodeUrl: string,
  agentId: string,
  taskId: string,
): Promise<void> {
  const target = nodeUrl.replace(/\/+$/, "")
  const allowed = new Set<string>()
  allowed.add(ctx.config.dashboard.daemonUrl.replace(/\/+$/, ""))
  for (const d of ctx.config.dashboard.daemons) allowed.add(d.url.replace(/\/+$/, ""))
  // Also accept any known mesh peer URL discovered at snapshot time.
  try {
    const peers = await fetchMeshPeers(ctx.config.dashboard.daemonUrl.replace(/\/+$/, ""), ctx.config.dashboard.token)
    for (const p of peers) allowed.add(p.url.replace(/\/+$/, ""))
  } catch { /* best effort */ }
  if (!allowed.has(target)) {
    sendJson(res, 403, { error: "node not in dashboard allowlist", target })
    return
  }
  const tokenForNode =
    target === ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      ? ctx.config.dashboard.token
      : ctx.config.dashboard.daemons.find((d) => d.url.replace(/\/+$/, "") === target)?.token
  const headers: Record<string, string> = { Accept: "text/event-stream" }
  if (tokenForNode) headers["Authorization"] = `Bearer ${tokenForNode}`
  const upstreamCtl = new AbortController()
  let upstreamRes: Response
  try {
    upstreamRes = await fetch(`${target}/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}/stream`, {
      headers,
      signal: upstreamCtl.signal,
    })
  } catch (e: any) {
    sendJson(res, 502, { error: e.message || "upstream connect failed" })
    return
  }
  if (!upstreamRes.ok || !upstreamRes.body) {
    sendJson(res, upstreamRes.status || 502, { error: `upstream HTTP ${upstreamRes.status}` })
    return
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  })
  const reader = upstreamRes.body.getReader()
  const pump = async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) res.write(value)
      }
    } catch { /* upstream closed */ } finally { try { res.end() } catch { /* */ } }
  }
  pump()
  req.on("close", () => { upstreamCtl.abort(); try { res.end() } catch { /* */ } })
}

/**
 * One-shot JSON proxy for /agents/:id/tasks (list) or /agents/:id/tasks/:tid
 * (single record). Same allowlist semantics as proxyTaskStream.
 */
async function proxyTaskHistory(
  res: ServerResponse,
  ctx: { config: DaemonConfig },
  nodeUrl: string,
  agentId: string,
  taskId: string | null,
  limit: string,
): Promise<void> {
  const target = nodeUrl.replace(/\/+$/, "")
  const allowed = new Set<string>()
  allowed.add(ctx.config.dashboard.daemonUrl.replace(/\/+$/, ""))
  for (const d of ctx.config.dashboard.daemons) allowed.add(d.url.replace(/\/+$/, ""))
  try {
    const peers = await fetchMeshPeers(ctx.config.dashboard.daemonUrl.replace(/\/+$/, ""), ctx.config.dashboard.token)
    for (const p of peers) allowed.add(p.url.replace(/\/+$/, ""))
  } catch { /* */ }
  if (!allowed.has(target)) {
    sendJson(res, 403, { error: "node not in dashboard allowlist", target })
    return
  }
  const tokenForNode =
    target === ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      ? ctx.config.dashboard.token
      : ctx.config.dashboard.daemons.find((d) => d.url.replace(/\/+$/, "") === target)?.token
  const headers: Record<string, string> = { Accept: "application/json" }
  if (tokenForNode) headers["Authorization"] = `Bearer ${tokenForNode}`
  const upstreamPath = taskId
    ? `/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}`
    : `/agents/${encodeURIComponent(agentId)}/tasks?limit=${encodeURIComponent(limit)}`
  try {
    const r = await fetch(`${target}${upstreamPath}`, { headers })
    const body = await r.text()
    res.writeHead(r.status, {
      "Content-Type": r.headers.get("content-type") || "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    })
    res.end(body)
  } catch (e: any) {
    sendJson(res, 502, { error: e.message || "upstream fetch failed" })
  }
}

// --- A2A issue drafting ---
//
// Builds a convention-aware prompt, calls the configured agent on the daemon,
// and parses a strict JSON reply. The agent returns title + refined description
// + suggested labels + (optional) suggested assignee username.

const DRAFT_CONVENTIONS = `
You are helping draft a new GitLab issue. Follow these conventions strictly.

Title pattern:
  <Kind>: <page|component> – <short symptom>
Kinds: Bug, UX, Copy, Perf, A11y, Security, UI, Incident (defects)
       Feat, Enh, Deprecate (features)
       Epic, Story, Spike, Req (planning)
       Data, Env, Test, Refactor, Chore, Task, Mgmt (technical)

Title guidance:
  - Be specific about the location ("Contact page", not "frontend").
  - Use lowercase for the symptom.
  - Keep the symptom 4-7 words max, present tense.
  - Do NOT include issue IDs.

Description structure (Markdown):
  For bugs: Problem / Steps to Reproduce / Expected / Actual / Environment / Impact.
  For features/stories: User Story (As a … I want … So that …) + Acceptance Criteria bullets.
  Otherwise: concise problem statement + any relevant context.

Labels:
  - Pick ONE Role label from: Dev, Design, QA, Ops, PM, mgmt.
  - Pick ONE Kind label matching the title prefix (bug, task, ux, ui, perf, security, copy, enhancement, …).
  - Pick ONE Priority: critical, high, medium, low.
  - Pick ONE Difficulty: diff-XS, diff-S, diff-M, diff-L, diff-XL.
  - Optional Area/feature labels if clearly applicable from the known label list.

Return ONLY a single JSON object on one line — no prose, no code fences, no explanation.
Shape:
  { "title": string, "description": string, "labels": string[], "assigneeUsername": string | null, "kind": string }
If you don't have enough information to pick a label confidently, omit it rather than guessing.
`

async function draftIssue(daemon: DaemonConfig, body: any): Promise<{ title: string; description: string; labels: string[]; assigneeUsername?: string; kind?: string; raw?: string }> {
  const rough: string = (body?.rough || "").toString().trim()
  if (!rough) throw new Error("rough description required")
  const agentId: string | undefined = body?.agent || daemon.dashboard.draftAgent
  if (!agentId) throw new Error("no draft agent configured (set dashboard.draftAgent or pass agent in body)")

  const boardCtx: {
    boardName?: string; primaryLabel?: string; project?: string;
    knownLabels?: string[]; members?: string[]; columnLabel?: string
  } = body?.context || {}

  const userPrompt = [
    `Rough description from the user:`,
    `"""`,
    rough,
    `"""`,
    ``,
    `Board: ${boardCtx.boardName || "(unspecified)"}`,
    boardCtx.primaryLabel ? `Primary board label (include in labels): ${boardCtx.primaryLabel}` : "",
    boardCtx.columnLabel ? `Target column label (include in labels): ${boardCtx.columnLabel}` : "",
    boardCtx.project ? `GitLab project: ${boardCtx.project}` : "",
    boardCtx.knownLabels?.length ? `Known labels in this project (prefer picking from these when they fit):\n- ${boardCtx.knownLabels.slice(0, 60).join("\n- ")}` : "",
    boardCtx.members?.length ? `Possible assignees (GitLab usernames): ${boardCtx.members.slice(0, 20).join(", ")}` : "",
    ``,
    `Produce the JSON draft now.`,
  ].filter(Boolean).join("\n")

  const url = daemon.dashboard.daemonUrl.replace(/\/+$/, "") + "/task"
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (daemon.dashboard.token) headers["Authorization"] = `Bearer ${daemon.dashboard.token}`

  const r = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({
      agent: agentId,
      message: userPrompt,
      context: { channel: "a2a", sender: "board-dashboard", systemPrompt: DRAFT_CONVENTIONS },
    }),
  })
  if (!r.ok) throw new Error(`daemon /task HTTP ${r.status}: ${await r.text().catch(() => "")}`)
  const data: any = await r.json()
  if (data.error) throw new Error(String(data.error))
  const content: string = (data.content || "").toString()

  // Agent may wrap JSON in ```json fences or prose; extract the first balanced {...}.
  const parsed = extractJson(content)
  if (!parsed || typeof parsed.title !== "string") {
    throw new Error("agent did not return a valid JSON draft. Raw: " + content.slice(0, 400))
  }
  const labels: string[] = Array.isArray(parsed.labels) ? parsed.labels.filter((x: any) => typeof x === "string") : []
  // Inject primary/column labels if the agent missed them.
  if (boardCtx.primaryLabel && !labels.includes(boardCtx.primaryLabel)) labels.unshift(boardCtx.primaryLabel)
  if (boardCtx.columnLabel && !labels.includes(boardCtx.columnLabel)) labels.unshift(boardCtx.columnLabel)
  return {
    title: parsed.title.trim(),
    description: (parsed.description || "").toString(),
    labels,
    assigneeUsername: typeof parsed.assigneeUsername === "string" ? parsed.assigneeUsername : undefined,
    kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
    raw: content,
  }
}

function extractJson(text: string): any {
  if (!text) return null
  // Try direct parse
  try { return JSON.parse(text) } catch { /* fallthrough */ }
  // Strip code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1]) } catch { /* fallthrough */ } }
  // Find first balanced {...}
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === "{") depth++
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)) } catch { return null } } }
  }
  return null
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
  <a href="/live" class="link" title="Live mesh view (L)">◎ Live</a>
  <button id="activityBtn" title="Agent activity (a)">◉ Activity</button>
  <button id="newIssueBtn" title="New issue">+ New</button>
  <button id="refreshBtn" title="Refresh (r)">↻</button>
  <div id="conn" class="conn ok" title="ready">●</div>
</header>
<aside id="activity-panel" class="activity-panel hidden" aria-hidden="true">
  <header>
    <h2>Agent Activity</h2>
    <span id="activity-source" class="source"></span>
    <button id="activity-close" class="x" title="Close">✕</button>
  </header>
  <div id="activity-body">Loading…</div>
  <footer id="activity-events" class="events"></footer>
</aside>
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
        <div id="m-draft" class="draft-box" hidden>
          <label class="fld">
            <span>✨ Describe the issue (the agent will draft a proper title + description)</span>
            <textarea id="m-rough" rows="3" placeholder="e.g. when I upload a CSV over 500 rows in Receiving Records the import silently fails"></textarea>
          </label>
          <div class="draft-row">
            <select id="m-draft-agent" title="Drafting agent"><option value="">Agent…</option></select>
            <button id="m-draft-go" class="btn-primary" type="button">✨ Draft</button>
            <span id="m-draft-hint" class="hint"></span>
          </div>
        </div>
        <div class="fld">
          <div class="desc-head">
            <span>Description</span>
            <div class="desc-tabs" role="tablist">
              <button type="button" class="desc-tab" data-tab="preview" role="tab">Preview</button>
              <button type="button" class="desc-tab active" data-tab="write" role="tab">Write</button>
            </div>
          </div>
          <div id="m-desc-preview" class="desc-preview" hidden></div>
          <textarea id="m-desc" rows="10" placeholder="Markdown supported (GitLab flavored)"></textarea>
        </div>
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

// --- Live full-screen page (/live) ---

function renderLiveHtml(): string {
  const labelsScript = `<script>window.UI_LABELS = ${JSON.stringify(UI_LABELS)};</script>`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlServer(UI_LABELS.brand)} — ${escapeHtmlServer(UI_LABELS.subtitle)}</title>
<style>${LIVE_CSS}</style>
</head>
<body>
<header>
  <div class="brand">${escapeHtmlServer(UI_LABELS.brand)} <span class="sub">· ${escapeHtmlServer(UI_LABELS.subtitle)}</span></div>
  <div id="summary" class="summary"></div>
  <div class="spacer"></div>
  <a href="/glossary" class="link" title="What do the terms mean?">? Glossary</a>
  <a href="/" class="link">← Boards</a>
  <span id="ts" class="ts" title="Last update"></span>
  <span id="conn" class="conn ok" title="connected">●</span>
</header>
<section id="today-strip" class="today-strip hidden" aria-label="Today's activity"></section>
<main id="grid"></main>
<aside id="history-panel" class="history-panel hidden" aria-hidden="true">
  <header>
    <h2 id="history-panel-title">${escapeHtmlServer(UI_LABELS.historyPanelTitle)}</h2>
    <span class="history-panel-source" id="history-panel-source"></span>
    <button class="history-panel-close" id="history-panel-close" aria-label="Close">×</button>
  </header>
  <div id="history-panel-body" class="history-panel-body"></div>
</aside>
<div id="task-modal" class="task-modal hidden" aria-hidden="true">
  <div class="task-modal-backdrop"></div>
  <div class="task-modal-card" role="dialog" aria-modal="true">
    <header>
      <span class="task-modal-channel" id="task-modal-channel"></span>
      <h2 id="task-modal-title">${escapeHtmlServer(UI_LABELS.taskModalTitle)}</h2>
      <span class="task-modal-status" id="task-modal-status">${escapeHtmlServer(UI_LABELS.taskModalConnecting)}</span>
      <button class="task-modal-close" id="task-modal-close" aria-label="Close">×</button>
    </header>
    <pre id="task-modal-output" class="task-modal-output"></pre>
  </div>
</div>
${labelsScript}
<script>${LIVE_JS}</script>
</body>
</html>`
}

/** Minimal HTML escaper for server-rendered label text. */
function escapeHtmlServer(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

/** /glossary — plain-English definitions of the terms that appear in the dashboard. */
function renderGlossaryHtml(): string {
  const items = GLOSSARY.map((g) => {
    const alias = g.alias ? `<span class="alias" title="Schema key">${escapeHtmlServer(g.alias)}</span>` : ""
    return `<article class="term"><h3>${escapeHtmlServer(g.term)}${alias}</h3><p>${escapeHtmlServer(g.definition)}</p></article>`
  }).join("")
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlServer(UI_LABELS.brand)} — Glossary</title>
<style>
:root { --bg:#0b0d14; --card:#151823; --border:#2a2d3a; --text:#e6e8ef; --muted:#8b8fa3; --accent:#6366f1; }
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:14px;padding:14px 22px;background:#10131c;border-bottom:1px solid var(--border);position:sticky;top:0}
.brand{font-weight:600;color:var(--accent);font-size:15px}
.sub{color:var(--muted);font-weight:500}
.spacer{flex:1}
a.link{color:var(--muted);text-decoration:none;font-size:13px;padding:4px 10px;border:1px solid var(--border);border-radius:6px}
a.link:hover{color:var(--accent);border-color:var(--accent)}
main{max-width:720px;margin:0 auto;padding:28px 22px 60px}
h1{font-size:22px;margin:0 0 6px}
.lead{color:var(--muted);margin:0 0 26px}
article.term{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin:12px 0}
article.term h3{font-size:15px;margin:0 0 6px;display:flex;align-items:center;gap:10px}
article.term .alias{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);background:rgba(99,102,241,0.14);padding:2px 7px;border-radius:3px;font-weight:500;font-family:ui-monospace,monospace}
article.term p{margin:0;color:var(--text)}
</style>
</head>
<body>
<header>
  <div class="brand">${escapeHtmlServer(UI_LABELS.brand)} <span class="sub">· Glossary</span></div>
  <div class="spacer"></div>
  <a href="/live" class="link">← Back to dashboard</a>
</header>
<main>
  <h1>Plain-English glossary</h1>
  <p class="lead">What the terms on the dashboard mean. Schema keys (shown in the pill on the right of each term) are what you'd write in <code>agentx.json</code> — the dashboard just relabels them for readability.</p>
  ${items}
</main>
</body>
</html>`
}

const LIVE_CSS = `
:root {
  --bg: #0b0d14; --card: #151823; --node: #1a1d29; --border: #2a2d3a;
  --text: #e6e8ef; --muted: #8b8fa3; --accent: #6366f1;
  --green: #22c55e; --yellow: #f59e0b; --red: #ef4444; --blue: #3b82f6; --gray: #6b7280;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 14px; padding: 10px 18px;
  background: #10131c; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
header .brand { font-weight: 600; color: var(--accent); font-size: 15px; }
header .brand .sub { color: var(--muted); font-weight: 500; }
header .summary { display: flex; gap: 16px; color: var(--muted); font-size: 12px; }
header .summary b { color: var(--text); }
header .spacer { flex: 1; }
header .link { color: var(--muted); text-decoration: none; font-size: 13px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; }
header .link:hover { color: var(--accent); border-color: var(--accent); }
header .ts { color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
header .conn { font-size: 14px; }
header .conn.ok { color: var(--green); }
header .conn.warn { color: var(--yellow); }
header .conn.err { color: var(--red); }

main#grid { padding: 16px; display: flex; flex-direction: column; gap: 16px; }

.today-strip { display: flex; flex-wrap: wrap; gap: 18px; padding: 12px 20px;
  background: linear-gradient(90deg, rgba(99,102,241,0.12), rgba(34,197,94,0.08));
  border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.today-strip.hidden { display: none; }
.today-strip .lbl { text-transform: uppercase; letter-spacing: 0.5px; font-size: 10px; color: var(--muted); margin-right: 4px; }
.today-strip b { color: var(--text); font-weight: 600; font-size: 13px; }
.today-strip .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
  background: rgba(21,24,35,0.6); border: 1px solid var(--border); border-radius: 20px; }
.today-strip .ch-breakdown { color: var(--muted); font-size: 11px; }
.today-strip .ch-breakdown .name { color: var(--text); font-weight: 500; }

.agent .summary { font-size: 11px; color: var(--muted); padding: 6px 8px; border-radius: 4px;
  background: rgba(255,255,255,0.02); border-left: 2px solid var(--accent);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.agent .summary.fail { border-left-color: var(--red); }
.agent .summary .when { color: var(--muted); font-size: 10px; font-family: ui-monospace, monospace; }

.node { background: var(--node); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.node > header { background: transparent; position: static; padding: 12px 16px; border-bottom: 1px solid var(--border); gap: 10px; }
.node .name { font-weight: 600; font-size: 14px; }
.node .url { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; }
.node .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
  padding: 2px 7px; border-radius: 10px; background: rgba(99,102,241,0.2); color: #c5c8d6; }
.node .tag.down { background: rgba(239,68,68,0.25); color: #fca5a5; }
.node .tag.up { background: rgba(34,197,94,0.2); color: #86efac; }
.node .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 10px; padding: 12px 14px; }

.agent { background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.2s; }
.agent.busy { border-color: var(--green); box-shadow: 0 0 0 1px rgba(34,197,94,0.3); }
.agent.errored { border-color: var(--red); }
.agent > .top { display: flex; align-items: center; gap: 8px; }
.agent .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gray); flex-shrink: 0; }
.agent.busy .dot { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 1.2s ease-in-out infinite; }
.agent.errored .dot { background: var(--red); }
.agent .name { font-weight: 600; font-size: 13px; flex: 1; }
.agent .tier { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; }
.agent .meta { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--muted); flex-wrap: wrap; }
.agent .model { font-family: ui-monospace, monospace; font-size: 10px; color: var(--accent);
  background: rgba(99,102,241,0.12); padding: 1px 7px; border-radius: 3px; letter-spacing: 0.2px; }
.agent .last { font-size: 10px; color: var(--muted); }
.agent .last.muted { font-style: italic; opacity: 0.7; }
.agent .stats { display: flex; gap: 10px; font-size: 11px; color: var(--muted); }
.agent .stats b { color: var(--text); font-weight: 600; }
.agent .stats .err b { color: var(--red); }
.agent .tasks { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }
.agent .task { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.agent .task .channel { background: rgba(99,102,241,0.18); color: var(--accent);
  font-size: 9px; text-transform: uppercase; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.5px; }
.agent .task .elapsed { color: var(--muted); font-family: ui-monospace, monospace; font-size: 10px; }
.agent .task .preview { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.agent .task .preview.clickable { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-decoration-color: var(--muted); text-underline-offset: 3px; }
.agent .task .preview.clickable:hover { color: var(--accent); text-decoration-color: var(--accent); }
.agent .idle { color: var(--muted); font-size: 11px; font-style: italic; }
.agent .recent-link { display: inline-block; margin-top: 4px; font-size: 11px; color: var(--muted);
  text-decoration: none; align-self: flex-start; }
.agent .recent-link:hover { color: var(--accent); }

@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }

.history-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 360px;
  background: var(--node); border-left: 1px solid var(--border); z-index: 900;
  display: flex; flex-direction: column; box-shadow: -8px 0 24px rgba(0,0,0,0.4);
  transition: transform 0.2s ease; }
.history-panel.hidden { transform: translateX(100%); pointer-events: none; }
.history-panel > header { display: flex; align-items: center; gap: 10px; padding: 12px 14px;
  background: #10131c; border-bottom: 1px solid var(--border); }
.history-panel > header h2 { margin: 0; font-size: 13px; font-weight: 600; flex: 1; color: var(--text); }
.history-panel-source { font-size: 10px; color: var(--muted); font-family: ui-monospace, monospace; }
.history-panel-close { background: transparent; border: none; color: var(--muted); font-size: 20px;
  cursor: pointer; padding: 0 6px; line-height: 1; }
.history-panel-close:hover { color: var(--text); }
.history-panel-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.history-item { background: var(--card); border: 1px solid var(--border); border-radius: 6px;
  padding: 9px 11px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.history-item:hover { border-color: var(--accent); }
.history-item .top { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--muted); }
.history-item .top .channel { background: rgba(99,102,241,0.18); color: var(--accent);
  font-size: 9px; text-transform: uppercase; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.5px; }
.history-item .top .ok { color: var(--green); }
.history-item .top .err { color: var(--red); }
.history-item .top .when { margin-left: auto; font-family: ui-monospace, monospace; }
.history-item .preview { color: var(--text); font-size: 12px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.history-item .duration { font-size: 10px; color: var(--muted); font-family: ui-monospace, monospace; }
.history-empty { color: var(--muted); font-size: 12px; text-align: center; padding: 20px 8px; font-style: italic; }

.task-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; }
.task-modal.hidden { display: none; }
.task-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.55); }
.task-modal-card { position: relative; width: min(900px, 92vw); height: min(620px, 80vh);
  background: var(--node); border: 1px solid var(--border); border-radius: 10px;
  display: flex; flex-direction: column; box-shadow: 0 18px 48px rgba(0,0,0,0.5); overflow: hidden; }
.task-modal-card > header { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  border-bottom: 1px solid var(--border); background: #10131c; }
.task-modal-card > header h2 { margin: 0; font-size: 13px; font-weight: 600; flex: 1;
  color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-modal-channel { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px;
  background: rgba(99,102,241,0.18); color: var(--accent); padding: 2px 7px; border-radius: 3px; }
.task-modal-status { font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; }
.task-modal-status.live { color: var(--green); }
.task-modal-status.done { color: var(--accent); }
.task-modal-status.err { color: var(--red); }
.task-modal-close { background: transparent; border: none; color: var(--muted); font-size: 22px;
  cursor: pointer; padding: 0 6px; line-height: 1; }
.task-modal-close:hover { color: var(--text); }
.task-modal-output { margin: 0; flex: 1; overflow: auto; padding: 14px 16px;
  background: #0a0c12; color: var(--text); font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
  white-space: pre-wrap; word-break: break-word; }
`

const LIVE_JS = `
'use strict';

const ui = { nodes: new Map(), summary: { nodes: 0, agents: 0, busy: 0, errors: 0 } };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function fmtElapsed(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000); if (s < 60) return s + 's';
  const m = Math.floor(s / 60); const rs = s % 60;
  if (m < 60) return m + 'm ' + (rs < 10 ? '0' : '') + rs + 's';
  const h = Math.floor(m / 60); const rm = m % 60;
  return h + 'h ' + (rm < 10 ? '0' : '') + rm + 'm';
}

function render(snapshot) {
  const grid = document.getElementById('grid');
  const nowTs = new Date(snapshot.ts).toLocaleTimeString();
  document.getElementById('ts').textContent = nowTs;
  const summary = { nodes: snapshot.nodes.length, reachable: 0, agents: 0, busy: 0, errors: 0 };
  grid.innerHTML = '';
  for (const node of snapshot.nodes) {
    if (node.reachable) summary.reachable++;
    summary.agents += node.agents.length;
    for (const a of node.agents) {
      const busy = (a.runningTasks && a.runningTasks.length > 0) || (a.active || 0) > 0;
      if (busy) summary.busy++;
      summary.errors += (a.errors || 0);
    }
    grid.appendChild(renderNode(node));
  }
  const L = window.UI_LABELS || {};
  document.getElementById('summary').innerHTML =
    '<span><b>' + summary.reachable + '/' + summary.nodes + '</b> ' + escapeHtml(L.nodes || 'machines') + '</span>' +
    '<span><b>' + summary.agents + '</b> ' + escapeHtml(L.agentsCount || 'agents') + '</span>' +
    '<span><b>' + summary.busy + '</b> ' + escapeHtml(L.activeNow || 'handling now') + '</span>' +
    '<span><b>' + summary.errors + '</b> ' + escapeHtml(L.errorsCount || 'failed') + '</span>';

  renderTodayStrip(snapshot);
}

// Aggregate per-agent usage from every node, then paint the "Today" strip.
// Zero-cost if the snapshot has no usage data (e.g. pre-1.0 daemons).
function renderTodayStrip(snapshot) {
  const strip = document.getElementById('today-strip');
  if (!strip) return;
  let tasks = 0, durationMs = 0, errors = 0, inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
  const byChannel = {};
  let hasData = false;
  for (const node of snapshot.nodes) {
    if (!node.usage || !node.usage.agents) continue;
    hasData = true;
    for (const agentId of Object.keys(node.usage.agents)) {
      const u = node.usage.agents[agentId];
      tasks += u.tasks || 0;
      durationMs += u.totalDuration || 0;
      errors += u.errors || 0;
      inputTokens += u.inputTokens || 0;
      outputTokens += u.outputTokens || 0;
      cacheRead += u.cacheReadTokens || 0;
      cacheCreate += u.cacheCreateTokens || 0;
      if (u.byChannel) {
        for (const ch of Object.keys(u.byChannel)) {
          byChannel[ch] = (byChannel[ch] || 0) + (u.byChannel[ch].tasks || 0);
        }
      }
    }
  }
  if (!hasData || tasks === 0) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  const topChannels = Object.keys(byChannel)
    .sort((a, b) => byChannel[b] - byChannel[a])
    .slice(0, 4)
    .map(ch => '<span class="name">' + escapeHtml(ch) + '</span> (' + byChannel[ch] + ')')
    .join(' · ');
  const durationStr = fmtDuration(durationMs);
  const tokensStr = fmtTokens(inputTokens + outputTokens + cacheRead + cacheCreate);
  strip.innerHTML =
    '<span class="chip"><span class="lbl">Today</span><b>' + tasks + '</b> tasks</span>' +
    '<span class="chip"><span class="lbl">Time</span><b>' + escapeHtml(durationStr) + '</b></span>' +
    '<span class="chip"><span class="lbl">Tokens</span><b>' + escapeHtml(tokensStr) + '</b></span>' +
    (errors > 0 ? '<span class="chip" style="border-color:var(--red);color:var(--red)"><span class="lbl" style="color:var(--red)">Failed</span><b style="color:var(--red)">' + errors + '</b></span>' : '') +
    (topChannels ? '<span class="ch-breakdown">' + topChannels + '</span>' : '');
}

function fmtDuration(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + 'h ' + (rm < 10 ? '0' : '') + rm + 'm';
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(2).replace(/\\.00$/, '') + 'M';
}

function renderNode(node) {
  const sec = document.createElement('section'); sec.className = 'node';
  const tag = node.reachable
    ? '<span class="tag up">online · ' + (node.uptimeSec ? Math.round(node.uptimeSec / 60) + 'm' : '—') + '</span>'
    : '<span class="tag down">offline — ' + escapeHtml(node.error || 'unreachable') + '</span>';
  sec.innerHTML = '<header><div class="name">' + escapeHtml(node.name) + '</div>' +
    '<div class="url">' + escapeHtml(node.url) + '</div>' +
    tag + '</header><div class="grid"></div>';
  const g = sec.querySelector('.grid');
  if (!node.reachable || node.agents.length === 0) {
    const empty = document.createElement('div'); empty.style.color = 'var(--muted)'; empty.style.padding = '8px 4px';
    const L = window.UI_LABELS || {};
    empty.textContent = node.reachable ? (L.noAgentsOnNode || 'No agents on this node.') : (L.unreachable || 'Unreachable.');
    g.appendChild(empty);
  } else {
    for (const a of node.agents) g.appendChild(renderAgent(a, node));
  }
  return sec;
}

function renderAgent(a, node) {
  const card = document.createElement('div');
  const busy = (a.runningTasks && a.runningTasks.length > 0) || (a.active || 0) > 0;
  const errored = (a.errors || 0) > 0;
  card.className = 'agent' + (busy ? ' busy' : '') + (errored ? ' errored' : '');
  const nodeUrl = (node && node.url) || '';
  const tasks = (a.runningTasks || []).map(t => {
    const elapsed = fmtElapsed(Date.now() - new Date(t.startedAt).getTime());
    const hasId = !!t.id;
    const cls = 'preview' + (hasId ? ' clickable' : '');
    const dataAttrs = hasId
      ? ' data-task-id="' + escapeHtml(t.id) + '" data-agent-id="' + escapeHtml(a.id) + '" data-node-url="' + escapeHtml(nodeUrl) + '" data-channel="' + escapeHtml(t.channel || '') + '" data-agent-name="' + escapeHtml(a.name || a.id) + '"'
      : '';
    return '<div class="task">' +
      '<span class="channel">' + escapeHtml(t.channel || '—') + '</span>' +
      '<span class="' + cls + '" title="' + escapeHtml(t.messagePreview || '') + '"' + dataAttrs + '>' + escapeHtml(t.messagePreview || '(no preview)') + '</span>' +
      '<span class="elapsed">' + elapsed + '</span>' +
    '</div>';
  }).join('');
  const L = window.UI_LABELS || {};
  const stats = (L.stats) || { active: 'Active', total: 'Total', errors: 'Err' };
  const tierLabels = (L.tierLabels) || {};
  const tierDisplay = tierLabels[a.tier] || a.tier || '';
  const tasksBlock = tasks
    ? '<div class="tasks">' + tasks + '</div>'
    : (busy ? '<div class="tasks"><div class="task"><span class="elapsed">' + escapeHtml(L.runningNoPreview || 'running · no preview') + '</span></div></div>'
            : '<div class="idle">' + escapeHtml(L.idle || 'idle') + '</div>');
  const modelLabel = a.model ? '<span class="model" title="Model">' + escapeHtml(shortenModel(a.model)) + '</span>' : '';
  const lastLabel = a.lastActive
    ? '<span class="last" title="' + escapeHtml(new Date(a.lastActive).toLocaleString()) + '">last ' + escapeHtml(fmtAgo(a.lastActive)) + '</span>'
    : '<span class="last muted">' + escapeHtml(L.neverRan || 'never ran') + '</span>';
  const recentLink = nodeUrl
    ? '<a class="recent-link" href="#" data-agent-id="' + escapeHtml(a.id) + '" data-agent-name="' + escapeHtml(a.name || a.id) + '" data-node-url="' + escapeHtml(nodeUrl) + '">' + escapeHtml(L.recentActivities || 'Recent activities →') + '</a>'
    : '';
  // One-line "what did they do last" blurb so operators can scan what happened
  // without clicking into each card.
  const summaryBlock = (!busy && a.lastSummary && a.lastSummary.text)
    ? '<div class="summary' + (a.lastSummary.ok === false ? ' fail' : '') + '" title="' + escapeHtml(a.lastSummary.text) + '">' +
        escapeHtml(a.lastSummary.text) +
        (a.lastSummary.at ? ' <span class="when">· ' + escapeHtml(fmtAgo(a.lastSummary.at)) + '</span>' : '') +
      '</div>'
    : '';
  card.innerHTML =
    '<div class="top">' +
      '<span class="dot"></span>' +
      '<span class="name">' + escapeHtml(a.name || a.id) + '</span>' +
      '<span class="tier" title="AI engine">' + escapeHtml(tierDisplay) + '</span>' +
    '</div>' +
    '<div class="meta">' + modelLabel + lastLabel + '</div>' +
    '<div class="stats">' +
      '<span>' + escapeHtml(stats.active) + ' <b>' + (a.active || 0) + '</b></span>' +
      '<span>' + escapeHtml(stats.total) + ' <b>' + (a.total || 0) + '</b></span>' +
      '<span class="err">' + escapeHtml(stats.errors) + ' <b>' + (a.errors || 0) + '</b></span>' +
    '</div>' + tasksBlock + summaryBlock + recentLink;
  return card;
}

function shortenModel(m) {
  if (!m) return '';
  return String(m)
    .replace(/^claude-/, '')
    .replace(/-\\d{8}$/, '')
    .replace(/\\[1m\\]$/, ' · 1M');
}

function fmtAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); return d + 'd ago';
}

function connect() {
  const conn = document.getElementById('conn');
  let es;
  const open = () => {
    try { es = new EventSource('/api/live/stream'); } catch (e) { setTimeout(open, 2000); return; }
    es.addEventListener('snapshot', (ev) => {
      conn.className = 'conn ok'; conn.title = 'connected';
      try { render(JSON.parse(ev.data)); } catch {}
    });
    es.addEventListener('error', () => {
      conn.className = 'conn err'; conn.title = 'reconnecting…';
      es.close(); setTimeout(open, 2000);
    });
  };
  open();
}

// Re-render every second to tick elapsed counters even when no new snapshot arrives.
let lastSnap = null;
fetch('/api/live').then(r => r.json()).then(s => { lastSnap = s; render(s); }).catch(() => {});
setInterval(() => { if (lastSnap) {
  // Patch elapsed times without a fresh snapshot
  document.querySelectorAll('.agent .task .elapsed').forEach((el) => { /* placeholder: server snapshot advances on stream */ });
} }, 1000);
connect();

// --- Task output modal ---
const taskModal = {
  el: document.getElementById('task-modal'),
  output: document.getElementById('task-modal-output'),
  title: document.getElementById('task-modal-title'),
  status: document.getElementById('task-modal-status'),
  channel: document.getElementById('task-modal-channel'),
  closeBtn: document.getElementById('task-modal-close'),
  backdrop: null,
  es: null,
  currentTaskId: null,
};
taskModal.backdrop = taskModal.el && taskModal.el.querySelector('.task-modal-backdrop');

function setStatus(label, kind) {
  if (!taskModal.status) return;
  taskModal.status.textContent = label;
  taskModal.status.className = 'task-modal-status' + (kind ? ' ' + kind : '');
}

function appendOutput(text) {
  if (!text || !taskModal.output) return;
  const atBottom = taskModal.output.scrollTop + taskModal.output.clientHeight >= taskModal.output.scrollHeight - 30;
  taskModal.output.appendChild(document.createTextNode(text));
  if (atBottom) taskModal.output.scrollTop = taskModal.output.scrollHeight;
}

function closeTaskModal() {
  if (!taskModal.el) return;
  taskModal.el.classList.add('hidden');
  taskModal.el.setAttribute('aria-hidden', 'true');
  if (taskModal.es) { try { taskModal.es.close(); } catch {} taskModal.es = null; }
  taskModal.currentTaskId = null;
}

function openTaskModal(opts) {
  if (!taskModal.el || !opts.taskId || !opts.nodeUrl) return;
  if (taskModal.currentTaskId === opts.taskId) { taskModal.el.classList.remove('hidden'); return; }
  const L = window.UI_LABELS || {};
  closeTaskModal();
  taskModal.currentTaskId = opts.taskId;
  taskModal.el.classList.remove('hidden');
  taskModal.el.setAttribute('aria-hidden', 'false');
  taskModal.title.textContent = opts.agentName + ' · ' + (opts.preview || 'task ' + opts.taskId);
  taskModal.title.title = opts.preview || '';
  taskModal.channel.textContent = opts.channel || '—';
  taskModal.output.textContent = '';
  setStatus(L.taskModalConnecting || 'connecting…', '');
  const url = '/api/task/stream?node=' + encodeURIComponent(opts.nodeUrl)
    + '&agent=' + encodeURIComponent(opts.agentId)
    + '&task=' + encodeURIComponent(opts.taskId);
  let es;
  try { es = new EventSource(url); } catch (e) { setStatus('connect failed', 'err'); return; }
  taskModal.es = es;
  es.addEventListener('start', (ev) => {
    setStatus(L.taskModalLive || 'live', 'live');
    try { const data = JSON.parse(ev.data); if (data.initial) appendOutput(data.initial); if (data.done) setStatus(L.taskModalFinished || 'finished', 'done'); } catch {}
  });
  es.addEventListener('chunk', (ev) => {
    try { const data = JSON.parse(ev.data); appendOutput(data.text || ''); } catch {}
  });
  es.addEventListener('end', () => {
    setStatus(L.taskModalFinished || 'finished', 'done');
    try { es.close(); } catch {}
    taskModal.es = null;
  });
  es.addEventListener('error', () => {
    if (es.readyState === 2) {
      setStatus('disconnected', 'err');
      taskModal.es = null;
    }
  });
}

if (taskModal.closeBtn) taskModal.closeBtn.addEventListener('click', closeTaskModal);
if (taskModal.backdrop) taskModal.backdrop.addEventListener('click', closeTaskModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && taskModal.el && !taskModal.el.classList.contains('hidden')) closeTaskModal(); });

// --- History panel ---
const historyPanel = {
  el: document.getElementById('history-panel'),
  body: document.getElementById('history-panel-body'),
  title: document.getElementById('history-panel-title'),
  source: document.getElementById('history-panel-source'),
  closeBtn: document.getElementById('history-panel-close'),
  current: null,
};

function closeHistoryPanel() {
  if (!historyPanel.el) return;
  historyPanel.el.classList.add('hidden');
  historyPanel.el.setAttribute('aria-hidden', 'true');
  historyPanel.current = null;
}

async function openHistoryPanel(opts) {
  if (!historyPanel.el) return;
  const L = window.UI_LABELS || {};
  historyPanel.current = { agentId: opts.agentId, nodeUrl: opts.nodeUrl };
  historyPanel.title.textContent = (opts.agentName || opts.agentId) + ' · ' + (L.historyPanelTitle || 'Recent activities');
  historyPanel.source.textContent = opts.nodeUrl;
  historyPanel.body.innerHTML = '<div class="history-empty">' + escapeHtml(L.historyLoading || 'loading…') + '</div>';
  historyPanel.el.classList.remove('hidden');
  historyPanel.el.setAttribute('aria-hidden', 'false');
  const url = '/api/task/history?node=' + encodeURIComponent(opts.nodeUrl)
    + '&agent=' + encodeURIComponent(opts.agentId) + '&limit=50';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = await r.json();
    renderHistoryList(items, opts);
  } catch (e) {
    historyPanel.body.innerHTML = '<div class="history-empty" style="color:var(--red)">' + escapeHtml(e.message) + '</div>';
  }
}

function renderHistoryList(items, opts) {
  const L = window.UI_LABELS || {};
  if (!Array.isArray(items) || items.length === 0) {
    historyPanel.body.innerHTML = '<div class="history-empty">' + escapeHtml(L.historyEmpty || 'No recorded tasks yet.') + '</div>';
    return;
  }
  historyPanel.body.innerHTML = '';
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.dataset.taskId = it.id;
    const flag = it.ok ? '<span class="ok">✓</span>' : '<span class="err">✗</span>';
    const dur = it.durationMs ? fmtElapsed(it.durationMs) : '—';
    const when = it.endedAt ? fmtAgoShort(it.endedAt) : '';
    const channel = '<span class="channel">' + escapeHtml(it.channel || '—') + '</span>';
    const sender = it.sender ? ' · ' + escapeHtml(it.sender) : '';
    div.innerHTML =
      '<div class="top">' + flag + channel + sender + '<span class="when">' + escapeHtml(when) + '</span></div>' +
      '<div class="preview">' + escapeHtml((it.message || '').slice(0, 200)) + '</div>' +
      '<div class="duration">' + escapeHtml(dur) + (it.error ? ' · ' + escapeHtml(it.error.slice(0, 80)) : '') + '</div>';
    div.addEventListener('click', () => openTaskRecord({
      taskId: it.id, agentId: opts.agentId, nodeUrl: opts.nodeUrl,
      channel: it.channel, agentName: opts.agentName,
      preview: it.message || '',
    }));
    historyPanel.body.appendChild(div);
  }
}

function fmtAgoShort(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// Open the task modal in "history" mode — fetch the stored record once,
// dump the transcript + final response, no SSE.
async function openTaskRecord(opts) {
  if (!taskModal.el) return;
  const L = window.UI_LABELS || {};
  closeTaskModal();
  taskModal.currentTaskId = opts.taskId;
  taskModal.el.classList.remove('hidden');
  taskModal.el.setAttribute('aria-hidden', 'false');
  taskModal.title.textContent = (opts.agentName || opts.agentId) + ' · ' + (opts.preview || 'task ' + opts.taskId);
  taskModal.title.title = opts.preview || '';
  taskModal.channel.textContent = opts.channel || '—';
  taskModal.output.textContent = '';
  setStatus(L.historyLoading || 'loading…', '');
  const url = '/api/task/history?node=' + encodeURIComponent(opts.nodeUrl)
    + '&agent=' + encodeURIComponent(opts.agentId) + '&task=' + encodeURIComponent(opts.taskId);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rec = await r.json();
    setStatus(rec.ok ? (L.taskModalArchived || 'archived') : (L.taskModalFinished || 'failed'), rec.ok ? 'done' : 'err');
    if (rec.transcript) appendOutput(rec.transcript);
    if (rec.responseText && rec.transcript.indexOf(rec.responseText) === -1) {
      appendOutput('\\n\\n--- ' + (L.taskModalFinalResponse || 'Final reply') + ' ---\\n' + rec.responseText);
    }
    if (rec.error) appendOutput('\\n\\n[error] ' + rec.error);
  } catch (e) {
    setStatus(L.taskModalLoadFailed || 'couldn\\'t load', 'err');
    appendOutput('Error: ' + e.message);
  }
}

if (historyPanel.closeBtn) historyPanel.closeBtn.addEventListener('click', closeHistoryPanel);

// Click delegation on the agent grid — opens the modal for any task preview,
// or the history panel for the "Recent activities" link.
document.getElementById('grid').addEventListener('click', (e) => {
  const previewEl = e.target.closest('.preview.clickable');
  if (previewEl) {
    e.preventDefault();
    openTaskModal({
      taskId: previewEl.dataset.taskId,
      agentId: previewEl.dataset.agentId,
      nodeUrl: previewEl.dataset.nodeUrl,
      channel: previewEl.dataset.channel,
      agentName: previewEl.dataset.agentName || previewEl.dataset.agentId,
      preview: previewEl.getAttribute('title') || previewEl.textContent || '',
    });
    return;
  }
  const recentEl = e.target.closest('.recent-link');
  if (recentEl) {
    e.preventDefault();
    openHistoryPanel({
      agentId: recentEl.dataset.agentId,
      agentName: recentEl.dataset.agentName,
      nodeUrl: recentEl.dataset.nodeUrl,
    });
  }
});
`

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

/* Description edit/preview tabs */
.desc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.desc-tabs { display: inline-flex; background: var(--col); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.desc-tabs button { background: transparent; border: none; color: var(--muted); padding: 4px 10px; cursor: pointer; font: inherit; font-size: 11px; }
.desc-tabs button.active { background: var(--accent); color: white; }
.desc-preview { background: var(--col); border: 1px solid var(--border); border-radius: 6px;
  padding: 12px 14px; min-height: 120px; max-height: 420px; overflow-y: auto; line-height: 1.55; }
.desc-preview.empty { color: var(--muted); font-style: italic; }
.desc-preview h1 { font-size: 18px; margin: 16px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
.desc-preview h2 { font-size: 16px; margin: 14px 0 6px; }
.desc-preview h3 { font-size: 14px; margin: 12px 0 4px; color: var(--text); }
.desc-preview p { margin: 6px 0; }
.desc-preview ul, .desc-preview ol { margin: 6px 0; padding-left: 20px; }
.desc-preview li { margin: 2px 0; }
.desc-preview li.task { list-style: none; margin-left: -16px; }
.desc-preview li.task input { margin-right: 6px; vertical-align: middle; }
.desc-preview code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px;
  font: 12px ui-monospace, "SF Mono", monospace; color: #e6e8ef; }
.desc-preview pre { background: #0a0c11; border: 1px solid var(--border); border-radius: 6px;
  padding: 10px; overflow-x: auto; margin: 8px 0; }
.desc-preview pre code { background: transparent; padding: 0; font-size: 12px; line-height: 1.45; color: #d8dce6; }
.desc-preview blockquote { border-left: 3px solid var(--accent); padding: 2px 12px; margin: 8px 0;
  color: var(--muted); background: rgba(99,102,241,0.08); border-radius: 0 4px 4px 0; }
.desc-preview a { color: var(--accent); text-decoration: none; }
.desc-preview a:hover { text-decoration: underline; }
.desc-preview hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.desc-preview table { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.desc-preview th, .desc-preview td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.desc-preview th { background: var(--col-hdr); font-weight: 600; }
.desc-preview img { max-width: 100%; border-radius: 4px; margin: 6px 0; }
.desc-preview del { color: var(--muted); }
.desc-preview .ref { background: rgba(99,102,241,0.15); padding: 0 4px; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 12px; }

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

/* --- Activity panel --- */
.activity-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 340px;
  background: var(--card); border-left: 1px solid var(--border); z-index: 140;
  display: flex; flex-direction: column; box-shadow: -8px 0 24px rgba(0,0,0,0.35);
  transition: transform 0.2s ease; }
.activity-panel.hidden { transform: translateX(100%); pointer-events: none; }
.activity-panel > header { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  border-bottom: 1px solid var(--border); background: var(--col-hdr); }
.activity-panel > header h2 { margin: 0; font-size: 13px; font-weight: 600; flex: 1; }
.activity-panel > header .source { font-size: 10px; color: var(--muted); font-family: ui-monospace, monospace; }
.activity-panel > header .x { background: transparent; border: none; color: var(--muted); font-size: 16px;
  cursor: pointer; padding: 4px 8px; }
.activity-panel > header .x:hover { color: var(--text); }
#activity-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.agent-card { background: var(--col); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.agent-card .top { display: flex; align-items: center; gap: 8px; }
.agent-card .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gray); flex-shrink: 0; }
.agent-card .dot.active { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 1.2s ease-in-out infinite; }
.agent-card .dot.errored { background: var(--red); }
.agent-card .name { font-weight: 600; font-size: 13px; flex: 1; }
.agent-card .tier { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.agent-card .meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.agent-card .model { font-family: ui-monospace, monospace; font-size: 10px; color: var(--accent);
  background: rgba(99,102,241,0.12); padding: 1px 7px; border-radius: 3px; letter-spacing: 0.2px; }
.agent-card .last { font-size: 10px; color: var(--muted); }
.agent-card .last.muted { font-style: italic; opacity: 0.7; }
.agent-card .stats { display: flex; gap: 10px; font-size: 11px; color: var(--muted); }
.agent-card .stats b { color: var(--text); font-weight: 600; }
.agent-card .stats .errors b { color: var(--red); }
.agent-card .current { font-size: 11px; color: var(--muted); padding-top: 4px; border-top: 1px dashed var(--border);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-card .current b { color: var(--text); font-weight: 500; }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }

.activity-panel .events { padding: 10px 14px; max-height: 200px; overflow-y: auto;
  border-top: 1px solid var(--border); background: #0a0c11; font: 11px/1.5 ui-monospace, monospace; }
.activity-panel .events .evt { color: var(--muted); margin-bottom: 4px; }
.activity-panel .events .evt .ts { color: #4a4e5a; }
.activity-panel .events .evt .who { color: var(--accent); }
.activity-panel .events .evt .what { color: var(--text); }
.activity-panel .events .evt.err .what { color: var(--red); }

/* Shift the main grid left when activity panel is open so cards aren't hidden */
body.panel-open main#columns { padding-right: 352px; }
body.panel-open header { padding-right: 356px; }

header #activityBtn.on { background: var(--accent); color: white; border-color: var(--accent); }
header a.link { color: var(--text); text-decoration: none; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
header a.link:hover { color: var(--accent); border-color: var(--accent); }

/* AI draft row inside the create modal */
.draft-box { background: var(--col); border: 1px dashed var(--accent); border-radius: 8px;
  padding: 10px 12px; margin-bottom: 14px; }
.draft-box .fld { margin-bottom: 8px; }
.draft-box .draft-row { display: flex; gap: 8px; align-items: center; }
.draft-box .draft-row select { flex: 0 0 160px; }
.draft-box .draft-row .hint { color: var(--muted); font-size: 12px; flex: 1; }
.draft-box .draft-row .hint.err { color: var(--red); }
.draft-box .draft-row .hint.ok { color: var(--green); }
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
document.getElementById('newIssueBtn').onclick = () => openCreateModal(null);
document.getElementById('activityBtn').onclick = () => toggleActivity();
document.getElementById('activity-close').onclick = () => toggleActivity(false);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('modal').classList.contains('open')) { closeModal(); return; }
  if (e.target.matches('input,select,textarea')) return;
  if (e.key === 'r') loadItems();
  if (e.key === 'a') toggleActivity();
});

// --- Modal (detail view / create) ---

async function openDetailModal(itemId) {
  openModal('edit', itemId);
  const hint = document.getElementById('m-hint');
  hint.textContent = 'Loading…';
  try {
    const r = await fetch('/api/boards/' + state.current.id + '/items/' + encodeURIComponent(itemId));
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
    const detail = await r.json();
    state.modal.original = detail;
    state.modal.draft = cloneForDraft(detail);
    paintModal(state.modal.draft);
    hint.textContent = '';
  } catch (e) {
    hint.textContent = 'Load failed: ' + e.message;
  }
}

function openCreateModal(columnId) {
  state.modal.targetColumnId = columnId || null;
  const blank = {
    id: null, title: '', description: '',
    labels: [], labelDetails: [], assignees: [], milestone: '', state: 'opened',
  };
  // Pre-apply the target column's scoped label so the new issue lands in that column.
  if (columnId && state.current) {
    const col = state.current.columns.find(c => c.id === columnId);
    if (col && col.kind === 'scoped-label' && col.scopedLabel) {
      blank.labels.push(col.scopedLabel);
      blank.labelDetails.push({ name: col.scopedLabel, color: col.accent });
    } else if (col && col.kind === 'label' && col.mapsToLabel) {
      blank.labels.push(col.mapsToLabel);
      blank.labelDetails.push({ name: col.mapsToLabel, color: col.accent });
    }
  }
  // Carry the board's primary label (the team filter) so created issues show up here.
  if (state.current && state.current.primaryToolLabel && !blank.labels.includes(state.current.primaryToolLabel)) {
    blank.labels.push(state.current.primaryToolLabel);
    blank.labelDetails.push({ name: state.current.primaryToolLabel });
  }
  openModal('create', null);
  state.modal.original = null;
  state.modal.draft = blank;
  paintModal(blank);
}

function openModal(mode, id) {
  state.modal.mode = mode;
  state.modal.id = id;
  const m = document.getElementById('modal');
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('m-save').textContent = mode === 'create' ? 'Create' : 'Save';
  document.getElementById('m-iid').textContent = id ? ('#' + id.split(':').slice(-1)[0]) : 'NEW';
  // Default description tab: Preview when reading an existing issue (focus on
  // rendered content), Write when creating (focus on typing).
  setDescTab(mode === 'create' ? 'write' : 'preview');
  // Draft box only in create mode.
  const draftBox = document.getElementById('m-draft');
  if (draftBox) {
    draftBox.hidden = mode !== 'create';
    if (mode === 'create') {
      document.getElementById('m-rough').value = '';
      document.getElementById('m-draft-hint').textContent = '';
      document.getElementById('m-draft-hint').className = 'hint';
      populateDraftAgents();
    }
  }
  // Pre-focus: rough for create, description for edit.
  setTimeout(() => {
    const el = document.getElementById(mode === 'create' ? 'm-rough' : 'm-desc');
    if (el) el.focus();
  }, 50);
}

/** Toggle between rendered preview and the raw textarea for the description. */
function setDescTab(tab) {
  const preview = document.getElementById('m-desc-preview');
  const textarea = document.getElementById('m-desc');
  if (!preview || !textarea) return;
  const showPreview = tab === 'preview';
  preview.hidden = !showPreview;
  textarea.hidden = showPreview;
  document.querySelectorAll('.desc-tabs .desc-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  if (showPreview) {
    // Re-render with the current draft content so previews stay in sync with
    // in-progress edits (e.g. after an ✨ Draft).
    paintDescriptionPreview(state.modal.draft || {});
  }
}

function paintDescriptionPreview(d) {
  const preview = document.getElementById('m-desc-preview');
  if (!preview) return;
  const text = (state.modal.draft && state.modal.draft.description) || d.description || '';
  if (!text.trim()) {
    preview.classList.add('empty');
    preview.textContent = 'No description yet.';
    return;
  }
  preview.classList.remove('empty');
  // Derive GitLab host+project from the item URL so #123 / !45 / @user become
  // real links. Falls back to plain text rendering when URL isn't available.
  const url = (state.modal.original && state.modal.original.url) || d.url || '';
  const ctx = parseGitLabContext(url);
  preview.innerHTML = renderGitLabMarkdown(text, ctx);
}

/** Extract {host, project} from a GitLab issue/MR URL. Returns null on failure. */
function parseGitLabContext(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    // ".../:namespace/:project/-/issues/:iid" or ".../-/merge_requests/..."
    const m = u.pathname.match(/^\\/(.+?)\\/-\\//);
    if (!m) return { host: u.origin, project: '' };
    return { host: u.origin, project: m[1] };
  } catch { return null; }
}

// Alias escapeHtml so the markdown renderer reads concisely.
const esc = escapeHtml;

/* ------------------------------------------------------------------ */
/* Minimal GitLab-flavored Markdown renderer                          */
/* ------------------------------------------------------------------ */
/*  Handles: headings, bold, italic, strikethrough, inline + fenced   */
/*  code, links, images, blockquotes, HR, ordered/unordered lists,    */
/*  task lists (- [ ] / - [x]), tables, paragraphs. Post-process for  */
/*  GitLab refs (#NNN, !NNN, @user).                                  */
/*  Not a full CommonMark implementation — covers the 95% used in     */
/*  issue bodies. Output is assembled from escaped + linkified tokens */
/*  so no user content lands in the DOM unescaped.                    */
/* ------------------------------------------------------------------ */

function renderGitLabMarkdown(md, ctx) {
  const src = String(md || '').replace(/\\r\\n?/g, '\\n');
  // Protect fenced code blocks first — they must pass through untouched.
  // Regex built via RegExp constructor because we're inside a TS template
  // literal and backtick regex literals confuse the bundler.
  const fences = [];
  const fenceRe = new RegExp('\\\\u0060\\\\u0060\\\\u0060(\\\\w*)\\\\n([\\\\s\\\\S]*?)\\\\n\\\\u0060\\\\u0060\\\\u0060', 'g');
  const withoutFences = src.replace(fenceRe, (_m, lang, code) => {
    const idx = fences.length;
    fences.push({ lang, code });
    return '\\u0000FENCE' + idx + '\\u0000';
  });

  const lines = withoutFences.split('\\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fence placeholder — emit <pre><code>.
    const fm = line.match(/^\\u0000FENCE(\\d+)\\u0000\$/);
    if (fm) {
      const f = fences[+fm[1]];
      const cls = f.lang ? ' class="lang-' + esc(f.lang) + '"' : '';
      html += '<pre><code' + cls + '>' + esc(f.code) + '</code></pre>';
      i++;
      continue;
    }

    // Blank line — paragraph break.
    if (!line.trim()) { i++; continue; }

    // Heading.
    const hm = line.match(/^(#{1,6})\\s+(.*)/);
    if (hm) {
      const level = hm[1].length;
      html += '<h' + level + '>' + inlineMd(hm[2], ctx) + '</h' + level + '>';
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(---+|\\*\\*\\*+|___+)\$/.test(line.trim())) {
      html += '<hr>';
      i++;
      continue;
    }

    // Blockquote (consecutive > lines).
    if (/^>\\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\\s?/, '')); i++; }
      html += '<blockquote>' + inlineMd(buf.join(' '), ctx) + '</blockquote>';
      continue;
    }

    // Table (GFM) — header row + alignment row + body rows.
    if (line.includes('|') && i + 1 < lines.length && /^\\s*\\|?\\s*(:?-+:?\\s*\\|?)+\\s*\$/.test(lines[i+1])) {
      const headerCells = splitTableRow(line);
      let t = '<table><thead><tr>' + headerCells.map(c => '<th>' + inlineMd(c, ctx) + '</th>').join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitTableRow(lines[i]);
        t += '<tr>' + cells.map(c => '<td>' + inlineMd(c, ctx) + '</td>').join('') + '</tr>';
        i++;
      }
      html += t + '</tbody></table>';
      continue;
    }

    // Lists (ordered, unordered, task).
    const ulMatch = line.match(/^(\\s*)[-*+]\\s+(.*)/);
    const olMatch = line.match(/^(\\s*)(\\d+)\\.\\s+(.*)/);
    if (ulMatch || olMatch) {
      const ordered = !!olMatch;
      const tag = ordered ? 'ol' : 'ul';
      let items = '';
      while (i < lines.length) {
        const cur = lines[i];
        const um = cur.match(/^(\\s*)[-*+]\\s+(.*)/);
        const om = cur.match(/^(\\s*)(\\d+)\\.\\s+(.*)/);
        if (!um && !om) break;
        const content = (um ? um[2] : om[3]);
        // Task list item: "- [ ] label" or "- [x] label"
        const tm = content.match(/^\\[( |x|X)\\]\\s+(.*)/);
        if (tm) {
          const checked = tm[1].toLowerCase() === 'x' ? ' checked' : '';
          items += '<li class="task"><input type="checkbox" disabled' + checked + '>' + inlineMd(tm[2], ctx) + '</li>';
        } else {
          items += '<li>' + inlineMd(content, ctx) + '</li>';
        }
        i++;
      }
      html += '<' + tag + '>' + items + '</' + tag + '>';
      continue;
    }

    // Paragraph — absorb consecutive non-empty, non-special lines.
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(\\u0000FENCE|#|>|\\s*[-*+]\\s|\\s*\\d+\\.\\s|---+|===+)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    html += '<p>' + inlineMd(para.join(' '), ctx) + '</p>';
  }
  return html;
}

function splitTableRow(line) {
  // Strip leading/trailing pipe and split by unescaped pipes.
  const s = line.trim().replace(/^\\||\\|\$/g, '');
  return s.split(/(?<!\\\\)\\|/).map(c => c.trim());
}

function inlineMd(text, ctx) {
  // Inline code — protect first with placeholders. Regex built via RegExp
  // constructor so a TS template literal doesn't choke on backtick escapes.
  const codes = [];
  const inlineCodeRe = new RegExp('\\\\u0060([^\\\\u0060]+)\\\\u0060', 'g');
  let out = text.replace(inlineCodeRe, (_m, c) => {
    const idx = codes.length;
    codes.push(c);
    return '\\u0001CODE' + idx + '\\u0001';
  });
  out = esc(out);
  // Images first so their URLs aren't caught by the link rule.
  out = out.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"([^\"]*)\")?\\)/g, (_m, alt, src, title) => {
    return '<img src="' + sanitizeUrl(src) + '" alt="' + esc(alt) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>';
  });
  // Links [text](url).
  out = out.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+\"([^\"]*)\")?\\)/g, (_m, label, href, title) => {
    return '<a href="' + sanitizeUrl(href) + '"' + (title ? ' title="' + esc(title) + '"' : '') + ' target="_blank" rel="noopener">' + label + '</a>';
  });
  // Bold, italic, strikethrough.
  out = out.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>\$1</strong>');
  out = out.replace(/(?<![\\w*])\\*([^*\\n]+)\\*(?![\\w])/g, '<em>\$1</em>');
  out = out.replace(/(?<![\\w_])_([^_\\n]+)_(?![\\w])/g, '<em>\$1</em>');
  out = out.replace(/~~([^~\\n]+)~~/g, '<del>\$1</del>');
  // Autolink raw URLs.
  out = out.replace(/(^|[\\s(])((?:https?:\\/\\/)[^\\s<)]+)/g, (_m, pre, url) => pre + '<a href="' + sanitizeUrl(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a>');
  // GitLab refs: #NNN (issue), !NNN (MR), @user. Only when we have context.
  if (ctx && ctx.host && ctx.project) {
    out = out.replace(/(^|[\\s(])#(\\d+)\\b/g, (_m, pre, n) => pre + '<a class="ref" href="' + ctx.host + '/' + ctx.project + '/-/issues/' + n + '" target="_blank" rel="noopener">#' + n + '</a>');
    out = out.replace(/(^|[\\s(])!(\\d+)\\b/g, (_m, pre, n) => pre + '<a class="ref" href="' + ctx.host + '/' + ctx.project + '/-/merge_requests/' + n + '" target="_blank" rel="noopener">!' + n + '</a>');
    out = out.replace(/(^|[\\s(])@([A-Za-z0-9_.\\-]+)/g, (_m, pre, u) => pre + '<a class="ref" href="' + ctx.host + '/' + u + '" target="_blank" rel="noopener">@' + u + '</a>');
  }
  // Restore inline code.
  out = out.replace(/\\u0001CODE(\\d+)\\u0001/g, (_m, idx) => '<code>' + esc(codes[+idx]) + '</code>');
  return out;
}

function sanitizeUrl(u) {
  const s = String(u || '').trim();
  // Block javascript: and data: (except safe images) URLs.
  if (/^javascript:/i.test(s)) return '#';
  return esc(s);
}

async function populateDraftAgents() {
  const sel = document.getElementById('m-draft-agent');
  if (!sel) return;
  if (sel.options.length > 1) {
    // Already populated — just sync selection.
    const saved = localStorage.getItem('agentx.draftAgent');
    if (saved) sel.value = saved;
    return;
  }
  try {
    const r = await fetch('/api/agents');
    if (!r.ok) return;
    const list = await r.json();
    sel.innerHTML = '<option value="">Agent…</option>';
    for (const a of list) {
      const o = document.createElement('option');
      o.value = a.id; o.textContent = a.name + ' (' + a.tier + ')';
      sel.appendChild(o);
    }
    const saved = localStorage.getItem('agentx.draftAgent');
    if (saved && list.some(a => a.id === saved)) sel.value = saved;
    sel.onchange = () => localStorage.setItem('agentx.draftAgent', sel.value);
  } catch {}
}

async function draftWithAgent() {
  const rough = document.getElementById('m-rough').value.trim();
  const agentId = document.getElementById('m-draft-agent').value;
  const hint = document.getElementById('m-draft-hint');
  const goBtn = document.getElementById('m-draft-go');
  if (!rough) { hint.textContent = 'Describe the issue first.'; hint.className = 'hint err'; return; }
  if (!agentId) { hint.textContent = 'Pick a drafting agent.'; hint.className = 'hint err'; return; }
  goBtn.disabled = true;
  hint.textContent = 'Drafting with ' + agentId + '…'; hint.className = 'hint';

  // Build board context for convention-aware prompting.
  const board = state.current;
  const col = state.modal.targetColumnId ? board.columns.find(c => c.id === state.modal.targetColumnId) : null;
  const columnLabel = col && (col.scopedLabel || col.mapsToLabel);
  const ctx = {
    boardName: board.name,
    primaryLabel: board.primaryToolLabel,
    project: board.source && board.source.projects && board.source.projects[0],
    knownLabels: state.meta.labels || [],
    members: (state.meta.members || []).map(m => m.username),
    columnLabel: columnLabel,
  };

  try {
    const r = await fetch('/api/draft', {
      method: 'POST', headers: csrfHeaders(),
      body: JSON.stringify({ rough, agent: agentId, context: ctx }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const drafted = await r.json();
    // Populate the existing form fields.
    document.getElementById('m-title').value = drafted.title || '';
    document.getElementById('m-desc').value = drafted.description || '';
    state.modal.draft.title = drafted.title || '';
    state.modal.draft.description = drafted.description || '';
    state.modal.draft.labels = Array.isArray(drafted.labels) ? drafted.labels.slice() : state.modal.draft.labels;
    if (drafted.assigneeUsername) {
      const m = state.meta.members.find(x => x.username === drafted.assigneeUsername);
      if (!state.modal.draft.assignees.some(a => a.username === drafted.assigneeUsername)) {
        state.modal.draft.assignees.push({
          username: drafted.assigneeUsername, name: m && m.name, avatarUrl: m && m.avatarUrl,
        });
      }
    }
    paintModal(state.modal.draft);
    hint.textContent = 'Draft ready — review and edit before creating.';
    hint.className = 'hint ok';
  } catch (e) {
    hint.textContent = 'Draft failed: ' + e.message;
    hint.className = 'hint err';
  } finally {
    goBtn.disabled = false;
  }
}
function closeModal() {
  const m = document.getElementById('modal');
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  state.modal = { mode: null, id: null, original: null, draft: null };
}
function cloneForDraft(d) {
  return {
    id: d.id, title: d.title || '', description: d.description || '',
    labels: (d.labels || []).slice(), labelDetails: (d.labelDetails || []).slice(),
    assignees: (d.assignees || []).slice(),
    milestone: d.milestone || '',
    state: d.state || 'opened',
    stage: d.stage, url: d.url, createdAt: d.createdAt, updatedAt: d.updatedAt, author: d.author,
  };
}

function paintModal(d) {
  document.getElementById('m-title').value = d.title || '';
  document.getElementById('m-desc').value = d.description || '';
  paintDescriptionPreview(d);

  document.querySelectorAll('#m-state button').forEach(b => {
    b.classList.toggle('active', b.dataset.state === (d.state || 'opened'));
    b.onclick = () => { state.modal.draft.state = b.dataset.state; paintModal(state.modal.draft); };
  });

  renderChipPicker('m-labels', d.labels || [], state.meta.labels, {
    chipStyle: (name) => {
      const match = (d.labelDetails || []).find(l => l.name === name);
      const bg = match && match.color ? match.color : labelColor(name);
      return { background: bg, color: pickTextColor(bg) };
    },
    onAdd: (name) => { if (!state.modal.draft.labels.includes(name)) { state.modal.draft.labels.push(name); paintModal(state.modal.draft); } },
    onRemove: (name) => { state.modal.draft.labels = state.modal.draft.labels.filter(l => l !== name); paintModal(state.modal.draft); },
    placeholder: 'Add label…',
    allowCustom: true,
  });

  const aNames = (d.assignees || []).map(a => a.username);
  renderChipPicker('m-assignees', aNames, state.meta.members.map(m => m.username), {
    chipLabel: (u) => {
      const m = state.meta.members.find(x => x.username === u) || (d.assignees || []).find(x => x.username === u);
      return (m && m.name) || u;
    },
    onAdd: (u) => {
      if (state.modal.draft.assignees.some(a => a.username === u)) return;
      const m = state.meta.members.find(x => x.username === u);
      state.modal.draft.assignees.push({ username: u, name: m && m.name, avatarUrl: m && m.avatarUrl });
      paintModal(state.modal.draft);
    },
    onRemove: (u) => { state.modal.draft.assignees = state.modal.draft.assignees.filter(a => a.username !== u); paintModal(state.modal.draft); },
    placeholder: 'Assign…',
  });

  const ms = document.getElementById('m-milestone');
  ms.innerHTML = '<option value="">None</option>';
  for (const m of state.meta.milestones) {
    const o = document.createElement('option');
    o.value = m.title; o.textContent = m.title + (m.state === 'closed' ? ' (closed)' : '');
    if (m.title === d.milestone) o.selected = true;
    ms.appendChild(o);
  }
  if (d.milestone && !state.meta.milestones.some(m => m.title === d.milestone)) {
    const o = document.createElement('option'); o.value = d.milestone; o.textContent = d.milestone; o.selected = true;
    ms.appendChild(o);
  }
  ms.onchange = () => { state.modal.draft.milestone = ms.value; };

  document.getElementById('m-author').textContent = (d.author && (d.author.name || d.author.username)) || '—';
  document.getElementById('m-created').textContent = d.createdAt ? fmtDate(d.createdAt) : '—';
  document.getElementById('m-updated').textContent = d.updatedAt ? fmtDate(d.updatedAt) : '—';
  const link = document.getElementById('m-link');
  if (d.url) { link.href = d.url; link.style.display = ''; } else { link.style.display = 'none'; }
}

function renderChipPicker(elId, selected, options, opts) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  for (const name of selected) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = opts.chipLabel ? opts.chipLabel(name) : name;
    if (opts.chipStyle) {
      const st = opts.chipStyle(name);
      if (st.background) chip.style.background = st.background;
      if (st.color) chip.style.color = st.color;
    }
    const x = document.createElement('span');
    x.className = 'remove'; x.textContent = '✕'; x.title = 'Remove';
    x.onclick = (e) => { e.stopPropagation(); opts.onRemove(name); };
    chip.appendChild(x);
    el.appendChild(chip);
  }
  const dd = document.createElement('span');
  dd.className = 'dropdown';
  const btn = document.createElement('button');
  btn.className = 'add-chip'; btn.textContent = '+ ' + (opts.placeholder || 'Add');
  btn.type = 'button';
  btn.onclick = (e) => {
    e.stopPropagation();
    let menu = dd.querySelector('.menu');
    if (menu) { menu.remove(); return; }
    menu = document.createElement('div');
    menu.className = 'menu';
    const search = document.createElement('input');
    search.className = 'search'; search.type = 'search'; search.placeholder = opts.placeholder || 'Search…';
    menu.appendChild(search);
    const list = document.createElement('div');
    menu.appendChild(list);
    const paintList = (q) => {
      list.innerHTML = '';
      const ql = (q || '').toLowerCase();
      const filtered = options.filter(o => o.toLowerCase().includes(ql) && !selected.includes(o));
      if (filtered.length === 0 && !(opts.allowCustom && q)) {
        const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No matches';
        list.appendChild(empty);
      }
      for (const o of filtered.slice(0, 50)) {
        const opt = document.createElement('div');
        opt.className = 'opt'; opt.textContent = opts.chipLabel ? opts.chipLabel(o) : o;
        opt.onclick = () => { opts.onAdd(o); menu.remove(); };
        list.appendChild(opt);
      }
      if (opts.allowCustom && q && !options.includes(q) && !selected.includes(q)) {
        const opt = document.createElement('div');
        opt.className = 'opt'; opt.textContent = 'Create "' + q + '"';
        opt.onclick = () => { opts.onAdd(q); menu.remove(); };
        list.appendChild(opt);
      }
    };
    search.oninput = (ev) => paintList(ev.target.value);
    paintList('');
    dd.appendChild(menu);
    setTimeout(() => search.focus(), 0);
    const away = (ev) => {
      if (!dd.contains(ev.target)) { menu.remove(); document.removeEventListener('click', away); }
    };
    setTimeout(() => document.addEventListener('click', away), 0);
  };
  dd.appendChild(btn);
  el.appendChild(dd);
}

async function saveModal() {
  const saveBtn = document.getElementById('m-save');
  const hint = document.getElementById('m-hint');
  saveBtn.disabled = true;
  hint.textContent = 'Saving…';
  const d = state.modal.draft;
  d.title = document.getElementById('m-title').value.trim();
  d.description = document.getElementById('m-desc').value;
  if (!d.title) { hint.textContent = 'Title required'; saveBtn.disabled = false; return; }

  try {
    if (state.modal.mode === 'create') {
      const r = await fetch('/api/boards/' + state.current.id + '/items', {
        method: 'POST', headers: csrfHeaders(),
        body: JSON.stringify({
          title: d.title, description: d.description, labels: d.labels,
          assigneeUsernames: (d.assignees || []).map(a => a.username),
          milestoneTitle: d.milestone || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
      toast('Created ✓', 'ok');
    } else {
      const orig = state.modal.original || {};
      const patch = {};
      if (d.title !== (orig.title || '')) patch.title = d.title;
      if (d.description !== (orig.description || '')) patch.description = d.description;
      const origLabels = (orig.labels || []).slice().sort().join('|');
      const newLabels = (d.labels || []).slice().sort().join('|');
      if (origLabels !== newLabels) patch.labels = d.labels;
      const origA = (orig.assignees || []).map(a => a.username).sort().join('|');
      const newA = (d.assignees || []).map(a => a.username).sort().join('|');
      if (origA !== newA) patch.assigneeUsernames = (d.assignees || []).map(a => a.username);
      if (d.milestone !== (orig.milestone || '')) patch.milestoneTitle = d.milestone || null;

      if (Object.keys(patch).length > 0) {
        const r = await fetch('/api/boards/' + state.current.id + '/items/' + encodeURIComponent(state.modal.id), {
          method: 'PATCH', headers: csrfHeaders(), body: JSON.stringify(patch),
        });
        if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
      }
      // State change → move to the appropriate column (reuses transition logic on server).
      if (d.state !== (orig.state || 'opened')) {
        const fromCol = state.current.columns.find(c => c.id === orig.stage);
        const toCol = d.state === 'closed'
          ? state.current.columns.find(c => c.kind === 'closed')
          : state.current.columns.find(c => c.kind === 'open-backlog');
        if (toCol) {
          await fetch('/api/boards/' + state.current.id + '/items/' + encodeURIComponent(state.modal.id) + '/move', {
            method: 'PATCH', headers: csrfHeaders(),
            body: JSON.stringify({ from: fromCol && fromCol.id, to: toCol.id }),
          });
        }
      }
      toast('Saved ✓', 'ok');
    }
    closeModal();
    await loadItems();
    state.meta.labels = collectKnownLabels();
  } catch (e) {
    hint.textContent = 'Save failed: ' + e.message;
  } finally {
    saveBtn.disabled = false;
  }
}

document.getElementById('m-close').onclick = closeModal;
document.getElementById('m-cancel').onclick = closeModal;
document.getElementById('m-save').onclick = saveModal;
document.querySelector('#modal .modal-backdrop').onclick = closeModal;
document.getElementById('m-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveModal();
});
const draftGo = document.getElementById('m-draft-go');
if (draftGo) draftGo.onclick = draftWithAgent;
const roughEl = document.getElementById('m-rough');
if (roughEl) roughEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) draftWithAgent();
});

// Description Preview/Write tabs. Textarea edits sync to draft so the
// preview re-renders the CURRENT text when the user flips to it.
document.querySelectorAll('.desc-tabs .desc-tab').forEach((b) => {
  b.addEventListener('click', () => setDescTab(b.dataset.tab));
});
const descEl = document.getElementById('m-desc');
if (descEl) descEl.addEventListener('input', () => {
  if (state.modal.draft) state.modal.draft.description = descEl.value;
});

// --- Agent activity panel (live polling of the daemon API) ---

const activity = {
  open: false, timer: null, daemonUrl: null, lastEventAt: 0, eventsRing: [],
};

function resolveDaemonUrl() {
  // Allow ?daemon=http://host:port override; fall back to localhost:18800 (MacBook) then 19900 (clawd).
  const q = new URLSearchParams(window.location.search).get('daemon');
  if (q) return q.replace(/\\/+\$/, '');
  return localStorage.getItem('agentx.daemon') || 'http://localhost:18800';
}

function toggleActivity(force) {
  activity.open = typeof force === 'boolean' ? force : !activity.open;
  const panel = document.getElementById('activity-panel');
  const btn = document.getElementById('activityBtn');
  panel.classList.toggle('hidden', !activity.open);
  panel.setAttribute('aria-hidden', activity.open ? 'false' : 'true');
  btn.classList.toggle('on', activity.open);
  document.body.classList.toggle('panel-open', activity.open);
  if (activity.open) startActivity(); else stopActivity();
}

async function startActivity() {
  activity.daemonUrl = resolveDaemonUrl();
  document.getElementById('activity-source').textContent = activity.daemonUrl.replace(/^https?:\\/\\//, '');
  await tickActivity();
  activity.timer = setInterval(tickActivity, 3000);
}
function stopActivity() {
  if (activity.timer) { clearInterval(activity.timer); activity.timer = null; }
}

async function tickActivity() {
  const body = document.getElementById('activity-body');
  try {
    // Fetch /agents (always present) + /business/status (optional — 404 tolerated)
    const [agentsRes, bizRes] = await Promise.all([
      fetch(activity.daemonUrl + '/agents').catch(() => null),
      fetch(activity.daemonUrl + '/business/status').catch(() => null),
    ]);
    if (!agentsRes || !agentsRes.ok) throw new Error('daemon unreachable at ' + activity.daemonUrl);
    const agents = await agentsRes.json();
    const biz = bizRes && bizRes.ok ? await bizRes.json() : null;

    // Merge business data (currentItem, onClock, lastReport) per-agent when available.
    const bizByAgent = {};
    if (biz && Array.isArray(biz.employees)) for (const e of biz.employees) bizByAgent[e.agentId || e.id] = e;

    body.innerHTML = '';
    for (const a of agents) {
      const b = bizByAgent[a.id];
      body.appendChild(renderAgentCard(a, b));
    }
    if (agents.length === 0) {
      body.innerHTML = '<div class="empty">No agents on this daemon.</div>';
    }
    // Events ring
    if (biz && biz.recentEvents) appendEvents(biz.recentEvents);
  } catch (e) {
    body.innerHTML = '<div class="empty" style="color:var(--red)">' + escapeHtml(e.message) + '</div>';
  }
}

function renderAgentCard(a, biz) {
  const card = document.createElement('div');
  card.className = 'agent-card';
  const active = (a.active || 0) > 0 || (biz && biz.onClock && biz.busy);
  const dotClass = (a.errors || 0) > 0 ? 'errored' : (active ? 'active' : '');
  const current = biz && biz.currentItem
    ? '<div class="current">Working on <b>' + escapeHtml(biz.currentItem.title || biz.currentItem.id) + '</b></div>'
    : (active ? '<div class="current"><b>' + a.active + ' active task' + (a.active === 1 ? '' : 's') + '</b></div>' : '');
  const modelLabel = a.model ? '<span class="model" title="Model">' + escapeHtml(shortenModelName(a.model)) + '</span>' : '';
  const lastLabel = a.lastActive
    ? '<span class="last" title="' + escapeHtml(new Date(a.lastActive).toLocaleString()) + '">last ' + escapeHtml(fmtAgoBoard(a.lastActive)) + '</span>'
    : '<span class="last muted">never ran</span>';
  card.innerHTML =
    '<div class="top">' +
      '<span class="dot ' + dotClass + '"></span>' +
      '<span class="name">' + escapeHtml(a.name || a.id) + '</span>' +
      '<span class="tier">' + escapeHtml(a.tier || '') + '</span>' +
    '</div>' +
    '<div class="meta">' + modelLabel + lastLabel + '</div>' +
    '<div class="stats">' +
      '<span>Active <b>' + (a.active || 0) + '</b></span>' +
      '<span>Total <b>' + (a.total || 0) + '</b></span>' +
      '<span class="errors">Errors <b>' + (a.errors || 0) + '</b></span>' +
    '</div>' + current;
  return card;
}

function shortenModelName(m) {
  if (!m) return '';
  return String(m)
    .replace(/^claude-/, '')
    .replace(/-\\d{8}$/, '')
    .replace(/\\[1m\\]$/, ' · 1M');
}

function fmtAgoBoard(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); return d + 'd ago';
}

function appendEvents(events) {
  const holder = document.getElementById('activity-events');
  const existingKeys = new Set([...holder.querySelectorAll('.evt')].map(e => e.dataset.key));
  for (const ev of events.slice(-50)) {
    const key = (ev.ts || '') + '|' + (ev.type || '') + '|' + (ev.agentId || '');
    if (existingKeys.has(key)) continue;
    const div = document.createElement('div');
    div.className = 'evt' + (ev.type && ev.type.includes('error') ? ' err' : '');
    div.dataset.key = key;
    div.innerHTML = '<span class="ts">' + (ev.ts ? new Date(ev.ts).toLocaleTimeString() : '') + '</span> ' +
                    '<span class="who">' + escapeHtml(ev.agentId || '—') + '</span> ' +
                    '<span class="what">' + escapeHtml(ev.summary || ev.type || '') + '</span>';
    holder.appendChild(div);
  }
  // Keep last 50 entries
  while (holder.children.length > 50) holder.removeChild(holder.firstChild);
  holder.scrollTop = holder.scrollHeight;
}

loadBoards().catch(e => toast('Init failed: ' + e.message));
`
