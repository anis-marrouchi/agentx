import { getAttachRegistry } from "./index"
import type { AttachSession, InboxItem, StopDecision } from "./types"

// --- In-daemon attach service ---
//
// The four Claude Code hook events, answered in-process. The hooks
// themselves are one-line `curl` calls to loopback (see install.ts) for the
// same reason the guard uses that shape: spawning `node dist/cli.js` per
// hook event costs ~300ms of interpreter boot, and Stop fires on every
// single turn the human takes.
//
// Everything here must be fast and must never throw. A hook that errors or
// hangs degrades the human's own Claude Code session, and attach mode is
// opt-in convenience — it has no right to do that. Every handler therefore
// fails open, returning "{}" (Claude Code's no-op) on any internal error.

export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  model?: string
  source?: string
  reason?: string
  /** Stop only: the text the session just produced. This is how a reply is
   *  captured without asking the model to call a tool for it. */
  last_assistant_message?: string
  /** Stop only: true when we are already inside a Stop-hook continuation. */
  stop_hook_active?: boolean
  user_input?: string
}

/** SessionStart — register the session and, if it is bound, tell it so. */
export function onSessionStart(p: HookPayload): string {
  return safe(() => {
    const sessionId = p.session_id
    if (!sessionId) return ""
    const reg = getAttachRegistry()
    const session = reg.register(sessionId, { cwd: p.cwd, model: p.model })
    if (session.agentIds.length === 0) return ""

    const pending = reg.pendingCount(sessionId)
    return json({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: briefing(session, pending),
      },
    })
  })
}

/** UserPromptSubmit — piggyback the backlog onto the human's own turn. We
 *  never block here: the human's prompt is theirs, and interrupting it to
 *  answer someone else's Telegram message is exactly the context hijack
 *  attach mode is designed not to do. */
export function onPrompt(p: HookPayload): string {
  return safe(() => {
    const sessionId = p.session_id
    if (!sessionId) return ""
    const reg = getAttachRegistry()
    const session = reg.touch(sessionId)
    if (!session || session.agentIds.length === 0) return ""
    if (session.mode === "manual") return ""

    const pending = reg.pendingCount(sessionId)
    if (pending === 0) return ""
    return json({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          `[agentx] ${pending} message${pending === 1 ? "" : "s"} queued for ` +
          `${session.agentIds.join(", ")}. Finish what the user asked first; ` +
          `use agentx_attach_next when you're ready to take them.`,
      },
    })
  })
}

/**
 * Stop — the drain point, and the only hook that can change what the
 * session does next.
 *
 * Two jobs, in order:
 *   1. Harvest. If we handed this session a message last turn, the text it
 *      just produced IS the answer. `last_assistant_message` gives it to us
 *      for free — no tool call, no special prompting.
 *   2. Decide. Stay quiet (manual), mention the backlog (notify), or take
 *      the turn by blocking the stop and feeding in the next message (auto).
 */
export function onStop(p: HookPayload): string {
  return safe(() => {
    const sessionId = p.session_id
    if (!sessionId) return ""
    const reg = getAttachRegistry()
    const session = reg.touch(sessionId)
    if (!session || session.agentIds.length === 0) return ""

    // 1. Harvest.
    let releasedEmpty = false
    if (session.awaitingAnswer) {
      const text = (p.last_assistant_message ?? "").trim()
      if (text) {
        reg.answer(sessionId, text)
      } else {
        reg.release(sessionId)
        releasedEmpty = true
      }
    }

    // 2. Decide.
    const pending = reg.pendingCount(sessionId)
    if (pending === 0) return stop(reg, sessionId, {})

    // The session produced no text for the message we just handed it — the
    // turn was interrupted, or ended on a tool call. Handing the very same
    // message straight back would spin until the per-turn budget ran out, so
    // put it down and let the session stop. The human can pick it up.
    if (releasedEmpty) {
      return stop(reg, sessionId, {
        systemMessage:
          `[agentx] no reply captured — the message is back in the queue ` +
          `(${pending} waiting). Run /inbox to answer it.`,
        suppressOutput: true,
      })
    }

    if (session.mode === "manual") return stop(reg, sessionId, {})

    if (session.mode === "notify") {
      return stop(reg, sessionId, {
        systemMessage:
          `[agentx] ${pending} message${pending === 1 ? "" : "s"} waiting for ` +
          `${session.agentIds.join(", ")} — run /inbox to answer.`,
        suppressOutput: true,
      })
    }

    // auto — drain until empty, bounded so a queue burst cannot own the turn.
    const opts = reg.options()
    if (session.drainedThisTurn >= opts.maxDrainPerTurn) {
      return stop(reg, sessionId, {
        systemMessage:
          `[agentx] paused after ${session.drainedThisTurn} messages; ` +
          `${pending} still queued. Run /inbox to continue.`,
        suppressOutput: true,
      })
    }

    const item = reg.claim(sessionId)
    if (!item) return stop(reg, sessionId, {})

    return json({ decision: "block", reason: prompt(item) })
  })
}

/** SessionEnd — release everything. Queued work expires rather than being
 *  dropped, so the dispatcher falls back to spawning a provider. */
export function onSessionEnd(p: HookPayload): string {
  return safe(() => {
    if (!p.session_id) return ""
    getAttachRegistry().deregister(p.session_id)
    return ""
  })
}

/** The text a session sees when it is handed a message. It is written as an
 *  instruction to the model, not as a log line — this lands mid-conversation
 *  and has to be unambiguous about who is asking and what to do. */
export function prompt(item: InboxItem): string {
  return [
    `[agentx] Incoming message for "${item.agentId}" via ${item.channel} from ${item.sender}:`,
    "",
    item.text,
    "",
    `Answer as "${item.agentId}". Your reply is sent back to ${item.channel} verbatim, ` +
      `so write it for ${item.sender}, not for the terminal.`,
  ].join("\n")
}

function briefing(session: AttachSession, pending: number): string {
  const lines = [
    `[agentx] This session is attached as "${session.agentIds.join('", "')}" ` +
      `(delivery mode: ${session.mode}).`,
    `Messages addressed to that identity on any connected channel are queued here ` +
      `instead of spawning a separate agent process.`,
  ]
  if (pending > 0) lines.push(`${pending} message${pending === 1 ? " is" : "s are"} already waiting.`)
  return lines.join(" ")
}

/** Emit a non-blocking decision and close the turn's drain window. */
function stop(reg: ReturnType<typeof getAttachRegistry>, sessionId: string, d: StopDecision): string {
  reg.endTurn(sessionId)
  return Object.keys(d).length ? json(d) : ""
}

function json(v: unknown): string {
  return JSON.stringify(v)
}

/** Fail open. An attach bug must never break the human's session. */
function safe(fn: () => string): string {
  try {
    return fn()
  } catch (e: any) {
    process.stderr.write(`[agentx-attach] handler error (fail-open): ${e?.message}\n`)
    return ""
  }
}
