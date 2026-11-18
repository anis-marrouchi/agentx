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
import { correctionFactors } from "../src/requests/estimates"

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
    const first = slots.queue()[0]
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
    // Open work counts its whole estimate until it closes: b, a minute
    // later, is due two hours from then.
    expect(store.get(aId)!.dueAt).toBe(T0 + HOUR)
    expect(store.get(bId)!.dueAt).toBe(T0 + MIN + 2 * HOUR)
    // A requester's own time does not move on its own.
    const pinned = promise("on", { estimateMinutes: 10, owedTo: "coder", text: "Send the link", due: new Date(T0 + 8 * HOUR).toISOString(), dueSource: { kind: "requester", text: "by 16:00" } }, T0 + 2 * MIN)
    const pinnedId = (pinned.body as any).request.id

    const crit = promise("on", { estimateMinutes: 30, priority: "critical", owedTo: "owner", text: "Fix the outage" }, T0 + 5 * MIN)
    expect(crit.status).toBe(200)
    expect((crit.body as any).due).toMatchObject({ dueAt: T0 + 35 * MIN, moved: 2 })
    expect(store.get(aId)!.dueAt).toBe(T0 + 95 * MIN)
    expect(store.get(bId)!.dueAt).toBe(T0 + 155 * MIN)
    expect(store.get(pinnedId)!.dueAt).toBe(T0 + 8 * HOUR)
    // The wake armed for the old time follows it.
    expect(jobs.get(aId)!.wakeAt).toBe(T0 + 95 * MIN)

    expect(told.map((t) => t.to).sort()).toEqual(["owner", "pm"])
    const toPm = told.find((t) => t.to === "pm")!
    expect(toPm.id).toBe(aId)
    expect(toPm.text).toContain("now due 2030-01-14 09:35 UTC, not 2030-01-14 09:00 UTC")
    expect(told.find((t) => t.to === "owner")!.text).toContain("now due 2030-01-14 10:35 UTC, not 2030-01-14 10:01 UTC")
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

describe("the correction factor", () => {
  /** A closed row: estimated `est` minutes, really `real` minutes. */
  function closed(agent: string, est: number, real: number, i: number) {
    const id = `done-${agent}-${i}`
    db.prepare(
      `INSERT INTO requests (id, state, channel, chat_id, agent_id, text, created_at, updated_at, closed_at, estimate_minutes, first_estimate_minutes, work)
       VALUES (?, 'done', 'telegram', 'c', ?, 'x', ?, ?, ?, ?, ?, 'writing')`,
    ).run(id, agent, T0 - 2 * HOUR - real * MIN, T0 - 2 * HOUR, T0 - 2 * HOUR, est, est)
  }

  it("comes from the agent's own past rows, estimate against real time", () => {
    closed("writer", 20, 30, 1)
    closed("writer", 10, 15, 2)
    closed("writer", 40, 60, 3)
    closed("coder", 30, 30, 1)
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
    db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER)")
    for (const i of [1, 2, 3]) {
      closed("writer", 10, 600, i)
      store.link(`done-writer-${i}`, "run", `run-${i}`, T0)
      db.prepare("INSERT INTO task_traces VALUES (?, ?, ?)").run(`run-${i}`, T0 - 3 * HOUR, T0 - 3 * HOUR + 20 * MIN)
    }
    expect(correctionFactors(db, { now: T0, days: 30, minRows: 3 })[0]).toMatchObject({ agentId: "writer", factor: 2, rows: 3 })
  })
})
