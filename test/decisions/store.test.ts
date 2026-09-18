import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { DecisionStore, answerView } from "../../src/decisions/store"
import { finalizeAnswer } from "../../src/decisions/normalize"
import { choice, noul, score } from "../../src/decisions/questions"
import type { AnyAnswer } from "../../src/decisions/types"

const questions = {
  area: choice({ billing: null, technical: null }),
  urgent: noul("is this urgent?"),
  quality: score(["poor", "fine", "good"]),
}

function answers(billing = 0.8): Record<string, AnyAnswer> {
  return {
    area: finalizeAnswer(questions.area, {
      probabilities: { billing, technical: 1 - billing },
    }).answer,
    urgent: finalizeAnswer(questions.urgent, { noul: 0.9 }).answer,
    quality: finalizeAnswer(questions.quality, {
      probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
    }).answer,
  }
}

const meta = {
  structureMode: "mock" as const,
  answerMode: "probabilities" as const,
  retries: 0,
  stateTruncated: false,
  latencyMs: 12,
}

function baseCall(overrides: Partial<Parameters<DecisionStore["recordCall"]>[0]> = {}) {
  return {
    seat: "workflow-matcher",
    mode: "shadow" as const,
    backend: "mock",
    model: "mock",
    meta,
    state: { message: "I was charged twice" },
    questions,
    answers: answers(),
    ...overrides,
  }
}

describe("DecisionStore", () => {
  let tmp: string
  let store: DecisionStore

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-decisions-"))
    store = new DecisionStore({ path: path.join(tmp, "decisions.sqlite") })
  })

  afterEach(() => {
    store.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("creates its schema and is idempotent on reopen", () => {
    expect(store.schemaVersion()).toBe(2)
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name)
    expect(tables).toEqual([
      "decision_answers",
      "decision_calls",
      "decision_incumbent",
      "decision_labels",
      "decision_links",
      "schema_version",
    ])

    store.close()
    const reopened = new DecisionStore({ path: path.join(tmp, "decisions.sqlite") })
    expect(reopened.schemaVersion()).toBe(2)
    reopened.close()
    store = new DecisionStore({ path: path.join(tmp, "decisions.sqlite") })
  })

  it("records one row per question and returns a sortable call id", () => {
    const first = store.recordCall(baseCall({ ts: 1000 }))
    const second = store.recordCall(baseCall({ ts: 2000 }))
    expect(second > first).toBe(true)

    const rows = store.gradedRows({ seat: "workflow-matcher" })
    expect(rows).toHaveLength(6) // 2 calls x 3 questions
    expect(new Set(rows.map((r) => r.question))).toEqual(new Set(["area", "urgent", "quality"]))
  })

  it("stores an incumbent and joins it back onto the graded row", () => {
    const callId = store.recordCall(
      baseCall({ incumbent: { area: { value: "technical", score: 0.71, source: "matchWorkflow" } } }),
    )
    const area = store.gradedRows({ question: "area" })[0]
    expect(area.callId).toBe(callId)
    expect(area.predicted).toBe("billing")
    expect(area.incumbent).toBe("technical")
    // Questions with no incumbent stay undefined rather than becoming null.
    expect(store.gradedRows({ question: "urgent" })[0].incumbent).toBeUndefined()
  })

  it("takes the newest label per question, keeping the earlier one on disk", () => {
    const callId = store.recordCall(baseCall())
    store.label(callId, "area", "technical", { kind: "outcome", ts: 1000 })
    store.label(callId, "area", "billing", { kind: "human", labeledBy: "anis", ts: 2000 })

    expect(store.gradedRows({ question: "area" })[0].truth).toBe("billing")
    const stored = store.db
      .prepare("SELECT value FROM decision_labels WHERE call_id = ? ORDER BY id")
      .all(callId)
      .map((r: any) => r.value)
    expect(stored).toEqual(["technical", "billing"])
  })

  it("filters to labeled rows only when asked", () => {
    const a = store.recordCall(baseCall())
    store.recordCall(baseCall())
    store.label(a, "area", "billing")
    expect(store.gradedRows({ question: "area" })).toHaveLength(2)
    expect(store.gradedRows({ question: "area", labeledOnly: true })).toHaveLength(1)
  })

  it("keeps a failed call as a row, and excludes it from grading", () => {
    store.recordCall(baseCall({ error: "backend timed out", answers: {} }))
    expect(store.gradedRows({})).toHaveLength(0)
    const failures = store.db
      .prepare("SELECT COUNT(*) AS n FROM decision_calls WHERE error IS NOT NULL")
      .get() as { n: number }
    expect(failures.n).toBe(1)
  })

  it("links a call to an external reference and finds it again", () => {
    const callId = store.recordCall(baseCall({ links: [{ kind: "task", id: "t-42" }] }))
    expect(store.findCallsByLink("task", "t-42")).toEqual([callId])
    expect(store.findCallsByLink("task", "t-99")).toEqual([])
  })

  it("can drop the state but never the hash", () => {
    for (let i = 0; i < 5; i++) store.recordCall(baseCall({ ts: 1000 + i }))
    expect(store.pruneState("workflow-matcher", 2)).toBe(3)

    const rows = store.db
      .prepare("SELECT state_json, state_hash FROM decision_calls ORDER BY ts")
      .all() as Array<{ state_json: string | null; state_hash: string }>
    expect(rows.filter((r) => r.state_json === null)).toHaveLength(3)
    expect(rows.every((r) => r.state_hash.length === 64)).toBe(true)
  })

  it("honours keepState: false at write time, for redacted seats", () => {
    store.recordCall(baseCall({ keepState: false }))
    const row = store.db.prepare("SELECT state_json, state_hash FROM decision_calls").get() as any
    expect(row.state_json).toBeNull()
    expect(row.state_hash).toHaveLength(64)
  })
})

