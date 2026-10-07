import { render, renderParams } from "../template"
import type { WorkflowRun } from "../types"
import { DEFAULT_FOLLOW_UP, type FollowUpDefaults, type NodeContext, type NodeHandler, type NodeResult } from "./types"

// --- Follow-up steps (#788) ---
//
// The steps a request with several stages needs beside agent work:
//   owner.notify    tell the owner something, and go on
//   owner.ask       ask the owner on a decision card; ports yes / no / expired
//   person.message  send a message to a person (an employee, a client);
//                   the owner approves it first, at the start of the run or
//                   on its own card; ports sent / declined
//   person.wait     wait for a person to write back on a channel, with a
//                   deadline and reminders; ports reply / timeout
// and the supervised agent step (supervisedResult): an agent step whose
// turn ends without saying it is done is nudged when it stalls, and
// blocked after the last nudge.
//
// Every pause here is resumed by the dispatcher: resumeFromCard,
// resumeFromReply, stepDone, and the timer for reminders, deadlines and
// nudges. No step needs its own watcher.

const ctxOf = (ctx: NodeContext) => ctx.run.context as unknown as Record<string, unknown>

/** Minutes as a number, "30m" / "4h" / "2d", or ISO "PT4H" / "P2D". */
export function durationMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v * 60_000 : null
  if (typeof v !== "string" || !v.trim()) return null
  const s = v.trim()
  const short = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/i.exec(s)
  if (short) {
    const n = Number(short[1])
    const unit = short[2].toLowerCase()
    const ms = n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000)
    return ms > 0 ? ms : null
  }
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(s)
  if (iso) {
    const ms = (((Number(iso[1] ?? 0) * 24 + Number(iso[2] ?? 0)) * 60 + Number(iso[3] ?? 0)) * 60 + Number(iso[4] ?? 0)) * 1000
    return ms > 0 ? ms : null
  }
  if (/^\d+$/.test(s)) return Number(s) * 60_000 || null
  return null
}

/** The follow-up settings for this step: node config, then the workflow's
 *  own, then the node's defaults. */
export function followUpFor(ctx: Pick<NodeContext, "workflow" | "node" | "followUp">): FollowUpDefaults {
  const base = ctx.followUp ?? DEFAULT_FOLLOW_UP
  const cfg = ctx.node.config as { stallMinutes?: unknown; maxNudges?: unknown }
  const wf = ctx.workflow.followUp ?? {}
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined)
  return {
    stallMinutes: num(cfg.stallMinutes) || wf.stallMinutes || base.stallMinutes,
    maxNudges: num(cfg.maxNudges) ?? wf.maxNudges ?? base.maxNudges,
    approval: ctx.workflow.approval ?? base.approval,
  }
}

/** Is this agent step followed? On a follow-up run unless the step says
 *  `supervise: false`; elsewhere only with `supervise: true`. */
export function isSupervised(ctx: Pick<NodeContext, "node" | "run">): boolean {
  const flag = (ctx.node.config as { supervise?: unknown }).supervise
  if (typeof flag === "boolean") return flag
  return ctx.run.meta?.followUp === true
}

/** What a supervised step's prompt ends with: how to say it is done. */
export function supervisedSuffix(run: Pick<WorkflowRun, "id">, nodeId: string): string {
  return [
    "",
    `[agentx:workflow-step run=${run.id} step=${nodeId}]`,
    "This is one step of a workflow AgentX is following. When the step is finished, end your reply with a line `RESULT: done` and say what proves it (a link, an id, the text you checked).",
    `If it will finish later (a deploy still running, an answer still due), say so and report it when it is done with agentx_workflow: {action:"step_done", runId:"${run.id}", step:"${nodeId}", evidence:"<proof>"}. You will be reminded if nothing happens.`,
    "If you cannot do it without the owner, end with `RESULT: blocked` and the reason in one line.",
  ].join("\n")
}

/** Decide what a supervised agent step's turn means. `parsed.result` is
 *  the RESULT token, if the reply had one. */
export function supervisedResult(
  ctx: Pick<NodeContext, "workflow" | "node" | "run" | "followUp">,
  agentId: string,
  turn: { output?: Record<string, unknown>; error?: string; result?: string; reply?: string },
): NodeResult {
  const { stallMinutes, maxNudges } = followUpFor(ctx)
  const stallMs = stallMinutes * 60_000
  const pausedAt = (blocked?: string) => ({
    kind: "agentStep" as const,
    nodeId: ctx.node.id,
    agentId,
    nudges: 0,
    maxNudges,
    stallMs,
    ...(blocked ? { blocked } : { nextNudgeAt: new Date(Date.now() + stallMs).toISOString() }),
  })
  if (!turn.error && turn.result === "blocked") {
    const reason = lastLine(turn.reply) || `${agentId} says the step is blocked`
    return { paused: true, pausedAt: pausedAt(reason), blocked: reason, output: turn.output }
  }
  if (!turn.error && turn.result) return { output: turn.output }
  // No word that it is done, or the turn failed: wait, and nudge when it stalls.
  return { paused: true, pausedAt: pausedAt(), output: turn.output }
}

