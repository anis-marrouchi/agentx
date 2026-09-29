// Calls an agent places to the owner, over HTTP (src/calls, #321).
//
//   POST /calls                 {agentId, reason, urgency?: "urgent"}
//                               with X-AgentX-Task, or X-AgentX-Channel +
//                               X-AgentX-Chat: a running turn of agentId
//                               201 ringing {call, rang}; 202 held as a
//                               missed call (Focus) {call, rang: false};
//                               403 no such running turn, or not in
//                               calls.allow; 409 one already in
//                               progress; 429 over calls.maxPerHour
//   GET  /calls?status=&limit=  newest first; status is a comma list
//   GET  /calls/ringing         the widget's poll: {calls, ringSound,
//                               ringSeconds}. Polling marks the widget alive.
//   GET  /calls/:id
//   POST /calls/:id/answer      200 {call, opener}: the widget sends the
//                               opener through /ask so the agent speaks first
//   POST /calls/:id/decline
//   POST /calls/:id/later       {minutes?}: rings again then (default 10)
//   POST /calls/:id/hangup      ends it; the summary follows in the background
//
// All of it is mesh-gated (isMeshGatedPath): reasons are agent-written text,
// and placing or answering a call makes this host ring and speak.

import type { CallerProof, CallService } from "@/calls/service"
import type { CallStatus } from "@/calls/store"
import type { CallsConfig } from "@/daemon/config"
import type { Reply } from "@/daemon/voice-talk-api"

const STATUSES: CallStatus[] = ["ringing", "answered", "ended", "declined", "missed", "later"]

export function isCallsPath(path: string): boolean {
  return path === "/calls" || path.startsWith("/calls/")
}

export async function handleCalls(
  calls: CallService,
  config: () => CallsConfig,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  proof: CallerProof = {},
): Promise<Reply> {
  if (path === "/calls") {
    if (method === "POST") {
      const r = await calls.request(body, proof)
      if (!r.ok) return { status: r.status, body: { error: r.error } }
      return { status: r.rang === false ? 202 : 201, body: { call: r.call, rang: r.rang } }
    }
    if (method !== "GET") return { status: 405, body: { error: "GET or POST" } }
    await calls.sweep()
    const status = (query.get("status") || "").split(",").filter((s): s is CallStatus => STATUSES.includes(s as CallStatus))
    const limit = parseInt(query.get("limit") || "", 10)
    return { status: 200, body: { calls: calls.list({ status, limit: Number.isFinite(limit) ? limit : undefined }) } }
  }

  if (path === "/calls/ringing") {
    if (method !== "GET") return { status: 405, body: { error: "GET" } }
    const cfg = config()
    return { status: 200, body: { calls: await calls.ringing(), ringSound: cfg.ringSound, ringSeconds: cfg.ringSeconds } }
  }

  // Call ids are plain ASCII ("call-1a2b3c4d"): no decoding needed.
  const [, , id, action, extra] = path.split("/")
  if (!id || extra !== undefined) return notFound
  if (action === undefined) {
    if (method !== "GET") return { status: 405, body: { error: "GET" } }
    const call = calls.get(id)
    return call ? { status: 200, body: { call } } : { status: 404, body: { error: `No such call: ${id}` } }
  }
  if (method !== "POST") return { status: 405, body: { error: "POST" } }
  switch (action) {
    case "answer": {
      const r = calls.answer(id)
      return r.ok ? { status: 200, body: { call: r.call, opener: r.opener } } : { status: r.status, body: { error: r.error } }
    }
    case "decline": return reply(calls.decline(id))
    case "later": return reply(calls.later(id, body.minutes))
    case "hangup": return reply(calls.hangup(id))
    default: return notFound
  }
}

const notFound: Reply = { status: 404, body: { error: "Not found" } }

function reply(r: ReturnType<CallService["decline"]>): Reply {
  return r.ok ? { status: 200, body: { call: r.call } } : { status: r.status, body: { error: r.error } }
}
