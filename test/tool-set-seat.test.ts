import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ mode: "shadow", askSeat: vi.fn(), labels: [] as any[] }))
vi.mock("../src/decisions/seat", () => ({
  getSeatMode: () => mocks.mode,
  askSeat: mocks.askSeat,
  labelSeatCall: (...a: any[]) => { mocks.labels.push(a) },
}))

import { bundleFor, isMiss, labelForTools, toolSetQuestions } from "../src/decisions/seats/tool-set"
import { labelToolSetRun, startToolSetShadow } from "../src/agents/tool-set"
import { validateQuestions } from "../src/decisions/questions"
import { summarize } from "../scripts/tool-set-report"

// #455: which built-in tools a fresh session needs, shadow only.
const answer = (a: number, c: number, f: number) => ({ bundle: { type: "choice", probabilities: { answer: a, code: c, full: f } } })
const input = { message: "What does src/cart.js export?", agent: "coder", channel: "telegram", taskId: "t1" }
const log: string[] = []

beforeEach(() => { mocks.mode = "shadow"; mocks.askSeat.mockReset(); mocks.labels.length = 0; log.length = 0 })

describe("tool-set policy", () => {
  it("picks the smallest bundle whose chance of being too small is under the limit", () => {
    expect(bundleFor(answer(0.95, 0.04, 0.01) as any)).toBe("answer")
    expect(bundleFor(answer(0.85, 0.1, 0.05) as any)).toBe("code")
    expect(bundleFor(answer(0.6, 0.3, 0.1) as any)).toBe("full")
    expect(bundleFor(answer(0.85, 0.1, 0.05) as any, 0.2)).toBe("answer")
  })

  it("starts with every tool when the answer is missing or malformed", () => {
    expect(bundleFor(null)).toBe("full")
    expect(bundleFor({})).toBe("full")
    expect(bundleFor({ bundle: { probabilities: { answer: 1 } } })).toBe("full")
    expect(bundleFor({ bundle: { probabilities: { answer: NaN, code: 0, full: 0 } } })).toBe("full")
  })

  it("labels a run with the smallest bundle that covers its built-in tool calls", () => {
    expect(labelForTools([])).toBe("answer")
    expect(labelForTools(["Read", "Grep", "mcp__agentx__recent"])).toBe("answer")
    expect(labelForTools(["Read", "Edit", "Bash"])).toBe("code")
    expect(labelForTools(["Read", "WebFetch"])).toBe("full")
    expect(isMiss("answer", "code")).toBe(true)
    expect(isMiss("full", "answer")).toBe(false)
  })

  it("asks one valid choice question", () => {
    expect(() => validateQuestions(toolSetQuestions)).not.toThrow()
  })
})

describe("tool-set on the live path", () => {
  it("asks nothing when the seat is off", () => {
    mocks.mode = "off"
    expect(startToolSetShadow(input, (m) => log.push(m))).toBeUndefined()
    expect(mocks.askSeat).not.toHaveBeenCalled()
  })

  it("records what it would start with, and labels the call with what the run needed", async () => {
    mocks.askSeat.mockResolvedValue({ callId: "c1", mode: "shadow", answers: answer(0.95, 0.04, 0.01) })
    const pending = startToolSetShadow(input, (m) => log.push(m))!
    expect(mocks.askSeat.mock.calls[0][0]).toBe("tool-set")
    await labelToolSetRun(pending, { toolUses: new Map([["Read", 2], ["Edit", 1]]), eventsSeen: true, agentId: "coder" }, (m) => log.push(m))
    expect(mocks.labels).toEqual([["c1", "bundle", "code", { kind: "outcome", labeledBy: "tool-use" }]])
    expect(log.join("\n")).toMatch(/would start with answer.*needed code — MISS/)
  })

  it("does not label a run that errored or streamed no events", async () => {
    mocks.askSeat.mockResolvedValue({ callId: "c2", mode: "shadow", answers: answer(0.2, 0.3, 0.5) })
    const pending = startToolSetShadow(input, () => {})!
    await labelToolSetRun(pending, { toolUses: new Map(), eventsSeen: false, agentId: "coder" }, () => {})
    await labelToolSetRun(pending, { toolUses: new Map([["Read", 1]]), eventsSeen: true, error: "boom", agentId: "coder" }, () => {})
    expect(mocks.labels).toEqual([])
  })

  it("never rejects when the seat fails, and warns once that active only records", async () => {
    mocks.mode = "active"
    mocks.askSeat.mockRejectedValue(new Error("down"))
    const pending = startToolSetShadow(input, (m) => log.push(m))!
    await expect(pending).resolves.toBeNull()
    startToolSetShadow(input, (m) => log.push(m))
    expect(log.filter((l) => l.includes("only shadow is built"))).toHaveLength(1)
  })
})

describe("tool-set report", () => {
  it("counts what would start smaller and how often it would have been too small", () => {
    const rows = [
      { probabilities: { answer: 0.95, code: 0.04, full: 0.01 }, truth: "answer", predicted: "answer" },
      { probabilities: { answer: 0.95, code: 0.04, full: 0.01 }, truth: "code", predicted: "answer" },
      { probabilities: { answer: 0.1, code: 0.85, full: 0.05 }, truth: "code", predicted: "code" },
      { probabilities: { answer: 0.3, code: 0.3, full: 0.4 }, truth: "answer", predicted: "full" },
      { probabilities: { answer: 0.3, code: 0.3, full: 0.4 }, predicted: "full" },
    ]
    const s = summarize(rows, [0.1])
    expect(s.total).toBe(5)
    expect(s.graded).toBe(4)
    expect(s.needed).toEqual({ answer: 2, code: 2, full: 0 })
    expect(s.lines[0]).toMatchObject({ picked: { answer: 2, code: 1, full: 1 }, misses: 1, smaller: 3 })
  })
})
