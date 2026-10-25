import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import type { BudgetView } from "@/agents/agent-budget"
import { digestDue } from "@/approvals/sweep"
import type { RequestRecord } from "@/requests/store"
import { stalledWhy, when } from "@/requests/loops"
import { readRecentCronRuns } from "./run-history"
import { agentRunTimeout, getNextCronDate } from "./scheduler"

// --- The exceptions digest (#1289) ---
//
// At most one message a day that lists only what is wrong on this node:
//   - schedules whose latest run failed, or that did not run when due;
//   - open requests that are stuck (the requests' own stalled rule);
//   - agents paused by their monthly budget.
// Nothing wrong: nothing is sent. Run files are the source of truth for
// schedule runs; the scheduler's counters reset on reload.
//
// Called every minute from the daemon's sweep. The day it went out and the
// moment it was sent are kept in .agentx/cron/exceptions-digest.json, so a
// restart neither repeats it nor loses the window it covers.

export interface ExceptionsDigestSettings {
  enabled: boolean
  /** Local time, HH:MM. */
  time: string
  timezone?: string
  destination?: { channel: string; chatId: string; accountId?: string }
}

/** The fields of a scheduler job the digest reads. */
export interface DigestJob {
  id: string
  agent: string
  enabled: boolean
  schedule: string
  timezone: string
  timeout: number
  command?: string
}

export interface ScheduleException {
  jobId: string
  agent: string
  kind: "failed" | "missed"
  /** ISO time: when the failed run started, or when the missed run was due. */
  at: string
  detail: string
}

export interface RequestException { id: string; agentId: string; title: string; why: string }
export interface AgentException { agentId: string; why: string }

export interface Exceptions {
  schedules: ScheduleException[]
  requests: RequestException[]
  agents: AgentException[]
}

/** A window never reaches back further than this, however long the daemon was down. */
export const MAX_WINDOW_MS = 7 * 24 * 3_600_000
const DAY_MS = 24 * 3_600_000
/** Extra wait past a run's time limit before an unseen run counts as missed. */
const MISSED_GRACE_MS = 5 * 60_000
/** A run file stamped a little before its slot still counts for it. */
const SLOT_SLACK_MS = 60_000
/** Lines per section; the rest are counted. */
const SECTION_LIMIT = 10
/** Most fire times walked for one job, so an every-minute job stays cheap. */
const MAX_FIRES_WALKED = 3000

/** The latest moment in (from, until] the schedule was due, or null. */
export function lastDueFire(schedule: string, timezone: string, from: number, until: number): Date | null {
  let last: Date | null = null
  let cursor = new Date(from)
  try {
    for (let i = 0; i < MAX_FIRES_WALKED; i++) {
      const next = getNextCronDate(schedule, cursor, timezone)
      if (next.getTime() > until) break
      last = next
      cursor = next
    }
  } catch {
    return last
  }
  return last
}

/** How long a run of `job` may take before it is late. */
function runAllowanceMs(job: DigestJob): number {
  const seconds = job.command?.trim() ? job.timeout : agentRunTimeout(job.timeout)
  return seconds * 1000 + MISSED_GRACE_MS
}

/**
 * Failed and missed schedules since `since`, from the run files.
 *  - failed: the job's latest run started in the window and failed. A job
 *    that failed and then ran fine is not an exception any more.
 *  - missed: an enabled job was due in the window (and long enough ago for
 *    the run to have ended) and no run started at or after that moment. A
 *    job that never ran is skipped, as missed-run detection does: it may
 *    have been created after its slot.
 */
