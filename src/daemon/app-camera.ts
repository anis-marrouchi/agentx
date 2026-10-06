import type { IncomingMessage, ServerResponse } from "http"
import type { DaemonTarget } from "./app-chat-relay"
import { readRaw } from "./voice-io-api"
import { normalizeName as normal } from "@/channels/webrtc-signal"

// --- Phone app: share the camera (/api/app/camera/*) ---
//
// Runs behind the device-token check in app-routes.ts. The phone can reach
// only /app and /api/app over `tailscale serve`, so these routes carry its
// WebRTC signalling to the daemon's broker (/webrtc/*), which relays it to
// the mesh node the owner picked. Video goes phone ↔ viewer peer to peer; no
// frame passes through the dashboard or the daemon.
//
// The phone always signals as this node: `from` is set here, never taken
// from the request, so a phone can't speak for another machine.
//
// A destination `bot:<agentId>` is an agent on this node watching (#325
// phase 2). Its ring starts the agent's bot through /webrtc/camera/watch;
// the rest of the signalling reaches the bot through the same broker, in
// process. /api/app/camera/look asks that agent what it sees.
// /api/app/camera/stream turns "Keep watching" on or off (#687), and
// /api/app/camera/speak says one of the agent's answers aloud: only an
// answer the watch holds, in the agent's voice when it has one. The audio
// is kept for a short while, so a replay does not pay for a new voice call.

export interface AppCameraDeps {
  daemon: DaemonTarget
  /** This node's name, the phone's identity in the call. */
  nodeName: string
}

const KINDS = new Set(["ring", "offer", "answer", "ice", "hangup"])
const CALL_ID = /^[A-Za-z0-9_-]{4,64}$/
/** An SDP offer for one video track is a few KB; this leaves ample room. */
const SIGNAL_MAX_BYTES = 128 * 1024
/** Spoken answers kept for replays: one or two short sentences each. */
const SPOKEN_KEPT = 24
const SPOKEN_MAX_BYTES = 2 * 1024 * 1024
const spoken = new Map<string, { type: string; bytes: Buffer }>()

