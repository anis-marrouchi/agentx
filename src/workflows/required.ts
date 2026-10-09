import { idempotencyKey, type RunStore } from "./run-store"
import type { NodeExecutionEntry, Plan, PlanStep, WorkflowRun } from "./types"

// --- Run every task through a workflow (#858) ---
//
// With `workflows.required` on, every task that reaches an agent runs
// inside a workflow run:
//   1. a saved workflow that fits the request, started and followed by the
//      engine (the registry's auto-runner, human-facing turns only);
//   2. otherwise a plan the agent writes first (agentx_workflow plan), whose
//      steps it reports as it goes and may change mid-run;
//   3. otherwise the one-step `linear` template: start → reply → done, the
//      reply being the agent's turn.
// Cases 2 and 3 wrap the agent's own turn: the run is created when the turn
// starts and ends with it, so nothing extra runs and no step is replayed.
//
// The run records each step with when it started, how long it took and
// where it failed; runRecord() turns a run into one line a later analysis
// reads across runs.
//
// A plain question (no plan, and only tools that change nothing) can be
// exempted: its run is discarded when the turn ends (exemptQuestions).

/** The workflow id wrapped tasks run under. No file: the steps are the
 *  `linear` template's, or the agent's plan. */
export const TASK_WORKFLOW_ID = "task"
/** Node ids of the `linear` template (templates/linear.yaml). */
export const LINEAR_STEPS = { start: "start", reply: "reply", done: "done" } as const

export interface RequiredSettings {
  enabled: boolean
  /** Per agent, by id: true or false wins over `enabled`. */
  agents: Record<string, boolean>
  /** Plain questions answered in one turn with nothing changed leave no run. */
  exemptQuestions: boolean
}

export const REQUIRED_DEFAULTS: RequiredSettings = { enabled: false, agents: {}, exemptQuestions: true }

/** Is a workflow required for this agent's tasks? Needs the engine on. */
export function requiredFor(
  workflows: { enabled?: boolean; required?: Partial<RequiredSettings> } | undefined,
  agentId: string,
): boolean {
  if (!workflows?.enabled) return false
  const r = workflows.required
  return r?.agents?.[agentId] ?? r?.enabled ?? false
}

/** Should this task be wrapped? Not a step of a workflow run already: an
 *  agent node's turn is that run's step, and wrapping it would nest runs. */
export function shouldWrap(task: { workflowRunId?: string; context?: { channel?: string } }): boolean {
  return !task.workflowRunId && task.context?.channel !== "workflow"
}

/** The one context block the agent gets when its task is wrapped. Kept
 *  short: it is sent on every wrapped turn (the overhead, in tokens). */
export function wrapHintText(runId: string): string {
  return [
    `[Workflow run ${runId}] This task runs inside a workflow run (workflows.required).`,
    `If it takes more than one step, write your plan first: agentx_workflow {action:"plan", runId:"${runId}", steps:["…","…"]}.`,
    `Report each step: {action:"step", runId:"${runId}", step:"<id>", status:"started"|"done"|"failed", note}.`,
    `If the plan changes, call plan again with the steps left and a reason; steps done stay.`,
    `A one-step task needs none of this: your reply is the run's one step.`,
  ].join(" ")
}

/** What the agentx_workflow tool says about plan and step: sent with the
 *  tool list, so it counts toward the overhead too. */
export const PLAN_TOOL_TEXT =
  "plan / step: when your task names a [Workflow run <id>], write your plan first (runId, steps: short titles) and report each step (runId, step, status started|done|failed, note); call plan again with the steps left and a reason to change it."

// ---------------------------------------------------------------------------
// Tools that change nothing (the plain-question exemption)

const READ_ONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "NotebookRead", "WebSearch", "WebFetch",
  "TodoWrite", "TodoRead", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool",
])
const READ_ONLY_VERB = /^(get|list|search|read|query|find|show|status|describe|fetch|view|lookup|recall|whoami|check)(_|-|$|[A-Z])/
const READ_ONLY_WORKFLOW_ACTIONS = new Set(["list", "match", "status"])
/** A first word that changes something: "set_status" is a write, even
 *  though its last word reads like a lookup. */
const WRITE_VERB = /^(set|update|delete|clear|create|add|remove|send|post|put|patch|write|run|start|stop|cancel|edit|move|rename|reset|save|upload|merge|close|open|approve|reject|assign|mark)$/

