import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { existsSync, readFileSync } from "fs"
import { handleVoiceIo, speakableAnswer, SPEAK_MAX_CHARS, MAX_TRANSCRIBING, type VoiceIoDeps } from "../src/daemon/voice-io-api"
import { AUDIO_LIMITS, audioExt, checkDurationHeader, sttEngines, sttSetupHint, type SttHost } from "../src/voice/transcribe"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import type { VoiceRef } from "../src/voice/speaker"

// The daemon side of the phone app's voice: speech to text with the Mac
// app's engine order, and an answer spoken in the agent's ElevenLabs voice.
// The engines and the synthesiser are fakes; nothing leaves the machine.

const FENCE = "```"
const AUDIO = Buffer.from("OggS-fake-opus-bytes-" + "x".repeat(200))
const ELEVEN: VoiceRef = { provider: "elevenlabs", elevenlabs: "voice-123", system: null, fallback: true }
const SYSTEM: VoiceRef = { provider: "system", elevenlabs: "", system: null, fallback: true }

let server: Server
let base: string
let logs: string[] = []
let calls: Array<{ engine: string; file: string; mime: string; bytes: number }> = []
let fail: Set<string> = new Set()
let spoken: Array<{ voice: VoiceRef; text: string }> = []
let deps: VoiceIoDeps
const host: SttHost = { key: "k", mlx: "/bin/mlx_whisper", whisper: null, ffmpeg: "/bin/ffmpeg" }

const engine = (name: string) => async (file: string, mime: string) => {
  calls.push({ engine: name, file, mime, bytes: readFileSync(file).length })
  if (fail.has(name)) throw new Error(`${name} is down`)
  return name === "mlx-whisper" ? "hello from whisper" : "hello from scribe"
}

