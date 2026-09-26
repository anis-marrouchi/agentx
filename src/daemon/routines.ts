// --- Routines: everything that runs on its own, in one list -----------------
//
// Automation lives in two places: time-based `crons.*` jobs and workflows
// whose trigger node is `trigger.cron` or `trigger.hook`. This module is a
// read model over both — no new schema — merged into one bounded row shape
// with a staleness verdict, so obsolete or failing automation surfaces on
// the mesh overview instead of going unnoticed.
//
// Pure: callers pass the job list, the persisted cron attempts (the source
// of truth; scheduler counters reset on reload), the workflow definitions
// and the workflow run summaries. Nothing here reads prompts or responses,
// and every string that leaves it is length-capped.
//
// Routine ids are stable and namespaced by source — `cron:<jobId>` and
// `workflow:<workflowId>` — so later per-routine actions can address a row
// without knowing which subsystem owns it.

import type { CronRunHistoryItem } from "@/crons/run-history"
import { getNextCronDate } from "@/crons/scheduler"
import { workflowHealth, type RunSummary } from "./workflow-health"

export type RoutineKind = "schedule" | "event"
export type RoutineSource = "cron" | "workflow"
export type RoutineOutcome = "success" | "failed" | "timeout" | "canceled" | "running" | "paused" | "unknown"
export type RoutineFlagReason = "failing" | "overdue" | "dormant" | "never-ran" | "disabled-long"
export type RoutineAttention = "critical" | "warning" | "info"

export interface RoutineFlag { reason: RoutineFlagReason; detail: string }

export interface Routine {
  id: string
  source: RoutineSource
  kind: RoutineKind
  name: string
  trigger: {
    /** Cron expression for schedules. */
    schedule?: string
    timezone?: string
    /** `on:*` event for event routines. */
    event?: string
    /** Compact `key=value` renderings of the trigger filters. */
    filters?: string[]
  }
  agent: string | null
  enabled: boolean
  /** Cron: enabled/disabled. Workflow: active/disabled/quarantined. */
  state: string
  nextRunAt: string | null
  lastRun: { at: string; status: RoutineOutcome; summary?: string } | null
  lastSuccessAt: string | null
  /** Terminal failures in a row, newest first, over the sampled runs. */
  consecutiveFailures: number
  /** Runs inspected to reach the verdict (bounded, not a lifetime total). */
  sampledRuns: number
  flags: RoutineFlag[]
  attention: RoutineAttention | null
}

export interface RoutineCronJob {
  id: string
  enabled: boolean
  schedule: string
  timezone?: string
  agent: string
  nextRun?: Date | string
}

export interface RoutineWorkflow {
  id: string
  title?: string
  state?: string
  ownerAgent?: string
  project?: string
  updated?: string
  created?: string
  nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>
}

export interface RoutineThresholds {
  /** Consecutive failures that flag a routine as failing. */
  failStreak: number
  /** Days a routine may sit disabled before it reads as obsolete. */
  disabledDays: number
  /** Scheduled fires that may pass without an attempt before it is overdue. */
  missedFires: number
  /** Slack added to the overdue deadline for slow starts and restarts. */
  graceMs: number
}

export const DEFAULT_ROUTINE_THRESHOLDS: RoutineThresholds = {
  failStreak: 3,
  disabledDays: 30,
  missedFires: 2,
  graceMs: 15 * 60_000,
}

/** Hard caps: the list is served on an unauthenticated GET and polled. */
export const ROUTINE_LIMITS = { routines: 200, summary: 160, filters: 6, filterValue: 60, text: 120 }

export type NextFire = (expression: string, after: Date, timezone: string) => Date | null

const defaultNextFire: NextFire = (expression, after, timezone) => {
  try { return getNextCronDate(expression, after, timezone) } catch { return null }
}

export interface BuildRoutinesInput {
  crons: RoutineCronJob[]
  /** Newest-first persisted attempts per cron job id. */
  cronRuns: Map<string, CronRunHistoryItem[]>
  workflows: RoutineWorkflow[]
  workflowRuns: RunSummary[]
  now?: number
  thresholds?: Partial<RoutineThresholds>
  nextFire?: NextFire
}

const DAY = 86_400_000