/** Does this tool call change nothing? Unknown tools count as changing. */
export function isReadOnlyToolUse(name: string, input?: Record<string, unknown>): boolean {
  if (READ_ONLY_TOOLS.has(name)) return true
  const bare = name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name
  if (bare === "agentx_workflow") return READ_ONLY_WORKFLOW_ACTIONS.has(String(input?.action ?? "list").toLowerCase())
  const verb = bare.replace(/^agentx_/, "")
  // "get_issue", or "wiki_query": the verb leads, or the noun comes first.
  // A name that leads with a write verb ("set_status") is never read-only.
  const words = verb.split(/[_-]/)
  if (WRITE_VERB.test(words[0].toLowerCase())) return false
  return READ_ONLY_VERB.test(verb) || (words.length > 1 && READ_ONLY_VERB.test(words.at(-1) ?? ""))
}

/** Tool calls in one stream event (assistant tool_use blocks). */
export function toolUsesOf(event: any): Array<{ name: string; input?: Record<string, unknown> }> {
  if (!event || typeof event !== "object" || event.type !== "assistant") return []
  const blocks = event.message?.content
  if (!Array.isArray(blocks)) return []
  return blocks
    .filter((b: any) => b?.type === "tool_use" && typeof b.name === "string" && b.name)
    .map((b: any) => ({ name: b.name, input: b.input && typeof b.input === "object" ? b.input : undefined }))
}

// ---------------------------------------------------------------------------
// The wrap: create, plan, step, finish

export interface WrapStart {
  runId: string
  agentId: string
  channel: string
  chatId?: string
  message: string
  taskId?: string
}

/** Create the run a task is wrapped in, on the `linear` template's steps. */
export function startWrap(runs: RunStore, args: WrapStart): WorkflowRun {
  const title = args.message.replace(/\s+/g, " ").trim().slice(0, 80) || `${args.agentId} task`
  return runs.create({
    id: args.runId,
    workflowId: TASK_WORKFLOW_ID,
    initialPending: [LINEAR_STEPS.reply],
    entityRef: { backend: "task", id: args.runId },
    // A bounded preview, never the whole request (run files are listed).
    initialContext: { [LINEAR_STEPS.start]: { agentId: args.agentId, channel: args.channel, ...(args.chatId ? { chatId: args.chatId } : {}), preview: args.message.slice(0, 200) } },
    meta: {
      title,
      tags: [`agent:${args.agentId}`],
      startedBy: args.agentId,
      followUp: false,
      approvedAtStart: false,
      wrap: { agentId: args.agentId, channel: args.channel, mode: "linear", ...(args.taskId ? { taskId: args.taskId } : {}) },
    },
  })
}

/** Step ids the run has finished (ok or failed). */
function finishedSteps(run: WorkflowRun): Set<string> {
  return new Set(run.history.filter((h) => h.status === "ok" || h.status === "failed").map((h) => h.nodeId))
}

function stepTitle(raw: unknown): string {
  if (typeof raw === "string") return raw.trim()
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>
    for (const k of ["title", "name", "step", "id"]) if (typeof r[k] === "string" && (r[k] as string).trim()) return (r[k] as string).trim()
  }
  return ""
}

export type WrapResult = { ok: true; run: WorkflowRun } | { ok: false; error: string }

/** The agent writes its plan, or changes the steps it has left. Steps done
 *  keep their place; the change is recorded on the run's plan. */
export function writePlan(runs: RunStore, runId: string, input: { steps: unknown; reason?: string }): WrapResult {
  const run = runs.get(runId)
  if (!run?.meta?.wrap) return { ok: false, error: `no wrapped task run "${runId}"` }
  if (run.status !== "running") return { ok: false, error: `run ${runId} is ${run.status}` }
  if (!Array.isArray(input.steps) || input.steps.length === 0) return { ok: false, error: "plan needs steps: a list of short step titles" }
  if (input.steps.length > 30) return { ok: false, error: "a plan has at most 30 steps" }
  const titles = input.steps.map(stepTitle)
  if (titles.some((t) => !t)) return { ok: false, error: "every step needs a title" }

  const old = run.meta.plan
  const done = finishedSteps(run)
  const kept: PlanStep[] = (old?.steps ?? []).filter((s) => done.has(s.id))
  let n = (old?.steps ?? []).reduce((max, s) => Math.max(max, Number(s.id.replace(/^step/, "")) || 0), 0)
  const fresh: PlanStep[] = titles.map((title) => ({ id: `step${++n}`, title: title.slice(0, 160) }))
  const dropped = (old?.steps ?? []).filter((s) => !done.has(s.id)).map((s) => s.id)
  const plan: Plan = {
    steps: [...kept, ...fresh],
    revisions: [
      ...(old?.revisions ?? []),
      {
        at: new Date().toISOString(),
        kind: old ? "revise" : "plan",
        ...(input.reason ? { reason: String(input.reason).slice(0, 300) } : {}),
        steps: fresh.map((s) => s.id),
        dropped,
      },
    ],
  }
  const updated = runs.patch(runId, {
    meta: { plan, wrap: { ...run.meta.wrap, mode: "plan" } },
    pending: fresh.map((s) => s.id),
  })
  return updated ? { ok: true, run: updated } : { ok: false, error: `run ${runId} vanished` }
}

