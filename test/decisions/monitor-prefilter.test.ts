import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { openDb, closeDb } from "../../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd } from "../../src/storage/traces"
import { SessionMonitor } from "../../src/daemon/session-monitor"
import {
  DEFAULT_EXPLORE_RATE,
  MONITOR_PREFILTER_SEAT,
  backfillMonitorLabels,
  chooseAction,
  labelFromOutcome,
  monitorPrefilterQuestions,
  prefilterState,
  runFailed,
  shouldSkip,
} from "../../src/decisions/seats/monitor-prefilter"
import { configureDecisions, resetDecisionsRuntime } from "../../src/decisions/seat"
import {
  _resetDecisionBackendsForTesting,
  registerDecisionBackend,
} from "../../src/decisions/backend"
import { createMockDecisionBackend } from "../../src/decisions/backends/mock"
import { DecisionStore } from "../../src/decisions/store"
import { finalizeAnswer } from "../../src/decisions/normalize"
import type { MonitorPrefilterAnswers } from "../../src/decisions/seats/monitor-prefilter"

const review = {
  summary: "Completed the change; needs deployment approval.",
  warnings: [],
  actions: [
    { text: "Approve deployment", evidence: "Awaiting approval", when: "now", minutes: 5, effort: "low", needsHuman: true },
  ],
  decisions: [], friction: [], context: [], links: [], relatedTaskIds: [],
}
const emptyReview = { ...review, actions: [], warnings: [] }

let dir: string
let store: DecisionStore

const origExplore = process.env.AGENTX_MONITOR_EXPLORE_RATE

beforeEach(() => {
  closeDb()
  // Exploration is random by design. Every test that asserts on a skip
  // pins the rate, or it is flaky 15% of the time.
  process.env.AGENTX_MONITOR_EXPLORE_RATE = "0"
  dir = mkdtempSync(join(tmpdir(), "prefilter-test-"))
  store = new DecisionStore({ path: join(dir, "decisions.sqlite") })
  _resetDecisionBackendsForTesting()
  resetDecisionsRuntime()
})

afterEach(() => {
  closeDb()
  if (origExplore === undefined) delete process.env.AGENTX_MONITOR_EXPLORE_RATE
  else process.env.AGENTX_MONITOR_EXPLORE_RATE = origExplore
  resetDecisionsRuntime()
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A backend that answers the two pre-filter questions however the test says. */
function seatBackend(worth: number, hitError = 0.1) {
  registerDecisionBackend("mock", () =>
    createMockDecisionBackend({
      answers: {
        worthReviewing: { noul: worth },
        runHitAnError: { noul: hitError },
      },
    }),
  )
}

function enableSeat(mode: "off" | "shadow" | "active") {
  configureDecisions({
    enabled: true,
    store,
    defaultBackend: "mock",
    seats: { [MONITOR_PREFILTER_SEAT]: { mode } },
  })
}

function fixture(result: unknown = review) {
  const reviewer = vi.fn(async () => JSON.stringify(result))
  const db = openDb({ path: join(dir, "db.sqlite") })!
  return { db, reviewer, monitor: new SessionMonitor(db, reviewer) }
}

async function runOne(
  monitor: SessionMonitor,
  db: any,
  taskId = "task1",
  status: "ok" | "error" = "ok",
) {
  recordTraceStart(db, { agentId: "dev", channel: "cli", chatId: "chat", messagePreview: "Ship it" }, taskId)
  recordTraceEnd(db, taskId, { status, finalResponse: "Awaiting approval" })
  await monitor.tick()
  await monitor.tick()
}

describe("monitor pre-filter — default off", () => {
  it("changes nothing when the seat is off", async () => {
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)

    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().reviews[0].status).toBe("ready")
    expect(store.gradedRows({})).toHaveLength(0)
  })

  it("changes nothing when decisions are enabled but this seat is off", async () => {
    seatBackend(0.01)
    enableSeat("off")
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)

    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(store.gradedRows({})).toHaveLength(0)
  })
})

