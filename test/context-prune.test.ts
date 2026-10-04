import { describe, it, expect } from "vitest"
import {
  DEFAULT_CONTEXT_PRUNE,
  pruneHistory,
  resolveContextPruneSettings,
  splitFloor,
  type SeatAsker,
} from "../src/agents/context-prune"
import { contextPruneQuestions } from "../src/decisions/seats/context-prune"
import { validateQuestions } from "../src/decisions/questions"
import { renderHistoryContext, type SessionMessage } from "../src/agents/sessions"

const ts = "2026-10-04T10:00:00.000Z"
function msg(role: "user" | "agent", content: string): SessionMessage {
  return { role, name: role === "user" ? "Sam" : "helper", content, timestamp: ts }
}

// 6 user/agent pairs then the current message: indices 0..12.
function conversation(): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = 0; i < 6; i++) {
    out.push(msg("user", `topic ${i} question`))
    out.push(msg("agent", `topic ${i} answer`))
  }
  out.push(msg("user", "current question"))
  return out
}

function asker(pByIndex: Record<number, number>, mode: "shadow" | "active" = "active"): SeatAsker {
  return async (_state, questions) => ({
    callId: null,
    mode,
    answers: Object.fromEntries(
      Object.keys(questions).map((k) => [k, { type: "noul", noul: pByIndex[Number(k.slice(1))] ?? 0.9 }]),
    ) as any,
  })
}

const ctx = { agentId: "helper", channel: "telegram" }

describe("context pruning floor", () => {
  it("keeps the current message and the last N user turns with their replies", () => {
    const { floor, candidates } = splitFloor(conversation(), { ...DEFAULT_CONTEXT_PRUNE, keepLastTurns: 2 })
    // current (12) + turns starting at 8 and 10
    expect([...floor].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12])
    expect(candidates).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it("always keeps approvals, instructions and pinned facts", () => {
    const msgs = conversation()
    msgs[2] = msg("user", "Approved, go ahead with the release")
    msgs[4] = msg("user", "From now on never post before 9am")
    const { floor, candidates } = splitFloor(msgs, DEFAULT_CONTEXT_PRUNE)
    expect(floor.has(2)).toBe(true)
    expect(floor.has(4)).toBe(true)
    expect(candidates).not.toContain(2)
    expect(candidates).not.toContain(4)
  })

  it("ignores a keep pattern that is not a valid regex", () => {
    expect(() => splitFloor(conversation(), { ...DEFAULT_CONTEXT_PRUNE, keepPatterns: ["("] })).not.toThrow()
  })
})

describe("pruneHistory", () => {
  it("drops only candidates at or below the threshold when active", async () => {
    const out = await pruneHistory(conversation(), DEFAULT_CONTEXT_PRUNE, ctx, asker({ 0: 0.05, 1: 0.2, 2: 0.21 }))
    expect(out.mode).toBe("active")
    expect(out.dropped).toBe(2)
    expect(out.messages.map((m) => m.content)).not.toContain("topic 0 question")
    expect(out.messages.map((m) => m.content)).toContain("topic 1 question")
    expect(out.messages[out.messages.length - 1].content).toBe("current question")
  })

  it("scores but drops nothing in shadow mode", async () => {
    const out = await pruneHistory(conversation(), DEFAULT_CONTEXT_PRUNE, ctx, asker({ 0: 0.01 }, "shadow"))
    expect(out.mode).toBe("shadow")
    expect(out.dropped).toBe(0)
    expect(out.messages).toHaveLength(13)
    expect(out.scores.find((s) => s.index === 0)?.dropped).toBe(true)
  })

  it("keeps everything when the seat fails or throws", async () => {
    const none: SeatAsker = async () => null
    const boom: SeatAsker = async () => { throw new Error("down") }
    for (const ask of [none, boom]) {
      const out = await pruneHistory(conversation(), DEFAULT_CONTEXT_PRUNE, ctx, ask)
      expect(out.mode).toBe("failed")
      expect(out.messages).toHaveLength(13)
    }
  })

  it("keeps a message whose answer is missing", async () => {
    const partial: SeatAsker = async () => ({ callId: null, mode: "active", answers: { m0: { type: "noul", noul: 0.01 } } as any })
    const out = await pruneHistory(conversation(), DEFAULT_CONTEXT_PRUNE, ctx, partial)
    expect(out.dropped).toBe(1)
  })

  it("skips the call on a short history", async () => {
    let called = false
    const spy: SeatAsker = async () => { called = true; return null }
    const out = await pruneHistory(conversation().slice(-5), DEFAULT_CONTEXT_PRUNE, ctx, spy)
    expect(out.mode).toBe("skipped")
    expect(called).toBe(false)
  })
})

describe("settings and rendering", () => {
  it("applies environment overrides over config", () => {
    const s = resolveContextPruneSettings(
      { threshold: 0.3, keepPatterns: undefined },
      { AGENTX_CONTEXT_PRUNE_THRESHOLD: "0.1", AGENTX_CONTEXT_PRUNE_BACKEND: "typesafe" },
    )
    expect(s.threshold).toBe(0.1)
    expect(s.backend).toBe("typesafe")
    expect(s.keepPatterns.length).toBeGreaterThan(0)
  })

  it("asks one valid yes/no question per candidate", () => {
    const q = contextPruneQuestions([{ key: "m0", name: "Sam", content: "hi" }, { key: "m3", name: "helper", content: "yo" }])
    expect(Object.keys(q)).toEqual(["m0", "m3"])
    expect(() => validateQuestions(q)).not.toThrow()
  })

  it("tells the agent when messages were left out", () => {
    const text = renderHistoryContext("2026-10-04", conversation().slice(-2), { omitted: 4 })
    expect(text).toContain("4 earlier message(s)")
    expect(renderHistoryContext("2026-10-04", conversation().slice(-2))).not.toContain("left out")
  })
})
