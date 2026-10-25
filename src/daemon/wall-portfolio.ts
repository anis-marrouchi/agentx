import type { IncomingMessage, ServerResponse } from "http"
import { redactSecrets } from "@/agents/memory-trust"
import { OPEN_STATES } from "@/requests/store"
import { recordHasScope, TokenStore, TOKEN_PREFIX } from "./token-store"
import { WALL_DAYS_MAX, type WallPost } from "./wall-api"
import { renderPortfolioPage } from "./ui/pages/portfolio"

// --- The Wall's portfolio summary, for named people (#1194) ---
//
// One read-only page across every group and node: per project what is
// open, in progress, blocked and stalled; per owner what they carry and
// finished; and the blocked posts. Counts and titles only. A post's
// title is the headline an agent or the model set on it; a post without
// one is named by its home ("acme/web #42") or not at all. The text of a
// request, its thread, its chat and its group never leave here.
//
// Who may look: a key carrying `wall:portfolio`, one per person, which
// the owner mints himself (`agentx token create --name <person> --scope
// wall:portfolio`). The dashboard key opens it too. Nothing else does,
// and a portfolio key opens nothing else: it is not a dashboard key, so
// /api/admin/* (the Wall's posts and threads) still refuses it. Like the
// member page, there is no loopback exemption (`tailscale serve` proxies
// from 127.0.0.1).
//   GET /portfolio                the page (no data: asks for the key)
//   GET /api/portfolio?days=7     the summary

export const PORTFOLIO_SCOPE = "wall:portfolio"
export const PORTFOLIO_API = "/api/portfolio"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const TITLE_MAX = 120
const BLOCKS_MAX = 100
const OTHER = "Other"

/** The posts the summary is made from: the Wall's, maybe from other nodes
 *  (`titled` is missing on a node older than this). */
export type PortfolioPost = Pick<WallPost, "id" | "state" | "headline" | "owner" | "project" | "home" | "lastMoveAt" | "closedAt" | "blocked">
  & { titled?: boolean; node?: { name: string }; stalled?: boolean }

export interface PortfolioSummary {
  node: string
  syncedAt: number
  days: number
  /** The name on the key that asked; null for the dashboard key. */
  viewer: string | null
  nodes: Array<{ name: string; ok: boolean }>
  totals: { open: number; inProgress: number; blocked: number; stalled: number; done: number }
  /** Overview and throughput per project; "Other" is work with no project. */
  projects: Array<{ project: string; open: number; inProgress: number; blocked: number; stalled: number; done: number }>
  /** Capacity and throughput per owner. */
  owners: Array<{ owner: string; open: number; inProgress: number; blocked: number; done: number }>
  blocks: Array<{ title: string; project: string; owner: string; waitingOn: "owner" | "others"; since: number; node: string | null }>
}

/** What a post is called on the portfolio: its set headline, else its home. */
export function portfolioTitle(p: PortfolioPost): string {
  if (p.titled === true && p.headline) return redactSecrets(p.headline.length > TITLE_MAX ? `${p.headline.slice(0, TITLE_MAX - 1)}…` : p.headline)
  const m = p.home?.link.match(/\/(issues|merge_requests|pull|pulls)\/(\d+)/)
  if (m && p.project) return `${p.project} ${m[1] === "merge_requests" ? "!" : "#"}${m[2]}`
  return "Untitled request"
}

const isOpen = (state: string) => (OPEN_STATES as readonly string[]).includes(state)

/** Open, with no move for more than twice its project's rhythm: the mark
 *  the Wall set from the project mapping (#1190), else twice the
 *  requests' stale time (a node older than the mapping). */
export function isStalledPost(p: Pick<PortfolioPost, "state" | "lastMoveAt" | "stalled">, now: number, staleAfterHours: number): boolean {
  if (typeof p.stalled === "boolean") return p.stalled
  return isOpen(p.state) && now - p.lastMoveAt > 2 * staleAfterHours * HOUR
}

