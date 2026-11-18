import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"
import { SlotStore } from "../src/requests/slot-store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi, type RequestsApiDeps } from "../src/requests/daemon-api"
import { DEFAULT_DUE_TIME_SETTINGS, dueTimesCtx, NO_SOURCE_REFUSAL, type DueTimeMode } from "../src/requests/due-times"
import { place, schedule, type QueueItem, type SlotOptions } from "../src/requests/slots"
import { correctionFactors, EstimateCache } from "../src/requests/estimates"
import { dueReport } from "../src/requests/due-report"

// Due times from the queue (#1909): the agent registers the work, the
// daemon gives the time. A fake clock throughout.

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.UTC(2030, 0, 14, 8, 0, 0)

let tmp: string
let db: Database.Database
let store: RequestStore
let slots: SlotStore
let jobs: JobStore
let tracker: RequestTracker
let told: Array<{ to: string; text: string; id: string }>
let logs: string[]

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-due-times-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  jobs = new JobStore(db)
  slots = new SlotStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => T0)
  told = []
  logs = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function deps(mode: DueTimeMode, now = T0, capacity = 4): RequestsApiDeps {
  return {
    store, tracker, enabled: true, now,
    hasAgent: (id) => ["writer", "coder", "pm"].includes(id),
    runningTurn: (agentId) => ({ channel: "telegram", chatId: `chat-${agentId}` }),
    dueTimes: dueTimesCtx(db, { ...DEFAULT_DUE_TIME_SETTINGS, mode }, {
      capacity, lanes: () => 1, now: () => now,
      tell: (to, text, id) => told.push({ to, text, id }),
      log: (m) => logs.push(m),
    }, slots),
  }
}

function promise(mode: DueTimeMode, body: Record<string, unknown>, now = T0) {
  return handleRequestsApi("POST", "/requests", { agentId: "writer", action: "promise", owedTo: "owner", text: "Write the summary", ...body }, deps(mode, now))
}

