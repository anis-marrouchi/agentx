import type Database from "better-sqlite3"
import { clusterKey } from "@/procedures/mine/cluster"
import { parseInjectedContext, type InjectedContext } from "./traces"

// --- Lesson impact (#98) ---
//
// Does a lesson make a repeated task better? Tasks are grouped per agent with
// the procedure miner's clusterKey (the same key that decides what counts as
// a recurring task). For every memory fact, procedure or the wiki catalog
// injected into a group's tasks, the report compares:
//   before — the group's tasks that started before the lesson was first
//            injected for that agent, and whose injected context was recorded
//   after  — the group's tasks the lesson was injected into
// "Recorded" matters: rows written before this capture existed carry no
// injected ids, so they can't prove a lesson was absent and never count as
// before. Tasks after the lesson appeared that did not get it (a resumed
// session, or a message it didn't match) are in neither group.

export interface TaskSample {
  taskId: string
  agentId: string
  cluster: string
  startedAt: number
  ok: boolean
  tokens: number | null
  turns: number | null
  durationMs: number | null
  injected: InjectedContext | null
}

export interface GroupStats {
  n: number
  successRate: number
  medianTokens: number | null
  medianTurns: number | null
  medianDurationMs: number | null
}

export interface LessonImpact {
  agentId: string
  cluster: string
  /** "memory:<id>", "procedure:<id>" or "wiki". */
  lesson: string
  /** ms epoch: the first task of this agent the lesson was injected into. */
  addedAt: number
  before: GroupStats
  after: GroupStats
}

const TOKEN_COLUMNS = [
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_create_tokens",
  "tier2_input_tokens", "tier2_output_tokens", "tier2_cache_read_tokens", "tier2_cache_create_tokens",
]

const BASE_COLUMNS = [
  "task_id", "agent_id", "channel", "chat_id", "started_at", "status", "duration_ms",
  "original_message", "message_preview",
]

/** Finished tasks, oldest first. Works read-only on a database that predates
 *  the lesson-impact columns: those rows just carry no injected context. */
export function loadTaskSamples(
  db: Database.Database,
  opts: { since?: number; agentId?: string } = {},
): TaskSample[] {
  const have = new Set((db.prepare("PRAGMA table_info(task_traces)").all() as Array<{ name: string }>).map((c) => c.name))
  const wanted = [...BASE_COLUMNS, ...TOKEN_COLUMNS, "num_turns", "injected_context"]
  const select = wanted.map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(", ")

  const where = ["status IN ('ok', 'error', 'timeout')"]
  const params: unknown[] = []
  if (opts.since !== undefined) { where.push("started_at >= ?"); params.push(opts.since) }
  if (opts.agentId) { where.push("agent_id = ?"); params.push(opts.agentId) }
  const filter = where.join(" AND ")

  const rows = db.prepare(`
    SELECT ${select} FROM task_traces WHERE ${filter} ORDER BY started_at
  `).all(...params) as Record<string, unknown>[]

  const actions = new Map<string, string[]>()
  const steps = db.prepare(`
    SELECT task_id, action FROM task_trace_steps
    WHERE name = 'tool_use' AND action IS NOT NULL
      AND task_id IN (SELECT task_id FROM task_traces WHERE ${filter})
    ORDER BY task_id, seq
  `).all(...params) as Array<{ task_id: string; action: string }>
  for (const s of steps) {
    const list = actions.get(s.task_id) ?? []
    list.push(s.action)
    actions.set(s.task_id, list)
  }

  return rows.map((row) => {
    const taskId = row.task_id as string
    const agentId = row.agent_id as string
    const cluster = clusterKey({
      taskId,
      agentId,
      channel: (row.channel as string) ?? "unknown",
      chatId: (row.chat_id as string) ?? "",
      startedAt: row.started_at as number,
      userMessage: ((row.original_message ?? row.message_preview ?? "") as string).trim(),
      userTurns: [],
      actions: actions.get(taskId) ?? [],
      actionSummaries: [],
    })
    const counts = TOKEN_COLUMNS.map((c) => row[c]).filter((v): v is number => typeof v === "number")
    return {
      taskId,
      agentId,
      cluster,
      startedAt: row.started_at as number,
      ok: row.status === "ok",
      tokens: counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null,
      turns: (row.num_turns as number) ?? null,
      durationMs: (row.duration_ms as number) ?? null,
      injected: parseInjectedContext(row.injected_context),
    }
  })
}

export function lessonsOf(sample: TaskSample): string[] {
  if (!sample.injected) return []
  return [
    ...sample.injected.memory.map((id) => `memory:${id}`),
    ...sample.injected.procedures.map((id) => `procedure:${id}`),
    ...(sample.injected.wiki ? ["wiki"] : []),
  ]
}

function median(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export function groupStats(samples: TaskSample[]): GroupStats {
  return {
    n: samples.length,
    successRate: samples.length ? samples.filter((s) => s.ok).length / samples.length : 0,
    medianTokens: median(samples.map((s) => s.tokens)),
    medianTurns: median(samples.map((s) => s.turns)),
    medianDurationMs: median(samples.map((s) => s.durationMs)),
  }
}

/** Before/after stats per (agent, repeated task, lesson). Pairs with fewer
 *  than `minSamples` tasks on either side are left out. */
export function lessonImpact(samples: TaskSample[], opts: { minSamples?: number } = {}): LessonImpact[] {
  const min = Math.max(1, opts.minSamples ?? 2)

  // First injection per agent: memory and wiki are per agent, and a
  // procedure one agent learned says nothing about another's tasks.
  const addedAt = new Map<string, number>()
  const groups = new Map<string, TaskSample[]>()
  for (const s of samples) {
    for (const lesson of lessonsOf(s)) {
      const key = `${s.agentId}\u0000${lesson}`
      addedAt.set(key, Math.min(addedAt.get(key) ?? Infinity, s.startedAt))
    }
    const g = `${s.agentId}\u0000${s.cluster}`
    const list = groups.get(g) ?? []
    list.push(s)
    groups.set(g, list)
  }

  const results: LessonImpact[] = []
  for (const tasks of groups.values()) {
    const { agentId, cluster } = tasks[0]
    const lessons = new Set(tasks.flatMap(lessonsOf))
    for (const lesson of lessons) {
      const added = addedAt.get(`${agentId}\u0000${lesson}`)!
      const before = tasks.filter((t) => t.injected !== null && t.startedAt < added)
      const after = tasks.filter((t) => lessonsOf(t).includes(lesson))
      if (before.length < min || after.length < min) continue
      results.push({ agentId, cluster, lesson, addedAt: added, before: groupStats(before), after: groupStats(after) })
    }
  }
  return results.sort((a, b) =>
    a.agentId.localeCompare(b.agentId) || a.cluster.localeCompare(b.cluster) || a.addedAt - b.addedAt,
  )
}
