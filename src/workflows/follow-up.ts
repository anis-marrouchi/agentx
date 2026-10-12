import { lintWorkflow, workflowSchema, type NodeType, type Workflow, type WorkflowRun } from "./types"

// --- Follow-up workflows: what agents, the CLI and the dashboard share (#788) ---
//
//   workflowHintText    the line that tells an agent a saved workflow fits
//   buildWorkflow       a workflow from an agent's step list (built on demand)
//   runSummary          the owner's one message when a run ends
//   blockedText         the owner's message when a step needs them
//   progressGroups      running follow-ups grouped by what they concern
//
// Pure functions: no I/O, so the daemon, the CLI and tests use them alike.

/** Step types an agent may put in a workflow it builds or proposes. No
 *  raw channel sends (`action.send` skips the owner's approval), no
 *  shell, HTTP or registered actions: those are the owner's to add from
 *  the editor or the CLI. */
export const AGENT_STEP_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "agent", "owner.notify", "owner.ask", "person.message", "person.wait",
  "branch", "transform", "timer.boundary", "end",
])

export function workflowHintText(wf: Pick<Workflow, "id" | "title" | "autoStart">): string {
  return [
    `[Saved workflow] This request looks like the saved workflow "${wf.title}" (${wf.id}).`,
    `If it is, start it with agentx_workflow {action:"start", workflowId:"${wf.id}", title:"<the request in a few words>", tags:["client:<name>"]} instead of doing the steps by hand: AgentX then follows each step, reminds whoever is slow and tells the owner when it is done.`,
    wf.autoStart ? "It is marked to start without asking." : "AgentX tells the owner which workflow you chose when you start it.",
  ].join(" ")
}

export interface StepInput {
  id?: unknown
  type?: unknown
  config?: unknown
}

export interface BuildInput {
  id: string
  title: string
  description?: string
  steps: unknown
  edges?: unknown
  approval?: unknown
  autoStart?: unknown
  ownerAgent?: string
  tags?: string[]
}

/** A workflow from a list of steps: a manual trigger first, the steps in
 *  order (or joined by `edges` when given), an end last. Every step must
 *  be one an agent may use (AGENT_STEP_TYPES). */
