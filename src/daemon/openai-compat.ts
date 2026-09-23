import type { IncomingMessage, ServerResponse } from "http"
import type { AgentTask, AgentResponse, StreamCallback } from "@/agents/runtime"
import type { SeededMessage } from "@/channels/types"

// OpenAI-compatible chat endpoint (POST /v1/chat/completions). Used by
// OpenCode, ElevenLabs, Cursor and plain SDK clients. The AgentX agent runs
// its own tools; this layer only relays what the agent produces:
//   - assistant text              → delta.content
//   - thinking + tool activity    → delta.reasoning_content (OpenCode shows
//                                   it as "Thinking" while the agent works)

type Execute = (
  task: AgentTask,
  onDelta?: StreamCallback,
  onThinking?: (text: string) => void,
  onEvent?: (event: any) => void,
) => Promise<AgentResponse>

export interface OpenAICompatDeps {
  execute: Execute
  agentIds: string[]
  /** Abort the running task for (agentId, channel, chatId) when the client goes away. */
  cancel: (agentId: string, channel: string, chatId: string, reason: string) => void
  log: (msg: string) => void
}

interface ChatMessage { role: string; content?: unknown }

const HEARTBEAT_MS = 15_000
const TITLE_PROMPT = /^You are a title generator\b/

/** OpenAI content is a string or an array of parts; tool/assistant turns may be null. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: any) => (typeof part === "string" ? part : part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
}

/** OpenCode asks its model for a thread title in a separate request. That
 *  is harness bookkeeping, not work for the agent: answering it with an
 *  agent turn costs a full run and lands the prompt in the agent's session. */
export function isTitleRequest(messages: ChatMessage[]): boolean {
  return messages.some(m => m.role === "system" && TITLE_PROMPT.test(messageText(m.content).trimStart()))
}

const SEED_MESSAGE_CHARS = 4000

/** The client's transcript before the current prompt, as session seeds.
 *  Used only when AgentX has no session for this conversation yet (first
 *  turn after an upgrade, restart with a new key, daily rotation). */
export function transcriptSeeds(messages: ChatMessage[], upTo: number, agentId: string): SeededMessage[] {
  const now = new Date().toISOString()
  return messages.slice(0, upTo).flatMap((m): SeededMessage[] => {
    if (m.role !== "user" && m.role !== "assistant") return []
    const text = messageText(m.content).trim()
    if (!text) return []
    return [{
      role: m.role === "user" ? "user" : "agent",
      name: m.role === "user" ? "User" : agentId,
      content: clip(text, SEED_MESSAGE_CHARS),
      timestamp: now,
    }]
  })
}