/** An owner's request to `agent`, waiting for its accept. */
function ownerRequest(id: string, agent = "writer", text = "Send the offer") {
  tracker.taskStarted({
    agentId: agent, channel: "telegram", chatId: `chat-${agent}`, taskId: id, messagePreview: text, fullMessage: text,
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
  return `req-${id}`
}

function accept(mode: DueTimeMode, id: string, body: Record<string, unknown> = {}, now = T0, agent = "writer") {
  return handleRequestsApi("POST", "/requests", { agentId: agent, action: "accept", id, ...body }, deps(mode, now))
}

describe("the scheduler, on a fake clock", () => {
  const opts: SlotOptions = { now: T0, capacity: 4, lanes: () => 1, factor: () => 1, defaultMinutes: () => 30 }
  const item = (id: string, minutes: number, extra: Partial<QueueItem> = {}): QueueItem => ({
    id, agentId: "writer", priority: "normal", estimateMinutes: minutes, createdAt: T0 - HOUR, dueAt: null, requester: "owner", ...extra,
  })

  it("an empty queue and a 20-minute estimate gives a due 20 minutes out", () => {
    const a = place([], item("new", 20, { createdAt: T0 }), opts, "given")
    expect(a.dueAt).toBe(T0 + 20 * MIN)
    expect(a.inputs).toMatchObject({ queueLength: 0, queueMinutes: 0, priority: "normal", factor: 1 })
  })

  it("the same job behind 3 queued hours gives a due after them", () => {
    const queue = [item("a", 60), item("b", 60), item("c", 60)]
    const a = place(queue, item("new", 20, { createdAt: T0 }), opts, "given")
    expect(a.dueAt).toBe(T0 + 3 * HOUR + 20 * MIN)
    expect(a.inputs).toMatchObject({ queueLength: 3, queueMinutes: 180 })
  })

  it("applies the agent's correction factor to every estimate", () => {
    const a = place([item("a", 60)], item("new", 20, { createdAt: T0 }), { ...opts, factor: () => 1.5 }, "given")
    expect(a.dueAt).toBe(T0 + 90 * MIN + 30 * MIN)
    expect(a.inputs.factor).toBe(1.5)
  })

  it("other agents' work only waits on the node's capacity", () => {
    const queue = [item("a", 60, { agentId: "coder" }), item("b", 60, { agentId: "pm" })]
    expect(place(queue, item("new", 20, { createdAt: T0 }), opts, "given").dueAt).toBe(T0 + 20 * MIN)
    expect(place(queue, item("new", 20, { createdAt: T0 }), { ...opts, capacity: 1 }, "given").dueAt).toBe(T0 + 140 * MIN)
  })

  it("a critical job goes ahead of earlier normal work", () => {
    const plan = schedule([item("a", 60), item("crit", 30, { priority: "critical", createdAt: T0 })], opts)
    expect(plan.get("crit")!.endAt).toBe(T0 + 30 * MIN)
    expect(plan.get("a")!.endAt).toBe(T0 + 90 * MIN)
  })
})

describe("promise and accept without due (mode on)", () => {
  it("a promise gets the daemon's due time, with the inputs it used", () => {
    const res = promise("on", { estimateMinutes: 20, priority: "high" })
    expect(res.status).toBe(200)
    const body = res.body as any
    expect(body.request.dueAt).toBe(T0 + 20 * MIN)
    expect(body.due).toMatchObject({ dueAt: T0 + 20 * MIN, source: "daemon", inputs: { queueLength: 0, priority: "high", factor: 1, estimateFrom: "given" } })
    expect(slots.get(body.request.id)).toMatchObject({ source: "daemon", mode: "on", computedDue: T0 + 20 * MIN, givenDue: T0 + 20 * MIN })
  })

  it("an accept behind 3 queued hours is due after them", () => {
    for (const _ of [1, 2, 3]) expect(promise("on", { estimateMinutes: 60 }).status).toBe(200)
    const id = ownerRequest("t1")
    const res = accept("on", id, { work: "writing", estimateMinutes: 20 })
    expect(res.status).toBe(200)
    expect((res.body as any).due).toMatchObject({ dueAt: T0 + 3 * HOUR + 20 * MIN, inputs: { queueLength: 3, queueMinutes: 180 } })
    expect(store.get(id)).toMatchObject({ state: "in_progress", dueAt: T0 + 3 * HOUR + 20 * MIN })
  })

  it("work with no estimate counts the default minutes", () => {
    const res = promise("on", {})
    expect((res.body as any).due).toMatchObject({ dueAt: T0 + 30 * MIN, inputs: { estimateFrom: "default" } })
  })
})

describe("a due time with a source", () => {
  it("the requester's time replaces the computed one when it fits", () => {
    const id = ownerRequest("t1")
    const due = new Date(T0 + 4 * HOUR).toISOString()
    const res = accept("on", id, { work: "writing", estimateMinutes: 20, due, dueSource: { kind: "requester", text: "by noon please" } })
    expect(res.status).toBe(200)
    expect(store.get(id)!.dueAt).toBe(T0 + 4 * HOUR)
    expect((res.body as any).due).toMatchObject({ source: "requester", dueAt: T0 + 4 * HOUR })
    expect(slots.get(id)).toMatchObject({ source: "requester", sourceText: "by noon please", computedDue: T0 + 20 * MIN })
  })

  it("a time that does not fit is answered at once, and nothing is accepted until the requester chooses", () => {
    expect(promise("on", { estimateMinutes: 120, text: "Draft the report" }).status).toBe(200)
    const first = slots.queue({ now: T0, staleAfterMs: 24 * HOUR })[0]
    const id = ownerRequest("t1")
    const due = new Date(T0 + HOUR).toISOString()
    const res = accept("on", id, { work: "writing", estimateMinutes: 30, due, dueSource: { kind: "requester", text: "within the hour" } })
    expect(res.status).toBe(409)
    const body = res.body as any
    expect(body.error).toMatch(/does not fit the queue/)
    expect(body.error).toMatch(/earliest with nothing moved is 2030-01-14 10:30 UTC/)
    expect(body.error).toMatch(/"Draft the report" .* moves from 2030-01-14 10:00 UTC to 2030-01-14 10:30 UTC/)
    expect(body.earliest).toBe(new Date(T0 + 150 * MIN).toISOString())
    expect(body.withRoom).toMatchObject({ meets: true, dueAt: new Date(T0 + 30 * MIN).toISOString() })
    expect(body.withRoom.moves.map((m: any) => m.id)).toEqual([first.id])
    // Not accepted: still the turn's candidate, no slot, no due time.
    expect(store.get(id)).toMatchObject({ state: "candidate", dueAt: null })
    expect(slots.get(id)).toBeNull()
    expect(told).toEqual([])

    // The requester chose to move the other work.
    const again = accept("on", id, { work: "writing", estimateMinutes: 30, due, dueSource: { kind: "requester", text: "within the hour" }, makeRoom: true })
    expect(again.status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "in_progress", dueAt: T0 + HOUR })
    expect(store.get(first.id)!.dueAt).toBe(T0 + 150 * MIN)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ to: "owner", id: first.id })
  })

  it("an accept the queue refuses writes nothing: no work, no goal, no goal record (#1920)", () => {
    expect(promise("on", { estimateMinutes: 120, text: "Draft the report" }).status).toBe(200)
    const id = ownerRequest("t1")
    const ensured: string[] = []
    const d = { ...deps("on"), goals: { ensure: (goal: string) => { ensured.push(goal) } } as any }
    const res = handleRequestsApi("POST", "/requests", {
      agentId: "writer", action: "accept", id, work: "writing", estimateMinutes: 30, goal: "launch",
      due: new Date(T0 + HOUR).toISOString(), dueSource: { kind: "requester", text: "within the hour" },
    }, d)
    expect(res.status).toBe(409)
    expect(store.get(id)).toMatchObject({ state: "candidate", work: null, estimateMinutes: null, goal: null })
    expect(ensured).toEqual([])
  })

  it("a requester's time even room cannot meet names both choices", () => {
    expect(promise("on", { estimateMinutes: 60 }).status).toBe(200)
    const id = ownerRequest("t1")
    const res = accept("on", id, { work: "writing", estimateMinutes: 45, due: new Date(T0 + 30 * MIN).toISOString(), dueSource: { kind: "requester", text: "in half an hour" }, makeRoom: true })
    expect(res.status).toBe(409)
    expect((res.body as any).withRoom.meets).toBe(false)
    expect((res.body as any).error).toMatch(/Even with room made it ends 2030-01-14 08:45 UTC/)
  })
})

