// --- Classic dashboard pages and their Wall views (#1447) ---
//
// The Wall replaces the classic dashboard page by page (epic #1449). This is
// the one list of every classic page a person can land on, and for each one
// where it stands:
//
//   wall     the Wall does everything the page did: the old address redirects
//            to its Wall view (classicRedirect) and no Wall link may point at it.
//   pending  the Wall does not match it yet. It is still served, and the
//            Wall may still link to it, until the issues in `blockedBy` close.
//   tool     kept on purpose as a tool page, not a dashboard page.
//
// A page moves from pending to wall in the PR that closes its last blocker:
// set `wall`, and the redirect and the Wall's link crawl (test/classic-routes
// .test.ts) follow. The wiki is its own space, like the Wall, and is not listed.

import { HUB_PATH } from "./hub-name"

export type ClassicStatus = "wall" | "pending" | "tool"

export interface ClassicRoute {
  /** The address as people type it; `<id>` marks a path segment. */
  path: string
  /** What the page is for, in a few words. */
  label: string
  status: ClassicStatus
  /** The Wall view it redirects to (status "wall"). */
  wall?: string
  /** Open issues the Wall still needs before the page can go (status "pending"). */
  blockedBy?: number[]
  /** What the Wall still lacks, for the PR list and the docs. */
  note?: string
}

export const CLASSIC_ROUTES: ClassicRoute[] = [
  { path: "/tasks/<id>", label: "One task's run", status: "wall", wall: "/#page=task", note: "The Task page (#1381): stream, steer, Stop." },
  { path: "/live", label: "Live", status: "wall", wall: HUB_PATH + "#page=live", note: "Redirected in board-dashboard.ts (#1439)." },
  { path: "/monitor", label: "Monitor", status: "pending", blockedBy: [1439, 1440], note: "Connect a CLI session; open actions of CLI sessions." },
  { path: "/mesh", label: "Operations", status: "pending", blockedBy: [1449], note: "Lifetime view (thread → run → step drill), Routines with stale verdicts, run analytics; no child issue yet." },
  { path: "/activity", label: "Activity", status: "pending", blockedBy: [1449], note: "Timeline lane view and the Map; no child issue yet. The Hub's Activity (#1429) has the run list." },
  { path: "/agents/<id>/history", label: "Agent history", status: "wall", wall: HUB_PATH + "#page=activity", note: "The agent's profile with its Activity tab (#1429)." },
  { path: "/approvals", label: "Approvals", status: "pending", blockedBy: [1440], note: "Deciding cards and inbox items." },
  { path: "/admin", label: "Settings", status: "pending", blockedBy: [1428] },
  { path: "/admin/agents/<id>", label: "Agent settings", status: "pending", blockedBy: [1428] },
  { path: "/admin/health", label: "Observability", status: "pending", blockedBy: [1428], note: "Also /admin/observability." },
  { path: "/guests", label: "Guests", status: "pending", blockedBy: [1428] },
  { path: "/admin/cost", label: "Cost", status: "wall", wall: HUB_PATH + "#status=open&view=cost", note: "Redirected in board-dashboard.ts (#1423, #1466)." },
  // Owner decision on #1420 (B): the org chart is edited on /org and the
  // Wall's Org page stays read-only (#1486 closed for it).
  { path: "/org", label: "Org chart editor", status: "tool", note: "Editing who reports to whom; the Hub's Org page reads it." },
  { path: "/people", label: "People", status: "wall", wall: HUB_PATH + "#page=people", note: "Redirected in people-panel.ts (#1441)." },
  { path: "/workflows", label: "Workflows", status: "pending", blockedBy: [1445] },
  { path: "/admin/graph", label: "Reviews", status: "pending", blockedBy: [1440], note: "Approve or reject a classification. Also /graph." },
  { path: "/admin/projects", label: "Projects", status: "pending", blockedBy: [1449], note: "Creating and editing projects; no child issue yet." },
  { path: "/admin/ledger", label: "Intent ledger", status: "pending", blockedBy: [1449], note: "Not covered by the spike; no child issue yet." },
  { path: "/boards", label: "Boards", status: "wall", wall: HUB_PATH + "#status=open&view=projects", note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/glossary", label: "Glossary", status: "wall", wall: HUB_PATH, note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/processes", label: "Processes", status: "wall", wall: HUB_PATH + "#status=open&view=jobs", note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/procedures", label: "Procedures", status: "wall", wall: HUB_PATH + "#page=agents", note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/places", label: "Places", status: "wall", wall: HUB_PATH, note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/setup", label: "First-run setup", status: "tool" },
  // Settings (#1428) sends a viewer who is not the owner here to sign in.
  { path: "/login", label: "Sign in (#1306)", status: "tool" },
  // Owner decision on #1449 (2026-10-29): the editor is a Wall page now (#1524).
  { path: "/workflows/editor", label: "Workflow editor", status: "wall", wall: HUB_PATH + "#page=editor", note: "The editor page (#1524): two columns, a side menu that folds away, auto-arrange." },
]

function pattern(path: string): RegExp {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<id>/g, "[^/?#]+")
  return new RegExp(`^${esc}/?$`)
}