/** Find a plan step by id, by title, or by its number (1-based). */
function findStep(plan: Plan, ref: string): PlanStep | undefined {
  const r = ref.trim()
  return plan.steps.find((s) => s.id === r)
    ?? plan.steps.find((s) => s.title.toLowerCase() === r.toLowerCase())
    ?? (/^\d+$/.test(r) ? plan.steps[Number(r) - 1] : undefined)
}

/** When the step began: when the agent said it started it, else when the
 *  last step ended, else when the run began. */
function stepStart(run: WorkflowRun, stepId: string): string {
  const cur = run.meta?.plan?.current
  if (cur?.id === stepId) return cur.startedAt
  return run.history.at(-1)?.at ?? run.createdAt
}

function entry(run: WorkflowRun, nodeId: string, status: NodeExecutionEntry["status"], startedAt: string, extra: Partial<NodeExecutionEntry> = {}): NodeExecutionEntry {
  const at = new Date().toISOString()
  return {
    at, nodeId, inputKeys: [], status, startedAt,
    durationMs: Math.max(0, Date.parse(at) - Date.parse(startedAt)),
    idempotencyKey: idempotencyKey(run.id, nodeId, `wrap:${status}:${run.history.length}`),
    ...extra,
  }
}

/** The agent reports a plan step: started, done or failed. A failed step
 *  marks where the run failed; the run itself ends with the turn. */
export function reportStep(runs: RunStore, runId: string, input: { step: unknown; status: unknown; note?: unknown }): WrapResult {
  const run = runs.get(runId)
  if (!run?.meta?.wrap) return { ok: false, error: `no wrapped task run "${runId}"` }
  if (run.status !== "running") return { ok: false, error: `run ${runId} is ${run.status}` }
  const plan = run.meta.plan
  if (!plan) return { ok: false, error: "write a plan first: {action:\"plan\", runId, steps:[…]}" }
  const status = String(input.status ?? "done").toLowerCase()
  if (!["started", "done", "failed"].includes(status)) return { ok: false, error: "status is started, done or failed" }
  const ref = typeof input.step === "string" || typeof input.step === "number" ? String(input.step) : ""
  const step = ref ? findStep(plan, ref) : plan.steps.find((s) => !finishedSteps(run).has(s.id))
  if (!step) return { ok: false, error: `no step "${ref}" in the plan (${plan.steps.map((s) => `${s.id} ${s.title}`).join("; ")})` }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 300) : undefined

  if (status === "started") {
    const pending = [step.id, ...run.pending.filter((p) => p !== step.id)]
    const updated = runs.patch(runId, { meta: { plan: { ...plan, current: { id: step.id, startedAt: new Date().toISOString() } } }, pending })
    return updated ? { ok: true, run: updated } : { ok: false, error: `run ${runId} vanished` }
  }
  const e = entry(run, step.id, status === "done" ? "ok" : "failed", stepStart(run, step.id), note ? { note } : {})
  const recorded = runs.recordExecution({ runId, entry: e, nextPending: run.pending.filter((p) => p !== step.id) })
  if (!recorded) return { ok: false, error: `run ${runId} vanished` }
  const updated = plan.current?.id === step.id ? runs.patch(runId, { meta: { plan: { ...plan, current: undefined } } }) : recorded
  return updated ? { ok: true, run: updated } : { ok: false, error: `run ${runId} vanished` }
}