beforeAll(async () => {
  server = createServer((req, res) => { void handleVoiceIo(req, res, new URL(req.url!, "http://x").pathname, deps) })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(() => { server.close() })
beforeEach(() => {
  logs = []; calls = []; fail = new Set(); spoken = []
  deps = {
    stt: () => "auto",
    host: () => ({ ...host }),
    voiceOf: (id, peer) => id === "alpha" ? ELEVEN : id === "sys" ? SYSTEM : peer === "peer-b" && id === "beta" ? ELEVEN : null,
    elevenLabsKey: () => "k",
    log: (l) => logs.push(l),
    engines: { elevenlabs: engine("elevenlabs"), "mlx-whisper": engine("mlx-whisper"), whisper: engine("whisper") },
    synth: async (_key, voice, text) => { spoken.push({ voice, text }); return Buffer.from("ID3-mp3") },
    // The fake bytes can't be decoded; the real measurement has its own
    // tests (voice-io-measure.test.ts). Here every recording is 3 s.
    measure: async () => 3,
  }
})

const SHORT = { "X-Audio-Duration-Ms": "3000" }
const transcribe = (body: BodyInit, headers: Record<string, string> = { "Content-Type": "audio/webm;codecs=opus", ...SHORT }) =>
  fetch(`${base}/voice/transcribe`, { method: "POST", headers, body })
const speak = (body: unknown) => fetch(`${base}/voice/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

describe("engine order", () => {
  it("is ElevenLabs, then a local Whisper that has ffmpeg, as on the Mac", () => {
    expect(sttEngines("auto", host)).toEqual(["elevenlabs", "mlx-whisper"])
    expect(sttEngines("elevenlabs", host)).toEqual(["elevenlabs", "mlx-whisper"])
    expect(sttEngines("local", host)).toEqual(["mlx-whisper"])
    expect(sttEngines("auto", { ...host, key: null })).toEqual(["mlx-whisper"])
    expect(sttEngines("auto", { ...host, mlx: null, whisper: "/bin/whisper" })).toEqual(["elevenlabs", "whisper"])
    // No ffmpeg: a local Whisper can't read the phone's webm or mp4.
    expect(sttEngines("auto", { ...host, ffmpeg: null })).toEqual(["elevenlabs"])
    expect(sttEngines("local", { key: "k", mlx: null, whisper: null, ffmpeg: null })).toEqual([])
  })

  it("takes the formats phones record, codec parameters aside", () => {
    expect(audioExt("audio/webm;codecs=opus")).toBe("webm")
    expect(audioExt("audio/mp4")).toBe("m4a")
    expect(audioExt("audio/ogg; codecs=opus")).toBe("ogg")
    expect(audioExt("text/plain")).toBeNull()
    expect(audioExt(undefined)).toBeNull()
  })

  it("is mesh-gated: only loopback or a mesh token reaches it", () => {
    expect(isMeshGatedPath("/voice/transcribe")).toBe(true)
    expect(isMeshGatedPath("/voice/speak")).toBe(true)
  })
})

describe("POST /voice/transcribe", () => {
  it("transcribes with ElevenLabs first and deletes the recording", async () => {
    const r = await transcribe(AUDIO)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ text: "hello from scribe", engine: "elevenlabs" })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ engine: "elevenlabs", mime: "audio/webm;codecs=opus", bytes: AUDIO.length })
    expect(calls[0].file.endsWith("speech.webm")).toBe(true)
    expect(existsSync(calls[0].file)).toBe(false)
  })

  it("falls back to the local Whisper when ElevenLabs fails", async () => {
    fail.add("elevenlabs")
    const r = await transcribe(AUDIO, { "Content-Type": "audio/mp4", ...SHORT })
    expect(await r.json()).toEqual({ text: "hello from whisper", engine: "mlx-whisper" })
    expect(calls.map((c) => c.engine)).toEqual(["elevenlabs", "mlx-whisper"])
    expect(calls[1].file.endsWith("speech.m4a")).toBe(true)
  })

  it("answers 503 with what to install when this computer has no engine", async () => {
    deps.host = () => ({ key: null, mlx: null, whisper: null, ffmpeg: null })
    const r = await transcribe(AUDIO)
    expect(r.status).toBe(503)
    const j = await r.json()
    expect(j.error).toMatch(/isn't set up/)
    expect(j.hint).toMatch(/Install ffmpeg on this computer.*ElevenLabs key.*mlx-whisper and ffmpeg/)
    expect(calls).toEqual([])
    expect(sttSetupHint("auto", { key: null, mlx: "/x", whisper: null, ffmpeg: null })).toMatch(/no ffmpeg/)
  })

  it("answers 502 when every engine fails, naming them", async () => {
    fail.add("elevenlabs"); fail.add("mlx-whisper")
    const r = await transcribe(AUDIO)
    expect(r.status).toBe(502)
    expect((await r.json()).detail).toMatch(/elevenlabs: .*; mlx-whisper: /)
  })

  it("bounds the size, the length and the type", async () => {
    expect((await transcribe(AUDIO, { "Content-Type": "text/plain", ...SHORT })).status).toBe(415)
    const long = await transcribe(AUDIO, { "Content-Type": "audio/webm", "X-Audio-Duration-Ms": String(AUDIO_LIMITS.ms + 5000) })
    expect(long.status).toBe(413)
    expect((await long.json()).error).toMatch(/longer than 2 minutes/)
    expect((await transcribe(Buffer.alloc(0))).status).toBe(400)
    expect(calls).toEqual([])
  })

  it("requires the stated length: missing or malformed is refused", async () => {
    for (const d of [undefined, "", "abc", "-5", "1e9", "3000ms"]) {
      const r = await transcribe(AUDIO, { "Content-Type": "audio/webm", ...(d === undefined ? {} : { "X-Audio-Duration-Ms": d }) })
      expect(r.status, String(d)).toBe(400)
    }
    expect(checkDurationHeader("120000")).toBeNull()
    expect(checkDurationHeader(String(AUDIO_LIMITS.ms + 2001))?.status).toBe(413)
    expect(calls).toEqual([])
  })

  it("caps the bytes at 2 minutes of the phone's bitrate, whatever length is stated", async () => {
    // 2 minutes at the recorder's 64 kbps is under 1 MB; the cap leaves room.
    expect(AUDIO_LIMITS.bytes).toBeGreaterThan((AUDIO_LIMITS.ms / 1000) * AUDIO_LIMITS.bitsPerSecond / 8)
    expect(AUDIO_LIMITS.bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    const r = await transcribe(Buffer.alloc(AUDIO_LIMITS.bytes + 1), { "Content-Type": "audio/webm", "X-Audio-Duration-Ms": "1000" })
    expect(r.status).toBe(413)
    expect(calls).toEqual([])
  })

  it("refuses phone voice input where ffmpeg is missing, even with an ElevenLabs key", async () => {
    // Without ffmpeg the length can't be measured, and neither the header
    // nor the byte cap bounds it.
    deps.host = () => ({ key: "k", mlx: null, whisper: null, ffmpeg: null })
    deps.nodeName = "office-mac"
    const r = await transcribe(AUDIO)
    expect(r.status).toBe(503)
    expect((await r.json()).hint).toBe("Install ffmpeg on office-mac for voice input from the phone.")
    expect(calls).toEqual([])
  })

  it("refuses a recording ffmpeg can't decode", async () => {
    deps.measure = async () => null
    expect((await transcribe(AUDIO)).status).toBe(422)
    expect(calls).toEqual([])
  })

  it("measures the recording and refuses a long one whose header lies", async () => {
    deps.measure = async () => AUDIO_LIMITS.ms / 1000 + 30
    const r = await transcribe(AUDIO, { "Content-Type": "audio/webm", "X-Audio-Duration-Ms": "1000" })
    expect(r.status).toBe(413)
    expect(calls).toEqual([])
    deps.measure = async () => 2.5
    expect((await transcribe(AUDIO)).status).toBe(200)
  })

  it(`runs at most ${MAX_TRANSCRIBING} transcriptions at once`, async () => {
    let open: Array<() => void> = []
    deps.engines = { elevenlabs: async () => { await new Promise<void>((r) => open.push(r)); return "hi" } }
    const first = Array.from({ length: MAX_TRANSCRIBING }, () => transcribe(AUDIO))
    for (let i = 0; i < 200 && open.length < MAX_TRANSCRIBING; i++) await new Promise((r) => setTimeout(r, 5))
    expect(open.length).toBe(MAX_TRANSCRIBING)
    expect((await transcribe(AUDIO)).status).toBe(429)
    open.forEach((r) => r()); open = []
    for (const r of await Promise.all(first)) expect(r.status).toBe(200)
    // The slots are free again.
    deps.engines = { elevenlabs: async () => "hi" }
    expect((await transcribe(AUDIO)).status).toBe(200)
  })

  it("never writes the audio or the words to the log", async () => {
    fail.add("elevenlabs")
    await transcribe(AUDIO)
    const all = logs.join("\n")
    expect(logs.length).toBeGreaterThan(0)
    expect(all).not.toContain("OggS")
    expect(all).not.toContain("hello from")
    expect(all).not.toContain("speech.webm")
  })
})

describe("POST /voice/speak", () => {
  it("speaks the answer in the agent's ElevenLabs voice, as mp3", async () => {
    const r = await speak({ agent: "alpha", text: "**Done.** See [the docs](https://example.com)." })
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("audio/mpeg")
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("ID3-mp3")
    expect(spoken).toEqual([{ voice: ELEVEN, text: "Done. See the docs." }])
  })

  it("finds a mesh peer's agent by the peer", async () => {
    expect((await speak({ agent: "beta", peer: "peer-b", text: "hi" })).status).toBe(200)
    expect((await speak({ agent: "beta", text: "hi" })).status).toBe(404)
  })

  it("drops the agentx:ui block and markdown, and caps what is said", () => {
    const text = `# Title\n\nHello *there*.\n\n${FENCE}agentx:ui\n{"buttons":[{"label":"Go","url":"https://example.com"}]}\n${FENCE}`
    expect(speakableAnswer(text)).toBe("Title. Hello there.")
    const long = speakableAnswer("word ".repeat(2000))
    expect(long.length).toBeLessThanOrEqual(SPEAK_MAX_CHARS + 3)
    expect(long.endsWith("...")).toBe(true)
  })

  it("hands the cleaned text back for the phone's own voice when ElevenLabs can't speak", async () => {
    // The normal case for a system-voice agent: a 200, not an error.
    const sys = await speak({ agent: "sys", text: "Hello `code` there" })
    expect(sys.status).toBe(200)
    expect(await sys.json()).toMatchObject({ fallback: "browser", text: "Hello there" })

    deps.elevenLabsKey = () => null
    const nokey = await speak({ agent: "alpha", text: "Hi" })
    expect(nokey.status).toBe(200)
    expect(await nokey.json()).toMatchObject({ fallback: "browser", text: "Hi", reason: expect.stringMatching(/No ElevenLabs key/) })

    deps.elevenLabsKey = () => "k"
    deps.synth = async () => { throw new Error("quota exceeded") }
    const broken = await speak({ agent: "alpha", text: "Hi" })
    expect(broken.status).toBe(502)
    expect(await broken.json()).toMatchObject({ fallback: "browser", text: "Hi" })
    expect(spoken).toEqual([])
  })

  it("refuses an unknown agent, a missing agent and nothing to say", async () => {
    expect((await speak({ agent: "ghost", text: "hi" })).status).toBe(404)
    expect((await speak({ text: "hi" })).status).toBe(400)
    expect((await speak({ agent: "alpha", text: `${FENCE}js\nx()\n${FENCE}` })).status).toBe(422)
    expect((await fetch(`${base}/voice/speak`)).status).toBe(405)
  })
})
