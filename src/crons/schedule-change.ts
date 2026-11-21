import type Database from "better-sqlite3"
import { applyConfigMutation, getAtPath } from "@/daemon/config-mutator"
import { parseEnglishToCron } from "@/utils/nl-cron"
import { cronValueSchema } from "./value-line"
import { ledgerText, writeLedgerRow, type CronChangeField } from "./change-ledger"
import { firesMoreOften } from "./fire-count"
import { addNote, GOAL_CHOICES, jobGoalState, readCronGoalState, updateJobGoalState, type GoalChoice } from "./goal-state"
import { endJobInConfig, retiredRefusalAt } from "./retired"
import { humanizeCron, isPendingCreate, SUPPORTED_PHRASES_HINT, type ScheduleApproval } from "./schedule-ops"

// --- The owner's own changes to its schedule (#863) ---
//
// Three actions of the agent's `agentx_schedule` tool, for a job's owner
// (its `agent`), its creator or an admin agent:
//
//   recommend  the owner's keep / change / drop for its job's goal card,
//              only while the daemon is waiting for it (askedAt set, no
//              card yet). Only the owner itself.
//   change     brief (prompt), time (when), goal or value, with a reason.
//              Each change is a ledger row. A time that fires more often
//              than the approved one over 31 days (in the job's timezone)
//              is a request the operator approves. While the job is on goal
//              check, goal and value are refused: only the operator's answer
//              moves it.
//   retire     ends the job for good (enabled false, endedAt), with a reason.
//
// A brief, time, goal or value row, or a retire, from the owner pays off a
// change the operator asked for (changeOwed). A pause does not.

export interface ChangeContext {
  id: string
  job: any
  caller: { agentId: string }
  root: string
  configPath?: string
  reload?: boolean
  now: Date
  ledger?: () => Database.Database | null
  /** Tell the operator about a request; returns what to tell the agent. */
  notifyApproval: (text: string) => Promise<string>
}

const WHY_MAX = 200
const REASON_MAX = 500
const GOAL_ID_RE = /^[a-z0-9][\w.:-]*$/i

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const day = (s: string | undefined) => (s ? s.slice(0, 10) : "?")

export function recommendAction(args: Record<string, unknown>, c: ChangeContext): string {
  if (c.job.agent !== c.caller.agentId) return `Not allowed: only the job's owner (agent "${c.job.agent}") recommends on its goal check.`
  const choice = str(args.choice)?.toLowerCase() as GoalChoice | undefined
  if (!choice || !GOAL_CHOICES.includes(choice)) return 'Error: recommend needs `choice`: "keep", "change" or "drop".'
  const why = str(args.why)?.replace(/\s+/g, " ")
  if (!why) return "Error: recommend needs `why`: one line."
  if (why.length > WHY_MAX) return `Error: \`why\` is longer than ${WHY_MAX} characters.`
  let refusal: string | null = null
  try {
    updateJobGoalState(c.root, c.id, (s) => {
      const g = s.goalCheck
      if (!g || g.reason === "drop-answered" || !g.askedAt) refusal = `"${c.id}" is not waiting for a recommendation: it is not on goal check.`
      else if (g.cardId) refusal = `The card for "${c.id}" is already raised (${g.cardId}); the operator decides there.`
      else g.recommend = { choice, why, at: c.now.toISOString() }
    })
  } catch (e: any) {
    return `Error: could not record it: ${e?.message ?? e}`
  }
  if (refusal) return refusal
  return `Recorded your recommendation for "${c.id}": ${choice}. The card goes to the operator when this turn ends.`
}

/** The owner wrote a change that pays off changeOwed: clear it. */
function payChangeOwed(c: ChangeContext): void {
  if (c.job.agent !== c.caller.agentId) return
  try {
    updateJobGoalState(c.root, c.id, (s) => { delete s.changeOwed })
  } catch { /* the next fire reads the ledger row and clears it */ }
}

function row(c: ChangeContext, field: CronChangeField, old: unknown, next: unknown, reason: string): void {
  writeLedgerRow(c.root, { job: c.id, field, old: ledgerText(old), new: ledgerText(next), by: c.caller.agentId, reason, at: c.now.getTime() }, c.ledger)
}

/** "brief copied from held job <id>": another job of the same owner on
 *  goal check has this exact brief. */
function copiedFromHeld(c: ChangeContext, prompt: string, crons: Record<string, any>): void {
  try {
    const held = readCronGoalState(c.root).jobs
    const from = Object.keys(crons).find((other) => other !== c.id && crons[other]?.agent === c.job.agent && held[other]?.goalCheck && String(crons[other]?.prompt ?? "").trim() === prompt)
    if (from) updateJobGoalState(c.root, c.id, (s) => { addNote(s, "brief-copied", `brief copied from held job ${from}`, c.now.toISOString()) })
  } catch { /* a Wall hint only */ }
}

