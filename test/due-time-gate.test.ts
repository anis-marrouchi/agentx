import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"
import { PlanStore } from "../src/requests/plan-store"
import { openPromise } from "../src/requests/promise"
import { DUE_TIME_ASK, DUE_UNRECORDED_REASON, DueTimeGate, madeSchedule, postedNotes, saysNoDueTime, type DueRun, type DueSeatAnswer } from "../src/requests/due-gate"
import { configureDecisions, resetDecisionsRuntime } from "../src/decisions/seat"
import { _resetDecisionBackendsForTesting, registerDecisionBackend } from "../src/decisions/backend"
import { createMockDecisionBackend } from "../src/decisions/backends/mock"
import { DecisionStore } from "../src/decisions/store"
import { DUE_TIME_SEAT } from "../src/decisions/seats/due-time"
import type { SeatMode } from "../src/decisions/store"

// A due time an agent writes gets a record, so a wake stands behind it (#1908).

const HOUR = 3_600_000
const START = Date.UTC(2030, 0, 1, 10, 0, 0)

/** What the seat answers for each fixture reply: its yes/no, as a probability. */
const FIXTURES: Record<string, DueSeatAnswer> = {
  "I will post the review by 15:00Z": { commits: 0.96, owner: "this_agent", callId: null },
  "merged at 09:30Z": { commits: 0.03, owner: "none", callId: null },
}

let tmp: string
let db: Database.Database
let store: RequestStore
let jobs: JobStore
let clock: number
let asks: string[]
let lines: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-due-gate-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  jobs = new JobStore(db)
  clock = START + 5 * 60_000
  asks = []
  lines = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const run = (reply: string, over: Partial<DueRun> = {}): DueRun => ({
  agentId: "pm", channel: "a2a", chatId: "chat-1", runIds: ["t1"], startedAt: START, reply, ...over,
})

function gate(mode: SeatMode = "active", over: Partial<ConstructorParameters<typeof DueTimeGate>[0]> = {}) {
  return new DueTimeGate({
    store, mode: () => mode, now: () => clock, log: (l) => lines.push(l),
    ask: async (r) => FIXTURES[r.reply] ?? null,
    ...over,
  })
}

/** The agent's answer to the one question. */
const agent = (answer: (text: string) => { reply?: string; error?: string }) => async (text: string) => {
  asks.push(text)
  return answer(text)
}

const promise = () => openPromise(store, {
  agentId: "pm", owedTo: "owner", text: "Post the review", channel: "a2a", chatId: "chat-1", dueAt: START + 5 * HOUR, now: clock,
})

