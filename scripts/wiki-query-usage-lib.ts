// --- How agents use the wiki, from the trace ledger (#1820) ---
//
// `_query-runs.jsonl` counts queries but holds no question, no answer and
// no link to the turn that asked. The trace ledger (task_traces +
// task_trace_steps) has all three: every tool call of every turn, its
// input and the start of its result. This module reads rows from it and
// answers the spike's questions: how many turns use the wiki, which
// agents, which days, how the calls end, and what the agent did next.
//
// Pure functions over rows; wiki-query-report.ts beside it does the SQL.

export interface TaskRow {
  task_id: string
  agent_id: string
  /** Epoch ms. */
  started_at: number
  /** Claude Code session the turn ended in, when known. */
  session: string | null
}

export interface StepRow {
  task_id: string
  seq: number
  /** "tool_use" or "tool_result". */
  name: string
  /** Tool name on a tool_use; null on a result. */
  action: string | null
  /** "ok" or "error" on a result. */
  status: string | null
  input_summary: string | null
  output_summary: string | null
}

/** A wiki-related call: the MCP query tool, the `wiki query` command run
 *  through Bash, the colleague lookup, or a wiki edit. */
export type WikiCallKind = "tool" | "cli" | "lookup" | "patch"

const tail = (action: string | null) => (action ?? "").replace(/^mcp__.+?__/, "")

export function classifyCall(action: string | null, input: string | null): WikiCallKind | null {
  const name = tail(action)
  if (name === "agentx_wiki_query") return "tool"
  if (name === "agentx_lookup") return "lookup"
  if (name === "agentx_wiki_patch") return "patch"
  if (action === "Bash" && /\bwiki\s+query\s/.test(input ?? "")) return "cli"
  return null
}

/** How a query ended, from the start of its result text. Text matching,
 *  so a cause is a best guess; `other-error` is what nothing matched. */
export type QueryOutcome =
  | "answer"
  | "no-answer"
  | "empty"
  | "no-catalog"
  | "timeout"
  | "crash"
  | "model-error"
  | "denied"
  | "other-error"

