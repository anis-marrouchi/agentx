import { describe, it, expect } from "vitest"
import { EventEmitter } from "events"
import type { ChildProcess } from "child_process"
import { VoiceTalkService, talkSpeaker } from "../src/daemon/voice-talk-api"
import { VoiceIntroTracker } from "../src/voice/agent-voice"
import { SpeechOut } from "../src/voice/speaker"
import { Channel, type LineModel } from "../src/voice/talk-model"

const agents: any = {
  "secretary-agent": { name: "Secretary", systemPrompt: "You are Anis's personal secretary.\n\nRules: …", voice: { elevenlabsVoiceId: "sarah" } },
  "marketing-agent": { name: "Nadia", systemPrompt: "You are Nadia, the marketing agent for Noqta.", voice: { elevenlabsVoiceId: "jessica", narrate: "on" } },
}

class Model implements LineModel {
  constructor(private text: string) {}
  reply(_m: string, signal?: AbortSignal) {
    const c = new Channel<string>()
    setTimeout(() => { c.push(this.text); c.end() }, 5)
    return c.read(signal)
  }
  close() {}
}

function service() {
  const play = () => { const p = new EventEmitter() as ChildProcess; setTimeout(() => p.emit("close", 0), 10); (p as any).kill = () => p.emit("close", null); return p }
  const speech = new SpeechOut(async () => null, play)
  const intros = new VoiceIntroTracker()
  const svc = new VoiceTalkService(() => agents, intros, () => {}, { speech, model: () => new Model("Short and sweet. DONE") })
  return { svc, intros }
}

describe("talkSpeaker", () => {
  it("takes the persona's first paragraph, the agent's voice, and the intro rule", () => {
    const s = talkSpeaker("secretary-agent", agents, true)
    expect(s).toMatchObject({ name: "Secretary", voiceId: "sarah", persona: "You are Anis's personal secretary." })
    expect(s.introLine).toContain("[VOICE INTRO]")
    expect(talkSpeaker("secretary-agent", agents, false).introLine).toContain("[VOICE CASUAL]")
  })
})

describe("VoiceTalkService", () => {
  it("validates, runs one talk at a time, and records introductions", async () => {
    const { svc, intros } = service()
    expect(svc.handle("POST", "/talk", { agents: ["secretary-agent"], topic: "x" }).status).toBe(400)
    expect(svc.handle("POST", "/talk", { agents: ["secretary-agent", "nobody"], topic: "x" }).status).toBe(404)
    expect(svc.handle("POST", "/talk/door", { text: "hi" }).status).toBe(409)
    expect(svc.handle("GET", "/talk", {}).body).toEqual({ active: false })

    expect(svc.handle("POST", "/talk", { agents: ["secretary-agent", "marketing-agent"], topic: "the demo" }).status).toBe(201)
    expect(svc.handle("POST", "/talk", { agents: ["secretary-agent", "marketing-agent"], topic: "again" }).status).toBe(409)
    for (let i = 0; i < 100 && !(svc.handle("GET", "/talk", {}).body as any).transcript.length; i++) await new Promise((r) => setTimeout(r, 2))
    // Speaking a line counts as the introduction.
    expect(intros.needsIntro("talk", "secretary-agent")).toBe(false)
    expect(svc.handle("POST", "/talk/hush", {}).body).toEqual({ active: true })
    expect(svc.handle("POST", "/talk/door", { text: "stop" }).status).toBe(200)
    expect((svc.handle("GET", "/talk", {}).body as any).active).toBe(false)
  })

  it("switches narration per agent or task", () => {
    const { svc } = service()
    expect(svc.handle("POST", "/narration", { agentId: "marketing-agent" }).status).toBe(400)
    expect(svc.handle("POST", "/narration", { agentId: "nobody", on: true }).status).toBe(404)
    expect(svc.handle("POST", "/narration", { agentId: "secretary-agent", on: true }).body).toEqual({ agents: { "secretary-agent": true }, tasks: {} })
    expect(svc.handle("POST", "/narration", { taskId: "t1", on: false }).body).toEqual({ agents: { "secretary-agent": true }, tasks: { t1: false } })
    expect(svc.narrator.enabled("marketing-agent", "gitlab", "t2")).toBe(true)
    expect(svc.narrator.enabled("secretary-agent", "gitlab", "t1")).toBe(false)
  })
})
