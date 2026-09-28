import type { IncomingMessage, ServerResponse } from "http"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { extractUiDirective } from "@/channels/ui-directive"
import { toSpeakable } from "@/voice/speakable"
import { elevenLabsSpeed, type VoiceRef } from "@/voice/speaker"
import {
  AUDIO_LIMITS, audioExt, checkDurationHeader, elevenLabsScribe, localWhisper, measureSeconds, sttEngines, sttSetupHint,
  tooLongMessage, type SttEngine, type SttHost, type SttSetting,
} from "@/voice/transcribe"
import { resolveAgentVoice, voiceRef } from "@/voice/agent-voice"
import type { MeshVoices } from "@/voice/mesh-voice"
import type { DaemonConfig } from "./config"

// --- Voice in and out for the phone app: POST /voice/transcribe, /voice/speak ---
//
// The phone app's dashboard (app-voice.ts) checks the device token and
// forwards here with the daemon token, because this process holds the
// ElevenLabs key, the agents' voices and the `voice.stt` setting. Both
// routes are mesh-gated for every caller off this box (isMeshGatedPath):
// they spend the ElevenLabs quota and run Whisper on this computer.
//
// Audio is never logged and never kept: a recording lives in a private temp
// folder for the length of the request and is deleted after it.

export const SPEAK_MAX_CHARS = 1500
const SPEAK_BODY_MAX = 64 * 1024
/** Transcriptions running at once on this host; more wait for none, they
 *  get 429. Whisper is heavy, and one phone rarely needs two. */
export const MAX_TRANSCRIBING = 2
let transcribing = 0

export function isVoiceIoPath(path: string): boolean {
  return path === "/voice/transcribe" || path === "/voice/speak"
}

export interface VoiceIoDeps {
  stt: () => SttSetting
  host: () => SttHost
  /** The agent's voice; `peer` names the mesh peer for an agent over there. */
  voiceOf: (agentId: string, peer?: string) => VoiceRef | null
  elevenLabsKey: () => string | null
  log: (line: string) => void
  /** Tests swap the engines and the synthesiser. */
  engines?: Partial<Record<SttEngine, (file: string, mime: string, host: SttHost, dir: string) => Promise<string>>>
  measure?: (file: string, ffmpeg: string | null) => Promise<number | null>
  /** voice.allowUnmeasured: take recordings this host can't measure. */
  allowUnmeasured?: () => boolean
  /** This node's name, for the phone's setup hint. */
  nodeName?: string
  synth?: (key: string, voice: VoiceRef, text: string) => Promise<Buffer>
}

export async function handleVoiceIo(req: IncomingMessage, res: ServerResponse, path: string, deps: VoiceIoDeps): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" })
  if (path === "/voice/transcribe") return transcribe(req, res, deps)
  return speak(req, res, deps)
}

