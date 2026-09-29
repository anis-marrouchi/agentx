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

export interface AppCameraDeps {
  daemon: DaemonTarget
  /** This node's name, the phone's identity in the call. */
  nodeName: string
}

const KINDS = new Set(["ring", "offer", "answer", "ice", "hangup"])
const CALL_ID = /^[A-Za-z0-9_-]{4,64}$/
/** An SDP offer for one video track is a few KB; this leaves ample room. */
const SIGNAL_MAX_BYTES = 128 * 1024

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
      return json(res, 200, { node: deps.nodeName, iceServers: cfg.iceServers ?? [], peers, camera: cfg.camera ?? null })
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

  return json(res, 404, { error: "not found" })
}

/** The signal to relay, or why it was refused. */
export function cameraSignal(body: any, nodeName: string): Record<string, unknown> | string {
  const kind = String(body?.kind ?? "")
  if (!KINDS.has(kind)) return "kind must be ring, offer, answer, ice or hangup"
  const callId = String(body?.callId ?? "")
  if (!CALL_ID.test(callId)) return "callId must be 4 to 64 letters, digits, - or _"
  const to = typeof body?.to === "string" ? body.to.trim() : ""
  if (!to || to.length > 100) return "to must name a machine"
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
