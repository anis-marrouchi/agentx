import type { AppChatStore, AppFileRef } from "./app-chat-store"
import { finishPush, shouldPushFinish, type AppPresence, type FinishPush } from "./app-chat-active"
import { safeUi } from "./app-chat-relay"
import { extractUiDirective } from "@/channels/ui-directive"
import { ARTIFACT_LIMITS, extractArtifacts, plainAnswer } from "@/utils/artifact-sentinel"

// --- Phone app: answers that arrive after a delegation (#277) ---
//
// When a phone chat's agent hands work to another agent, its turn ends
// with "I asked X". X's answer comes back later as a new turn for the
// agent (a callback, src/a2a/delegation.ts), and that turn's reply belongs
// in the same phone conversation.
//
// The phone's conversations live in this dashboard's chat store, and the
// callback runs in a daemon (the primary one, or a mesh peer). So:
//
//   1. The daemon holds the reply and publishes a small bus event
//      (kind "delegation", type "reply", ref = the delegation id). A peer's
//      event reaches the primary daemon through the mesh feed.
//   2. This dashboard follows the primary daemon's /events/recent for that
//      kind, a bounded read with a cursor.
//   3. For each new event it reads the reply from the node that published
//      it, checks the conversation belongs to that node and agent, and files
//      the reply once (keyed by delegation id). It lands unread, so the
//      strip, banner and speaking queue pick it up, and it gets the same
//      finish notification as any answer, under the phone's `finish` switch.

/** How often the dashboard looks for callback replies. */
export const CALLBACK_POLL_MS = 4_000
/** Events read per poll. */
export const CALLBACK_EVENTS_LIMIT = 100
/** Polls an event is retried when its node or reply can't be read yet. */
export const CALLBACK_RETRIES = 15

export interface CallbackEvent {
  id: string
  node: string
  kind: string
  type: string
  agentId?: string
  ref?: string
  at?: string
}

/** What GET /a2a/delegations/<id>/reply returns. */
export interface CallbackReplyBody {
  taskId: string
  channel: string
  chatId: string
  agent: string
  text: string
  status: "done" | "error"
  plain?: boolean
  at: number
}

export interface CallbackPullDeps {
  /** Delegation events from the primary daemon, oldest first. `since` is
   *  the last event id seen; absent on the first read. Throws when down. */
  recent: (since: string | undefined, limit: number) => Promise<CallbackEvent[]>
  /** The daemon URL of the node that published an event, by its name. */
  nodeUrl: (node: string) => Promise<string | null>
  /** The daemon URL a conversation's agent runs on ("local" or a peer). */
  conversationUrl: (conv: { node: string }) => Promise<string | null>
  /** Read one reply from a node. Null when it has none (expired, unknown). */
  fetchReply: (nodeUrl: string, taskId: string) => Promise<CallbackReplyBody | null>
  store: () => AppChatStore | null
  presence: AppPresence
  /** The phone's "Tell me when an answer finishes" switch, and a way to
   *  reach it. False when this computer sends no pushes. */
  finishAlerts?: (deviceId: string) => boolean
  notifyFinish?: (push: FinishPush) => Promise<void>
  log?: (msg: string) => void
  now?: () => number
}

const norm = (u: string) => u.replace(/\/+$/, "")

export class AppCallbackPuller {
  private cursor: string | undefined
  /** Events whose node or reply could not be read yet → polls left. */
  private retry = new Map<string, { event: CallbackEvent; left: number }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(private deps: CallbackPullDeps) {}

