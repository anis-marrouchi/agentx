import type { RequestRecord } from "./store"
import { CHOICE_LIMITS } from "@/approvals/choices"
import { STEP_TEXT_MAX, type NewStep, type PlanStep } from "./plan-store"

// --- What a plan is made of, and what each party is told (#788) ---
//
// Validation of the steps an agent sends with `accept`, and the words of
// every turn and notice the plan check sends. No I/O here.

export interface PlanSettings {
  /** Plans are recorded and followed. Needs requests.enabled as well. */
  enabled: boolean
  /** A step with no progress for this long gets a nudge. */
  stallMinutes: number
  /** Nudges per step before it counts as blocked and the owner is told. */
  maxNudges: number
  /** Step kinds the owner approves once, when the plan is made. */
  approveKinds: string[]
  /** Agents that may not open a plan. */
  disabledAgents: string[]
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  enabled: true, stallMinutes: 30, maxNudges: 3, approveKinds: ["message"], disabledAgents: [],
}

/** The kind the daemon carries out itself: it sends the message. */
export const MESSAGE_KIND = "message"
export const MIN_STEPS = 2
export const MAX_STEPS = 20
const NAME_MAX = 120
const KIND_RE = /^[a-z][a-z0-9_-]{0,30}$/

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** Plans are off for this agent, or everywhere. */
export function plansOffFor(settings: PlanSettings, agentId: string): string | null {
  if (!settings.enabled) return "Plans are turned off on this node (requests.plans.enabled)."
  if (settings.disabledAgents.includes(agentId)) return `Plans are turned off for ${agentId} (requests.plans.disabledAgents).`
  return null
}

/** Check the steps an agent sent. Each needs a name and a "done when"
 *  check; the owner defaults to the agent writing the plan. */
export function parseSteps(
  raw: unknown,
  opts: { createdBy: string; hasAgent: (id: string) => boolean; settings: PlanSettings },
): { ok: true; steps: NewStep[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "steps must be a list" }
  if (raw.length < MIN_STEPS) return { ok: false, error: `a plan needs ${MIN_STEPS} or more steps; for one step, accept without steps` }
  if (raw.length > MAX_STEPS) return { ok: false, error: `a plan has at most ${MAX_STEPS} steps` }
  const steps: NewStep[] = []
  for (const [i, item] of raw.entries()) {
    const at = `step ${i + 1}`
    if (!item || typeof item !== "object") return { ok: false, error: `${at} must be an object` }
    const s = item as Record<string, unknown>
    const name = str(s.name)
    if (!name) return { ok: false, error: `${at} needs a name` }
    if (name.length > NAME_MAX) return { ok: false, error: `${at}: name is longer than ${NAME_MAX} characters` }
    const kind = (str(s.kind) || "task").toLowerCase()
    if (!KIND_RE.test(kind)) return { ok: false, error: `${at}: kind "${kind}" must be a short lower-case word (task, deploy, verify, message…)` }
    const agentId = str(s.agent) || opts.createdBy
    if (!opts.hasAgent(agentId)) return { ok: false, error: `${at}: "${agentId}" is not an agent on this node` }
    const step: NewStep = { name, kind, agentId, doneWhen: "", needsApproval: opts.settings.approveKinds.includes(kind) }

    if (kind === MESSAGE_KIND) {
      const message = str(s.message)
      const to = (s.to && typeof s.to === "object" ? s.to : {}) as Record<string, unknown>
      if (!message) return { ok: false, error: `${at}: a message step needs message: the text to send` }
      // It goes on the approval card as its draft.
      if (message.length > CHOICE_LIMITS.draft) return { ok: false, error: `${at}: message is longer than ${CHOICE_LIMITS.draft} characters` }
      if (!str(to.channel) || !str(to.chatId)) return { ok: false, error: `${at}: a message step needs to: {channel, chatId}, where to send it` }
      Object.assign(step, { message, toChannel: str(to.channel), toChat: str(to.chatId), toAccount: str(to.accountId) || null })
      step.doneWhen = str(s.done) || `sent to ${str(to.channel)} chat ${str(to.chatId)}`
    } else {
      step.doneWhen = str(s.done)
      if (!step.doneWhen) return { ok: false, error: `${at} needs done: what proves it is finished` }
    }
    if (step.doneWhen.length > STEP_TEXT_MAX) return { ok: false, error: `${at}: done is longer than ${STEP_TEXT_MAX} characters` }

    if (s.check !== undefined) {
      const check = (s.check && typeof s.check === "object" ? s.check : {}) as Record<string, unknown>
      const url = str(check.url)
      if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: `${at}: check.url must be an http(s) address` }
      step.checkUrl = url
      step.checkContains = str(check.contains) || null
    }
    if (s.stallMinutes !== undefined) {
      const n = Number(s.stallMinutes)
      if (!(n > 0) || n > 7 * 24 * 60) return { ok: false, error: `${at}: stallMinutes must be a positive number of minutes (at most a week)` }
      step.stallMinutes = n
    }
    steps.push(step)
  }
  return { ok: true, steps }
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