export function buildRoutines(input: BuildRoutinesInput): Routine[] {
  const now = input.now ?? Date.now()
  const t = { ...DEFAULT_ROUTINE_THRESHOLDS, ...input.thresholds }
  const nextFire = input.nextFire ?? defaultNextFire
  const out: Routine[] = []

  for (const job of input.crons) {
    const runs = input.cronRuns.get(job.id) ?? []
    const timezone = job.timezone || "UTC"
    const outcomes = runs.map((r) => ({ at: Date.parse(r.startedAt), status: r.status as RoutineOutcome }))
    const latest = runs[0]
    const routine: Routine = {
      id: `cron:${job.id}`,
      source: "cron",
      kind: "schedule",
      name: cap(job.id, ROUTINE_LIMITS.text),
      trigger: { schedule: cap(job.schedule, ROUTINE_LIMITS.text), timezone },
      agent: job.agent || null,
      enabled: job.enabled,
      state: job.enabled ? "enabled" : "disabled",
      nextRunAt: job.enabled ? isoOrNull(job.nextRun) ?? isoOrNull(nextFire(job.schedule, new Date(now), timezone)) : null,
      lastRun: latest
        ? { at: latest.startedAt, status: latest.status, summary: capOpt(latest.status === "success" ? undefined : latest.errorSummary, ROUTINE_LIMITS.summary) }
        : null,
      lastSuccessAt: runs.find((r) => r.status === "success")?.startedAt ?? null,
      consecutiveFailures: failStreak(outcomes),
      sampledRuns: runs.length,
      flags: [],
      attention: null,
    }
    routine.flags = scheduleFlags(routine, outcomes, job.schedule, timezone, null, now, t, nextFire)
    out.push(finish(routine))
  }

  const health = new Map(workflowHealth(
    input.workflows.map((w) => ({ id: w.id, name: w.title })), input.workflowRuns, now,
  ).map((h) => [h.id, h] as const))
  const runsByWorkflow = new Map<string, RunSummary[]>()
  for (const r of input.workflowRuns) {
    const list = runsByWorkflow.get(r.workflowId)
    if (list) list.push(r)
    else runsByWorkflow.set(r.workflowId, [r])
  }

  for (const wf of input.workflows) {
    const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
    if (!trigger || (trigger.type !== "trigger.cron" && trigger.type !== "trigger.hook")) continue
    const cfg = (trigger.config ?? {}) as Record<string, unknown>
    const state = wf.state || "active"
    const enabled = state === "active"
    const runs = (runsByWorkflow.get(wf.id) ?? []).slice().sort((a, b) => b.at - a.at)
    const outcomes = runs.map((r) => ({ at: r.at, status: workflowOutcome(r.status) }))
    const latest = outcomes[0]
    const isCron = trigger.type === "trigger.cron"
    const spec = typeof cfg.spec === "string" ? cfg.spec : ""
    const timezone = typeof cfg.timezone === "string" ? cfg.timezone : "UTC"
    const routine: Routine = {
      id: `workflow:${wf.id}`,
      source: "workflow",
      kind: isCron ? "schedule" : "event",
      name: cap(wf.title || wf.id, ROUTINE_LIMITS.text),
      trigger: isCron
        ? { schedule: cap(spec, ROUTINE_LIMITS.text), timezone }
        : { event: cap(typeof cfg.event === "string" ? cfg.event : "", ROUTINE_LIMITS.text), filters: describeFilters(cfg.filter, wf) },
      agent: workflowAgent(wf),
      enabled,
      state,
      nextRunAt: isCron && enabled && spec ? isoOrNull(nextFire(spec, new Date(now), timezone)) : null,
      lastRun: latest ? { at: new Date(latest.at).toISOString(), status: latest.status } : null,
      lastSuccessAt: (() => { const s = outcomes.find((o) => o.status === "success"); return s ? new Date(s.at).toISOString() : null })(),
      consecutiveFailures: failStreak(outcomes),
      sampledRuns: runs.length,
      flags: [],
      attention: null,
    }
    const changedAt = Date.parse(wf.updated || wf.created || "")
    routine.flags = isCron
      ? scheduleFlags(routine, outcomes, spec, timezone, Number.isFinite(changedAt) ? changedAt : null, now, t, nextFire)
      : eventFlags(routine, health.get(wf.id)?.state === "dormant", Number.isFinite(changedAt) ? changedAt : null, now, t)
    out.push(finish(routine))
  }

  return out.sort(compareRoutines).slice(0, ROUTINE_LIMITS.routines)
}

/** Terminal failures in a row from the newest run. In-flight and parked
 *  runs are skipped; a success or cancel ends the streak. */
export function failStreak(outcomes: Array<{ status: RoutineOutcome }>): number {
  let n = 0
  for (const o of outcomes) {
    if (o.status === "running" || o.status === "paused" || o.status === "unknown") continue
    if (o.status === "failed" || o.status === "timeout") n++
    else break
  }
  return n
}

