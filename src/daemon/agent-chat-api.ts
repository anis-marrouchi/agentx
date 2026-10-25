import type { IncomingMessage, ServerResponse } from "http"

// --- The agent page's chat, through the dashboard (#1163) ---
//
//   POST /api/admin/agent-chat {agent, message} → {content} or {error}
//
// The agent page (/admin/agents/<id>#chat, where `agentx start` lands)
// is served by the dashboard, but its chat posted to /chat and /task on
// the dashboard's own origin, which only the daemon serves: every message
// came back "not found". This forwards one message to the local daemon's
// /task with the dashboard's credential. Mounted below the /api/admin
// token gate, like the other admin routes.

export const AGENT_CHAT_PATH = "/api/admin/agent-chat"

export interface AgentChatDeps {
  daemonUrl: string
  token?: string
  readBody: (req: IncomingMessage) => Promise<any>
  fetch?: typeof fetch
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
  return true
}

export async function handleAgentChatApi(req: IncomingMessage, res: ServerResponse, path: string, deps: AgentChatDeps): Promise<boolean> {
  if (path !== AGENT_CHAT_PATH || req.method !== "POST") return false
  const body = (await deps.readBody(req).catch(() => null)) || {}
  const agent = typeof body.agent === "string" ? body.agent : ""
  const message = typeof body.message === "string" ? body.message.trim() : ""
  if (!agent || !message) return send(res, 400, { error: "agent and message are required" })
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (deps.token) headers["Authorization"] = `Bearer ${deps.token}`
  try {
    const r = await (deps.fetch ?? fetch)(deps.daemonUrl.replace(/\/+$/, "") + "/task", {
      method: "POST",
      headers,
      body: JSON.stringify({ agent, message, context: { channel: "test-drive", sender: "admin-ui" } }),
      // A first reply from a CLI engine can take a minute or more.
      signal: AbortSignal.timeout(10 * 60_000),
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok || data.error) return send(res, r.ok ? 502 : r.status, { error: String(data.error || `daemon /task HTTP ${r.status}`) })
    return send(res, 200, { content: String(data.content ?? "") })
  } catch (e: any) {
    return send(res, 502, { error: `The daemon did not answer: ${e?.message || e}. Is it running? Try: agentx start` })
  }
}
