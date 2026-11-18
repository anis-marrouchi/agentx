import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"
import { DEFAULT_WAKE_SETTINGS, JobWake } from "../src/jobs/wake"
import { armPromiseWake, openPromise, raiseLoop } from "../src/requests/promise"
import { runRequestsSweep } from "../src/requests/sweep"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"

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

// The same hour it falls due (#1908): the agent is woken and whoever waits
// on it is told by the requests check, not after the quiet time.
describe("a promise past its due time", () => {
  const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
  let told: Array<{ to: string; text: string }>
  let notices: string[]

  const check = () => runRequestsSweep({
    store, settings, log: () => {}, now: clock,
    hasAgent: (id) => ["sales", "pm"].includes(id),
    wakeJob: (id, note) => wake.wakeFor(id, note),
    tellRequester: (to, text) => { told.push({ to, text }); return true },
    notify: async (title) => { notices.push(title) },
  })

  beforeEach(() => {
    told = []
    notices = []
  })

  it("wakes its agent at the due time and tells the owner in the same check", async () => {
    const p = promise()
    clock += HOUR
    expect((await check()).duePushed).toBe(0)
    expect(wake.tick().woken).toBe(0)
    clock += HOUR + MIN
    const result = await check()
    expect(result.duePushed).toBe(1)
    expect(result.notified).toBe(1)
    expect(notices[0]).toContain("Promise not kept")
    expect(store.get(p.id)).toMatchObject({ state: "needs_attention" })
    expect(store.get(p.id)!.attentionReason).toContain("Past its due time")
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(started.map((s) => s.id)).toEqual([p.id])
    // Once: the next checks neither wake nor tell again.
    clock += MIN
    expect((await check()).duePushed).toBe(0)
    expect(wake.tick().woken).toBe(0)
    expect(notices).toHaveLength(1)
  })

  it("wakes the agent even when the promise had no wake armed", async () => {
    const p = promise({ wake: false })
    expect(jobs.get(p.id)?.wakeAt).toBeNull()
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(1)
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(started[0]).toMatchObject({ id: p.id, assignee: "sales" })
    expect(started[0].text).toContain("fell due")
  })

  it("tells the agent that waits on it, as a notice", async () => {
    const p = promise({ owedTo: "pm" })
    clock += 2 * HOUR + MIN
    await check()
    expect(told).toHaveLength(1)
    expect(told[0].to).toBe("pm")
    expect(told[0].text).toContain(p.id)
    expect(told[0].text).toContain("sales promised you this")
  })

  // A host rolled back to code from before the push (#1912): that code
  // sets a due time without clearing `due_pushed_at`.
  const oldSetDue = (id: string, dueAt: number) =>
    db.prepare("UPDATE requests SET due_at = ?, state = 'in_progress', attention_reason = NULL, updated_at = ? WHERE id = ?").run(dueAt, clock, id)

  it("pushes a new due time that older code wrote with the pushed mark left set, once", async () => {
    const p = promise()
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(1)
    oldSetDue(p.id, clock + HOUR)
    expect((db.prepare("SELECT due_pushed_at FROM requests WHERE id = ?").get(p.id) as any).due_pushed_at).not.toBeNull()
    expect((await check()).duePushed).toBe(0)
    clock += HOUR + MIN
    expect((await check()).duePushed).toBe(1)
    expect(store.get(p.id)!.attentionReason).toContain("Past its due time")
    clock += MIN
    expect((await check()).duePushed).toBe(0)
    expect(notices).toHaveLength(2)
  })

  it("pushes it too when the push itself was made before the mark held a due time", async () => {
    const p = promise()
    clock += 2 * HOUR + MIN
    // Pushed by 0.229.0: only `due_pushed_at` is written.
    db.prepare("UPDATE requests SET due_pushed_at = ?, due_pushed_for = NULL WHERE id = ?").run(clock, p.id)
    const other = promise({ chatId: "chat-2" })
    db.prepare("UPDATE requests SET due_pushed_at = ?, due_pushed_for = NULL WHERE id = ?").run(clock, other.id)
    oldSetDue(p.id, clock + HOUR)
    // The upgrade: the store opens the database again.
    store = new RequestStore(db)
    clock += HOUR + MIN
    // The new due time is pushed; the one already pushed is not pushed again.
    expect(store.duePromises(clock).map((r) => r.id)).toEqual([p.id])
    expect((await check()).duePushed).toBe(1)
    expect((await check()).duePushed).toBe(0)
  })

  it("leaves a kept promise, one not due yet, and one the owner owes", async () => {
    const kept = promise()
    store.close(kept.id, "done", "https://example.com/sent", clock)
    promise({ dueAt: clock + 5 * HOUR })
    promise({ owedTo: "sales", owedBy: "owner", channel: "approvals", chatId: "card-2" })
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(0)
    expect(told).toEqual([])
  })
})

describe("a due time an agent accepts on a request", () => {
  it("arms the wake, like a promise's", () => {
    const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
    const tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
    tracker.taskStarted({
      agentId: "sales", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: "Send the offer", fullMessage: "Send the offer",
      at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
    const due = new Date(clock + 3 * HOUR).toISOString()
    const res = handleRequestsApi("POST", "/requests", { agentId: "sales", action: "accept", id: "req-t1", due }, {
      store, tracker, enabled: true, hasAgent: (id) => id === "sales", now: clock,
      runningTurn: (agentId) => (agentId === "sales" ? { channel: "telegram", chatId: "chat-1" } : null),
    }, { taskId: "t1" })
    expect(res.status).toBe(200)
    expect(jobs.get("req-t1")).toMatchObject({ wakeAt: clock + 3 * HOUR, state: "continue" })
  })
})