describe("a reply that sets a due time", () => {
  it("asks the agent once when nothing was recorded, and is content once it records a promise", async () => {
    const out = await gate().runEnded(run("I will post the review by 15:00Z"), agent(() => { promise(); return { reply: "Recorded." } }))
    expect(out).toBe("recorded-when-asked")
    expect(asks).toEqual([DUE_TIME_ASK])
    expect(DUE_TIME_ASK).toContain("agentx_request")
    expect(DUE_TIME_ASK).toContain("closeWhen")
    expect(store.listOpen().every((r) => r.state !== "needs_attention")).toBe(true)
  })

  it("does not ask when a matching promise was made in the run", async () => {
    promise()
    expect(await gate().runEnded(run("I will post the review by 15:00Z"), agent(() => ({ reply: "" })))).toBe("recorded")
    expect(asks).toEqual([])
  })

  it("does not count a promise made before the run, nor another agent's", async () => {
    clock = START - HOUR
    promise()
    clock = START + 60_000
    openPromise(store, { agentId: "coder", owedTo: "owner", text: "Ship it", channel: "a2a", chatId: "c", dueAt: START + 2 * HOUR, now: clock })
    expect(await gate().runEnded(run("I will post the review by 15:00Z"), agent(() => ({ reply: "Due: none" })))).toBe("none-when-asked")
    expect(asks).toHaveLength(1)
  })

  it("counts a job state with a time, and a plan step told to wait, as a record", async () => {
    jobs.open({ id: "job-1", door: "a2a", assignee: "pm", requester: "boss", text: "Review it", channel: "a2a", chatId: "chat-1", now: START })
    expect(store.dueRecordedSince("pm", START)).toBe(false)
    jobs.declare("job-1", { state: "continue", wakeAt: START + 5 * HOUR, note: "the review" }, { now: clock })
    expect(await gate().runEnded(run("I will post the review by 15:00Z"), agent(() => ({ reply: "" })))).toBe("recorded")
    expect(asks).toEqual([])
    expect(store.dueRecordedSince("coder", START)).toBe(false)
    new PlanStore(db)
    db.pragma("foreign_keys = OFF")
    db.prepare(
      `INSERT INTO request_plan_steps (request_id, idx, name, kind, agent_id, done_when, state, updated_at, wait_until)
       VALUES ('req-x', 1, 'Review', 'work', 'coder', 'reviewed', 'active', ?, ?)`,
    ).run(clock, START + 3 * HOUR)
    expect(store.dueRecordedSince("coder", START)).toBe(true)
    // A job that waits on someone until a time is a record too.
    jobs.open({ id: "job-2", door: "a2a", assignee: "qa", requester: "boss", text: "Test it", channel: "a2a", chatId: "chat-2", now: START })
    jobs.declare("job-2", { state: "waiting", on: "devops", until: START + 4 * HOUR }, { now: clock })
    expect(store.dueRecordedSince("qa", START)).toBe(true)
  })

  it("accepts the agent's word that there is none", async () => {
    expect(await gate().runEnded(run("I will post the review by 15:00Z"), agent(() => ({ reply: "Due: none" })))).toBe("none-when-asked")
    expect(store.listOpen()).toEqual([])
  })

  it("marks the run's request as needing attention when nothing is recorded even when asked", async () => {
    store.addCandidate({ id: "req-t1", runId: "t1", channel: "telegram", chatId: "chat-1", agentId: "pm", text: "Review the release notes", now: START })
    store.progress("req-t1", START)
    const out = await gate().runEnded(run("I will post the review by 15:00Z", { channel: "telegram" }), agent(() => ({ reply: "ok" })))
    expect(out).toBe("stalled")
    expect(asks).toHaveLength(1)
    const r = store.get("req-t1")!
    expect(r.state).toBe("needs_attention")
    expect(r.attentionReason).toContain(DUE_UNRECORDED_REASON)
    // The requests check tells the owner once: it waits for its notice.
    expect(store.awaitingNotice().map((x) => x.id)).toEqual(["req-t1"])
  })

  it("opens a promise that needs attention when the run has no open request", async () => {
    const out = await gate().runEnded(run("I will post the review by 15:00Z"), agent(() => ({ error: "agent busy" })))
    expect(out).toBe("stalled")
    const open = store.listOpen()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ state: "needs_attention", promise: true, agentId: "pm", owedTo: "owner" })
    expect(open[0].attentionReason).toContain("agent busy")
    // Raised, not hidden behind a wake.
    expect(jobs.get(open[0].id)?.wakeAt ?? null).toBeNull()
  })
})

describe("a reply with no commitment", () => {
  it("is not asked: the seat says no", async () => {
    expect(await gate().runEnded(run("merged at 09:30Z"), agent(() => ({ reply: "" })))).toBe("no-commitment")
    expect(asks).toEqual([])
    expect(store.listOpen()).toEqual([])
  })
})