export async function changeAction(args: Record<string, unknown>, c: ChangeContext, crons: Record<string, any>): Promise<string> {
  const { id, job } = c
  const reason = str(args.reason)
  if (!reason) return "Error: change needs `reason`: why you make it (it goes in the job's change log)."
  if (reason.length > REASON_MAX) return `Error: \`reason\` is longer than ${REASON_MAX} characters.`
  if (isPendingCreate(job)) return `"${id}" is still awaiting operator approval; change the request by withdrawing it and asking again.`
  const retired = retiredRefusalAt(c.root, id, job)
  if (retired) return retired
  const prompt = str(args.prompt)
  const when = str(args.when)
  const goal = str(args.goal)
  const value = args.value
  if (!prompt && !when && !goal && value === undefined) return "Error: change needs at least one of `prompt`, `when`, `goal` or `value`."
  const g = jobGoalState(c.root, id).goalCheck
  if (g && (goal || value !== undefined)) {
    return `"${id}" is on goal check since ${day(g.since)}; only the operator's answer${g.cardId ? ` on card ${g.cardId}` : ""} changes its goal or value. You may pause it, or retire it with a reason.`
  }
  if (goal && (goal.length > 80 || !GOAL_ID_RE.test(goal))) return "Error: `goal` must be a goal record id: letters, digits, dashes, dots or colons."
  let parsedValue: unknown
  if (value !== undefined) {
    const v = cronValueSchema.safeParse(value)
    if (!v.success) return `Error: \`value\` must be {why, metric, number?}: ${v.error.issues[0]?.message ?? "invalid"}.`
    parsedValue = v.data
  }
  const tz = job.timezone || "UTC"
  let cron: string | undefined
  let request: { cron: string; counts: { next: number; approved: number } } | null = null
  if (when) {
    const parsed = parseEnglishToCron(when, { now: c.now, timezone: tz })
    if (!parsed) return `Error: couldn't parse "${when}". ${SUPPORTED_PHRASES_HINT}.`
    if (parsed.runAt) return "Error: a change cannot make a recurring job one-time; retire it and request a new one."
    if (parsed.cron !== job.schedule) {
      const approved = job.approvedSchedule || job.schedule
      const more = firesMoreOften(parsed.cron, approved, tz, c.now.getTime())
      if (more.more) {
        if (job.approval) return `"${id}" already has a ${job.approval.action} request waiting for the operator.`
        request = { cron: parsed.cron, counts: more }
      } else cron = parsed.cron
    }
  }
  const result = await applyConfigMutation((cfg) => {
    const j: any = getAtPath(cfg, `crons.${id}`)
    if (!j) throw new Error(`schedule "${id}" not found`)
    if (prompt) j.prompt = prompt
    if (goal) j.goal = goal
    if (parsedValue) j.value = parsedValue
    if (cron) {
      // The approved time stays the bar a later change is measured against.
      j.approvedSchedule = j.approvedSchedule || j.schedule
      j.schedule = cron
    }
    if (request) {
      const approval: ScheduleApproval = { action: "change", requestedBy: c.caller.agentId, requestedAt: c.now.toISOString(), schedule: request.cron, reason }
      j.approval = approval
    }
  }, { configPath: c.configPath, reload: c.reload })
  if (!result.success) return `Error: ${result.error}`
  const done: string[] = []
  if (prompt && prompt !== job.prompt) { row(c, "brief", job.prompt, prompt, reason); done.push("brief"); copiedFromHeld(c, prompt, crons) }
  if (goal && goal !== job.goal) { row(c, "goal", job.goal, goal, reason); done.push(`goal → ${goal}`) }
  if (parsedValue) { row(c, "value", job.value, parsedValue, reason); done.push("value") }
  if (cron) { row(c, "time", job.schedule, cron, reason); done.push(`time → ${humanizeCron(cron)} (${cron})`) }
  if (done.length) payChangeOwed(c)
  const lines = [done.length ? `Changed "${id}": ${done.join("; ")}. Written to its change log.` : `Nothing changed on "${id}" yet.`]
  if (request) {
    const text = [
      `Schedule time change requested by ${c.caller.agentId}`,
      `Schedule: ${id} (agent ${job.agent})`,
      `From: ${humanizeCron(job.schedule)} — \`${job.schedule}\` (${request.counts.approved} runs in 31 days, approved)`,
      `To:   ${humanizeCron(request.cron)} — \`${request.cron}\` (${request.counts.next} runs in 31 days)`,
      `Why: ${reason}`,
      "",
      `Approve: agentx schedule approve ${id}`,
      `Reject:  agentx schedule reject ${id}`,
    ].join("\n")
    lines.push(`The new time runs more often than the approved one (${request.counts.next} against ${request.counts.approved} runs in 31 days), so it needs operator approval; the job keeps its current time until then.`, await c.notifyApproval(text))
  }
  return lines.join("\n")
}

export async function retireAction(args: Record<string, unknown>, c: ChangeContext): Promise<string> {
  const reason = str(args.reason)
  if (!reason) return "Error: retire needs `reason`: why the job ends (it goes in the job's change log)."
  if (reason.length > REASON_MAX) return `Error: \`reason\` is longer than ${REASON_MAX} characters.`
  if (isPendingCreate(c.job)) return `"${c.id}" was never approved; withdraw the request with delete instead.`
  const ended = await endJobInConfig(c.id, c.now.toISOString(), { configPath: c.configPath, reload: c.reload ?? true })
  if (!ended.ok) return `Error: ${ended.error}`
  if (!ended.changed) return `"${c.id}" is already retired.`
  row(c, "retire", c.job.enabled ? "on" : "paused", "retired", reason)
  payChangeOwed(c)
  return `Retired "${c.id}": it never runs again. Bringing it back needs a new schedule the operator approves.`
}
