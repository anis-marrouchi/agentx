import { describe, it, expect } from "vitest"
import { renderLivePage } from "../src/daemon/ui/pages/live"
import { VoiceTalkService } from "../src/daemon/voice-talk-api"
import { VoiceIntroTracker } from "../src/voice/agent-voice"
import { Channel, type LineModel } from "../src/voice/talk-model"

// A live lesson holds the listener's screen, so the Live page shows it
// with a stop: the daemon's GET /talk names whose lesson it is.

const agents: any = { "secretary-agent": { name: "Secretary", systemPrompt: "You are the secretary." } }

class Lines implements LineModel {
  reply(_m: string, signal?: AbortSignal) {
    const c = new Channel<string>()
    setTimeout(() => { c.push("TARGET: 1\nACTION: highlight\nSAY: Let's reload."); c.end() }, 5)
    return c.read(signal)
  }
  close() {}
}

describe("the Live page and lessons", () => {
  it("GET /talk names the lesson's agent, mode and goal", async () => {
    const svc = new VoiceTalkService(() => agents, new VoiceIntroTracker(), () => {}, {
      speech: { get busy() { return false }, say: async () => true, stop: () => {} } as any,
      model: () => new Lines(), stopSpeakers: () => {},
      presence: {
        overlay: () => ({ moveTo: () => {}, clear: () => {}, park: () => {}, ping: () => {}, say: () => {}, close: () => {} }),
        screen: {
          readScreen: async () => ({ app: "Safari", window: null, candidates: [{ id: 1, role: "AXButton", label: "Reload" }], rectOf: () => ({ x: 1, y: 2, width: 3, height: 4 }) }),
          act: async () => ({ error: null }),
        },
      },
    })
    svc.startLesson("secretary-agent", "open the drafts", "teach")
    await new Promise((r) => setTimeout(r, 30))
    expect(svc.handle("GET", "/talk", {}).body).toMatchObject({
      active: true, kind: "lesson", agentId: "secretary-agent", mode: "teach", goal: "open the drafts",
    })
    svc.handle("POST", "/voice/stop", {})
    expect(svc.handle("GET", "/talk", {}).body).toEqual({ active: false })
  })

  it("ships a script that parses, with the lesson row and its stop", () => {
    const html = renderLivePage()
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    expect(html).toContain("data-action=\"voice-stop\"")
    expect(html).toContain("/api/voice/stop?node=")
  })
})
