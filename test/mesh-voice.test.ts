import { describe, it, expect } from "vitest"
import { EventEmitter } from "events"
import type { ChildProcess } from "child_process"
import {
  MeshVoices, PREMADE_VOICES, assignVoices, clipSpeech, genderFromCard, loadVoicePool, parseVoiceSwitch,
  type MeshDirectory, type PoolVoice,
} from "../src/voice/mesh-voice"
import { DEFAULT_VOICE_ID, VoiceIntroTracker, remoteVoiceAppend } from "../src/voice/agent-voice"
import { VoiceMeshProxy } from "../src/daemon/voice-mesh-proxy"
import { VoiceTalkService } from "../src/daemon/voice-talk-api"
import { SpeechOut } from "../src/voice/speaker"
import { Channel, type LineModel } from "../src/voice/talk-model"
import { daemonConfigSchema } from "../src/daemon/config"

const directory: MeshDirectory = [{
  peer: "clawd-server",
  healthy: true,
  skills: [
    { id: "atlas", name: "Main Agent", description: "You are Main Agent on clawd-server for Noqta.", tags: ["claude-code", "@noqta_atlas_bot", "atlas"] },
    { id: "omar", name: "Omar Agent", description: "You are Omar Agent on clawd-server for Noqta.", tags: [] },
    { id: "mtgl-v2", name: "MTGL V2 Agent", description: "You are the MTGL V2 coding agent.", tags: [] },
    // Also local: the local agent wins.
    { id: "secretary-agent", name: "Remote Secretary", description: "", tags: [] },
  ],
}]

function config(meshVoices: Record<string, any> = {}): any {
  return {
    node: { id: "macbook-local" },
    agents: {
      "secretary-agent": { name: "Secretary", systemPrompt: "You are Anis's personal secretary.", voice: { elevenlabsVoiceId: "EXAVITQu4vr4xnSDxMaL" } },
      "marketing-agent": { name: "Nadia", systemPrompt: "You are Nadia, the marketing agent.", voice: { elevenlabsVoiceId: "cgSgspJ2msm6clMCkdW9" } },
    },
    meshVoices,
  }
}

describe("assignVoices", () => {
  const pool: PoolVoice[] = [
    { id: "a", gender: "female", premade: true }, { id: "b", gender: "male", premade: true },
    { id: "c", gender: "male", premade: true }, { id: "d", gender: "female", premade: false },
  ]

  it("gives every agent its own voice, skipping reserved ones, premade first", () => {
    const out = assignVoices([{ id: "x", gender: null }, { id: "y", gender: null }], pool, new Set(["a"]))
    expect(new Set(out.values()).size).toBe(2)
    expect([...out.values()].every((v) => v === "b" || v === "c")).toBe(true)
  })

  it("matches a known gender, and only repeats once the pool runs dry", () => {
    expect(assignVoices([{ id: "x", gender: "female" }], pool, new Set(["a"])).get("x")).toBe("d")
    const many = assignVoices(["p", "q", "r", "s", "t"].map((id) => ({ id, gender: null })), pool, new Set())
    expect(new Set([...many.values()].slice(0, 4)).size).toBe(4)
    expect(many.size).toBe(5)
  })

  it("is stable: the same agents get the same voices", () => {
    const agents = ["atlas", "omar", "seif"].map((id) => ({ id, gender: null }))
    expect(assignVoices(agents, PREMADE_VOICES, new Set())).toEqual(assignVoices([...agents].reverse(), PREMADE_VOICES, new Set()))
  })
})

describe("card-derived voice details", () => {
  it("reads gender only from pronouns in the description", () => {
    expect(genderFromCard("You are Atlas. She handles ops.")).toBe("female")
    expect(genderFromCard("You are Omar; his job is billing.")).toBe("male")
    expect(genderFromCard("You are Main Agent on clawd-server for Noqta.")).toBeNull()
  })

  it("clips a long reply to its first sentences for speech", () => {
    expect(clipSpeech("One. Two! Three? Four. Five.")).toBe("One. Two! Three?")
    expect(clipSpeech("No full stop")).toBe("No full stop")
  })
})

describe("parseVoiceSwitch", () => {
  it.each([
    ["talk to Atlas", "Atlas"],
    ["Can I speak with the secretary?", "the secretary"],
    ["OK, switch to Omar.", "Omar"],
    ["back to secretary", "secretary"],
    ["Go back to Nadia", "Nadia"],
    ["put me through to atlas", "atlas"],
  ])("%s → %s", (said, name) => expect(parseVoiceSwitch(said)).toBe(name))

  it("ignores ordinary questions", () => {
    expect(parseVoiceSwitch("what is on my calendar")).toBeNull()
    expect(parseVoiceSwitch("tell atlas to deploy")).toBeNull()
  })
})

