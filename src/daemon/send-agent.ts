// retro:01M4DJTC01FK0BVCMFKT5K4SRQ — #847. POST /send/agent used to hold the
// request open until the target's turn finished (a long local task, or a
// mesh peer's synchronous answer). The MCP tool's fetch then failed after
// ~300 s although the task was already queued, and the caller retried,
// creating a duplicate. Now the route answers 202 as soon as the work is
// handed off, and a retry of the same message inside a short window gets
// the first task id back instead of a second task.

import { createHash } from "crypto"
import { newEventId } from "@/intent/ulid"

/** How long a resend of the same message from the same sender to the same
 *  agent is treated as a retry. Longer than the old ~300 s client timeout,
 *  so the retry that timeout provoked is caught. */
export const SEND_AGENT_DEDUPE_MS = 10 * 60_000

/** How long a queued send to a busy local agent waits for a free slot
 *  (#1258). Nobody holds a request open for it, so the 25 min cap of a
 *  waiting caller does not apply: the message stays in line behind long
 *  runs instead of being dropped, and is refused only past this age. */
export const SEND_AGENT_SLOT_WAIT_MS = 6 * 60 * 60_000

/** Most entries the dedupe window holds; the oldest go first. */
export const SEND_AGENT_DEDUPE_MAX = 500

/** Who sent what to whom. The text is hashed: the key never holds it. */
export function sendAgentKey(senderAgentId: string | undefined, targetAgent: string, text: string): string {
  const hash = createHash("sha256").update(targetAgent).update("\0").update(text).digest("hex")
  return `${senderAgentId || "?"}:${hash}`
}

/** The 202 body a recent send returned, kept for the dedupe window. */
export class SendAgentDedupe {
  private entries = new Map<string, { at: number; body: Record<string, unknown> }>()

  constructor(
    private windowMs = SEND_AGENT_DEDUPE_MS,
    private max = SEND_AGENT_DEDUPE_MAX,
    private now: () => number = Date.now,
  ) {}

  get(key: string): Record<string, unknown> | null {
    const hit = this.entries.get(key)
    if (!hit) return null
    if (this.now() - hit.at > this.windowMs) {
      this.entries.delete(key)
      return null
    }
    return hit.body
  }

  put(key: string, body: Record<string, unknown>): void {
    this.entries.delete(key)
    this.entries.set(key, { at: this.now(), body })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
  }
}

/**
 * #1251 — POST /send on an a2a chat. The chat ID is
 * `a2a:<caller>:<callee>[:<dlg-id>]`; the message goes to the agent in it
 * that did not send it, as a /send/agent would. With no sender named, the
 * caller (the first agent): the callee is the one told its chat ID.
 * An error when the chat ID does not name two agents, or names a sender
 * that is neither of them.
 */
export function a2aSendBody(body: Record<string, unknown>): { body: Record<string, unknown> } | { error: string } {
  const chatId = String(body.chatId ?? "")
  const m = /^a2a:([^:]+):([^:]+)(?::[^:]+)?$/.exec(chatId)
  if (!m) {
    return { error: `"${chatId}" is not an a2a chat ID (a2a:<agent>:<agent>[:<id>]). To message an agent, POST /send/agent {agentId, text, senderAgentId}.` }
  }
  const [, caller, callee] = m
  const sender = typeof body.senderAgentId === "string" ? body.senderAgentId
    : typeof body.agentId === "string" ? body.agentId
    : undefined
  if (sender !== undefined && sender !== caller && sender !== callee) {
    return { error: `"${sender}" is not in a2a chat "${chatId}" (${caller}, ${callee}). Send as one of them, or POST /send/agent {agentId, text, senderAgentId}.` }
  }
  const to = sender === caller ? callee : caller
  return {
    body: {
      // What /send/agent reads besides the addressing: wait for the answer
      // (async:false), the work's home and context, its task type.
      ...pick(body, ["async", "home", "context", "taskType"]),
      agentId: to,
      text: body.text,
      // The sender of a callee's note is the callee, the agent the caller asked.
      senderAgentId: sender ?? callee,
      // Names the sender's turn in this chat, so a callee's note reaches the
      // caller's conversation for that delegation (#1100).
      callerChannel: "a2a",
      callerChatId: chatId,
      ...(typeof body.callerTaskId === "string" ? { callerTaskId: body.callerTaskId } : {}),
    },
  }
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
  return out
}

/** The 202 body for a send that was queued, not waited on. */
export function queuedBody(taskId: string, agent: string, peer?: string): Record<string, unknown> {
  const who = peer ? `${agent} on ${peer}` : agent
  return {
    accepted: true,
    status: "queued",
    taskId,
    agent,
    ...(peer ? { peer } : {}),
    note:
      `Queued for ${who} (task ${taskId}). The message is delivered; do not send it again. ` +
      `The answer is not returned here: ${agent} works on it in its own turn.`,
  }
}

/** What a duplicate send gets back: the first send's body, marked. */
export function duplicateBody(first: Record<string, unknown>): Record<string, unknown> {
  return {
    ...first,
    duplicate: true,
    note: `Already sent (task ${String(first.taskId)}); this repeat was not delivered again.`,
  }
}

/**
 * Start `run` in the background and answer at once. `run` never holds the
 * HTTP request; its outcome goes to `log` only. Returns the 202 body.
 */
export function queueSend(
  opts: {
    agent: string
    peer?: string
    run: (taskId: string) => Promise<{ ok: boolean; detail?: string }>
    log: (msg: string) => void
    newId?: () => string
  },
): Record<string, unknown> {
  const taskId = `snd-${(opts.newId ?? newEventId)()}`
  const who = opts.peer ? `${opts.agent}@${opts.peer}` : opts.agent
  opts.log(`[send/agent] ${taskId} → ${who} queued`)
  void Promise.resolve()
    .then(() => opts.run(taskId))
    .then(
      (r) => opts.log(`[send/agent] ${taskId} → ${who} ${r.ok ? "done" : "failed"}${r.detail ? `: ${r.detail}` : ""}`),
      (e: any) => opts.log(`[send/agent] ${taskId} → ${who} failed: ${e?.message ?? e}`),
    )
  return queuedBody(taskId, opts.agent, opts.peer)
}
