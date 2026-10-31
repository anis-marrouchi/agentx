import { redactSecrets } from "@/agents/memory-trust"
import { groupEventsFeed, type GroupedFeed, type NodeEventsShare } from "@/events/hub-feed"
import { WALL_PREFIX } from "./wall-api"

// --- The Hub's Events view (#1648) ---
//
// Broadcasts (named events, announcements), the wakes each one caused on
// every machine, and the events sent in reply, grouped under the event
// that caused them. Read-only: nothing is sent, nobody is notified.
//
// Each machine's daemon serves its own share at GET /events/hub (its ring
// and its wake journal, both in memory). This dashboard reads its own
// daemon's share and asks every other machine's dashboard for its share
// with ?scope=node, then merges them: a peer's event the mesh feed already
// brought here is kept once, and its wakes from every machine land on it.
// A machine that does not answer is listed with the reason; the rest
// still shows.
//   GET /api/admin/wall/events?limit=50     the merged feed
//   GET /api/admin/wall/events?scope=node   this machine's share only

export const WALL_EVENTS_PATH = `${WALL_PREFIX}/events`

export interface WallEventsNode {
  name: string
  ok: boolean
  error?: string
}

export interface WallEventsDeps {
  /** This machine's share, from its daemon. */
  local: () => Promise<NodeEventsShare>
  /** The other machines, each read through its dashboard. */
  peers: Array<{ name: string; read: () => Promise<NodeEventsShare> }>
  now?: number
}

export type WallEventsReply = GroupedFeed & { node: string; syncedAt: number; nodes: WallEventsNode[] }

const fail = (e: any): string => (e?.name === "TimeoutError" ? "timed out" : String(e?.message || e).slice(0, 120))

/** Strip what a share must not carry on: summaries and errors are already
 *  bounded, and are passed through redactSecrets once more here. */
function clean(share: NodeEventsShare): NodeEventsShare {
  return {
    node: String(share.node || ""),
    events: (Array.isArray(share.events) ? share.events : []).map((e) => ({ ...e, summary: redactSecrets(String(e.summary ?? "")) })),
    wakes: (Array.isArray(share.wakes) ? share.wakes : []).map((w) => (w.error ? { ...w, error: redactSecrets(w.error) } : w)),
  }
}

export async function buildWallEvents(q: URLSearchParams, deps: WallEventsDeps): Promise<WallEventsReply> {
  const now = deps.now ?? Date.now()
  const shares: NodeEventsShare[] = []
  const nodes: WallEventsNode[] = []
  let node = "local"
  try {
    const own = clean(await deps.local())
    node = own.node || node
    shares.push(own)
    nodes.push({ name: node, ok: true })
  } catch (e) {
    nodes.push({ name: "this machine", ok: false, error: fail(e) })
  }
  await Promise.all(deps.peers.map(async (p) => {
    try {
      const s = clean(await p.read())
      shares.push(s)
      nodes.push({ name: s.node || p.name, ok: true })
    } catch (e) {
      nodes.push({ name: p.name, ok: false, error: fail(e) })
    }
  }))
  const limit = Number(q.get("limit")) || undefined
  return { node, syncedAt: now, nodes, ...groupEventsFeed(shares, { limit, now }) }
}

/** Read one share over HTTP; a non-200 answer is an error with its reason. */
export async function readShare(url: string, token: string | undefined, extra: Record<string, string> = {}): Promise<NodeEventsShare> {
  const r = await fetch(url, {
    headers: { Accept: "application/json", ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(6000),
  })
  if (!r.ok) {
    throw new Error(r.status === 401 || r.status === 403 ? `key refused (answered ${r.status})`
      : r.status === 404 ? "no events feed (older AgentX)" : `answered ${r.status}`)
  }
  const body = await r.json() as NodeEventsShare
  if (!body || !Array.isArray(body.events)) throw new Error("no events feed (older AgentX)")
  return body
}
