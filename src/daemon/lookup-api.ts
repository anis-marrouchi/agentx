// GET /lookup?agent=<id>  |  GET /lookup?work=<issue or MR link/ref, or req-id>
// Read-only answers for agentx_lookup (src/a2a/lookup.ts). Nothing here
// starts a run or calls a model. An agent on a mesh peer is looked up on
// that peer (forward); work is looked up on this computer only.

import type Database from "better-sqlite3"
import {
  formatAgentLookup, formatWorkLookup, isPersonChannel, likeNeedles, MAX_LOOKUP_RUNS, RECENT_HOURS, requestConcerns,
  requestView, runConcerns, runView, WORK_DAYS, workKey,
  type AgentLookup, type LookupHandOff, type RequestRow, type TraceRow, type WorkLookup,
} from "@/a2a/lookup"

export interface LookupDeps {
  db: Database.Database | null
  hasAgent: (id: string) => boolean
  running: (agentId: string) => Array<{ channel: string; chatId?: string; startedAt: Date | string; message?: string; messagePreview?: string }>
  openRequests: () => RequestRow[]
  /** Requests closed since a time, for a work lookup. */
  closedRequests?: (since: number) => RequestRow[]
  handOffs: () => LookupHandOff[]
  /** An agent on a peer: that peer's answer, or null when no peer has it. */
  forward?: (agentId: string) => Promise<{ status: number; body: Record<string, unknown> } | null>
  nodeName?: string
  now?: number
}

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
  const l = workLookup(key, deps, now)
  return { status: 200, body: { ...l, text: formatWorkLookup(l) } }
}

export function agentLookup(agent: string, deps: LookupDeps, now: number): AgentLookup {
  const running = deps.running(agent).map((t) => runView({
    agent_id: agent, channel: t.channel, chat_id: t.chatId ?? null, status: "in-flight",
    started_at: typeof t.startedAt === "string" ? Date.parse(t.startedAt) : t.startedAt.getTime(),
    original_message: t.message ?? t.messagePreview ?? null, final_response: null, error: null,
  }))
  const recent = deps.db ? (deps.db.prepare(
    `SELECT agent_id, channel, chat_id, status, started_at, original_message, final_response, error FROM task_traces
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

export function workLookup(key: NonNullable<ReturnType<typeof workKey>>, deps: LookupDeps, now: number): WorkLookup {
  let runs: TraceRow[] = []
  if (deps.db) {
    const needles = likeNeedles(key)
    const where = needles.map(() => "(original_message LIKE ? OR chat_id LIKE ?)").join(" OR ")
    const params = needles.flatMap((n) => [`%${n}%`, `%${n}%`])
    runs = (deps.db.prepare(
      `SELECT agent_id, channel, chat_id, status, started_at, original_message, final_response, error FROM task_traces
       WHERE started_at >= ? AND (${where}) ORDER BY started_at DESC LIMIT 200`,
    ).all(now - WORK_DAYS * 86_400_000, ...params) as TraceRow[]).filter((r) => runConcerns(r, key)).slice(0, MAX_LOOKUP_RUNS)
  }
  return {
    work: key.key,
    requests: [...deps.openRequests(), ...(deps.closedRequests?.(now - WORK_DAYS * 86_400_000) ?? [])]
      .filter((r) => requestConcerns(r, key)).map(requestView),
    // A person's run about the work shows that it happened, not their words.
    runs: runs.map((r) => (isPersonChannel(r.channel) ? { ...runView(r), answer: undefined } : runView(r))),
  }
}
