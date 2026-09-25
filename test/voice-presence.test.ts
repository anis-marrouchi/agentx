import { describe, it, expect, vi, afterEach } from "vitest"

const answers = { current: null as unknown }
vi.mock("../src/decisions/seat", async (orig) => ({
  ...(await orig<typeof import("../src/decisions/seat")>()),
  askSeat: vi.fn(async () => {
    if (answers.current === "hang") return new Promise(() => {})
    return answers.current ? { answers: answers.current, callId: "c1", mode: "active" } : null
  }),
}))

import { PresenceHost } from "../src/daemon/voice-presence"
import { VoiceTalkService } from "../src/daemon/voice-talk-api"
import { VoiceIntroTracker } from "../src/voice/agent-voice"
import { Channel, type LineModel } from "../src/voice/talk-model"
import type { Presence } from "../src/voice/presence"

const agents: any = {
  "coder-agent": { name: "Coder", systemPrompt: "You are Coder.", presence: { color: "#7C3AED" } },
  "helper-agent": { name: "Helper", systemPrompt: "You are Helper.", presence: { allowActions: true } },
}

const pick = (mode: string, conf: number) => ({
  mode: { type: "choice", choice: mode, confidence: conf, probabilities: { [mode]: conf } },
  persist: { type: "noul", noul: 0.9 },
  nextAction: { type: "choice", choice: "highlight", confidence: 0.8, probabilities: { highlight: 0.8 } },
})

function overlayLog(log: string[]): (look: any) => Presence {
  return (look) => ({
    moveTo: () => log.push(`${look.name} move`), say: (t) => log.push(`${look.name} say ${t}`),
    clear: () => {}, park: () => log.push(`${look.name} park`), close: () => log.push(`${look.name} close`),
  })
}

describe("PresenceHost.decide", () => {
  afterEach(() => { delete process.env.AGENTX_DECISION_SEAT_PRESENCE_MODE; answers.current = null })

  it("with the seat off, every turn is talk and nothing is asked", async () => {
    const logs: string[] = []
    const host = new PresenceHost(() => agents, (m) => logs.push(m), { frontmostApp: async () => "Numbers" })
    expect(await host.decide("coder-agent", "teach me Numbers")).toMatchObject({ mode: "talk", seat: "off", override: "no-decision" })
    expect(logs).toEqual([])
  })

  it("with the seat on, applies the policy and logs the probability", async () => {
    process.env.AGENTX_DECISION_SEAT_PRESENCE_MODE = "active"
    const logs: string[] = []
    const host = new PresenceHost(() => agents, (m) => logs.push(m), { frontmostApp: async () => "Numbers" })
    answers.current = pick("teach", 0.82)
    expect(await host.decide("coder-agent", "teach me Numbers")).toMatchObject({ mode: "teach", seat: "active", probability: 0.82, persist: true })
    expect(logs[0]).toContain("chose=teach p=0.82 → teach")
    answers.current = pick("act", 0.9)
    expect(await host.decide("coder-agent", "do it for me")).toMatchObject({ mode: "teach", override: "actions-not-allowed" })
    expect(await host.decide("helper-agent", "do it for me")).toMatchObject({ mode: "act" })
    answers.current = pick("watch", 0.3)
    expect(await host.decide("coder-agent", "hmm")).toMatchObject({ mode: "talk", override: "low-confidence" })
    answers.current = null
    expect(await host.decide("coder-agent", "backend down")).toMatchObject({ mode: "talk", override: "no-decision" })
  })

  it("a seat that hangs cannot hold up the turn: talk after the budget", async () => {
    process.env.AGENTX_DECISION_SEAT_PRESENCE_MODE = "active"
    vi.useFakeTimers()
    const host = new PresenceHost(() => agents, () => {}, { frontmostApp: async () => null })
    answers.current = "hang"
    const pending = host.decide("coder-agent", "teach me")
    await vi.advanceTimersByTimeAsync(2_600)
    expect(await pending).toMatchObject({ mode: "talk", override: "no-decision" })
    vi.useRealTimers()
  })

  it("shows the agent's cursor with the spoken answer, then removes it", async () => {
    vi.useFakeTimers()
    const log: string[] = []
    const host = new PresenceHost(() => agents, () => {}, { overlay: overlayLog(log) })
    host.showTalk("coder-agent", "Your next meeting is at three.", false)
    expect(log).toEqual(["Coder park", "Coder say Your next meeting is at three."])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log.at(-1)).toBe("Coder close")
    vi.useRealTimers()
  })
})

