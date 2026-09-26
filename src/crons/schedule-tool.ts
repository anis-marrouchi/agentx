import { existsSync, readFileSync } from "fs"
import { applyConfigMutation, findConfigPath, getAtPath, setAtPath, unsetAtPath } from "@/daemon/config-mutator"
import { parseEnglishToCron, slugifyScheduleId } from "@/utils/nl-cron"
import {
  buildScheduleJob,
  DEFAULT_SCHEDULE_TIMEZONE,
  formatFireTime,
  humanizeCron,
  isPendingCreate,
  isValidScheduleId,
  isValidTimezone,
  nextFireTime,
  SUPPORTED_PHRASES_HINT,
  type NotifyTarget,
  type ScheduleApproval,
} from "./schedule-ops"

// --- Agent-facing `schedule` tool ---
//
// Lets an agent list / create / pause / resume / delete routines from any
// chat. Writes go through the same builder and config mutator as the
// `agentx schedule` CLI, with two differences that make it safe to hand to
// a model:
//
//   1. create and delete are REQUESTS. Create writes the job disabled with an
//      `approval` marker (the scheduler refuses to run it while that marker
//      says "create"); delete only marks the job. The operator is notified
//      with the parsed cron and next fire time, and only
//      `agentx schedule approve|reject <id>` resolves the request. There is
//      no action here that approves anything.
//   2. Ownership. Jobs record `createdBy`; an agent may touch only its own
//      unless its config says `admin: true`.

export type ScheduleAction = "list" | "create" | "pause" | "resume" | "delete"

export interface ScheduleCaller {
  agentId: string
  /** Chat the request came from — the default notify target. */
  channel?: string
  chatId?: string
  accountId?: string
}

export interface ScheduleToolDeps {
  configPath?: string
  /** Hot-reload the daemon after a write. Default true. */
  reload?: boolean
  now?: () => Date
  /** Deliver the approval request to the operator. Throws on failure. */
  notifyOperator?: (dest: NotifyTarget, text: string) => Promise<void>
}

/** Channels that are not a conversation someone reads, so they never make a
 *  sensible default delivery target for a routine's output. */
const NON_DELIVERABLE_CHANNELS = new Set(["cron", "heartbeat", "api", "a2a", "mesh"])

