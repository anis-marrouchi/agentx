// Calls an agent places to the owner, over HTTP (src/calls, #321).
//
//   POST /calls                 {agentId, reason, urgency?: "urgent",
//                               kind?: "camera"}
//                               with X-AgentX-Task, or X-AgentX-Channel +
//                               X-AgentX-Chat: a running turn of agentId
//                               201 ringing {call, rang}, or waiting
//                               for a busy owner {call, rang: "waiting",
//                               busy: {why, with, remindAt, waitsUntil}};
//                               202 held as a missed call (Focus)
//                               {call, rang: false};
//                               403 no such running turn, or not in
//                               calls.allow; 409 one already in
//                               progress; 429 over calls.maxPerHour
//   POST /calls/owner           {agentId, reason}: the owner asks the agent
//                               to talk (a Wall post's Call, #1316). Only
//                               with the operator key (`owner`): 201 ringing,
//                               403 without the key, 404 no such agent here,
//                               409 one already in progress, 429 over the limit
//   POST /calls/cancel          {agentId}, same proof: the caller withdraws
//                               its voice call that waits or rings
//                               200 {call}; 404 it has none
//   GET  /calls?status=&kind=&limit=  newest first; status is a comma list
//   GET  /calls/ringing?busy=1&showing=<id>
//                               the widget's poll: voice calls {calls,
//                               ringSound, ringSeconds}. Polling marks the
//                               widget alive. busy: it cannot ring a new
//                               call now; showing: the call ringing on it.
//                               A call it is not showing waits while busy.
//   GET  /calls/asking          the phone app's poll: camera asks waiting
//                               for the owner {calls, ringSeconds}
//   GET  /calls/:id
//   POST /calls/:id/answer      200 {call, opener}: the widget sends the
//                               opener through /ask so the agent speaks first
//   POST /calls/:id/decline
//   POST /calls/:id/later       {minutes?}: rings again then (default 10)
//   POST /calls/:id/hangup      ends it; the summary follows in the background.
//                               {channel: "app", chatId: "app:<conv>"}: it was
//                               answered on the phone, in that conversation
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
  /** The request showed this node's operator key: it is the owner's. */
  owner = false,
): Promise<Reply> {
  if (path === "/calls/owner") {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    if (!owner) return { status: 403, body: { error: "Only the owner's own surfaces (the dashboard) place a call to an agent." } }
    const r = await calls.ownerCall(body)
    if (!r.ok) return { status: r.status, body: { error: r.error } }
    return { status: 201, body: { call: r.call, rang: r.rang, ...(r.busy ? { busy: r.busy } : {}) } }
  }
  if (path === "/calls") {
    if (method === "POST") {
      const r = await calls.request(body, proof)
      if (!r.ok) return { status: r.status, body: { error: r.error } }
      return { status: r.rang === false ? 202 : 201, body: { call: r.call, rang: r.rang, ...(r.busy ? { busy: r.busy } : {}) } }
    }
    if (method !== "GET") return { status: 405, body: { error: "GET or POST" } }
    await calls.sweep()
    const status = (query.get("status") || "").split(",").filter((s): s is CallStatus => STATUSES.includes(s as CallStatus))
    const kindParam = query.get("kind")
    const kind = kindParam === "voice" || kindParam === "camera" ? kindParam : undefined
    const limit = parseInt(query.get("limit") || "", 10)
    return { status: 200, body: { calls: calls.list({ status, kind, limit: Number.isFinite(limit) ? limit : undefined }) } }
  }

  if (path === "/calls/cancel") {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    return reply(await calls.cancel(body, proof))
  }

  if (path === "/calls/ringing") {
    if (method !== "GET") return { status: 405, body: { error: "GET" } }
    const cfg = config()
    return { status: 200, body: { calls: await calls.ringing({ busy: query.get("busy") === "1", showing: query.get("showing") || undefined }), ringSound: cfg.ringSound, ringSeconds: cfg.ringSeconds } }
  }

  if (path === "/calls/asking") {
    if (method !== "GET") return { status: 405, body: { error: "GET" } }
    return { status: 200, body: { calls: await calls.asking(), ringSeconds: config().ringSeconds } }
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
    case "hangup": return reply(calls.hangup(id, appSession(body)))
    default: return notFound
  }
}

/** A hang-up from the phone app names the conversation the call was in
 *  (#1605), so the agent summarises that one. Only an app chat id. */
export function appSession(body: Record<string, unknown>): { channel: string; chatId: string } | undefined {
  const chatId = typeof body.chatId === "string" ? body.chatId : ""
  return body.channel === "app" && /^app:c[a-z0-9]{8,32}$/.test(chatId) ? { channel: "app", chatId } : undefined
}

const notFound: Reply = { status: 404, body: { error: "Not found" } }

function reply(r: ReturnType<CallService["decline"]>): Reply {
  return r.ok ? { status: 200, body: { call: r.call } } : { status: r.status, body: { error: r.error } }
}
