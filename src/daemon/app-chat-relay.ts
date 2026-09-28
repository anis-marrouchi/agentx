import { extractUiDirective, type UiDirective } from "@/channels/ui-directive"
import type { AppToolBadge } from "./app-chat-store"
import { ARTIFACT_LIMITS, extractArtifacts, type DeclaredArtifact } from "@/utils/artifact-sentinel"

// --- Phone app chat: one turn, relayed from the daemon ---
//
// The dashboard never runs an agent itself. A turn goes to the daemon this
// dashboard serves: POST /task for its own agents, POST /mesh/task for an
// agent on a mesh peer (that daemon forwards with its own peer credentials).
// Both answer with the agentx SSE wire (start, text, thinking, tool, done,
// error). Every event is passed to the phone unchanged as it arrives; what
// the turn produced is gathered on the side so it can be saved.

export interface DaemonTarget { url: string; token?: string }

export interface TurnRequest {
  /** "local" or the mesh peer's name. */
  node: string
  agent: string
  message: string
  /** Session key: the daemon resumes the same agent session per chat id. */
  chatId: string
}

export interface TurnOutcome {
  status: "done" | "error" | "stopped"
  /** The reply without its agentx:ui block and <agentx-artifact> lines. */
  text: string
  ui?: UiDirective
  /** Files the reply declared, not yet checked or registered. */
  files: DeclaredArtifact[]
  error?: string
  tools: AppToolBadge[]
}

const MAX_TOOLS = 50
const QUICK_REPLIES = 4
const MAX_REPLY = 500

/** The upstream path and body for one turn. */
export function upstreamRequest(t: TurnRequest): { path: string; body: Record<string, unknown> } {
  const context = { channel: "app", chatId: t.chatId }
  return t.node === "local"
    ? { path: "/task", body: { agent: t.agent, message: t.message, stream: true, context } }
    : { path: "/mesh/task", body: { peer: t.node, agent: t.agent, message: t.message, stream: true, context } }
}

/** Runs one turn and hands every upstream event to `send` as it comes.
 *  Never throws: every way a turn can end is an outcome to save. Aborting
 *  `signal` drops the upstream connection, which the daemon treats as an
 *  interrupt and stops the run. */
export async function relayTurn(
  daemon: DaemonTarget,
  turn: TurnRequest,
  signal: AbortSignal,
  send: (event: string, data: unknown) => void,
): Promise<TurnOutcome> {
  const { path, body } = upstreamRequest(turn)
  let text = ""
  const tools: AppToolBadge[] = []
  const byId = new Map<string, AppToolBadge>()
  const end = (status: TurnOutcome["status"], raw: string, error?: string, rich = true): TurnOutcome => {
    // Declared files come out of every answer, even a stopped one, so a
    // sentinel is never shown or read out.
    const declared = extractArtifacts(raw, ARTIFACT_LIMITS.perMessage)
    const { cleanText, ui } = status === "done" ? extractUiDirective(declared.text) : { cleanText: declared.text, ui: undefined }
    // An agent with richMessages off still has the block stripped, but
    // nothing from it is shown.
    const safe = rich ? safeUi(ui) : undefined
    return { status, text: cleanText, tools, files: declared.artifacts, ...(safe ? { ui: safe } : {}), ...(error ? { error } : {}) }
  }
  try {
    const r = await fetch(daemon.url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!r.ok || !r.body) {
      const detail = await r.json().then((j: any) => j?.error).catch(() => "")
      return end("error", text, detail || `AgentX answered HTTP ${r.status}.`)
    }
    for await (const ev of readSse(r.body)) {
      send(ev.event, ev.data)
      const d = ev.data ?? {}
      if (ev.event === "text" && typeof d.text === "string") {
        text += d.text
      } else if (ev.event === "tool" && d.status === "start" && tools.length < MAX_TOOLS) {
        const badge: AppToolBadge = { name: String(d.name || "tool").slice(0, 80), ...(d.arg ? { arg: String(d.arg).slice(0, 80) } : {}) }
        tools.push(badge)
        if (d.id) byId.set(String(d.id), badge)
      } else if (ev.event === "tool" && d.status === "result" && d.error === true && byId.has(String(d.id))) {
        byId.get(String(d.id))!.error = true
      } else if (ev.event === "done") {
        return end("done", typeof d.content === "string" && d.content ? d.content : text, undefined, d.richMessages !== false)
      } else if (ev.event === "error") {
        return end("error", text, friendlyError(d.error))
      }
    }
    return signal.aborted
      ? end("stopped", text)
      : end("error", text, "The connection to the agent closed before it answered.")
  } catch (e: any) {
    if (signal.aborted) return end("stopped", text)
    return end("error", text, `Could not reach AgentX: ${e?.message || e}`)
  }
}

function friendlyError(e: unknown): string {
  const s = String(e || "The agent could not answer.")
  // An older node queues a busy agent's message instead of waiting, and its
  // answer then has nowhere to go.
  if (s.startsWith("__queued__")) return "The agent is busy with other work. Send the message again when it is free."
  return s.slice(0, 500)
}

/** What the phone may render: web links only, and bounded sizes. The page
 *  escapes everything as well; this keeps stored rows small and clean. */
export function safeUi(ui: UiDirective | undefined): UiDirective | undefined {
  if (!ui) return undefined
  const web = (u: string) => /^https?:\/\//i.test(u) && u.length <= 2048
  const out: UiDirective = {}
  const buttons = (ui.buttons ?? []).filter((b) => web(b.url)).slice(0, 8).map((b) => ({ label: b.label.slice(0, 80), url: b.url }))
  if (buttons.length) out.buttons = buttons
  if (ui.poll) {
    out.poll = {
      question: ui.poll.question.slice(0, 300),
      options: ui.poll.options.slice(0, 10).map((o) => o.slice(0, 100)),
      multiple: ui.poll.multiple === true,
    }
  }
  if (ui.media && web(ui.media.url)) {
    out.media = { type: ui.media.type, url: ui.media.url, ...(ui.media.caption ? { caption: ui.media.caption.slice(0, 300) } : {}) }
  }
  // A tap sends the text as the user's message: at most 4 of each, and the
  // page clips long labels on screen while the full text is sent.
  const chips = (ui.quickReplies ?? []).slice(0, QUICK_REPLIES).map((q) => q.slice(0, MAX_REPLY))
  if (chips.length) out.quickReplies = chips
  const replies = (ui.replies ?? []).slice(0, QUICK_REPLIES).map((r) => ({ label: r.label.slice(0, 80), reply: r.reply.slice(0, MAX_REPLY) }))
  if (replies.length) out.replies = replies
  return Object.keys(out).length ? out : undefined
}

/** Parses the agentx SSE wire: `event: <kind>\ndata: <json>\n\n`. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let sep: number
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const record = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        let event = "message"
        const data: string[] = []
        for (const line of record.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim()
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
        }
        if (!data.length) continue
        try { yield { event, data: JSON.parse(data.join("\n")) } } catch { /* skip a malformed record */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
