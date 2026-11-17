import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"
import { DEFAULT_WAKE_SETTINGS, JobWake } from "../src/jobs/wake"
import { armPromiseWake, openPromise, raiseLoop } from "../src/requests/promise"

// A promise's due time wakes the agent that owes it (noqta#858): before,
// the due time only told the owner the promise was late.

const MIN = 60_000
const HOUR = 60 * MIN

let tmp: string
let db: Database.Database
let store: RequestStore
let jobs: JobStore
let wake: JobWake
let clock: number
let started: Array<{ id: string; assignee: string; text: string }>

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-promise-wake-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, status TEXT, started_at INTEGER, finished_at INTEGER, cost_usd REAL, error TEXT)")
  store = new RequestStore(db)
  jobs = new JobStore(db)
  clock = Date.UTC(2026, 10, 18, 8, 0, 0)
  started = []
  wake = new JobWake({
    jobs, settings: () => ({ ...DEFAULT_WAKE_SETTINGS }), log: () => {}, now: () => clock,
    facts: () => ({ lastRunEndedAt: clock - HOUR }),
    start: async (job, text) => { started.push({ id: job.id, assignee: job.assignee, text }); return {} },
    hasAgent: () => true,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const flush = () => new Promise((r) => setTimeout(r, 0))

const promise = (over: Partial<Parameters<typeof openPromise>[1]> = {}) => openPromise(store, {
  agentId: "sales", owedTo: "owner", text: "Send the second follow-up email at 10:00Z", channel: "telegram", chatId: "chat-1",
  dueAt: clock + 2 * HOUR, now: clock, ...over,
})

describe("a promise with a due time", () => {
  it("wakes the agent that owes it when it falls due, once, with what it promised", async () => {
    const p = promise()
    expect(wake.tick().woken).toBe(0)
    clock += HOUR
    expect(wake.tick().woken).toBe(0)
    clock += HOUR
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ id: p.id, assignee: "sales" })
    expect(started[0].text).toContain("Send the second follow-up email at 10:00Z")
    expect(started[0].text).toContain("owed to owner")
    clock += HOUR
    expect(wake.tick().woken).toBe(0)
  })

  it("stays an open promise: armed, still in progress, its due time kept", () => {
    const p = promise()
    expect(store.get(p.id)).toMatchObject({ state: "in_progress", promise: true, dueAt: clock + 2 * HOUR })
    expect(jobs.get(p.id)).toMatchObject({ wakeAt: clock + 2 * HOUR, state: "continue" })
  })

  it("does not wake once it is kept", () => {
    const p = promise()
    store.close(p.id, "done", "https://example.com/sent", clock)
    clock += 2 * HOUR
    expect(wake.tick().woken).toBe(0)
  })

  it("arms nothing without a due time, or with one already past", () => {
    const a = promise({ dueAt: null })
    const b = promise({ dueAt: clock - MIN })
    expect(jobs.get(a.id)?.wakeAt).toBeNull()
    expect(jobs.get(b.id)?.wakeAt).toBeNull()
    clock += HOUR
    expect(wake.tick().woken).toBe(0)
  })

  it("does not wake for a promise the owner owes: the owner is not an agent to wake", () => {
    const p = promise({ owedTo: "sales", owedBy: "owner", channel: "approvals", chatId: "card-1" })
    expect(store.get(p.id)?.state).toBe("waiting_owner")
    expect(jobs.get(p.id)?.wakeAt).toBeNull()
  })

  it("an escalation stays needing attention, not hidden behind a wake", () => {
    const { requestId } = raiseLoop(store, {
      links: [], reason: "the follow-up ran out",
      open: { agentId: "sales", owedTo: "owner", text: "Chase the lead", channel: "telegram", chatId: "chat-1", dueAt: clock + HOUR, link: { kind: "card", ref: "c-1" } },
      now: clock,
    })
    expect(store.get(requestId)?.state).toBe("needs_attention")
    expect(jobs.get(requestId)?.wakeAt).toBeNull()
  })
})

describe("a due time added to an open request", () => {
  it("arms the wake once, and never over a state a run declared or a wake already set", () => {
    const p = promise({ dueAt: null })
    expect(armPromiseWake(store, p.id, clock + HOUR, clock)).toBe(true)
    expect(armPromiseWake(store, p.id, clock + 3 * HOUR, clock)).toBe(false)
    expect(jobs.get(p.id)?.wakeAt).toBe(clock + HOUR)

    const q = promise({ dueAt: null })
    jobs.declare(q.id, { state: "waiting", on: "pm", until: clock + 5 * HOUR }, { now: clock })
    expect(armPromiseWake(store, q.id, clock + HOUR, clock)).toBe(false)
    expect(jobs.get(q.id)?.state).toBe("waiting")
  })
})