function lastLine(text: string | undefined): string {
  if (!text) return ""
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^RESULT:/i.test(l))
  return (lines.at(-1) ?? "").slice(0, 300)
}

/** The prompt of a nudge. */
export function nudgeText(run: Pick<WorkflowRun, "id" | "meta">, nodeId: string, n: number, max: number, sinceMs: number): string {
  const mins = Math.max(1, Math.round(sinceMs / 60_000))
  return [
    `[agentx:workflow-nudge run=${run.id} step=${nodeId} nudge=${n}/${max}]`,
    `Reminder ${n} of ${max}: the workflow step "${nodeId}"${run.meta?.title ? ` of "${run.meta.title}"` : ""} has shown no progress for ${mins} minute(s).`,
    "Check where it stands and finish it now if you can.",
    `When it is done, end your reply with \`RESULT: done\` and the proof, or call agentx_workflow {action:"step_done", runId:"${run.id}", step:"${nodeId}", evidence:"<proof>"}.`,
    "If you cannot finish it without the owner, end with `RESULT: blocked` and the reason.",
    n >= max ? "This is the last reminder: after it the owner is told the step is blocked." : "",
  ].filter(Boolean).join("\n")
}

// --- owner.notify ---

const ownerNotifyHandler: NodeHandler = async (ctx) => {
  const text = render(String(ctx.node.config.text ?? ""), ctxOf(ctx), { envAllow: ctx.workflow.envAllow }).trim()
  if (!text) return { error: `owner.notify "${ctx.node.id}" needs config.text` }
  if (!ctx.owner) return { error: `owner.notify "${ctx.node.id}": no owner to tell on this node` }
  try {
    await ctx.owner.notify(text, ctx.run)
  } catch (e: any) {
    return { error: `owner.notify "${ctx.node.id}" failed: ${e?.message ?? e}` }
  }
  return { output: { text, sentAt: new Date().toISOString() } }
}

// --- owner.ask ---

const ownerAskHandler: NodeHandler = async (ctx) => {
  const cfg = renderParams(ctx.node.config, ctxOf(ctx), { envAllow: ctx.workflow.envAllow })
  const ask = String(cfg.ask ?? cfg.question ?? "").trim()
  if (!ask) return { error: `owner.ask "${ctx.node.id}" needs config.ask (the yes/no question)` }
  if (!ctx.owner) return { error: `owner.ask "${ctx.node.id}": no owner to ask on this node` }
  const choices = Array.isArray(cfg.choices) ? (cfg.choices as unknown[]).map(String).filter(Boolean) : undefined
  try {
    const { cardId } = await ctx.owner.ask({
      title: clip(String(cfg.title ?? ctx.run.meta?.title ?? ctx.workflow.title), 120),
      ask: clip(ask, 300),
      recommend: clip(String(cfg.recommend ?? "Your call."), 300),
      ...(typeof cfg.draft === "string" && cfg.draft.trim() ? { draft: cfg.draft } : {}),
      ...(choices?.length ? { choices } : {}),
      ...(typeof cfg.context === "string" && cfg.context.trim() ? { context: clip(cfg.context, 600) } : {}),
      ...(typeof cfg.expires === "string" && cfg.expires.trim() ? { expires: cfg.expires } : {}),
    }, ctx.run, ctx.node.id)
    return { paused: true, pausedAt: { kind: "ownerDecision", nodeId: ctx.node.id, cardId, purpose: "ask" } }
  } catch (e: any) {
    return { error: `owner.ask "${ctx.node.id}": could not raise the card: ${e?.message ?? e}` }
  }
}

// --- person.message ---

/** The message a person.message step sends, rendered against the run. */
export function renderPersonMessage(ctx: Pick<NodeContext, "node" | "run" | "workflow">): {
  channel: string; chatId: string; accountId?: string; text: string; to?: string
} {
  const cfg = renderParams(ctx.node.config, ctxOf(ctx as NodeContext), { envAllow: ctx.workflow.envAllow })
  return {
    channel: String(cfg.channel ?? "").trim(),
    chatId: String(cfg.chatId ?? "").trim(),
    ...(typeof cfg.accountId === "string" && cfg.accountId ? { accountId: cfg.accountId } : {}),
    text: String(cfg.text ?? "").trim(),
    ...(typeof cfg.to === "string" && cfg.to.trim() ? { to: cfg.to.trim() } : {}),
  }
}