describe("MeshVoices", () => {
  it("lists remote agents, local ids win", () => {
    const v = new MeshVoices(() => config(), () => directory)
    expect(v.list().map((a) => a.id)).toEqual(["atlas", "omar", "mtgl-v2"])
    expect(v.get("secretary-agent")).toBeUndefined()
  })

  it("derives name, intro and a distinct voice that no local agent uses", () => {
    const v = new MeshVoices(() => config(), () => directory)
    const voices = v.list().map((a) => v.voice(a.id))
    expect(voices[0]).toMatchObject({ agentId: "atlas", name: "Main Agent", gender: null, intro: "Hello, this is Main Agent on clawd-server for Noqta." })
    const ids = voices.map((x) => x.elevenlabsVoiceId)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    for (const taken of ["EXAVITQu4vr4xnSDxMaL", "cgSgspJ2msm6clMCkdW9", DEFAULT_VOICE_ID]) expect(ids).not.toContain(taken)
  })

  it("uses meshVoices when set, and keeps that voice off everyone else", () => {
    const pinned = PREMADE_VOICES[5].id
    const v = new MeshVoices(() => config({ atlas: { name: "Atlas", elevenlabsVoiceId: pinned, style: "calm" } }), () => directory)
    expect(v.voice("atlas")).toMatchObject({ name: "Atlas", elevenlabsVoiceId: pinned, style: "calm", intro: "Hello, this is Atlas, Main Agent on clawd-server for Noqta." })
    expect([v.voice("omar"), v.voice("mtgl-v2")].map((x) => x.elevenlabsVoiceId)).not.toContain(pinned)
  })

  it("resolves spoken names to local and remote agents", () => {
    const v = new MeshVoices(() => config({ atlas: { name: "Atlas" } }), () => directory)
    expect(v.resolve("Atlas")).toBe("atlas")
    expect(v.resolve("the main agent")).toBe("atlas")
    expect(v.resolve("secretary")).toBe("secretary-agent")
    expect(v.resolve("Nadia")).toBe("marketing-agent")
    expect(v.resolve("omar")).toBe("omar")
    expect(v.resolve("mtgl v2")).toBe("mtgl-v2")
    expect(v.resolve("nobody")).toBeUndefined()
  })

  it("makes a talk speaker from the agent card", () => {
    const s = new MeshVoices(() => config(), () => directory).speaker("omar", true)!
    expect(s).toMatchObject({ agentId: "omar", name: "Omar Agent", persona: "You are Omar Agent on clawd-server for Noqta." })
    expect(s.introLine).toContain("[VOICE INTRO]")
  })
})

describe("loadVoicePool", () => {
  it("keeps premade and library voices, never clones", async () => {
    const fake = (async () => new Response(JSON.stringify({ voices: [
      { voice_id: "p1", category: "premade", labels: { gender: "male" } },
      { voice_id: "l1", category: "professional", labels: { gender: "female" } },
      { voice_id: "c1", category: "cloned" },
      { voice_id: "g1", category: "generated" },
    ] }))) as unknown as typeof fetch
    expect(await loadVoicePool("k", fake)).toEqual([
      { id: "p1", gender: "male", premade: true }, { id: "l1", gender: "female", premade: false },
    ])
  })

  it("falls back to the premade list", async () => {
    expect(await loadVoicePool(null)).toBe(PREMADE_VOICES)
    const failing = (async () => { throw new Error("offline") }) as unknown as typeof fetch
    expect(await loadVoicePool("k", failing)).toBe(PREMADE_VOICES)
  })
})

describe("remoteVoiceAppend (receiving node)", () => {
  it("builds the voice instruction from the voice fields only", () => {
    const a = remoteVoiceAppend({ channel: "voice", voice: { introduce: true, intro: "Hello, this is Atlas.", style: "calm" } })!
    expect(a).toContain("[VOICE MODE]")
    expect(a).toContain("[VOICE INTRO]")
    expect(a).toContain("Hello, this is Atlas.")
    expect(remoteVoiceAppend({ channel: "voice", voice: { introduce: false } })).toContain("[VOICE CASUAL]")
  })

  it("does nothing for other tasks and clips what crosses the mesh", () => {
    expect(remoteVoiceAppend({ channel: "telegram", voice: { introduce: true } })).toBeUndefined()
    expect(remoteVoiceAppend({ channel: "voice" })).toBeUndefined()
    expect(remoteVoiceAppend(undefined)).toBeUndefined()
    const long = remoteVoiceAppend({ channel: "voice", voice: { introduce: true, intro: "x".repeat(5000) } })!
    expect(long.length).toBeLessThan(1200)
  })
})