describe("a due time the agent wrote with no source", () => {
  it("is refused with a plain message when the mode is on", () => {
    const res = promise("on", { estimateMinutes: 20, due: new Date(T0 + 4 * HOUR).toISOString() })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toBe(NO_SOURCE_REFUSAL)
    expect(store.openPromises("writer")).toBe(0)
    const id = ownerRequest("t1")
    expect(accept("on", id, { work: "writing", due: new Date(T0 + 4 * HOUR).toISOString() }).status).toBe(400)
    expect(store.get(id)!.state).toBe("candidate")
  })

  it("in shadow mode, goes through and records the time the daemon would give beside it", () => {
    const res = promise("shadow", { estimateMinutes: 20, due: new Date(T0 + 4 * HOUR).toISOString() })
    expect(res.status).toBe(200)
    const body = res.body as any
    expect(body.request.dueAt).toBe(T0 + 4 * HOUR)
    expect(body.due).toBeUndefined()
    expect(slots.get(body.request.id)).toMatchObject({
      mode: "shadow", source: "agent", agentDue: T0 + 4 * HOUR, computedDue: T0 + 20 * MIN, wouldRefuse: "no source",
    })
    expect(logs.some((l) => /shadow .* would give 2030-01-14 08:20 UTC \(220 min from it; would refuse: no source\)/.test(l))).toBe(true)
  })

  it("in shadow mode, an accept with no due records the daemon's time and sets none", () => {
    const id = ownerRequest("t1")
    expect(accept("shadow", id, { work: "writing", estimateMinutes: 20 }).status).toBe(200)
    expect(store.get(id)!.dueAt).toBeNull()
    expect(slots.get(id)).toMatchObject({ mode: "shadow", source: "daemon", agentDue: null, computedDue: T0 + 20 * MIN, wouldRefuse: null })
  })

  it("off: nothing is recorded and nothing changes", () => {
    const res = promise("off", { estimateMinutes: 20, due: new Date(T0 + 4 * HOUR).toISOString(), priority: "nonsense" })
    expect(res.status).toBe(200)
    expect(slots.get((res.body as any).request.id)).toBeNull()
    expect(store.get((res.body as any).request.id)!.estimateMinutes).toBeNull()
  })
})

