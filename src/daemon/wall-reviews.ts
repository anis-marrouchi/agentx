import { existsSync, readFileSync, statSync } from "fs"
import { resolve } from "path"
import { redactSecrets } from "@/agents/memory-trust"
import { classificationSchema, type Classification, type GraphNode } from "@/graph/types"
import { summarize } from "@/requests/card-view"
import { WALL_PREFIX } from "./wall-api"

// --- The Wall's review queue (#1182) ---
//
// The intent-graph classifications that went to review (`agentx graph
// review`, the agentx_graph_review tool, or the classic /admin/graph page),
// what the reviewer decided and why, and for an approval the nodes it
// added to the taxonomy. Read straight from the graph's files: no
// GraphStore, whose constructor and loadSchema() may create or migrate
// files. Nothing is written, nobody is notified.
//
// A classification's id is its msgHash. Its log rows, oldest first, are
// its thread, so the thread never depends on the chat it came from.
//
// What the records do not hold is left out rather than guessed: a "skip"
// writes nothing (the row stays pending), and the wiki queries a reviewer
// ran are not stored with its decision. Each review instead carries the
// wiki search for its path (the node names), so the page links to the
// wiki results a reviewer would have seen for that path.
//   GET /api/admin/wall/reviews?status=pending|decided|all   the queue
//   GET /api/admin/wall/reviews?id=<msgHash>                  one review and its thread

export const WALL_REVIEWS_PATH = `${WALL_PREFIX}/reviews`
const LIMIT = 100
const LIMIT_MAX = 500
const TEXT_MAX = 300

export interface WallReviewDeps {
  /** The graph's folder (graph.baseDir). Null: no graph on this node. */
  baseDir: string | null
  enabled: boolean
}

export interface WallReviewDecision {
  verdict: "approved" | "rejected"
  /** The review agent, as recorded. Null: decided on the classic graph page,
   *  which records no reviewer. */
  by: string | null
  reason: string | null
  at: number
}

/** One node along an approved path, against nodes.json now. */
export interface WallTaxonomyLine {
  /** add: created for this classification; keep: already there; missing:
   *  not in nodes.json now (removed later, or its commit failed). */
  op: "add" | "keep" | "missing"
  id: string
  level: string | null
  parentId: string | null
  axes: Record<string, string>
}

export interface WallReviewEvent {
  at: number
  status: Classification["status"]
  who: string | null
  text: string
}

export interface WallReview {
  /** The classification id (its msgHash). */
  id: string
  status: Classification["status"]
  path: string[]
  proposedAxes: Record<string, Record<string, string>>
  confidence: number | null
  source: Classification["source"]
  agentId: string | null
  channel: string | null
  /** The message it classified, redacted. */
  message: string
  proposedAt: number
  decision: WallReviewDecision | null
  /** Approved only: the nodes the path touches. Empty otherwise. */
  taxonomy: WallTaxonomyLine[]
  /** The wiki search for this path: its node names, root first. Empty when
   *  the path is empty. The page links it to /admin/wiki/search. */
  wikiQuery: string
}

let cache: { key: string; rows: Classification[] } | null = null

const clean = (s: string | null | undefined, max = TEXT_MAX): string => (s ? redactSecrets(summarize(s, max)) : "")
const ms = (iso: string): number => Date.parse(iso) || 0

/** Every classification row in log order, each with the preview it was
 *  written with. The page refreshes every minute and the log grows without
 *  bound, so the parse is kept until the file's size or time changes. */
function readLog(file: string): Classification[] {
  if (!existsSync(file)) return []
  let key: string
  try { const s = statSync(file); key = `${file}:${s.size}:${s.mtimeMs}` } catch { return [] }
  if (cache?.key === key) return cache.rows
  const rows: Classification[] = []
  let text = ""
  try { text = readFileSync(file, "utf-8") } catch { return [] }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const p = classificationSchema.safeParse(JSON.parse(line))
      if (p.success) rows.push(p.data)
    } catch { /* skip a corrupt line, as GraphStore does */ }
  }
  cache = { key, rows }
  return rows
}

function readNodes(file: string): GraphNode[] {
  if (!existsSync(file)) return []
  try {
    const j = JSON.parse(readFileSync(file, "utf-8"))
    return Array.isArray(j?.nodes) ? j.nodes : []
  } catch { return [] }
}

/** updateClassificationStatus() keeps the reviewer and reason on the row's
 *  preview: "<previous preview> · reviewer=<id> · <reason>". */
export function decisionOf(row: Classification, prev: Classification | null): WallReviewDecision | null {
  if (row.status === "pending") return null
  const before = prev?.preview ?? ""
  const now = row.preview ?? ""
  let suffix = before && now.startsWith(before) ? now.slice(before.length) : ""
  if (!suffix) {
    const at = now.lastIndexOf(" · reviewer=")
    suffix = at >= 0 ? now.slice(at) : ""
  }
  const m = suffix.match(/^ · (?:reviewer=(\S+))?(?: · ([\s\S]*))?$/)
  return {
    verdict: row.status,
    by: m?.[1] ?? null,
    reason: m?.[2] ? clean(m[2], 200) : null,
    at: ms(row.ts),
  }
}

