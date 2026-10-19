import { callerHeaders } from "@/calls/service"
import { NOTE_LIMITS } from "./notes-api"

// --- agentx_note: an idea for the owner, as a note in their notes app ---
//
// The MCP side of POST /native/notes (#1062). The daemon checks the switch,
// the caller and the daily limit; this only shapes the call and the answer.

export async function runNoteTool(
  args: Record<string, unknown>,
  deps: { daemonUrl: string; fetch?: typeof fetch; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const env = deps.env ?? process.env
  const title = typeof args.title === "string" ? args.title.trim() : ""
  const body = typeof args.body === "string" ? args.body.trim() : ""
  if (!title || !body) return "Error: title and body are required."
  if (title.length > NOTE_LIMITS.title) return `Error: title is at most ${NOTE_LIMITS.title} characters.`
  if (body.length > NOTE_LIMITS.body) return `Error: body is at most ${NOTE_LIMITS.body} characters.`
  const agentId = env.AGENTX_AGENT_ID || (typeof args.callerAgentId === "string" ? args.callerAgentId : "")
  try {
    const res = await (deps.fetch ?? fetch)(`${deps.daemonUrl.replace(/\/+$/, "")}/native/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...callerHeaders(env) },
      body: JSON.stringify({ title, body, agentId }),
      signal: AbortSignal.timeout(45_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (res.status === 201) return `Added to the owner's notes, folder "${data.folder ?? "AgentX"}". Don't also send the idea in chat.`
    return `Error: ${data?.error || `HTTP ${res.status}`}`
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
