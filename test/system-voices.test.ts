import { describe, it, expect, vi, afterEach } from "vitest"
import {
  candidates, castVoices, findVoice, parseVoiceList, setVoiceLog, type SystemVoice,
} from "../src/voice/system-voices"
import { localSystemVoices, resolveAgentVoice, voiceRef } from "../src/voice/agent-voice"
import { elevenLabsSynth, sayArgs, type VoiceRef } from "../src/voice/speaker"
import { MeshVoices } from "../src/voice/mesh-voice"
import { daemonConfigSchema } from "../src/daemon/config"

/** What JXA prints on a Mac with only the standard voices, plus noise. */
const JXA_OUT = [
  "com.apple.voice.compact.en-GB.Daniel\tDaniel\ten-GB\t1\t1",
  "com.apple.voice.compact.en-US.Samantha\tSamantha\ten-US\t1\t2",
  "com.apple.voice.compact.en-AU.Karen\tKaren\ten-AU\t1\t2",
  "com.apple.voice.compact.en-IN.Rishi\tRishi\ten-IN\t1\t1",
  "com.apple.eloquence.en-US.Flo\tFlo\ten-US\t1\t0",
  "com.apple.eloquence.en-GB.Flo\tFlo\ten-GB\t1\t0",
  "com.apple.eloquence.en-US.Reed\tReed\ten-US\t1\t0",
  "com.apple.eloquence.en-US.Eddy\tEddy\ten-US\t1\t0",
  "com.apple.eloquence.en-GB.Eddy\tEddy\ten-GB\t1\t0",
  "com.apple.speech.synthesis.voice.Fred\tFred\ten-US\t1\t1",
  "com.apple.speech.synthesis.voice.Kathy\tKathy\ten-US\t1\t0",
  "com.apple.speech.synthesis.voice.Albert\tAlbert\ten-US\t1\t0",
  "com.apple.speech.synthesis.voice.Bells\tBells\ten-US\t1\t0",
  "com.apple.ttsbundle.siri_aaron_en-US_compact\tAaron\ten-US\t1\t1",
  "com.apple.voice.compact.fr-FR.Thomas\tThomas\tfr-FR\t1\t1",
  "com.apple.voice.compact.fr-CA.Amelie\tAmélie\tfr-CA\t1\t2",
].join("\n")

const STANDARD = parseVoiceList(JXA_OUT)
const PREMIUM: SystemVoice = { id: "com.apple.voice.premium.en-US.Ava", name: "Ava", locale: "en-US", quality: "premium", gender: "female" }
const ENHANCED: SystemVoice = { id: "com.apple.voice.enhanced.en-GB.Serena", name: "Serena", locale: "en-GB", quality: "enhanced", gender: "female" }

const agents = (o: Record<string, { system?: string; provider?: "system" | "elevenlabs"; gender?: "female" | "male" }>) =>
  Object.fromEntries(Object.entries(o).map(([id, v]) => [id, { name: id, voice: v }])) as any

afterEach(() => { setVoiceLog((m) => process.stderr.write(m + "\n")); vi.unstubAllGlobals() })

describe("parseVoiceList", () => {
  it("drops Siri and novelty voices, keeps the classic ones, fills in gender", () => {
    const names = STANDARD.map((v) => v.name)
    expect(names).not.toContain("Aaron")
    expect(names).not.toContain("Bells")
    expect(names).not.toContain("Albert")
    expect(names).toContain("Fred")
    expect(STANDARD.find((v) => v.name === "Kathy")?.gender).toBe("female")
    expect(STANDARD.find((v) => v.name === "Reed")?.gender).toBe("male")
    expect(parseVoiceList("x\tAva\ten-US\t3\t2")[0]).toMatchObject({ quality: "premium", gender: "female" })
  })
})

describe("candidates", () => {
  it("prefers Premium, then Enhanced, then modern standard voices, in the configured language", () => {
    const ranked = candidates([...STANDARD, ENHANCED, PREMIUM], "en")
    expect(ranked.slice(0, 2).map((v) => v.name)).toEqual(["Ava", "Serena"])
    expect(ranked.map((v) => v.name)).not.toContain("Thomas")
    // Modern standard voices before the older families.
    expect(ranked.findIndex((v) => v.name === "Daniel")).toBeLessThan(ranked.findIndex((v) => v.name === "Flo"))
    expect(ranked.findIndex((v) => v.name === "Flo")).toBeLessThan(ranked.findIndex((v) => v.name === "Fred"))
  })

  it("follows the locale, and falls back to every voice when none match", () => {
    expect(candidates(STANDARD, "fr").map((v) => v.name).sort()).toEqual(["Amélie", "Thomas"])
    expect(candidates(STANDARD, "xx")).toHaveLength(STANDARD.length)
  })
})

