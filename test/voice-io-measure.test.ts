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
let forged: string

/** 30 minutes of a tone at 6 kbps (well under the 2 MB cap), written to a
 *  seekable file so it carries a container Duration, which is then patched
 *  to 60 s: the review's attack on #228. */
function forgedLong(file: string): void {
  execFileSync(ffmpeg!, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1800",
    "-ac", "1", "-c:a", "libopus", "-b:a", "6k", file])
  const buf = readFileSync(file)
  // EBML Duration (ID 0x4489) with an 8-byte float, in ms (TimecodeScale 1 ms).
  const at = buf.indexOf(Buffer.from([0x44, 0x89, 0x88]))
  if (at < 0) throw new Error("no 8-byte Duration element")
  buf.writeDoubleBE(60_000, at + 3)
  writeFileSync(file, buf)
}

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
    forged = join(dir, "forged.webm")
    forgedLong(forged)
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
  }, 90_000)

  afterAll(() => {
    server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("refuses 30 minutes whose container and header both say 60 s", async () => {
    const body = readFileSync(forged)
    expect(body.length).toBeLessThan(AUDIO_LIMITS.bytes)
    // The container really does claim 60 s: ffprobe believes it.
    const ffprobe = findBinary("ffprobe")
    if (ffprobe) {
      const stated = execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", forged]).toString().trim()
      expect(Number(stated)).toBeCloseTo(60, 0)
    }
    const before = reached
    const r = await fetch(base, { method: "POST", headers: { "Content-Type": "audio/webm", "X-Audio-Duration-Ms": "60000" }, body })
    expect(r.status).toBe(413)
    expect(reached).toBe(before)
  }, 30_000)

  it("reads the real length by decoding", async () => {
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