describe("VoiceMeshProxy", () => {
  function proxy(sendTask: (...a: any[]) => Promise<string>) {
    const calls: any[][] = []
    const mesh = { directory: () => directory as any, sendTask: async (...a: any[]) => { calls.push(a); return sendTask(...a) } }
    return { p: new VoiceMeshProxy(() => config({ atlas: { name: "Atlas" } }), () => mesh as any), calls }
  }

  it("switches a session's target until 'back to …'", () => {
    const { p } = proxy(async () => "")
    expect(p.switchTo("s1", "talk to me about the budget", "secretary-agent")).toBeNull()
    expect(p.switchTo("s1", "talk to Atlas", "secretary-agent")).toBe("atlas")
    expect(p.target("s1", "secretary-agent")).toBe("atlas")
    expect(p.target("s2", "secretary-agent")).toBe("secretary-agent")
    expect(p.switchTo("s1", "back to secretary", "secretary-agent")).toBe("secretary-agent")
    expect(p.target("s1", "secretary-agent")).toBe("secretary-agent")
  })

  it("forwards a turn to the owning peer with a stable, warm voice session", async () => {
    const { p, calls } = proxy(async () => "Deploy is green.")
    const voice = p.voices.voice("atlas")
    const r = await p.ask("atlas", "how is the deploy", voice, true)
    expect(r).toMatchObject({ content: "Deploy is green.", peer: "clawd-server" })
    const [peer, message, agent, opts] = calls[0]
    expect([peer, message, agent]).toEqual(["clawd-server", "how is the deploy", "atlas"])
    expect(opts.freshSession).toBe(false)
    expect(opts.context).toMatchObject({ channel: "voice", chatId: "voice:macbook-local", voice: { introduce: true, intro: voice.intro } })
  })

  it("reports a failed peer instead of throwing, and lists known agents", async () => {
    const { p } = proxy(async () => { throw new Error('Peer "clawd-server" is not healthy') })
    const r = await p.ask("atlas", "hi", p.voices.voice("atlas"), false)
    expect(r.error).toContain("not healthy")
    expect(p.known()).toEqual({ local: ["secretary-agent", "marketing-agent"], mesh: ["atlas", "omar", "mtgl-v2"] })
    expect(p.isRemote("atlas")).toBe(true)
    expect(p.isRemote("secretary-agent")).toBe(false)
  })
})

describe("talk with a remote agent", () => {
  class Model implements LineModel {
    reply(_m: string, signal?: AbortSignal) {
      const c = new Channel<string>()
      setTimeout(() => { c.push("Short. DONE"); c.end() }, 5)
      return c.read(signal)
    }
    close() {}
  }

  it("accepts a mesh agent on either side and refuses unknown ones", () => {
    const play = () => { const p = new EventEmitter() as ChildProcess; setTimeout(() => p.emit("close", 0), 5); (p as any).kill = () => p.emit("close", null); return p }
    const mesh = new MeshVoices(() => config(), () => directory)
    const svc = new VoiceTalkService(() => config().agents, new VoiceIntroTracker(), () => {}, {
      speech: new SpeechOut(async () => null, play), stopSpeakers: () => {},
      model: () => new Model(),
      remote: (id, introduce) => mesh.speaker(id, introduce),
    })
    expect(svc.handle("POST", "/talk", { agents: ["secretary-agent", "nobody"], topic: "x" }).status).toBe(404)
    const started = svc.handle("POST", "/talk", { agents: ["secretary-agent", "atlas"], topic: "the deploy" })
    expect(started.status).toBe(201)
    svc.handle("POST", "/talk/stop", {})
  })
})

describe("meshVoices config", () => {
  it("parses, defaults to empty", () => {
    const base = { node: { id: "n", name: "n" } }
    expect(daemonConfigSchema.parse(base).meshVoices).toEqual({})
    const parsed = daemonConfigSchema.parse({ ...base, meshVoices: { atlas: { name: "Atlas", gender: "male", elevenlabsVoiceId: "x" } } })
    expect(parsed.meshVoices.atlas).toEqual({ name: "Atlas", gender: "male", elevenlabsVoiceId: "x" })
  })
})