export async function scheduleExceptions(
  jobs: DigestJob[],
  opts: { since: number; now: number; runsDir?: string },
): Promise<ScheduleException[]> {
  if (jobs.length === 0) return []
  const latest = await readRecentCronRuns({ perJob: 1, runsDir: opts.runsDir, jobIds: jobs.map((j) => j.id) })
  const out: ScheduleException[] = []
  for (const job of jobs) {
    const run = latest.get(job.id)?.[0]
    const startedAt = run ? Date.parse(run.startedAt) : NaN
    if (run && run.status !== "success" && startedAt >= opts.since) {
      const why = run.errorSummary?.split("\n")[0]?.slice(0, 160) || (run.status === "timeout" ? "timed out" : "failed")
      out.push({
        jobId: job.id, agent: job.agent, kind: "failed", at: run.startedAt,
        detail: `${run.status === "timeout" ? "timed out" : "failed"}: ${why}${job.enabled ? "" : " (now switched off)"}`,
      })
      continue
    }
    if (!job.enabled || !run) continue
    const due = lastDueFire(job.schedule, job.timezone, opts.since, opts.now - runAllowanceMs(job))
    if (due && startedAt < due.getTime() - SLOT_SLACK_MS) {
      out.push({ jobId: job.id, agent: job.agent, kind: "missed", at: due.toISOString(), detail: "did not run" })
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.jobId.localeCompare(b.jobId))
}

/** Open requests that are stuck, by the requests' own stalled rule, oldest first. */
export function requestExceptions(items: RequestRecord[], staleAfterHours: number, now: number): RequestException[] {
  const out: Array<RequestException & { updatedAt: number }> = []
  for (const r of items) {
    const why = stalledWhy(r, staleAfterHours, now)
    if (!why) continue
    const title = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
    out.push({ id: r.id, agentId: r.agentId, title: title.length > 80 ? `${title.slice(0, 79)}…` : title, why, updatedAt: r.updatedAt })
  }
  return out.sort((a, b) => a.updatedAt - b.updatedAt).map(({ updatedAt: _, ...e }) => e)
}

/** Agents, Wall projects (#1301) and the whole fleet paused by their monthly budget. */
export function pausedAgents(view: Pick<BudgetView, "agents" | "fleet"> & Partial<Pick<BudgetView, "projects">>): AgentException[] {
  const usd = (n: number) => `$${n.toFixed(2)}`
  const out: AgentException[] = []
  if (view.fleet.state === "paused" && view.fleet.capUsd) {
    out.push({ agentId: "every agent", why: `fleet budget used (${usd(view.fleet.spentUsd)} of ${usd(view.fleet.capUsd)})` })
  }
  for (const row of view.projects ?? []) {
    if (row.state !== "paused" || !row.capUsd) continue
    out.push({ agentId: `project ${row.name}`, why: `project budget used (${usd(row.spentUsd)} of ${usd(row.capUsd)})` })
  }
  for (const row of view.agents) {
    if (row.state !== "paused" || !row.capUsd) continue
    out.push({ agentId: row.agentId, why: `monthly budget used (${usd(row.spentUsd)} of ${usd(row.capUsd)})` })
  }
  return out
}

export function isEmpty(ex: Exceptions): boolean {
  return ex.schedules.length === 0 && ex.requests.length === 0 && ex.agents.length === 0
}

function section<T>(title: string, items: T[], line: (item: T) => string): string[] {
  if (items.length === 0) return []
  const lines = [`${title} (${items.length})`, ...items.slice(0, SECTION_LIMIT).map((i) => `- ${line(i)}`)]
  if (items.length > SECTION_LIMIT) lines.push(`- and ${items.length - SECTION_LIMIT} more`)
  return lines
}

/** The digest's words, or null when nothing is wrong. */
export function exceptionsDigestText(ex: Exceptions, opts: { node?: string; dashboardUrl?: string } = {}): string | null {
  if (isEmpty(ex)) return null
  const lines = [`Needs a look${opts.node ? ` on ${opts.node}` : ""}:`]
  lines.push(...section("Schedules", ex.schedules, (s) =>
    s.kind === "missed"
      ? `${s.jobId} (${s.agent}): due ${when(Date.parse(s.at))}, did not run`
      : `${s.jobId} (${s.agent}): ${when(Date.parse(s.at))}, ${s.detail}`))
  lines.push(...section("Stuck requests", ex.requests, (r) => `${r.title} (${r.agentId}): ${r.why}`))
  lines.push(...section("Paused agents", ex.agents, (a) => `${a.agentId}: ${a.why}`))
  lines.push(opts.dashboardUrl
    ? `Details: ${opts.dashboardUrl.replace(/\/$/, "")} (Operations), or run: agentx schedule list`
    : "Details: Operations in the dashboard, or run: agentx schedule list")
  return lines.join("\n")
}

interface DigestState {
  /** Local date (YYYY-MM-DD) of the last digest considered. */
  lastDigest?: string
  /** ISO time of the last check; the next digest covers what came after. */
  checkedAt?: string
}

export function digestStateFile(root: string): string {
  return resolve(root, ".agentx/cron/exceptions-digest.json")
}

function readState(file: string): DigestState {
  try {
    if (!existsSync(file)) return {}
    const v = JSON.parse(readFileSync(file, "utf-8"))
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

function writeState(file: string, state: DigestState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2))
}

/** Start of the window a digest covers: since the last check, and at
 *  least the last day, at most the last week. */
export function windowStart(checkedAt: string | undefined, now: number): number {
  const last = checkedAt ? Date.parse(checkedAt) : NaN
  const since = Number.isFinite(last) ? Math.min(last, now - DAY_MS) : now - DAY_MS
  return Math.max(since, now - MAX_WINDOW_MS)
}

export interface ExceptionsDigestDeps {
  settings: ExceptionsDigestSettings
  /** Used when settings.destination is unset (notifications.destination). */
  fallbackDestination?: { channel: string; chatId: string; accountId?: string }
  /** Directory that holds .agentx (the daemon's working directory). */
  root: string
  runsDir?: string
  jobs: () => DigestJob[]
  /** Open requests and their stale time; absent when requests are off. */
  requests?: () => { items: RequestRecord[]; staleAfterHours: number }
  budget?: () => Pick<BudgetView, "agents" | "fleet"> & Partial<Pick<BudgetView, "projects">>
  send: (dest: { channel: string; chatId: string; accountId?: string }, text: string) => Promise<void>
  node?: string
  dashboardUrl?: string
  now?: number
  log: (msg: string) => void
}

export type ExceptionsDigestResult = "sent" | "not-due" | "empty" | "no-destination" | "disabled" | "failed"

/** Gather everything that is wrong now. Each source is isolated: one that
 *  throws is logged and the others still report. */
export async function collectExceptions(deps: Omit<ExceptionsDigestDeps, "send" | "settings" | "root">, since: number, now: number): Promise<Exceptions> {
  const ex: Exceptions = { schedules: [], requests: [], agents: [] }
  try {
    ex.schedules = await scheduleExceptions(deps.jobs(), { since, now, runsDir: deps.runsDir })
  } catch (e: any) { deps.log(`[exceptions] schedules not read: ${e?.message ?? e}`) }
  try {
    const r = deps.requests?.()
    if (r) ex.requests = requestExceptions(r.items, r.staleAfterHours, now)
  } catch (e: any) { deps.log(`[exceptions] requests not read: ${e?.message ?? e}`) }
  try {
    const b = deps.budget?.()
    if (b) ex.agents = pausedAgents(b)
  } catch (e: any) { deps.log(`[exceptions] budgets not read: ${e?.message ?? e}`) }
  return ex
}

/** Send the day's exceptions digest when it is due and something is wrong. */
export async function runExceptionsDigest(deps: ExceptionsDigestDeps): Promise<ExceptionsDigestResult> {
  const { settings, log } = deps
  if (!settings.enabled) return "disabled"
  const now = deps.now ?? Date.now()
  const file = digestStateFile(deps.root)
  const state = readState(file)
  const { due, date } = digestDue(settings, state.lastDigest, now)
  if (!due) return "not-due"
  const dest = settings.destination ?? deps.fallbackDestination
  if (!dest) return "no-destination"
  const ex = await collectExceptions(deps, windowStart(state.checkedAt, now), now)
  // Recorded before the send, like the approvals digest: a send that hangs
  // or fails must not turn into one message a minute.
  writeState(file, { lastDigest: date, checkedAt: new Date(now).toISOString() })
  const text = exceptionsDigestText(ex, { node: deps.node, dashboardUrl: deps.dashboardUrl })
  if (!text) {
    log("[exceptions] digest: nothing wrong, nothing sent")
    return "empty"
  }
  try {
    await deps.send(dest, text)
    log(`[exceptions] digest sent: ${ex.schedules.length} schedule(s), ${ex.requests.length} request(s), ${ex.agents.length} agent(s)`)
    return "sent"
  } catch (e: any) {
    log(`[exceptions] digest failed: ${e?.message ?? e}`)
    return "failed"
  }
}