const PROMPT_PREVIEW = 160

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function preview(s: string, n = PROMPT_PREVIEW): string {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

function readRawConfig(configPath?: string): any {
  const path = findConfigPath(configPath)
  if (!existsSync(path)) throw new Error(`config not found at ${path}`)
  return JSON.parse(readFileSync(path, "utf-8"))
}

function isAdmin(cfg: any, agentId: string): boolean {
  return cfg?.agents?.[agentId]?.admin === true
}

function canManage(cfg: any, job: any, caller: ScheduleCaller): boolean {
  return isAdmin(cfg, caller.agentId) || job?.createdBy === caller.agentId
}

function ownershipError(id: string, job: any): string {
  const owner = job?.createdBy ? `agent "${job.createdBy}"` : "the operator"
  return `Not allowed: "${id}" was created by ${owner}. Agents manage only schedules they created (unless configured admin).`
}

function resolveNotify(args: Record<string, unknown>, caller: ScheduleCaller): NotifyTarget | undefined | "invalid" {
  const raw = str(args.notify)
  if (raw === "none") return undefined
  if (raw && raw !== "here") {
    const parts = raw.split(":")
    if (parts.length < 2 || !parts[0] || !parts[1]) return "invalid"
    // chatIds can contain ":" (gitlab "org/repo:issue:1"), so the channel
    // is the first segment and the rest is the chat id.
    return { channel: parts[0], chatId: parts.slice(1).join(":") }
  }
  if (caller.channel && caller.chatId && !NON_DELIVERABLE_CHANNELS.has(caller.channel)) {
    return { channel: caller.channel, chatId: caller.chatId, ...(caller.accountId ? { accountId: caller.accountId } : {}) }
  }
  return undefined
}

function describeJob(id: string, job: any, now: Date): string {
  const tz = job.timezone || "UTC"
  const next = job.enabled && !isPendingCreate(job) ? formatFireTime(nextFireTime(job.schedule, tz, now), tz) : "—"
  const state = job.approval
    ? `pending ${job.approval.action} approval`
    : job.enabled ? "active" : "paused"
  const lines = [
    `- ${id} [${state}] ${job.schedule} — ${humanizeCron(job.schedule)} (${tz})`,
    `  agent: ${job.agent}; created by: ${job.createdBy || "operator"}; next: ${next}`,
  ]
  if (job.notify) lines.push(`  notify: ${job.notify.channel} ${job.notify.chatId}`)
  if (job.command) lines.push(`  command: ${preview(String(job.command))}`)
  else if (job.prompt) lines.push(`  prompt: ${preview(String(job.prompt))}`)
  return lines.join("\n")
}

async function notifyApproval(
  cfg: any,
  deps: ScheduleToolDeps,
  text: string,
): Promise<string> {
  const dest = cfg?.notifications?.destination
  if (!dest?.channel || !dest?.chatId) {
    return "No operator notification destination is configured (notifications.destination); the operator must check `agentx schedule list`."
  }
  if (!deps.notifyOperator) return "Operator notification is unavailable in this context."
  try {
    await deps.notifyOperator({ channel: dest.channel, chatId: dest.chatId, accountId: dest.accountId }, text)
    return "The operator has been notified."
  } catch (e: any) {
    return `Could not notify the operator (${e?.message ?? e}); the request is still recorded.`
  }
}

/**
 * Run one tool action. Returns the text the agent sees. Throws only on
 * programming errors — every expected refusal is returned as text so the
 * model can relay it.
 */
export async function runScheduleTool(
  args: Record<string, unknown>,
  caller: ScheduleCaller | null,
  deps: ScheduleToolDeps = {},
): Promise<string> {
  const action = (str(args.action) || "list").toLowerCase() as ScheduleAction
  const now = deps.now ? deps.now() : new Date()

  let cfg: any
  try {
    cfg = readRawConfig(deps.configPath)
  } catch (e: any) {
    return `Error: ${e.message}`
  }
  const crons: Record<string, any> = cfg.crons || {}

  if (action === "list") {
    const mineOnly = args.mine === true
    const entries = Object.entries(crons).filter(([, j]) => !mineOnly || (caller && j?.createdBy === caller.agentId))
    if (!entries.length) return mineOnly ? "You have no schedules." : "No schedules."
    return entries.map(([id, j]) => describeJob(id, j, now)).join("\n")
  }

  if (!caller?.agentId) {
    return "Error: caller agent is unknown (AGENTX_AGENT_ID not set). Pass callerAgentId."
  }
  if (!cfg.agents?.[caller.agentId]) {
    return `Error: caller "${caller.agentId}" is not an agent on this node.`
  }

  const id = str(args.id)
  const mutate = (fn: (c: any) => void) =>
    applyConfigMutation(fn, { configPath: deps.configPath, reload: deps.reload })

  if (action === "create") {
    const when = str(args.when)
    const prompt = str(args.prompt)
    if (!when || !prompt) return "Error: create needs `when` (plain English) and `prompt`."
    const parsed = parseEnglishToCron(when)
    if (!parsed) return `Error: couldn't parse "${when}". ${SUPPORTED_PHRASES_HINT}.`

    const agent = str(args.agent) || caller.agentId
    if (!cfg.agents?.[agent]) return `Error: agent "${agent}" not found on this node.`

    const timezone = str(args.timezone) || DEFAULT_SCHEDULE_TIMEZONE
    if (!isValidTimezone(timezone)) return `Error: unknown timezone "${timezone}".`

    const jobId = id || slugifyScheduleId(parsed.matched, agent)
    if (!isValidScheduleId(jobId)) return `Error: invalid id "${jobId}" (letters, digits, "-" and "_" only).`
    if (crons[jobId]) return `Error: a schedule "${jobId}" already exists. Pick another \`id\`.`

    const notify = resolveNotify(args, caller)
    if (notify === "invalid") return 'Error: `notify` must be "here", "none", or "channel:chatId".'

    const approval: ScheduleApproval = {
      action: "create",
      requestedBy: caller.agentId,
      requestedAt: now.toISOString(),
    }
    const job = buildScheduleJob({
      parsed,
      agent,
      prompt,
      timezone,
      notify,
      enabled: false,
      createdBy: caller.agentId,
      approval,
    })

    const result = await mutate((c) => setAtPath(c, `crons.${jobId}`, job))
    if (!result.success) return `Error: ${result.error}`

    const next = formatFireTime(nextFireTime(parsed.cron, timezone, now), timezone)
    const request = [
      `Schedule approval requested by ${caller.agentId}`,
      `Create: ${jobId}`,
      `When: ${parsed.human} — cron \`${parsed.cron}\` (${timezone})`,
      `Next fire: ${next}`,
      `Agent: ${agent}`,
      notify ? `Notify: ${notify.channel} ${notify.chatId}` : "Notify: none",
      `Prompt: ${preview(prompt, 400)}`,
      "",
      `Approve: agentx schedule approve ${jobId}`,
      `Reject:  agentx schedule reject ${jobId}`,
    ].join("\n")
    const notified = await notifyApproval(cfg, deps, request)

    return [
      `Requested schedule "${jobId}": ${parsed.human} (cron ${parsed.cron}, ${timezone}); next fire would be ${next}.`,
      "It is saved DISABLED and will not run until the operator approves it.",
      notified,
    ].join("\n")
  }

  if (!id) return `Error: ${action} needs \`id\`.`
  const job = crons[id]
  if (!job) return `Error: schedule "${id}" not found.`
  if (!canManage(cfg, job, caller)) return ownershipError(id, job)

  if (action === "pause" || action === "resume") {
    const enable = action === "resume"
    if (enable && isPendingCreate(job)) {
      return `"${id}" is still awaiting operator approval; it can't be resumed until approved.`
    }
    if (job.enabled === enable) return `"${id}" is already ${enable ? "active" : "paused"}.`
    const result = await mutate((c) => setAtPath(c, `crons.${id}.enabled`, enable))
    if (!result.success) return `Error: ${result.error}`
    return `"${id}" ${enable ? "resumed" : "paused"}.`
  }

  if (action === "delete") {
    // Withdrawing your own never-approved request removes nothing that ever
    // ran, so it needs no approval.
    if (isPendingCreate(job) && job.approval.requestedBy === caller.agentId) {
      const result = await mutate((c) => unsetAtPath(c, `crons.${id}`))
      if (!result.success) return `Error: ${result.error}`
      return `Withdrew the pending request "${id}".`
    }
    // Never replace a pending create marker with a delete marker: rejecting
    // that delete would leave a disabled job with no marker, which its owner
    // could then resume without the create ever being approved.
    if (isPendingCreate(job)) {
      return `"${id}" is a creation request still awaiting approval; only its requester or the operator (\`agentx schedule reject ${id}\`) can drop it.`
    }
    if (job.approval?.action === "delete") return `Deletion of "${id}" is already awaiting approval.`

    const approval: ScheduleApproval = {
      action: "delete",
      requestedBy: caller.agentId,
      requestedAt: now.toISOString(),
    }
    const result = await mutate((c) => {
      if (!getAtPath(c, `crons.${id}`)) throw new Error(`schedule "${id}" not found`)
      setAtPath(c, `crons.${id}.approval`, approval)
    })
    if (!result.success) return `Error: ${result.error}`

    const tz = job.timezone || "UTC"
    const request = [
      `Schedule approval requested by ${caller.agentId}`,
      `Delete: ${id}`,
      `When: ${humanizeCron(job.schedule)} — cron \`${job.schedule}\` (${tz})`,
      `Next fire: ${job.enabled ? formatFireTime(nextFireTime(job.schedule, tz, now), tz) : "— (paused)"}`,
      `Agent: ${job.agent}`,
      "",
      `Approve: agentx schedule approve ${id}`,
      `Reject:  agentx schedule reject ${id}`,
    ].join("\n")
    const notified = await notifyApproval(cfg, deps, request)
    return [
      `Deletion of "${id}" requested. It keeps its current state until the operator approves.`,
      notified,
    ].join("\n")
  }

  return `Error: unknown action "${action}". Use list, create, pause, resume or delete.`
}

/**
 * Who is calling. The runtime-exported environment wins over model-supplied
 * arguments: an agent launched by AgentX cannot claim another identity by
 * passing `callerAgentId`. The arguments are the fallback for runtimes that
 * don't export the variables (e.g. an operator-configured MCP entry).
 */
export function resolveScheduleCaller(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ScheduleCaller | null {
  const agentId = str(env.AGENTX_AGENT_ID) || str(args.callerAgentId)
  if (!agentId) return null
  const envChat = Boolean(str(env.AGENTX_CHANNEL) && str(env.AGENTX_CHAT_ID))
  const channel = envChat ? str(env.AGENTX_CHANNEL) : str(args.channel)
  const chatId = envChat ? str(env.AGENTX_CHAT_ID) : str(args.chatId)
  const accountId = str(args.accountId)
  return { agentId, channel, chatId, ...(accountId ? { accountId } : {}) }
}
