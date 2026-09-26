import cronstrue from "cronstrue"
import { applyConfigMutation, getAtPath, setAtPath, unsetAtPath, type MutationResult } from "@/daemon/config-mutator"
import type { NlCronResult } from "@/utils/nl-cron"
import { getNextCronDate } from "./scheduler"

// --- Shared schedule operations ---
//
// One code path for everything that writes a `crons.<id>` entry from a
// natural-language schedule: the `agentx schedule` CLI and the agent-facing
// `agentx_schedule` MCP tool both build jobs here, so the two can never
// drift into writing different shapes.
//
// Also owns the operator side of the approval flow (approve / reject), which
// only the CLI exposes. Agents can request; they cannot approve.

export type OnErrorValue = "log" | "notify" | "disable"

export interface NotifyTarget {
  channel: string
  chatId: string
  accountId?: string
}

export interface ScheduleApproval {
  action: "create" | "delete"
  requestedBy: string
  requestedAt: string
}

/** Default timezone for schedules created without one. Kept identical to the
 *  CLI's historical `--timezone` default. */
export const DEFAULT_SCHEDULE_TIMEZONE = "Africa/Tunis"
export const DEFAULT_SCHEDULE_TIMEOUT = 600

export const SUPPORTED_PHRASES_HINT =
  'Try: "every morning at 9", "weekdays at 6pm", "every 15 minutes", "every monday at 10am", ' +
  '"1st of every month at noon", "daily at 9:30am", "every hour"'

/** Cron ids become a dot-path segment (`crons.<id>`), so dots and other
 *  separators are refused rather than silently nesting the config. */
const SCHEDULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isValidScheduleId(id: string): boolean {
  return SCHEDULE_ID_RE.test(id)
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function parseOnError(flag: string | undefined): OnErrorValue[] {
  if (!flag) return ["log"]
  return flag
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is OnErrorValue => s === "log" || s === "notify" || s === "disable")
}

export interface ScheduleJobInput {
  parsed: NlCronResult
  agent: string
  prompt: string
  timezone?: string
  timeout?: number
  model?: string
  notify?: NotifyTarget
  onError?: OnErrorValue[]
  enabled?: boolean
  createdBy?: string
  approval?: ScheduleApproval
}

/** Build the `crons.<id>` object. A notify target implies the "notify"
 *  error mode, exactly as the CLI always did. */
export function buildScheduleJob(input: ScheduleJobInput): Record<string, unknown> {
  const onError = [...(input.onError ?? ["log"])]
  if (input.notify && !onError.includes("notify")) onError.push("notify")

  const job: Record<string, unknown> = {
    enabled: input.enabled ?? true,
    schedule: input.parsed.cron,
    timezone: input.timezone || DEFAULT_SCHEDULE_TIMEZONE,
    agent: input.agent,
    prompt: input.prompt,
    timeout: input.timeout ?? DEFAULT_SCHEDULE_TIMEOUT,
    onError,
  }
  if (input.model) job.model = input.model
  if (input.notify) job.notify = input.notify
  if (input.createdBy) job.createdBy = input.createdBy
  if (input.approval) job.approval = input.approval
  return job
}

export function humanizeCron(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: false })
  } catch {
    return cron
  }
}

export function nextFireTime(cron: string, timezone: string, now: Date = new Date()): Date | null {
  try {
    return getNextCronDate(cron, now, timezone)
  } catch {
    return null
  }
}

/** "Mon, 28 Sep 2026, 10:00 (<tz>)" — the wall-clock time where the job
 *  runs, which is what an operator reading an approval request cares about. */
export function formatFireTime(d: Date | null, timezone: string): string {
  if (!d) return "unknown (no match within a year)"
  try {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d)
    return `${local} (${timezone})`
  } catch {
    return d.toISOString()
  }
}

export function isPendingCreate(job: any): boolean {
  return job?.approval?.action === "create"
}

// ── Operator approval ────────────────────────────────────────────────

export interface ApprovalOutcome {
  success: boolean
  /** What happened, for the CLI to print. */
  message: string
  result?: MutationResult
}

/**
 * Apply a pending agent request. `create` → enable and clear the marker;
 * `delete` → remove the job. Hot-reloads the daemon through the same
 * mutator the CLI uses.
 */
export async function approveSchedule(
  id: string,
  opts: { configPath?: string; reload?: boolean } = {},
): Promise<ApprovalOutcome> {
  let message = ""
  const result = await applyConfigMutation((cfg) => {
    const job: any = getAtPath(cfg, `crons.${id}`)
    if (!job) throw new Error(`cron "${id}" not found`)
    const approval = job.approval as ScheduleApproval | undefined
    if (!approval) throw new Error(`cron "${id}" has no pending request`)
    if (approval.action === "create") {
      delete job.approval
      job.enabled = true
      message = `${id} approved and enabled (requested by ${approval.requestedBy})`
    } else {
      unsetAtPath(cfg, `crons.${id}`)
      message = `${id} deletion approved; job removed (requested by ${approval.requestedBy})`
    }
  }, { configPath: opts.configPath, reload: opts.reload })
  if (!result.success) return { success: false, message: result.error || "failed", result }
  return { success: true, message, result }
}

/** Refuse a pending request. `create` → drop the never-run job; `delete` →
 *  keep the job exactly as it was and clear the marker. */
export async function rejectSchedule(
  id: string,
  opts: { configPath?: string; reload?: boolean } = {},
): Promise<ApprovalOutcome> {
  let message = ""
  const result = await applyConfigMutation((cfg) => {
    const job: any = getAtPath(cfg, `crons.${id}`)
    if (!job) throw new Error(`cron "${id}" not found`)
    const approval = job.approval as ScheduleApproval | undefined
    if (!approval) throw new Error(`cron "${id}" has no pending request`)
    if (approval.action === "create") {
      unsetAtPath(cfg, `crons.${id}`)
      message = `${id} rejected; pending job removed`
    } else {
      delete job.approval
      message = `${id} deletion rejected; job kept`
    }
  }, { configPath: opts.configPath, reload: opts.reload })
  if (!result.success) return { success: false, message: result.error || "failed", result }
  return { success: true, message, result }
}

/** Enable/disable, refusing to enable a job still awaiting approval. */
export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
  opts: { configPath?: string; reload?: boolean } = {},
): Promise<MutationResult> {
  return applyConfigMutation((cfg) => {
    const job: any = getAtPath(cfg, `crons.${id}`)
    if (!job) throw new Error(`cron "${id}" not found`)
    if (enabled && isPendingCreate(job)) {
      throw new Error(`cron "${id}" is awaiting approval; run \`agentx schedule approve ${id}\``)
    }
    setAtPath(cfg, `crons.${id}.enabled`, enabled)
  }, { configPath: opts.configPath, reload: opts.reload })
}