export function classifyResult(text: string | null, status: string | null): QueryOutcome {
  const t = (text ?? "").trim()
  if (!t) return status === "error" ? "other-error" : "empty"
  if (/permission|denied|not allowed|blocked by/i.test(t) && (status === "error" || t.length < 400)) return "denied"
  if (/no agent has a (wiki )?catalog/i.test(t)) return "no-catalog"
  if (/timed? ?out|SIGTERM|exited 143/i.test(t)) return "timeout"
  if (/\n\s+at .+\(|ENOTDIR|EACCES|EROFS|ENOENT|Cannot find module|Node\.js v\d/.test(t)) return "crash"
  if (/Selector:|Synthesis:|claude exited|status "error"|status: error/.test(t)) return "model-error"
  if (/no-candidates|\(no answer\)|No wiki page (was used|holds)|no page (fits|answers)/i.test(t)) return "no-answer"
  if (status === "error" || /^Error:/.test(t)) return "other-error"
  return "answer"
}

export const FAILED_OUTCOMES: readonly QueryOutcome[] = ["empty", "no-catalog", "timeout", "crash", "model-error", "denied", "other-error"]

/** What the agent did in the next few calls after a query: a proxy for
 *  whether the answer was enough. */
export type FollowUp = "search" | "read" | "ask" | "requery" | "other" | "none"

export function classifyFollowUp(action: string | null, input: string | null): FollowUp {
  const name = tail(action)
  const call = classifyCall(action, input)
  if (call === "tool" || call === "cli") return "requery"
  if (name === "Grep" || name === "Glob" || name === "WebSearch") return "search"
  if (action === "Bash" && /(^|[\s"'|;&(])(grep|rg|find|ag|git (log|grep))\s/.test(input ?? "")) return "search"
  if (name === "Read" || name === "agentx_recent" || name === "agentx_events") return "read"
  if (/^agentx_(send|send_agent|lookup|call_owner|request)$/.test(name)) return "ask"
  return "other"
}

/** The question a call asked, from its input summary. */
export function questionOf(kind: WikiCallKind, input: string | null): string | null {
  if (!input) return null
  if (kind === "tool") {
    try {
      const q = JSON.parse(input)?.question
      return typeof q === "string" && q.trim() ? q.trim() : null
    } catch {
      const m = input.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      return m ? m[1].replace(/\\"/g, '"').trim() : null
    }
  }
  if (kind === "cli") {
    let cmd = input
    try { cmd = String(JSON.parse(input)?.command ?? input) } catch { /* clipped JSON: match the raw text */ }
    const m = cmd.match(/wiki\s+query\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/)
    return m ? (m[1] ?? m[2] ?? "").replace(/\\"/g, '"').trim() || null : null
  }
  return null
}

export interface WikiCall {
  task_id: string
  agent: string
  at: number
  kind: WikiCallKind
  question: string | null
  outcome: QueryOutcome | null
  resultChars: number
  next: FollowUp
}

/**
 * The wiki calls in `steps`, each paired with its result. A result carries
 * no tool_use id in the ledger, so results are paired in order: the first
 * result after a call answers the oldest call still waiting. Parallel
 * calls can swap results; the counts hold, a single pairing may not.
 */
export function wikiCalls(tasks: TaskRow[], steps: StepRow[], followWindow = 3): WikiCall[] {
  const byTask = new Map<string, StepRow[]>()
  for (const s of steps) {
    const list = byTask.get(s.task_id) ?? []
    list.push(s)
    byTask.set(s.task_id, list)
  }
  const taskOf = new Map(tasks.map((t) => [t.task_id, t]))
  const out: WikiCall[] = []
  for (const [taskId, list] of byTask) {
    const task = taskOf.get(taskId)
    if (!task) continue
    list.sort((a, b) => a.seq - b.seq)
    const waiting: number[] = []
    const resultFor = new Map<number, StepRow>()
    list.forEach((s, i) => {
      if (s.name === "tool_use") waiting.push(i)
      else if (s.name === "tool_result" && waiting.length) resultFor.set(waiting.shift()!, s)
    })
    list.forEach((s, i) => {
      if (s.name !== "tool_use") return
      const kind = classifyCall(s.action, s.input_summary)
      if (!kind) return
      const result = resultFor.get(i)
      const later = list.slice(i + 1).filter((x) => x.name === "tool_use").slice(0, followWindow)
      const nexts = later.map((x) => classifyFollowUp(x.action, x.input_summary))
      const next: FollowUp = nexts.find((n) => n === "requery" || n === "search" || n === "ask")
        ?? nexts.find((n) => n === "read") ?? (nexts.length ? "other" : "none")
      out.push({
        task_id: taskId,
        agent: task.agent_id,
        at: task.started_at,
        kind,
        question: questionOf(kind, s.input_summary),
        outcome: kind === "tool" || kind === "cli" ? (result ? classifyResult(result.output_summary, result.status) : null) : null,
        resultChars: result?.output_summary?.length ?? 0,
        next,
      })
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

export interface UsageReport {
  turns: number
  sessions: number
  turnsWithQuery: number
  sessionsWithQuery: number
  calls: Record<WikiCallKind, number>
  byAgent: Array<{ agent: string; turns: number; turnsWithQuery: number; queries: number; failed: number }>
  byDay: Array<{ day: string; turns: number; turnsWithQuery: number; queries: number }>
  /** Over queries (tool + cli) whose result was found. */
  outcomes: Partial<Record<QueryOutcome, number>>
  failed: number
  unpaired: number
  resultCharsP50: number
  /** What came next after a query, over queries that ended in an answer. */
  nextAfterAnswer: Partial<Record<FollowUp, number>>
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const isQuery = (c: WikiCall) => c.kind === "tool" || c.kind === "cli"

export function summariseUsage(tasks: TaskRow[], calls: WikiCall[]): UsageReport {
  const queries = calls.filter(isQuery)
  const askedTasks = new Set(queries.map((c) => c.task_id))
  const sessionOf = (t: TaskRow) => t.session || t.task_id
  const sessions = new Set(tasks.map(sessionOf))
  const askedSessions = new Set(tasks.filter((t) => askedTasks.has(t.task_id)).map(sessionOf))

  const outcomes: Partial<Record<QueryOutcome, number>> = {}
  const nextAfterAnswer: Partial<Record<FollowUp, number>> = {}
  let unpaired = 0
  for (const q of queries) {
    if (!q.outcome) { unpaired++; continue }
    outcomes[q.outcome] = (outcomes[q.outcome] ?? 0) + 1
    if (q.outcome === "answer") nextAfterAnswer[q.next] = (nextAfterAnswer[q.next] ?? 0) + 1
  }
  const failedOf = (list: WikiCall[]) => list.filter((q) => q.outcome && FAILED_OUTCOMES.includes(q.outcome)).length

  const agents = new Map<string, { turns: number; asked: Set<string>; q: WikiCall[] }>()
  for (const t of tasks) {
    const a = agents.get(t.agent_id) ?? { turns: 0, asked: new Set<string>(), q: [] }
    a.turns++
    if (askedTasks.has(t.task_id)) a.asked.add(t.task_id)
    agents.set(t.agent_id, a)
  }
  for (const q of queries) agents.get(q.agent)?.q.push(q)

  const days = new Map<string, { turns: number; asked: Set<string>; queries: number }>()
  for (const t of tasks) {
    const d = days.get(day(t.started_at)) ?? { turns: 0, asked: new Set<string>(), queries: 0 }
    d.turns++
    if (askedTasks.has(t.task_id)) d.asked.add(t.task_id)
    days.set(day(t.started_at), d)
  }
  for (const q of queries) {
    const d = days.get(day(q.at))
    if (d) d.queries++
  }

  const chars = queries.filter((q) => q.outcome).map((q) => q.resultChars).sort((a, b) => a - b)
  const calls_: Record<WikiCallKind, number> = { tool: 0, cli: 0, lookup: 0, patch: 0 }
  for (const c of calls) calls_[c.kind]++

  return {
    turns: tasks.length,
    sessions: sessions.size,
    turnsWithQuery: askedTasks.size,
    sessionsWithQuery: askedSessions.size,
    calls: calls_,
    byAgent: [...agents].map(([agent, a]) => ({ agent, turns: a.turns, turnsWithQuery: a.asked.size, queries: a.q.length, failed: failedOf(a.q) }))
      .sort((x, y) => y.queries - x.queries || y.turns - x.turns),
    byDay: [...days].map(([d, v]) => ({ day: d, turns: v.turns, turnsWithQuery: v.asked.size, queries: v.queries }))
      .sort((x, y) => x.day.localeCompare(y.day)),
    outcomes,
    failed: failedOf(queries),
    unpaired,
    resultCharsP50: chars.length ? chars[Math.floor(chars.length / 2)] : 0,
    nextAfterAnswer,
  }
}

export interface GradingItem {
  id: string
  agent: string
  at: string
  question: string
  /** Filled in by hand: the facts a correct answer contains (`wiki score`). */
  expect: string[]
  /** How the query ended when the agent asked it. */
  outcome: QueryOutcome | null
}

/**
 * Up to `n` distinct past questions for a graded sample, taken in turn
 * from each agent so one busy seat does not fill the set, newest first.
 * The file it goes to holds real questions: keep it out of the repository.
 */
export function gradingSample(calls: WikiCall[], n: number): GradingItem[] {
  const seen = new Set<string>()
  const perAgent = new Map<string, WikiCall[]>()
  for (const c of [...calls].filter(isQuery).reverse()) {
    if (!c.question) continue
    const key = c.question.toLowerCase().replace(/\s+/g, " ")
    if (seen.has(key)) continue
    seen.add(key)
    const list = perAgent.get(c.agent) ?? []
    list.push(c)
    perAgent.set(c.agent, list)
  }
  const out: GradingItem[] = []
  const queues = [...perAgent.values()]
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) {
      const c = q.shift()
      if (!c) continue
      out.push({ id: `q${out.length + 1}`, agent: c.agent, at: new Date(c.at).toISOString(), question: c.question!, expect: [], outcome: c.outcome })
      if (out.length >= n) break
    }
  }
  return out
}