const personMessageHandler: NodeHandler = async (ctx) => {
  const msg = renderPersonMessage(ctx)
  if (!msg.channel || !msg.chatId || !msg.text) {
    return { error: `person.message "${ctx.node.id}" needs channel, chatId and text` }
  }
  // Approved with the whole run: send it now.
  if (ctx.run.meta?.approvedAtStart) {
    const sent = await deliver(ctx, msg)
    if ("error" in sent) return { error: sent.error }
    return { output: { ...msg, messageId: sent.messageId, approved: "start" }, port: "sent" }
  }
  if (!ctx.owner) return { error: `person.message "${ctx.node.id}": no owner to approve it on this node` }
  const who = msg.to ?? `${msg.channel} ${msg.chatId}`
  try {
    const { cardId } = await ctx.owner.ask({
      title: clip(`Send to ${who}`, 120),
      ask: clip(`Send this message to ${who} on ${msg.channel}?`, 300),
      recommend: clip(`It is step "${ctx.node.id}" of ${ctx.run.meta?.title ? `"${ctx.run.meta.title}"` : `workflow ${ctx.workflow.id}`}. Edit it if needed, then say yes.`, 300),
      draft: msg.text,
    }, ctx.run, ctx.node.id)
    return { paused: true, pausedAt: { kind: "ownerDecision", nodeId: ctx.node.id, cardId, purpose: "send", message: msg } }
  } catch (e: any) {
    return { error: `person.message "${ctx.node.id}": could not ask the owner: ${e?.message ?? e}` }
  }
}

/** Send through the local adapter, or a mesh peer that hosts the channel. */
export async function deliver(
  ctx: Pick<NodeContext, "channels" | "forwardChannelSend">,
  msg: { channel: string; chatId: string; accountId?: string; text: string },
): Promise<{ messageId: string | null } | { error: string }> {
  const adapter = ctx.channels[msg.channel] as { send?: (m: { channel: string; chatId: string; text: string; accountId?: string }) => Promise<string | void> } | undefined
  const out = { channel: msg.channel, chatId: msg.chatId, text: msg.text, ...(msg.accountId ? { accountId: msg.accountId } : {}) }
  if (adapter?.send) {
    try {
      return { messageId: (await adapter.send(out)) ?? null }
    } catch (e: any) {
      return { error: `send on ${msg.channel} failed: ${e?.message ?? e}` }
    }
  }
  if (ctx.forwardChannelSend) {
    try {
      return { messageId: (await ctx.forwardChannelSend(out)).messageId }
    } catch (e: any) {
      return { error: `send on ${msg.channel} via the mesh failed: ${e?.message ?? e}` }
    }
  }
  return { error: `channel "${msg.channel}" is not available here or on a peer` }
}

// --- person.wait ---

const personWaitHandler: NodeHandler = async (ctx) => {
  const cfg = renderParams(ctx.node.config, ctxOf(ctx), { envAllow: ctx.workflow.envAllow })
  // Default: wait where the step named in `reminds` wrote.
  const reminds = typeof cfg.reminds === "string" && cfg.reminds ? cfg.reminds : undefined
  const sent = reminds ? ctx.run.context[reminds] as { channel?: unknown; chatId?: unknown; accountId?: unknown } | undefined : undefined
  const channel = String(cfg.channel ?? sent?.channel ?? "").trim()
  const chatId = String(cfg.chatId ?? sent?.chatId ?? "").trim()
  if (!channel || !chatId) return { error: `person.wait "${ctx.node.id}" needs channel and chatId (or reminds: a person.message step)` }
  const timeout = durationMs(cfg.timeout ?? "P1D")
  if (!timeout) return { error: `person.wait "${ctx.node.id}": timeout must be minutes, "4h", "2d" or "P2D"` }
  const every = cfg.remindAfter === undefined ? null : durationMs(cfg.remindAfter)
  if (cfg.remindAfter !== undefined && !every) return { error: `person.wait "${ctx.node.id}": remindAfter must be minutes, "4h", "2d" or "P2D"` }
  const maxReminders = typeof cfg.maxReminders === "number" ? Math.max(0, Math.floor(cfg.maxReminders)) : every ? 1 : 0
  const now = Date.now()
  const accountId = typeof cfg.accountId === "string" && cfg.accountId ? cfg.accountId
    : typeof sent?.accountId === "string" && sent.accountId ? sent.accountId : undefined
  return {
    paused: true,
    pausedAt: {
      kind: "replyWait",
      nodeId: ctx.node.id,
      channel,
      chatId,
      ...(accountId ? { accountId } : {}),
      ...(typeof cfg.from === "string" && cfg.from ? { from: cfg.from } : {}),
      deadline: new Date(now + timeout).toISOString(),
      ...(every && maxReminders > 0 ? { nextRemindAt: new Date(now + every).toISOString(), remindEveryMs: every } : {}),
      reminders: 0,
      maxReminders,
      ...(reminds ? { reminds } : {}),
    },
  }
}

/** The pause's next moment: a reminder, a nudge or the deadline. */
export function nextWakeAt(p: NonNullable<WorkflowRun["pausedAt"]>): string | null {
  if (p.kind === "replyWait") {
    const remind = p.nextRemindAt && p.reminders < p.maxReminders ? p.nextRemindAt : null
    return remind && Date.parse(remind) < Date.parse(p.deadline) ? remind : p.deadline
  }
  if (p.kind === "agentStep") return p.blocked ? null : p.nextNudgeAt ?? null
  return null
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

export const FOLLOW_UP_HANDLERS: Record<string, NodeHandler> = {
  "owner.notify": ownerNotifyHandler,
  "owner.ask": ownerAskHandler,
  "person.message": personMessageHandler,
  "person.wait": personWaitHandler,
}