describe("findVoice", () => {
  const all = [...STANDARD, PREMIUM]
  it("matches an identifier, a name, a tier suffix and say's language suffix", () => {
    expect(findVoice("com.apple.eloquence.en-GB.Eddy", all)?.locale).toBe("en-GB")
    expect(findVoice("daniel", all)?.id).toBe("com.apple.voice.compact.en-GB.Daniel")
    expect(findVoice("Ava (Premium)", all)?.id).toBe(PREMIUM.id)
    expect(findVoice("Eddy (English (US))", all, "en-US")?.locale).toBe("en-US")
  })

  it("returns null for a voice that is not installed", () => {
    expect(findVoice("Zoe (Premium)", all)).toBeNull()
    expect(findVoice("", all)).toBeNull()
  })
})

describe("castVoices", () => {
  const pool = candidates(STANDARD, "en")
  it("gives each agent a different speaker, alternating female and male", () => {
    const cast = castVoices(["a", "b", "c", "d"].map((id) => ({ id })), pool)
    const picks = [...cast.values()]
    expect(new Set(picks.map((v) => v.name)).size).toBe(4)
    expect(picks.map((v) => v.gender)).toEqual(["female", "male", "female", "male"])
  })

  it("honours a known gender and leaves taken names until last", () => {
    const cast = castVoices([{ id: "a", gender: "male" }], pool, new Set(["Daniel"]))
    expect(cast.get("a")?.name).toBe("Rishi")
  })

  it("treats one name in two locales as one speaker, and repeats only when out of voices", () => {
    const eddys = STANDARD.filter((v) => v.name === "Eddy")
    const cast = castVoices([{ id: "a" }, { id: "b" }, { id: "c" }], eddys)
    expect(cast.size).toBe(3)
    expect([...cast.values()].every((v) => v.name === "Eddy")).toBe(true)
    expect(castVoices([{ id: "a" }], [])).toEqual(new Map())
  })
})

describe("voice resolution: override → agent → global → auto-assign", () => {
  it("auto-assigns distinct voices on a fresh install, best first", () => {
    const voices = localSystemVoices(agents({ front: {}, sales: {}, billing: {} }), {}, [...STANDARD, PREMIUM])
    expect(voices.get("front")?.name).toBe("Ava")
    expect(new Set([...voices.values()].map((v) => v.name)).size).toBe(3)
  })

  it("an agent's own voice wins, and nobody else is given it", () => {
    const voices = localSystemVoices(agents({ front: {}, sales: { system: "Samantha" } }), {}, STANDARD)
    expect(voices.get("sales")?.name).toBe("Samantha")
    expect(voices.get("front")?.name).not.toBe("Samantha")
  })

  it("the global voice covers agents without their own", () => {
    const voices = localSystemVoices(agents({ front: {}, sales: { system: "Karen" } }), { system: "Daniel" }, STANDARD)
    expect(voices.get("front")?.name).toBe("Daniel")
    expect(voices.get("sales")?.name).toBe("Karen")
  })

  it("a missing voice falls back to the next choice and logs once", () => {
    const log: string[] = []
    setVoiceLog((m) => log.push(m))
    const cfg = agents({ front: { system: "Nobody Special" } })
    for (let i = 0; i < 3; i++) {
      expect(resolveAgentVoice("front", cfg, { system: "Daniel" }, STANDARD).systemVoiceName).toBe("Daniel en-GB")
    }
    expect(log.filter((l) => l.includes("Nobody Special"))).toHaveLength(1)
  })

  it("the provider is the agent's, then the global one, then system", () => {
    const cfg = agents({ front: {}, sales: { provider: "elevenlabs" } })
    expect(resolveAgentVoice("front", cfg, {}, STANDARD).provider).toBe("system")
    expect(resolveAgentVoice("sales", cfg, {}, STANDARD).provider).toBe("elevenlabs")
    expect(resolveAgentVoice("front", cfg, { provider: "elevenlabs" }, STANDARD).provider).toBe("elevenlabs")
    expect(resolveAgentVoice("front", cfg, { fallback: "none" }, STANDARD).fallback).toBe(false)
  })

  it("a one-off ElevenLabs id overrides the agent's", () => {
    const v = resolveAgentVoice("front", { front: { name: "Front", voice: { elevenlabsVoiceId: "agent-id" } } } as any, {}, [])
    expect(voiceRef(v, "cli-id").elevenlabs).toBe("cli-id")
    expect(voiceRef(v).elevenlabs).toBe("agent-id")
  })

  it("mesh agents get voices no local agent uses", () => {
    const config = { agents: agents({ front: {}, sales: {} }), meshVoices: {}, voice: {} }
    const directory = [{ peer: "p", healthy: true, skills: [{ id: "remote-a", name: "Remote A" }, { id: "remote-b", name: "Remote B" }] }]
    const mesh = new MeshVoices(() => config, () => directory, () => STANDARD)
    const local = [...localSystemVoices(config.agents, {}, STANDARD).values()].map((v) => v.name)
    const remote = [mesh.voice("remote-a").systemVoiceName, mesh.voice("remote-b").systemVoiceName].map((n) => n!.split(" ")[0])
    expect(remote.filter((n) => local.includes(n))).toEqual([])
    expect(mesh.speaker("remote-a", false)?.voice.provider).toBe("system")
  })
})