const STATE_WORD: Record<string, string> = {
  pending: "not started", active: "in progress", done: "done", blocked: "blocked", skipped: "skipped",
}

/** One line per step, for agents and notices. */
export function stepLines(steps: PlanStep[]): string[] {
  return steps.map((s) => {
    const extra = s.state === "done" && s.evidence ? `: ${clip(s.evidence, 200)}`
      : (s.state === "blocked" || s.state === "skipped") && s.note ? `: ${clip(s.note, 200)}` : ""
    return `${s.idx}. ${s.name} (${s.agentId}) [${STATE_WORD[s.state] ?? s.state}]${extra}`
  })
}

function reportHow(r: RequestRecord, s: PlanStep): string {
  return [
    `When it is done, report it with agentx_request: {action:"step", id:"${r.id}", step:${s.idx}, status:"done", evidence:"<link or proof>"}.`,
    `While it is still under way, report status:"progress" with a note, so you are not nudged. If you cannot go on, report status:"blocked" with the reason: the owner is told.`,
  ].join(" ")
}

/** The turn that hands a step to its owner agent. */
export function dispatchText(r: RequestRecord, steps: PlanStep[], s: PlanStep): string {
  return [
    `[agentx:plan-step id=${r.id} step=${s.idx}]`,
    `You own step ${s.idx} of ${steps.length} in the plan for the owner's request ${r.id}: "${s.name}".`,
    "",
    "What the owner asked:",
    clip(r.text, 800),
    "",
    `Done when: ${s.doneWhen}`,
    ...(s.checkUrl ? [`The daemon also checks ${s.checkUrl}${s.checkContains ? ` for "${s.checkContains}"` : ""} and marks the step done when it answers.`] : []),
    "",
    "The plan:",
    ...stepLines(steps),
    "",
    `Do it now. ${reportHow(r, s)}`,
  ].join("\n")
}

/** The turn that nudges a step that went quiet. */
export function nudgeText(r: RequestRecord, steps: PlanStep[], s: PlanStep, minutes: number, nudge: number, max: number): string {
  return [
    `[agentx:plan-nudge id=${r.id} step=${s.idx}]`,
    `Step ${s.idx} of the plan for request ${r.id}, "${s.name}", has had no progress for ${Math.round(minutes)} minutes. This is nudge ${nudge} of ${max}; after that the owner is told it is blocked.`,
    `Done when: ${s.doneWhen}`,
    "",
    "The plan:",
    ...stepLines(steps),
    "",
    `Go on with it now. ${reportHow(r, s)}`,
  ].join("\n")
}

/** The owner's notice for a blocked step. */
export function blockedText(r: RequestRecord, steps: PlanStep[], s: PlanStep): string {
  return [
    `Step ${s.idx} of ${steps.length}, "${s.name}" (${s.agentId}), is blocked: ${clip(s.note ?? "no reason given", 300)}`,
    `You asked ${r.agentId}: ${clip(r.text, 240)}`,
    ...stepLines(steps),
    `To go on: answer the agent, or run \`agentx requests step ${r.id} ${s.idx} --retry\` (or --skip).`,
  ].join("\n")
}

/** The owner's one notice when every step is finished. */
export function summaryText(r: RequestRecord, steps: PlanStep[]): string {
  return [
    `Done: what you asked ${r.agentId} on ${r.channel}: ${clip(r.text, 240)}`,
    ...stepLines(steps),
  ].join("\n")
}

/** What a finished request is closed with. */
export function planEvidence(steps: PlanStep[]): string {
  const done = steps.filter((s) => s.state === "done" && s.evidence).map((s) => `${s.idx}. ${clip(s.evidence!, 120)}`)
  return done.length ? `Plan finished. ${done.join(" · ")}` : "Plan finished."
}

/** The approval card's question and draft for a step. */
export function approvalCardInput(r: RequestRecord, s: PlanStep): { title: string; ask: string; recommend: string; draft?: string; context: string } {
  const isMessage = s.kind === MESSAGE_KIND && s.message
  return {
    title: clip(`Plan step ${s.idx}: ${s.name}`, 120),
    ask: clip(isMessage
      ? `Send this to ${s.toChannel} chat ${s.toChat} as soon as the earlier steps are done, without asking you again?`
      : `Let ${s.agentId} do "${s.name}" when its turn in the plan comes, without asking you again?`, 300),
    recommend: "Yes, if it is right: approve it now so the plan does not stop for you later. Edit the text first if needed.",
    ...(isMessage ? { draft: s.message! } : {}),
    context: clip(`Request ${r.id} to ${r.agentId}: ${r.text}`, 600),
  }
}