  start(intervalMs = CALLBACK_POLL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    ;(this.timer as any).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One poll. Returns the replies filed in the phone threads. */
  async tick(): Promise<number> {
    if (this.running) return 0
    this.running = true
    try {
      let events: CallbackEvent[]
      try {
        events = await this.deps.recent(this.cursor, CALLBACK_EVENTS_LIMIT)
      } catch {
        return 0 // daemon down; the cursor stays, so nothing is skipped
      }
      if (events.length) this.cursor = events[events.length - 1].id
      const todo = [...this.retry.values()].map((r) => r.event)
      for (const e of events) {
        if (e.kind === "delegation" && e.type === "reply" && typeof e.ref === "string" && e.ref && !this.retry.has(e.id)) todo.push(e)
      }
      let filed = 0
      for (const e of todo) {
        const outcome = await this.file(e).catch(() => "retry" as const)
        if (outcome === "retry") {
          const left = (this.retry.get(e.id)?.left ?? CALLBACK_RETRIES) - 1
          if (left > 0) this.retry.set(e.id, { event: e, left })
          else {
            this.retry.delete(e.id)
            this.deps.log?.(`[app] callback reply ${e.ref} from ${e.node} could not be read; it stays in the agent's session`)
          }
        } else {
          this.retry.delete(e.id)
          if (outcome === "filed") filed++
        }
      }
      return filed
    } finally {
      this.running = false
    }
  }

  private async file(e: CallbackEvent): Promise<"filed" | "skip" | "retry"> {
    const store = this.deps.store()
    if (!store) return "retry"
    const url = await this.deps.nodeUrl(e.node)
    if (!url) return "retry"
    const reply = await this.deps.fetchReply(url, e.ref!)
    if (!reply) return "skip" // expired, or not ours to read
    if (reply.taskId !== e.ref || reply.channel !== "app" || !reply.chatId.startsWith("app:")) return "skip"
    const convId = reply.chatId.slice(4)
    const deviceId = store.ownerOf(convId)
    if (!deviceId) return "skip" // the phone deleted it, or it was never here
    const conv = store.get(deviceId, convId)
    if (!conv) return "skip"
    // A node may only answer for its own agent's conversations.
    const convUrl = await this.deps.conversationUrl(conv)
    if (!convUrl || norm(convUrl) !== norm(url) || conv.agent !== reply.agent) {
      this.deps.log?.(`[app] callback reply ${reply.taskId} from ${e.node} does not match conversation ${convId}; ignored`)
      return "skip"
    }

    const message = toAnswer(reply, this.deps.now?.() ?? Date.now())
    const files = store.appendOnce(deviceId, convId, `dlg:${e.node}:${reply.taskId}`, message.row, message.declared)
    if (files === null) return "skip" // already filed
    const status = message.row.status as "done" | "error"
    const enabled = !!this.deps.finishAlerts?.(deviceId)
    const facts = { status, attached: false, appOpen: this.deps.presence.open(deviceId), enabled }
    if (this.deps.notifyFinish && shouldPushFinish(facts)) {
      this.deps.notifyFinish(finishPush(deviceId, conv, status, message.row.content, message.row.error)).catch(() => {})
    }
    return "filed"
  }
}

/** The stored row for a reply, cleaned the way a streamed answer is: no
 *  agentx:ui block or file lines in the text, files declared separately,
 *  nothing rich for an agent with rich messages off. */
export function toAnswer(reply: CallbackReplyBody, now: number): {
  row: { role: "assistant"; content: string; status: "done" | "error"; error?: string; ui?: any; at: number }
  declared: ReturnType<typeof extractArtifacts>["artifacts"]
} {
  const declared = reply.plain
    ? { text: plainAnswer(reply.text, false), artifacts: [] }
    : extractArtifacts(reply.text, ARTIFACT_LIMITS.perMessage, false)
  const { cleanText, ui } = extractUiDirective(declared.text)
  const safe = reply.plain ? undefined : safeUi(ui)
  const status = reply.status === "error" ? "error" : "done"
  return {
    row: {
      role: "assistant",
      content: cleanText,
      status,
      ...(status === "error" ? { error: firstWords(cleanText) } : {}),
      ...(safe ? { ui: safe } : {}),
      at: now,
    },
    declared: declared.artifacts,
  }
}

function firstWords(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 300)
}

export type { AppFileRef }
