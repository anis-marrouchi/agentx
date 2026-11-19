import { afterEach, describe, expect, it } from "vitest"
import { formatSeatReport, situationSeatReport, wilsonUpper } from "../src/situations/seat-report"
import { importanceOf } from "../src/situations/importance"
import { SituationSeat } from "../src/situations/seat"
import { DEFAULT_SITUATIONS_CONFIG, situationsConfigSchema, type SituationsConfig } from "../src/situations/config"
import { askSeat, configureDecisions, getSeatMode, resetDecisionsRuntime } from "../src/decisions/seat"
import { _resetDecisionBackendsForTesting, registerDecisionBackend } from "../src/decisions/backend"
import { createMockDecisionBackend } from "../src/decisions/backends/mock"
import { DecisionStore } from "../src/decisions/store"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SITUATION_PHASE_SEAT, saysNoReply, situationPhaseQuestions, situationPhaseState } from "../src/decisions/seats/situation-phase"
import { finalizeAnswer } from "../src/decisions/normalize"
import type { GradedRow } from "../src/decisions/store"

// #1892 phase 5: the situation-phase seat, its calibration report and the
// importance score. Unit level; the end-to-end proof is in
// situation-phase5.test.ts.

afterEach(() => { resetDecisionsRuntime(); _resetDecisionBackendsForTesting() })

let n = 0
function row(p: number, truth?: "yes" | "no", backend = "mock", model = "mock"): GradedRow {
  return {
    callId: `c${++n}`, seat: SITUATION_PHASE_SEAT, ts: n, backend, model, structureMode: "mock",
    question: "needsReply", type: "noul", predicted: p >= 0.5 ? "yes" : "no", confidence: Math.abs(p - 0.5) * 2,
    probabilities: { yes: p, no: 1 - p }, ...(truth ? { truth } : {}), features: {}, mode: "shadow", explored: false,
  }
}

describe("the seat's questions", () => {
  it("asks phase, needs a reply and importance in one call; a malformed answer is never a no", () => {
    expect(Object.keys(situationPhaseQuestions)).toEqual(["phase", "needsReply", "importance"])
    const no = { needsReply: finalizeAnswer(situationPhaseQuestions.needsReply, { noul: 0.05 } as any).answer } as any
    const unsure = { needsReply: finalizeAnswer(situationPhaseQuestions.needsReply, { noul: 0.4 } as any).answer } as any
    expect(saysNoReply(no)).toBe(true)
    expect(saysNoReply(unsure)).toBe(false)
    expect(saysNoReply({} as any)).toBe(false)
    const state = situationPhaseState({ message: "ok", senderKind: "person", channel: "whatsapp", group: true, phase: "ended", endReason: "closed", minutesInPhase: 3.4 }) as Record<string, unknown>
    expect(state).toEqual({ message: "ok", sender: "person", channel: "whatsapp", chat: "group", phase: "ended", endReason: "closed", minutesInPhase: 3 })
  })
})