describe("monitor pre-filter — shadow", () => {
  it("records one call per review and still writes the review", async () => {
    seatBackend(0.01) // "nobody would act on this" — but shadow must not skip
    enableSeat("shadow")
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)

    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().reviews[0].status).toBe("ready")

    const rows = store.gradedRows({ seat: MONITOR_PREFILTER_SEAT })
    expect(rows).toHaveLength(2) // two questions
    expect(new Set(rows.map((r) => r.question))).toEqual(
      new Set(["worthReviewing", "runHitAnError"]),
    )
    // The incumbent is what the monitor does today: review everything.
    expect(rows.find((r) => r.question === "worthReviewing")!.incumbent).toBe("yes")
    // And the call is linked back to the review, which is how labels land.
    expect(store.findCallsByLink("review", "task1")).toHaveLength(1)
  })

  it("sends a bounded state, not the reviewer's full evidence", async () => {
    seatBackend(0.5)
    enableSeat("shadow")
    const { db, monitor } = fixture()
    await runOne(monitor, db)

    const call = store.db.prepare("SELECT state_json FROM decision_calls").get() as {
      state_json: string
    }
    const state = JSON.parse(call.state_json)
    expect(Object.keys(state).sort()).toEqual([
      "agent", "channel", "durationMs", "error", "failedSteps",
      "request", "response", "status", "stepCount",
    ])
    expect(call.state_json.length).toBeLessThan(6000)
  })

  it("a broken backend leaves the review to run as normal", async () => {
    registerDecisionBackend("mock", () =>
      createMockDecisionBackend({ fail: new Error("backend down") }),
    )
    enableSeat("shadow")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)

    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().reviews[0].status).toBe("ready")
    // ...and the failure is still a recorded row, so it shows up in stats.
    const failures = store.db
      .prepare("SELECT COUNT(*) AS n FROM decision_calls WHERE error IS NOT NULL")
      .get() as { n: number }
    expect(failures.n).toBe(1)
  })
})

describe("monitor pre-filter — active", () => {
  it("skips the opus call when confidently not worth reviewing", async () => {
    seatBackend(0.02)
    enableSeat("active")
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)

    expect(reviewer).not.toHaveBeenCalled()
    expect(monitor.snapshot().reviews[0].status).toBe("skipped")
  })

  it("never skips a run that failed, whatever the model says", async () => {
    seatBackend(0.0) // maximally confident that nobody would act
    enableSeat("active")
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db, "task1", "error")

    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().reviews[0].status).toBe("ready")
  })

  it("does not skip on a low-confidence answer", async () => {
    seatBackend(0.45) // near a coin flip
    enableSeat("active")
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)

    expect(reviewer).toHaveBeenCalledTimes(1)
  })

  it("does not skip when the model thinks a human would act", async () => {
    seatBackend(0.97)
    enableSeat("active")
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)

    expect(reviewer).toHaveBeenCalledTimes(1)
  })

  it("keeps a skipped review retryable, with its input intact", async () => {
    seatBackend(0.02)
    enableSeat("active")
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)
    expect(monitor.snapshot().reviews[0].status).toBe("skipped")

    const row = db.prepare("SELECT input FROM session_reviews WHERE id='task1'").get() as {
      input: string
    }
    expect(row.input.length).toBeGreaterThan(0)

    monitor.retry("task1")
    enableSeat("off")
    await monitor.tick()
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().reviews[0].status).toBe("ready")
  })
})

describe("shouldSkip", () => {
  it("honours the documented maxWorth, not half of it", () => {
    // Same regression as session-continuity's shouldRotateEarly: a
    // derived |noul - 0.5| * 2 "confidence" floored at 0.8 turned a
    // documented maxWorth of 0.2 into an effective 0.1. A Noul carries no
    // confidence to gate on, so the threshold now stands alone.
    expect(shouldSkip(answers(0.15), { runFailed: false })).toBe(true)
    expect(shouldSkip(answers(0.2), { runFailed: false })).toBe(true)
    expect(shouldSkip(answers(0.21), { runFailed: false })).toBe(false)
  })

  const answers = (worth: number): MonitorPrefilterAnswers =>
    ({
      worthReviewing: finalizeAnswer(monitorPrefilterQuestions.worthReviewing, { noul: worth }).answer,
      runHitAnError: finalizeAnswer(monitorPrefilterQuestions.runHitAnError, { noul: 0.1 }).answer,
    }) as MonitorPrefilterAnswers

  it("requires confidence, a low worth estimate, and a run that did not fail", () => {
    expect(shouldSkip(answers(0.02), { runFailed: false })).toBe(true)
    expect(shouldSkip(answers(0.02), { runFailed: true })).toBe(false)
    expect(shouldSkip(answers(0.3), { runFailed: false })).toBe(false)
    expect(shouldSkip(answers(0.5), { runFailed: false })).toBe(false)
    expect(shouldSkip(answers(0.9), { runFailed: false })).toBe(false)
  })

  it("the failure override is not a threshold and cannot be tuned away", () => {
    expect(
      shouldSkip(answers(0.0), { runFailed: true, maxWorth: 1 }),
    ).toBe(false)
  })
})

