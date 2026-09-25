import { describe, it, expect } from "vitest"
import { EventEmitter } from "events"
import { VoiceTalkService } from "../src/daemon/voice-talk-api"
import { VoiceIntroTracker } from "../src/voice/agent-voice"
import { Narrator } from "../src/voice/narrator"
import { isStop } from "../src/voice/talk"
import { Channel, type LineModel } from "../src/voice/talk-model"
import type { Presence } from "../src/voice/presence"

// One door (Option-Space) for everything spoken: talk, live lesson,
// narration and a spoken-answer bubble.

const agents: any = {
  "secretary-agent": { name: "Secretary", systemPrompt: "You are the secretary.", voice: { narrate: "on" } },
  "coder-agent": { name: "Coder", systemPrompt: "You are Coder.", voice: { narrate: "on" } },
}

class Lines implements LineModel {
  constructor(private text: string, private ms = 5) {}
  reply(_m: string, signal?: AbortSignal) {
    const c = new Channel<string>()
    setTimeout(() => { c.push(this.text); c.end() }, this.ms)
    return c.read(signal)
  }
  close() {}
}

function setup(model: () => LineModel = () => new Lines("Hi there.")) {
  const log: string[] = []
  const said: string[] = []
  const speech = {
    get busy() { return false },
    say: async (u: { text: string }) => { said.push(u.text); await new Promise((r) => setTimeout(r, 20)); return true },
    stop: () => log.push("speech stop"),
  } as any
  const overlay = (look: any): Presence => ({
    moveTo: () => {}, clear: () => {}, park: () => {}, ping: () => {},
    say: (t) => log.push(`${look.name} say ${t}`), close: () => log.push(`${look.name} close`),
  })
  const svc = new VoiceTalkService(() => agents, new VoiceIntroTracker(), (m) => log.push(m), {
    speech, model, stopSpeakers: () => { log.push("stop speakers") },
    presence: {
      overlay,
      screen: {
        readScreen: async () => ({ app: "Safari", window: null, candidates: [{ id: 1, role: "AXButton", label: "Reload" }], rectOf: () => ({ x: 1, y: 2, width: 3, height: 4 }) }),
        act: async () => ({ error: null }),
      },
    },
  })
  return { svc, log, said }
}

const hush = (svc: VoiceTalkService) => svc.handle("POST", "/voice/hush", {})
const door = (svc: VoiceTalkService, text: string) => svc.handle("POST", "/voice/door", { text })

describe("the door", () => {
  it("with nothing speaking: hush says so, the words go to /ask", () => {
    const { svc, log } = setup()
    expect(hush(svc)).toEqual({ status: 200, body: { active: false, kind: null, agentId: null } })
    expect(door(svc, "what's on my calendar").status).toBe(409)
    expect(log).toContain("[door] hush → nothing was speaking")
    expect(log.some((l) => l.startsWith('[door] "what\'s on my calendar" → nothing'))).toBe(true)
    expect(svc.handle("POST", "/voice/door", {}).status).toBe(400)
  })

  it("reaches a live lesson: hush stops its voice, the lesson takes the words, stop ends it", async () => {
    const { svc, log } = setup(() => new Lines("TARGET: 1\nACTION: highlight\nSAY: Let's reload.", 5))
    svc.startLesson("secretary-agent", "open the merge request", "teach")
    await new Promise((r) => setTimeout(r, 30))
    expect(hush(svc).body).toEqual({ active: true, kind: "lesson", agentId: "secretary-agent" })
    expect(log).toContain("speech stop")
    expect(log).toContain("[door] hush → lesson (secretary-agent)")
    expect(door(svc, "wait, which one is mine?").body).toMatchObject({ handled: true, kind: "lesson", active: true })
    expect(log).toContain('[door] "wait, which one is mine?" → lesson')
    expect(door(svc, "stop").body).toMatchObject({ handled: true, active: false })
    expect(log).toContain('[door] "stop" → lesson (ended)')
    expect(log).toContain("Secretary close")
    expect(svc.live).toBeNull()
  })

  it("reaches a talk the same way, also through the old /talk routes", async () => {
    const { svc, log } = setup()
    svc.handle("POST", "/talk", { agents: ["secretary-agent", "coder-agent"], topic: "the release" })
    await new Promise((r) => setTimeout(r, 10))
    expect(svc.handle("POST", "/talk/hush", {}).body).toMatchObject({ active: true, kind: "talk" })
    expect(svc.handle("POST", "/talk/door", { text: "stop" }).body).toMatchObject({ handled: true, active: false })
    expect(log).toContain('[door] "stop" → talk (ended)')
  })

  it("empties a spoken-answer bubble", () => {
    const { svc, log } = setup()
    svc.presence.showTalk("coder-agent", "Your build is green.", true)
    hush(svc)
    expect(log.at(-2)).toBe("Coder say ")
    svc.presence.close()
  })
})