describe("the calibration report", () => {
  it("states the false 'no reply' rate over the labeled 'no reply' answers", () => {
    const rows = [
      ...Array.from({ length: 58 }, () => row(0.05, "no")),
      ...Array.from({ length: 2 }, () => row(0.1, "yes")), // false "no reply"
      ...Array.from({ length: 5 }, () => row(0.08)), // not labeled yet
      ...Array.from({ length: 10 }, () => row(0.9, "yes")), // "reply": not in the rate
    ]
    const r = situationSeatReport(rows, { below: 0.2, limit: 0.15, minLabeled: 50 })
    expect(r).toMatchObject({ calls: 75, noReply: 65, labeled: 60, falseNoReply: 2, limit: 0.15, minLabeled: 50 })
    expect(r.rate).toBeCloseTo(2 / 60, 6)
    expect(r.upper95).toBeCloseTo(wilsonUpper(2, 60), 6)
    expect(r.upper95!).toBeLessThan(0.15)
    expect(r.ready).toBe(true)
    const text = formatSeatReport(r).join("\n")
    expect(text).toContain("False \"no reply\" rate: 3.3% (2 of 60 labeled)")
    expect(text).toMatch(/ready for active: yes/i)
  })

  it("is not ready with no limit set, too few labels, or an upper bound over the limit", () => {
    const rows = [...Array.from({ length: 58 }, () => row(0.05, "no")), ...Array.from({ length: 2 }, () => row(0.1, "yes"))]
    expect(situationSeatReport(rows, { below: 0.2, minLabeled: 50 })).toMatchObject({ ready: false, why: expect.stringMatching(/no limit/i) })
    expect(situationSeatReport(rows.slice(0, 20), { below: 0.2, limit: 0.5, minLabeled: 50 })).toMatchObject({ ready: false, why: expect.stringMatching(/20 labeled.*50/i) })
    expect(situationSeatReport(rows, { below: 0.2, limit: 0.05, minLabeled: 50 })).toMatchObject({ ready: false, why: expect.stringMatching(/over the limit/i) })
  })

  it("counts only the current backend and model, and names them", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row(0.05, "yes", "local", "haiku")), // another backend
      ...Array.from({ length: 3 }, () => row(0.05, "yes", "jev", "jev-1.12")), // an older model
      ...Array.from({ length: 4 }, () => row(0.05, "no", "jev", "jev-1.13")),
    ]
    const r = situationSeatReport(rows, { below: 0.2, limit: 1, minLabeled: 1, backend: "jev", model: "jev-1.13" })
    expect(r).toMatchObject({ backend: "jev", model: "jev-1.13", calls: 4, labeled: 4, falseNoReply: 0 })
    expect(formatSeatReport(r).join("\n")).toContain("Backend: jev, model jev-1.13")
  })

  it("reads labels written as true/false too", () => {
    const rows = [{ ...row(0.05), truth: "false" }, { ...row(0.05), truth: "true" }]
    expect(situationSeatReport(rows, { below: 0.2, limit: 1, minLabeled: 1 })).toMatchObject({ labeled: 2, falseNoReply: 1 })
  })

  it("wilsonUpper", () => {
    expect(wilsonUpper(0, 0)).toBe(1)
    expect(wilsonUpper(0, 100)).toBeGreaterThan(0)
    expect(wilsonUpper(0, 100)).toBeLessThan(0.04)
    expect(wilsonUpper(50, 100)).toBeGreaterThan(0.5)
  })
})

describe("importance, in code", () => {
  const now = 1_000_000_000_000
  it("high for the owner or a client, or a promise due within a day", () => {
    expect(importanceOf({ senderKind: "person", role: "owner", now }).level).toBe("high")
    expect(importanceOf({ senderKind: "person", role: "client", now }).level).toBe("high")
    expect(importanceOf({ senderKind: "bot", openPromise: { dueAt: now + 3600_000 }, now })).toMatchObject({ level: "high", why: expect.stringMatching(/promise/) })
    expect(importanceOf({ senderKind: "bot", openPromise: { dueAt: now - 1 }, now }).level).toBe("high")
  })
  it("normal for a known person or a promise with no near due time; low for a bot; unsure otherwise", () => {
    expect(importanceOf({ senderKind: "person", role: "member", now }).level).toBe("normal")
    expect(importanceOf({ senderKind: "bot", openPromise: { dueAt: null }, now }).level).toBe("normal")
    expect(importanceOf({ senderKind: "bot", now }).level).toBe("low")
    expect(importanceOf({ senderKind: "person", now })).toMatchObject({ level: null })
  })
})

