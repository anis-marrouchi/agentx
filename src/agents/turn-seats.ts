import { askSeat, decisionsRuntime, getSeatMode } from "@/decisions/seat"
import { TURN_PROGRESS_SEAT, turnProgressQuestions, turnProgressState, type TurnStep } from "@/decisions/seats/turn-progress"
import {
  APPROVAL_BINDING_SEAT,
  TURN_HANDOFF_SEAT,
  approvalBindingQuestions,
  approvalBindingState,
  endsWithQuestion,
  isBareApproval,
  isShortReply,
  turnHandoffQuestions,
  turnHandoffState,
} from "@/decisions/seats/turn-handoff"

// Wiring for the three turn seats (see src/decisions/seats/turn-*.ts).
// Every call here is fire-and-forget: a seat must never add latency to a
// turn or fail one. All three are shadow seats, so nothing here changes
// what the agent does.

const CHECKPOINT_MS = 5 * 60_000
const REPEAT_THRESHOLD = 3
const RECENT_STEPS = 12
const HANDOFF_LABEL_WINDOW_MS = 24 * 60 * 60_000

/** Channels with no person on the other end: nobody to hand a turn back to. */
const AUTOMATED_CHANNELS = new Set(["cron", "heartbeat", "bench", "a2a", "business"])

export interface TurnWatch {
  observe(event: any): void
  stop(): void
}

const NOOP_WATCH: TurnWatch = { observe() {}, stop() {} }

export function startTurnWatch(opts: {
  agent: string
  request: string
  taskId: string
  budgetMinutes: number
  checkpointMs?: number
  now?: () => number
}): TurnWatch {
  if (getSeatMode(TURN_PROGRESS_SEAT) === "off") return NOOP_WATCH
  const now = opts.now ?? Date.now
  const started = now()
  const steps: TurnStep[] = []
  const byToolUseId = new Map<string, TurnStep>()
  const calls = new Map<string, number>()
  const askedSignatures = new Set<string>()
  let stepsAtLastAsk = 0
  let inFlight = false

  const repeated = () => {
    let best: { call: string; times: number } | undefined
    for (const [call, times] of calls) if (times > 1 && (!best || times > best.times)) best = { call, times }
    return best
  }

  const ask = (trigger: "checkpoint" | "repetition") => {
    if (inFlight) return
    inFlight = true
    stepsAtLastAsk = steps.length
    const state = turnProgressState({
      agent: opts.agent,
      request: opts.request,
      elapsedMinutes: (now() - started) / 60_000,
      budgetMinutes: opts.budgetMinutes,
      steps: steps.slice(-RECENT_STEPS),
      repeated: repeated(),
      trigger,
    })
    void askSeat(TURN_PROGRESS_SEAT, state, turnProgressQuestions, {
      links: [{ kind: "task", id: opts.taskId }],
      features: { agent: opts.agent, trigger },
    }).finally(() => { inFlight = false })
  }

  const timer = setInterval(() => {
    if (steps.length > stepsAtLastAsk) ask("checkpoint")
  }, opts.checkpointMs ?? CHECKPOINT_MS)
  timer.unref?.()

  return {
    observe(event: any) {
      const blocks = Array.isArray(event?.message?.content) ? event.message.content : []
      if (event?.type === "assistant") {
        for (const block of blocks) {
          if (block?.type !== "tool_use") continue
          const input = block.input ? JSON.stringify(block.input) : ""
          const step: TurnStep = { tool: block.name || "tool", input }
          steps.push(step)
          if (typeof block.id === "string") byToolUseId.set(block.id, step)
          const signature = `${step.tool}(${input})`
          const times = (calls.get(signature) ?? 0) + 1
          calls.set(signature, times)
          if (times >= REPEAT_THRESHOLD && !askedSignatures.has(signature)) {
            askedSignatures.add(signature)
            ask("repetition")
          }
        }
      } else if (event?.type === "user") {
        for (const block of blocks) {
          if (block?.type !== "tool_result") continue
          const step = byToolUseId.get(block.tool_use_id)
          if (!step) continue
          step.result = Array.isArray(block.content)
            ? block.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
            : typeof block.content === "string" ? block.content : ""
          if (block.is_error) step.error = true
        }
      }
    },
    stop() { clearInterval(timer) },
  }
}

/** turn-handoff calls awaiting the user's next message, by conversation. */
const pendingHandoffs = new Map<string, { callId: string; at: number }>()
const conversationKey = (agent: string, channel: string, chatId: string) => `${agent}\u0000${channel}\u0000${chatId}`

export function onAgentReply(opts: {
  agent: string
  channel: string
  chatId: string
  request: string
  reply: string
  taskId: string
}): void {
  if (AUTOMATED_CHANNELS.has(opts.channel) || !endsWithQuestion(opts.reply)) return
  const key = conversationKey(opts.agent, opts.channel, opts.chatId)
  void askSeat(TURN_HANDOFF_SEAT, turnHandoffState(opts), turnHandoffQuestions, {
    links: [{ kind: "task", id: opts.taskId }],
    features: { agent: opts.agent, channel: opts.channel },
  }).then(result => {
    if (result?.callId) pendingHandoffs.set(key, { callId: result.callId, at: Date.now() })
  })
}

export function onUserMessage(opts: {
  agent: string
  channel: string
  chatId: string
  message: string
  /** The agent's last reply in this conversation, before this message. */
  previousReply?: string
  taskId: string
}): void {
  if (AUTOMATED_CHANNELS.has(opts.channel)) return
  const key = conversationKey(opts.agent, opts.channel, opts.chatId)

  // Outcome label for the handoff question the agent ended on.
  const pending = pendingHandoffs.get(key)
  if (pending) {
    pendingHandoffs.delete(key)
    const store = decisionsRuntime().store
    if (store && Date.now() - pending.at < HANDOFF_LABEL_WINDOW_MS) {
      try {
        store.label(pending.callId, "userReply", isBareApproval(opts.message) ? "approved" : "redirected", {
          kind: "outcome",
          labeledBy: "next-user-message",
        })
      } catch { /* observability never breaks the caller */ }
    }
  }

  if (!opts.previousReply || !isShortReply(opts.message) || !endsWithQuestion(opts.previousReply)) return
  void askSeat(
    APPROVAL_BINDING_SEAT,
    approvalBindingState({ agent: opts.agent, channel: opts.channel, message: opts.message, previousReply: opts.previousReply }),
    approvalBindingQuestions,
    { links: [{ kind: "task", id: opts.taskId }], features: { agent: opts.agent, channel: opts.channel } },
  )
}

export function resetTurnSeatsForTesting(): void {
  pendingHandoffs.clear()
}
