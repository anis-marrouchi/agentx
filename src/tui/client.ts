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