export function buildWorkflow(input: BuildInput): { ok: true; workflow: Workflow } | { ok: false; error: string } {
  if (!Array.isArray(input.steps) || input.steps.length === 0) return { ok: false, error: "steps must be a non-empty list of {id, type, config}" }
  if (input.steps.length > 40) return { ok: false, error: "a workflow has at most 40 steps" }
  const nodes: Array<{ id: string; type: string; config: Record<string, unknown> }> = [{ id: "start", type: "trigger.manual", config: {} }]
  for (const [i, raw] of (input.steps as StepInput[]).entries()) {
    const id = typeof raw?.id === "string" && raw.id ? raw.id : `step${i + 1}`
    const type = typeof raw?.type === "string" ? raw.type : ""
    if (!AGENT_STEP_TYPES.has(type as NodeType)) {
      return { ok: false, error: `step "${id}": type "${type}" is not one an agent may use (${[...AGENT_STEP_TYPES].join(", ")})` }
    }
    if (id === "start" || nodes.some((n) => n.id === id)) return { ok: false, error: `step id "${id}" is used twice (or is "start")` }
    nodes.push({ id, type, config: raw.config && typeof raw.config === "object" && !Array.isArray(raw.config) ? raw.config as Record<string, unknown> : {} })
  }
  const addEnd = !nodes.some((n) => n.type === "end")
  if (addEnd) nodes.push({ id: "done", type: "end", config: {} })
  let edges: unknown = input.edges
  if (edges === undefined) {
    // In order, and the start to the first step.
    edges = nodes.slice(0, -1).flatMap((n, i) => (n.type === "end" ? [] : [{ from: n.id, to: nodes[i + 1].id }]))
  } else if (Array.isArray(edges)) {
    const given = edges as Array<{ from?: unknown }>
    // A step nothing leads on from ends the run.
    const loose = addEnd ? nodes.slice(1, -1).filter((n) => n.type !== "end" && !given.some((e) => e?.from === n.id)) : []
    edges = [{ from: "start", to: nodes[1].id }, ...given, ...loose.map((n) => ({ from: n.id, to: "done" }))]
  }
  const parsed = workflowSchema.safeParse({
    id: input.id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    nodes,
    edges,
    tags: input.tags ?? [],
    ...(input.ownerAgent ? { ownerAgent: input.ownerAgent } : {}),
    ...(input.approval === "start" || input.approval === "step" ? { approval: input.approval } : {}),
    autoStart: input.autoStart === true,
  })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "workflow"}: ${i.message}`).join("; ").slice(0, 600) }
  }
  const issues = lintWorkflow(parsed.data)
  if (issues.length) return { ok: false, error: issues.join("; ").slice(0, 600) }
  return { ok: true, workflow: parsed.data }
}

/** A workflow id from a title: lower-kebab, with a suffix that keeps it new. */
export function workflowIdFor(title: string, prefix = "wf"): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return `${prefix}-${slug || "run"}-${Date.now().toString(36)}`
}

/** Tags as "kind:name", lower case, without spaces at the ends. */
export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : []
  const out: string[] = []
  for (const t of list) {
    if (typeof t !== "string") continue
    const tag = t.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 60)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 10)
}

/** A pause as list APIs show it: a message waiting for approval keeps
 *  its recipient, never its text (CLAUDE.md: bounded summaries). */
export function slimPausedAt(p: WorkflowRun["pausedAt"]): WorkflowRun["pausedAt"] {
  if (p?.kind !== "ownerDecision" || !p.message) return p
  const { text: _text, ...recipient } = p.message
  return { ...p, message: { ...recipient, text: "" } }
}

/** What a paused or running run is waiting on, in words. */
export function waitingOn(run: Pick<WorkflowRun, "status" | "pausedAt" | "pending" | "meta">): string {
  const p = run.pausedAt
  if (run.status === "running") return run.pending.length ? `running ${run.pending.join(", ")}` : "finishing"
  if (run.status !== "paused" || !p) return run.status
  switch (p.kind) {
    case "ownerDecision":
      return p.purpose === "start" ? "your approval to start" : p.purpose === "send" ? `your approval to send to ${p.message?.to ?? p.message?.chatId ?? "a person"}` : "your answer"
    case "replyWait":
      return `a reply on ${p.channel} (${p.chatId}) until ${p.deadline.slice(0, 16).replace("T", " ")} UTC${p.reminders ? `, ${p.reminders} reminder(s) sent` : ""}`
    case "agentStep":
      return p.blocked ? `blocked: ${p.blocked}` : `${p.agentId} to finish${p.nudges ? ` (${p.nudges}/${p.maxNudges} reminder(s) sent)` : ""}`
    case "agentStop":
      return `a resume signal: ${p.agentId} was paused at this step`
    case "timerWait":
      return `a timer until ${p.fireAt.slice(0, 16).replace("T", " ")} UTC`
    case "signalWait":
      return `the signal "${p.signalName}"`
    case "subProcess":
      return `the child workflow ${p.childWorkflowId}`
    case "checkpoint":
      return `an event at checkpoint ${p.checkpointName}`
  }
}

/** The step a run is on. */
export function currentStep(run: Pick<WorkflowRun, "pausedAt" | "pending" | "history">): string {
  return run.pausedAt?.nodeId ?? run.pending[0] ?? run.history.at(-1)?.nodeId ?? "-"
}

/** The owner's one message when a follow-up run ends. */
export function runSummary(run: WorkflowRun, wf: Pick<Workflow, "id" | "title"> | null): { title: string; message: string } {
  const name = run.meta?.title ?? wf?.title ?? run.workflowId
  const word = run.status === "completed" ? "done" : run.status === "canceled" ? "stopped" : "did not finish"
  const steps: string[] = []
  const seen = new Set<string>()
  for (const h of run.history) {
    if (h.status !== "ok" && h.status !== "resumed" && h.status !== "failed") continue
    if (seen.has(h.nodeId) && h.status !== "failed") continue
    seen.add(h.nodeId)
    const proof = h.output && typeof h.output.evidence === "string" ? ` (${h.output.evidence})` : ""
    steps.push(`${h.status === "failed" ? "✗" : "✓"} ${h.nodeId}${proof}${h.status === "failed" && h.note ? `: ${h.note}` : ""}`)
  }
  const last = run.history.at(-1)
  return {
    title: `Workflow ${word}: ${name}`.slice(0, 120),
    message: [
      `"${name}" is ${word}${run.meta?.startedBy ? ` (started by ${run.meta.startedBy})` : ""}.`,
      ...(run.meta?.tags?.length ? [`About: ${run.meta.tags.join(", ")}`] : []),
      ...steps.slice(-12),
      ...(run.status !== "completed" && last?.note ? [`Why: ${last.note}`] : []),
      `Run ${run.id}`,
    ].join("\n"),
  }
}

/** The evidence a finished run leaves on its request: the steps' proofs. */
export function runEvidence(run: WorkflowRun): string {
  const proofs = run.history
    .map((h) => (h.output && typeof h.output.evidence === "string" ? h.output.evidence : null))
    .filter((x): x is string => !!x)
  return proofs.length ? proofs.join(" ") : `workflow run ${run.id} (${run.workflowId}) completed`
}

export function blockedText(run: WorkflowRun, wf: Pick<Workflow, "title"> | null, nodeId: string, reason: string): { title: string; message: string } {
  const name = run.meta?.title ?? wf?.title ?? run.workflowId
  return {
    title: `Workflow blocked: ${name}`.slice(0, 120),
    message: [
      `Step "${nodeId}" of "${name}" cannot go on without you.`,
      `Why: ${reason}`,
      `When it is sorted, the agent can report it done, or you can stop it: agentx workflow cancel ${run.id}`,
    ].join("\n"),
  }
}

export interface ProgressRow {
  runId: string
  workflowId: string
  title: string
  status: string
  step: string
  waitingOn: string
  since: string
  startedBy?: string
  blocked: boolean
  tags: string[]
}

export interface ProgressGroup {
  tag: string
  rows: ProgressRow[]
}

/** Follow-up runs still going, grouped by tag (a run with two tags shows
 *  in both groups; one with none under "untagged"). Oldest first. */
export function progressGroups(runs: WorkflowRun[], titles: (workflowId: string) => string | undefined = () => undefined): ProgressGroup[] {
  const active = runs
    .filter((r) => r.meta?.followUp && (r.status === "running" || r.status === "paused") && !r.parentRunId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const groups = new Map<string, ProgressRow[]>()
  for (const r of active) {
    const row: ProgressRow = {
      runId: r.id,
      workflowId: r.workflowId,
      title: r.meta?.title ?? titles(r.workflowId) ?? r.workflowId,
      status: r.status,
      step: currentStep(r),
      waitingOn: waitingOn(r),
      since: r.updatedAt,
      ...(r.meta?.startedBy ? { startedBy: r.meta.startedBy } : {}),
      blocked: !!r.meta?.blocked,
      tags: r.meta?.tags ?? [],
    }
    const tags = row.tags.length ? row.tags : ["untagged"]
    for (const tag of tags) {
      if (!groups.has(tag)) groups.set(tag, [])
      groups.get(tag)!.push(row)
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "untagged" ? 1 : b === "untagged" ? -1 : a.localeCompare(b)))
    .map(([tag, rows]) => ({ tag, rows }))
}
