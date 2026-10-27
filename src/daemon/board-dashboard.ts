import { readMonitorBody, monitorTargets } from "./session-monitor"
import { cronValueOf, type CronValue } from "@/crons/value-line"
import { renderMonitorPage } from "./ui/pages/monitor"
import { renderActivityPage } from "./ui/pages/activity"
import { renderWorkflowEditorPage } from "./ui/pages/workflow-editor"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { appendFileSync, existsSync, mkdirSync } from "fs"
import { readFile } from "fs/promises"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"
import type { DaemonConfig } from "./config"
import { dashboardTokenForNode } from "./mesh-auth"
import { handleLogin, hasSession, hasStreamTicket, isOffBox, pageToken, redirectToLogin, streamTicket, STREAM_TICKET_TTL_S } from "./dashboard-session"
import { loadOperatorKey, OPERATOR_HEADER } from "@/requests/operator"
import { currentPeople, handleMemberRequest } from "./member-routes"
import { MemberStore } from "@/members/store"
import { forgeLink } from "@/members/work"
import type { BoardConfig, BoardColumn } from "@/boards/config"
import { deriveStage, transitionDiff } from "@/boards/config"
import type { WorkSource, WorkItem } from "@/business/work-pool"
import { GitLabWorkSource } from "@/business/work-pool"
import { SORTABLE_JS } from "./vendor/sortable"
import { handleWizardGet, handleWizardPost, handleStartDaemonPost, wizardState } from "./setup-wizard"
import { handleAdminGet, handleAdminApi, handleAdminConfigGet } from "./admin-panel"
import { readVoiceHealth } from "@/voice/voice-health"
import { handleGraphGet, handleGraphApi } from "./graph-panel"
import { handleApprovalsPageGet, handleApprovalsPanelApi } from "./approvals-panel"
import { handlePeoplePanel } from "./people-panel"
import { handleObservabilityGet, handleObservabilityApi } from "./observability-panel"
import { handleLedgerApi, renderLedgerPage } from "./ledger-panel"
import { renderProjectsPage } from "./ui/pages/projects"
import { createWikiHandler } from "@/wiki/serve"
import { recordSurfaceUse } from "@/observability/surface-usage"
import { handleActivityGraphApi, handleActivityGraphStream, handleActivityGraphDetail, setDaemonConfigForActivityGraph, buildLocalActivityGraphSnapshot, mergeFleetSnapshots, withForgeStatus, type FleetSnapshot } from "./activity-graph-panel"
import { handleAgentPageGet, handleAgentApi } from "./agent-panel"
import { renderWallPage, WALL_LIVE_HREF } from "./ui/pages/wall"
import { WALL_COST_HREF } from "./ui/pages/wall-cost"
import { renderOrgPage } from "./ui/pages/org"
import { renderMeshPage } from "./ui/pages/mesh"
import { renderGuestsPage } from "./ui/pages/guests"
import { fetchMeshAnalytics, fetchMeshDay, proxyNodeAnalytics, type NodeTarget } from "./mesh-analytics-api"
import { renderWorkflowsPage } from "./ui/pages/workflows"
import { classicRedirect } from "./ui/classic-routes"
import { renderHistoryPage } from "./ui/pages/history"
import { handleWorkflowsApi } from "./workflows-api"
import { ROUTINE_LIMITS, type Routine } from "./routines"
import { LayoutStore, RunStore, WorkflowStore, type WorkflowRun } from "@/workflows"
import { progressGroups, slimPausedAt } from "@/workflows/follow-up"
import { readRequiredSettings, updateRequiredSettings, type RequiredSettingsPatch } from "@/daemon/workflow-required-settings"
import { budgetPatchProblem, updateBudget, type BudgetPatch } from "@/daemon/budget-settings"
import { TokenStore, recordHasScope, extractToken, type TokenRecord } from "./token-store"
import { handleAppRequest } from "./app-routes"
import { appReachDeps, type AppReachDeps } from "./app-reach"
import { dashboardIcon } from "./app-icon"
import { assetLinks, handleDashboardPlaces, placesDeps, type PlacesDeps } from "./app-places"
import { pinsDeps } from "./app-pins"
import { daemonFireDeps } from "@/places/fire"
import { relayedPush, relayedPushHere, type AppPushDeps } from "./app-push"
import { appAnnounceDeps } from "./app-announce"
import { PushStore } from "@/channels/push-store"
import { AppChatStore } from "./app-chat-store"
import { appPresence, type AppChatDeps, type AppMeshPeer } from "./app-chat"
import { AppCallbackPuller, type CallbackEvent, type CallbackReplyBody } from "./app-chat-callbacks"
import type { AppVoiceDeps } from "./app-voice"
import type { AppCameraDeps } from "./app-camera"
import { pushKeysPath, readPushKeys } from "@/channels/push-keys"
import { openDb } from "@/storage/sqlite"
import { logSlowQueries } from "@/storage/slow-queries"
import type { AppFleetDeps, NodeApprovals, NodeReply } from "./app-fleet"
import { inboxToDesk, readOwnerList } from "@/desk/owner-list"
import type { AppDeskDeps } from "./app-desk"
import { buildDesk, DESK_DONE_DAYS, DESK_DONE_MAX, liveRunRefs, type DeskRequest } from "@/desk/board"
import { listCards, type DecisionCard } from "@/approvals/cards"
import { readInboxState } from "@/approvals/state"
import { handleRequestsPanel, REQUESTS_PANEL_PREFIX } from "./requests-panel"
import { decide, listInbox, planStoreFor, requestStoreFor, type InboxItem } from "@/approvals/inbox"
import { readRequestSettings } from "@/requests/settings"
import { handleWallApi, WALL_PREFIX, withForge, type WallDeps } from "./wall-api"
import { gitlabTimeReader, wallForgeTime, type WallForgeTimeSource } from "./wall-forge-time"
import { wallForgeState, type WallForgeStateSource } from "./wall-forge-state"
import { reportedReader, wallReported, withReported, type WallReportedSource } from "./wall-reported"
import { forgeReader } from "@/requests/checkers/issue"
import { handlePortfolioRequest } from "./wall-portfolio"
import { claimPost, projectOverview, wallProjects } from "./wall-projects"
import { mergeGoals } from "./wall-goals"
import { claimClosure, wallThroughput, type WallClosure } from "./wall-throughput"
import { handleWallReviews, WALL_REVIEWS_PATH } from "./wall-reviews"
import { handleWallAction, isWallActionPath, isWallWrite, WALL_BUDGET_PATH, type Reply as WallReply } from "./wall-actions"
import { claimBlocker } from "./wall-blocks"
import { wallCapacity } from "./wall-capacity"
import { forgeConnectorsOf } from "@/requests/drift/live"
import { chatKey, findOverlaps, worktreeKey, type RunOverlap, type RunSpan } from "./concurrent-runs"
import { readApprovalSettings } from "@/approvals/settings"
import { classifyBrowserRequest, isStateChangingOrPreflight } from "./browser-origin"
import { headerBuild, setTopbarFeatures, type TopbarPeer } from "./topbar"
import { handleModelSetupApi, MODEL_KEY_PATH, MODEL_READY_PATH } from "./model-setup-api"
import { handleAgentChatApi } from "./agent-chat-api"

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

/** The database the pages read, with any query that holds this process for
 *  200 ms or longer named in the log (#448): one such query stops every page. */
function dashboardDb(): ReturnType<typeof openDb> {
  const db = openDb()
  if (db) logSlowQueries(db, "dashboard")
  return db
}

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

  // Opened before the first page is served: every later reader in this
  // process shares this handle, so its slow queries are logged too.
  dashboardDb()

  // Compact primary nav. Every other surface stays routable by URL.
  setTopbarFeatures({
    business: config.business?.enabled === true,
  })

  const server = createServer(async (req, res) => {
    try {
      await handleBoardRequest(req, res, { boards, sources, token, config, workflowStore, workflowRuns, workflowLayouts })
    } catch (e: any) {
      sendJson(res, 500, { error: e.message || "internal error" })
    }
  })

  // #277 — replies an agent writes after a delegation, filed in the phone
  // conversation they belong to (app-chat-callbacks.ts).
  appCallbackPuller(config).start()

  server.listen(port, bind, () => {
    const displayHost = bind === "0.0.0.0" ? "localhost" : bind
    console.log(`\n  Dashboard: http://${displayHost}:${port}\n`)
    if (bind === "127.0.0.1" && !token) {
      console.log("  (bound to localhost; no auth token — safe default)")
    } else if (bind !== "127.0.0.1" && !token) {
      console.log("  ⚠ bound to a non-loopback address without a token — writes are UNAUTHENTICATED")
    }
  })
}

/** Every page a human can land on. Kept explicit rather than inferred from
 *  "has no file extension" so assets, redirects and API routes can never
 *  drift into the numbers the reduction decisions are made from. */
const DASHBOARD_PAGES = new Set([
  "/",
  "/live",
  "/wall",
  "/mesh",
  "/monitor",
  "/activity",
  "/workflows",
  "/workflows/editor",
  "/graph",
  "/setup",
  "/admin",
  "/admin/graph",
  "/approvals",
  "/people",
  "/org",
  "/admin/health",
  "/admin/observability",
  "/admin/ledger",
  "/admin/projects",
  "/admin/wiki",
])

/** Retired classic pages and the Wall view each one now opens (#1446). */
export const RETIRED_PAGES: Record<string, string> = {
  "/boards": "/wall#status=open&view=projects",
  "/glossary": "/wall",
  "/procedures": "/wall#page=agents",
  "/processes": "/wall#status=open&view=jobs",
  "/places": "/wall",
}

export interface Ctx {
  boards: BoardConfig[]
  sources: Map<string, WorkSource>
  token?: string
  config: DaemonConfig
  workflowStore: WorkflowStore
  workflowRuns: RunStore
  workflowLayouts: LayoutStore
}

