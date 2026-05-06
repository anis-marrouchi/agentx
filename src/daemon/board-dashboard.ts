import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { appendFileSync, existsSync, mkdirSync } from "fs"
import { readFile } from "fs/promises"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"
import type { DaemonConfig } from "./config"
import type { BoardConfig, BoardColumn } from "@/boards/config"
import { deriveStage, transitionDiff } from "@/boards/config"
import type { WorkSource, WorkItem } from "@/business/work-pool"
import { GitLabWorkSource } from "@/business/work-pool"
import { SORTABLE_JS } from "./vendor/sortable"
import { handleWizardGet, handleWizardPost, handleStartDaemonPost, wizardState } from "./setup-wizard"
import { handleAdminGet, handleAdminApi, handleAdminConfigGet } from "./admin-panel"
import { handleGraphGet, handleGraphApi } from "./graph-panel"
import { handleObservabilityGet, handleObservabilityApi } from "./observability-panel"
import { handleLedgerApi, renderLedgerPage } from "./ledger-panel"
import { renderCostPage } from "./ui/pages/cost"
import { createWikiHandler } from "@/wiki/serve"
import { handleActivityGraphGet, handleActivityGraphApi, handleActivityGraphStream, handleActivityGraphDetail, setDaemonConfigForActivityGraph, buildLocalActivityGraphSnapshot, mergeFleetSnapshots, type FleetSnapshot } from "./activity-graph-panel"
import { handleAgentPageGet, handleAgentApi } from "./agent-panel"
import { renderLivePage } from "./ui/pages/live"
import { renderBoardsPage } from "./ui/pages/boards"
import { renderGlossaryPage } from "./ui/pages/glossary"
import { renderWorkflowsPage } from "./ui/pages/workflows"
import { renderWorkflowEditorPage } from "./ui/pages/workflow-editor"
import { renderInboxPage } from "./ui/pages/inbox"
import { renderProcessesPage } from "./ui/pages/processes"
import { handleWorkflowsApi } from "./workflows-api"
import { LayoutStore, RunStore, WorkflowStore, type WorkflowRun } from "@/workflows"
import { TokenStore, recordHasScope, extractToken, type TokenRecord } from "./token-store"
import type { TopbarPeer } from "./topbar"