function scheduleFlags(
  r: Routine,
  outcomes: Array<{ at: number; status: RoutineOutcome }>,
  spec: string,
  timezone: string,
  changedAt: number | null,
  now: number,
  t: RoutineThresholds,
  nextFire: NextFire,
): RoutineFlag[] {
  const flags: RoutineFlag[] = []
  const lastAt = outcomes.length ? outcomes[0].at : null
  if (!r.enabled) {
    const disabled = disabledFlag(lastAt, changedAt, now, t)
    if (disabled) flags.push(disabled)
    return flags
  }
  if (r.consecutiveFailures >= t.failStreak) {
    flags.push({ reason: "failing", detail: `${r.consecutiveFailures} failed attempts in a row` })
  }
  if (lastAt === null) {
    flags.push({ reason: "never-ran", detail: "No persisted attempt" })
    return flags
  }
  // Walk the schedule forward from the last attempt: if `missedFires`
  // expected fires have already passed (plus grace), the job has gone quiet.
  let cursor = new Date(lastAt)
  let deadline: Date | null = null
  for (let i = 0; i < t.missedFires; i++) {
    deadline = nextFire(spec, cursor, timezone)
    if (!deadline) break
    cursor = deadline
  }
  if (deadline && now > deadline.getTime() + t.graceMs) {
    flags.push({ reason: "overdue", detail: `No attempt since ${new Date(lastAt).toISOString()}; ${t.missedFires} scheduled fires missed` })
  }
  return flags
}

function eventFlags(
  r: Routine,
  dormant: boolean,
  changedAt: number | null,
  now: number,
  t: RoutineThresholds,
): RoutineFlag[] {
  const flags: RoutineFlag[] = []
  const lastAt = r.lastRun ? Date.parse(r.lastRun.at) : null
  if (!r.enabled) {
    const disabled = disabledFlag(lastAt, changedAt, now, t)
    if (disabled) flags.push(disabled)
    return flags
  }
  if (r.consecutiveFailures >= t.failStreak) {
    flags.push({ reason: "failing", detail: `${r.consecutiveFailures} failed runs in a row` })
  }
  if (lastAt === null) flags.push({ reason: "never-ran", detail: "No run recorded for this trigger" })
  else if (dormant) flags.push({ reason: "dormant", detail: "Fired in the prior week, silent in the last one" })
  return flags
}

function disabledFlag(lastAt: number | null, changedAt: number | null, now: number, t: RoutineThresholds): RoutineFlag | null {
  // Crons carry no "disabled since" timestamp, so the last attempt (or the
  // workflow's last edit) is the best available proxy for how long it sat.
  const since = Math.max(lastAt ?? 0, changedAt ?? 0)
  if (since && now - since < t.disabledDays * DAY) return null
  return {
    reason: "disabled-long",
    detail: since ? `Disabled; no activity for ${Math.floor((now - since) / DAY)} days` : "Disabled and never ran",
  }
}

function finish(r: Routine): Routine {
  const reasons = new Set(r.flags.map((f) => f.reason))
  r.attention = reasons.has("failing") ? "critical"
    : reasons.has("overdue") || reasons.has("dormant") || reasons.has("never-ran") ? "warning"
    : reasons.has("disabled-long") ? "info"
    : null
  return r
}

const ATTENTION_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 }

function compareRoutines(a: Routine, b: Routine): number {
  const ra = a.attention ? ATTENTION_RANK[a.attention] : 3
  const rb = b.attention ? ATTENTION_RANK[b.attention] : 3
  return ra - rb || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)
}

/** Map a workflow run's last recorded status onto the routine vocabulary.
 *  The tail line may be a node execution entry (`ok`), not a run status. */
export function workflowOutcome(status: string): RoutineOutcome {
  switch (status) {
    case "completed": case "ok": return "success"
    case "failed": return "failed"
    case "timeout": return "timeout"
    case "canceled": return "canceled"
    case "running": return "running"
    case "paused": return "paused"
    default: return "unknown"
  }
}

function workflowAgent(wf: RoutineWorkflow): string | null {
  if (wf.ownerAgent) return cap(wf.ownerAgent, ROUTINE_LIMITS.text)
  const node = wf.nodes.find((n) => n.type === "agent" && typeof n.config?.agentId === "string" && n.config.agentId)
  return node ? cap(String(node.config!.agentId), ROUTINE_LIMITS.text) : null
}

/** `filter.action = ["open","reopen"]` → `action=open,reopen`. The workflow's
 *  project scope is a filter too: it silently drops other projects' events. */
export function describeFilters(filter: unknown, wf?: { project?: string }): string[] {
  const out: string[] = []
  const project = wf?.project
  if (project) out.push(cap(`project=${project}`, ROUTINE_LIMITS.filterValue))
  if (filter && typeof filter === "object" && !Array.isArray(filter)) {
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      const values = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)]
      if (!values.length) continue
      out.push(cap(`${key}=${values.join(",")}`, ROUTINE_LIMITS.filterValue))
    }
  }
  return out.slice(0, ROUTINE_LIMITS.filters)
}

function isoOrNull(v: Date | string | null | undefined): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function cap(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit - 3) + "..."
}

function capOpt(value: string | undefined, limit: number): string | undefined {
  return value === undefined ? undefined : cap(value, limit)
}