const MATCHERS = CLASSIC_ROUTES.map((r) => ({ r, re: pattern(r.path) }))

/** The classic page an address opens, if any. Takes a path or a same-site href. */
export function classicRouteFor(href: string): ClassicRoute | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null
  const path = href.split(/[?#]/)[0]
  // The most specific pattern wins: /workflows/editor over nothing, /admin/agents/<id> over /admin.
  return MATCHERS.find((m) => m.re.test(path))?.r ?? null
}

/**
 * Where a classic page the Wall now covers redirects to, or null to serve it.
 * `daemonUrl` is the node a task runs on when the address names none, as the
 * classic Task page assumed.
 */
export function classicRedirect(path: string, params: URLSearchParams, daemonUrl: string): string | null {
  const task = path.match(/^\/tasks\/([^/]+)$/)
  if (task) {
    const agent = params.get("agent")
    if (!agent) return null
    // The Wall Task page's hash keys (wall-task.client.ts TASK_KEYS).
    const q = new URLSearchParams()
    q.set("page", "task")
    let id: string
    try { id = decodeURIComponent(task[1]) } catch { return null }
    q.set("task", id)
    q.set("agent", agent)
    q.set("node", params.get("node") || daemonUrl)
    const ch = params.get("channel")
    if (ch) q.set("ch", ch)
    const ask = params.get("ask")
    if (ask) q.set("ask", ask.slice(0, 400))
    const at = params.get("at")
    if (at) q.set("at", at)
    if (params.get("archived") === "1") q.set("done", "1")
    return "/#" + q.toString()
  }
  if (path === "/workflows/editor" || path === "/workflows/editor/") {
    // The editor's page keys (wall-editor.client.ts): e-wf names the
    // workflow, e-new starts one. With neither, the Workflows page.
    const q = new URLSearchParams()
    const id = params.get("id")
    if (params.get("new") === "1") { q.set("page", "editor"); q.set("e-new", "1") }
    else if (id) { q.set("page", "editor"); q.set("e-wf", id.slice(0, 200)) }
    else q.set("page", "workflows")
    return HUB_PATH + "#" + q.toString()
  }
  const hist = path.match(/^\/agents\/([^/]+)\/history$/)
  if (hist) {
    // The Activity filter keys (wall-activity.client.ts ACT_KEYS). The classic
    // page listed the agent's latest runs whatever their age: open the
    // longest period. The Wall reads every machine, so ?node= is not needed.
    let id: string
    try { id = decodeURIComponent(hist[1]) } catch { return null }
    const q = new URLSearchParams()
    q.set("page", "activity")
    q.set("a-agent", id)
    q.set("a-period", "30d")
    return HUB_PATH + "#" + q.toString()
  }
  return null
}
