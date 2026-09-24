import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"
import { Narrator, stepLine, type NarrateMode } from "../src/voice/narrator"
import type { LineModel } from "../src/voice/talk-model"

class FakeModel implements LineModel {
  prompts: string[] = []
  constructor(private answer: string) {}
  async *reply(message: string): AsyncIterable<string> { this.prompts.push(message); yield this.answer }
  close() {}
}

function setup(mode: NarrateMode, answer = "I'm going through the release notes now.") {
  const said: string[] = []
  const speech = { busy: false, say: async (u: { text: string }) => { said.push(u.text); return true } } as any
  const model = new FakeModel(answer)
  const n = new Narrator({
    speech, model: () => model, minGapMs: 20_000, firstDelayMs: 4_000,
    voiceOf: (id) => (id === "coder-agent" ? { name: "Coder", voiceId: "roger", style: "laid-back", narrate: mode } : null),
  })
  const bus = new EventEmitter() as any
  n.attach(bus)
  const start = (taskId: string, channel = "telegram") =>
    bus.emit("task:started", { agentId: "coder-agent", channel, chatId: "c", messagePreview: "", at: "", taskId })
  const step = (taskId: string, action = "Read", input = '{"file_path":"notes/release.md"}') =>
    bus.emit("task:step", { taskId, agentId: "coder-agent", name: "tool_use", action, inputSummary: input, at: "" })
  return { n, bus, said, model, start, step, speech }
}

describe("Narrator", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("speaks one line from real steps, then at most one per 20 s", async () => {
    const { said, model, start, step } = setup("on")
    start("t1")
    step("t1")
    step("t1", "Bash", "git log --oneline -5")
    await vi.advanceTimersByTimeAsync(4_000)
    expect(said).toEqual(["I'm going through the release notes now."])
    expect(model.prompts[0]).toContain("- Read:")
    expect(model.prompts[0]).toContain("- Bash: git log --oneline -5")
    step("t1", "Grep")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(said).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(said).toHaveLength(2)
    expect(model.prompts[1]).toContain("- Grep:")
    expect(model.prompts[1]).not.toContain("git log")
  })

  it("is off by default, skips cron unless 'all', and skips voice-app turns", async () => {
    const off = setup("off")
    off.start("a"); off.step("a")
    const on = setup("on")
    on.start("b", "cron"); on.step("b")
    on.start("c", "voice"); on.step("c")
    const all = setup("all")
    all.start("d", "cron"); all.step("d")
    await vi.advanceTimersByTimeAsync(5_000)
    expect(off.said).toEqual([])
    expect(on.said).toEqual([])
    expect(all.said).toHaveLength(1)
  })

  it("switches per agent and per task at runtime", async () => {
    const { n, said, start, step } = setup("off")
    n.set({ agentId: "coder-agent" }, true)
    start("x"); step("x")
    start("y", "cron"); step("y")
    n.set({ taskId: "y" }, true)
    step("y")
    await vi.advanceTimersByTimeAsync(5_000)
    expect(said).toHaveLength(2)
    n.set({ agentId: "coder-agent" }, null)
    start("z"); step("z")
    await vi.advanceTimersByTimeAsync(5_000)
    expect(said).toHaveLength(2)
  })

  it("says nothing on SKIP or while something else is speaking", async () => {
    const skip = setup("on", "SKIP")
    skip.start("t"); skip.step("t")
    const busy = setup("on")
    busy.speech.busy = true
    busy.start("t"); busy.step("t")
    await vi.advanceTimersByTimeAsync(5_000)
    expect(skip.said).toEqual([])
    expect(busy.said).toEqual([])
  })

  it("never sends secrets or long ids to the model", () => {
    expect(stepLine("Bash", 'curl -H "token: sk-live-abc" https://x')).not.toContain("sk-live-abc")
    expect(stepLine("Read", "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5")).toBe("Read: …")
  })
})
