// GET /lookup?agent=<id>  |  GET /lookup?work=<issue or MR link/ref, or req-id>
// Read-only answers for agentx_lookup (src/a2a/lookup.ts). Nothing here
// starts a run or calls a model. An agent on a mesh peer is looked up on
// that peer (forward); work is looked up on this computer only.
//
// A work lookup cannot use an index (it matches words in the message), and
// better-sqlite3 blocks the event loop while a query runs: on a 1.7 GB
// database one full scan took 11 s. So it walks task_traces newest first
// in rowid slices (rowid follows start order), gives the loop back between
// slices, stops once it has enough runs or passes the window, and gives up
// after WORK_SCAN_BUDGET_MS with what it found.

import type Database from "better-sqlite3"
import {
  formatAgentLookup, formatWorkLookup, likeNeedles, MAX_LOOKUP_RUNS, RECENT_HOURS, requestConcerns,
  requestView, runConcerns, runView, WORK_DAYS, workKey,
  type AgentLookup, type LookupHandOff, type RequestRow, type TraceRow, type WorkLookup,
} from "@/a2a/lookup"

export interface LookupDeps {
  db: Database.Database | null
  hasAgent: (id: string) => boolean
  running: (agentId: string) => Array<{ channel: string; chatId?: string; sender?: string; startedAt: Date | string; message?: string; messagePreview?: string }>
  openRequests: () => RequestRow[]
  /** Requests closed since a time, for a work lookup. */
  closedRequests?: (since: number) => RequestRow[]
  handOffs: () => LookupHandOff[]
  /** An agent on a peer: that peer's answer, or null when no peer has it. */
  forward?: (agentId: string) => Promise<{ status: number; body: Record<string, unknown> } | null>
  nodeName?: string
  now?: number
  /** Rows per slice of a work scan, and the time it may take (tests). */
  scanSlice?: number
  scanBudgetMs?: number
}

export const WORK_SCAN_SLICE = 2000
export const WORK_SCAN_BUDGET_MS = 5000
const TRACE_COLUMNS = "agent_id, channel, chat_id, status, started_at, original_message, final_response, error, sender"

type Answer = { status: number; body: Record<string, unknown> }

export async function handleLookup(query: URLSearchParams, deps: LookupDeps): Promise<Answer> {
  const agent = (query.get("agent") ?? "").trim()
  const work = (query.get("work") ?? "").trim()
  if (!agent === !work) return { status: 400, body: { error: "give one of: agent=<agent id>, or work=<issue or merge request link or group/project#12 ref, or a req- id>" } }
  const now = deps.now ?? Date.now()

  if (agent) {
    if (!deps.hasAgent(agent)) {
      const remote = deps.forward ? await deps.forward(agent).catch(() => null) : null
      if (remote) return remote
      return { status: 404, body: { error: `no agent "${agent}" on this computer or a reachable peer` } }
    }
    const l = agentLookup(agent, deps, now)
    return { status: 200, body: { ...l, text: formatAgentLookup(l) } }
  }

  const key = workKey(work)
  if (!key) return { status: 400, body: { error: `"${work}" is not a work reference: use an issue or merge request link, a group/project#12 or group/project!12 ref, or a req- id` } }
  const l = await workLookup(key, deps, now)
  return { status: 200, body: { ...l, text: formatWorkLookup(l) } }
}

export function agentLookup(agent: string, deps: LookupDeps, now: number): AgentLookup {
  const running = deps.running(agent).map((t) => runView({
    agent_id: agent, channel: t.channel, chat_id: t.chatId ?? null, sender: t.sender ?? "", status: "in-flight",
    started_at: typeof t.startedAt === "string" ? Date.parse(t.startedAt) : t.startedAt.getTime(),
    original_message: t.message ?? t.messagePreview ?? null, final_response: null, error: null,
  }))
  const recent = deps.db ? (deps.db.prepare(
    `SELECT ${TRACE_COLUMNS} FROM task_traces
     WHERE agent_id = ? AND started_at >= ? AND status != 'in-flight' ORDER BY started_at DESC LIMIT ?`,
  ).all(agent, now - RECENT_HOURS * 3_600_000, MAX_LOOKUP_RUNS) as TraceRow[]).map(runView) : []
  return {
    agent,
    ...(deps.nodeName ? { node: deps.nodeName } : {}),
    running,
    requests: deps.openRequests().filter((r) => r.agentId === agent).map(requestView),
    recent,
    handOffs: deps.handOffs().filter((h) => h.status === "running" && (h.caller === agent || h.callee === agent)),
  }
}

export async function workLookup(key: NonNullable<ReturnType<typeof workKey>>, deps: LookupDeps, now: number): Promise<WorkLookup> {
  const since = now - WORK_DAYS * 86_400_000
  const scan = deps.db ? await scanWorkRuns(deps.db, key, since, deps.scanSlice ?? WORK_SCAN_SLICE, deps.scanBudgetMs ?? WORK_SCAN_BUDGET_MS) : { runs: [], partial: false }
  return {
    work: key.key,
    requests: [...deps.openRequests(), ...(deps.closedRequests?.(since) ?? [])]
      .filter((r) => requestConcerns(r, key)).map(requestView),
    runs: scan.runs.map(runView),
    ...(scan.partial ? { partial: true } : {}),
  }
}

/** Runs about the work since `since`, newest first, confirmed by
 *  runConcerns before they count toward the limit. */
export async function scanWorkRuns(
  db: Database.Database, key: NonNullable<ReturnType<typeof workKey>>, since: number, slice: number, budgetMs: number,
): Promise<{ runs: TraceRow[]; partial: boolean }> {
  const needles = likeNeedles(key)
  const where = needles.map(() => "(original_message LIKE ? OR chat_id LIKE ?)").join(" OR ")
  const params = needles.flatMap((n) => [`%${n}%`, `%${n}%`])
  const top = (db.prepare("SELECT max(rowid) AS m FROM task_traces").get() as { m: number | null }).m
  const inSlice = db.prepare(
    `SELECT ${TRACE_COLUMNS} FROM task_traces WHERE rowid BETWEEN ? AND ? AND started_at >= ? AND (${where}) ORDER BY rowid DESC`,
  )
  const oldestIn = db.prepare("SELECT started_at FROM task_traces WHERE rowid >= ? ORDER BY rowid LIMIT 1")
  const runs: TraceRow[] = []
  const t0 = Date.now()
  for (let hi = top ?? 0; hi > 0; hi -= slice) {
    const lo = Math.max(1, hi - slice + 1)
    for (const r of inSlice.all(lo, hi, since, ...params) as TraceRow[]) {
      if (runConcerns(r, key)) runs.push(r)
      if (runs.length >= MAX_LOOKUP_RUNS) return { runs, partial: false }
    }
    const oldest = (oldestIn.get(lo) as { started_at: number } | undefined)?.started_at
    if (oldest === undefined || oldest < since) break
    if (Date.now() - t0 > budgetMs) return { runs, partial: true }
    await new Promise((r) => setImmediate(r))
  }
  return { runs, partial: false }
}