export function taxonomyOf(c: Classification, proposedAt: number, nodes: GraphNode[]): WallTaxonomyLine[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  return c.path.map((id) => {
    const n = byId.get(id)
    if (!n) return { op: "missing", id, level: null, parentId: null, axes: c.proposedAxes[id] ?? {} }
    const added = id in c.proposedAxes && ms(n.createdAt) >= proposedAt
    return { op: added ? "add" : "keep", id, level: n.level, parentId: n.parentId, axes: n.axes ?? {} }
  })
}

/** Rows grouped by classification id, oldest first, only for the ones that
 *  were ever pending: rows the classifier approved itself never went to
 *  review and stay out. */
function reviewed(rows: Classification[]): { groups: Map<string, Classification[]>; autoApproved: number } {
  const all = new Map<string, Classification[]>()
  for (const r of rows) {
    const list = all.get(r.msgHash) ?? []
    list.push(r)
    all.set(r.msgHash, list)
  }
  const groups = new Map<string, Classification[]>()
  let autoApproved = 0
  for (const [id, list] of all) {
    if (list.some((r) => r.status === "pending")) groups.set(id, list)
    else autoApproved++
  }
  return { groups, autoApproved }
}

/** The path's node names (axes.name, else the proposed name, else the id),
 *  joined as one wiki search. */
export function wikiQueryOf(c: Classification, nodes: GraphNode[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  return c.path
    .map((id) => byId.get(id)?.axes?.name || c.proposedAxes[id]?.name || id)
    .join(" ")
    .slice(0, 200)
}

export function wallReview(list: Classification[], nodes: GraphNode[]): WallReview {
  const first = list.find((r) => r.status === "pending") ?? list[0]
  const last = list[list.length - 1]
  const proposedAt = ms(first.ts)
  const decision = decisionOf(last, list.length > 1 ? list[list.length - 2] : null)
  return {
    id: last.msgHash,
    status: last.status,
    path: last.path,
    proposedAxes: last.proposedAxes,
    confidence: typeof first.confidence === "number" ? first.confidence : null,
    source: first.source,
    agentId: first.agentId ?? null,
    channel: first.channel ?? null,
    message: clean(first.preview),
    proposedAt,
    decision,
    taxonomy: last.status === "approved" ? taxonomyOf(last, proposedAt, nodes) : [],
    wikiQuery: wikiQueryOf(last, nodes),
  }
}

/** A classification's log rows as its thread, oldest first. */
export function reviewThread(list: Classification[]): WallReviewEvent[] {
  return list.map((r, i) => {
    if (r.status === "pending") {
      const conf = typeof r.confidence === "number" ? `, confidence ${r.confidence.toFixed(2)}` : ""
      return { at: ms(r.ts), status: r.status, who: r.agentId ?? null, text: `Proposed ${r.path.join(" › ")} (${r.source}${conf})` }
    }
    const d = decisionOf(r, i > 0 ? list[i - 1] : null)!
    return { at: d.at, status: r.status, who: d.by, text: `${r.status === "approved" ? "Approved" : "Rejected"}${d.reason ? `: ${d.reason}` : ""}` }
  })
}

export function handleWallReviews(q: URLSearchParams, deps: WallReviewDeps, node: string, now: number): { status: number; body: unknown } {
  const base = { node, syncedAt: now, enabled: deps.enabled }
  const rows = deps.baseDir ? readLog(resolve(deps.baseDir, "classifications.jsonl")) : []
  const { groups, autoApproved } = reviewed(rows)
  const nodes = deps.baseDir && groups.size ? readNodes(resolve(deps.baseDir, "nodes.json")) : []
  const id = q.get("id")
  if (id) {
    const list = groups.get(id)
    if (!list) return { status: 404, body: { error: "no review for that classification id" } }
    return { status: 200, body: { ...base, review: wallReview(list, nodes), events: reviewThread(list) } }
  }
  const status = q.get("status") ?? "all"
  const limit = Math.max(1, Math.min(LIMIT_MAX, Number(q.get("limit") ?? LIMIT) || LIMIT))
  const all = [...groups.values()].map((list) => wallReview(list, nodes))
  const counts = {
    pending: all.filter((r) => r.status === "pending").length,
    approved: all.filter((r) => r.status === "approved").length,
    rejected: all.filter((r) => r.status === "rejected").length,
    autoApproved,
  }
  const keep = all
    .filter((r) => status === "all" || (status === "decided" ? r.status !== "pending" : r.status === status))
    .sort((a, b) => (b.decision?.at ?? b.proposedAt) - (a.decision?.at ?? a.proposedAt))
    .slice(0, limit)
  return { status: 200, body: { ...base, counts, reviews: keep } }
}