export function portfolioSummary(
  posts: PortfolioPost[],
  o: { node: string; now: number; days: number; staleAfterHours: number; viewer: string | null; nodes?: Array<{ name: string; ok: boolean }> },
): PortfolioSummary {
  const totals = { open: 0, inProgress: 0, blocked: 0, stalled: 0, done: 0 }
  const projects = new Map<string, PortfolioSummary["projects"][number]>()
  const owners = new Map<string, PortfolioSummary["owners"][number]>()
  const blocks: PortfolioSummary["blocks"] = []
  const since = o.now - o.days * DAY
  for (const p of posts) {
    const name = p.project ?? OTHER
    const proj = projects.get(name) ?? { project: name, open: 0, inProgress: 0, blocked: 0, stalled: 0, done: 0 }
    const own = owners.get(p.owner) ?? { owner: p.owner, open: 0, inProgress: 0, blocked: 0, done: 0 }
    if (isOpen(p.state)) {
      const inProgress = p.state === "in_progress" ? 1 : 0
      const blocked = p.blocked ? 1 : 0
      const stalled = isStalledPost(p, o.now, o.staleAfterHours) ? 1 : 0
      for (const x of [totals, proj]) { x.open++; x.inProgress += inProgress; x.blocked += blocked; x.stalled += stalled }
      own.open++; own.inProgress += inProgress; own.blocked += blocked
      if (p.blocked) {
        blocks.push({
          title: portfolioTitle(p), project: name, owner: p.owner,
          waitingOn: p.state === "waiting_owner" || p.state === "needs_attention" ? "owner" : "others",
          since: p.blocked.since, node: p.node?.name ?? null,
        })
      }
    } else if (p.state === "done" && p.closedAt !== null && p.closedAt >= since) {
      totals.done++; proj.done++; own.done++
    } else {
      continue
    }
    projects.set(name, proj)
    owners.set(p.owner, own)
  }
  const byLoad = <T extends { open: number; done: number }>(a: T, b: T) => b.open - a.open || b.done - a.done
  return {
    node: o.node,
    syncedAt: o.now,
    days: o.days,
    viewer: o.viewer,
    nodes: (o.nodes ?? [{ name: o.node, ok: true }]).map((n) => ({ name: n.name, ok: n.ok })),
    totals,
    projects: [...projects.values()].sort((a, b) => (a.project === OTHER ? 1 : 0) - (b.project === OTHER ? 1 : 0) || byLoad(a, b) || a.project.localeCompare(b.project)),
    owners: [...owners.values()].sort((a, b) => byLoad(a, b) || a.owner.localeCompare(b.owner)),
    blocks: blocks.sort((a, b) => a.since - b.since).slice(0, BLOCKS_MAX),
  }
}

/** Who is asking: the name on a `wall:portfolio` key, or the owner by the
 *  dashboard key (configured, or a stored dashboard:write key). Null: no one. */
export function portfolioViewer(sent: string | null, dashboardToken: string | undefined, tokens: Pick<TokenStore, "verify">): { name: string | null } | null {
  if (!sent) return null
  if (dashboardToken && sent === dashboardToken) return { name: null }
  const rec = sent.startsWith(TOKEN_PREFIX) ? tokens.verify(sent) : null
  if (!rec) return null
  if (recordHasScope(rec, PORTFOLIO_SCOPE)) return { name: rec.name }
  return recordHasScope(rec, "dashboard:write") ? { name: null } : null
}

export interface PortfolioRouteCtx {
  node: string
  dashboardToken?: string
  tokens?: Pick<TokenStore, "verify">
  /** The Wall's posts across the mesh for the last `days`. */
  posts: (days: number) => Promise<{ posts: PortfolioPost[]; nodes: Array<{ name: string; ok: boolean }>; staleAfterHours: number | null }>
  now?: () => number
}

/** Handles the request and returns true if `path` is the portfolio's. */
export async function handlePortfolioRequest(
  req: IncomingMessage, res: ServerResponse, path: string, method: string, ctx: PortfolioRouteCtx,
): Promise<boolean> {
  if (path !== "/portfolio" && path !== PORTFOLIO_API) return false
  if (method !== "GET") return json(res, 405, { error: "read-only" })
  if (path === "/portfolio") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
    res.end(renderPortfolioPage())
    return true
  }
  // The key comes in the Authorization header only: never in the address,
  // where it would land in proxy logs and browser history.
  // A dashboard with no token lets every request into the Wall itself, so a
  // portfolio key there would open far more than the portfolio. Refuse every
  // key until the owner sets dashboard.token.
  if (!ctx.dashboardToken) return json(res, 503, { error: "set dashboard.token first", hint: "the owner must set a dashboard token before any key opens the portfolio" })
  const auth = String(req.headers.authorization || "")
  const sent = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
  const viewer = portfolioViewer(sent, ctx.dashboardToken, ctx.tokens ?? new TokenStore())
  if (!viewer) return json(res, 401, { error: "a portfolio key is needed", hint: "ask the owner for one" })
  const q = new URL(req.url || "/", "http://_").searchParams
  const days = Math.max(1, Math.min(WALL_DAYS_MAX, Number(q.get("days") ?? 7) || 7))
  const read = await ctx.posts(days)
  return json(res, 200, portfolioSummary(read.posts, {
    node: ctx.node, now: (ctx.now ?? Date.now)(), days, staleAfterHours: read.staleAfterHours ?? 24, viewer: viewer.name, nodes: read.nodes,
  }))
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