export interface WrapOutcome {
  /** The turn's error, if it failed or was stopped. */
  error?: string
  /** Why the turn ended without finishing, when it was not a failure: a
   *  stop signal (#857), an operator cancel, a daemon stop. The run is
   *  then closed as `canceled`, not `failed`, so analysis across runs
   *  never counts a pause as a failure. */
  canceled?: boolean
  /** Turn wall time, ms. */
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  /** Every tool the turn used changed nothing. */
  readOnly: boolean
  /** Discard the run of a plain question (exemptQuestions on). */
  exemptQuestions: boolean
}

/** The turn ended: close the run. Returns "discarded" for an exempted
 *  plain question, else the final run. */
export function finishWrap(runs: RunStore, runId: string, out: WrapOutcome): WorkflowRun | "discarded" | null {
  const run = runs.get(runId)
  if (!run?.meta?.wrap) return null
  if (run.status !== "running") return run
  const plan = run.meta.plan
  if (!plan && !out.error && out.readOnly && out.exemptQuestions) {
    runs.discard(runId)
    return "discarded"
  }
  const usage = {
    turnMs: out.durationMs,
    ...(out.inputTokens !== undefined ? { inputTokens: out.inputTokens } : {}),
    ...(out.outputTokens !== undefined ? { outputTokens: out.outputTokens } : {}),
  }
  const error = out.error ? out.error.slice(0, 300) : undefined
  let current = run

  if (error && out.canceled) {
    // Stopped, not failed: the step it was on and the ones after it are
    // skipped with the reason; nothing is marked failed.
    const done = finishedSteps(current)
    const left = plan ? plan.steps.filter((s) => !done.has(s.id)).map((s) => s.id) : [LINEAR_STEPS.reply]
    const at = plan?.current && left.includes(plan.current.id) ? plan.current.id : left[0]
    for (const id of left) {
      const note = id === at ? `stopped: ${error}` : "not reached: the turn was stopped"
      const e = entry(current, id, "skipped", id === at ? stepStart(current, id) : (current.history.at(-1)?.at ?? current.createdAt), { note, ...(id === at && !plan ? { output: usage } : {}) })
      current = runs.recordExecution({ runId, entry: e, nextPending: [] }) ?? current
    }
    return runs.setStatus(runId, "canceled") ?? current
  }

  if (!plan) {
    // linear: the reply step is the turn.
    const e = entry(current, LINEAR_STEPS.reply, error ? "failed" : "ok", current.createdAt, { output: usage, ...(error ? { note: error } : {}) })
    current = runs.recordExecution({ runId, entry: e, nextPending: error ? [] : [LINEAR_STEPS.done], ...(error ? { status: "failed" as const } : {}) }) ?? current
  } else {
    const done = finishedSteps(current)
    const left = plan.steps.filter((s) => !done.has(s.id))
    if (error) {
      // Failed where it was: the step it started, else the next one left.
      const at = (plan.current && left.find((s) => s.id === plan.current!.id)) ?? left[0]
      if (at) {
        const e = entry(current, at.id, "failed", stepStart(current, at.id), { note: error })
        current = runs.recordExecution({ runId, entry: e, nextPending: [] }) ?? current
      }
    }
    for (const s of left) {
      if (error && finishedSteps(current).has(s.id)) continue
      const e = entry(current, s.id, "skipped", current.history.at(-1)?.at ?? current.createdAt, { note: error ? "not reached: the turn failed" : "not reported before the turn ended" })
      current = runs.recordExecution({ runId, entry: e, nextPending: [] }) ?? current
    }
    if (error) current = runs.setStatus(runId, "failed") ?? current
  }
  if (!error) {
    const e = entry(current, LINEAR_STEPS.done, "ok", current.history.at(-1)?.at ?? current.createdAt, { output: usage })
    current = runs.recordExecution({ runId, entry: e, nextPending: [], status: "completed" }) ?? current
  } else if (current.status === "running") {
    current = runs.setStatus(runId, "failed") ?? current
  }
  return runs.get(runId) ?? current
}

/** Error kinds that end a turn without it failing: a stop signal (#857),
 *  an operator cancel, a daemon shutdown. Compared as strings so a kind
 *  added later needs no type change here. */
const NOT_A_FAILURE = new Set(["stopped", "cancelled", "interrupted"])
export function endedWithoutFailing(errorKind: unknown): boolean {
  return typeof errorKind === "string" && NOT_A_FAILURE.has(errorKind)
}