// --- Kanban Board Dashboard ---
//
// Zero-build web UI, served on its own port (default 4202, bound 127.0.0.1).
// Inline HTML/CSS/JS, manual routing, no framework.
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

  // Workflow stores are lightweight (filesystem-backed, no network). Created
  // once per dashboard so the /workflows page + editor API don't re-scan
  // directories on every request.
  //
  // Home-node id comes from the mesh config when available; falls back to a
  // stable "local" so single-node runs work out of the box. Until the
  // integration seam commits, the dispatcher itself isn't booted in the
  // daemon — the editor's view over these stores is read/write, but the
  // engine's run-time dispatch + mesh forwarding aren't wired yet.
  const wfNodeId = config.node?.id || "local"
  const wfDir = config.workflows?.dir ? resolve(process.cwd(), config.workflows.dir) : undefined
  const workflowStore = new WorkflowStore(wfDir ? { baseDir: wfDir } : undefined)
  const workflowRuns = new RunStore(wfDir ? { baseDir: wfDir, nodeId: wfNodeId } : { nodeId: wfNodeId })
  const workflowLayouts = new LayoutStore(wfDir ? { baseDir: wfDir } : undefined)

  // Activity-graph snapshot needs agent metadata (tier, model, name) from
  // agentx.json — set the module-level reference so the snapshot builder can
  // read it when serving each request.
  setDaemonConfigForActivityGraph(config)

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, { boards, sources, token, config, workflowStore, workflowRuns, workflowLayouts })
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
  workflowStore: WorkflowStore
  workflowRuns: RunStore
  workflowLayouts: LayoutStore
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
    const peers = buildTopbarPeers(ctx.config)
    const html = ctx.boards.length === 0
      ? renderLivePage({ peers })
      : renderBoardsPage({ peers })
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(html)
    return
  }
  if (method === "GET" && path === "/live") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderLivePage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  if (method === "GET" && path === "/glossary") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderGlossaryPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  if (method === "GET" && path === "/workflows") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderWorkflowsPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  if (method === "GET" && path === "/workflows/editor") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderWorkflowEditorPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  if (method === "GET" && path === "/inbox") {
    const actor = url.searchParams.get("actor") || undefined
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderInboxPage({ actor }))
    return
  }
  if (method === "GET" && path === "/processes") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderProcessesPage({}))
    return
  }
  // /graph is the canonical doc path; the page itself lives at /admin/graph.
  if (method === "GET" && path === "/graph") {
    res.writeHead(302, { Location: "/admin/graph" })
    res.end()
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
  if (method === "POST" && path === "/api/setup/start-daemon") {
    await handleStartDaemonPost(req, res)
    return
  }

  // Admin panel — ongoing management without editing JSON.
  if (method === "GET" && path === "/admin") {
    handleAdminGet(req, res, buildTopbarPeers(ctx.config), ctx.token)
    return
  }
  // /admin/graph — Intent Knowledge Graph: pending approvals + taxonomy editor.
  if (method === "GET" && path === "/admin/graph") {
    handleGraphGet(req, res, buildTopbarPeers(ctx.config), ctx.token)
    return
  }
  // /admin/health — platform-health view over route_traces + rotations + errors.
  // Renamed from /admin/observability — that name suggested business flow,
  // but the page only ever covered platform health. Old URL redirects so
  // existing bookmarks keep working.
  if (method === "GET" && (path === "/admin/health" || path === "/admin/observability")) {
    if (path === "/admin/observability") {
      res.writeHead(302, { Location: "/admin/health" })
      res.end()
      return
    }
    handleObservabilityGet(req, res, buildTopbarPeers(ctx.config))
    return
  }
  // ── Cross-mesh API proxy (must precede every /api/admin/* handler) ──
  // When the topbar peer selector is set to a non-primary peer, the
  // client-side fetch wrapper attaches X-Agentx-Peer / ?peer=<url> to the
  // request. Forward the whole call to that peer's dashboard before any
  // local handler picks it up, so the activity-graph + observability +
  // every other admin surface follow the selector.
  //
  // Special peerId="fleet" → fan-out + merge across local + every
  // dashboard.daemons[] entry. Only meaningful for the activity-graph
  // snapshot endpoint right now; other endpoints fall through to local
  // until they grow merge semantics.
  if (path.startsWith("/api/admin/")) {
    const peerId = String(req.headers["x-agentx-peer"] || "").trim() || url.searchParams.get("peer") || ""
    if (peerId === "fleet") {
      if (path === "/api/admin/activity-graph") {
        await handleActivityGraphFleet(req, res, ctx)
        return
      }
      // Dispatch detail in fleet mode: the id was rewritten to
      // "<nodeName>::<originalId>" by the merger so React keys stay
      // unique. Route the lookup back to the node that owns the row.
      const detailMatch = path.match(/^\/api\/admin\/activity-graph\/dispatch\/(.+)$/)
      if (detailMatch) {
        const decoded = decodeURIComponent(detailMatch[1])
        const sep = decoded.indexOf("::")
        if (sep > 0) {
          const nodeName = decoded.slice(0, sep)
          const realId = decoded.slice(sep + 2)
          const localNodeName = ctx.config.node?.id || ctx.config.node?.name || "local"
          if (nodeName === localNodeName) {
            // Local row — strip the prefix and let the local handler answer.
            req.url = `/api/admin/activity-graph/dispatch/${encodeURIComponent(realId)}`
            // Fall through to the regular handler below.
          } else {
            const peerByName = (ctx.config.dashboard?.daemons || []).find((d) => (d.name || d.url) === nodeName)
            if (peerByName) {
              const peer = findPeer(peerByName.url.replace(/\/+$/, ""), ctx.config)
              if (peer) {
                await proxyAdminToPeer(
                  req, res, peer,
                  `/api/admin/activity-graph/dispatch/${encodeURIComponent(realId)}`,
                )
                return
              }
            }
            sendJson(res, 404, { error: `unknown node "${nodeName}" in fleet dispatch id` })
            return
          }
        }
      }
      // Anything else in fleet mode → answer locally.
    } else if (peerId && peerId !== "primary") {
      const peer = findPeer(peerId, ctx.config)
      if (!peer) { sendJson(res, 404, { error: `unknown peer: ${peerId}` }); return }
      // Strip ?peer= so the destination doesn't re-proxy.
      const stripped = (url.search || "").replace(/[?&]peer=[^&]*/g, (m) => m.startsWith("?") ? "?" : "")
      const cleanQuery = stripped === "?" ? "" : stripped
      await proxyAdminToPeer(req, res, peer, path + cleanQuery)
      return
    }
  }

  if (method === "GET" && path.startsWith("/api/admin/observability/")) {
    if (await handleObservabilityApi(req, res, path)) return
  }
  // /api/admin/logs/stream — SSE tail of the daemon's stdout. Mirrors
  // `agentx daemon logs -f`. On systemd-managed nodes this calls
  // journalctl; on others it falls back to /tmp/agentx-daemon.log.
  if (method === "GET" && path === "/api/admin/logs/stream") {
    await streamDaemonLogs(req, res)
    return
  }
  // /api/admin/doctor — preflight check JSON. Same shape as
  // `agentx doctor --json`, served in-process.
  if (method === "GET" && path === "/api/admin/doctor") {
    try {
      const { runDoctorChecks } = await import("@/commands/doctor")
      const url = new URL(req.url || "/", "http://_")
      const running = url.searchParams.get("running") !== "false"
      const result = await runDoctorChecks({ running })
      sendJson(res, 200, result)
    } catch (e: any) {
      sendJson(res, 500, { error: e?.message || String(e) })
    }
    return
  }
  // /admin/ledger — read-only window over .agentx/intent/ledger.sqlite.
  // Mirrors `agentx ledger stats/events/divergences/active`. Replay and
  // lineage stay CLI-only.
  if (method === "GET" && path === "/admin/ledger") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderLedgerPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  if (method === "GET" && path.startsWith("/api/admin/ledger/")) {
    if (await handleLedgerApi(req, res, path)) return
  }
  // /admin/cost — token-spend page. Replaces the standalone
  // `agentx usage serve` (port 4201) and the Cost tab inside Health.
  if (method === "GET" && path === "/admin/cost") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderCostPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  // /admin/wiki/* — wiki UI mounted natively into the dashboard. Same
  // renderer as `agentx wiki serve`, no second port required. The wiki
  // hub instance is created lazily on first request and reused for the
  // lifetime of the dashboard process; updates from `wiki absorb` are
  // picked up because each render rebuilds its index from disk.
  if (method === "GET" && (path === "/admin/wiki" || path.startsWith("/admin/wiki/"))) {
    if (path === "/admin/wiki") {
      // Trailing slash so internal links stay relative to the mount.
      res.writeHead(302, { Location: "/admin/wiki/" })
      res.end()
      return
    }
    await getOrCreateWikiHandler(ctx)(req, res)
    return
  }
  // /admin/activity-graph — perspective lens over the intent ledger.
  if (method === "GET" && path === "/admin/activity-graph") {
    handleActivityGraphGet(req, res, buildTopbarPeers(ctx.config))
    return
  }
  if (method === "GET" && path === "/api/admin/activity-graph") {
    if (await handleActivityGraphApi(req, res, path)) return
  }
  if (method === "GET" && path.startsWith("/api/admin/activity-graph/stream")) {
    if (await handleActivityGraphStream(req, res, path)) return
  }
  if (method === "GET" && path.startsWith("/api/admin/activity-graph/dispatch/")) {
    if (await handleActivityGraphDetail(req, res, path)) return
  }
  // /admin/agents/<id> — dedicated per-agent page with md editor + skill mgr.
  const agentPageMatch = method === "GET" && path.match(/^\/admin\/agents\/([a-z0-9][a-z0-9_-]*)$/)
  if (agentPageMatch) {
    handleAgentPageGet(req, res, agentPageMatch[1], buildTopbarPeers(ctx.config), ctx.token)
    return
  }
  // (Cross-mesh proxy is now handled at the top of /api/admin/*. The
  // local-token enforcement below still runs for any admin call that
  // didn't match a specific handler above.)
  if (path.startsWith("/api/admin/")) {
    // Local admin calls: enforce dashboard.token (if configured) BEFORE the
    // dispatcher runs. The legacy ctx.token check further down only catches
    // paths nothing else handled — admin routes were silently bypassing it.
    if (ctx.token) {
      const authHeader = req.headers.authorization || ""
      const got = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
      if (got !== ctx.token) {
        const tokStore = new TokenStore()
        const rec = got ? tokStore.verify(got) : null
        if (!rec || !recordHasScope(rec, "dashboard:write")) {
          sendJson(res, 401, { error: "unauthorized" })
          return
        }
      }
    }
  }
  if (method === "GET" && path === "/api/admin/config") {
    await handleAdminConfigGet(req, res)
    return
  }
  if (path.startsWith("/api/admin/graph/")) {
    await handleGraphApi(req, res, path)
    return
  }
  if (path.startsWith("/api/admin/agent/")) {
    await handleAgentApi(req, res, path)
    return
  }
  if (path.startsWith("/api/admin/")) {
    await handleAdminApi(req, res, path)
    return
  }
  if (method === "GET" && path === "/sortable.min.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" })
    res.end(SORTABLE_JS)
    return
  }

  // Serve the web-bundled editor artifact. Built by `tsup --config tsup.web.config.ts`
  // to dist/web/workflow-editor.js. Any `/assets/<name>` request is mapped
  // 1:1 into dist/web so future bundles (graph editor, ...) can live there
  // without another route registration.
  if (method === "GET" && path.startsWith("/assets/")) {
    const rel = path.slice("/assets/".length)
    // Allow dotted stems (e.g. "workflow-editor.global.js") but keep the
    // whitelist narrow to script/map/style files.
    if (!/^[a-zA-Z0-9._-]+\.(js|map|css)$/.test(rel)) {
      sendJson(res, 400, { error: "invalid asset name" }); return
    }
    const assetPath = resolveFromHere("web/" + rel)
    try {
      const buf = await readAsset(assetPath)
      const ct = rel.endsWith(".map") ? "application/json; charset=utf-8"
        : rel.endsWith(".css") ? "text/css; charset=utf-8"
        : "application/javascript; charset=utf-8"
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public, max-age=60" })
      res.end(buf)
    } catch {
      sendJson(res, 404, { error: "asset not found", hint: "run: npm run build:web" })
    }
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

  // --- Public agent endpoint (always token-gated, regardless of dashboard.token) ---
  const publicAgentMatch = path.match(/^\/api\/public\/agents\/([^/]+)\/messages$/)
  if (publicAgentMatch && method === "POST") {
    const agentId = publicAgentMatch[1]
    const tokenRec = requireScopedToken(req, res, [`agent:${agentId}`])
    if (!tokenRec) return
    await proxyPublicAgentMessage(req, res, ctx.config, agentId)
    return
  }

  if (path.startsWith("/api/") && ctx.token) {
    // Legacy: if dashboard.token is configured, every /api/* request must
    // carry it (or a scoped token with dashboard:write).
    const authHeader = req.headers.authorization || ""
    const got = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (got === ctx.token) { /* fall through */ }
    else {
      const tokStore = new TokenStore()
      const rec = got ? tokStore.verify(got) : null
      if (!rec || !recordHasScope(rec, "dashboard:write")) {
        sendJson(res, 401, { error: "unauthorized" })
        return
      }
    }
  }

  const isWrite = method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT"
  if (isWrite && path.startsWith("/api/")) {
    const xr = req.headers["x-requested-with"]
    if (xr !== "agentx-board") { sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" }); return }
  }

  // Read-through proxies for runs. The dashboard's local RunStore only
  // sees runs home-noded on THIS machine, but the user typically wants
  // the cross-fleet view: runs fired on clawd-server when GitLab events
  // land there, runs fired on Mac when local channels fire. We merge
  // the local list with the main-daemon's list and return the union.
  // Fan-out SSE proxy for /events — multiplexes every configured peer
  // daemon's event stream into a single stream. Lets the board-dashboard
  // show live activity across the whole fleet.
  if (method === "GET" && path === "/events") {
    const url = new URL(req.url || "/", "http://localhost")
    const qs = url.searchParams.toString()
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    })
    const targets: Array<{ name: string; url: string; token?: string }> = [
      { name: ctx.config.node.name || "local", url: ctx.config.dashboard.daemonUrl, token: ctx.config.dashboard.token },
      ...(ctx.config.dashboard.daemons || []).map((d) => ({ name: d.name, url: d.url, token: d.token })),
    ]
    const closed = { flag: false }
    const controllers: AbortController[] = []
    req.on("close", () => { closed.flag = true; for (const c of controllers) try { c.abort() } catch { /* */ } })
    // Heartbeat — some proxies drop idle SSE at 30s.
    const heartbeat = setInterval(() => { if (!closed.flag) { try { res.write(": ping\n\n") } catch { /* */ } } }, 15000)
    req.on("close", () => clearInterval(heartbeat))
    for (const t of targets) {
      void (async () => {
        const headers: Record<string, string> = { Accept: "text/event-stream" }
        if (t.token) headers["Authorization"] = `Bearer ${t.token}`
        const ctrl = new AbortController()
        controllers.push(ctrl)
        try {
          const r = await fetch(`${t.url.replace(/\/+$/, "")}/events${qs ? `?${qs}` : ""}`, { headers, signal: ctrl.signal })
          if (!r.ok || !r.body) return
          const reader = r.body.getReader()
          const dec = new TextDecoder()
          let buf = ""
          while (!closed.flag) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let idx: number
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              if (closed.flag) break
              try { res.write(frame + "\n\n") } catch { closed.flag = true }
            }
          }
        } catch { /* ignore — peer disconnected or aborted */ }
      })()
    }
    return
  }

  if (method === "GET" && path === "/api/workflows/runs") {
    try {
      const url = new URL(req.url || "/", "http://localhost")
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 50)))
      const workflowId = url.searchParams.get("workflowId") || undefined
      // summary=1 strips the per-run context blob (full webhook payloads,
      // per-node outputs — routinely 10-50KB each) and trims history to
      // the last 5 entries. Cuts a 100-run mesh-aggregated response from
      // multi-MB / 30s+ down to ~100KB / 1s. Run-detail (GET /runs/:id)
      // and SSE stream still return the full shape unchanged.
      const summary = url.searchParams.get("summary") === "1" || url.searchParams.get("summary") === "true"
      const local = ctx.workflowRuns.list({ limit, workflowId })
      const qs = `?limit=${limit}${workflowId ? `&workflowId=${encodeURIComponent(workflowId)}` : ""}${summary ? "&summary=1" : ""}`
      // Fan out to every configured peer daemon in parallel. Primary
      // (dashboard.daemonUrl) gets the dashboard.token; entries in
      // dashboard.daemons use their own per-peer token. The summary flag
      // is forwarded so peer daemons also slim their responses (the daemon
      // handler in src/daemon/index.ts honors the same query param).
      const targets: Array<{ url: string; token?: string }> = [
        { url: ctx.config.dashboard.daemonUrl, token: ctx.config.dashboard.token },
        ...(ctx.config.dashboard.daemons || []).map((d) => ({ url: d.url, token: d.token })),
      ]
      const remoteLists = await Promise.all(targets.map(async (t) => {
        const headers: Record<string, string> = {}
        if (t.token) headers["Authorization"] = `Bearer ${t.token}`
        try {
          // 5s timeout per peer — a slow/unhealthy mesh node must not pin
          // the dashboard's first paint forever. AbortController keeps the
          // existing fetch ergonomics; on timeout we just skip this peer's
          // contribution and merge whatever we have.
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 5000)
          try {
            const r = await fetch(`${t.url.replace(/\/+$/, "")}/api/workflows/runs${qs}`, { headers, signal: ctrl.signal })
            if (!r.ok) return []
            const data = await r.json() as { runs?: WorkflowRun[] }
            return Array.isArray(data.runs) ? data.runs : []
          } finally {
            clearTimeout(timer)
          }
        } catch { return [] }
      }))
      const byId = new Map<string, WorkflowRun>()
      for (const r of local) byId.set(r.id, r)
      for (const list of remoteLists) for (const r of list) byId.set(r.id, r)
      const merged = Array.from(byId.values()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit)
      // Ensure the local runs the listing returns are also slimmed; the
      // handleWorkflowsApi path further down does this for its branch but
      // we never reach it because this handler returns first.
      const out = summary ? merged.map((r) => slimRun(r)) : merged
      sendJson(res, 200, { runs: out })
    } catch (e: any) {
      sendJson(res, 502, { error: "runs fetch failed", message: e.message || String(e) })
    }
    return
  }
  const runDetailMatch = method === "GET" && path.match(/^\/api\/workflows\/runs\/([^\/]+)$/)
  if (runDetailMatch) {
    const runId = decodeURIComponent(runDetailMatch[1])
    const local = ctx.workflowRuns.get(runId)
    if (local) { sendJson(res, 200, { run: local }); return }
    // Try every peer until one returns the run. First hit wins.
    const targets: Array<{ url: string; token?: string }> = [
      { url: ctx.config.dashboard.daemonUrl, token: ctx.config.dashboard.token },
      ...(ctx.config.dashboard.daemons || []).map((d) => ({ url: d.url, token: d.token })),
    ]
    for (const t of targets) {
      try {
        const headers: Record<string, string> = {}
        if (t.token) headers["Authorization"] = `Bearer ${t.token}`
        const r = await fetch(`${t.url.replace(/\/+$/, "")}/api/workflows/runs/${encodeURIComponent(runId)}`, { headers })
        if (r.ok) {
          sendJson(res, 200, await r.json())
          return
        }
      } catch { /* try next */ }
    }
    sendJson(res, 404, { error: "run not found on any configured peer" })
    return
  }

  // Draft replay — fires an ad-hoc workflow run on the daemon. Lives on
  // the daemon (not in workflows-api.ts) because it needs the dispatcher
  // and the trace store. The dashboard saves drafts directly to disk via
  // PUT /api/workflows/drafts/:id, then proxies the replay through here.
  const draftReplayMatch = method === "POST" && path.match(/^\/api\/workflows\/drafts\/([^/]+)\/replay$/)
  if (draftReplayMatch) {
    try {
      const body = await readJson(req).catch(() => ({}))
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const daemonUrl = ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      const r = await fetch(`${daemonUrl}/api/workflows/drafts/${encodeURIComponent(draftReplayMatch[1])}/replay`, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
      })
      const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
      sendJson(res, r.status, data)
    } catch (e: any) {
      sendJson(res, 502, { error: "daemon unreachable", message: e.message || String(e) })
    }
    return
  }

  // Workflow-builder chat (proxies to main daemon where the dispatcher
  // + AgentRegistry live). The board-dashboard serves /workflows/editor
  // but runs its own workflow stores; the chat endpoint needs the
  // running agent registry, which only the main daemon has.
  if (method === "POST" && path === "/api/workflows/editor/chat") {
    try {
      const body = await readJson(req)
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const daemonUrl = ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      const r = await fetch(`${daemonUrl}/api/workflows/editor/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
      })
      const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
      sendJson(res, r.status, data)
    } catch (e: any) {
      sendJson(res, 502, { error: "daemon unreachable", message: e.message || String(e) })
    }
    return
  }

  // /api/workflows/tasks[*] — BPM inbox API lives on the daemon (the
  // dispatcher owns the TaskStore + run-resume plumbing). Proxy through
  // so the /inbox page on the dashboard works the same as on the daemon.
  if (path.startsWith("/api/workflows/tasks") && (method === "GET" || method === "POST")) {
    try {
      const t = ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(ctx.config.dashboard.token ? { Authorization: `Bearer ${ctx.config.dashboard.token}` } : {}),
      }
      const body = method === "POST"
        ? await new Promise<string>((resolve) => {
            const chunks: Buffer[] = []
            req.on("data", (c) => chunks.push(c))
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
          })
        : undefined
      const r = await fetch(`${t}${req.url}`, { method, headers, body })
      const text = await r.text()
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" })
      res.end(text)
    } catch (e: any) {
      sendJson(res, 502, { error: "tasks proxy failed", message: e?.message || String(e) })
    }
    return
  }

  // Workflow API — read (dashboard:read) / write (dashboard:write). Fine-
  // grained scope checks let read-only scoped tokens still populate the
  // /workflows observability page when dashboard.token isn't configured.
  if (path.startsWith("/api/workflows")) {
    const handled = handleWorkflowsApi(req, res, {
      store: ctx.workflowStore,
      runs: ctx.workflowRuns,
      layouts: ctx.workflowLayouts,
      requireScope: (r, s, scopes) => {
        // When ctx.token is set the legacy check above already verified
        // write scope on any /api call, so we don't re-gate here.
        // When it's not set (localhost default), enforce scopes ourselves
        // only if the caller *presented* a token — otherwise allow through
        // to preserve the loopback "safe default" UX.
        if (ctx.token) return true
        const presented = extractToken(r as any)
        if (!presented) return true
        const rec = new TokenStore().verify(presented)
        if (!rec) { sendJson(s, 401, { error: "invalid or revoked token" }); return false }
        for (const scope of scopes) {
          if (!recordHasScope(rec, scope)) { sendJson(s, 403, { error: `token missing scope: ${scope}`, scopes: rec.scopes }); return false }
        }
        return true
      },
    })
    if (handled) return
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

/** Trim a WorkflowRun to just the fields the listing UI needs. Drops the
 *  per-run `context` (full webhook payload + per-node outputs, often 10-50KB
 *  each) and clips `history` to the last 5 entries. Both the dashboard's
 *  mesh-aggregation handler and workflows-api.ts call this for `summary=1`
 *  responses; the shape MUST match between the two so the page doesn't see
 *  divergent fields per code path. */
function slimRun(r: WorkflowRun): Partial<WorkflowRun> {
  return {
    id: r.id,
    workflowId: r.workflowId,
    workflowVersion: r.workflowVersion,
    homeNode: r.homeNode,
    status: r.status,
    pending: r.pending,
    entityRef: r.entityRef,
    history: (r.history || []).slice(-5),
    parentRunId: r.parentRunId,
    parentNodeId: r.parentNodeId,
    rootRunId: r.rootRunId,
    depth: r.depth,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

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
    hourlyTasks?: number[]
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
      hourlyTasks: Array.isArray(a.hourlyTasks) ? a.hourlyTasks : undefined,
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

// Lazy /admin/wiki/* handler — built once per dashboard process. The
// WikiHub it wraps reads articles from disk on every request (no
// in-memory cache), so absorbs and edits from elsewhere show up
// without a restart.
let _wikiHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null
function getOrCreateWikiHandler(ctx: { config: DaemonConfig; token?: string }): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (_wikiHandler) return _wikiHandler
  const wikiDir = resolve(process.cwd(), ".agentx/wiki")
  // Match the CLI defaults exactly so the embedded view renders the
  // same hub/sidebar/article markup as `agentx wiki serve` does — they
  // share the handler, but mode changes which `hubHome`/`hubSidebar`
  // branches fire (graph mode adds the article-list + type-label).
  _wikiHandler = createWikiHandler({
    wikiDir,
    pathPrefix: "/admin/wiki",
    mode: "graph",
    // No remote-peer browsing in the embedded view — keeps the dashboard
    // independent of mesh state. Operators who want cross-mesh wiki nav
    // can still run `agentx wiki serve --peer <url>`.
  })
  // ctx is passed for future use (auth etc.) but unused right now.
  void ctx
  return _wikiHandler
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
 * Reject the request with 401 unless the caller presents a scoped token that
 * covers *all* of the required scopes. Returns the matching record on success,
 * or null after writing the 401 (so callers can early-return).
 */
function requireScopedToken(
  req: IncomingMessage,
  res: ServerResponse,
  required: string[],
): TokenRecord | null {
  const token = extractToken(req as any)
  if (!token) {
    sendJson(res, 401, { error: "missing token", hint: "pass Authorization: Bearer <token> (agentx token create)" })
    return null
  }
  const rec = new TokenStore().verify(token)
  if (!rec) {
    sendJson(res, 401, { error: "invalid or revoked token" })
    return null
  }
  for (const s of required) {
    if (!recordHasScope(rec, s)) {
      sendJson(res, 403, { error: `token missing scope: ${s}`, scopes: rec.scopes })
      return null
    }
  }
  return rec
}

/**
 * Public agent endpoint — external apps POST a message, we forward to the
 * daemon's /task and return the final response. Only agents whose config
 * says `access: "public"` are reachable.
 */
async function proxyPublicAgentMessage(
  req: IncomingMessage,
  res: ServerResponse,
  config: DaemonConfig,
  agentId: string,
): Promise<void> {
  const agentDef = (config.agents as any)?.[agentId]
  if (!agentDef) { sendJson(res, 404, { error: "unknown agent" }); return }
  if (agentDef.access !== "public") {
    sendJson(res, 403, { error: "agent is private", hint: `set agents.${agentId}.access = "public" to expose it` })
    return
  }
  let body: any
  try { body = await readJson(req) } catch { sendJson(res, 400, { error: "invalid JSON body" }); return }
  const message = body?.message
  if (!message || typeof message !== "string") {
    sendJson(res, 400, { error: "required: { message: string, context?: {...} }" })
    return
  }
  const daemonUrl = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.dashboard.token) headers["Authorization"] = `Bearer ${config.dashboard.token}`
  try {
    const upstream = await fetch(`${daemonUrl}/task`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: agentId,
        message,
        context: {
          channel: "public-api",
          sender: body.context?.sender || "api",
          ...(body.context || {}),
        },
      }),
    })
    const text = await upstream.text()
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    })
    res.end(text)
  } catch (e: any) {
    sendJson(res, 502, { error: e.message || "upstream call failed" })
  }
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

/** Resolve a path relative to THIS module's directory at runtime.  After
 *  tsup bundles dist/board-dashboard-*.js is placed in dist/, so
 *  `../../dist/web/foo.js` is relative to wherever the bundled module
 *  actually runs. `fileURLToPath(import.meta.url)` is the ESM equivalent
 *  of __filename. */
function resolveFromHere(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, rel)
}

async function readAsset(path: string): Promise<Buffer> {
  return readFile(path)
}

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


// --- Live full-screen page (/live) ---



/**
 * Derive a peer's board-dashboard URL from a dashboard.daemons[] entry.
 * Uses the explicit dashboardUrl override if set; otherwise swaps the
 * daemon's port (18800 / 19900 / 18810) for :4202, matching our convention
 * that the dashboard runs alongside the daemon.
 */
function resolvePeerDashboardUrl(d: { url: string; dashboardUrl?: string }): string {
  if (d.dashboardUrl) return d.dashboardUrl.replace(/\/+$/, "")
  return d.url.replace(/\/+$/, "").replace(/:(?:1[89][89]00|18810)$/, ":4202")
}

/**
 * Build the peers list shown in the topbar mesh selector. Combines the
 * primary daemon + any `dashboard.daemons[]` entries.
 */
function buildTopbarPeers(config: DaemonConfig, ctxConfig?: DaemonConfig): TopbarPeer[] {
  const cfg = ctxConfig || config
  const primary: TopbarPeer = {
    id: "primary",
    name: cfg.node?.name || "this daemon",
    dashboardUrl: "",  // empty = stay on current origin
    primary: true,
  }
  const extras: TopbarPeer[] = (cfg.dashboard?.daemons || []).map((d) => ({
    id: d.url.replace(/\/+$/, ""),
    name: d.name,
    dashboardUrl: resolvePeerDashboardUrl(d),
    tokenScope: (d.dashboardToken || d.token) ? "proxy-ready" : undefined,
  }))
  // Fleet pseudo-peer: only meaningful when there's at least one
  // remote peer to merge with. Placed at the bottom so users tend to
  // notice it after they've used the per-peer entries first.
  const fleet: TopbarPeer[] = extras.length > 0
    ? [{
        id: "fleet",
        name: "Fleet (all peers)",
        dashboardUrl: "",
        tokenScope: "merged across nodes",
      }]
    : []
  return [primary, ...extras, ...fleet]
}

/**
 * Forward the entire incoming admin request to the selected peer's
 * dashboard. Copies method, query string, body, and Content-Type. Auth
 * replaces anything the browser sent with the peer's configured token so
 * the local dashboard.token (if any) doesn't leak across nodes.
 */
/** Fleet-mode activity-graph snapshot: build the local snapshot in-process,
 *  fetch every configured peer's snapshot via its dashboard API, merge.
 *  Per-peer failures don't fail the whole call — they're just dropped from
 *  the merge and logged, so a single dead peer doesn't black out the view. */
async function handleActivityGraphFleet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { config: DaemonConfig; token?: string },
): Promise<void> {
  const url = new URL(req.url || "/", "http://_")
  const hours = parseInt(url.searchParams.get("hours") || "6", 10) || 6
  const localNodeId = ctx.config.node?.id || ctx.config.node?.name || "local"

  const parts: Array<{ nodeId: string; snap: FleetSnapshot }> = []

  // Local node: in-process call, no HTTP round-trip.
  const localSnap = buildLocalActivityGraphSnapshot(hours)
  if (localSnap) parts.push({ nodeId: localNodeId, snap: localSnap })

  // Each configured peer: HTTP fetch via the existing per-peer proxy logic.
  // Fire in parallel; whichever peers respond on time get merged in.
  const peerEntries = (ctx.config.dashboard?.daemons || []).filter((d) => d.url)
  await Promise.all(peerEntries.map(async (d) => {
    const peer = findPeer(d.url.replace(/\/+$/, ""), ctx.config)
    if (!peer) return
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 8000)
      try {
        const r = await fetch(`${peer.url}/api/admin/activity-graph?hours=${hours}`, {
          headers: {
            "Accept": "application/json",
            "X-Agentx-Peer": "primary",
            ...(peer.token ? { Authorization: `Bearer ${peer.token}` } : {}),
          },
          signal: ac.signal,
        })
        if (!r.ok) return
        const snap = await r.json() as FleetSnapshot
        parts.push({ nodeId: d.name || d.url, snap })
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // Drop this peer from the merge; the rest of the snapshot remains usable.
    }
  }))

  sendJson(res, 200, mergeFleetSnapshots(parts))
}

/** SSE-stream the daemon's stdout to the dashboard /admin/health Logs tab.
 *  Picks the best available source: prefers `journalctl -u agentx -f`
 *  (systemd-managed nodes like clawd-server), falls back to `tail -F` on
 *  /tmp/agentx-daemon.log (Mac dev launches), or the tail of the
 *  workspace pid log if neither exists. Mirrors the source the
 *  `agentx daemon logs -f` CLI hits, so both surfaces show the same
 *  data.
 *
 *  The spawned process inherits the dashboard's permissions; on
 *  clawd-server `clawd` already has read access to its agentx unit's
 *  journal via the systemd-journal group (no sudo needed). On Mac the
 *  log file is world-readable. */
async function streamDaemonLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { spawn, execSync } = await import("child_process")

  // Prefer journalctl when available — it captures stdout from systemd,
  // which is where the daemon's logs actually land on prod. Fall back to
  // the legacy /tmp file the CLI uses.
  let cmd: string
  let args: string[]
  try {
    execSync("which journalctl", { stdio: "pipe" })
    cmd = "journalctl"
    args = ["-u", "agentx", "--no-pager", "-n", "200", "-f", "-o", "cat"]
  } catch {
    // Mac (launchd) logs to ~/.agentx/logs/daemon-stdout.log; the legacy
    // /tmp/agentx-daemon.log is the foreground-launch path. Probe both.
    const home = process.env.HOME || ""
    const candidates = [
      home && `${home}/.agentx/logs/daemon-stdout.log`,
      "/tmp/agentx-daemon.log",
    ].filter(Boolean) as string[]
    const file = candidates.find((f) => existsSync(f))
    if (!file) {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        error: "no log source — install journalctl, run the daemon under launchd, or run it foreground writing to /tmp/agentx-daemon.log",
        searched: candidates,
      }))
      return
    }
    cmd = "tail"
    args = ["-F", "-n", "200", file]
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  })
  res.write(`: source=${cmd}\n\n`)

  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
  let buffer = ""
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let idx
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "")
      buffer = buffer.slice(idx + 1)
      // SSE: each line gets its own `event: line` so the client can
      // listen by name. Escape newlines defensively (lines should not
      // contain any since we split on them, but be safe).
      try { res.write(`event: line\ndata: ${line.replace(/\n/g, " ")}\n\n`) } catch { /* */ }
    }
  }
  child.stdout?.on("data", onData)
  // Mirror stderr too so the operator sees crash output.
  child.stderr?.on("data", onData)

  // Heartbeat keeps middleboxes from idling the connection out.
  const hb = setInterval(() => {
    try { res.write(`: hb\n\n`) } catch { /* */ }
  }, 15_000)

  const cleanup = () => {
    clearInterval(hb)
    try { child.kill() } catch { /* */ }
    try { res.end() } catch { /* */ }
  }
  req.on("close", cleanup)
  child.on("exit", cleanup)
  child.on("error", cleanup)
}

async function proxyAdminToPeer(
  req: IncomingMessage,
  res: ServerResponse,
  peer: { url: string; token?: string },
  pathWithQuery: string,
): Promise<void> {
  const target = peer.url + pathWithQuery
  // Read the incoming body (if any). For GET/HEAD there's no body to drain.
  const method = (req.method || "GET").toUpperCase()
  const hasBody = method !== "GET" && method !== "HEAD"
  const body: Buffer | undefined = hasBody
    ? await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on("data", (c: Buffer) => chunks.push(c))
        req.on("end", () => resolve(Buffer.concat(chunks)))
        req.on("error", reject)
      })
    : undefined

  const headers: Record<string, string> = {}
  const ct = req.headers["content-type"]
  if (ct) headers["Content-Type"] = Array.isArray(ct) ? ct[0] : ct
  const xrw = req.headers["x-requested-with"]
  if (xrw) headers["X-Requested-With"] = Array.isArray(xrw) ? xrw[0] : xrw
  if (peer.token) headers["Authorization"] = `Bearer ${peer.token}`
  // Tell the peer not to recurse — belt-and-braces guard.
  headers["X-Agentx-Peer"] = "primary"

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: body && body.length > 0 ? body : undefined,
    })
    const respBody = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    })
    res.end(respBody)
  } catch (e: any) {
    sendJson(res, 502, { error: `proxy to peer failed: ${e?.message || e}`, target })
  }
}

/**
 * Look up a peer by id (matches `dashboard.daemons[].url` normalised) so
 * the proxy middleware knows where to forward + what token to use.
 */
function findPeer(id: string, config: DaemonConfig): { url: string; token?: string } | null {
  const peerId = id.replace(/\/+$/, "")
  const match = (config.dashboard?.daemons || []).find((d) => d.url.replace(/\/+$/, "") === peerId)
  if (!match) return null
  return {
    url: resolvePeerDashboardUrl(match),
    token: match.dashboardToken || match.token,
  }
}

/**
 * Cross-surface theme switcher. Reads persisted theme from localStorage BEFORE
 * first paint (dropped into <head> to avoid FOUC), then wires any segmented
 * control with [data-theme-opt="..."] buttons once the DOM is ready.
 */





