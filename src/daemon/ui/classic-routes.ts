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
  { path: "/tasks/<id>", label: "One task's run", status: "wall", wall: "/#page=task", note: "Wall Task page (#1381): stream, steer, Stop." },
  { path: "/live", label: "Live", status: "wall", wall: "/wall#page=live", note: "Redirected in board-dashboard.ts (#1439)." },
  { path: "/monitor", label: "Monitor", status: "pending", blockedBy: [1439, 1440], note: "Connect a CLI session; open actions of CLI sessions." },
  { path: "/mesh", label: "Operations", status: "pending", blockedBy: [1429, 1439, 1446] },
  { path: "/activity", label: "Activity", status: "pending", blockedBy: [1429], note: "Timeline and map." },
  { path: "/agents/<id>/history", label: "Agent history", status: "pending", blockedBy: [1429] },
  { path: "/approvals", label: "Approvals", status: "pending", blockedBy: [1440], note: "Deciding cards and inbox items." },
  { path: "/admin", label: "Settings", status: "pending", blockedBy: [1428] },
  { path: "/admin/agents/<id>", label: "Agent settings", status: "pending", blockedBy: [1428] },
  { path: "/admin/health", label: "Observability", status: "pending", blockedBy: [1428], note: "Also /admin/observability." },
  { path: "/guests", label: "Guests", status: "pending", blockedBy: [1428] },
  { path: "/admin/cost", label: "Cost", status: "wall", wall: "/wall#status=open&view=cost", note: "Redirected in board-dashboard.ts (#1423, #1466)." },
  { path: "/org", label: "Org", status: "pending", blockedBy: [1419, 1420, 1421] },
  { path: "/people", label: "People", status: "wall", wall: "/wall#page=people", note: "Redirected in people-panel.ts (#1441)." },
  { path: "/workflows", label: "Workflows", status: "pending", blockedBy: [1445] },
  { path: "/admin/graph", label: "Reviews", status: "pending", blockedBy: [1440], note: "Approve or reject a classification. Also /graph." },
  { path: "/admin/projects", label: "Projects", status: "pending", blockedBy: [1449], note: "Creating and editing projects; no child issue yet." },
  { path: "/admin/ledger", label: "Intent ledger", status: "pending", blockedBy: [1449], note: "Not covered by the spike; no child issue yet." },
  { path: "/boards", label: "Boards", status: "wall", wall: "/wall#status=open&view=projects", note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/glossary", label: "Glossary", status: "wall", wall: "/wall", note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/processes", label: "Processes", status: "wall", wall: "/wall#status=open&view=jobs", note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/procedures", label: "Procedures", status: "wall", wall: "/wall#page=agents", note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/places", label: "Places", status: "wall", wall: "/wall", note: "Retired, redirected in board-dashboard.ts RETIRED_PAGES (#1446)." },
  { path: "/setup", label: "First-run setup", status: "tool" },
  { path: "/workflows/editor", label: "Workflow editor", status: "tool" },
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
  return null
}
