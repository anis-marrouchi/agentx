import { spawn } from "child_process"
import { accessSync, constants, readFileSync } from "fs"
import { homedir } from "os"
import { basename, delimiter, dirname, extname, join } from "path"

// --- Speech to text for the phone app (and anything else holding a file) ---
//
// The same engine order as AgentX Voice on the Mac (Speech.swift): ElevenLabs
// Scribe when a key is set, then a Whisper that runs on this computer. The
// phone records whatever its browser can (webm/opus on Android and desktop,
// mp4/aac on iPhone), so the local engines need ffmpeg to read it: without
// ffmpeg they are not offered at all.
//
// Nothing here logs audio, a transcript or a file path; only which engine ran
// and why one failed.

export type SttSetting = "auto" | "elevenlabs" | "local"
export type SttEngine = "elevenlabs" | "mlx-whisper" | "whisper"

/** Bounds on one recording, checked by the dashboard and by the daemon.
 *  The phone records at `bitsPerSecond`, so 2 minutes is under 1 MB; the
 *  byte cap is 2 minutes at about twice that, room for a browser that
 *  ignores the requested rate and for the container. The cap bounds bytes,
 *  not minutes: a low-bitrate file holds far more than 2 minutes in 2 MB,
 *  so only measuring it (with ffmpeg) bounds the length. */
export const AUDIO_LIMITS = {
  ms: 2 * 60 * 1000,
  bitsPerSecond: 64_000,
  bytes: 2 * 1024 * 1024,
} as const

/** The recording's length as the phone states it (X-Audio-Duration-Ms).
 *  Required: a missing or malformed value is refused, as is one over the
 *  cap (with 2 s of slack for the recorder's own rounding). */
export function checkDurationHeader(header: string | string[] | undefined): { status: 400 | 413; error: string } | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw || !/^\d{1,9}$/.test(raw.trim())) return { status: 400, error: "Say how long the recording is (X-Audio-Duration-Ms)." }
  return Number(raw) > AUDIO_LIMITS.ms + 2000 ? { status: 413, error: tooLongMessage() } : null
}

export const tooLongMessage = (): string => `The recording is longer than ${AUDIO_LIMITS.ms / 60000} minutes.`

const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm", "video/webm": "webm", "audio/ogg": "ogg",
  "audio/mp4": "m4a", "video/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
}

/** The file extension for a recording's Content-Type, or null when it is
 *  not audio this route takes. Codec parameters are ignored. */
export function audioExt(contentType: string | undefined): string | null {
  const base = String(contentType || "").split(";")[0].trim().toLowerCase()
  return AUDIO_TYPES[base] ?? null
}

/** What this computer has for speech to text. */
export interface SttHost {
  key: string | null
  mlx: string | null
  whisper: string | null
  ffmpeg: string | null
}

/** The engines to try, in order. Empty: voice input is not set up here. */
export function sttEngines(setting: SttSetting, host: SttHost): SttEngine[] {
  const out: SttEngine[] = []
  if (setting !== "local" && host.key) out.push("elevenlabs")
  if (host.ffmpeg) {
    if (host.mlx) out.push("mlx-whisper")
    else if (host.whisper) out.push("whisper")
  }
  return out
}

/** Why voice input can't work on this computer, in words for the phone. */
export function sttSetupHint(setting: SttSetting, host: SttHost): string {
  if (setting === "local" && host.key && !host.ffmpeg) return "Speech to text is set to local, and this computer has no ffmpeg."
  if ((host.mlx || host.whisper) && !host.ffmpeg) return "This computer has Whisper but no ffmpeg to read the recording."
  return "Add an ElevenLabs key on this computer, or install mlx-whisper and ffmpeg."
}

/** Looks for an executable: an explicit path, then the usual install
 *  places, then PATH. A launchd daemon's PATH is short, hence the list. */
export function findBinary(name: string, explicit?: string | null, pathEnv = process.env.PATH ?? ""): string | null {
  const home = homedir()
  const dirs = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...pathEnv.split(delimiter).filter(Boolean)]
  for (const p of [explicit, ...dirs.map((d) => join(d, name))]) {
    if (!p) continue
    try { accessSync(p, constants.X_OK); return p } catch { /* next */ }
  }
  return null
}

