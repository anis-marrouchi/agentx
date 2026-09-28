import type { IncomingMessage, ServerResponse } from "http"
import type { TokenRecord } from "./token-store"
import type { AppChatStore } from "./app-chat-store"
import type { DaemonTarget } from "./app-chat-relay"
import { readRaw, tooBigMessage } from "./voice-io-api"
import { AUDIO_LIMITS, audioExt, checkDurationHeader } from "@/voice/transcribe"

// --- Phone app: voice (/api/app/voice/transcribe, /api/app/voice/speak) ---
//
// Runs behind the device-token check in app-routes.ts. The dashboard holds
// no voice engine: it bounds what the phone sends and forwards it to the
// daemon it serves (voice-io-api.ts), which transcribes with ElevenLabs or a
// local Whisper and speaks with the agent's ElevenLabs voice.
//
// A spoken answer is tied to one of this phone's conversations, so the voice
// is always the agent the conversation is pinned to, and a phone can only
// have its own conversations read out. Audio is passed through, never logged.

export interface AppVoiceDeps {
  store: () => AppChatStore | null
  daemon: DaemonTarget
}

/** Characters of an answer sent to be spoken; the daemon cuts it further. */
export const SPEAK_INPUT_MAX = 8_000

export async function handleAppVoice(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: TokenRecord,
  deps: AppVoiceDeps,
): Promise<boolean> {
  if (path !== "/api/app/voice/transcribe" && path !== "/api/app/voice/speak") return false
  if (method !== "POST") return json(res, 405, { error: "POST" })

  if (path === "/api/app/voice/transcribe") {
    const mime = String(req.headers["content-type"] || "")
    if (!audioExt(mime)) return json(res, 415, { error: "Send the recording as audio (webm, mp4, ogg, mp3 or wav)." })
    const stated = checkDurationHeader(req.headers["x-audio-duration-ms"])
    if (stated) { req.resume(); return json(res, stated.status, { error: stated.error }) }
    const audio = await readRaw(req, AUDIO_LIMITS.bytes)
    if (!audio) return json(res, 413, { error: tooBigMessage() })
    if (!audio.length) return json(res, 400, { error: "The recording is empty." })
    const headers = { "Content-Type": mime, "X-Audio-Duration-Ms": String(req.headers["x-audio-duration-ms"]).trim() }
    return forward(res, deps.daemon, "/voice/transcribe", audio, headers, 180_000)
  }

  let body: any
  const raw = await readRaw(req, 64 * 1024)
  if (!raw) return json(res, 413, { error: "request too large" })
  try { body = JSON.parse(raw.toString("utf8") || "{}") } catch { return json(res, 400, { error: "expected JSON" }) }
  const store = deps.store()
  if (!store) return json(res, 503, { error: "The database on this computer is unavailable." })
  const conv = store.get(device.id, String(body?.conversationId ?? ""))
  if (!conv) return json(res, 404, { error: "no such conversation" })
  const text = typeof body?.text === "string" ? body.text.slice(0, SPEAK_INPUT_MAX) : ""
  if (!text.trim()) return json(res, 400, { error: "text is required" })
  // Only an answer this conversation holds is read out, so a phone can't
  // have arbitrary text said in an agent's voice.
  if (!isAnswerIn(conv.messages, text)) return json(res, 404, { error: "no such answer in this conversation" })
  const upstream = { agent: conv.agent, text, ...(conv.node !== "local" ? { peer: conv.node } : {}) }
  return forward(res, deps.daemon, "/voice/speak", Buffer.from(JSON.stringify(upstream)), { "Content-Type": "application/json" }, 90_000)
}

/** POSTs to the daemon and passes its answer on: audio as bytes, the rest as JSON. */
async function forward(res: ServerResponse, daemon: DaemonTarget, path: string, body: Buffer, headers: Record<string, string>, timeoutMs: number): Promise<true> {
  try {
    const r = await fetch(daemon.url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { ...headers, ...(daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {}) },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const type = r.headers.get("content-type") || ""
    const out = Buffer.from(await r.arrayBuffer())
    if (r.ok && type.startsWith("audio/")) {
      res.writeHead(200, { "Content-Type": type, "Content-Length": out.length, "Cache-Control": "no-store" })
      res.end(out)
      return true
    }
    // A daemon from before these routes answers its generic "Not found",
    // which lists its endpoints.
    if (r.status === 404 && Array.isArray(parse(out)?.endpoints)) {
      return json(res, 503, { error: "AgentX on this computer is too old for voice. Update it." })
    }
    res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    res.end(type.includes("json") ? out : JSON.stringify({ error: `AgentX answered HTTP ${r.status}.` }))
    return true
  } catch (e: any) {
    return json(res, 502, { error: e?.name === "TimeoutError" ? "AgentX took too long to answer." : "Could not reach AgentX on this computer." })
  }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}

function parse(buf: Buffer): any {
  try { return JSON.parse(buf.toString("utf8")) } catch { return null }
}

/** `text` is one of the saved answers, or the first SPEAK_INPUT_MAX
 *  characters of one (a long answer is sent cut). */
export function isAnswerIn(messages: Array<{ role: string; content: string }>, text: string): boolean {
  return messages.some((m) => m.role === "assistant" && (m.content === text || (text.length === SPEAK_INPUT_MAX && m.content.startsWith(text))))
}
