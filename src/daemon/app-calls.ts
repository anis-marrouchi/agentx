import type { IncomingMessage, ServerResponse } from "http"
import type { TokenRecord } from "./token-store"
import type { AppVoiceDeps } from "./app-voice"
import { relay } from "./app-camera"
import { readRaw } from "./voice-io-api"

// --- Phone app: answer an agent's voice call (/api/app/calls/*, #1605) ---
//
// Runs behind the device-token check in app-routes.ts. A voice call an
// agent places rings the phone with a call push that opens /app#call=<id>;
// the app also polls the ringing calls while it is on screen. Answering
// goes through the daemon's own /calls/:id/answer, so the first device to
// pick up (the phone or the AgentX Voice widget) takes the call and the
// other stops ringing. The phone then sends the opener as the first turn
// of a new conversation with that agent, so the agent speaks first.
//
// Only calls of the daemon this dashboard serves are answered here. The
// list returns a bounded summary of each call, never its full record.
//
//   GET  /api/app/calls                  voice calls ringing now, oldest first
//   GET  /api/app/calls/:id              one call
//   POST /api/app/calls/:id/answer       {call, opener}
//   POST /api/app/calls/:id/decline
//   POST /api/app/calls/:id/hangup       {conversationId?}: the conversation
//                                        it was answered in, for the summary

const CALL_ID = /^[A-Za-z0-9_-]{4,64}$/
const CONVERSATION_ID = /^c[a-z0-9]{8,32}$/

/** What the phone sees of a call. */
export interface PhoneCall {
  id: string
  agentId: string
  reason: string
  urgency: "urgent" | "normal"
  status: string
  ringingSince: number | null
}

export function phoneCall(c: any): PhoneCall {
  return {
    id: String(c?.id ?? ""), agentId: String(c?.agentId ?? ""), reason: String(c?.reason ?? "").slice(0, 200),
    urgency: c?.urgency === "urgent" ? "urgent" : "normal", status: String(c?.status ?? ""),
    ringingSince: typeof c?.ringingSince === "number" ? c.ringingSince : null,
  }
}

/** Voice calls an agent placed that ring now, oldest first. A call the
 *  owner placed from the dashboard rings the widget only. */
export function ringingForPhone(calls: unknown): PhoneCall[] {
  return (Array.isArray(calls) ? calls : [])
    .filter((c: any) => c && c.kind === "voice" && c.status === "ringing" && c.placedBy !== "owner" && c.ringingSince !== null)
    .map(phoneCall)
    .reverse()
}

export async function handleAppCalls(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: TokenRecord,
  deps: AppVoiceDeps,
): Promise<boolean> {
  if (path !== "/api/app/calls" && !path.startsWith("/api/app/calls/")) return false
  const base = deps.daemon.url.replace(/\/+$/, "")
  const auth: Record<string, string> = deps.daemon.token ? { Authorization: `Bearer ${deps.daemon.token}` } : {}

  if (path === "/api/app/calls") {
    if (method !== "GET") return json(res, 405, { error: "GET" })
    const r = await relay(base, auth, "GET", "/calls?status=ringing&kind=voice&limit=20")
    if (r.status >= 300) return json(res, r.status, { error: r.body.error })
    return json(res, 200, { calls: ringingForPhone(r.body.calls) })
  }

  const m = /^\/api\/app\/calls\/([^/]+)(?:\/(answer|decline|hangup))?$/.exec(path)
  if (!m || !CALL_ID.test(m[1])) return json(res, 404, { error: "not found" })
  const [, id, action] = m
  if (!action) {
    if (method !== "GET") return json(res, 405, { error: "GET" })
    const r = await relay(base, auth, "GET", `/calls/${id}`)
    if (r.status >= 300) return json(res, r.status, { error: r.body.error })
    if (r.body.call?.kind !== "voice") return json(res, 404, { error: "no such call" })
    return json(res, 200, { call: phoneCall(r.body.call) })
  }
  if (method !== "POST") return json(res, 405, { error: "POST" })

  let body: Record<string, unknown> = {}
  if (action === "hangup") {
    const raw = await readRaw(req, 4 * 1024)
    if (!raw) return json(res, 413, { error: "request too large" })
    try { body = JSON.parse(raw.toString("utf8") || "{}") } catch { return json(res, 400, { error: "expected JSON" }) }
  } else {
    req.resume()
  }
  const upstream: Record<string, unknown> = {}
  if (action === "hangup" && typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId)) {
    // Only a conversation of this phone, with the agent that called.
    const conv = deps.store()?.get(device.id, body.conversationId)
    const call = conv && conv.node === "local" ? await relay(base, auth, "GET", `/calls/${id}`) : null
    if (conv && call && call.status < 300 && call.body.call?.agentId === conv.agent) {
      Object.assign(upstream, { channel: "app", chatId: `app:${conv.id}` })
    }
  }
  const r = await relay(base, auth, "POST", `/calls/${id}/${action}`, upstream)
  if (r.status >= 300) return json(res, r.status, { error: r.body.error })
  return json(res, 200, { call: phoneCall(r.body.call), ...(typeof r.body.opener === "string" ? { opener: r.body.opener } : {}) })
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