describe("runFailed and prefilterState", () => {
  it("treats anything but a success status as a failure", () => {
    expect(runFailed({ task: { status: "ok" } })).toBe(false)
    expect(runFailed({ task: { status: "completed" } })).toBe(false)
    expect(runFailed({ task: { status: "error" } })).toBe(true)
    expect(runFailed({ task: { status: "canceled" } })).toBe(true)
    expect(runFailed({ task: {} })).toBe(false)
  })

  it("clips a huge evidence payload down to something cheap", () => {
    const state = prefilterState({
      task: { agentId: "dev", status: "ok", originalMessage: "x".repeat(20000), finalResponse: "y".repeat(40000) },
      steps: Array.from({ length: 60 }, () => ({ status: "ok" })),
    }) as any
    expect(state.request).toHaveLength(1200)
    expect(state.response).toHaveLength(2000)
    expect(state.stepCount).toBe(60)
  })
})

describe("labelFromOutcome", () => {
  it("labels the control question on every row, exactly", async () => {
    const { db, monitor } = fixture()
    await runOne(monitor, db, "task1", "error")
    expect(labelFromOutcome(db, "task1")!.runHitAnError).toBe("yes")
  })

  it("calls a review worth writing when it raised a now action", async () => {
    const { db, monitor } = fixture(review)
    await runOne(monitor, db)
    expect(labelFromOutcome(db, "task1")!.worthReviewing).toBe("yes")
  })

  it("calls it worth writing when someone actually marked an action done", async () => {
    const later = { ...review, actions: [{ ...review.actions[0], when: "later" }] }
    const { db, monitor } = fixture(later)
    await runOne(monitor, db)
    expect(labelFromOutcome(db, "task1")!.worthReviewing).toBeUndefined()

    monitor.action({ reviewId: "task1", index: 0, state: "done" })
    expect(labelFromOutcome(db, "task1")!.worthReviewing).toBe("yes")
  })

  it("calls it not worth writing when it produced nothing", async () => {
    const { db, monitor } = fixture(emptyReview)
    await runOne(monitor, db)
    expect(labelFromOutcome(db, "task1")!.worthReviewing).toBe("no")
  })

  it("leaves genuinely ambiguous rows unlabeled rather than guessing", async () => {
    const later = { ...review, actions: [{ ...review.actions[0], when: "later" }] }
    const { db, monitor } = fixture(later)
    await runOne(monitor, db)
    const labels = labelFromOutcome(db, "task1")!
    expect(labels.worthReviewing).toBeUndefined()
    expect(labels.runHitAnError).toBe("no")
  })
})

describe("backfillMonitorLabels", () => {
  it("attaches outcome labels to shadow rows and is idempotent", async () => {
    seatBackend(0.3)
    enableSeat("shadow")
    const { db, monitor } = fixture(emptyReview)
    await runOne(monitor, db)

    expect(store.gradedRows({ labeledOnly: true })).toHaveLength(0)
    expect(backfillMonitorLabels(db, store)).toBe(2)

    const rows = store.gradedRows({ seat: MONITOR_PREFILTER_SEAT, labeledOnly: true })
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.question === "worthReviewing")!.truth).toBe("no")
    expect(rows.find((r) => r.question === "runHitAnError")!.truth).toBe("no")

    expect(backfillMonitorLabels(db, store)).toBe(0)
  })
})