async function transcribe(req: IncomingMessage, res: ServerResponse, deps: VoiceIoDeps): Promise<void> {
  const mime = String(req.headers["content-type"] || "")
  const ext = audioExt(mime)
  if (!ext) return json(res, 415, { error: "Send the recording as audio (webm, mp4, ogg, mp3 or wav)." })
  const stated = checkDurationHeader(req.headers["x-audio-duration-ms"])
  if (stated) { req.resume(); return json(res, stated.status, { error: stated.error }) }
  const audio = await readRaw(req, AUDIO_LIMITS.bytes)
  if (!audio) return json(res, 413, { error: tooBigMessage() })
  if (!audio.length) return json(res, 400, { error: "The recording is empty." })
  if (transcribing >= MAX_TRANSCRIBING) return json(res, 429, { error: "This computer is already writing down other recordings. Try again in a moment." })

  const setting = deps.stt()
  const host = deps.host()
  const engines = sttEngines(setting, host)
  // Without ffmpeg the length can't be measured, and the byte cap bounds
  // bytes, not minutes: refuse unless the owner opted out (#233).
  if (!host.ffmpeg && !deps.allowUnmeasured?.()) {
    const where = deps.nodeName ? `on ${deps.nodeName}` : "on this computer"
    const more = engines.length ? "" : " " + sttSetupHint(setting, host)
    return json(res, 503, { error: "Voice input isn't set up on this computer.", hint: `Install ffmpeg ${where} for voice input from the phone.${more}`, setup: false })
  }
  if (!engines.length) {
    return json(res, 503, { error: "Voice input isn't set up on this computer.", hint: sttSetupHint(setting, host), setup: false })
  }
  // The recording is deleted before the phone gets its answer.
  transcribing++
  let reply: [number, unknown]
  try {
    const dir = await mkdtemp(join(tmpdir(), "agentx-phone-voice-"))
    try {
      reply = await transcribeIn(dir, `speech.${ext}`, audio, mime, host, engines, deps)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    transcribing--
  }
  json(res, reply[0], reply[1])
}

async function transcribeIn(dir: string, name: string, audio: Buffer, mime: string, host: SttHost, engines: SttEngine[], deps: VoiceIoDeps): Promise<[number, unknown]> {
  const file = join(dir, name)
  await writeFile(file, audio, { mode: 0o600 })
  // The real length where this host can measure it, whatever the header
  // said. With ffmpeg, a recording it can't read is refused rather than
  // passed on unmeasured. Without ffmpeg (only with voice.allowUnmeasured)
  // just the byte cap applies, which bounds bytes, not minutes.
  if (host.ffmpeg) {
    const secs = await (deps.measure ?? measureSeconds)(file, host.ffmpeg)
    if (secs == null) return [422, { error: "This computer couldn't read the recording. Try again." }]
    if (secs * 1000 > AUDIO_LIMITS.ms + 2000) return [413, { error: tooLongMessage() }]
  }
  const failures: string[] = []
  for (const engine of engines) {
    try {
      const text = await runEngine(engine, file, mime, host, dir, deps)
      deps.log(`[voice] phone recording transcribed with ${engine} (${Math.round(audio.length / 1024)} KB)`)
      if (!text) return [422, { error: "No words were heard. Hold the orb and speak, then let go.", engine }]
      return [200, { text, engine }]
    } catch (e: any) {
      const why = String(e?.message ?? e).split("\n")[0].slice(0, 200)
      failures.push(`${engine}: ${why}`)
      deps.log(`[voice] phone transcription with ${engine} failed: ${why}`)
    }
  }
  return [502, { error: "Speech to text failed on this computer.", detail: failures.join("; ") }]
}

function runEngine(engine: SttEngine, file: string, mime: string, host: SttHost, dir: string, deps: VoiceIoDeps): Promise<string> {
  const custom = deps.engines?.[engine]
  if (custom) return custom(file, mime, host, dir)
  if (engine === "elevenlabs") return elevenLabsScribe(file, mime, host.key!)
  const bin = engine === "mlx-whisper" ? host.mlx! : host.whisper!
  return localWhisper(engine, bin, file, host.ffmpeg!, dir)
}

async function speak(req: IncomingMessage, res: ServerResponse, deps: VoiceIoDeps): Promise<void> {
  const raw = await readRaw(req, SPEAK_BODY_MAX)
  if (!raw) return json(res, 413, { error: "request too large" })
  let body: any
  try { body = JSON.parse(raw.toString("utf8") || "{}") } catch { return json(res, 400, { error: "expected JSON" }) }
  const agent = typeof body?.agent === "string" ? body.agent : ""
  const peer = typeof body?.peer === "string" && body.peer ? body.peer : undefined
  if (!agent) return json(res, 400, { error: "agent is required" })
  const text = speakableAnswer(typeof body?.text === "string" ? body.text : "")
  if (!text) return json(res, 422, { error: "Nothing in this answer can be said aloud." })

  const voice = deps.voiceOf(agent, peer)
  if (!voice) return json(res, 404, { error: `Unknown agent: ${agent}` })
  // No ElevenLabs voice for this agent: the phone speaks the same cleaned
  // text with its own voice. That is the normal case for system-voice
  // agents, so it is a 200, not an error.
  const browser = (why: string, status = 200) => json(res, status, { fallback: "browser", reason: why, text })
  if (voice.provider !== "elevenlabs") return browser("This agent speaks with a system voice, which only plays on the computer.")
  const key = deps.elevenLabsKey()
  if (!key) return browser("No ElevenLabs key is set on this computer.")
  try {
    const audio = await (deps.synth ?? elevenLabsAudio)(key, voice, text)
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store", "X-Spoken-Chars": String(text.length) })
    res.end(audio)
  } catch (e: any) {
    deps.log(`[voice] phone answer synthesis failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`)
    return browser("ElevenLabs could not speak this answer.", 502)
  }
}

/** An answer as it is said: no agentx:ui block, no markdown, capped. */
export function speakableAnswer(text: string): string {
  return toSpeakable(extractUiDirective(text).cleanText, SPEAK_MAX_CHARS)
}

/** One answer as mp3, in the agent's ElevenLabs voice. */
async function elevenLabsAudio(key: string, voice: VoiceRef, text: string): Promise<Buffer> {
  const speed = elevenLabsSpeed(voice.rate)
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.elevenlabs)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5", ...(speed ? { voice_settings: { speed } } : {}) }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`)
  return Buffer.from(await r.arrayBuffer())
}

export const tooBigMessage = (): string =>
  `The recording is larger than ${AUDIO_LIMITS.bytes / 1024 / 1024} MB, more than ${AUDIO_LIMITS.ms / 60000} minutes of speech.`

/** The voice for `agentId`: a local agent's when there is no peer, else the
 *  agent of that id on that mesh peer exactly. Never another peer's agent
 *  that happens to share the id. */
export function resolveVoice(
  agentId: string, peer: string | undefined,
  config: Pick<DaemonConfig, "agents" | "voice">, mesh: Pick<MeshVoices, "speakerOn" | "speaker">,
): VoiceRef | null {
  if (peer) return mesh.speakerOn(peer, agentId, false)?.voice ?? null
  const agents = config.agents ?? {}
  return agents[agentId] ? voiceRef(resolveAgentVoice(agentId, agents, config.voice)) : null
}

/** The whole body, or null past `limit` (a declared length says so at
 *  once). Past the limit the rest is read and dropped, not kept, so the
 *  answer still reaches the sender. */
export function readRaw(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  if (Number(req.headers["content-length"]) > limit) { req.resume(); return Promise.resolve(null) }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      if (size > limit) return
      size += chunk.length
      if (size > limit) { chunks.length = 0; resolve(null); return }
      chunks.push(chunk)
    })
    req.on("end", () => { if (size <= limit) resolve(Buffer.concat(chunks)) })
    req.on("error", reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}