describe("speech engine", () => {
  const ref = (o: Partial<VoiceRef>): VoiceRef => ({ provider: "system", elevenlabs: "el-id", system: "com.apple.voice.compact.en-GB.Daniel", fallback: true, ...o })
  const signal = new AbortController().signal

  it("with the system provider, never calls ElevenLabs even with a key", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    expect(await elevenLabsSynth("key")({ voice: ref({}), text: "hi" }, signal)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("ElevenLabs without a key or with an error falls back to the system voice, unless told not to", async () => {
    setVoiceLog(() => {})
    const eleven = ref({ provider: "elevenlabs" })
    expect(await elevenLabsSynth(null)({ voice: eleven, text: "hi" }, signal)).toBeNull()
    await expect(elevenLabsSynth(null)({ voice: { ...eleven, fallback: false }, text: "hi" }, signal)).rejects.toThrow(/no key/)
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 401 })))
    expect(await elevenLabsSynth("key")({ voice: eleven, text: "hi" }, signal)).toBeNull()
    await expect(elevenLabsSynth("key")({ voice: { ...eleven, fallback: false }, text: "hi" }, signal)).rejects.toThrow(/401/)
  })

  it("passes the chosen voice to say, and nothing for the OS default", () => {
    expect(sayArgs(ref({}))).toEqual(["-v", "com.apple.voice.compact.en-GB.Daniel"])
    expect(sayArgs(ref({ system: null }))).toEqual([])
  })
})

describe("config", () => {
  it("defaults to free system voices with a system fallback", () => {
    const parsed = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(parsed.voice).toEqual({ provider: "system", fallback: "system", locale: "en" })
  })

  it("accepts a per-agent provider and system voice", () => {
    const parsed = daemonConfigSchema.parse({
      node: { id: "n", name: "n" },
      agents: { front: { name: "Front", workspace: ".", voice: { provider: "elevenlabs", system: "Daniel" } } },
    })
    expect(parsed.agents.front.voice).toEqual({ provider: "elevenlabs", system: "Daniel" })
  })
})

describe("agentx voice set", () => {
  const raw = () => ({ agents: { front: { name: "Front", workspace: ".", voice: { style: "warm" } } } })
  // Imported here so the CLI module's commander setup stays out of the other suites.
  const load = () => import("../src/commands/voice").then((m) => m.setAgentVoice)

  it("stores an installed system voice and keeps the rest of the block", async () => {
    const set = await load()
    const { raw: out, summary } = set(raw(), "front", "Daniel", undefined, STANDARD)
    expect(out.agents.front.voice).toEqual({ style: "warm", system: "Daniel" })
    expect(summary).toContain("Daniel en-GB")
  })

  it("takes an ElevenLabs id only with that provider, and rejects unknown names", async () => {
    const set = await load()
    expect(set(raw(), "front", "abc123", "elevenlabs", STANDARD).raw.agents.front.voice)
      .toEqual({ style: "warm", provider: "elevenlabs", elevenlabsVoiceId: "abc123" })
    expect(() => set(raw(), "front", "Nobody", undefined, STANDARD)).toThrow(/not an installed system voice/)
    expect(() => set(raw(), "ghost", "Daniel", undefined, STANDARD)).toThrow(/No agent/)
  })
})
