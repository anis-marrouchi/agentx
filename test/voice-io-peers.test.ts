import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { handleVoiceIo, resolveVoice } from "../src/daemon/voice-io-api"
import { MeshVoices, type MeshDirectory } from "../src/voice/mesh-voice"
import type { VoiceRef } from "../src/voice/speaker"

// A phone conversation is pinned to an agent on one peer. When two peers
// both run an agent called "main", the answer must be spoken in the voice
// of the one the conversation is with. This goes through the daemon's real
// wiring: resolveVoice over a real MeshVoices, not a stub.

const directory: MeshDirectory = [
  { peer: "peer-a", healthy: true, skills: [{ id: "main", name: "Main", description: "The first computer's agent." }] },
  { peer: "peer-b", healthy: true, skills: [{ id: "main", name: "Main", description: "The second computer's agent." }, { id: "helper", name: "Helper" }] },
]

function mesh(meshVoices: Record<string, any> = {}) {
  const config = { agents: { local: { name: "Local", voice: { provider: "elevenlabs" as const, elevenlabsVoiceId: "voice-local" } } } as any, voice: { provider: "elevenlabs" as const }, meshVoices }
  return { config, voices: new MeshVoices(() => config, () => directory, () => []) }
}

describe("the voice of an agent on a mesh peer", () => {
  it("follows meshVoices pinned per peer", () => {
    const { config, voices } = mesh({ "peer-a/main": { elevenlabsVoiceId: "voice-A" }, "peer-b/main": { elevenlabsVoiceId: "voice-B" } })
    expect(resolveVoice("main", "peer-a", config, voices)?.elevenlabs).toBe("voice-A")
    expect(resolveVoice("main", "peer-b", config, voices)?.elevenlabs).toBe("voice-B")
  })

  it("gives the same id on two peers two different voices when nothing is pinned", () => {
    const { config, voices } = mesh()
    const a = resolveVoice("main", "peer-a", config, voices)!
    const b = resolveVoice("main", "peer-b", config, voices)!
    expect(a.provider).toBe("elevenlabs")
    expect(a.elevenlabs).not.toBe(b.elevenlabs)
    // The agent list() picks keeps the voice it had before.
    expect(a.elevenlabs).toBe(voices.voice("main").elevenlabsVoiceId)
  })

  it("keeps an id-wide meshVoices entry for every peer, and a per-peer one wins", () => {
    const { config, voices } = mesh({ main: { elevenlabsVoiceId: "voice-all" }, "peer-b/main": { elevenlabsVoiceId: "voice-B" } })
    expect(resolveVoice("main", "peer-a", config, voices)?.elevenlabs).toBe("voice-all")
    expect(resolveVoice("main", "peer-b", config, voices)?.elevenlabs).toBe("voice-B")
  })

  it("never borrows another peer's agent, and keeps local agents local", () => {
    const { config, voices } = mesh()
    expect(resolveVoice("helper", "peer-a", config, voices)).toBeNull()
    expect(resolveVoice("main", "peer-c", config, voices)).toBeNull()
    expect(resolveVoice("local", undefined, config, voices)?.elevenlabs).toBe("voice-local")
    expect(resolveVoice("main", undefined, config, voices)).toBeNull()
  })
})

describe("POST /voice/speak with the real wiring", () => {
  let server: Server
  let base: string
  const spoken: Array<{ voice: VoiceRef; text: string }> = []
  const { config, voices } = mesh({ "peer-a/main": { elevenlabsVoiceId: "voice-A" }, "peer-b/main": { elevenlabsVoiceId: "voice-B" } })

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleVoiceIo(req, res, "/voice/speak", {
        stt: () => "auto",
        host: () => ({ key: "k", mlx: null, whisper: null, ffmpeg: null }),
        voiceOf: (id, peer) => resolveVoice(id, peer, config, voices),
        elevenLabsKey: () => "k",
        log: () => {},
        synth: async (_k, voice, text) => { spoken.push({ voice, text }); return Buffer.from("ID3") },
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => { server.close() })

  it("speaks a peer-b conversation in peer-b's voice", async () => {
    const r = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "main", peer: "peer-b", text: "Hello." }) })
    expect(r.status).toBe(200)
    const r2 = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "main", peer: "peer-a", text: "Hello." }) })
    expect(r2.status).toBe(200)
    expect(spoken.map((s) => s.voice.elevenlabs)).toEqual(["voice-B", "voice-A"])
  })
})