export async function handleAppCamera(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  deps: AppCameraDeps,
): Promise<boolean> {
  if (!path.startsWith("/api/app/camera/")) return false
  const base = deps.daemon.url.replace(/\/+$/, "")
  const auth: Record<string, string> = deps.daemon.token ? { Authorization: `Bearer ${deps.daemon.token}` } : {}

  if (path === "/api/app/camera/config") {
    if (method !== "GET") return json(res, 405, { error: "GET" })
    try {
      const r = await fetch(`${base}/webrtc/config`, { headers: auth, signal: AbortSignal.timeout(10_000) })
      if (r.status === 404) return json(res, 503, { error: "Calls are off on this computer. Set channels.webrtc.enabled to true in agentx.json." })
      if (!r.ok) return json(res, 502, { error: `AgentX answered HTTP ${r.status}.` })
      const cfg = await r.json() as any
      const self = normal(deps.nodeName)
      // The phone shows its camera on another machine; this node is where it
      // signals from, so it is not a destination.
      const peers = (Array.isArray(cfg.peers) ? cfg.peers : []).filter((p: any) => normal(String(p?.name ?? "")) !== self)
      const agents = (Array.isArray(cfg.agents) ? cfg.agents : [])
        .filter((a: any) => a && typeof a.id === "string")
        .map((a: any) => ({ id: a.id, name: typeof a.name === "string" && a.name ? a.name : a.id }))
      return json(res, 200, { node: deps.nodeName, iceServers: cfg.iceServers ?? [], peers, agents, camera: cfg.camera ?? null })
    } catch {
      return json(res, 502, { error: "Could not reach AgentX on this computer." })
    }
  }

  if (path === "/api/app/camera/signal") {
    if (method !== "POST") return json(res, 405, { error: "POST" })
    const raw = await readRaw(req, SIGNAL_MAX_BYTES)
    if (!raw) return json(res, 413, { error: "signal too large" })
    let body: any
    try { body = JSON.parse(raw.toString("utf8") || "{}") } catch { return json(res, 400, { error: "expected JSON" }) }
    const signal = cameraSignal(body, deps.nodeName)
    if (typeof signal === "string") return json(res, 400, { error: signal })
    // The owner tapped Start with an agent as the destination: its bot
    // joins now and offers; the phone answers through the broker.
    const agentId = watchingAgent(signal.to as string)
    if (agentId && signal.kind === "ring") {
      const r = await relay(base, auth, "POST", "/webrtc/camera/watch", { callId: signal.callId, agentId })
      return json(res, r.status, r.status < 300 ? { ok: true, watch: r.body.watch } : { error: r.body.error })
    }
    try {
      const r = await fetch(`${base}/webrtc/signal/out`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify(signal),
        signal: AbortSignal.timeout(15_000),
      })
      const out = await r.json().catch(() => ({})) as any
      return json(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: out?.error || `AgentX answered HTTP ${r.status}.` })
    } catch {
      return json(res, 502, { error: "Could not reach AgentX on this computer." })
    }
  }

  if (path === "/api/app/camera/events") {
    if (method !== "GET") return json(res, 405, { error: "GET" })
    const callId = new URL(req.url || "/", "http://x").searchParams.get("callId") || ""
    if (!CALL_ID.test(callId)) return json(res, 400, { error: "callId is required" })
    return pipeEvents(req, res, `${base}/webrtc/events?callId=${encodeURIComponent(callId)}&as=${encodeURIComponent(deps.nodeName)}`, auth)
  }

  // The owner asks the watching agent what it sees. One turn of the agent.
  if (path === "/api/app/camera/look") {
    if (method !== "POST") return json(res, 405, { error: "POST" })
    const raw = await readRaw(req, 4096)
    if (!raw) return json(res, 413, { error: "note too long" })
    let body: any
    try { body = JSON.parse(raw.toString("utf8") || "{}") } catch { return json(res, 400, { error: "expected JSON" }) }
    const callId = String(body?.callId ?? "")
    if (!CALL_ID.test(callId)) return json(res, 400, { error: "callId is required" })
    const note = typeof body?.note === "string" ? body.note : ""
    const r = await relay(base, auth, "POST", `/webrtc/camera/watch/${encodeURIComponent(callId)}/look`, { note }, 180_000)
    return json(res, r.status, r.status < 300 ? { reply: r.body.reply, frame: r.body.frame } : { error: r.body.error })
  }

  // "Keep watching" (#687): a frame every few seconds for a short while,
  // only while the owner has it on. seconds 0 stops it.
  if (path === "/api/app/camera/stream") {
    if (method !== "POST") return json(res, 405, { error: "POST" })
    const body = await readJson(req, 4096)
    if (!body) return json(res, 400, { error: "expected JSON" })
    const callId = String(body.callId ?? "")
    if (!CALL_ID.test(callId)) return json(res, 400, { error: "callId is required" })
    const seconds = Number(body.seconds ?? 0)
    if (!Number.isFinite(seconds) || seconds < 0) return json(res, 400, { error: "seconds must be 0 or more" })
    const note = typeof body.note === "string" ? body.note : ""
    const r = await relay(base, auth, "POST", `/webrtc/camera/watch/${encodeURIComponent(callId)}/stream`, { seconds, note })
    return json(res, r.status, r.status < 300 ? { watch: r.body.watch } : { error: r.body.error })
  }

  // Say one of the watching agent's answers aloud (#687). The text comes
  // from the watch, never from the phone, so a phone can't have arbitrary
  // words said in an agent's voice.
  if (path === "/api/app/camera/speak") {
    if (method !== "POST") return json(res, 405, { error: "POST" })
    const body = await readJson(req, 4096)
    if (!body) return json(res, 400, { error: "expected JSON" })
    const callId = String(body.callId ?? "")
    if (!CALL_ID.test(callId)) return json(res, 400, { error: "callId is required" })
    const w = await relay(base, auth, "GET", `/webrtc/camera/watch/${encodeURIComponent(callId)}`)
    if (w.status >= 300) return json(res, w.status, { error: w.body.error })
    const reply = (Array.isArray(w.body.watch?.replies) ? w.body.watch.replies : []).find((x: any) => x && x.at === body.at)
    if (!reply || typeof reply.text !== "string") return json(res, 404, { error: "no such answer on this share" })
    const agent = String(w.body.watch.agentId ?? "")
    const key = JSON.stringify([callId, reply.at, agent, reply.text])
    const kept = spoken.get(key)
    if (kept) {
      spoken.delete(key)
      spoken.set(key, kept)
      return sendAudio(res, kept.type, kept.bytes)
    }
    return speakThrough(res, base, auth, { agent, text: reply.text }, (type, bytes) => {
      if (bytes.length > SPOKEN_MAX_BYTES) return
      spoken.set(key, { type, bytes })
      while (spoken.size > SPOKEN_KEPT) spoken.delete(spoken.keys().next().value as string)
    })
  }

  // Camera asks waiting for the owner (#325 phase 3): the app polls this
  // and shows a Show / Decline bar. Show answers the ask, then the phone
  // starts a share with the ask's id and the agent as the destination.
  if (path === "/api/app/camera/asks") {
    if (method !== "GET") return json(res, 405, { error: "GET" })
    const r = await relay(base, auth, "GET", "/calls/asking")
    if (r.status >= 300) return json(res, r.status, { error: r.body.error })
    const asks = (Array.isArray(r.body.calls) ? r.body.calls : []).map((c: any) => ({ id: c.id, agentId: c.agentId, reason: c.reason, createdAt: c.createdAt }))
    return json(res, 200, { asks, ringSeconds: r.body.ringSeconds ?? null })
  }
  const askAction = /^\/api\/app\/camera\/asks\/([A-Za-z0-9_-]{4,64})\/(answer|decline)$/.exec(path)
  if (askAction) {
    if (method !== "POST") return json(res, 405, { error: "POST" })
    const r = await relay(base, auth, "POST", `/calls/${askAction[1]}/${askAction[2]}`, {})
    return json(res, r.status, r.status < 300 ? { call: r.body.call } : { error: r.body.error })
  }

  // What the watching agent has answered so far (frames it got by itself).
  if (path === "/api/app/camera/watch") {
    if (method !== "GET") return json(res, 405, { error: "GET" })
    const callId = new URL(req.url || "/", "http://x").searchParams.get("callId") || ""
    if (!CALL_ID.test(callId)) return json(res, 400, { error: "callId is required" })
    const r = await relay(base, auth, "GET", `/webrtc/camera/watch/${encodeURIComponent(callId)}`)
    return json(res, r.status, r.status < 300 ? { watch: r.body.watch } : { error: r.body.error })
  }

  return json(res, 404, { error: "not found" })
}

