// --- The shell's Automations, as data (#2226 S5) ---
//
// What runs on its own, per machine: the scheduled jobs (`crons.*`) and the
// workflows a schedule or an event starts, with their last run and the
// strip of their last seven. Read from the same reply the old Hub's
// Schedules page reads (`GET /api/live?quick=1`, buildLiveSnapshot in
// src/daemon/board-dashboard.ts): each node's `crons`, `cronRuns` and
// `routines` (src/daemon/routines.ts). Nothing new on the server.
//
// Plain data and pure functions, so the tests check them without a browser.

import { wsProject } from "../daemon/ui/pages/wall-schedules"

/** Where the list is read: every machine, quick (a slow one says "checking"). */
export const AUTOMATIONS_URL = "/api/live?quick=1"
/** The old Hub's Schedules page: sensors, host jobs, the day's totals. */
export const SCHEDULES_PAGE = "#status=open&view=jobs"

/** The part of a node's routine row the shell draws (Routine in routines.ts). */
export interface LiveRoutine {
  id: string
  source: "cron" | "workflow"
  kind: "schedule" | "event"
  name: string
  trigger: { schedule?: string; timezone?: string; event?: string }
  agent: string | null
  enabled: boolean
  state: string
  nextRunAt: string | null
  lastRun: { at: string; status: string; summary?: string } | null
  consecutiveFailures: number
  flags?: { reason: string; detail: string }[]
  recent?: { at: string; status: string }[]
}

/** The part of a node's cron job the shell draws (NodeLive.crons). */
export interface LiveCron {
  id: string
  enabled: boolean
  schedule: string
  timezone?: string
  agent: string
  nextRun?: string
  consecutiveErrors?: number
  value?: { why?: string; metric?: string } | null
  home?: string
  goal?: string
}

export interface LiveCronRun { jobId: string; startedAt: string; status: string; responseSummary?: string; errorSummary?: string }

export interface LiveNode {
  name: string
  url?: string
  reachable?: boolean
  error?: string
  checking?: boolean
  stale?: boolean
  staleSince?: string
  crons?: LiveCron[]
  cronRuns?: LiveCronRun[]
  routines?: LiveRoutine[]
}

export interface LiveReply { nodes?: LiveNode[] }

export type RunTone = "ok" | "err" | "idle" | "work"

export interface AutomationRun { status: string; at: number | null; summary: string }

/** One row of the list: a scheduled job or a workflow that starts on its own. */
export interface Automation {
  /** `cron:<job>` or `workflow:<id>`, as routines.ts names them. */
  id: string
  source: "cron" | "workflow"
  name: string
  agent: string | null
  /** What starts it: a schedule (`when` is a cron expression) or an event. */
  starts: "schedule" | "event"
  /** The cron expression, or the event that starts it. */
  when: string
  timezone?: string
  enabled: boolean
  /** The workflow's state when it is not just on or off (quarantined). */
  state: string
  nextRunAt: number | null
  last: AutomationRun | null
  /** The last seven runs, oldest first. */
  recent: string[]
  /** Why it looks stale or failing, in words; empty when it is fine. */
  flags: string[]
  /** The same flags as codes (overdue, dormant, failing, never-ran...): the badge reads these. */
  reasons: string[]
  /** What it is for, when the job says. */
  why: string
  project: { label: string; href: string }
}

export type NodeState = "ok" | "checking" | "down" | "stale"

export interface AutomationGroup { node: string; state: NodeState; staleSince?: string; rows: Automation[] }

const ms = (s: string | null | undefined): number | null => {
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) ? t : null
}

/** How a machine answered: stale (last good data shown), checking, down, or fine. */
export function nodeState(n: LiveNode): NodeState {
  if (n.stale) return "stale"
  if (n.checking) return "checking"
  if (n.reachable === false || n.error) return "down"
  return "ok"
}

/** A machine's rows: its jobs (with their routine's verdict when the node
 *  reports one), then the workflows a schedule or an event starts. */