class Planner implements LineModel {
  reply(_m: string, signal?: AbortSignal) {
    const c = new Channel<string>()
    setTimeout(() => { c.push("TARGET: 1\nACTION: highlight\nSAY: Click New."); c.end() }, 5)
    return c.read(signal)
  }
  close() {}
}

describe("POST /teach/live", () => {
  it("runs a lesson as the voice session: GET /talk shows it, the door reaches it, stop ends it", async () => {
    const log: string[] = []
    const speech = { busy: false, say: async () => { await new Promise((r) => setTimeout(r, 30)); return true }, stop: () => log.push("speech stop") } as any
    const svc = new VoiceTalkService(() => agents, new VoiceIntroTracker(), () => {}, {
      speech, model: () => new Planner(),
      presence: {
        overlay: overlayLog(log),
        screen: {
          readScreen: async () => ({ app: "Notes", window: null, candidates: [{ id: 1, role: "AXButton", label: "New" }], rectOf: () => ({ x: 1, y: 2, width: 3, height: 4 }) }),
          act: async () => ({ error: null }),
        },
      },
    })
    expect(svc.handle("POST", "/teach/live", { agent: "coder-agent", goal: "" }).status).toBe(400)
    expect(svc.handle("POST", "/teach/live", { agent: "nobody", goal: "x" }).status).toBe(404)
    expect(svc.handle("POST", "/teach/live", { agent: "coder-agent", goal: "start a note", mode: "teach" }).status).toBe(201)
    expect(svc.handle("POST", "/talk", { agents: ["coder-agent", "helper-agent"], topic: "x" }).status).toBe(409)
    expect(svc.handle("GET", "/talk", {}).body).toMatchObject({ active: true, kind: "lesson" })
    await new Promise((r) => setTimeout(r, 20))
    expect(svc.handle("POST", "/talk/door", { text: "where is it?" }).status).toBe(200)
    expect(log).toContain("speech stop")
    svc.handle("POST", "/talk/door", { text: "stop" })
    expect(svc.handle("GET", "/talk", {}).body).toEqual({ active: false })
    expect(log).toContain("Coder close")
  })

  it("targets the app in front now, not the one from the last voice turn (#55)", async () => {
    process.env.AGENTX_DECISION_SEAT_PRESENCE_MODE = "active"
    answers.current = pick("talk", 0.9)
    let front = "WhatsApp"
    const prompts: string[] = []
    const said: string[] = []
    const planner: LineModel = {
      reply(m: string, signal?: AbortSignal) {
        prompts.push(m)
        const c = new Channel<string>()
        setTimeout(() => { c.push("TARGET: none\nACTION: done\nSAY: Done."); c.end() }, 2)
        return c.read(signal)
      },
      close() {},
    }
    const svc = new VoiceTalkService(() => agents, new VoiceIntroTracker(), () => {}, {
      speech: { busy: false, say: async (u: { text: string }) => { said.push(u.text); return true }, stop: () => {} } as any,
      model: () => planner,
      presence: {
        overlay: overlayLog([]),
        frontmostApp: async () => front,
        screen: { readScreen: async () => ({ app: front, window: null, candidates: [], rectOf: () => null }), act: async () => ({ error: null }) },
      },
    })
    // A voice turn while WhatsApp was in front, then tldraw comes forward.
    await svc.presence.decide("helper-agent", "what's new?")
    front = "tldraw"
    expect(svc.handle("POST", "/teach/live", { agent: "helper-agent", goal: "draw a box", mode: "act" }).status).toBe(201)
    await vi.waitFor(() => expect(svc.handle("GET", "/talk", {}).body).toEqual({ active: false }))
    expect(said.some((t) => t.includes("WhatsApp"))).toBe(false)
    expect(prompts[0]).toContain("App: tldraw")

    // An explicit app wins over whatever is in front.
    said.length = 0
    expect(svc.handle("POST", "/teach/live", { agent: "helper-agent", goal: "draw a box", mode: "act", app: "Notes" }).status).toBe(201)
    await vi.waitFor(() => expect(said[0]).toBe("Bring Notes to the front and I'll carry on."))
    svc.handle("POST", "/talk/door", { text: "stop" })
    delete process.env.AGENTX_DECISION_SEAT_PRESENCE_MODE
    answers.current = null
  })
})
