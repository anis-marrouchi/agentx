import { describe, it, expect, afterEach } from "vitest"
import {
  DEFAULT_VOICE_ID,
  INTRO_GAP_MS,
  VoiceIntroTracker,
  deriveIntro,
  introInstruction,
  pickVoiceId,
  resolveAgentVoice,
} from "../src/voice/agent-voice"
import { daemonConfigSchema } from "../src/daemon/config"

describe("resolveAgentVoice", () => {
  it("uses the configured voice block", () => {
    const v = resolveAgentVoice("marketing-agent", {
      "marketing-agent": {
        name: "Nadia",
        voice: { elevenlabsVoiceId: "abc", gender: "female", style: "warm", intro: "Hi, Nadia here." },
      },
    } as any, {}, [])
    expect(v).toEqual({
      agentId: "marketing-agent", name: "Nadia", provider: "system", elevenlabsVoiceId: "abc",
      systemVoice: null, systemVoiceName: null, systemByLanguage: {}, fallback: true,
      gender: "female", style: "warm", intro: "Hi, Nadia here.",
    })
  })

  it("leaves the voice id null and derives an intro when unconfigured", () => {
    const v = resolveAgentVoice("coder-agent", {
      "coder-agent": {
        name: "Coder",
        systemPrompt: "You are Coder, Noqta's local coding agent. You write clean code.",
      },
    } as any, {}, [])
    expect(v.elevenlabsVoiceId).toBeNull()
    expect(v.intro).toBe("Hello, this is Coder, Noqta's local coding agent.")
  })

  it("falls back to the id when the agent is unknown", () => {
    expect(resolveAgentVoice("ghost", {}, {}, []).intro).toBe("Hello, this is ghost.")
  })
})

describe("deriveIntro", () => {
  it.each([
    ["Nadia", "You are Nadia, the marketing agent for Noqta (noqta.tn). You handle content.",
      "Hello, this is Nadia, the marketing agent for Noqta."],
    ["Accountant", "You are the Accountant agent for Noqta. You handle invoices.",
      "Hello, this is the Accountant agent for Noqta."],
    ["Graph Agent", "You are a taxonomy/graph agent. Respond with JSON.",
      "Hello, this is Graph Agent, a taxonomy/graph agent."],
    ["Hakim", undefined, "Hello, this is Hakim."],
    ["Bot", "Answer briefly.", "Hello, this is Bot."],
  ])("%s", (name, prompt, expected) => {
    expect(deriveIntro(name, prompt)).toBe(expected)
  })
})

describe("pickVoiceId", () => {
  const saved = process.env.AGENTX_VOICE_ID
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTX_VOICE_ID
    else process.env.AGENTX_VOICE_ID = saved
  })

  it("prefers explicit, then agent, then env, then the default", () => {
    process.env.AGENTX_VOICE_ID = "env"
    expect(pickVoiceId("cli", "agent")).toBe("cli")
    expect(pickVoiceId(null, "agent")).toBe("agent")
    expect(pickVoiceId(null, null)).toBe("env")
    delete process.env.AGENTX_VOICE_ID
    expect(pickVoiceId()).toBe(DEFAULT_VOICE_ID)
  })
})

describe("VoiceIntroTracker", () => {
  it("introduces once per session and agent", () => {
    const t = new VoiceIntroTracker()
    expect(t.needsIntro("s1", "nadia", 0)).toBe(true)
    t.spoke("s1", "nadia", 0)
    expect(t.needsIntro("s1", "nadia", 1_000)).toBe(false)
    // A different agent, or a new session, gets its own introduction.
    expect(t.needsIntro("s1", "coder", 1_000)).toBe(true)
    expect(t.needsIntro("s2", "nadia", 1_000)).toBe(true)
  })

  it("introduces again after a long gap, measured from the last reply", () => {
    const t = new VoiceIntroTracker()
    t.spoke("s", "a", 0)
    t.spoke("s", "a", INTRO_GAP_MS)
    expect(t.needsIntro("s", "a", INTRO_GAP_MS * 2)).toBe(false)
    expect(t.needsIntro("s", "a", INTRO_GAP_MS * 2 + 1)).toBe(true)
  })

  it("stays bounded", () => {
    const t = new VoiceIntroTracker()
    for (let i = 0; i < 600; i++) t.spoke(`s${i}`, "a", i)
    expect(t.needsIntro("s0", "a", 700)).toBe(true)
    expect(t.needsIntro("s599", "a", 700)).toBe(false)
  })
})

describe("introInstruction", () => {
  const voice = resolveAgentVoice("n", { n: { name: "Nadia", voice: { intro: "Hi, Nadia here.", style: "upbeat" } } } as any, {}, [])

  it("asks for the intro on first contact", () => {
    const s = introInstruction(voice, true)
    expect(s).toContain("[VOICE INTRO]")
    expect(s).toContain("Hi, Nadia here.")
    expect(s).toContain("upbeat")
  })

  it("forbids a repeat intro afterwards", () => {
    const s = introInstruction(voice, false)
    expect(s).toContain("[VOICE CASUAL]")
    expect(s).not.toContain("Hi, Nadia here.")
  })
})

describe("agent voice config", () => {
  const base = { name: "Nadia", workspace: "/tmp" }

  it("accepts a voice block and remains optional", () => {
    const cfg = (agent: object) => daemonConfigSchema.safeParse({ node: { id: "n", name: "n" }, agents: { a: agent } })
    expect(cfg(base).success).toBe(true)
    const ok = cfg({ ...base, voice: { elevenlabsVoiceId: "x", gender: "female", style: "warm", intro: "Hi" } })
    expect(ok.success).toBe(true)
    expect(cfg({ ...base, voice: { gender: "robot" } }).success).toBe(false)
  })
})