describe("answerView", () => {
  it("projects a noul into a two-outcome distribution so it grades like a choice", () => {
    const yes = answerView(finalizeAnswer(noul(), { noul: 0.9 }).answer)
    expect(yes.predicted).toBe("yes")
    expect(yes.confidence).toBeCloseTo(0.8, 10) // |0.9 - 0.5| * 2
    expect(yes.probabilities.yes).toBeCloseTo(0.9, 10)
    expect(yes.probabilities.no).toBeCloseTo(0.1, 10)

    const no = answerView(finalizeAnswer(noul(), { noul: 0.1 }).answer)
    expect(no.predicted).toBe("no")
    expect(no.confidence).toBeCloseTo(0.8, 10)

    const coinFlip = answerView(finalizeAnswer(noul(), { noul: 0.5 }).answer)
    expect(coinFlip.confidence).toBe(0)
  })

  it("rounds a score to the nearest level for grading, keeping the expected value", () => {
    const view = answerView(
      finalizeAnswer(score(["poor", "fine", "good"]), {
        probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
      }).answer,
    )
    expect(view.expectedScore).toBeCloseTo(1.6, 10)
    expect(view.predicted).toBe("2")
  })
})

describe("policy outcomes", () => {
  let tmp2: string
  let s2: DecisionStore
  beforeEach(() => {
    tmp2 = mkdtempSync(path.join(tmpdir(), "agentx-outcome-"))
    s2 = new DecisionStore({ path: path.join(tmp2, "d.sqlite") })
  })
  afterEach(() => {
    s2.close()
    rmSync(tmp2, { recursive: true, force: true })
  })

  it("defaults to no recorded action, because askSeat cannot know one", () => {
    s2.recordCall(baseCall())
    const row = s2.gradedRows({})[0]
    expect(row.action).toBeUndefined()
    expect(row.explored).toBe(false)
    expect(row.mode).toBe("shadow")
  })

  it("records what the caller did and makes it filterable", () => {
    const skipped = s2.recordCall(baseCall({ ts: 1000 }))
    const reviewed = s2.recordCall(baseCall({ ts: 2000 }))
    s2.recordOutcome(skipped, "skip", true)
    s2.recordOutcome(reviewed, "review")

    expect(s2.gradedRows({ action: "skip" }).every((r) => r.callId === skipped)).toBe(true)
    expect(s2.gradedRows({ exploredOnly: true }).every((r) => r.explored)).toBe(true)
    expect(s2.gradedRows({ action: "review" })[0].explored).toBe(false)
  })
})