/** The agent id in a `bot:<agentId>` destination, or null for a machine. */
export function watchingAgent(to: string): string | null {
  const m = /^bot:([A-Za-z0-9_.-]{1,80})$/.exec(to)
  return m ? m[1] : null
}

/** One request to the daemon, with its status and JSON body. A daemon that
 *  cannot be reached answers 502 in the same shape. */
async function relay(base: string, auth: Record<string, string>, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...auth },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const out = await r.json().catch(() => ({})) as any
    if (r.status === 404 && typeof out?.error === "string" && /channels\.webrtc\.enabled/.test(out.error)) return { status: 503, body: out }
    return { status: r.ok ? r.status : r.status >= 500 ? 502 : r.status, body: r.ok ? out : { error: out?.error || `AgentX answered HTTP ${r.status}.` } }
  } catch {
    return { status: 502, body: { error: "Could not reach AgentX on this computer." } }
  }
}

async function readJson(req: IncomingMessage, max: number): Promise<Record<string, any> | null> {
  const raw = await readRaw(req, max)
  if (!raw) return null
  try {
    const v = JSON.parse(raw.toString("utf8") || "{}")
    return v && typeof v === "object" && !Array.isArray(v) ? v : null
  } catch { return null }
}

/** POSTs to the daemon's /voice/speak and passes its answer on: audio as
 *  bytes (also handed to `keep`), or JSON telling the phone to speak the
 *  text with its own voice. */