export function nodeAutomations(n: LiveNode): Automation[] {
  const routines = new Map((n.routines ?? []).filter((r) => r && r.id).map((r) => [r.id, r]))
  const runs = n.cronRuns ?? []
  const jobs = (n.crons ?? []).filter((j) => j && j.id).map((j): Automation => {
    const r = routines.get("cron:" + j.id)
    const lastRun = runs.find((x) => x.jobId === j.id)
    const last: AutomationRun | null = r?.lastRun
      ? { status: r.lastRun.status, at: ms(r.lastRun.at), summary: r.lastRun.summary || lastRun?.errorSummary || lastRun?.responseSummary || "" }
      : lastRun ? { status: lastRun.status, at: ms(lastRun.startedAt), summary: lastRun.errorSummary || lastRun.responseSummary || "" } : null
    const flags = (r?.flags ?? []).map((f) => f.detail || f.reason)
    const fails = Math.max(j.consecutiveErrors ?? 0, r?.consecutiveFailures ?? 0)
    const reasons = (r?.flags ?? []).map((f) => f.reason)
    if (fails >= 3 && !flags.some((f) => /fail/i.test(f))) flags.push(`failed ${fails} times in a row`)
    if (fails >= 3 && !reasons.includes("failing")) reasons.push("failing")
    return {
      id: "cron:" + j.id,
      source: "cron",
      name: j.id,
      agent: j.agent || null,
      starts: "schedule",
      when: j.schedule,
      ...(j.timezone ? { timezone: j.timezone } : {}),
      enabled: !!j.enabled,
      state: j.enabled ? "enabled" : "disabled",
      nextRunAt: j.enabled ? ms(j.nextRun ?? r?.nextRunAt) : null,
      last,
      recent: (r?.recent ?? []).slice().reverse().map((x) => x.status),
      flags,
      reasons,
      why: j.value?.why ? String(j.value.why) : "",
      project: wsProject(j),
    }
  })
  const flows = (n.routines ?? []).filter((r) => r && r.source === "workflow").map((r): Automation => ({
    id: r.id,
    source: "workflow",
    name: r.name || r.id.replace(/^workflow:/, ""),
    agent: r.agent,
    starts: r.kind === "event" ? "event" : "schedule",
    when: r.kind === "event" ? (r.trigger.event || "an event") : (r.trigger.schedule || ""),
    ...(r.trigger.timezone ? { timezone: r.trigger.timezone } : {}),
    enabled: !!r.enabled,
    state: r.state,
    nextRunAt: r.enabled ? ms(r.nextRunAt) : null,
    last: r.lastRun ? { status: r.lastRun.status, at: ms(r.lastRun.at), summary: r.lastRun.summary || "" } : null,
    recent: (r.recent ?? []).slice().reverse().map((x) => x.status),
    flags: (r.flags ?? []).map((f) => f.detail || f.reason),
    reasons: (r.flags ?? []).map((f) => f.reason),
    why: "",
    project: { label: "", href: "" },
  }))
  return [...jobs, ...flows]
}

/** Every machine with its rows, in the order the snapshot lists them. */
export function automationGroups(reply: LiveReply | null | undefined): AutomationGroup[] {
  const nodes = Array.isArray(reply?.nodes) ? reply!.nodes : []
  return nodes.filter((n) => n && n.name).map((n) => ({
    node: n.name,
    state: nodeState(n),
    ...(n.stale && n.staleSince ? { staleSince: n.staleSince } : {}),
    rows: nodeAutomations(n),
  }))
}

/** True while a machine is still answering: the pane asks again soon. */
export function automationsPending(reply: LiveReply | null | undefined): boolean {
  return (reply?.nodes ?? []).some((n) => n && n.checking)
}

/** A run's outcome in a word, as the old Schedules page says it. */
export function runWord(status: string): string {
  switch (status) {
    case "success": return "Worked"
    case "failed": return "Failed"
    case "timeout": return "Timed out"
    case "missed": return "Missed"
    case "held": return "Held, retry waiting"
    case "skipped": return "Skipped, nothing to do"
    case "canceled": return "Canceled"
    case "running": return "Running"
    case "paused": return "Paused"
    default: return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown"
  }
}

/** A run's tone: worked is ok, failed / timed out / missed is err. */
export function runTone(status: string): RunTone {
  if (status === "success") return "ok"
  if (status === "failed" || status === "timeout" || status === "missed") return "err"
  if (status === "running") return "work"
  return "idle"
}

/** The row's own state: off, quarantined, failing, stale, not run yet, or on.
 *  Off wins. Only an overdue or dormant flag reads as stale; a job that never
 *  ran is new, not stale, so it gets a neutral label. */
export function automationStatus(a: Automation): { label: string; tone: "ok" | "warn" | "err" | "idle" } {
  if (!a.enabled) return { label: a.state === "quarantined" ? "Quarantined" : "Off", tone: a.state === "quarantined" ? "err" : "idle" }
  if (a.last && runTone(a.last.status) === "err") return { label: "Last run failed", tone: "err" }
  if (a.reasons.includes("failing")) return { label: "Failing", tone: "err" }
  if (a.reasons.includes("overdue") || a.reasons.includes("dormant")) return { label: "Looks stale", tone: "warn" }
  if (!a.last && a.reasons.includes("never-ran")) return { label: "Not run yet", tone: "idle" }
  return { label: "On", tone: "ok" }
}

/** The figures above the list. */
export function automationTotals(groups: AutomationGroup[]): { total: number; on: number; failed: number; stale: number } {
  const rows = groups.flatMap((g) => g.rows)
  const st = rows.map(automationStatus)
  return {
    total: rows.length,
    on: rows.filter((r) => r.enabled).length,
    failed: st.filter((s) => s.label === "Last run failed" || s.label === "Failing").length,
    stale: st.filter((s) => s.label === "Looks stale").length,
  }
}

/** "in 5m", "in 3h", "in 2d": how long until, short. */
export function shortUntil(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return "in " + Math.floor(s / 60) + "m"
  if (s < 86400) return "in " + Math.floor(s / 3600) + "h"
  return "in " + Math.floor(s / 86400) + "d"
}