describe("the seat's mode", () => {
  it("does nothing while it is off, and nothing without an answer", async () => {
    let asked = 0
    expect(await gate("off", { ask: async () => { asked++; return null } }).runEnded(run("I will post the review by 15:00Z"), agent(() => ({})))).toBe("off")
    expect(asked).toBe(0)
    expect(await gate("active", { ask: async () => null }).runEnded(run("anything"), agent(() => ({})))).toBe("no-answer")
    expect(asks).toEqual([])
  })

  it("only records in shadow mode: no ask, nothing raised", async () => {
    expect(await gate("shadow").runEnded(run("I will post the review by 15:00Z"), agent(() => ({ reply: "" })))).toBe("shadow")
    expect(asks).toEqual([])
    expect(store.listOpen()).toEqual([])
  })

  it("never throws into the run", async () => {
    expect(await gate("active", { ask: async () => { throw new Error("backend down") } }).runEnded(run("x"))).toBe("no-answer")
    expect(lines.join("\n")).toContain("backend down")
  })
})

describe("through the decisions runtime", () => {
  let decisions: DecisionStore

  beforeEach(() => {
    decisions = new DecisionStore({ path: path.join(tmp, "d.sqlite") })
    _resetDecisionBackendsForTesting()
    registerDecisionBackend("mock", () => createMockDecisionBackend({ answers: { commits: { noul: 0.97 }, owner: { probabilities: { this_agent: 1 } } } }))
    resetDecisionsRuntime()
  })

  afterEach(() => {
    resetDecisionsRuntime()
    decisions.close()
  })

  const real = () => new DueTimeGate({ store, now: () => clock, log: (l) => lines.push(l) })

  it("is off by default: no row, no ask", async () => {
    configureDecisions({ enabled: true, defaultBackend: "mock", store: decisions, seats: {} })
    expect(await real().runEnded(run("I will post the review by 15:00Z"), agent(() => ({})))).toBe("off")
    expect(decisions.findCallsByLink("task", "t1")).toEqual([])
    expect(asks).toEqual([])
  })

  it("records one row per finished run in shadow mode, and changes nothing", async () => {
    configureDecisions({ enabled: true, defaultBackend: "mock", store: decisions, seats: { [DUE_TIME_SEAT]: { mode: "shadow" } } })
    expect(await real().runEnded(run("I will post the review by 15:00Z"), agent(() => ({})))).toBe("shadow")
    expect(await real().runEnded(run("merged at 09:30Z", { runIds: ["t2"] }), agent(() => ({})))).toBe("shadow")
    expect(decisions.findCallsByLink("task", "t1")).toHaveLength(1)
    expect(decisions.findCallsByLink("task", "t2")).toHaveLength(1)
    expect(asks).toEqual([])
    expect(store.listOpen()).toEqual([])
  })

  it("asks in active mode", async () => {
    configureDecisions({ enabled: true, defaultBackend: "mock", store: decisions, seats: { [DUE_TIME_SEAT]: { mode: "active" } } })
    expect(await real().runEnded(run("I will post the review by 15:00Z"), agent(() => ({ reply: "Due: none" })))).toBe("none-when-asked")
    expect(asks).toHaveLength(1)
  })
})

describe("reading a run", () => {
  it("knows the agent's `Due: none`", () => {
    expect(saysNoDueTime("Due: none")).toBe(true)
    expect(saysNoDueTime("Nothing owed.\n- `Due: none`")).toBe(true)
    expect(saysNoDueTime("Due: 15:00Z")).toBe(false)
    expect(saysNoDueTime(undefined)).toBe(false)
  })

  it("keeps the tool calls that post something, and sees a schedule made", () => {
    const calls = [
      { action: "Bash", inputSummary: "gh issue comment 12 --body 'Due 12:00Z, set by me'" },
      { action: "Read", inputSummary: "src/index.ts" },
      { action: "mcp__agentx__agentx_schedule", inputSummary: '{"action":"create","when":"tomorrow 9am"}' },
    ]
    expect(postedNotes(calls)).toEqual(["Bash: gh issue comment 12 --body 'Due 12:00Z, set by me'"])
    expect(madeSchedule(calls)).toBe(true)
    expect(madeSchedule([{ action: "mcp__agentx__agentx_schedule", inputSummary: '{"action":"list"}' }])).toBe(false)
  })
})
