import cronstrue from "cronstrue"
import type Database from "better-sqlite3"
import { applyConfigMutation, getAtPath, setAtPath, unsetAtPath, type MutationResult } from "@/daemon/config-mutator"
import type { NlCronResult } from "@/utils/nl-cron"
import { getNextCronDate } from "./scheduler"
import { rootOfConfig } from "./goal-state"
import { retiredRefusalAt } from "./retired"
import { withdrawGoalCards } from "./goal-card"
import { writeLedgerRow } from "./change-ledger"

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
  action: "create" | "delete" | "change"
  requestedBy: string
  requestedAt: string
  /** change (#863): the new time, which fires more often than the approved one. */
  schedule?: string
  reason?: string
}

/** Default timezone for schedules created without one: this machine's, the
 *  same as the CLI's `--timezone` default. */
export const DEFAULT_SCHEDULE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
export const DEFAULT_SCHEDULE_TIMEOUT = 600

export const SUPPORTED_PHRASES_HINT =
  'Try: "every morning at 9", "weekdays at 6pm", "every 15 minutes", "every monday at 10am", ' +
  '"1st of every month at noon", "daily at 9:30am", "every hour"; once: "tomorrow at 9:05", ' +
  '"once on 20 november at 09:05", "2026-11-20T09:05"; or a raw cron "5 9 20 11 *"'

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
  /** False keeps `notify` for failure alerts only. Default: each
   *  successful run's answer is sent there too. */
  deliverResult?: boolean
  /** `exceptions`: a run with nothing wrong sends nothing (#1289). */
  report?: "always" | "exceptions"
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
  if (input.parsed.runAt) job.runAt = input.parsed.runAt
  if (input.model) job.model = input.model
  if (input.notify) job.notify = input.notify
  if (input.notify && input.deliverResult === false) job.deliverResult = false
  if (input.report === "exceptions") job.report = "exceptions"
  if (input.createdBy) job.createdBy = input.createdBy
  if (input.approval) job.approval = input.approval
  return job
}

/** Channels whose chat ids never hold ":", so a third segment is the account (#2005). */
const ACCOUNT_SUFFIX_CHANNELS = new Set(["telegram", "whatsapp"])

/** Parse `--notify channel:chatId[:accountId]`. The first segment is the
 *  channel; other channels' chat ids can hold ":" ("app:<id>", gitlab
 *  "org/repo:issue:1"), so for them the whole rest is the chat id (#2005). */
export function parseNotifyFlag(flag: string): NotifyTarget | null {
  const i = flag.indexOf(":")
  if (i <= 0 || i === flag.length - 1) return null
  const channel = flag.slice(0, i)
  const rest = flag.slice(i + 1)
  if (!ACCOUNT_SUFFIX_CHANNELS.has(channel)) return { channel, chatId: rest }
  const [chatId, accountId] = rest.split(":")
  if (!chatId) return null
  return accountId ? { channel, chatId, accountId } : { channel, chatId }
}

/** True for a saved notify target in the shape the old parser wrote for
 *  app chats: chatId "app" with the id moved into accountId (#2005). */
export function isBrokenAppNotify(notify: { channel?: string; chatId?: string } | undefined): boolean {
  return notify?.channel === "app" && !String(notify.chatId ?? "").startsWith("app:")
}

/** What a job's `notify` destination receives, as `schedule list` prints it. */
export function notifyScope(job: { deliverResult?: boolean; report?: string }): string {
  if (job.deliverResult === false) return "(failures only)"
  return job.report === "exceptions" ? "(exceptions and failures)" : "(results and failures)"
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
  opts: { configPath?: string; reload?: boolean; ledger?: () => Database.Database | null } = {},
): Promise<ApprovalOutcome> {
  let message = ""
  let changed: { old: string; new: string; by: string; reason?: string } | null = null
  let removed = false
  const result = await applyConfigMutation((cfg) => {
    const job: any = getAtPath(cfg, `crons.${id}`)
    if (!job) throw new Error(`cron "${id}" not found`)
    const approval = job.approval as ScheduleApproval | undefined
    if (!approval) throw new Error(`cron "${id}" has no pending request`)
    if (approval.action === "create") {
      delete job.approval
      job.enabled = true
      message = `${id} approved and enabled (requested by ${approval.requestedBy})`
    } else if (approval.action === "change") {
      // A time that fires more often (#863): now the approved one.
      if (!approval.schedule) throw new Error(`cron "${id}" has a change request with no time`)
      changed = { old: String(job.schedule), new: approval.schedule, by: approval.requestedBy, reason: approval.reason }
      delete job.approval
      job.schedule = approval.schedule
      job.approvedSchedule = approval.schedule
      message = `${id} time change approved: ${approval.schedule} (requested by ${approval.requestedBy})`
    } else {
      unsetAtPath(cfg, `crons.${id}`)
      removed = true
      message = `${id} deletion approved; job removed (requested by ${approval.requestedBy})`
    }
  }, { configPath: opts.configPath, reload: opts.reload })
  if (!result.success) return { success: false, message: result.error || "failed", result }
  // A deleted job's goal card never expires: withdraw it (#863, n158092).
  if (removed) withdrawGoalCards(rootOfConfig(opts.configPath), id, "was deleted")
  if (changed) {
    const c: { old: string; new: string; by: string; reason?: string } = changed
    writeLedgerRow(rootOfConfig(opts.configPath), { job: id, field: "time", old: c.old, new: c.new, by: c.by, reason: c.reason ?? "approved by the operator", at: Date.now() }, opts.ledger)
  }
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
      message = approval.action === "change" ? `${id} time change rejected; job keeps ${job.schedule}` : `${id} deletion rejected; job kept`
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
    const retired = enabled ? retiredRefusalAt(rootOfConfig(opts.configPath), id, job) : null
    if (retired) throw new Error(retired)
    setAtPath(cfg, `crons.${id}.enabled`, enabled)
  }, { configPath: opts.configPath, reload: opts.reload })
}
