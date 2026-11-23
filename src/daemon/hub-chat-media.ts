import type { IncomingMessage, ServerResponse } from "http"
import type { DaemonTarget } from "./app-chat-relay"
import { SPEAK_INPUT_MAX, isAnswerIn, speakVia, transcribeVia } from "./app-voice"
import { UPLOAD_MAX_BYTES, UPLOAD_PATH } from "./assistant-upload"
import { readRaw } from "./voice-io-api"

// --- The Hub chat's files and voice, on the dashboard (#2101 PR 2, R14) ---
//
//   POST /api/assistant/upload?node=&agent=&name=   a file, kept on the node
//        that runs the agent (assistant-upload.ts does the keeping)
//   POST /api/assistant/voice/transcribe            a recording, written down
//   POST /api/assistant/voice/speak {threadId, node, text}
//        an answer of that conversation, said in its agent's voice
//
// The owner's alone, like every /api/assistant route here: the caller
// checked isDashboardOwner and passes `owner`. Voice goes through the same
// code as the phone app (app-voice.ts transcribeVia / speakVia), so the
// limits, the engines and the agent's voice are the widget's and the
// phone's. Audio and file bytes pass through; none of it is logged.

export const HUB_TRANSCRIBE_PATH = "/api/assistant/voice/transcribe"
export const HUB_SPEAK_PATH = "/api/assistant/voice/speak"

export interface HubChatMediaDeps {
  owner: boolean
  /** The nodes this dashboard reaches, with the token each accepts. */
  targets: () => Promise<DaemonTarget[]>
  /** The daemon this dashboard serves: it holds the speech-to-text setup. */
  daemon: DaemonTarget
}

export function isHubChatMediaPath(path: string): boolean {
  return path === UPLOAD_PATH || path === HUB_TRANSCRIBE_PATH || path === HUB_SPEAK_PATH
}

export async function handleHubChatMedia(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: HubChatMediaDeps): Promise<boolean> {
  if (!isHubChatMediaPath(path)) return false
  if (!deps.owner) { req.resume(); return json(res, 401, { error: "unauthorized" }) }
  if (req.method !== "POST") { req.resume(); return json(res, 405, { error: "POST" }) }
  if (path === HUB_TRANSCRIBE_PATH) return transcribeVia(req, res, deps.daemon)

  let targets: DaemonTarget[]
  try { targets = await deps.targets() } catch { req.resume(); return json(res, 502, { error: "could not reach the node" }) }

  if (path === UPLOAD_PATH) {
    const pick = url.searchParams.get("node")
    const node = pick ? targets.find(n => n.url === pick) : targets[0]
    if (!node) { req.resume(); return json(res, 400, { error: "unknown node" }) }
    const body = await readRaw(req, UPLOAD_MAX_BYTES)
    if (!body) return json(res, 413, { error: `The file is larger than ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB.` })
    const qs = new URLSearchParams({ agent: url.searchParams.get("agent") || "", name: url.searchParams.get("name") || "" })
    try {
      const r = await fetch(`${node.url}${UPLOAD_PATH}?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...auth(node) },
        body: new Uint8Array(body),
      })
      if (r.status === 401) return refused(res, node)
      const out = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
      return json(res, r.status, { ...out, node: node.url })
    } catch (e: any) {
      return json(res, 502, { error: "could not reach the node", message: e?.message || String(e) })
    }
  }

  // Speak: only an answer the conversation holds, in the voice of the
  // agent it belongs to, read on the node that holds it.
  const raw = await readRaw(req, 64 * 1024)
  if (!raw) return json(res, 413, { error: "request too large" })
  let body: any
  try { body = JSON.parse(raw.toString("utf8") || "{}") } catch { return json(res, 400, { error: "expected JSON" }) }
  const text = typeof body?.text === "string" ? body.text.slice(0, SPEAK_INPUT_MAX) : ""
  if (!text.trim()) return json(res, 400, { error: "text is required" })
  const node = typeof body?.node === "string" && body.node ? targets.find(n => n.url === body.node) : targets[0]
  if (!node) return json(res, 400, { error: "unknown node" })
  let conv: any
  try {
    const r = await fetch(`${node.url}/api/assistant/thread?id=${encodeURIComponent(String(body?.threadId ?? ""))}`, { headers: auth(node) })
    if (r.status === 401) return refused(res, node)
    if (!r.ok) return json(res, 404, { error: "no such conversation" })
    conv = await r.json()
  } catch (e: any) {
    return json(res, 502, { error: "could not reach the node", message: e?.message || String(e) })
  }
  const agent = String(conv?.thread?.agentId || "")
  if (!agent || !isAnswerIn(Array.isArray(conv?.messages) ? conv.messages : [], text)) {
    return json(res, 404, { error: "no such answer in this conversation" })
  }
  return speakVia(res, node, agent, text)
}

function auth(node: DaemonTarget): Record<string, string> {
  return node.token ? { Authorization: `Bearer ${node.token}` } : {}
}

/** The owner passed; the node refused this dashboard's token. */
function refused(res: ServerResponse, node: DaemonTarget): true {
  return json(res, 502, { error: "That machine refused this dashboard's token. Give its dashboard.daemons entry a token it accepts.", node: node.url })
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