/** At boot: a wrapped task's run still "running" lost its turn when the
 *  daemon stopped (a hard kill skips the turn's own close). Close it as
 *  canceled where it was, so records and the Live page do not show it as
 *  going on. The task itself is resumed (or reported) by the restart
 *  path as before: wrapping never sets the task's workflowRunId. */
export function closeStaleWraps(runs: RunStore, note = "interrupted: the daemon stopped during the turn"): number {
  let closed = 0
  for (const run of runs.list()) {
    if (run.status !== "running" || !run.meta?.wrap) continue
    // Cut off, not failed: the task itself is resumed after the restart.
    const r = finishWrap(runs, run.id, { error: note, canceled: true, durationMs: Math.max(0, Date.now() - Date.parse(run.createdAt)), readOnly: false, exemptQuestions: false })
    if (r && r !== "discarded") closed++
  }
  return closed
}

// ---------------------------------------------------------------------------
// One line per run, for analysis across runs

export interface RunRecordStep {
  id: string
  title?: string
  status: string
  startedAt?: string
  durationMs?: number
  note?: string
}

export interface RunRecord {
  v: 1
  runId: string
  workflowId: string
  title: string
  /** How the work ran: a saved workflow, the agent's plan, or `linear`. */
  mode: "workflow" | "plan" | "linear"
  agentId?: string
  status: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  steps: RunRecordStep[]
  /** The first step that failed, if any. */
  failedAt: string | null
  /** Changes made to the plan after it was first written. */
  revisions: number
  tags: string[]
  /** Tokens the agent turn used, when the run wrapped one. */
  tokens?: { input?: number; output?: number }
}

const TERMINAL = new Set(["completed", "failed", "canceled"])

/** A run as one record: which steps were taken, how long each took, where
 *  it failed. Step durations missing from older runs are taken from the
 *  gap to the entry before. Bounded: no step outputs, no prompts. */
export function runRecord(run: WorkflowRun): RunRecord {
  const plan = run.meta?.plan
  const titles = new Map((plan?.steps ?? []).map((s) => [s.id, s.title] as const))
  const steps: RunRecordStep[] = []
  let prevAt = run.createdAt
  for (const h of run.history) {
    if (h.status === "paused" || h.status === "resumed") { prevAt = h.at; continue }
    const durationMs = h.durationMs ?? Math.max(0, Date.parse(h.at) - Date.parse(prevAt))
    steps.push({
      id: h.nodeId,
      ...(titles.has(h.nodeId) ? { title: titles.get(h.nodeId) } : {}),
      status: h.status,
      startedAt: h.startedAt ?? prevAt,
      durationMs,
      ...(h.note ? { note: h.note.slice(0, 200) } : {}),
    })
    prevAt = h.at
  }
  const ended = TERMINAL.has(run.status) ? run.updatedAt : undefined
  const usage = [...run.history].reverse().find((h) => h.output && typeof h.output.turnMs === "number")?.output as Record<string, number> | undefined
  return {
    v: 1,
    runId: run.id,
    workflowId: run.workflowId,
    title: run.meta?.title ?? run.workflowId,
    mode: run.meta?.wrap ? run.meta.wrap.mode : "workflow",
    ...(run.meta?.wrap?.agentId ?? run.meta?.startedBy ? { agentId: run.meta?.wrap?.agentId ?? run.meta?.startedBy } : {}),
    status: run.status,
    startedAt: run.createdAt,
    ...(ended ? { endedAt: ended, durationMs: Math.max(0, Date.parse(ended) - Date.parse(run.createdAt)) } : {}),
    steps,
    failedAt: steps.find((s) => s.status === "failed" || s.status === "timeout")?.id ?? null,
    revisions: Math.max(0, (plan?.revisions.length ?? 0) - 1),
    tags: run.meta?.tags ?? [],
    ...(usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
      ? { tokens: { ...(usage.inputTokens !== undefined ? { input: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { output: usage.outputTokens } : {}) } }
      : {}),
  }
}

/** The step a wrapped or engine run is on, with plan progress when there
 *  is one ("step2 Check the logs (2/4)"). For the live page. */
export function liveStep(run: WorkflowRun): string {
  const plan = run.meta?.plan
  const id = run.meta?.plan?.current?.id ?? run.pausedAt?.nodeId ?? run.pending[0] ?? run.history.at(-1)?.nodeId ?? "-"
  if (!plan) return id
  const i = plan.steps.findIndex((s) => s.id === id)
  return i >= 0 ? `${plan.steps[i].title} (${i + 1}/${plan.steps.length})` : id
}