describe("a critical job entering the queue", () => {
  it("moves the later due times, and each requester gets one message with the old time, the new time and the reason", () => {
    // Two pieces of work for two different requesters, due times from the daemon.
    const a = promise("on", { estimateMinutes: 60, owedTo: "pm", text: "Review the plan" })
    const b = promise("on", { estimateMinutes: 60, owedTo: "owner", text: "Write the summary" }, T0 + MIN)
    const aId = (a.body as any).request.id
    const bId = (b.body as any).request.id
    // Work not running yet counts its whole estimate: b, a minute later,
    // is due two hours from then.
    expect(store.get(aId)!.dueAt).toBe(T0 + HOUR)
    expect(store.get(bId)!.dueAt).toBe(T0 + MIN + 2 * HOUR)
    // A requester's own time does not move on its own.
    const pinned = promise("on", { estimateMinutes: 10, owedTo: "coder", text: "Send the link", due: new Date(T0 + 8 * HOUR).toISOString(), dueSource: { kind: "requester", text: "by 16:00" } }, T0 + 2 * MIN)
    const pinnedId = (pinned.body as any).request.id

    // Critical is the owner's word (#1919): the owner's request, accepted.
    const crit = accept("on", ownerRequest("t-crit", "writer", "Fix the outage"), { work: "fixing", estimateMinutes: 30, priority: "critical" }, T0 + 5 * MIN)
    expect(crit.status).toBe(200)
    expect((crit.body as any).due).toMatchObject({ dueAt: T0 + 35 * MIN, moved: 2 })
    // Each moves by the 30 minutes the critical job costs it, not by the
    // 5 minutes the clock moved since its time was given.
    expect(store.get(aId)!.dueAt).toBe(T0 + 90 * MIN)
    expect(store.get(bId)!.dueAt).toBe(T0 + 151 * MIN)
    expect(store.get(pinnedId)!.dueAt).toBe(T0 + 8 * HOUR)
    // The wake armed for the old time follows it, and its note says the new time.
    expect(jobs.get(aId)!.wakeAt).toBe(T0 + 90 * MIN)
    expect(jobs.get(aId)!.note).toContain(new Date(T0 + 90 * MIN).toISOString())
    expect(jobs.get(aId)!.note).not.toContain(new Date(T0 + HOUR).toISOString())

    expect(told.map((t) => t.to).sort()).toEqual(["owner", "pm"])
    const toPm = told.find((t) => t.to === "pm")!
    expect(toPm.id).toBe(aId)
    expect(toPm.text).toContain("now due 2030-01-14 09:30 UTC, not 2030-01-14 09:00 UTC")
    expect(told.find((t) => t.to === "owner")!.text).toContain("now due 2030-01-14 10:31 UTC, not 2030-01-14 10:01 UTC")
    expect(toPm.text).toContain('Reason: "Fix the outage"')
    expect(toPm.text).toContain("critical")
  })

  it("a normal job behind them moves nothing", () => {
    promise("on", { estimateMinutes: 60, owedTo: "pm" })
    told = []
    expect((promise("on", { estimateMinutes: 60 }, T0 + MIN).body as any).due.moved).toBe(0)
    expect(told).toEqual([])
  })
})

