import { loadDaemonConfig } from "@/daemon/config"

// Resolved connection details for the daemon, derived from --node/--token
// CLI flags first, then daemon config's `dashboard` block, then localhost.
export interface DaemonConn {
  baseUrl: string
  token: string
}

export function resolveConn(opts: { node?: string; token?: string; config?: string }): DaemonConn {
  let baseUrl = typeof opts.node === "string" ? opts.node : ""
  let token = typeof opts.token === "string" ? opts.token : ""
  if (!baseUrl || !token) {
    try {
      const cfg = loadDaemonConfig(opts.config)
      if (!baseUrl) baseUrl = cfg.dashboard?.daemonUrl || ""
      if (!token) token = cfg.dashboard?.token || ""
    } catch {
      // No config — fall back to localhost.
    }
  }
  if (!baseUrl) baseUrl = "http://localhost:18800"
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token }
}

async function get<T>(conn: DaemonConn, path: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (conn.token) headers["Authorization"] = `Bearer ${conn.token}`
  const res = await fetch(`${conn.baseUrl}${path}`, { headers, signal })
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

export interface AgentRow {
  id: string
  name: string
  tier: string
  model?: string
  workspace: string
  active: number
  total: number
  errors: number
  lastActive?: string
}

export interface ProcessRow {
  key: { agentId: string; channel: string; chatId: string }
  pid: number | null
  state: string
  spawnedAt: number
  lastTurnAt: number
  turnCount: number
}

export interface CronRow {
  id: string
  enabled: boolean
  schedule: string
  agent: string
  nextRun?: string
  lastError?: string
  consecutiveErrors: number
}

export function fetchAgents(conn: DaemonConn, signal?: AbortSignal): Promise<AgentRow[]> {
  return get<AgentRow[]>(conn, "/agents", signal)
}

export async function fetchProcesses(conn: DaemonConn, signal?: AbortSignal): Promise<ProcessRow[]> {
  const r = await get<{ processes: ProcessRow[] }>(conn, "/api/processes", signal)
  return r.processes ?? []
}

export function fetchCrons(conn: DaemonConn, signal?: AbortSignal): Promise<CronRow[]> {
  return get<CronRow[]>(conn, "/crons", signal)
}

async function post<T>(conn: DaemonConn, path: string, body: any, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  }
  if (conn.token) headers["Authorization"] = `Bearer ${conn.token}`
  const res = await fetch(`${conn.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  let parsed: any
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
  if (!res.ok) throw new Error(parsed?.error || `POST ${path} → HTTP ${res.status}`)
  return parsed as T
}

export function killProcess(
  conn: DaemonConn,
  key: { agentId: string; channel: string; chatId: string },
  reason = "tui",
): Promise<{ killed: { agentId: string; channel: string; chatId: string } }> {
  return post(conn, "/api/processes/kill", { ...key, reason })
}

export interface TaskResponse {
  content?: string
  error?: string
  [k: string]: any
}

export function sendTask(
  conn: DaemonConn,
  agentId: string,
  message: string,
  context?: { channel?: string; chatId?: string },
): Promise<TaskResponse> {
  return post<TaskResponse>(conn, "/task", {
    agent: agentId,
    message,
    context: context ?? { channel: "tui", chatId: "tui:operator" },
  })
}

/** Live task events surfaced to a streaming client. Mirrors the daemon's
 *  `POST /task` SSE wire (src/daemon/index.ts): `text` deltas, `thinking`
 *  deltas, and `tool` badges (start/result). */
export interface StreamTaskHandlers {
  onText?: (text: string) => void
  onThinking?: (text: string) => void
  onTool?: (t: { status: "start" | "result"; id?: string; name?: string; error?: boolean; arg?: string }) => void
}

export interface StreamTaskResult {
  content: string
  usage?: Record<string, number>
  duration?: number
  error?: string
  errorKind?: string
}

/**
 * Stream a task turn over SSE. POSTs `/task` with `Accept: text/event-stream`,
 * parses `event:/data:` frames, and invokes the handlers as tokens and tool
 * events arrive. Resolves with the final `done` payload (or an `error`).
 * Reuses the same (channel, chatId) warm-process semantics as sendTask.
 */
export async function streamTask(
  conn: DaemonConn,
  agentId: string,
  message: string,
  opts: { channel?: string; chatId?: string; signal?: AbortSignal } & StreamTaskHandlers = {},
): Promise<StreamTaskResult> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  }
  if (conn.token) headers["Authorization"] = `Bearer ${conn.token}`

  const res = await fetch(`${conn.baseUrl}/task`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      message,
      stream: true,
      context: { channel: opts.channel ?? "chat-cli", chatId: opts.chatId ?? "chat-cli:operator" },
    }),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "")
    throw new Error(`POST /task (stream) → HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`)
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const result: StreamTaskResult = { content: "" }
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const parsed = parseSseFrame(frame)
        if (!parsed) continue
        applyFrame(parsed, opts, result)
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }
  return result
}

function applyFrame(
  frame: { event: string; data: any },
  handlers: StreamTaskHandlers,
  result: StreamTaskResult,
): void {
  const { event, data } = frame
  switch (event) {
    case "text":
      if (data?.text) { result.content += data.text; handlers.onText?.(data.text) }
      break
    case "thinking":
      if (data?.text) handlers.onThinking?.(data.text)
      break
    case "tool":
      handlers.onTool?.(data)
      break
    case "done":
      if (typeof data?.content === "string") result.content = data.content
      result.usage = data?.usage
      result.duration = data?.duration
      break
    case "error":
      result.error = data?.error
      result.errorKind = data?.errorKind
      break
  }
}

/** Parse one `event:/data:` SSE frame. Ignores comment/heartbeat lines. */
function parseSseFrame(frame: string): { event: string; data: any } | null {
  let event = "message"
  let data = ""
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim()
    else if (line.startsWith("data: ")) data = line.slice(6)
  }
  if (!data) return null
  let payload: any
  try { payload = JSON.parse(data) } catch { payload = data }
  return { event, data: payload }
}