/** Exported for tests only; production requests come through startBoardDashboard. */
export async function handleBoardRequest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost")
  const path = url.pathname
  const method = (req.method || "GET").toUpperCase()

  // Every route below matches `path`, which has dot segments folded and
  // backslashes read as slashes. A proxy that publishes only some paths
  // (a teammate's /member and /api/member, say) may forward the address as
  // it was typed, so "/member/../approvals" would arrive here as
  // "/approvals". Only an address sent in its normal form is served (#452).
  if ((req.url || "/").split(/[?#]/)[0] !== path) {
    sendJson(res, 404, { error: "not found" })
    return
  }

  // No CORS headers: every dashboard page calls this server on its own
  // origin (browser-origin.ts). A page on another origin, localhost on
  // another port included, can't read responses, can't pass a preflight,
  // and its writes stop here: the X-Requested-With check below only holds
  // while no foreign page is allowed to send that header.
  if (classifyBrowserRequest(req.headers) === "foreign" && isStateChangingOrPreflight(method)) {
    sendJson(res, 403, { error: "Forbidden: request from a page on another origin" })
    return
  }
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return }
  // The Wall's owner-only guard (#1454): every write under /api/admin/wall,
  // here or forwarded to a peer, stops here without the owner's token.
  if (isWallWrite(method, path) && !wallOwnerOk(req, ctx)) {
    sendJson(res, 401, { error: "Only the owner writes on the Wall: sign in, or send the dashboard token." })
    return
  }
  // Sign-in for a browser on another machine (#1306, dashboard-session.ts).
  if (await handleLogin(req, res, url, method, ctx.token)) return

  // Phone app. First, above every proxy and the loopback-trusting gates
  // below: /app and /api/app/* always need a device token (app-routes.ts).
  // A teammate's own work page: /member and /api/member/* (member-routes.ts).
  // Same rule as the phone app: a machine's own key or nothing.
  if (await handleMemberRequest(req, res, path, method, {
    nodeName: ctx.config.node?.name, root: process.cwd(), people: () => currentPeople(ctx.config.people),
    members: membersStore(ctx.config.members.logRetentionDays),
    db: () => dashboardDb(), linkFor: (channel, chatId) => forgeLink(channel, chatId, { gitlab: ctx.config.channels.gitlab?.host }),
  })) return
  // The Wall's portfolio summary (#1194): a `wall:portfolio` key or the
  // dashboard key, nothing else; counts and titles only (wall-portfolio.ts).
  if (await handlePortfolioRequest(req, res, path, method, {
    node: localNodeName(ctx.config), dashboardToken: ctx.token,
    posts: (days) => buildWallFleet(new URLSearchParams({ days: String(days) }), ctx) as Promise<any>,
  })) return
  if (await handleAppRequest(req, res, path, method, { nodeName: ctx.config.node?.name, fleet: appFleetDeps(ctx.config), desk: appDeskDeps(ctx.config), push: appPushDeps(ctx.config), announce: appAnnounceDeps(ctx.config), chat: appChatDeps(ctx.config), voice: appVoiceDeps(ctx.config), camera: appCameraDeps(ctx.config), places: appPlacesDeps(ctx.config), pins: pinsDeps(ctx.config, process.cwd()), reach: appReach(), assetLinks: () => assetLinks(ctx.config) })) return

  // The AX symbol as favicon and touch icon. Public: browsers fetch icons
  // without credentials, and they hold no data.
  const icon = method === "GET" ? dashboardIcon(path) : null
  if (icon) {
    res.writeHead(200, { "Content-Type": icon.type, "Cache-Control": "public, max-age=86400" })
    res.end(icon.body)
    return
  }

  // Count which dashboard pages operators actually open. Page paths only —
  // no query strings, no ids, and nothing under /api (those are XHR from a
  // page we already counted, so they'd inflate every number).
  // See docs/architecture/surface-reduction.md.
  if (method === "GET" && DASHBOARD_PAGES.has(path)) {
    recordSurfaceUse("page", path)
  }

  if (method === "GET" && path === "/") {
    // Home is the Wall (#1180, owner decision 2026-10-24): every request
    // as a post with its thread, and what runs on each node now. Live
    // stays at /live, and every other address is unchanged. Boards used to
    // take the root whenever any were configured, which meant the landing
    // page silently changed identity based on config. The Boards page
    // itself is retired (#1446): /boards opens the Wall's Projects view.
    //
    // The one exception is a machine with no agents yet, where there is
    // nothing live to show and the wizard is the only useful destination.
    const wz = wizardState()
    if (!wz.configExists || wz.agentCount === 0) {
      res.writeHead(302, { Location: "/setup" })
      res.end()
      return
    }
    if (!pageAllowed(req, res, ctx, path)) return
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderWallPage({ peers: buildTopbarPeers(ctx.config), localToken: pageToken(req, ctx.token) }))
    return
  }
  // Classic pages retired with no views in 30 days (#1446): each address
  // still works and opens the closest Wall view. The phone app keeps place
  // reminders; only the dashboard's Places page went.
  const retired = method === "GET" ? RETIRED_PAGES[path] : undefined
  if (retired) {
    res.writeHead(302, { Location: retired })
    res.end()
    return
  }
  if (method === "GET" && path === "/wall") {
    if (!pageAllowed(req, res, ctx, path)) return
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderWallPage({ peers: buildTopbarPeers(ctx.config), localToken: pageToken(req, ctx.token) }))
    return
  }
  // Classic Live is on the Wall now (#1439): Resume, Restart when idle and
  // the attached sessions are all on Wall Live, so the old address opens it.
  if (method === "GET" && path === "/live") {
    res.writeHead(302, { Location: WALL_LIVE_HREF })
    res.end()
    return
  }
  // n8n posts here. It is forwarded to the local node rather than served
  // from the dashboard so the operator has ONE address to paste into n8n —
  // the one they are already looking at — instead of learning which port the
  // daemon happens to be on.
  const n8nIn = method === "POST" && path.match(/^\/webhook\/n8n\/[A-Za-z0-9._:-]{1,64}$/)
  if (n8nIn) {
    try {
      const [node] = await resolveNodeTargets(ctx.config)
      if (!node) { sendJson(res, 503, { error: "no node available" }); return }
      const body = await new Promise<string>(resolve => {
        let d = ""; req.on("data", c => (d += c)); req.on("end", () => resolve(d)); req.on("error", () => resolve(""))
      })
      const r = await fetch(node.url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(node.token ? { Authorization: `Bearer ${node.token}` } : {}) },
        body: body || "{}",
      })
      res.writeHead(r.status, { "Content-Type": "application/json" })
      res.end(await r.text())
    } catch (e: any) {
      sendJson(res, 502, { error: "could not reach the node", message: String(e?.message || e) })
    }
    return
  }

  // Workflow-builder chat (proxies to main daemon where the dispatcher
  // + AgentRegistry live). The board-dashboard serves /workflows/editor
  // but runs its own workflow stores; the chat endpoint needs the
  // running agent registry, which only the main daemon has.
  // Ask-an-agent drawer. Every verb proxies to one node: `node` picks which,
  // and a conversation belongs to the node that holds it.
  if (path === "/api/assistant" || path.startsWith("/api/assistant/")) {
    try {
      const targets = await resolveNodeTargets(ctx.config)
      const wanted = method === "POST" ? undefined : url.searchParams.get("node")
      const body: any = method === "POST" ? await readJson(req) : undefined
      const pick = body?.node ?? wanted
      const node = pick ? targets.find(n => n.url === pick) : targets[0]
      if (!node) { sendJson(res, 400, { error: "unknown node" }); return }
      const qs = url.search ? url.search.replace(/([?&])node=[^&]*/, "$1").replace(/[?&]$/, "") : ""
      const r = await fetch(node.url + path + qs, {
        method,
        headers: { "Content-Type": "application/json", ...(node.token ? { Authorization: `Bearer ${node.token}` } : {}) },
        ...(method === "POST" ? { body: JSON.stringify({ ...body, node: undefined }) } : {}),
      })
      sendJson(res, r.status, await r.json().catch(() => ({ error: `HTTP ${r.status}` })))
    } catch (e: any) {
      sendJson(res, 502, { error: "could not reach the node", message: e?.message || String(e) })
    }
    return
  }

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

  if (method === "GET" && path === "/api/n8n/workflows") {
    try {
      const [node] = await resolveNodeTargets(ctx.config)
      if (!node) { sendJson(res, 200, { configured: false, workflows: [] }); return }
      const r = await fetch(node.url + "/api/n8n/workflows", {
        headers: node.token ? { Authorization: `Bearer ${node.token}` } : {},
      })
      sendJson(res, r.status, await r.json().catch(() => ({ configured: false, workflows: [] })))
    } catch {
      sendJson(res, 200, { configured: false, workflows: [] })
    }
    return
  }

  if (method === "GET" && path === "/workflows/editor") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderWorkflowEditorPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  if (method === "GET" && path === "/activity") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderActivityPage({ peers: buildTopbarPeers(ctx.config), view: url.searchParams.get("view"), localToken: pageToken(req, ctx.token) }))
    return
  }
  if (method === "GET" && path === "/monitor") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderMonitorPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  // Wall Live's "Connect a CLI session" (#1439) is the monitor's discover and
  // register, at Wall addresses so the Wall's owner guard (#1454) holds the
  // write. /api/monitor/* itself stays as it was for its other callers.
  const wallCli = method === "POST" && path === WALL_LIVE_CLI_PATH
  const monitorPath = wallCli ? "/api/monitor/register"
    : method === "GET" && path === WALL_LIVE_DISCOVER_PATH ? "/api/monitor/discover" : path
  if (monitorPath === "/api/monitor" || monitorPath.startsWith("/api/monitor/")) {
    if (wallCli && req.headers["x-requested-with"] !== "agentx-board") { sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" }); return }
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 8000)
    try {
      const targets = monitorTargets(await resolveNodeTargets(ctx.config, ac.signal), ctx.config.mesh.peers)
      if (method === "GET" && monitorPath === "/api/monitor") {
        const nodes = await Promise.all(targets.map(async node => {
          try {
            const r = await fetch(node.url + "/monitor", { headers: node.token ? { Authorization: `Bearer ${node.token}` } : {}, signal: ac.signal })
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return { name: node.name, url: node.url, ok: true, data: await r.json() }
          } catch (e: any) { return { name: node.name, url: node.url, ok: false, error: e.message } }
        }))
        sendJson(res, 200, { nodes }); return
      }
      const node = targets.find(n => n.url === url.searchParams.get("node"))
      if (!node) { sendJson(res, 400, { error: "Select a known node" }); return }
      const op = monitorPath.slice("/api/monitor/".length)
      if (!((method === "GET" && ["discover", "actions", "activity"].includes(op)) || (method === "POST" && ["register", "ended", "action", "retry", "clear"].includes(op)))) {
        sendJson(res, 405, { error: "Unknown monitor operation" }); return
      }
      const body = method === "POST" ? JSON.stringify(await readMonitorBody(req)) : undefined
      const r = await fetch(node.url + "/monitor/" + op + (op === "actions" ? "?offset=" + encodeURIComponent(url.searchParams.get("offset") || "0")
        : op === "activity" ? "?hours=" + encodeURIComponent(url.searchParams.get("hours") || "24") : ""), { method, body, signal: ac.signal, headers: { "Content-Type": "application/json", ...(node.token ? { Authorization: `Bearer ${node.token}` } : {}) } })
      sendJson(res, r.status, await r.json())
    } catch (e: any) { sendJson(res, 502, { error: e.message }) }
    finally { clearTimeout(timeout) }
    return
  }
  if (method === "GET" && path === "/mesh") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderMeshPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  // Guest meshes (#380): the host's panel, with its data proxied to the
  // daemon's /mesh/guests (loopback-trusted there, like the other panels).
  if (method === "GET" && path === "/guests") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderGuestsPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  if ((method === "GET" && path === "/api/guests") || (method === "POST" && /^\/api\/guests\/[^/]+\/(pause|resume|end|update)$/.test(path))) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const daemonUrl = ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      const body = method === "POST" ? await readJson(req).catch(() => ({})) : undefined
      const r = await fetch(`${daemonUrl}${path.replace(/^\/api\/guests/, "/mesh/guests")}`, {
        method, headers, ...(body !== undefined ? { body: JSON.stringify(body ?? {}) } : {}),
      })
      sendJson(res, r.status, await r.json().catch(() => ({ error: `HTTP ${r.status}` })))
    } catch (e: any) {
      sendJson(res, 502, { error: "daemon unreachable", message: e.message || String(e) })
    }
    return
  }
  if (method === "GET" && path === "/workflows") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderWorkflowsPage({ peers: buildTopbarPeers(ctx.config) }))
    return
  }
  // /tasks/:id — watching an agent work is a place, not a popup. The Wall's
  // Task page (#1381) does everything this page did, so the address now
  // redirects there (#1447, classic-routes.ts); links in chat messages,
  // voice replies and the classic pages keep working.
  const taskPage = method === "GET" && path.match(/^\/tasks\/([^/]+)$/)
  if (taskPage) {
    const to = classicRedirect(path, url.searchParams, ctx.config.dashboard.daemonUrl)
    if (!to) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end("<p>Missing <code>?agent=</code>. Open this task from the Wall's Live page.</p>")
      return
    }
    // Off-box with no session, sign in first with the whole Wall link as
    // next: the hash never reaches the server, so a sign-in reached from
    // "/" would come back to the bare Wall.
    if (!pageAllowed(req, res, ctx, to)) return
    res.writeHead(302, { Location: to })
    res.end()
    return
  }
  // /agents/:id/history — was a 360px drawer sliding over Live. The list is
  // what you came to read, it wants width, and every row leads somewhere, so
  // it needs to be linkable and back-navigable.
  const histPage = method === "GET" && path.match(/^\/agents\/([^/]+)\/history$/)
  if (histPage) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderHistoryPage({
      agentId: decodeURIComponent(histPage[1]),
      agentName: url.searchParams.get("name") || undefined,
      nodeUrl: url.searchParams.get("node") || ctx.config.dashboard.daemonUrl,
      peers: buildTopbarPeers(ctx.config),
    }))
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
    if (!pageAllowed(req, res, ctx, path)) return
    handleAdminGet(req, res, buildTopbarPeers(ctx.config), pageToken(req, ctx.token))
    return
  }
  // /approvals — one inbox for every decision waiting for the operator.
  if (method === "GET" && path === "/approvals") {
    if (!pageAllowed(req, res, ctx, path)) return
    handleApprovalsPageGet(res, buildTopbarPeers(ctx.config), pageToken(req, ctx.token))
    return
  }
  // /admin/graph — Intent Knowledge Graph: pending approvals + taxonomy editor.
  if (method === "GET" && path === "/admin/graph") {
    if (!pageAllowed(req, res, ctx, path)) return
    handleGraphGet(req, res, buildTopbarPeers(ctx.config), pageToken(req, ctx.token))
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
    if (!pageAllowed(req, res, ctx, path)) return
    handleObservabilityGet(req, res, buildTopbarPeers(ctx.config), pageToken(req, ctx.token))
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
  // /api/workflows + /api/agents live outside /api/admin/ for legacy
  // reasons but are part of the admin surface and follow the same
  // peer-selector contract. Mirror of the shouldProxy() allowlist on
  // the client side (topbar.ts). Treat them the same as /api/admin/*
  // so admin pages proxy to the chosen peer when the selector is set.
  // A stream ticket is minted by, and only opens streams on, this node, so
  // its route never follows the selector.
  if ((path.startsWith("/api/admin/") && path !== STREAM_TICKET_PATH) || path.startsWith("/api/workflows") || path.startsWith("/api/agents")) {
    // An explicit ?peer=fleet (the /activity map) beats the topbar's
    // per-node header: that view is mesh-wide by definition.
    const peerId = url.searchParams.get("peer") === "fleet" ? "fleet"
      : String(req.headers["x-agentx-peer"] || "").trim() || url.searchParams.get("peer") || ""
    // This block runs before the /api/admin/* token gate below, and both the
    // fleet fan-out and the per-peer proxy call peers with their own tokens,
    // so check dashboard.token here first (#1201). GET /api/agents is the
    // one route open on this node without the token (the board's agent
    // list asks for it without one), so the proxy leaves it open too.
    const openLocally = method === "GET" && path === "/api/agents"
    if (peerId && peerId !== "primary" && !openLocally && !adminTokenOk(req, ctx) && !streamTicketOk(req, ctx, method, path)) {
      sendJson(res, 401, { error: "unauthorized" })
      return
    }
    if (peerId === "fleet") {
      if (path === "/api/admin/activity-graph") {
        await handleActivityGraphFleet(req, res, ctx)
        return
      }
      if (path === WALL_PREFIX && method === "GET") {
        sendJson(res, 200, await buildWallFleet(url.searchParams, ctx))
        return
      }
      if (path === `${WALL_PREFIX}/throughput` && method === "GET") {
        sendJson(res, 200, await buildWallThroughputFleet(ctx))
        return
      }
      if (path === "/api/admin/activity-graph/stream") {
        await handleActivityGraphStream(req, res, path, (hours) => buildFleetActivitySnapshot(hours, ctx.config))
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

  // /admin/ledger — read-only window over .agentx/intent/ledger.sqlite.
  // Mirrors `agentx ledger stats/events/divergences/active`. Replay and
  // lineage stay CLI-only.
  if (method === "GET" && path === "/admin/ledger") {
    if (!pageAllowed(req, res, ctx, path)) return
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderLedgerPage({ peers: buildTopbarPeers(ctx.config), localToken: pageToken(req, ctx.token) }))
    return
  }
  // /admin/cost was the token-spend page. The Wall's Cost page (#1423)
  // does all it did, so old links and bookmarks land there. The CSV and
  // the reads stay under /api/admin/observability/.
  if (method === "GET" && path === "/admin/cost") {
    if (!pageAllowed(req, res, ctx, path)) return
    res.writeHead(302, { Location: WALL_COST_HREF })
    res.end()
    return
  }
  // /admin/projects — aggregated per-project view. Data via
  // GET /api/admin/projects on the daemon, proxied by the existing
  // /api/admin/* path-prefix proxy so the mesh selector works.
  if (method === "GET" && path === "/admin/projects") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderProjectsPage({ peers: buildTopbarPeers(ctx.config) }))
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
  // /admin/activity-graph retired: its map lives on as the Map view of
  // /activity. The APIs below still feed that view.
  if (method === "GET" && path === "/admin/activity-graph") {
    res.writeHead(302, { Location: "/activity?view=map" })
    res.end()
    return
  }
  // /admin/agents/<id> — dedicated per-agent page with md editor + skill mgr.
  const agentPageMatch = method === "GET" && path.match(/^\/admin\/agents\/([a-z0-9][a-z0-9_-]*)$/)
  if (agentPageMatch) {
    if (!pageAllowed(req, res, ctx, path)) return
    handleAgentPageGet(req, res, agentPageMatch[1], buildTopbarPeers(ctx.config), pageToken(req, ctx.token))
    return
  }
  // (Cross-mesh proxy is now handled at the top of /api/admin/*. The
  // local-token enforcement below still runs for any admin call that
  // didn't match a specific handler above.)
  if (path.startsWith("/api/admin/")) {
    // Local admin calls: enforce dashboard.token (if configured) BEFORE the
    // dispatcher runs. The legacy ctx.token check further down only catches
    // paths nothing else handled — admin routes were silently bypassing it.
    if (!adminTokenOk(req, ctx) && !streamTicketOk(req, ctx, method, path)) {
      sendJson(res, 401, { error: "unauthorized" })
      return
    }
  }
  // Trade the header token (or session cookie) for a short-lived ticket an
  // EventSource can carry as ?st= (see dashboard-session.ts).
  if (method === "POST" && path === STREAM_TICKET_PATH) {
    sendJson(res, 200, ctx.token ? { ticket: streamTicket(ctx.token), expiresInS: STREAM_TICKET_TTL_S } : { ticket: "" })
    return
  }
  // /api/admin/logs/stream — SSE tail of the daemon's stdout. Mirrors
  // `agentx daemon logs -f`. On systemd-managed nodes this calls
  // journalctl; on others it falls back to /tmp/agentx-daemon.log.
  if (method === "GET" && path === "/api/admin/logs/stream") {
    await streamDaemonLogs(req, res)
    return
  }
  // The /activity map's local snapshot, stream and dispatch detail. Behind
  // the gate above like every admin read; the stream takes a ticket.
  if (method === "GET" && path === "/api/admin/activity-graph") {
    if (await handleActivityGraphApi(req, res, path)) return
  }
  if (method === "GET" && path.startsWith("/api/admin/activity-graph/stream")) {
    if (await handleActivityGraphStream(req, res, path)) return
  }
  if (method === "GET" && path.startsWith("/api/admin/activity-graph/dispatch/")) {
    if (await handleActivityGraphDetail(req, res, path)) return
  }
  // Health, Cost and Ledger reads (#1302): spend, budgets, errors, doctor
  // output. After the token gate above; their pages send dashboard.token.
  if (method === "GET" && path.startsWith("/api/admin/observability/")) {
    if (await handleObservabilityApi(req, res, path, ctx.config)) return
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
  if (method === "GET" && path.startsWith("/api/admin/ledger/")) {
    if (await handleLedgerApi(req, res, path)) return
  }
  // Set or raise a monthly budget from the Cost page (#1290), after the
  // token gate above. { scope: agent|project|fleet, id?, monthlyUsd, warnRatio? }
  // The Wall's Cost page sends it to WALL_BUDGET_PATH, under the Wall's
  // owner-only guard (#1454).
  if (method === "POST" && (path === "/api/admin/budgets" || path === WALL_BUDGET_PATH)) {
    const body = await readJson(req).catch(() => ({})) as Record<string, unknown>
    const problem = budgetPatchProblem(body)
    if (problem) { sendJson(res, 400, { error: problem }); return }
    const r = await updateBudget(body as unknown as BudgetPatch)
    if (!r.success) { sendJson(res, 400, { error: r.error }); return }
    sendJson(res, 200, { ok: true, reloaded: !!r.reloaded })
    return
  }
  // The agent page's chat (#1163), after the token gate above.
  if (await handleAgentChatApi(req, res, path, {
    daemonUrl: ctx.config.dashboard.daemonUrl, token: ctx.config.dashboard.token, readBody: readJson,
  })) return
  // The chat's "no model yet" box (#1163), after the token gate above.
  if (path === MODEL_READY_PATH || path === MODEL_KEY_PATH) {
    if (await handleModelSetupApi(req, res, path, url.searchParams, {
      dir: process.cwd(),
      readBody: readJson,
      reloadDaemon: async () => {
        const headers: Record<string, string> = {}
        if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
        const r = await fetch(ctx.config.dashboard.daemonUrl.replace(/\/+$/, "") + "/reload", { method: "POST", headers, signal: AbortSignal.timeout(10_000) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
      },
    })) return
  }
  if (method === "GET" && path === "/api/admin/config") {
    await handleAdminConfigGet(req, res)
    return
  }
  // Configured voices macOS took away, as the daemon last found them
  // (src/voice/voice-health.ts); after the token gate above.
  if (method === "GET" && path === "/api/admin/voice-health") {
    sendJson(res, 200, readVoiceHealth() ?? { checkedAt: null, missing: [] })
    return
  }
  // The Wall's review queue (#1182): read-only over the graph's own files.
  if (method === "GET" && path === WALL_REVIEWS_PATH) {
    const graph = ctx.config.graph
    const reply = handleWallReviews(url.searchParams, {
      baseDir: graph?.baseDir ? resolve(process.cwd(), graph.baseDir) : null,
      enabled: !!graph?.enabled,
    }, localNodeName(ctx.config), Date.now())
    sendJson(res, reply.status, reply.body)
    return
  }
  // Wall Live's controls (#1439): Resume, Drop and Pause a task, Restart
  // when idle (and cancel it), Stop a lesson. Each goes to the node that
  // holds what it acts on, through the node API classic Live used. Under
  // /api/admin/wall, so the Wall's owner guard (#1454) holds every one.
  //   POST /api/admin/wall/live/resume?node=<url>          { id }
  //   POST /api/admin/wall/live/drop?node=<url>            { id }
  //   POST /api/admin/wall/live/pause?node=<url>           { taskId }
  //   POST /api/admin/wall/live/restart?node=<url>
  //   POST /api/admin/wall/live/restart-cancel?node=<url>
  //   POST /api/admin/wall/live/lesson-stop?node=<url>
  //   POST /api/admin/wall/live/cli?node=<url>             a CLI to connect (the monitor block above)
  //   GET  /api/admin/wall/live/discover?node=<url>        CLI sessions to connect (the monitor block above)
  const liveUpstream = method === "POST" && path.startsWith(`${WALL_LIVE_ACTIONS_PREFIX}/`)
    ? WALL_LIVE_UPSTREAM.get(path.slice(WALL_LIVE_ACTIONS_PREFIX.length + 1)) : undefined
  if (liveUpstream) {
    if (req.headers["x-requested-with"] !== "agentx-board") { sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" }); return }
    const nodeUrl = url.searchParams.get("node")
    if (!nodeUrl) { sendJson(res, 400, { error: "node query param required" }); return }
    await proxyNodePost(req, res, ctx, nodeUrl, liveUpstream)
    return
  }

  // The Wall's writes (#1316): comment on a post, call its agent, a Space.
  // After the token gate above; the proxy above sends a comment or a call
  // to the node that keeps the post.
  if (isWallActionPath(path)) {
    const body = method === "POST" ? await readJson(req) : {}
    const reply = await handleWallAction(method, path, body, { inbox: { root: process.cwd() }, daemon: wallDaemon(ctx.config) })
    sendJson(res, reply!.status, reply!.body)
    return
  }
  // The Wall (#1180): read-only posts and threads from this node's records.
  if (method === "GET" && (path === WALL_PREFIX || path.startsWith(`${WALL_PREFIX}/`))) {
    const reply = await wallLocal(path, url.searchParams, ctx)
    sendJson(res, reply.status, reply.body)
    return
  }
  if (path.startsWith("/api/admin/approvals")) {
    await handleApprovalsPanelApi(req, res, path, url, {
      node: { url: ctx.config.dashboard.daemonUrl.replace(/\/+$/, ""), name: ctx.config.node?.name || "this computer" },
    })
    return
  }
  // People (#441): /api/admin/people, after the token gate above; /people
  // itself goes to the Wall's People page (#1441). The people list is read
  // per request, like the member page.
  // Org (#1169): the org chart, after the token gate above. Its data is
  // /api/admin/org, in admin-panel.ts.
  if (method === "GET" && path === "/org") {
    if (!pageAllowed(req, res, ctx, path)) return
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(renderOrgPage({ peers: buildTopbarPeers(ctx.config), localToken: pageToken(req, ctx.token) }))
    return
  }
  if (method === "GET" && path === "/people" && !pageAllowed(req, res, ctx, path)) return
  if (await handlePeoplePanel(req, res, path, {
    people: () => currentPeople(ctx.config.people), members: membersStore(ctx.config.members.logRetentionDays),
    root: process.cwd(), db: () => dashboardDb(),
  })) return
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
  // to dist/web/<name>.js. Any `/assets/<name>` request is mapped
  // 1:1 into dist/web so future bundles (graph editor, ...) can live there
  // without another route registration.
  if (method === "GET" && path.startsWith("/assets/")) {
    const rel = path.slice("/assets/".length)
    // Allow dotted stems (e.g. "activity-graph.global.js") but keep the
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
      // A hashed URL names exactly one build, so it can be cached hard; a bare
      // one must keep revalidating because its bytes change under it.
      const immutable = url.searchParams.has("v")
      res.writeHead(200, {
        "Content-Type": ct,
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=60",
      })
      res.end(buf)
    } catch {
      sendJson(res, 404, { error: "asset not found", hint: "run: npm run build:web" })
    }
    return
  }

  // Live mesh view endpoints (JSON snapshot + SSE push every 2s)
  if (method === "GET" && path === "/api/live") {
    try {
      // ?quick=1 (#1442): a node still answering after a moment is "checking".
      const snap = await buildLiveSnapshot(ctx.config, undefined, url.searchParams.get("quick") === "1")
      sendJson(res, 200, snap)
    } catch (e: any) { sendJson(res, 502, { error: e.message }) }
    return
  }
  if (method === "GET" && path === "/api/mesh") {
    try {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10)
      const timezone = url.searchParams.get("timezone") || "UTC"
      const snap = await buildLiveSnapshot(ctx.config, { date, timezone })
      sendJson(res, 200, snap)
    } catch (e: any) { sendJson(res, 502, { error: e.message }) }
    return
  }

  // Mesh analytics — fleet-wide activity, failure causes, zombie jobs and
  // thread lifetimes. Fans out to every node's /analytics/mesh and merges.
  //   GET /api/mesh/analytics?days=30&tzOffset=<minutes>&limit=60
  if (method === "GET" && path === "/api/mesh/analytics") {
    const num = (k: string, d: number, lo: number, hi: number): number => {
      const v = parseInt(url.searchParams.get(k) || "", 10)
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d
    }
    try {
      const targets = await resolveNodeTargets(ctx.config)
      sendJson(res, 200, await fetchMeshAnalytics(targets, {
        days: num("days", 30, 0, 180),
        tzOffsetMinutes: num("tzOffset", 0, -840, 840),
        limit: num("limit", 60, 1, 200),
      }))
    } catch (e: any) { sendJson(res, 502, { error: e.message }) }
    return
  }

  // One activity column, across the fleet.
  //   GET /api/mesh/day?day=YYYY-MM-DD&tzOffset=<minutes>&limit=40
  if (method === "GET" && path === "/api/mesh/day") {
    const day = url.searchParams.get("day") || ""
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      sendJson(res, 400, { error: "day=YYYY-MM-DD query param required" }); return
    }
    const num = (k: string, d: number, lo: number, hi: number): number => {
      const v = parseInt(url.searchParams.get(k) || "", 10)
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d
    }
    try {
      const targets = await resolveNodeTargets(ctx.config)
      sendJson(res, 200, await fetchMeshDay(targets, {
        day,
        tzOffsetMinutes: num("tzOffset", 0, -840, 840),
        limit: num("limit", 40, 1, 200),
      }))
    } catch (e: any) { sendJson(res, 502, { error: e.message }) }
    return
  }

  // Drill-down proxies. The node URL comes from the merged analytics
  // payload and is re-checked against the allowlist before forwarding.
  //   GET /api/mesh/thread?node=&agent=&channel=&chat=&limit=
  //   GET /api/mesh/job?node=&kind=cron|workflow&key=&limit=
  //   GET /api/mesh/run?node=&task=
  //   GET /api/mesh/conversation?node=&agent=&channel=&chat=&tzOffset=
  if (method === "GET" && (path === "/api/mesh/thread" || path === "/api/mesh/job"
      || path === "/api/mesh/run" || path === "/api/mesh/conversation")) {
    const nodeUrl = url.searchParams.get("node")
    if (!nodeUrl) { sendJson(res, 400, { error: "node query param required" }); return }
    const q = url.searchParams
    let upstream: string
    if (path === "/api/mesh/thread") {
      const [agent, channel, chat] = [q.get("agent"), q.get("channel"), q.get("chat")]
      if (!agent || !channel || !chat) { sendJson(res, 400, { error: "agent, channel, chat required" }); return }
      upstream = `/analytics/thread?agent=${encodeURIComponent(agent)}&channel=${encodeURIComponent(channel)}`
        + `&chat=${encodeURIComponent(chat)}&limit=${encodeURIComponent(q.get("limit") || "120")}`
    } else if (path === "/api/mesh/job") {
      const [kind, key] = [q.get("kind"), q.get("key")]
      if (!kind || !key) { sendJson(res, 400, { error: "kind and key required" }); return }
      upstream = `/analytics/job?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}`
        + `&limit=${encodeURIComponent(q.get("limit") || "120")}`
    } else if (path === "/api/mesh/conversation") {
      const [agent, channel, chat] = [q.get("agent"), q.get("channel"), q.get("chat")]
      if (!agent || !channel || !chat) { sendJson(res, 400, { error: "agent, channel, chat required" }); return }
      upstream = `/analytics/conversation?agent=${encodeURIComponent(agent)}&channel=${encodeURIComponent(channel)}`
        + `&chat=${encodeURIComponent(chat)}&tzOffset=${encodeURIComponent(q.get("tzOffset") || "0")}`
    } else {
      const task = q.get("task")
      if (!task) { sendJson(res, 400, { error: "task required" }); return }
      upstream = `/analytics/run/${encodeURIComponent(task)}`
    }
    try {
      await proxyNodeAnalytics(res, await resolveNodeTargets(ctx.config), nodeUrl, upstream)
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

  // Cross-node action proxy: stop / follow-up a running task on any daemon
  // in the dashboard's allowlist. The browser talks to the dashboard origin
  // (same as /api/task/stream), and the dashboard forwards to the daemon's
  // /api/tasks/:taskId/{cancel|followup} endpoint with the operator token.
  //   POST /api/task/action?node=<url>&task=<id>&kind=cancel|followup
  // body: passthrough JSON (cancel: { reason? }; followup: { message, replace?, sender? })
  if (method === "POST" && path === "/api/task/action") {
    const u = new URL(req.url || "/", "http://localhost")
    const nodeUrl = u.searchParams.get("node")
    const taskId = u.searchParams.get("task")
    const kind = u.searchParams.get("kind")
    if (!nodeUrl || !taskId || (kind !== "cancel" && kind !== "followup")) {
      sendJson(res, 400, { error: "node, task, kind=cancel|followup query params required" })
      return
    }
    await proxyTaskAction(req, res, ctx, nodeUrl, taskId, kind)
    return
  }

  // Stop whatever is speaking or showing on a node's screen: a lesson, a
  // talk, narration (the daemon's POST /voice/stop).
  //   POST /api/voice/stop?node=<url>
  if (method === "POST" && path === "/api/voice/stop") {
    const nodeUrl = new URL(req.url || "/", "http://localhost").searchParams.get("node")
    if (!nodeUrl) { sendJson(res, 400, { error: "node query param required" }); return }
    await proxyNodePost(req, res, ctx, nodeUrl, "/voice/stop")
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

  // Business status (proxy to configured daemon) — used by the boards
  // Activity panel, which used to call the daemon cross-origin.
  if (method === "GET" && path === "/api/business/status") {
    try {
      const headers: Record<string, string> = {}
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const r = await fetch(ctx.config.dashboard.daemonUrl.replace(/\/+$/, "") + "/business/status", { headers })
      if (!r.ok) { sendJson(res, r.status, { error: `HTTP ${r.status}` }); return }
      sendJson(res, 200, await r.json())
    } catch (e: any) { sendJson(res, 502, { error: e.message || "business status fetch failed" }) }
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

  // The build the primary daemon is running and since when, for the header
  // of every page (#465). The dashboard is its own process, so it asks.
  // Above the /api/* token gate on purpose: the header script has no token
  // to send, and putting one in the top bar would put it on every page.
  // Only headerBuild's five fields leave here, which the daemon's own
  // /health already gives without a token.
  //   GET /api/node/build
  if (method === "GET" && path === "/api/node/build") {
    try {
      const headers: Record<string, string> = {}
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const r = await fetch(ctx.config.dashboard.daemonUrl.replace(/\/+$/, "") + "/health", { headers, signal: AbortSignal.timeout(3000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      sendJson(res, 200, headerBuild(await r.json()))
    } catch (e: any) { sendJson(res, 502, { error: e.message || "daemon not reachable" }) }
    return
  }

  if (path.startsWith("/api/") && ctx.token) {
    // Legacy: if dashboard.token is configured, every /api/* request must
    // carry it (or a scoped token with dashboard:write).
    const authHeader = req.headers.authorization || ""
    const got = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (got === ctx.token || hasSession(req, ctx.token)) { /* fall through */ }
    else {
      const tokStore = new TokenStore()
      const rec = got ? tokStore.verify(got) : null
      if (!rec || !recordHasScope(rec, "dashboard:write")) {
        sendJson(res, 401, { error: "unauthorized" })
        return
      }
    }
  }

  // Mesh feed (#166) — the newest events on the primary daemon's bus. That
  // bus already holds each mesh peer's own events (src/events/peer-feed.ts),
  // so one read covers the fleet; fanning out like /events would show every
  // peer event twice. Per-step agent activity is left out.
  //
  // Below the /api/* token gate on purpose: the daemon's /events/recent is
  // mesh-gated, and this proxy reads it with the dashboard's credential, so
  // an ungated route here would hand the whole mesh's events to anyone who
  // can reach the dashboard. The daemon accepts MESH_TOKEN (not
  // dashboard.token) off-box, so that is tried first.
  //   GET /api/mesh/feed?limit=50
  if (method === "GET" && path === "/api/mesh/feed") {
    await serveMeshFeed(res, ctx.config, url.searchParams)
    return
  }

  const isWrite = method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT"
  if (isWrite && path.startsWith("/api/")) {
    const xr = req.headers["x-requested-with"]
    if (xr !== "agentx-board") { sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" }); return }
  }

  // Wiki page curator (#818). The wiki on this dashboard is the local
  // node's, so the chat goes to the local daemon, which runs the agent.
  // Below the /api/* token and X-Requested-With checks on purpose: the
  // proxy calls the daemon with the dashboard's own credential, and a POST
  // starts an operator turn that rewrites a page.
  if (path === "/api/wiki/curate" || path === "/api/wiki/curate/restore") {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const daemonUrl = ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      const body = method === "POST" ? JSON.stringify((await readJson(req)) ?? {}) : undefined
      const r = await fetch(`${daemonUrl}${path}${url.search}`, { method, headers, ...(body ? { body } : {}) })
      sendJson(res, r.status, await r.json().catch(() => ({ error: `HTTP ${r.status}` })))
    } catch (e: any) {
      sendJson(res, 502, { error: "daemon unreachable", message: e?.message || String(e) })
    }
    return
  }

  // Places (#676), below the /api/* token and X-Requested-With checks:
  // the /places page adds and removes the owner's places here.
  if (await handleDashboardPlaces(req, res, path, method, appPlacesDeps(ctx.config))) return

  // Pause a running task with a resume plan, or resume one (#857), on the
  // node that holds it. Below the token and X-Requested-With checks: both
  // stop or start a run.
  //   POST /api/signals/stop?node=<url>     { taskId, reason? }
  //   POST /api/signals/resume?node=<url>   { id }
  //   POST /api/signals/drop?node=<url>     { id }
  if (method === "POST" && (path === "/api/signals/stop" || path === "/api/signals/resume" || path === "/api/signals/drop")) {
    const nodeUrl = new URL(req.url || "/", "http://localhost").searchParams.get("node")
    if (!nodeUrl) { sendJson(res, 400, { error: "node query param required" }); return }
    await proxyNodePost(req, res, ctx, nodeUrl, path)
    return
  }

  // "Restart when idle" on a node's header (Live page). The daemon holds the
  // request and exits by itself once no task is running, so its service
  // manager starts it again; it refuses when none would. Below the token and
  // X-Requested-With checks on purpose: this stops a node.
  //   POST /api/node/restart?node=<url>          { timeoutMinutes?, onTimeout? }
  //   POST /api/node/restart/cancel?node=<url>
  if (method === "POST" && (path === "/api/node/restart" || path === "/api/node/restart/cancel")) {
    const nodeUrl = url.searchParams.get("node")
    if (!nodeUrl) { sendJson(res, 400, { error: "node query param required" }); return }
    await proxyNodePost(req, res, ctx, nodeUrl, path === "/api/node/restart" ? "/daemon/restart" : "/daemon/restart/cancel")
    return
  }

  // Read-through proxies for runs. The dashboard's local RunStore only
  // sees runs home-noded on THIS machine, but the user typically wants
  // the cross-fleet view: runs fired on peer-server when GitLab events
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

  // Follow-up runs still going, on this node and its peers, grouped by
  // what they concern (#788). Unreachable peers are skipped and named.
  if (method === "GET" && path === "/api/workflows/follow-ups") {
    const targets: Array<{ url: string; token?: string }> = [
      { url: ctx.config.dashboard.daemonUrl, token: ctx.config.dashboard.token },
      ...(ctx.config.dashboard.daemons || []).map((d) => ({ url: d.url, token: d.token })),
    ]
    const unreachable: string[] = []
    const remote = await Promise.all(targets.map(async (t) => {
      const headers: Record<string, string> = {}
      if (t.token) headers["Authorization"] = `Bearer ${t.token}`
      try {
        const r = await fetch(`${t.url.replace(/\/+$/, "")}/api/workflows/runs?limit=500&summary=1`, { headers, signal: AbortSignal.timeout(5000) })
        if (!r.ok) { unreachable.push(t.url); return [] }
        const data = await r.json() as { runs?: WorkflowRun[] }
        return Array.isArray(data.runs) ? data.runs : []
      } catch { unreachable.push(t.url); return [] }
    }))
    const byId = new Map<string, WorkflowRun>()
    for (const r of ctx.workflowRuns.list({ limit: 500 })) byId.set(r.id, r)
    for (const list of remote) for (const r of list) byId.set(r.id, { ...r, history: r.history ?? [], pending: r.pending ?? [] })
    const titles = new Map(ctx.workflowStore.list().map((w) => [w.id, w.title] as const))
    sendJson(res, 200, { groups: progressGroups([...byId.values()], (id) => titles.get(id)), unreachable })
    return
  }

  // Run every task through a workflow (#858): this node's setting. Follows
  // the topbar's machine menu like the rest of /api/workflows.
  //   GET  /api/workflows/required   the settings and this node's agents
  //   POST /api/workflows/required   { enabled?, exemptQuestions?, agentId?, agentRequired?: "on"|"off"|"default" }
  if (path === "/api/workflows/required") {
    const view = () => ({ settings: readRequiredSettings(), agents: Object.keys(ctx.config.agents ?? {}).sort() })
    if (method === "GET") { sendJson(res, 200, view()); return }
    if (method !== "POST") { sendJson(res, 405, { error: "Method not allowed" }); return }
    if (ctx.config.workflows?.editor !== "edit") { sendJson(res, 403, { error: "the workflow editor is read-only on this node (workflows.editor)" }); return }
    const body = await readJson(req).catch(() => ({})) as Record<string, unknown>
    const patch: RequiredSettingsPatch = {}
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled
    if (typeof body.exemptQuestions === "boolean") patch.exemptQuestions = body.exemptQuestions
    if (typeof body.agentId === "string" && body.agentId) {
      if (!Object.prototype.hasOwnProperty.call(ctx.config.agents ?? {}, body.agentId)) { sendJson(res, 400, { error: `no agent "${body.agentId}" on this node` }); return }
      const v = body.agentRequired
      if (v !== "on" && v !== "off" && v !== "default") { sendJson(res, 400, { error: "agentRequired is on, off or default" }); return }
      patch.agent = { id: body.agentId, value: v === "default" ? null : v === "on" }
    }
    if (patch.enabled === undefined && patch.exemptQuestions === undefined && !patch.agent) { sendJson(res, 400, { error: "nothing to change" }); return }
    const r = await updateRequiredSettings(patch)
    if (!r.success) { sendJson(res, 400, { error: r.error }); return }
    sendJson(res, 200, { ok: true, reloaded: !!r.reloaded, ...view() })
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

  // /api/actions/builtin — proxy GET to the daemon. The /procedures page
  // reads the live built-in catalog from this endpoint; daemon owns the
  // typed registry, dashboard runs in a separate process.
  if (method === "GET" && path === "/api/actions/builtin") {
    try {
      const headers: Record<string, string> = {}
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const daemonUrl = ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      const r = await fetch(`${daemonUrl}/api/actions/builtin`, { headers })
      const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
      sendJson(res, r.status, data)
    } catch (e: any) {
      sendJson(res, 502, { error: "daemon unreachable", message: e.message || String(e) })
    }
    return
  }

  // Active-workflow manual run — proxies the daemon's POST /workflows/:id/run
  // endpoint. The /workflows page on the dashboard fires this for the "▶ Run"
  // button. Body shape passed through unchanged: { payload?: object, force?: bool }.
  // The daemon already enforces the trigger.manual constraint and returns
  // 409 when force is needed, which the page surfaces as a toast.
  const runMatch = method === "POST" && path.match(/^\/workflows\/([^/]+)\/run$/)
  if (runMatch) {
    try {
      const body = await readJson(req).catch(() => ({}))
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (ctx.config.dashboard.token) headers["Authorization"] = `Bearer ${ctx.config.dashboard.token}`
      const daemonUrl = ctx.config.dashboard.daemonUrl.replace(/\/+$/, "")
      const r = await fetch(`${daemonUrl}/workflows/${encodeURIComponent(runMatch[1])}/run`, {
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

  // Draft replay — fires an ad-hoc workflow run on the daemon. Lives on
  // the daemon (not in workflows-api.ts) because it needs the dispatcher

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

  // Friendly aliases for naked paths people copy-paste from terminal output,
  // Slack messages, or muscle memory ("just open /health"). The dashboard
  // proper lives under /admin/<page> — unknown top-level paths that match a
  // known admin section get a 302 so the URL works instead of dumping
  // {"error":"not found"} JSON. Only slugs that resolve to a real admin
  // page are mapped — phantom redirects (/admin/<slug> 404) would be worse
  // than the original 404.
  if (method === "GET" && /^\/[a-z][a-z-]*\/?$/.test(path)) {
    const slug = path.replace(/^\/+|\/+$/g, "")
    const SLUG_TO_ADMIN: Record<string, string> = {
      health: "/admin/health",
      ledger: "/admin/ledger",
      cost: WALL_COST_HREF,
      projects: "/admin/projects",
      graph: "/admin/graph",
      wiki: "/admin/wiki/",
      observability: "/admin/health",
    }
    const target = SLUG_TO_ADMIN[slug]
    if (target) {
      res.writeHead(302, { Location: target })
      res.end()
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
    // Follow-up runs (#788): what it is about, and what it waits on.
    ...(r.meta ? { meta: r.meta } : {}),
    ...(r.pausedAt ? { pausedAt: slimPausedAt(r.pausedAt) } : {}),
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
  /** #1442 — /agents did not answer within the node's deadline: the node
   *  is slow, not down. Pages show "checking…" and ask again. */
  checking?: boolean
  /** #193 — last good data kept while the node is briefly unreachable. */
  stale?: boolean
  staleSince?: string
  /** #193 — Claude Code sessions registered with this node's attach hooks.
   *  Loopback-only on the daemon, so only the dashboard's own host reports. */
  attachSessions?: Array<{
    session: string
    project: string
    agentIds: string[]
    mode: string
    lastSeenAt: number
    /** When the session registered (#1439); absent for a saved binding. */
    startedAt?: number
    pending: number
    /** Bound, but the session has not reported since a restart or idle drop. */
    waiting?: boolean
  }>
  uptimeSec?: number
  /** The build the node runs (GET /health; undefined on older nodes). */
  version?: string
  commit?: string
  /** Tasks a restart would cut off (GET /health; undefined on older nodes). */
  inflight?: number
  /** A "restart when idle" request the node is holding (GET /health). */
  restart?: { state: "none" | "pending" | "restarting"; requestedAt?: string; deadline?: string }
  /** Tasks a stop signal paused, with their resume plan (#857;
   *  GET /api/signals/stopped, bounded summaries; undefined on older nodes). */
  stoppedTasks?: Array<{
    id: string
    agentId: string
    channel: string
    chatId: string
    state: string
    stoppedAt: string
    stoppedBy: string
    reason?: string
    request: string
    plan?: { author: string; text: string; note?: string }
    resumable: boolean
    /** A workflow step: its run is paused at this step (#870). */
    workflow?: { runId: string; workflowId: string; nodeId: string }
  }>
  agents: Array<{
    id: string
    name: string
    tier: string
    model?: string
    color?: string
    skillCount?: number
    active: number
    total: number
    errors: number
    lastActive?: string
    lastSummary?: { text: string; at: string; ok: boolean }
    /** #193 — the Claude Code session answering for this agent, if any. */
    attached?: { session: string; project: string; mode: string; lastSeenAt: number; waiting?: boolean }
    hourlyTasks?: number[]
    runningTasks?: Array<{
      id: string
      traceId?: string
      messagePreview: string
      channel: string
      chatId?: string
      sender?: string
      startedAt: string
      lastActivity?: string
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
  crons?: Array<{
    id: string
    enabled: boolean
    schedule: string
    timezone?: string
    agent: string
    /** "command" jobs run a shell command, never an agent — no task to open. */
    kind: "agent" | "command"
    model?: string
    nextRun?: string
    retryPending?: boolean
    consecutiveErrors: number
    /** Why it runs and the number that proves it (#1183). */
    value?: CronValue
  }>
  cronRuns?: Array<{
    jobId: string
    startedAt: string
    completedAt: string
    duration: number
    status: "success" | "failed" | "timeout"
    responseSummary?: string
    errorSummary?: string
    isRetry: boolean
    retryAttempt: number
    taskId?: string
    rootTaskId?: string
    traceId?: string
    sessionId?: string
  }>
  /** Schedules and cron/hook workflows with staleness flags (GET /routines).
   *  Undefined when the node predates the endpoint. */
  routines?: Routine[]
  /** A Space on this node (GET /talk, #1355), while one runs. */
  space?: { agents: string[]; topic: string; startedAt: string }
  /** A live lesson on this node's screen (GET /talk), while one runs. It
   *  holds the listener's screen and voice, so it is shown with a stop. */
  lesson?: {
    agentId: string | null
    mode: string
    goal: string
    step: number
    saying: string
    startedAt: string
  }
}
interface LiveSnapshot {
  ts: string
  nodes: NodeLive[]
  /** Runs going now on one chat or in one worktree at the same time (#1187). */
  concurrent?: RunOverlap[]
}

/** Each live node's agent → worktree key, kept off the snapshot so a
 *  workspace path never leaves the dashboard host. */
const nodeWorktrees = new WeakMap<NodeLive, Map<string, string | null>>()

/** Runs going now that share a chat (across the mesh) or a worktree (on
 *  one node). Unreachable and stale nodes are left out: their runs are
 *  not known to be going. */
export function liveOverlaps(nodes: NodeLive[], now: number = Date.now()): RunOverlap[] {
  const spans: RunSpan[] = []
  for (const n of nodes) {
    if (!n.reachable || n.error || n.stale) continue
    const trees = nodeWorktrees.get(n)
    for (const a of n.agents) {
      const tree = trees?.get(a.id)
      for (const t of a.runningTasks ?? []) {
        const startedAt = Date.parse(t.startedAt)
        if (!Number.isFinite(startedAt)) continue
        spans.push({ runId: t.traceId || t.id, agentId: a.id, chat: chatKey(t.channel, t.chatId), worktree: tree ? `${n.url}|${tree}` : null, startedAt, endedAt: null })
      }
    }
  }
  return findOverlaps(spans, now)
}

/** How long an optional snapshot endpoint may take before it's skipped. */
const OPTIONAL_ENDPOINT_MS = 2_000
/** An optional endpoint's reply, its JSON body already read. */
interface PrefetchedJson { ok: boolean; json: () => Promise<any> }

export async function fetchDaemonAgents(
  url: string,
  token?: string,
  signal?: AbortSignal,
  day?: { date: string; timezone: string },
): Promise<NodeLive> {
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`
  const base: NodeLive = { id: url, name: url, url, reachable: false, agents: [] }
  try {
    const cronQuery = day ? `?date=${encodeURIComponent(day.date)}&timezone=${encodeURIComponent(day.timezone)}` : ""
    // Only /agents decides whether the node is reachable. The rest are
    // extras with their own shorter deadline, so one slow route (a node
    // busy reading its cron history, #245) can't hold the snapshot past
    // the shared abort and leave /agents' body unreadable.
    // The body is read inside the same deadline, straight away: read later,
    // after the slowest extra gave up, it would already be aborted.
    const optional = (path: string): Promise<PrefetchedJson | null> => {
      const own = new AbortController()
      const timer = setTimeout(() => own.abort(), OPTIONAL_ENDPOINT_MS)
      const stop = () => own.abort()
      signal?.addEventListener("abort", stop, { once: true })
      return fetch(url + path, { headers, signal: own.signal })
        .then(async (r) => {
          const body: unknown = r.ok ? await r.json().catch(() => undefined) : undefined
          return { ok: body !== undefined, json: async () => body }
        })
        .catch(() => null)
        .finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", stop) })
    }
    const [healthRes, agentsRes, meshRes, cronsRes, cronRunsRes, talkRes, routinesRes, attachRes, stoppedRes] = await Promise.all([
      optional("/health"),
      fetch(url + "/agents", { headers, signal }).catch(() => null),
      optional("/mesh"),
      optional("/crons"),
      optional("/crons/runs" + cronQuery),
      optional("/talk"),
      optional("/routines"),
      optional("/attach/sessions"),
      optional("/api/signals/stopped?limit=20"),
    ])
    if (!agentsRes || !agentsRes.ok) {
      // Out of time is a slow node, not a down one (#1442): it answered
      // nothing yet, so it is "checking", and the next snapshot asks again.
      const late = !agentsRes && signal?.aborted === true
      base.error = agentsRes ? `HTTP ${agentsRes.status}` : late ? "timed out" : "unreachable"
      if (late) base.checking = true
      return base
    }
    const agents: any[] = await agentsRes.json()
    base.agents = agents.map((a) => ({
      id: a.id, name: a.name, tier: a.tier, model: a.model,
      // The agent's colour (#157), for the phone app's voice orb.
      ...(typeof a.color === "string" && /^#[0-9a-fA-F]{6}$/.test(a.color) ? { color: a.color } : {}),
      skillCount: Number.isFinite(a.skillCount) ? a.skillCount : undefined,
      active: a.active || 0, total: a.total || 0, errors: a.errors || 0,
      lastActive: a.lastActive,
      lastSummary: a.lastSummary,
      hourlyTasks: Array.isArray(a.hourlyTasks) ? a.hourlyTasks : undefined,
      runningTasks: Array.isArray(a.runningTasks) ? a.runningTasks : [],
    }))
    nodeWorktrees.set(base, new Map(agents.map((a) => [String(a.id), worktreeKey(typeof a.workspace === "string" ? a.workspace : null)] as const)))
    if (healthRes && healthRes.ok) {
      const h: any = await healthRes.json().catch(() => ({}))
      base.uptimeSec = h.uptime
      if (typeof h.version === "string") base.version = h.version
      if (typeof h.commit === "string") base.commit = h.commit
      if (typeof h.inflight?.total === "number") base.inflight = h.inflight.total
      if (h.restart && typeof h.restart.state === "string") base.restart = h.restart
      base.name = h.node?.name || h.node?.id || url
      base.id = h.node?.id || url
      // /health already embeds today's usage rollup — reuse it so the
      // dashboard doesn't need a separate /usage call per node.
      if (h.usage) base.usage = h.usage
    }
    if (stoppedRes && stoppedRes.ok) {
      const data: any = await stoppedRes.json().catch(() => ({}))
      const tasks: any[] = Array.isArray(data?.tasks) ? data.tasks : []
      base.stoppedTasks = tasks.filter((t) => t && t.state !== "resumed").slice(0, 10).map((t) => ({
        id: String(t.id), agentId: String(t.agentId), channel: String(t.channel ?? ""), chatId: String(t.chatId ?? ""),
        state: String(t.state), stoppedAt: String(t.stoppedAt), stoppedBy: String(t.stoppedBy ?? ""),
        reason: typeof t.reason === "string" ? t.reason : undefined,
        request: String(t.request ?? ""),
        plan: t.plan && typeof t.plan.text === "string" ? { author: String(t.plan.author), text: t.plan.text, note: t.plan.note } : undefined,
        resumable: t.resumable === true,
        ...(t.workflow && typeof t.workflow.runId === "string"
          ? { workflow: { runId: t.workflow.runId, workflowId: String(t.workflow.workflowId ?? ""), nodeId: String(t.workflow.nodeId ?? "") } }
          : {}),
      }))
    }
    if (cronsRes && cronsRes.ok) {
      const jobs: any[] = await cronsRes.json().then((j: unknown) => (Array.isArray(j) ? j : []), () => [])
      base.crons = jobs.map((job) => ({
        id: job.id,
        enabled: job.enabled === true,
        schedule: String(job.schedule || ""),
        timezone: job.timezone,
        agent: String(job.agent || ""),
        kind: typeof job.command === "string" && job.command.trim() ? "command" : "agent",
        model: job.model,
        nextRun: job.nextRun,
        retryPending: job.retryPending === true,
        consecutiveErrors: Number(job.consecutiveErrors) || 0,
        value: cronValueOf(job.value),
      }))
    }
    if (cronRunsRes && cronRunsRes.ok) {
      const history: any = await cronRunsRes.json().catch(() => ({}))
      base.cronRuns = Array.isArray(history.runs) ? history.runs : []
    }
    // Older daemons 404 here; leaving `routines` unset tells the page the
    // node does not report them rather than that it has none.
    if (routinesRes && routinesRes.ok) {
      const body: any = await routinesRes.json().catch(() => null)
      if (body && Array.isArray(body.routines)) base.routines = body.routines.slice(0, ROUTINE_LIMITS.routines)
    }
    if (talkRes && talkRes.ok) {
      const t: any = await talkRes.json().catch(() => null)
      // A Space (#1355): who talks and about what, for the Wall's live
      // sessions. What they say stays on the node.
      if (t?.active && t.kind === "talk") {
        base.space = {
          agents: Array.isArray(t.agents) ? t.agents.map(String).slice(0, 4) : [],
          topic: String(t.topic || "").slice(0, 200),
          startedAt: typeof t.startedAt === "number" ? new Date(t.startedAt).toISOString() : String(t.startedAt || ""),
        }
      }
      if (t?.active && t.kind === "lesson") {
        base.lesson = {
          agentId: t.agentId ?? null, mode: String(t.mode || "teach"), goal: String(t.goal || ""),
          step: Number(t.step) || 0, saying: String(t.saying || ""), startedAt: String(t.startedAt || ""),
        }
      }
    }
    // Remote nodes answer 403 (loopback-only), which just means no attach data.
    if (attachRes && attachRes.ok) {
      const body: any = await attachRes.json().catch(() => null)
      if (body && Array.isArray(body.sessions)) applyAttachSessions(base, body.sessions, body.saved ?? {})
    }
    base.reachable = true
    // Expose mesh peer info for discovery, but the caller does fan-out separately.
    ;(base as any)._peers = Array.isArray(meshRes?.ok ? await meshRes.json() : null) ? (base as any)._peers : undefined
  } catch (e: any) {
    base.error = e.message || String(e)
    // The body ran out of time mid-read: slow, not down (#1442).
    if (signal?.aborted) { base.error = "timed out"; base.checking = true }
  }
  return base
}

// Lazy /admin/wiki/* handler — built once per dashboard process. The
// WikiHub it wraps reads articles from disk on every request (no
// in-memory cache), so absorbs and edits from elsewhere show up
// without a restart.
let _wikiHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null
function getOrCreateWikiHandler(_ctx: { config: DaemonConfig; token?: string }): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
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
    // The page curator bubble (#818). It asks the daemon on load and
    // stays hidden when wiki.curator.enabled is off there, so a settings
    // change shows without restarting the dashboard.
    curator: true,
    curatorToken: (req) => pageToken(req, _ctx.token),
    // No remote-peer browsing in the embedded view — keeps the dashboard
    // independent of mesh state. Operators who want cross-mesh wiki nav
    // can still run `agentx wiki serve --peer <url>`.
  })
  return _wikiHandler
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

/** GET /api/mesh/feed: the primary daemon's recent events, task steps left out. */
async function serveMeshFeed(res: ServerResponse, config: DaemonConfig, q: URLSearchParams): Promise<void> {
  const limit = Math.max(1, Math.min(200, Number(q.get("limit")) || 50))
  const primary = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const token = process.env.MESH_TOKEN || dashboardTokenForNode(config.dashboard, primary)
  try {
    const r = await fetch(`${primary}/events/recent?skip=task:step&limit=${limit}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) { sendJson(res, 502, { error: `daemon answered ${r.status}` }); return }
    const body = await r.json() as { events?: unknown[] }
    sendJson(res, 200, { node: config.node.name || config.node.id, events: body.events ?? [] })
  } catch (e: any) { sendJson(res, 502, { error: e.message || "daemon unreachable" }) }
}

/** Every daemon this dashboard is allowed to read: the primary, the
 *  explicitly configured extras, and whatever the primary's /mesh reports.
 *  Shared by the live snapshot and the analytics fan-out so both agree on
 *  what "the fleet" means, and so the analytics drill-down proxy has the
 *  same allowlist as the task proxies. */
export async function resolveNodeTargets(daemon: DaemonConfig, signal?: AbortSignal): Promise<NodeTarget[]> {
  const dash = daemon.dashboard
  const primaryUrl = dash.daemonUrl.replace(/\/+$/, "")
  const primaryToken = dashboardTokenForNode(dash, primaryUrl)
  const seen = new Map<string, NodeTarget>()
  seen.set(primaryUrl, { name: "primary", url: primaryUrl, token: primaryToken })
  for (const d of dash.daemons) {
    const key = d.url.replace(/\/+$/, "")
    if (!seen.has(key)) seen.set(key, { name: d.name, url: key, token: dashboardTokenForNode(dash, key) })
  }
  const meshPeers = await fetchMeshPeers(primaryUrl, primaryToken, signal)
  for (const p of meshPeers) if (!seen.has(p.url)) seen.set(p.url, { ...p, token: dashboardTokenForNode(dash, p.url) })
  return [...seen.values()]
}

// #193 — each node gets its own budget: one slow daemon used to exhaust a
// shared 3 s and vanish from Live entirely.
const TARGETS_TIMEOUT_MS = 3_000
const NODE_TIMEOUT_MS = 6_000
/** How long a node's last good data is shown (marked stale) after it fails. */
const STALE_NODE_TTL_MS = 5 * 60_000
const lastGoodNode = new Map<string, { node: NodeLive; at: number }>()
const inflightSnapshots = new Map<string, Promise<LiveSnapshot>>()

/** A quick snapshot (#1442) waits this long for each node; one still
 *  answering shows its last good data, or nothing yet, marked checking. */
const QUICK_NODE_MS = 1_500
/** One read per node at a time for the live view: a quick snapshot asked
 *  again while a node is slow joins its read instead of starting another. */
const inflightNodes = new Map<string, Promise<NodeLive>>()

/** One build at a time per view: every open Live tab and the SSE ticks share
 *  it, so a slow daemon is not hit by piled-up overlapping snapshots. */
function buildLiveSnapshot(
  daemon: DaemonConfig,
  day?: { date: string; timezone: string },
  quick = false,
): Promise<LiveSnapshot> {
  const key = day ? `${day.date}|${day.timezone}` : quick ? "live|quick" : "live"
  const running = inflightSnapshots.get(key)
  if (running) return running
  const build = (async () => {
    const targets = await resolveNodeTargets(daemon, AbortSignal.timeout(TARGETS_TIMEOUT_MS))
    const nodes = await Promise.all(targets.map(async (d) => {
      if (day) return fetchDaemonAgents(d.url, d.token, AbortSignal.timeout(NODE_TIMEOUT_MS), day)
      let asking = inflightNodes.get(d.url)
      if (!asking) {
        asking = fetchDaemonAgents(d.url, d.token, AbortSignal.timeout(NODE_TIMEOUT_MS))
          .then((node) => withLastGood(d.url, node))
          .finally(() => inflightNodes.delete(d.url))
        inflightNodes.set(d.url, asking)
      }
      if (!quick) return asking
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), QUICK_NODE_MS) })
      const node = await Promise.race([asking, late]).finally(() => clearTimeout(timer))
      return node ?? stillChecking(d)
    }))
    return { ts: new Date().toISOString(), nodes, concurrent: liveOverlaps(nodes) }
  })().finally(() => inflightSnapshots.delete(key))
  inflightSnapshots.set(key, build)
  return build
}

/** A node a quick snapshot is still waiting on: its last good data marked
 *  checking, or an empty row by the name it was listed under. */
function stillChecking(d: NodeTarget, now: number = Date.now()): NodeLive {
  const good = lastGoodNode.get(d.url)
  if (good && now - good.at <= STALE_NODE_TTL_MS) return { ...good.node, stale: true, staleSince: new Date(good.at).toISOString(), checking: true }
  return { id: d.url, name: d.name, url: d.url, reachable: false, agents: [], checking: true }
}

export function withLastGood(url: string, node: NodeLive, now: number = Date.now()): NodeLive {
  if (node.reachable && !node.error) {
    lastGoodNode.set(url, { node, at: now })
    return node
  }
  const good = lastGoodNode.get(url)
  if (!good || now - good.at > STALE_NODE_TTL_MS) return node
  return { ...good.node, stale: true, staleSince: new Date(good.at).toISOString(), error: node.error, ...(node.checking ? { checking: true } : {}) }
}

/** Test-only. */
export function resetLiveCaches(): void {
  lastGoodNode.clear()
  inflightSnapshots.clear()
  inflightNodes.clear()
}

export function applyAttachSessions(
  node: NodeLive,
  sessions: Array<{ sessionId: string; cwd?: string; agentIds?: string[]; mode?: string; lastSeenAt?: number; registeredAt?: number; pending?: number }>,
  saved: Record<string, { agentIds?: string[]; mode?: string; cwd?: string; savedAt?: number }>,
): void {
  const project = (cwd?: string) => (cwd ? cwd.replace(/\/+$/, "").split("/").pop() || cwd : "")
  const rows: NonNullable<NodeLive["attachSessions"]> = sessions.map((s) => ({
    session: String(s.sessionId).slice(0, 8),
    project: project(s.cwd),
    agentIds: Array.isArray(s.agentIds) ? s.agentIds : [],
    mode: String(s.mode || "notify"),
    lastSeenAt: Number(s.lastSeenAt) || 0,
    ...(Number(s.registeredAt) > 0 ? { startedAt: Number(s.registeredAt) } : {}),
    pending: Number(s.pending) || 0,
  }))
  const live = new Set(sessions.map((s) => s.sessionId))
  for (const [id, b] of Object.entries(saved)) {
    if (live.has(id) || !Array.isArray(b.agentIds) || b.agentIds.length === 0) continue
    rows.push({
      session: id.slice(0, 8), project: project(b.cwd), agentIds: b.agentIds,
      mode: String(b.mode || "notify"), lastSeenAt: Number(b.savedAt) || 0, pending: 0, waiting: true,
    })
  }
  node.attachSessions = rows
  for (const agent of node.agents) {
    const row = rows.find((r) => r.agentIds.includes(agent.id) && !r.waiting) ?? rows.find((r) => r.agentIds.includes(agent.id))
    if (row) agent.attached = { session: row.session, project: row.project, mode: row.mode, lastSeenAt: row.lastSeenAt, waiting: row.waiting }
  }
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
  let busy = false
  const tick = async () => {
    // Never stack ticks: a slow build is waited out, not multiplied.
    if (busy) return
    busy = true
    try {
      const snap = await buildLiveSnapshot(daemon)
      send("snapshot", snap)
    } catch (e: any) {
      send("error", { message: e.message })
    } finally {
      busy = false
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
  const tokenForNode = dashboardTokenForNode(ctx.config.dashboard, target)
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
  const tokenForNode = dashboardTokenForNode(ctx.config.dashboard, target)
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
    })
    res.end(body)
  } catch (e: any) {
    sendJson(res, 502, { error: e.message || "upstream fetch failed" })
  }
}

/**
 * Cross-node POST proxy for the live page's Stop / Update controls.
 * Forwards the operator's request body verbatim to the originating daemon's
 * /api/tasks/:taskId/{cancel|followup} endpoint. Same allowlist + token
 * resolution as proxyTaskStream / proxyTaskHistory.
 */
async function proxyTaskAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { config: DaemonConfig },
  nodeUrl: string,
  taskId: string,
  kind: "cancel" | "followup",
): Promise<void> {
  await proxyNodePost(req, res, ctx, nodeUrl, `/api/tasks/${encodeURIComponent(taskId)}/${kind}`)
}

/** POST to a daemon the dashboard may read, with that node's token. The
 *  node must be in the allowlist, so this is never an open proxy. */
async function proxyNodePost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { config: DaemonConfig },
  nodeUrl: string,
  upstreamPath: string,
): Promise<void> {
  let body: unknown = {}
  try { body = (await readJson(req)) ?? {} } catch { /* leave default */ }
  const r = await postToNode(ctx.config, nodeUrl, upstreamPath, body)
  res.writeHead(r.status, { "Content-Type": r.contentType })
  res.end(r.text)
}

/** POST to a daemon the dashboard may read, with that node's token. The
 *  node must be in the allowlist, so this is never an open proxy. */
async function postToNode(
  config: DaemonConfig,
  nodeUrl: string,
  upstreamPath: string,
  body: unknown,
): Promise<{ status: number; text: string; contentType: string }> {
  const asJson = (status: number, b: unknown) => ({ status, text: JSON.stringify(b), contentType: "application/json" })
  const target = nodeUrl.replace(/\/+$/, "")
  const allowed = new Set<string>()
  allowed.add(config.dashboard.daemonUrl.replace(/\/+$/, ""))
  for (const d of config.dashboard.daemons) allowed.add(d.url.replace(/\/+$/, ""))
  try {
    const peers = await fetchMeshPeers(config.dashboard.daemonUrl.replace(/\/+$/, ""), config.dashboard.token)
    for (const p of peers) allowed.add(p.url.replace(/\/+$/, ""))
  } catch { /* */ }
  if (!allowed.has(target)) return asJson(403, { error: "node not in dashboard allowlist", target })
  const tokenForNode = dashboardTokenForNode(config.dashboard, target)
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" }
  if (tokenForNode) headers["Authorization"] = `Bearer ${tokenForNode}`
  try {
    const r = await fetch(`${target}${upstreamPath}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) })
    return { status: r.status, text: await r.text(), contentType: r.headers.get("content-type") || "application/json; charset=utf-8" }
  } catch (e: any) {
    return asJson(502, { error: e.message || "upstream fetch failed" })
  }
}

/** What the phone app's Alerts tab needs. The dashboard shares the daemon's
 *  folder (as it does for tokens.json), so it opens the same SQLite file
 *  the daemon's PushAdapter sends from. */
/** Presence and read marks from the phone app (#1138 step B), written to
 *  the SQLite file the daemon reads. One per dashboard process. */
let _appReach: AppReachDeps | null = null
function appReach(): AppReachDeps {
  _appReach ??= appReachDeps({
    db: () => dashboardDb(),
    requestOfCard: (id) => {
      try {
        return requestStoreFor({ root: process.cwd() })?.byLink("card", id)?.id ?? null
      } catch (e: any) {
        console.warn(`[reach] request of card ${id} not read: ${e?.message ?? e}`)
        return null
      }
    },
    log: (m) => console.warn(m),
  })
  return _appReach
}

function appPushDeps(config: DaemonConfig): AppPushDeps {
  const push = config.channels.push
  const off = (reason: string): AppPushDeps => ({ store: () => null, publicKey: () => null, keepRecent: 0, allowedHosts: [], reason })
  if (!push.enabled) return off("Notifications are off. On the computer, run: agentx notifications push --enable")
  if (push.relayTo) {
    // #711 — this node relays: the phone subscribes on the push host,
    // through this node's daemon (POST /push/app, push-bridge.ts).
    const primary = config.dashboard.daemonUrl.replace(/\/+$/, "")
    const token = process.env.MESH_TOKEN || dashboardTokenForNode(config.dashboard, primary)
    relayedPushHere()
    return {
      ...off(`Can't reach ${push.relayTo}, the computer that sends notifications`),
      async forward(call) {
        const r = await fetch(`${primary}/push/app`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ op: "app", call }),
          signal: AbortSignal.timeout(20_000),
        })
        const body = await r.json().catch(() => ({})) as { status?: unknown; body?: unknown; error?: string }
        if (!r.ok || typeof body.status !== "number") throw new Error(body.error || `the daemon answered ${r.status}`)
        return { status: body.status, body: body.body ?? {} }
      },
    }
  }
  const keysPath = pushKeysPath(push.keysFile)
  return {
    store: () => {
      const db = dashboardDb()
      return db ? new PushStore(db) : null
    },
    publicKey: () => readPushKeys(keysPath)?.publicKey ?? null,
    keepRecent: push.keepRecent,
    allowedHosts: push.allowedHosts,
    reason: "The database on this computer is unavailable, so notifications can't be saved.",
    alertsRead: (items) => appReach().pushRead(items),
  }
}

/** Places and place reminders (#676), for the phone app and /places.
 *  Reminders are pushed through the daemon's push channel, so they are
 *  only sent where the phone's pushes are: push on here, not relayed. */
function appPlacesDeps(config: DaemonConfig): PlacesDeps {
  const push = config.channels.push
  const url = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const fire = push.enabled && !push.relayTo
    ? daemonFireDeps({ url, token: dashboardTokenForNode(config.dashboard, url), operatorKey: loadOperatorKey(process.cwd()) ?? undefined })
    : null
  const reason = push.relayTo
    ? `this computer relays notifications to ${push.relayTo}; place reminders work on a phone paired with ${push.relayTo}.`
    : appPushDeps(config).reason
  return placesDeps(config, process.cwd(), fire, reason)
}

/** What waits on the other nodes of the dashboard, each read from that
 *  node's own dashboard (/api/admin/approvals). */
async function remoteApprovals(config: DaemonConfig): Promise<NodeApprovals[]> {
  return Promise.all(config.dashboard.daemons.map(async (d): Promise<NodeApprovals> => {
    const out: NodeApprovals = { node: d.url.replace(/\/+$/, ""), nodeName: d.name, items: [] }
    const peer = findPeer(d.url, config)
    if (!peer) return out
    try {
      const r = await fetch(`${peer.url}/api/admin/approvals`, {
        headers: { "X-Agentx-Peer": "primary", ...(peer.token ? { Authorization: `Bearer ${peer.token}` } : {}) },
        signal: AbortSignal.timeout(4000),
      })
      if (!r.ok) { out.error = `HTTP ${r.status}`; return out }
      const body = await r.json() as { items?: InboxItem[] }
      out.items = (body.items ?? []).map(inboxToDesk)
    } catch (e: any) { out.error = e.message || "unreachable" }
    return out
  }))
}

/** What the phone app's Fleet and Activity tabs read and act through
 *  (app-fleet.ts). Built per request, like every other handler here, so a
 *  config reload is picked up without restarting the dashboard. */
function appFleetDeps(config: DaemonConfig): AppFleetDeps {
  const primary = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const parse = (text: string) => { try { return JSON.parse(text) } catch { return { error: text.slice(0, 200) } } }
  return {
    snapshot: (day) => buildLiveSnapshot(config, day),
    async nodePost(nodeUrl, path, body) {
      const r = await postToNode(config, nodeUrl, path, body)
      return { status: r.status, body: parse(r.text) }
    },
    async approvals() {
      const local: NodeApprovals = { node: primary, nodeName: config.node?.name || "this computer", items: [] }
      try {
        local.items = listInbox({ root: process.cwd() }).items.map(inboxToDesk)
      } catch (e: any) { local.error = e.message }
      return [local, ...await remoteApprovals(config)]
    },
    async decide(nodeUrl, key, action, by, answer = {}) {
      const target = nodeUrl.replace(/\/+$/, "")
      if (target === primary) {
        const settings = readApprovalSettings()
        const r = await decide({ root: process.cwd() }, key, action, { laterHours: settings.laterHours, by, ...answer })
        return r.ok ? { status: 200, body: { ok: true, message: r.message } } : { status: 409, body: { error: r.error } }
      }
      const peer = findPeer(target, config)
      if (!peer) return { status: 403, body: { error: "node not in dashboard allowlist", target } }
      try {
        const r = await fetch(`${peer.url}/api/admin/approvals/decide`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "agentx-board",
            "X-Agentx-Peer": "primary",
            ...(peer.token ? { Authorization: `Bearer ${peer.token}` } : {}),
          },
          body: JSON.stringify({ key, action, ...answer }),
          signal: AbortSignal.timeout(10000),
        })
        return { status: r.status, body: parse(await r.text()) }
      } catch (e: any) {
        return { status: 502, body: { error: e.message || "peer dashboard unreachable" } }
      }
    },
  }
}

/** What the phone app's Desk tab reads and answers through (app-desk.ts).
 *  The board is put together from this node's sources on every read:
 *  what waits (every node's inbox), the requests, the finished decision
 *  cards, and the runs that are live right now. */
function appDeskDeps(config: DaemonConfig): AppDeskDeps {
  const primary = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const fleet = appFleetDeps(config)
  const ctx = { root: process.cwd() }
  return {
    async board() {
      // This node's waiting items are the owner's one list (desk/owner-list.ts),
      // the same the Approvals page and the digest read; other nodes' come from them.
      const [inbox, snap] = await Promise.all([remoteApprovals(config), fleet.snapshot()])
      const owner = readOwnerList(ctx, { url: primary, name: config.node?.name || "this computer" })
      let liveRuns: ReadonlySet<string> = new Set<string>()
      const errors: string[] = []
      const here = snap.nodes.find((n) => n.url.replace(/\/+$/, "") === primary)
      // A last-known answer is no proof that a run is live now.
      if (!here || !here.reachable || (here as { stale?: boolean }).stale) {
        errors.push("The running tasks could not be read, so no request is shown as working now.")
      } else {
        liveRuns = liveRunRefs(here.agents)
      }
      const now = Date.now()
      let requests: DeskRequest[] | null = null
      try {
        const store = requestStoreFor(ctx)
        if (store) {
          requests = [...store.listOpen(), ...store.listClosedSince(now - DESK_DONE_DAYS * 86_400_000, DESK_DONE_MAX)]
            .map((record) => ({ record, links: store.links(record.id) }))
        }
      } catch (e: any) { errors.push(`Requests could not be read: ${e.message}`) }
      let cards: DecisionCard[] = []
      try { cards = listCards(ctx.root).filter((c) => c.status !== "pending") } catch (e: any) { errors.push(`Finished cards could not be read: ${e.message}`) }
      const deferred = new Set(Object.entries(readInboxState(ctx.root).snoozed).filter(([, until]) => Date.parse(until) > now).map(([key]) => key))
      const board = buildDesk({ now, node: primary, nodeName: config.node?.name || "this computer", inbox, requests, cards, liveRuns, deferred, owner })
      return { ...board, errors: [...board.errors, ...errors] }
    },
    async reply(id, text) {
      return handleRequestsPanel("POST", `${REQUESTS_PANEL_PREFIX}/reply`, { id, text }, ctx) as Promise<NodeReply>
    },
  }
}

/** What the phone app's Chat tab talks through (app-chat.ts): turns go to
 *  the primary daemon with its token, the picker reads the live snapshot,
 *  and conversations live in the same SQLite file as the push tables. */
/** Wall Live's controls (#1439) under the Wall's guarded prefix. */
const WALL_LIVE_ACTIONS_PREFIX = "/api/admin/wall/live"
const WALL_LIVE_CLI_PATH = `${WALL_LIVE_ACTIONS_PREFIX}/cli`
const WALL_LIVE_DISCOVER_PATH = `${WALL_LIVE_ACTIONS_PREFIX}/discover`
/** Each control's node API, the one classic Live called. */
const WALL_LIVE_UPSTREAM = new Map([
  ["resume", "/api/signals/resume"],
  ["drop", "/api/signals/drop"],
  ["pause", "/api/signals/stop"],
  ["restart", "/daemon/restart"],
  ["restart-cancel", "/daemon/restart/cancel"],
  ["lesson-stop", "/voice/stop"],
])

/** One member store per dashboard process, so its hourly log pruning holds;
 *  a new one when the retention setting changes. */
let _members: { days: number; store: MemberStore } | null = null
function membersStore(retentionDays: number): MemberStore {
  if (_members?.days !== retentionDays) _members = { days: retentionDays, store: new MemberStore(process.cwd(), Date.now, retentionDays) }
  return _members!.store
}

function appChatDeps(config: DaemonConfig): AppChatDeps {
  const url = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const token = dashboardTokenForNode(config.dashboard, url)
  const fleet = appFleetDeps(config)
  return {
    store: () => {
      const db = dashboardDb()
      return db ? new AppChatStore(db) : null
    },
    // The operator key proves to the daemon that a phone turn is the
    // owner's (#393). Read here, next to agentx.json; the daemon creates it.
    daemon: { url, token, name: config.node?.name, operatorKey: loadOperatorKey(process.cwd()) ?? undefined },
    snapshot: () => buildLiveSnapshot(config),
    meshPeers: async () => {
      const r = await fetch(url + "/mesh", { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) })
      return r.ok ? (await r.json()) as AppMeshPeer[] : []
    },
    nodePost: (nodeUrl, path, body) => fleet.nodePost(nodeUrl, path, body),
    tokenFor: (nodeUrl) => dashboardTokenForNode(config.dashboard, nodeUrl.replace(/\/+$/, "")),
    ...finishAlertDeps(config, url, token),
  }
}

/** Finish notifications for the phone app (#265). The push channel runs in
 *  the daemon, so the dashboard asks it through POST /channel/send with the
 *  phone's device id as the chat id: that addresses one phone, never all.
 *  Off when push is off here, when the phone has no subscription, or when
 *  it turned the setting off in Alerts. On a relaying node the daemon
 *  forwards it to the host, which finds the phone by this node's name. */
function finishAlertDeps(config: DaemonConfig, url: string, token: string | undefined): Pick<AppChatDeps, "finishAlerts" | "notifyFinish"> {
  const pushDeps = appPushDeps(config)
  return {
    finishAlerts: (deviceId) => {
      // A relay asks the host's answer it last passed on (#711).
      if (pushDeps.forward) return relayedPush.finishOn(deviceId)
      const store = pushDeps.store()
      return !!store && store.chatFinishOn(deviceId) && store.list(deviceId).length > 0
    },
    notifyFinish: async (p) => {
      try {
        const r = await fetch(url + "/channel/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          // First line is the title (splitTitle in channels/ntfy.ts); the
          // one button's link is where a tap on the notification lands.
          body: JSON.stringify({ channel: "push", chatId: p.deviceId, text: `${p.title}\n${p.body}`, buttons: [{ label: "Open", url: p.url }] }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!r.ok) console.error(`[app] finish notification not sent: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
      } catch (e: any) {
        console.error(`[app] finish notification not sent: ${e?.message || e}`)
      }
    },
  }
}

/** Follows the primary daemon's delegation events and files each phone
 *  reply in its conversation. Reads replies from the node that published
 *  them, with the token the dashboard holds for it. */
function appCallbackPuller(config: DaemonConfig): AppCallbackPuller {
  const primary = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const tokenFor = (url: string) => dashboardTokenForNode(config.dashboard, url.replace(/\/+$/, ""))
  const auth = (url: string): Record<string, string> => {
    const t = tokenFor(url)
    return t ? { Authorization: `Bearer ${t}` } : {}
  }
  const chat = appChatDeps(config)
  return new AppCallbackPuller({
    recent: async (since, limit) => {
      const q = new URLSearchParams({ kind: "delegation", limit: String(limit) })
      if (since) q.set("since", since)
      const r = await fetch(`${primary}/events/recent?${q}`, { headers: auth(primary), signal: AbortSignal.timeout(5000) })
      if (!r.ok) throw new Error(`the daemon answered ${r.status}`)
      const body = await r.json() as { events?: CallbackEvent[]; gap?: boolean }
      return { events: Array.isArray(body.events) ? body.events : [], gap: body.gap === true }
    },
    nodeUrl: async (node) => {
      const snap = await buildLiveSnapshot(config)
      const n = snap.nodes.find((x) => x.name === node || x.id === node)
      return n?.url ? n.url.replace(/\/+$/, "") : null
    },
    conversationUrl: async (conv) => {
      if (conv.node === "local") return primary
      const peer = (await chat.meshPeers().catch(() => [] as AppMeshPeer[])).find((p) => p.peer === conv.node)
      return peer ? peer.peerUrl.replace(/\/+$/, "") : null
    },
    fetchReply: async (url, taskId) => {
      const r = await fetch(`${url}/a2a/delegations/${encodeURIComponent(taskId)}/reply`, { headers: auth(url), signal: AbortSignal.timeout(5000) })
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`the node answered ${r.status}`)
      return await r.json() as CallbackReplyBody
    },
    store: chat.store,
    presence: appPresence(),
    finishAlerts: chat.finishAlerts,
    notifyFinish: chat.notifyFinish,
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
  })
}

/** What the phone app's voice routes forward to (app-voice.ts): the same
 *  daemon and token as Chat, and the conversations a spoken answer is
 *  checked against. */
function appVoiceDeps(config: DaemonConfig): AppVoiceDeps {
  const url = config.dashboard.daemonUrl.replace(/\/+$/, "")
  return {
    store: () => {
      const db = dashboardDb()
      return db ? new AppChatStore(db) : null
    },
    daemon: { url, token: dashboardTokenForNode(config.dashboard, url) },
  }
}

function appCameraDeps(config: DaemonConfig): AppCameraDeps {
  const url = config.dashboard.daemonUrl.replace(/\/+$/, "")
  return { daemon: { url, token: dashboardTokenForNode(config.dashboard, url) }, nodeName: config.node.name }
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
  sendJson(res, 200, await withForgeStatus(await buildFleetActivitySnapshot(hours, ctx.config)))
}

/** dashboard.token (if configured), or a stored token with dashboard:write. */
function adminTokenOk(req: IncomingMessage, ctx: Ctx): boolean {
  if (!ctx.token) return true
  const authHeader = req.headers.authorization || ""
  const got = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
  if (got === ctx.token || hasSession(req, ctx.token)) return true
  const rec = got ? new TokenStore().verify(got) : null
  return !!rec && recordHasScope(rec, "dashboard:write")
}

/** The owner, for a Wall write (#1454): the dashboard token, its session
 *  cookie or a dashboard:write key. With no token set, only a caller on
 *  this machine: a board bound off loopback without one reads, never writes. */
function wallOwnerOk(req: IncomingMessage, ctx: Ctx): boolean {
  return adminTokenOk(req, ctx) && (!!ctx.token || !isOffBox(req))
}

const STREAM_TICKET_PATH = "/api/admin/stream-ticket"
const STREAM_PATHS = new Set(["/api/admin/logs/stream", "/api/admin/activity-graph/stream"])

/** An EventSource GET on a stream route with a valid ?st= ticket. Tickets
 *  open nothing else: every other read sends the header or the cookie. */
function streamTicketOk(req: IncomingMessage, ctx: Ctx, method: string, path: string): boolean {
  return method === "GET" && STREAM_PATHS.has(path) && hasStreamTicket(req, ctx.token)
}

/** A page that carries AX_LOCAL_TOKEN (#1306). Off-box, a caller that has not
 *  signed in goes to /login; one that has gets the page without the token
 *  (pageToken), and its session cookie carries the page's API calls. */
function pageAllowed(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): boolean {
  if (ctx.token && isOffBox(req) && !adminTokenOk(req, ctx)) {
    redirectToLogin(res, path)
    return false
  }
  return true
}

function localNodeName(config: DaemonConfig): string {
  return config.node?.name || config.node?.id || "local"
}

/** What the Wall reads on this node; null when it keeps no requests. */
function wallDeps(config: DaemonConfig): WallDeps | null {
  const ictx = { root: process.cwd() }
  const store = requestStoreFor(ictx)
  if (!store) return null
  const agents = config.agents ?? {}
  const staleAfterHours = readRequestSettings().staleAfterHours
  const workspaceOf = (id: string) => agents[id]?.workspace ?? null
  return {
    store,
    plans: planStoreFor(ictx),
    db: dashboardDb(),
    now: Date.now(),
    staleAfterHours,
    isAgent: (id) => Object.prototype.hasOwnProperty.call(agents, id),
    workspaceOf,
    projects: wallProjects(config.dashboard?.wall, staleAfterHours, workspaceOf),
    capacityThreshold: config.dashboard?.wall?.capacity?.threshold ?? null,
    cards: () => listCards(ictx.root, "pending"),
    gitlabUrl: forgeConnectorsOf(config).gitlab?.url ?? null,
  }
}

/** GitLab time tracking for the Wall (#1189), kept across reads so its
 *  cache holds; rebuilt when the GitLab connector changes. Null: this node
 *  has no GitLab connector, so no post gets forge time. */
let wallTime: { key: string; source: WallForgeTimeSource } | null = null
function wallTimeSource(config: DaemonConfig): WallForgeTimeSource | null {
  if (!config.channels?.gitlab && !config.requests?.checkers?.gitlab) return null
  const gitlab = forgeConnectorsOf(config).gitlab
  if (!gitlab) return null
  const key = `${gitlab.url}\n${gitlab.token ?? ""}`
  if (wallTime?.key !== key) wallTime = { key, source: wallForgeTime(gitlab.url, gitlabTimeReader(gitlab)) }
  return wallTime.source
}

/** The home state of GitHub and GitLab posts (#1184), kept like wallTime.
 *  Null: this node has neither connector. */
let wallState: { key: string; source: WallForgeStateSource } | null = null
function wallStateSource(config: DaemonConfig): WallForgeStateSource | null {
  const c = forgeConnectorsOf(config)
  if (!c.github && !c.gitlab) return null
  const key = JSON.stringify(c)
  if (wallState?.key !== key) wallState = { key, source: wallForgeState({ github: !!c.github, gitlabUrl: c.gitlab?.url ?? null }, forgeReader(c)) }
  return wallState.source
}

const wallForgeSources = (config: DaemonConfig) => [wallTimeSource(config), wallStateSource(config)]

/** Reported failures for the Failures tab (#1186), kept like wallTime.
 *  Null: `wall.reportedIssues` is not set, so nothing is read. */
let wallReportedCached: { key: string; source: WallReportedSource } | null = null
function wallReportedSource(config: DaemonConfig): WallReportedSource | null {
  const cfg = config.wall?.reportedIssues
  if (!cfg) return null
  const c = forgeConnectorsOf(config)
  const key = JSON.stringify([cfg, c])
  if (wallReportedCached?.key !== key) wallReportedCached = { key, source: wallReported(cfg, reportedReader(c)) }
  return wallReportedCached.source
}

/** A quick fleet read waits this long for each peer (#1442); a peer still
 *  answering after that shows its last reply, or "checking", and the page
 *  asks again. The request goes on and fills the cache below. */
const WALL_PEER_QUICK_MS = 600
const WALL_PEER_TIMEOUT_MS = 8_000
/** A peer's last reply younger than this stands in as is while the peer is
 *  slow to answer; an older one, up to the stale limit, says "checking". */
const WALL_PEER_FRESH_MS = 60_000
const WALL_PEER_STALE_MS = 10 * 60_000
type WallPeerReply = { name: string; id: string; body?: any; error?: string; answeredMs?: number }
/** Each peer's last Wall reply, by address and query: a reply or an error. */
const lastPeerWall = new Map<string, { reply: WallPeerReply; at: number }>()
/** One request per peer and query at a time: a page that asks again while
 *  a slow peer still builds joins that request instead of piling up. */
const inflightPeerWall = new Map<string, Promise<WallPeerReply>>()
/** One fleet build per query at a time, shared by every open Wall. */
const inflightWallFleet = new Map<string, Promise<unknown>>()

/** Test-only. */
export function resetWallFleetCaches(): void {
  lastPeerWall.clear()
  inflightPeerWall.clear()
  inflightWallFleet.clear()
}

/** The Wall across the mesh: this node's posts, then each configured
 *  peer's, every post tagged with the node it lives on. A peer that does
 *  not answer is listed as unreachable; the others still show (#1180). */
function buildWallFleet(q: URLSearchParams, ctx: Ctx): Promise<unknown> {
  const key = ["days", "timings", "quick"].map((k) => q.get(k) ?? "").join("|")
  const running = inflightWallFleet.get(key)
  if (running) return running
  const build = buildWallFleetOnce(q, ctx).finally(() => inflightWallFleet.delete(key))
  inflightWallFleet.set(key, build)
  return build
}

async function buildWallFleetOnce(q: URLSearchParams, ctx: Ctx): Promise<unknown> {
  const days = q.get("days") ?? "7"
  const withTimings = q.get("timings") === "1"
  const quick = q.get("quick") === "1"
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  const deps = wallDeps(ctx.config)
  // Projects (#1190): this node's mapping also claims the peer posts it
  // names, and every project configured here gets an overview row.
  const projects = deps?.projects ?? null
  const now = Date.now()
  // The peers are asked first and build their Walls while this node builds
  // its own, so the fleet takes about the slowest node's time, not the sum
  // of all of them (#1252).
  const peers = (ctx.config.dashboard?.daemons || []).filter((d) => d.url)
  const query = `?days=${encodeURIComponent(days)}${withTimings ? "&timings=1" : ""}${quick ? "&quick=1" : ""}`
  const askPeer = async (d: { url: string; name?: string }): Promise<WallPeerReply> => {
    const id = d.url.replace(/\/+$/, "")
    const name = d.name || id
    const peer = findPeer(id, ctx.config)
    if (!peer) return { name, id, error: "no dashboard address" }
    try {
      const r = await fetch(`${peer.url}${WALL_PREFIX}${query}`, {
        headers: { Accept: "application/json", "X-Agentx-Peer": "primary", ...(peer.token ? { Authorization: `Bearer ${peer.token}` } : {}) },
        signal: AbortSignal.timeout(WALL_PEER_TIMEOUT_MS),
      })
      if (!r.ok) return { name, id, error: `answered ${r.status}` }
      const body = await r.json() as any
      return { name, id, body, answeredMs: ms() }
    } catch (e: any) {
      return { name, id, error: e?.name === "TimeoutError" ? "timed out" : String(e?.message || e).slice(0, 120) }
    }
  }
  const peerReplies = Promise.all(peers.map(async (d): Promise<WallPeerReply & { checking?: boolean }> => {
    const id = d.url.replace(/\/+$/, "")
    const cacheKey = `${id}${query}`
    let asking = inflightPeerWall.get(cacheKey)
    if (!asking) {
      asking = askPeer(d).then((reply) => {
        lastPeerWall.set(cacheKey, { reply, at: Date.now() })
        return reply
      }).finally(() => inflightPeerWall.delete(cacheKey))
      inflightPeerWall.set(cacheKey, asking)
    }
    if (!quick) return asking
    // A quick read waits briefly; a peer still building shows its last
    // reply, or "checking" when it has none, never "does not answer".
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), WALL_PEER_QUICK_MS) })
    const reply = await Promise.race([asking, late]).finally(() => clearTimeout(timer))
    if (reply) return reply
    // A peer whose last answer was an error keeps that error meanwhile, so
    // a peer that is down does not read as "checking" on every refresh.
    const last = lastPeerWall.get(cacheKey)
    const age = last ? Date.now() - last.at : Infinity
    if (last?.reply.body && age < WALL_PEER_FRESH_MS) return last.reply
    if (last?.reply.body && age < WALL_PEER_STALE_MS) return { ...last.reply, checking: true }
    if (last?.reply.error) return last.reply
    return { name: d.name || id, id, checking: true }
  }))
  // Let the peer requests go out before the local build takes the thread.
  await new Promise<void>((r) => setImmediate(r))
  const local = (await wallLocal(WALL_PREFIX, new URLSearchParams({ days, ...(withTimings ? { timings: "1" } : {}), ...(quick ? { quick: "1" } : {}) }), ctx, deps)).body as any
  const localMs = ms()
  // `checking`: the peer is still answering this read (#1442).
  const nodes: Array<{ name: string; peer: string | null; ok: boolean; error?: string; syncedAt?: number; checking?: boolean }> = [
    { name: local.node, peer: null, ok: true, syncedAt: local.syncedAt },
  ]
  let pending = local.pending === true
  const tag = (items: any[], name: string, peer: string | null, daemonUrl: string | null) =>
    items.map((x) => ({ ...x, node: { name, peer, daemonUrl } }))
  const posts = tag(local.posts, local.node, null, null)
  const failures = tag(local.failures, local.node, null, null)
  const reported = local.reported ? tag([local.reported], local.node, null, null) : []
  // Goals (#1392): rows with the same id add up across nodes.
  const goalLists: unknown[][] = [Array.isArray(local.goals) ? local.goals : []]
  // Keyed by peer address: two peers can report the same node name.
  const peerTimingsOf: Record<string, unknown> = {}
  for (const { name, id, body, error, answeredMs, checking } of await peerReplies) {
    if (checking) pending = true
    if (body?.pending === true) pending = true
    if (!body) { nodes.push({ name, peer: id, ok: false, ...(error ? { error } : {}), ...(checking ? { checking: true } : {}) }); continue }
    const node = body.node || name
    nodes.push({ name: node, peer: id, ok: true, syncedAt: body.syncedAt, ...(checking ? { checking: true } : {}) })
    posts.push(...tag(Array.isArray(body.posts) ? body.posts : [], node, id, id).map((p) => claimBlocker(claimPost(p, projects, now), projects)))
    failures.push(...tag(Array.isArray(body.failures) ? body.failures : [], node, id, id))
    if (Array.isArray(body.goals)) goalLists.push(body.goals)
    if (body.reported && Array.isArray(body.reported.groups)) reported.push(...tag([body.reported], node, id, id))
    if (withTimings) peerTimingsOf[id] = { node, answeredMs, ...(body.timings ? { build: body.timings } : {}) }
  }
  posts.sort((a, b) => b.updatedAt - a.updatedAt)
  return { node: local.node, syncedAt: Date.now(), nodes, posts, failures, ...(reported.length ? { reported } : {}), ...(pending ? { pending: true } : {}), projects: projectOverview(posts, projects?.names),
    goals: mergeGoals(goalLists),
    // Capacity (#1191): counted here over every node's posts, with this node's threshold.
    capacity: wallCapacity(posts, deps?.capacityThreshold), staleAfterHours: local.staleAfterHours,
    ...(withTimings ? { timings: { totalMs: ms(), local: { doneMs: localMs, ...local.timings }, peers: peerTimingsOf } } : {}) }
}

/** This node's Wall reply: the posts, then the forge's word on them, then
 *  reported failures. With `?timings=1` on the list, the reply says how
 *  long each part took (#1252): numbers only. */
/** The Wall's calls to this node's daemon (#1316): the dashboard's token,
 *  and the operator key, since every one of them is the owner's. */
function wallDaemon(config: DaemonConfig): (method: "GET" | "POST", path: string, body?: unknown) => Promise<WallReply> {
  const url = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const token = dashboardTokenForNode(config.dashboard, url)
  const key = loadOperatorKey(process.cwd())
  return async (method, path, body) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (token) headers["Authorization"] = `Bearer ${token}`
    if (key) headers[OPERATOR_HEADER] = key
    try {
      const r = await fetch(url + path, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined, signal: AbortSignal.timeout(15_000) })
      return { status: r.status, body: await r.json().catch(() => ({ error: `HTTP ${r.status}` })) }
    } catch (e: any) {
      return { status: 502, body: { error: `The daemon on this computer did not answer: ${e?.message ?? e}` } }
    }
  }
}

async function wallLocal(path: string, q: URLSearchParams, ctx: Ctx, deps = wallDeps(ctx.config)): Promise<{ status: number; body: unknown }> {
  // A quick read (#1442) shows what the forge caches hold and says when a
  // read it started is still out, so the page asks again in a moment.
  const quick = q.get("quick") === "1"
  const sources = wallForgeSources(ctx.config)
  const reportedSource = wallReportedSource(ctx.config)
  const reply = handleWallApi(path, q, deps, localNodeName(ctx.config))
  const t1 = performance.now()
  const forged = await withForge(reply, deps, sources, quick)
  const t2 = performance.now()
  const out = await withReported(forged, path, reportedSource, quick)
  const body = out.body as any
  const timings = body?.timings
  if (timings) Object.assign(timings, { forgeMs: Math.round(t2 - t1), reportedMs: Math.round(performance.now() - t2) })
  if (quick && out.status === 200 && body && [...sources, reportedSource].some((s) => s?.busy())) body.pending = true
  return out
}

/** Weekly throughput across the mesh (#1192): every node's closures,
 *  claimed by this node's project mapping, counted here. A peer that does
 *  not answer (or is older than #1192) is listed and left out. */
async function buildWallThroughputFleet(ctx: Ctx): Promise<unknown> {
  const deps = wallDeps(ctx.config)
  const local = handleWallApi(`${WALL_PREFIX}/throughput`, new URLSearchParams(), deps, localNodeName(ctx.config)).body as any
  const nodes: Array<{ name: string; peer: string | null; ok: boolean; error?: string }> = [{ name: local.node, peer: null, ok: true }]
  const closures: WallClosure[] = [...local.closures]
  const owners = new Set<string>(local.owners)
  const projects = deps?.projects ?? null
  const peers = (ctx.config.dashboard?.daemons || []).filter((d) => d.url)
  await Promise.all(peers.map(async (d) => {
    const id = d.url.replace(/\/+$/, "")
    const name = d.name || id
    const peer = findPeer(id, ctx.config)
    if (!peer) { nodes.push({ name, peer: id, ok: false, error: "no dashboard address" }); return }
    try {
      const r = await fetch(`${peer.url}${WALL_PREFIX}/throughput`, {
        headers: { Accept: "application/json", "X-Agentx-Peer": "primary", ...(peer.token ? { Authorization: `Bearer ${peer.token}` } : {}) },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) { nodes.push({ name, peer: id, ok: false, error: `answered ${r.status}` }); return }
      const body = await r.json() as any
      nodes.push({ name: body.node || name, peer: id, ok: true })
      for (const c of Array.isArray(body.closures) ? body.closures : []) closures.push(claimClosure(c, projects))
      for (const o of Array.isArray(body.owners) ? body.owners : []) owners.add(o)
    } catch (e: any) {
      nodes.push({ name, peer: id, ok: false, error: e?.name === "TimeoutError" ? "timed out" : String(e?.message || e).slice(0, 120) })
    }
  }))
  const now = Date.now()
  return { node: local.node, syncedAt: now, nodes, throughput: wallThroughput(closures, { now, projectNames: projects?.names, owners: [...owners] }) }
}

async function buildFleetActivitySnapshot(hours: number, config: DaemonConfig): Promise<FleetSnapshot> {
  const localNodeId = config.node?.id || config.node?.name || "local"

  const parts: Array<{ nodeId: string; snap: FleetSnapshot }> = []

  // Local node: in-process call, no HTTP round-trip.
  const localSnap = buildLocalActivityGraphSnapshot(hours)
  if (localSnap) parts.push({ nodeId: localNodeId, snap: localSnap })

  // Each configured peer: HTTP fetch via the existing per-peer proxy logic.
  // Fire in parallel; whichever peers respond on time get merged in.
  const peerEntries = (config.dashboard?.daemons || []).filter((d) => d.url)
  const peerParts: Array<{ nodeId: string; snap: FleetSnapshot } | null> = await Promise.all(peerEntries.map(async (d) => {
    const peer = findPeer(d.url.replace(/\/+$/, ""), config)
    if (!peer) return null
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
        if (!r.ok) return null
        return { nodeId: d.name || d.url, snap: await r.json() as FleetSnapshot }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // Drop this peer from the merge; the rest of the snapshot remains usable.
      return null
    }
  }))
  // Keep local first: the merger reports parts[0] as the serving node.
  for (const p of peerParts) if (p) parts.push(p)

  return mergeFleetSnapshots(parts)
}

/** SSE-stream the daemon's stdout to the dashboard /admin/health Logs tab.
 *  Picks the best available source: prefers `journalctl -u agentx -f`
 *  (systemd-managed nodes like peer-server), falls back to `tail -F` on
 *  /tmp/agentx-daemon.log (Mac dev launches), or the tail of the
 *  workspace pid log if neither exists. Mirrors the source the
 *  `agentx daemon logs -f` CLI hits, so both surfaces show the same
 *  data.
 *
 *  The spawned process inherits the dashboard's permissions; on
 *  peer-server `peer` already has read access to its agentx unit's
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