describe("chooseAction — exploration", () => {
  const answers = (worth: number): MonitorPrefilterAnswers =>
    ({
      worthReviewing: finalizeAnswer(monitorPrefilterQuestions.worthReviewing, { noul: worth }).answer,
      runHitAnError: finalizeAnswer(monitorPrefilterQuestions.runHitAnError, { noul: 0.1 }).answer,
    }) as MonitorPrefilterAnswers

  const skipWorthy = answers(0.02)
  const reviewWorthy = answers(0.95)

  it("a review verdict never explores — there is nothing to explore", () => {
    expect(chooseAction(reviewWorthy, { active: true, runFailed: false, rng: () => 0 })).toEqual({
      action: "review",
      skip: false,
      explored: false,
    })
  })

  it("shadow records the skip verdict but never skips, so the row is gradeable", () => {
    expect(chooseAction(skipWorthy, { active: false, runFailed: false })).toEqual({
      action: "skip",
      skip: false,
      explored: true,
    })
  })

  it("active explores when the draw lands under the rate", () => {
    expect(
      chooseAction(skipWorthy, { active: true, runFailed: false, explore: 0.15, rng: () => 0.05 }),
    ).toEqual({ action: "skip", skip: false, explored: true })
  })

  it("active skips when the draw lands over the rate", () => {
    expect(
      chooseAction(skipWorthy, { active: true, runFailed: false, explore: 0.15, rng: () => 0.9 }),
    ).toEqual({ action: "skip", skip: true, explored: false })
  })

  it("explore=0 always skips, which is what makes the metrics untrustworthy", () => {
    expect(
      chooseAction(skipWorthy, { active: true, runFailed: false, explore: 0, rng: () => 0 }).skip,
    ).toBe(true)
  })

  it("defaults to a non-zero rate rather than silently never exploring", () => {
    expect(DEFAULT_EXPLORE_RATE).toBeGreaterThan(0)
    let explored = 0
    for (let i = 0; i < 1000; i++) {
      const r = i / 1000
      if (chooseAction(skipWorthy, { active: true, runFailed: false, rng: () => r }).explored) explored++
    }
    expect(explored / 1000).toBeCloseTo(DEFAULT_EXPLORE_RATE, 2)
  })
})

describe("exploration, end to end", () => {
  it("shadow records the counterfactual skip verdict on a real review", async () => {
    seatBackend(0.02) // the policy would skip this
    enableSeat("shadow")
    const { db, reviewer, monitor } = fixture()
    await runOne(monitor, db)

    expect(reviewer).toHaveBeenCalledTimes(1) // shadow never skips
    const row = store.db
      .prepare("SELECT action, explored FROM decision_calls")
      .get() as { action: string; explored: number }
    expect(row.action).toBe("skip")
    expect(row.explored).toBe(1)
  })

  it("an explored skip is gradeable; a real skip never is", async () => {
    seatBackend(0.02)

    // Exploration forces the review, so the outcome labels it.
    process.env.AGENTX_MONITOR_EXPLORE_RATE = "1"
    enableSeat("active")
    const a = fixture(emptyReview)
    await runOne(a.monitor, a.db, "explored-task")
    expect(a.reviewer).toHaveBeenCalledTimes(1)

    // Without exploration the review never runs, so nothing can label it.
    process.env.AGENTX_MONITOR_EXPLORE_RATE = "0"
    const b = new SessionMonitor(a.db, a.reviewer)
    await runOne(b, a.db, "skipped-task")
    expect(a.reviewer).toHaveBeenCalledTimes(1) // still one — the second was skipped

    backfillMonitorLabels(a.db, store)
    const rows = store.gradedRows({ question: "worthReviewing" })
    expect(rows).toHaveLength(2)

    expect(rows.find((r) => r.explored)!.truth).toBe("no") // gradeable
    expect(rows.find((r) => !r.explored)!.truth).toBeUndefined() // permanently unlabelable
  })

  it("the unbiased skip-region sample is queryable on its own", async () => {
    seatBackend(0.02)
    enableSeat("shadow")
    const { db, monitor } = fixture()
    await runOne(monitor, db, "t1")
    await runOne(monitor, db, "t2")

    expect(store.gradedRows({ exploredOnly: true })).toHaveLength(4) // 2 runs x 2 questions
    expect(store.gradedRows({ action: "skip" })).toHaveLength(4)
    expect(store.gradedRows({ action: "review" })).toHaveLength(0)
  })
})