describe("the seat's mode and plan", () => {
  const cfg = (patch: Partial<SituationsConfig["seat"]> = {}): SituationsConfig => ({ ...DEFAULT_SITUATIONS_CONFIG, mode: "active", seat: { ...DEFAULT_SITUATIONS_CONFIG.seat, ...patch } })

  it("settings: defaults keep today's behaviour", () => {
    const s = situationsConfigSchema.parse(undefined)
    expect(s.seat).toEqual({ noReplyBelow: 0.2, minLabeled: 50 })
    expect(s.importance).toEqual({ enabled: false })
  })

  it("off until the operator names it, like every seat", () => {
    expect(getSeatMode(SITUATION_PHASE_SEAT, {})).toBe("off")
    configureDecisions({ enabled: true, seats: {} })
    expect(getSeatMode(SITUATION_PHASE_SEAT, {})).toBe("off") // unnamed: off, so no default backend is ever spawned
    expect(new SituationSeat({ settings: () => cfg() }).plan().mode).toBe("off")
    configureDecisions({ enabled: true, seats: { [SITUATION_PHASE_SEAT]: { mode: "shadow", backend: "jev" } } })
    expect(new SituationSeat({ settings: () => cfg() }).plan().mode).toBe("shadow")
  })

  it("the global redactState applies to every seat, named or not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-redact-"))
    try {
      registerDecisionBackend("mock", () => createMockDecisionBackend())
      const store = new DecisionStore({ path: join(dir, "d.sqlite") })
      configureDecisions({ enabled: true, defaultBackend: "mock", store, redactState: true, seats: {} })
      const q = { yes: situationPhaseQuestions.needsReply }
      await askSeat("some-unnamed-seat", { message: "secret" }, q, {})
      expect(await askSeat("unnamed-in-env", { message: "secret" }, q, {})).toBeNull() // unnamed: off
      process.env.AGENTX_DECISION_SEAT_UNNAMED_REDACT = "shadow"
      await askSeat("unnamed-redact", { message: "secret" }, q, {})
      delete process.env.AGENTX_DECISION_SEAT_UNNAMED_REDACT
      const rows = store.db.prepare("SELECT state_json FROM decision_calls").all() as Array<{ state_json: string | null }>
      expect(rows).toHaveLength(1)
      expect(rows[0].state_json).toBeNull()
      store.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("a plan is reused at most a minute", () => {
    let t = 0
    let rows: GradedRow[] = []
    const seat = new SituationSeat({ settings: () => cfg({ maxFalseNoReply: 0.1 }), mode: () => "active", backend: () => "mock", rows: () => rows, now: () => t })
    expect(seat.plan().act).toBe(false)
    rows = Array.from({ length: 60 }, () => row(0.05, "no"))
    t = 59_000
    expect(seat.plan().act).toBe(false) // cached
    t = 61_000
    expect(seat.plan().act).toBe(true)
  })

  it("active acts only when the report passes the owner's limit", () => {
    const labeled = [...Array.from({ length: 60 }, () => row(0.05, "no"))]
    const seat = (limit?: number, rows = labeled) => new SituationSeat({ settings: () => cfg(limit === undefined ? {} : { maxFalseNoReply: limit }), mode: () => "active", backend: () => "mock", rows: () => rows })
    expect(seat().plan()).toMatchObject({ mode: "active", act: false, why: expect.stringMatching(/no limit/i) })
    expect(seat(0.1).plan()).toMatchObject({ mode: "active", act: true })
    expect(seat(0.01).plan()).toMatchObject({ act: false, why: expect.stringMatching(/over the limit/i) })
    expect(seat(0.1, []).plan()).toMatchObject({ act: false })
    expect(new SituationSeat({ settings: () => cfg({ maxFalseNoReply: 0.1 }), mode: () => "shadow", backend: () => "mock", rows: () => labeled }).plan()).toMatchObject({ mode: "shadow", act: false })
  })

  it("a report that cannot be read never acts", () => {
    const seat = new SituationSeat({ settings: () => cfg({ maxFalseNoReply: 0.5 }), mode: () => "active", rows: () => { throw new Error("db locked") } })
    expect(seat.plan()).toMatchObject({ act: false, why: expect.stringMatching(/db locked/) })
  })
})