async function speakThrough(res: ServerResponse, base: string, auth: Record<string, string>, body: { agent: string; text: string }, keep: (type: string, bytes: Buffer) => void): Promise<true> {
  try {
    const r = await fetch(`${base}/voice/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
    const type = r.headers.get("content-type") || ""
    if (r.ok && type.startsWith("audio/")) {
      const bytes = Buffer.from(await r.arrayBuffer())
      keep(type, bytes)
      return sendAudio(res, type, bytes)
    }
    const out = await r.json().catch(() => ({})) as any
    // No voice for the agent here: the phone says it with its own.
    if (r.ok || typeof out?.text === "string") return json(res, 200, { text: typeof out?.text === "string" ? out.text : body.text })
    return json(res, 200, { text: body.text, error: out?.error || `AgentX answered HTTP ${r.status}.` })
  } catch {
    return json(res, 200, { text: body.text, error: "Could not reach AgentX on this computer." })
  }
}

function sendAudio(res: ServerResponse, type: string, bytes: Buffer): true {
  res.writeHead(200, { "Content-Type": type, "Content-Length": String(bytes.length), "Cache-Control": "no-store" })
  res.end(bytes)
  return true
}

/** The signal to relay, or why it was refused. */
export function cameraSignal(body: any, nodeName: string): Record<string, unknown> | string {
  const kind = String(body?.kind ?? "")
  if (!KINDS.has(kind)) return "kind must be ring, offer, answer, ice or hangup"
  const callId = String(body?.callId ?? "")
  if (!CALL_ID.test(callId)) return "callId must be 4 to 64 letters, digits, - or _"
  const to = typeof body?.to === "string" ? body.to.trim() : ""
  if (!to || to.length > 100) return "to must name a machine or an agent"
  if (to.startsWith("bot:") && !watchingAgent(to)) return "to must be bot:<agent id> for an agent"
  if (normal(to) === normal(nodeName)) return "pick another machine; this phone signals from this one"
  const signal: Record<string, unknown> = { kind, callId, from: nodeName, to }
  if (kind === "offer" || kind === "answer") {
    if (typeof body.sdp !== "string" || !body.sdp) return "sdp is required"
    signal.sdp = body.sdp
  }
  if (kind === "ice") {
    const c = body.candidate
    if (!c || typeof c.candidate !== "string") return "candidate is required"
    signal.candidate = {
      candidate: c.candidate,
      sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null,
      sdpMLineIndex: typeof c.sdpMLineIndex === "number" ? c.sdpMLineIndex : null,
      usernameFragment: typeof c.usernameFragment === "string" ? c.usernameFragment : null,
    }
  }
  // The receiving node words its notice as a camera share, not a call.
  if (kind === "ring") signal.reason = "camera"
  return signal
}

/** Streams the daemon's SSE to the phone until either side closes. */
async function pipeEvents(req: IncomingMessage, res: ServerResponse, url: string, auth: Record<string, string>): Promise<true> {
  const abort = new AbortController()
  req.on("close", () => abort.abort())
  let r: Response
  try {
    r = await fetch(url, { headers: { Accept: "text/event-stream", ...auth }, signal: abort.signal })
  } catch {
    return json(res, 502, { error: "Could not reach AgentX on this computer." })
  }
  if (!r.ok || !r.body) {
    if (r.status === 404) return json(res, 503, { error: "Calls are off on this computer." })
    return json(res, 502, { error: `AgentX answered HTTP ${r.status}.` })
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" })
  const reader = r.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } catch {
    // The phone left (abort) or the daemon went away; either ends the stream.
  } finally {
    abort.abort()
    res.end()
  }
  return true
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