export function detectSttHost(key: string | null): SttHost {
  return {
    key,
    mlx: findBinary("mlx_whisper", process.env.AGENTX_MLX_WHISPER),
    whisper: findBinary("whisper", process.env.AGENTX_WHISPER),
    ffmpeg: findBinary("ffmpeg", process.env.AGENTX_FFMPEG),
  }
}

/** Seconds of audio in a file, measured, not taken from the phone or from
 *  the container's stated duration (which the sender writes): ffmpeg
 *  decodes it. Decoding stops a little past the cap, so a long file costs
 *  no more than a legal one. Null when ffmpeg is not here or can't read it. */
export async function measureSeconds(file: string, ffmpeg: string | null): Promise<number | null> {
  return ffmpeg ? decodeSeconds(file, ffmpeg) : null
}

/** Decodes up to the cap plus 5 s and reads ffmpeg's last "time=". */
export async function decodeSeconds(file: string, ffmpeg: string): Promise<number | null> {
  const limit = String(AUDIO_LIMITS.ms / 1000 + 5)
  try {
    const err = await runStderr(ffmpeg, ["-nostdin", "-hide_banner", "-t", limit, "-i", file, "-f", "null", "-"], 30_000)
    const times = [...err.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
    const m = times[times.length - 1]
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
  } catch { return null }
}

/** ElevenLabs Scribe. The recording goes as it is: Scribe reads webm and mp4. */
export async function elevenLabsScribe(file: string, mime: string, key: string, signal?: AbortSignal): Promise<string> {
  const fd = new FormData()
  fd.set("model_id", process.env.AGENTX_STT_MODEL || "scribe_v1")
  fd.set("file", new Blob([readFileSync(file)], { type: mime }), basename(file))
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST", headers: { "xi-api-key": key }, body: fd, signal: signal ?? AbortSignal.timeout(60_000),
  })
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`)
  const j = await r.json() as { text?: unknown }
  if (typeof j.text !== "string") throw new Error("ElevenLabs returned no text")
  return j.text.trim()
}

/** A Whisper CLI on this computer. Both write <name>.txt into `outDir`;
 *  stdout is never taken as the words (mlx_whisper prints "Skipping …" there
 *  and exits 0 when it fails). */
export async function localWhisper(engine: "mlx-whisper" | "whisper", bin: string, file: string, ffmpeg: string, outDir: string): Promise<string> {
  const args = engine === "mlx-whisper"
    ? ["--model", process.env.AGENTX_MLX_MODEL || "mlx-community/whisper-large-v3-turbo", "--output-format", "txt", "--output-dir", outDir, file]
    : [file, "--model", process.env.AGENTX_WHISPER_MODEL || "base", "--output_format", "txt", "--output_dir", outDir, "--fp16", "False"]
  // Both read the recording through ffmpeg, found by PATH.
  const env = { ...process.env, PATH: `${dirname(ffmpeg)}${delimiter}${process.env.PATH ?? ""}` }
  await run(bin, args, 120_000, env)
  try {
    return readFileSync(join(outDir, basename(file, extname(file)) + ".txt"), "utf8").trim()
  } catch {
    throw new Error(`${engine} wrote no transcript`)
  }
}

/** Runs to the end and resolves with the tail of stderr (ffmpeg's progress). */
function runStderr(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] })
    let err = ""
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${basename(cmd)} took too long`)) }, timeoutMs)
    child.stderr.on("data", (d) => { err = (err + d).slice(-8192) })
    child.on("error", (e) => { clearTimeout(timer); reject(e) })
    child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve(err) : reject(new Error(`${basename(cmd)} exited ${code}`)) })
  })
}

function run(cmd: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env })
    let out = ""
    let err = ""
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${basename(cmd)} took longer than ${timeoutMs / 1000}s`)) }, timeoutMs)
    child.stdout.on("data", (d) => { if (out.length < 4096) out += d })
    child.stderr.on("data", (d) => { if (err.length < 4096) err += d })
    child.on("error", (e) => { clearTimeout(timer); reject(e) })
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${basename(cmd)} exited ${code}: ${err.trim().split("\n").pop()?.slice(0, 160) ?? ""}`))
    })
  })
}