export function titleFrom(text: string): string {
  const line = text.replace(/^["'\s]+|["'\s]+$/g, "").split(/\r?\n/).find(l => l.trim()) || "New session"
  const clean = line.replace(/\s+/g, " ").trim()
  return clean.length > 50 ? `${clean.slice(0, 49).trimEnd()}…` : clean
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Map a stream-json event to reasoning text; tool calls read like a terminal log. */
export function makeReasoningFormatter(): (event: any) => string {
  return (event: any) => {
    if (!event || typeof event !== "object") return ""
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      let out = ""
      for (const block of event.message.content) {
        if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          out += `${block.thinking.trim()}\n\n`
        } else if (block?.type === "tool_use") {
          const input = block.input ? clip(JSON.stringify(block.input), 300) : ""
          out += `→ ${block.name || "tool"}(${input})\n`
        }
      }
      return out
    }
    if (event.type === "user" && Array.isArray(event.message?.content)) {
      let out = ""
      for (const block of event.message.content) {
        if (block?.type !== "tool_result") continue
        const text = Array.isArray(block.content)
          ? block.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
          : typeof block.content === "string" ? block.content : ""
        out += `${block.is_error ? "← [error] " : "← "}${clip(text.trim().replace(/\s+/g, " "), 200)}\n\n`
      }
      return out
    }
    return ""
  }
}

export async function handleOpenAICompat(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: Record<string, unknown>,
  deps: OpenAICompatDeps,
): Promise<void> {
  const pathMatch = path.match(/^\/llm\/([^/]+)\//)
  const agentId = pathMatch?.[1] || (typeof body.model === "string" ? body.model : "") || deps.agentIds[0] || "default"
  const messages = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[]
  const lastUser = [...messages].reverse().find(m => m.role === "user")
  const prompt = messageText(lastUser?.content).trim()
  const stream = body.stream === true
  const requestId = `chatcmpl-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)

  if (!prompt) {
    sendJson(res, 400, { error: { message: "No user message found", type: "invalid_request_error" } })
    return
  }

  // A session header keys the agent conversation per client session, so
  // separate OpenCode sessions no longer share one Claude process and
  // queue behind each other. The agent's own session carries continuity.
  const sessionHeader = req.headers["x-opencode-session"] || req.headers["x-session-id"]
  const sessionId = typeof sessionHeader === "string" && sessionHeader.trim() ? sessionHeader.trim() : undefined
  const channel = sessionId ? "opencode" : "api"
  const chatId = sessionId || "openai-compat"

  if (isTitleRequest(messages)) {
    const title = titleFrom(prompt)
    if (stream) {
      startStream(res)
      writeChunk(res, requestId, created, agentId, { role: "assistant", content: title }, "stop")
      res.end("data: [DONE]\n\n")
    } else {
      sendCompletion(res, requestId, created, agentId, title)
    }
    return
  }

  // Clients without a session id only send the transcript; fold the
  // recent turns into the prompt so the agent sees the conversation.
  let message = prompt
  if (!sessionId) {
    const history = messages
      .slice(0, messages.lastIndexOf(lastUser!))
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${messageText(m.content).slice(0, 200)}`)
      .filter(line => !line.endsWith(": "))
    if (history.length) message = `[Conversation]\n${history.slice(-10).join("\n")}\n\n${prompt}`
  }

  const task: AgentTask = {
    agentId, message,
    context: { channel, sender: sessionId ? "opencode" : "openai-compat", chatId },
    // OpenCode owns the conversation; AgentX seeds from it only when its own
    // session is empty, and resumed sessions carry continuity natively.
    ...(sessionId ? { seedHistory: transcriptSeeds(messages, messages.lastIndexOf(lastUser!), agentId) } : {}),
  }

  if (!stream) {
    const response = await deps.execute(task)
    if (response.error) {
      sendJson(res, 502, { error: { message: response.error, type: "upstream_error" } })
      return
    }
    sendCompletion(res, requestId, created, agentId, response.content || "", response)
    return
  }

  startStream(res)
  let closed = false
  let finished = false
  const send = (delta: Record<string, unknown>, finish: string | null = null) => {
    if (!closed) writeChunk(res, requestId, created, agentId, delta, finish)
  }
  send({ role: "assistant" })
  // Comment lines keep the connection alive through long tool runs; SSE
  // parsers ignore them.
  const heartbeat = setInterval(() => { if (!closed) res.write(": ping\n\n") }, HEARTBEAT_MS)
  res.on("close", () => {
    closed = true
    clearInterval(heartbeat)
    if (!finished) deps.cancel(agentId, channel, chatId, "client disconnected")
  })

  const reasoning = makeReasoningFormatter()
  let streamedContent = false
  try {
    const response = await deps.execute(
      task,
      (delta) => { if (delta) { streamedContent = true; send({ content: delta }) } },
      (text) => { if (text) send({ reasoning_content: text }) },
      (event) => { const text = reasoning(event); if (text) send({ reasoning_content: text }) },
    )
    finished = true
    if (response.error) {
      // Visible text, not an SSE error object: OpenCode retries stream
      // errors, and retrying would re-run an agent turn with side effects.
      send({ content: `${streamedContent ? "\n\n" : ""}[error] ${response.error}` }, "stop")
    } else {
      if (!streamedContent && response.content) send({ content: response.content })
      send({}, "stop")
      if (response.usage && !closed) {
        const prompt_tokens = response.usage.inputTokens || 0
        const completion_tokens = response.usage.outputTokens || 0
        res.write(`data: ${JSON.stringify({
          id: requestId, object: "chat.completion.chunk", created, model: agentId, choices: [],
          usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
        })}\n\n`)
      }
    }
  } catch (e: any) {
    finished = true
    deps.log(`[openai-compat] ${agentId} failed: ${e?.message || e}`)
    send({ content: `[error] ${e?.message || String(e)}` }, "stop")
  } finally {
    clearInterval(heartbeat)
    if (!closed) res.end("data: [DONE]\n\n")
  }
}

function startStream(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
}

function writeChunk(res: ServerResponse, id: string, created: number, model: string, delta: Record<string, unknown>, finish: string | null): void {
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
}

function sendCompletion(res: ServerResponse, id: string, created: number, model: string, content: string, response?: AgentResponse): void {
  const prompt_tokens = response?.usage?.inputTokens ?? 0
  const completion_tokens = response?.usage?.outputTokens ?? Math.ceil(content.length / 4)
  sendJson(res, 200, {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  })
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}
