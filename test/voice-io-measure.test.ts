import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { execFileSync } from "child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { handleVoiceIo, type VoiceIoDeps } from "../src/daemon/voice-io-api"
import { AUDIO_LIMITS, decodeSeconds, findBinary, measureSeconds } from "../src/voice/transcribe"

// The daemon measures a recording itself, with the ffmpeg on this machine,
// so a phone that under-states the length is still held to 2 minutes.
// Skipped where ffmpeg (with an Opus encoder, to make the test files) is not installed.

const ffmpeg = findBinary("ffmpeg")
let dir: string
let long: string
let short: string

function silence(file: string, seconds: number) {
  // Piped out, like a MediaRecorder stream: written without seeking back.
  const out = execFileSync(ffmpeg!, ["-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(seconds), "-c:a", "libopus", "-b:a", "16k", "-f", "webm", "pipe:1"], { maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(file, out)
}

const canEncode = (() => {
  if (!ffmpeg) return false
  try { execFileSync(ffmpeg, ["-loglevel", "error", "-f", "lavfi", "-i", "anullsrc", "-t", "0.1", "-c:a", "libopus", "-f", "webm", "pipe:1"]); return true } catch { return false }
})()

describe.skipIf(!canEncode)("measuring a recording", () => {
  let server: Server
  let base: string
  let reached = 0

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agentx-voice-measure-"))
    long = join(dir, "long.webm"); short = join(dir, "short.webm")
    silence(long, AUDIO_LIMITS.ms / 1000 + 10)
    silence(short, 3)
    const deps: VoiceIoDeps = {
      stt: () => "auto",
      host: () => ({ key: "k", mlx: null, whisper: null, ffmpeg }),
      voiceOf: () => null,
      elevenLabsKey: () => "k",
      log: () => {},
      engines: { elevenlabs: async () => { reached++; return "hi" } },
    }
    server = createServer((req, res) => { void handleVoiceIo(req, res, "/voice/transcribe", deps) })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  }, 30_000)

  afterAll(() => {
    server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("reads the real length, by probing or by decoding", async () => {
    expect(await measureSeconds(long, ffmpeg)).toBeGreaterThan(AUDIO_LIMITS.ms / 1000 + 2)
    expect(await measureSeconds(short, ffmpeg)).toBeCloseTo(3, 0)
    // Decoding (for a webm with no stated duration) stops just past the cap.
    const decoded = await decodeSeconds(long, ffmpeg!)
    expect(decoded).toBeGreaterThan(AUDIO_LIMITS.ms / 1000 + 2)
    expect(decoded).toBeLessThanOrEqual(AUDIO_LIMITS.ms / 1000 + 5)
    expect(await decodeSeconds(short, ffmpeg!)).toBeCloseTo(3, 0)
  }, 30_000)

  it("refuses a long recording whose header says it is short", async () => {
    const body = readFileSync(long)
    expect(body.length).toBeLessThan(AUDIO_LIMITS.bytes)
    const r = await fetch(base, { method: "POST", headers: { "Content-Type": "audio/webm", "X-Audio-Duration-Ms": "1000" }, body })
    expect(r.status).toBe(413)
    expect(reached).toBe(0)
    const ok = await fetch(base, { method: "POST", headers: { "Content-Type": "audio/webm", "X-Audio-Duration-Ms": "3000" }, body: readFileSync(short) })
    expect(ok.status).toBe(200)
    expect(reached).toBe(1)
  }, 30_000)
})
