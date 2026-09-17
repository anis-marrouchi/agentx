import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  askSeat,
  configureDecisions,
  getSeatMode,
  parseSeatMode,
  resetDecisionsRuntime,
  seatEnvVar,
} from "../../src/decisions/seat"
import {
  _resetDecisionBackendsForTesting,
  registerDecisionBackend,
} from "../../src/decisions/backend"
import { createMockDecisionBackend } from "../../src/decisions/backends/mock"
import { DecisionStore } from "../../src/decisions/store"
import { choice, noul } from "../../src/decisions/questions"
import type { ChoiceAnswer } from "../../src/decisions/types"

const questions = {
  area: choice({ billing: null, technical: null }),
  urgent: noul("is this urgent?"),
}

const SEAT = "workflow-matcher"
const ENV = seatEnvVar(SEAT)

let tmp: string
let store: DecisionStore

beforeEach(() => {
  delete process.env[ENV]
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-seat-"))
  store = new DecisionStore({ path: path.join(tmp, "d.sqlite") })
  _resetDecisionBackendsForTesting()
  registerDecisionBackend("mock", () => createMockDecisionBackend())
  resetDecisionsRuntime()
})

afterEach(() => {
  delete process.env[ENV]
  resetDecisionsRuntime()
  store.close()
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("seat mode resolution", () => {
  it("names the env var from the seat", () => {
    expect(seatEnvVar("monitor-prefilter")).toBe("AGENTX_DECISION_SEAT_MONITOR_PREFILTER")
  })

  it("is off by default, even with a configured seat, until decisions are enabled", () => {
    configureDecisions({ enabled: false, seats: { [SEAT]: { mode: "shadow" } } })
    expect(getSeatMode(SEAT)).toBe("off")
  })

  it("reads config once decisions are enabled", () => {
    configureDecisions({ enabled: true, seats: { [SEAT]: { mode: "shadow" } } })
    expect(getSeatMode(SEAT)).toBe("shadow")
  })

  it("lets the env var override config in both directions", () => {
    configureDecisions({ enabled: true, seats: { [SEAT]: { mode: "off" } } })
    process.env[ENV] = "shadow"
    expect(getSeatMode(SEAT)).toBe("shadow")

    configureDecisions({ enabled: true, seats: { [SEAT]: { mode: "active" } } })
    process.env[ENV] = "off"
    expect(getSeatMode(SEAT)).toBe("off")
  })

  it("falls through a typo to config rather than guessing", () => {
    configureDecisions({ enabled: true, seats: { [SEAT]: { mode: "shadow" } } })
    process.env[ENV] = "Activate!"
    expect(getSeatMode(SEAT)).toBe("shadow")
  })

  it("parses case-insensitively and rejects everything else", () => {
    expect(parseSeatMode("SHADOW")).toBe("shadow")
    expect(parseSeatMode(" Active ")).toBe("active")
    expect(parseSeatMode("authoritative")).toBeNull()
    expect(parseSeatMode(undefined)).toBeNull()
  })
})

describe("askSeat", () => {
  it("returns null and writes nothing when the seat is off", async () => {
    configureDecisions({ enabled: true, store, seats: {} })
    expect(await askSeat(SEAT, "hello", questions)).toBeNull()
    expect(store.gradedRows({})).toHaveLength(0)
  })

  it("answers and records in shadow mode", async () => {
    configureDecisions({
      enabled: true,
      store,
      defaultBackend: "mock",
      seats: { [SEAT]: { mode: "shadow" } },
    })

    const result = await askSeat(SEAT, { message: "charged twice" }, questions, {
      incumbent: { area: "technical" },
      links: [{ kind: "task", id: "t-1" }],
    })

    expect(result).not.toBeNull()
    expect(result!.mode).toBe("shadow")
    expect((result!.answers.area as ChoiceAnswer).type).toBe("choice")

    const rows = store.gradedRows({ seat: SEAT })
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.question === "area")!.incumbent).toBe("technical")
    expect(store.findCallsByLink("task", "t-1")).toEqual([result!.callId])
  })

  it("fails open: a broken backend returns null and leaves the caller alone", async () => {
    registerDecisionBackend("mock", () =>
      createMockDecisionBackend({ fail: new Error("backend down") }),
    )
    configureDecisions({
      enabled: true,
      store,
      defaultBackend: "mock",
      seats: { [SEAT]: { mode: "active" } },
    })
    vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(await askSeat(SEAT, "x", questions)).toBeNull()
  })

  it("still records a failed call, so the failure rate is measurable", async () => {
    registerDecisionBackend("mock", () =>
      createMockDecisionBackend({ fail: new Error("backend down") }),
    )
    configureDecisions({
      enabled: true,
      store,
      defaultBackend: "mock",
      seats: { [SEAT]: { mode: "shadow" } },
    })
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await askSeat(SEAT, "x", questions)

    const row = store.db
      .prepare("SELECT seat, error FROM decision_calls")
      .get() as { seat: string; error: string }
    expect(row.seat).toBe(SEAT)
    expect(row.error).toMatch(/backend down/)
    // ...and a failed call contributes no graded answers.
    expect(store.gradedRows({})).toHaveLength(0)
  })

  it("returns null rather than throwing when the backend name is unknown", async () => {
    configureDecisions({
      enabled: true,
      store,
      defaultBackend: "jev",
      seats: { [SEAT]: { mode: "shadow" } },
    })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await askSeat(SEAT, "x", questions)).toBeNull()
  })

  it("works with no store configured — recording is optional, answering is not", async () => {
    configureDecisions({
      enabled: true,
      store: null,
      defaultBackend: "mock",
      seats: { [SEAT]: { mode: "shadow" } },
    })
    const result = await askSeat(SEAT, "x", questions)
    expect(result).not.toBeNull()
    expect(result!.callId).toBeNull()
  })

  it("honours a per-seat backend override over the default", async () => {
    registerDecisionBackend("other", () =>
      createMockDecisionBackend({ answers: { area: { probabilities: { billing: 1, technical: 0 } } } }),
    )
    configureDecisions({
      enabled: true,
      store,
      defaultBackend: "mock",
      seats: { [SEAT]: { mode: "shadow", backend: "other" } },
    })
    const result = await askSeat(SEAT, "x", questions)
    expect((result!.answers.area as ChoiceAnswer).choice).toBe("billing")
    const row = store.db.prepare("SELECT backend FROM decision_calls").get() as { backend: string }
    expect(row.backend).toBe("mock") // the mock backend reports its own name
  })
})