describe("the door and narration", () => {
  function narrated() {
    const { svc, log, said } = setup(() => new Lines("Reading the release notes now."))
    const bus = new EventEmitter() as any
    svc.narrator.attach(bus)
    bus.emit("task:started", { agentId: "coder-agent", channel: "telegram", chatId: "c", messagePreview: "", at: "", taskId: "t1" })
    return { svc, log, said, bus }
  }

  it("hush names the narrated task and holds narration; stop turns it off for that task", async () => {
    const { svc, log, said } = narrated()
    const step = { taskId: "t1", agentId: "coder-agent", name: "tool_use", action: "Read", inputSummary: "{}", at: "" }
    svc.narrator.onStep(step as any)
    expect(await svc.narrator.flush("t1")).toBe("Reading the release notes now.")
    expect(hush(svc).body).toEqual({ active: false, kind: "narration", agentId: "coder-agent" })
    expect(log).toContain("[door] hush → narration (coder-agent)")
    // Held: nothing more is said until the listener has spoken.
    svc.narrator.onStep(step as any)
    expect(await svc.narrator.flush("t1")).toBeNull()
    expect(door(svc, "stop").body).toMatchObject({ handled: true, kind: "narration" })
    expect(svc.narrator.enabled("coder-agent", "telegram", "t1")).toBe(false)
    expect(log).toContain('[door] "stop" → narration of t1 off')
    expect(said).toEqual(["Reading the release notes now."])
  })

  it("anything else goes to /ask and narration carries on", async () => {
    const { svc } = narrated()
    svc.narrator.onStep({ taskId: "t1", agentId: "coder-agent", name: "tool_use", action: "Read", inputSummary: "{}", at: "" } as any)
    await svc.narrator.flush("t1")
    hush(svc)
    expect(door(svc, "how long will it take?").status).toBe(409)
    expect(svc.narrator.enabled("coder-agent", "telegram", "t1")).toBe(true)
    svc.narrator.onStep({ taskId: "t1", agentId: "coder-agent", name: "tool_use", action: "Edit", inputSummary: "{}", at: "" } as any)
    expect(await svc.narrator.flush("t1")).toBe("Reading the release notes now.")
  })

  it("hush silences every speaker on the host, AgentX Voice's lines included", () => {
    const { svc, log } = setup()
    hush(svc)
    expect(log).toContain("speech stop")
    expect(log).toContain("stop speakers")
  })

  it("/voice/stop silences everything and keeps nothing waiting for the door", async () => {
    const { svc, log } = narrated()
    svc.narrator.onStep({ taskId: "t1", agentId: "coder-agent", name: "tool_use", action: "Read", inputSummary: "{}", at: "" } as any)
    await svc.narrator.flush("t1")
    expect(svc.handle("POST", "/voice/stop", {}).body).toEqual({ active: false, kind: "narration", agentId: "coder-agent" })
    expect(log).toContain("speech stop")
    expect(log).toContain("stop speakers")
    // Unlike the door, a stop does not hand the next words to the task.
    expect(door(svc, "stop").status).toBe(409)
  })

  it("an old narration line is not what the listener heard", () => {
    const n = new Narrator({ speech: { busy: false, say: async () => true } as any, model: () => new Lines(""), voiceOf: () => null })
    expect(n.hush()).toBeNull()
  })
})

describe("isStop", () => {
  it.each(["stop", "Stop.", "that's enough", "end the lesson", "enough!"])("%s", (s) => expect(isStop(s)).toBe(true))
  it("not a question that contains the word", () => expect(isStop("stop the deploy after tests")).toBe(false))
})