describe("who may ask for critical (#1919): the owner's words only", () => {
  /** Another agent's work, due from the daemon, on a node that runs one item at a time. */
  function coderWork(mode: DueTimeMode) {
    const res = handleRequestsApi("POST", "/requests", { agentId: "coder", action: "promise", owedTo: "pm", text: "Review the plan", estimateMinutes: 60 }, deps(mode, T0, 1))
    expect(res.status).toBe(200)
    told = []
    return (res.body as any).request.id as string
  }
  const call = (mode: DueTimeMode, body: Record<string, unknown>, now = T0 + MIN) =>
    handleRequestsApi("POST", "/requests", { agentId: "writer", ...body }, deps(mode, now, 1))

  it("on: an agent's own critical promise is refused, and another agent's due time does not move", () => {
    const coderId = coderWork("on")
    expect(store.get(coderId)!.dueAt).toBe(T0 + HOUR)
    const res = call("on", { action: "promise", owedTo: "owner", text: "Fix my thing", estimateMinutes: 30, priority: "critical" })
    expect(res.status).toBe(403)
    expect((res.body as any).error).toMatch(/critical is only for the owner's requests/)
    expect((res.body as any).error).toMatch(/high/)
    expect(store.openPromises("writer")).toBe(0)
    expect(store.get(coderId)!.dueAt).toBe(T0 + HOUR)
    expect(slots.get(coderId)).toMatchObject({ givenDue: T0 + HOUR })
    expect(told).toEqual([])
  })

  it("on: critical on an accept of the agent's own promise is refused too", () => {
    const coderId = coderWork("on")
    const own = call("on", { action: "promise", owedTo: "owner", text: "Fix my thing", estimateMinutes: 30 })
    expect(own.status).toBe(200)
    const res = call("on", { action: "accept", id: (own.body as any).request.id, priority: "critical" })
    expect(res.status).toBe(403)
    expect(store.get(coderId)!.dueAt).toBe(T0 + HOUR)
    expect(told).toEqual([])
  })

  it("on: the owner's request accepted as critical still goes ahead and moves the other agent's due time", () => {
    const coderId = coderWork("on")
    const id = ownerRequest("t-crit", "writer", "Fix the outage")
    const res = call("on", { action: "accept", id, work: "fixing", estimateMinutes: 30, priority: "critical" })
    expect(res.status).toBe(200)
    expect((res.body as any).due).toMatchObject({ dueAt: T0 + 31 * MIN, moved: 1, inputs: { priority: "critical" } })
    expect(store.get(coderId)!.dueAt).toBe(T0 + 90 * MIN)
    expect(told).toEqual([expect.objectContaining({ to: "pm", id: coderId })])
  })

  it("shadow: an agent's own critical counts as high, and the row and log say critical was asked and lowered", () => {
    const res = call("shadow", { action: "promise", owedTo: "owner", text: "Fix my thing", estimateMinutes: 30, priority: "critical" })
    expect(res.status).toBe(200)
    const id = (res.body as any).request.id
    expect(slots.get(id)).toMatchObject({ priority: "high", wouldRefuse: expect.stringMatching(/critical asked, lowered to high/) })
    expect(logs.some((l) => l.includes(id) && /critical asked, lowered to high/.test(l))).toBe(true)
    expect(dueReport(db, { since: T0 - HOUR, now: T0 + MIN, factorDays: 30, factorMinRows: 3 }).agents[0]).toMatchObject({ criticalLowered: 1, invalid: 0 })
  })

  it("shadow: the owner's request keeps critical, with no note", () => {
    const id = ownerRequest("t-crit", "writer", "Fix the outage")
    expect(call("shadow", { action: "accept", id, work: "fixing", estimateMinutes: 30, priority: "critical" }).status).toBe(200)
    expect(slots.get(id)).toMatchObject({ priority: "critical", wouldRefuse: null })
  })

  it("off: an agent's critical goes through as before, nothing recorded", () => {
    const res = call("off", { action: "promise", owedTo: "owner", text: "Fix my thing", estimateMinutes: 30, priority: "critical" })
    expect(res.status).toBe(200)
    expect(slots.get((res.body as any).request.id)).toBeNull()
  })
})

describe("the correction factor", () => {
  /** A closed row: estimated `est` minutes, open `open` minutes from ask
   *  to close, and a linked run of `run` minutes when given. */
  function closed(agent: string, est: number, open: number, i: number, run?: number) {
    const id = `done-${agent}-${i}`
    db.prepare(
      `INSERT INTO requests (id, state, channel, chat_id, agent_id, text, created_at, updated_at, closed_at, estimate_minutes, first_estimate_minutes, work)
       VALUES (?, 'done', 'telegram', 'c', ?, 'x', ?, ?, ?, ?, ?, 'writing')`,
    ).run(id, agent, T0 - 2 * HOUR - open * MIN, T0 - 2 * HOUR, T0 - 2 * HOUR, est, est)
    if (run !== undefined) {
      db.exec("CREATE TABLE IF NOT EXISTS task_traces (task_id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER)")
      store.link(id, "run", `run-${id}`, T0)
      db.prepare("INSERT INTO task_traces VALUES (?, ?, ?)").run(`run-${id}`, T0 - 3 * HOUR, T0 - 3 * HOUR + run * MIN)
    }
  }

  it("comes from the agent's own past rows, estimate against real time", () => {
    closed("writer", 20, 30, 1, 30)
    closed("writer", 10, 15, 2, 15)
    closed("writer", 40, 60, 3, 60)
    closed("coder", 30, 30, 1, 30)
    const all = correctionFactors(db, { now: T0, days: 30, minRows: 3 })
    expect(all).toEqual([
      { agentId: "coder", factor: 1, rows: 1, measured: false },
      { agentId: "writer", factor: 1.5, rows: 3, measured: true },
    ])
    // And it is applied to the next due time.
    const res = promise("on", { estimateMinutes: 20 })
    expect((res.body as any).due).toMatchObject({ dueAt: T0 + 30 * MIN, inputs: { factor: 1.5 } })
  })

  it("a run's real time is the time its linked runs took", () => {
    for (const i of [1, 2, 3]) closed("writer", 10, 600, i, 20)
    expect(correctionFactors(db, { now: T0, days: 30, minRows: 3 })[0]).toMatchObject({ agentId: "writer", factor: 2, rows: 3 })
  })

  it("rows with no run time kept do not count: ask-to-close time (nights, waits) would pin the agent at the cap", () => {
    // Ten rows open for a day each, estimated 30 minutes, no run kept:
    // start to close would read as x48, clamped to x8.
    for (let i = 1; i <= 10; i++) closed("writer", 30, 24 * 60, i)
    closed("writer", 30, 24 * 60, 11, 30)
    const ctx = dueTimesCtx(db, { ...DEFAULT_DUE_TIME_SETTINGS, mode: "on" }, { capacity: 4, lanes: () => 1, now: () => T0 }, slots)
    expect(ctx.factor("writer")).toEqual({ agentId: "writer", factor: 1, rows: 1, measured: false })
    // Nor do they make the usual minutes of the work.
    expect(ctx.usual("writer", "writing")).toBeNull()
    expect((promise("on", { estimateMinutes: 20 }).body as any).due.dueAt).toBe(T0 + 20 * MIN)
  })

  it("a cache shared by the daemon keeps the rows for a minute across calls (#1920)", () => {
    // The daemon builds a context per call: the rows must outlive it.
    let now = T0
    const estimates = new EstimateCache()
    const ctxOf = () => dueTimesCtx(db, { ...DEFAULT_DUE_TIME_SETTINGS, mode: "shadow" }, { capacity: 4, lanes: () => 1, now: () => now, estimates }, slots)
    expect(ctxOf().factor("writer")).toMatchObject({ factor: 1, measured: false })
    for (const i of [1, 2, 3]) closed("writer", 10, 30, i, 20)
    // A new context within the minute: the kept rows, no new read.
    now = T0 + 30_000
    expect(ctxOf().factor("writer")).toMatchObject({ factor: 1, measured: false })
    // After the minute: read again.
    now = T0 + 61_000
    expect(ctxOf().factor("writer")).toMatchObject({ factor: 2, measured: true })
  })
})

describe("a queue that reads like the node's real work", () => {
  /** An open job row of the ledger, last touched `touched` ms ago. */
  function openJob(id: string, minutes: number, touched: number, extra: { jobState?: string; wakeAt?: number } = {}) {
    db.prepare(
      `INSERT INTO requests (id, state, channel, chat_id, agent_id, text, created_at, updated_at, estimate_minutes, job_state, wake_at)
       VALUES (?, 'in_progress', 'telegram', 'c', 'writer', 'old work', ?, ?, ?, ?, ?)`,
    ).run(id, T0 - touched - HOUR, T0 - touched, minutes, extra.jobState ?? null, extra.wakeAt ?? null)
  }

  it("100 rows nobody touched for days do not push a fresh 20-minute job hours out", () => {
    for (let i = 0; i < 100; i++) openJob(`stale-${i}`, 60, 3 * 24 * HOUR)
    const res = promise("on", { estimateMinutes: 20 })
    expect((res.body as any).due).toMatchObject({ dueAt: T0 + 20 * MIN, inputs: { queueLength: 0 } })
  })

  it("a stale row with a wake ahead still counts, from that wake", () => {
    openJob("later", 60, 3 * 24 * HOUR, { jobState: "continue", wakeAt: T0 + 2 * HOUR })
    expect(slots.queue({ now: T0, staleAfterMs: 24 * HOUR })).toEqual([expect.objectContaining({ id: "later", notBefore: T0 + 2 * HOUR })])
    // It waits for its wake, so a job ready now is not put behind it.
    expect((promise("on", { estimateMinutes: 20 }).body as any).due.dueAt).toBe(T0 + 20 * MIN)
    const plan = schedule([
      { id: "later", agentId: "writer", priority: "normal", estimateMinutes: 60, createdAt: T0 - HOUR, dueAt: null, requester: null, notBefore: T0 + 2 * HOUR },
    ], { now: T0, capacity: 4, lanes: () => 1, factor: () => 1, defaultMinutes: () => 30 })
    expect(plan.get("later")).toMatchObject({ startAt: T0 + 2 * HOUR, endAt: T0 + 3 * HOUR })
  })

  it("a running job counts what is left of it, never under 5 minutes", () => {
    openJob("running", 60, 0, { jobState: "working" })
    store.link("running", "run", "run-now", T0 - 45 * MIN)
    expect((promise("on", { estimateMinutes: 20 }).body as any).due).toMatchObject({ dueAt: T0 + 35 * MIN, inputs: { queueMinutes: 15 } })
    // Past its estimate: 5 minutes left, not a negative time.
    db.prepare("UPDATE request_links SET at = ? WHERE ref = 'run-now'").run(T0 - 3 * HOUR)
    expect(schedule(slots.queue({ now: T0, staleAfterMs: 24 * HOUR }).filter((q) => q.id === "running"), {
      now: T0, capacity: 4, lanes: () => 1, factor: () => 1, defaultMinutes: () => 30,
    }).get("running")).toMatchObject({ minutes: 5, endAt: T0 + 5 * MIN })
  })

  it("an old request accepted now queues from its accept, behind work accepted before it", () => {
    const old = ownerRequest("old-ask")
    db.prepare("UPDATE requests SET created_at = ? WHERE id = ?").run(T0 - 6 * HOUR, old)
    const first = promise("on", { estimateMinutes: 60, owedTo: "pm", text: "Review the plan" })
    told = []
    const res = accept("on", old, { work: "writing", estimateMinutes: 20 }, T0 + MIN)
    expect((res.body as any).due).toMatchObject({ dueAt: T0 + MIN + 80 * MIN, moved: 0 })
    expect(store.get((first.body as any).request.id)!.dueAt).toBe(T0 + HOUR)
    expect(told).toEqual([])
  })
})

describe("telling a requester that their due time moved", () => {
  it("skips moves under 15 minutes", () => {
    const a = promise("on", { estimateMinutes: 60, owedTo: "pm", text: "Review the plan" })
    told = []
    expect(accept("on", ownerRequest("t-small", "writer", "Small fix"), { work: "fixing", estimateMinutes: 10, priority: "critical" }, T0 + MIN).status).toBe(200)
    expect(store.get((a.body as any).request.id)!.dueAt).toBe(T0 + HOUR)
    expect(told).toEqual([])
  })

  it("tells at most once an hour, and the held move is told later from the oldest time", () => {
    const a = promise("on", { estimateMinutes: 60, owedTo: "pm", text: "Review the plan" })
    const aId = (a.body as any).request.id
    told = []
    expect(accept("on", ownerRequest("t-one", "writer", "Fix one"), { work: "fixing", estimateMinutes: 30, priority: "critical" }, T0 + MIN).status).toBe(200)
    expect(accept("on", ownerRequest("t-two", "writer", "Fix two"), { work: "fixing", estimateMinutes: 30, priority: "critical" }, T0 + 10 * MIN).status).toBe(200)
    expect(told.filter((t) => t.id === aId)).toHaveLength(1)
    expect(told[0].text).toContain("now due 2030-01-14 09:30 UTC, not 2030-01-14 09:00 UTC")
    expect(store.get(aId)!.dueAt).toBe(T0 + 2 * HOUR)
    // An hour on, the next call tells the held move: from the oldest time
    // not told yet to the latest.
    told = []
    promise("on", { estimateMinutes: 5, priority: "low", text: "Later" }, T0 + 2 * HOUR)
    expect(told).toEqual([expect.objectContaining({ to: "pm", id: aId })])
    expect(told[0].text).toContain("now due 2030-01-14 10:00 UTC, not 2030-01-14 09:30 UTC")
  })
})

describe("shadow never changes a reply (#1909 review)", () => {
  /** Runs `call` on a fresh database in `mode`: its reply and every
   *  requests row, with ids made stable. */
  function run(mode: DueTimeMode, call: (d: RequestsApiDeps, t: RequestTracker) => { status: number; body: unknown }) {
    const dir = mkdtempSync(path.join(tmpdir(), "agentx-due-shadow-"))
    const d = new Database(path.join(dir, "db.sqlite"))
    try {
      const st = new RequestStore(d)
      new JobStore(d)
      const tr = new RequestTracker(st, () => settings, () => {}, () => T0)
      const deps: RequestsApiDeps = {
        store: st, tracker: tr, enabled: true, now: T0,
        hasAgent: (id) => ["writer", "coder", "pm"].includes(id),
        runningTurn: (agentId) => ({ channel: "telegram", chatId: `chat-${agentId}` }),
        dueTimes: dueTimesCtx(d, { ...DEFAULT_DUE_TIME_SETTINGS, mode }, { capacity: 4, lanes: () => 1, now: () => T0 }),
      }
      const reply = call(deps, tr)
      const rows = d.prepare("SELECT * FROM requests ORDER BY created_at, id").all()
      const hasSlots = !!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'due_slots'").get()
      const slotRows = hasSlots ? d.prepare("SELECT * FROM due_slots").all() : []
      const stable = (x: unknown) => JSON.parse(JSON.stringify(x).replace(/prm-[a-z0-9]+-[0-9a-f]{6}/g, "ID"))
      return { reply: stable(reply), rows: stable(rows), slotRows: slotRows as any[], hasSlots }
    } finally {
      d.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const bad: Array<Record<string, unknown>> = [
    { priority: "urgent" },
    { priority: 3 },
    { priority: "critical" },
    { dueSource: "the owner said so", due: new Date(T0 + 4 * HOUR).toISOString() },
    { dueSource: { kind: "boss", text: "x" } },
    { makeRoom: "yes" },
    { work: "Big Work!" },
    { estimateMinutes: "soon" },
    { estimateMinutes: 50_000 },
    { estimateMinutes: 1e20 },
  ]

  for (const fields of bad) {
    it(`a promise with ${JSON.stringify(fields)}: the same reply and rows as off`, () => {
      const call = (d: RequestsApiDeps) => handleRequestsApi("POST", "/requests", { agentId: "writer", action: "promise", owedTo: "owner", text: "Write the summary", ...fields }, d)
      const off = run("off", call)
      const shadow = run("shadow", call)
      expect(shadow.reply).toEqual(off.reply)
      expect(shadow.rows).toEqual(off.rows)
      // Off never makes the table; shadow notes the call on its slot row.
      expect(off.hasSlots).toBe(false)
      if (off.reply.status === 200) expect(shadow.slotRows).toHaveLength(1)
    })

    it(`an accept with ${JSON.stringify(fields)}: the same reply and rows as off`, () => {
      const call = (d: RequestsApiDeps, tr: RequestTracker) => {
        tr.taskStarted({
          agentId: "writer", channel: "telegram", chatId: "chat-writer", taskId: "t1", messagePreview: "Send the offer", fullMessage: "Send the offer",
          at: "", humanRoot: true, sender: { id: "4242" },
        } as any)
        return handleRequestsApi("POST", "/requests", { agentId: "writer", action: "accept", id: "req-t1", work: "writing", ...fields }, d)
      }
      const off = run("off", call)
      const shadow = run("shadow", call)
      expect(shadow.reply).toEqual(off.reply)
      expect(shadow.rows).toEqual(off.rows)
    })
  }

  it("on refuses the same fields with a plain 400, and an estimate over a week", () => {
    expect(promise("on", { priority: "urgent" }).status).toBe(400)
    expect(promise("on", { dueSource: "the owner said so", due: new Date(T0 + 4 * HOUR).toISOString() }).status).toBe(400)
    expect(promise("on", { estimateMinutes: 50_000 })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/at most 10080/) } })
    expect(promise("on", { estimateMinutes: 1e20, due: new Date(T0 + HOUR).toISOString() }).status).toBe(400)
    expect(store.openPromises("writer")).toBe(0)
    const id = ownerRequest("t1")
    expect(accept("on", id, { work: "writing", estimateMinutes: 50_000 }).status).toBe(400)
    expect(store.get(id)).toMatchObject({ state: "candidate", estimateMinutes: null })
  })

  it("the shadow row names what on would have refused", () => {
    const res = promise("shadow", { priority: "urgent", estimateMinutes: 20 })
    expect(slots.get((res.body as any).request.id)).toMatchObject({ priority: "normal", wouldRefuse: expect.stringMatching(/^invalid: priority must be one of/) })
    expect(dueReport(db, { since: T0 - HOUR, now: T0, factorDays: 30, factorMinRows: 3 }).agents[0]).toMatchObject({ invalid: 1 })
  })

  it("a huge estimate already on the ledger cannot make a time out of range", () => {
    db.prepare(
      `INSERT INTO requests (id, state, channel, chat_id, agent_id, text, created_at, updated_at, estimate_minutes)
       VALUES ('huge', 'in_progress', 'telegram', 'c', 'writer', 'x', ?, ?, 1e20)`,
    ).run(T0 - HOUR, T0)
    const res = promise("on", { estimateMinutes: 20, due: new Date(T0 + HOUR).toISOString() })
    expect(res.status).toBe(400)
    expect((res.body as any).wouldGive).toBe(new Date(T0 + 7 * 24 * HOUR + 20 * MIN).toISOString())
  })
})

describe("the shadow report (agentx requests contract)", () => {
  it("gives each agent's rows, the median gap to the daemon's time, and what the refusal would stop", () => {
    promise("shadow", { estimateMinutes: 20, due: new Date(T0 + 4 * HOUR).toISOString() })
    promise("shadow", { estimateMinutes: 20, due: new Date(T0 + 2 * HOUR).toISOString(), dueSource: { kind: "fact", text: "the 10:00 posting slot" } })
    promise("shadow", { estimateMinutes: 20 })
    const r = dueReport(db, { since: T0 - HOUR, now: T0, factorDays: 30, factorMinRows: 3 })
    expect(r.rows).toBe(3)
    expect(r.agents).toEqual([expect.objectContaining({
      agentId: "writer", rows: 3, written: 2, noSource: 1, doesNotFit: 0, invalid: 0,
      factor: { agentId: "writer", factor: 1, rows: 0, measured: false },
    })])
    // Gaps: 4 h against 20 min, and 2 h against 40 min (behind the first).
    expect(r.agents[0].medianGapMinutes).toBe(Math.round(((240 - 20) + (120 - 40)) / 2))
  })
})
