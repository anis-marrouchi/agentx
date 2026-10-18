import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const hoisted = vi.hoisted(() => ({ askSeat: vi.fn() }))
vi.mock("../src/decisions/seat", () => ({ askSeat: hoisted.askSeat }))

import { WatcherStore } from "../src/watchers/store"
import {
  DEFAULT_WATCHER_SETTINGS, TaskWatcher, askTaskWatchSeat, delegationIdOf, delegatorOf, parseDueAt, watchFields,
  type SeatAnswer, type WatcherSettings,
} from "../src/watchers/watcher"
import { attachWatchers } from "../src/watchers/attach"
import { getEventBus } from "../src/events/bus"
import { watchersConfigSchema } from "../src/daemon/config"

const T0 = Date.parse("2026-10-18T08:00:00Z")
const MIN = 60_000
const flush = () => new Promise((r) => setTimeout(r, 0))

let dir: string
let db: Database.Database
let store: WatcherStore
let clock: number
let settings: WatcherSettings
let answer: SeatAnswer | null
let alertAgent: ReturnType<typeof vi.fn>
let alertOwner: ReturnType<typeof vi.fn>
let steps: Array<{ taskId: string; summary: string }>

function makeWatcher(extra: Partial<ConstructorParameters<typeof TaskWatcher>[0]> = {}): TaskWatcher {
  return new TaskWatcher({
    store,
    settings: () => settings,
    log: () => {},
    decide: async () => answer,
    alertAgent,
    alertOwner,
    traceStep: (taskId, _agent, summary) => steps.push({ taskId, summary }),
    now: () => clock,
    ...extra,
  })
}

const started = (over: Record<string, unknown> = {}) => ({
  agentId: "worker",
  channel: "mcp",
  chatId: "mcp:lead:worker:1",
  messagePreview: "Publish the approved video at 18:00",
  fullMessage: "Publish the approved video at 18:00",
  at: new Date(clock).toISOString(),
  taskId: "trace-1",
  sender: { name: "agent:lead" },
  ...over,
}) as any

const completed = (over: Record<string, unknown> = {}) => ({
  taskId: "trace-1", agentId: "worker", channel: "mcp", chatId: "mcp:lead:worker:1", durationMs: 1000,
  at: new Date(clock).toISOString(), ...over,
}) as any

const delegation = (over: Record<string, unknown> = {}) => ({
  id: "dlg-abc123-0a1b2c3d",
  caller: "lead",
  callee: "worker",
  request: "Publish the approved video at 18:00",
  origin: { channel: "telegram", chatId: "chat-1" },
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-watchers-"))
  db = new Database(join(dir, "test.db"))
  store = new WatcherStore(db)
  clock = T0
  settings = { ...DEFAULT_WATCHER_SETTINGS, enabled: true }
  answer = null
  alertAgent = vi.fn(async () => {})
  alertOwner = vi.fn(async () => {})
  steps = []
  hoisted.askSeat.mockReset()
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("helpers", () => {
  it("reads due times, delegators and delegation ids", () => {
    expect(parseDueAt("2026-10-18T18:00:00Z")).toBe(Date.parse("2026-10-18T18:00:00Z"))
    expect(parseDueAt(T0)).toBe(T0)
    expect(parseDueAt("not a date")).toBeNull()
    expect(parseDueAt(undefined)).toBeNull()
    expect(delegatorOf({ name: "agent:lead" })).toBe("lead")
    expect(delegatorOf({ name: "Sam" })).toBeNull()
    expect(delegationIdOf("a2a:lead:worker:dlg-abc123-0a1b2c3d")).toBe("dlg-abc123-0a1b2c3d")
    expect(delegationIdOf("telegram-chat")).toBeNull()
  })

  it("puts the due time and delegation id on task:started", () => {
    expect(watchFields({ dueAt: "2026-10-18T18:00:00Z" })).toEqual({ dueAt: "2026-10-18T18:00:00.000Z" })
    expect(watchFields({ context: { dueAt: T0, delegationId: "dlg-x-1" } })).toEqual({ dueAt: new Date(T0).toISOString(), delegationId: "dlg-x-1" })
    expect(watchFields({ context: { delegationId: "not-a-delegation" } })).toEqual({})
    expect(watchFields({})).toEqual({})
  })

  it("is off by default and validates its thresholds", () => {
    const cfg = watchersConfigSchema.parse({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.sources).toEqual(["dispatch", "delegation", "cron"])
    expect(cfg.skipBelow).toBe(0.2)
    expect(watchersConfigSchema.safeParse({ skipBelow: 0.8, attachAbove: 0.5 }).success).toBe(false)
  })
})

describe("checkpoint", () => {
  it("attaches exactly one watcher to a delegated task with a due time and records it", async () => {
    const w = makeWatcher()
    answer = { probability: 0.91, mode: "active", callId: "call-1" }
    const due = T0 + 60 * MIN
    await w.delegationStarted({ ...delegation(), dueAt: due })
    // The delegated run reports the same delegation: no second watcher.
    await w.taskStarted(started({ channel: "a2a", chatId: "custom-chat", delegationId: "dlg-abc123-0a1b2c3d", dueAt: new Date(due).toISOString() }))

    const live = store.listLive()
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ taskKey: "dlg-abc123-0a1b2c3d", source: "delegation", delegator: "lead", dueAt: due, status: "armed" })

    const audit = store.checkpoints("dlg-abc123-0a1b2c3d")
    expect(audit.map((c) => c.decision)).toEqual(["attach", "existing"])
    expect(audit[0]).toMatchObject({ probability: 0.91, seatMode: "active", callId: "call-1", watcherId: live[0].id })
    expect(audit[1]).toMatchObject({ watcherId: live[0].id, existingKind: "watcher" })
    // The run's trace shows the decision.
    expect(steps).toEqual([{ taskId: "trace-1", summary: expect.stringContaining(`existing p=n/a watcher=${live[0].id}`) }])
  })

  it("never creates a second watcher for a task that already has one", async () => {
    const w = makeWatcher()
    const first = await w.checkpoint({ taskKey: "t-1", source: "dispatch", agentId: "worker", message: "x", delegator: "lead" })
    const second = await w.checkpoint({ taskKey: "t-1", source: "dispatch", agentId: "worker", message: "x", delegator: "lead" })
    expect(first?.decision).toBe("attach")
    expect(second).toMatchObject({ decision: "existing", watcherId: first?.watcherId })
    expect(store.listLive()).toHaveLength(1)
  })

  it("counts another mechanism's watcher and does not ask the seat", async () => {
    const decide = vi.fn(async () => answer)
    const w = makeWatcher({ decide, lookups: [(i) => (i.taskKey === "t-2" ? { kind: "request", id: "req-9" } : null)] })
    const r = await w.checkpoint({ taskKey: "t-2", source: "dispatch", agentId: "worker", message: "x", delegator: "lead" })
    expect(r).toMatchObject({ decision: "existing", watcherId: "req-9" })
    expect(decide).not.toHaveBeenCalled()
    expect(store.listLive()).toHaveLength(0)
    expect(store.checkpoints("t-2")[0]).toMatchObject({ existingKind: "request" })
  })

  it("attaches on an uncertain decision (fail-safe)", async () => {
    const w = makeWatcher()
    answer = { probability: 0.45, mode: "active", callId: "c" }
    const r = await w.checkpoint({ taskKey: "t-3", source: "cron", agentId: "worker", message: "daily report" })
    expect(r?.decision).toBe("attach")
    expect(r?.reason).toMatch(/uncertain/)
  })

  it("attaches when the seat is off, unreachable or only shadowing", async () => {
    const w = makeWatcher()
    answer = null
    expect((await w.checkpoint({ taskKey: "t-4", source: "cron", agentId: "worker", message: "x" }))?.decision).toBe("attach")
    answer = { probability: 0.01, mode: "shadow", callId: "c" }
    expect((await w.checkpoint({ taskKey: "t-5", source: "cron", agentId: "worker", message: "x" }))?.decision).toBe("attach")
    const throwing = makeWatcher({ decide: async () => { throw new Error("down") } })
    expect((await throwing.checkpoint({ taskKey: "t-6", source: "cron", agentId: "worker", message: "x" }))?.decision).toBe("attach")
  })

  it("skips only on a confident no from an active seat, and records it", async () => {
    const w = makeWatcher()
    answer = { probability: 0.05, mode: "active", callId: "c" }
    const r = await w.checkpoint({ taskKey: "t-7", source: "cron", agentId: "worker", message: "heartbeat" })
    expect(r).toMatchObject({ decision: "skip", probability: 0.05, watcherId: null })
    expect(store.listLive()).toHaveLength(0)
    expect(store.checkpoints("t-7")[0]).toMatchObject({ decision: "skip", probability: 0.05 })
  })

  it("always watches a task with a due time or a delegator, whatever the seat says", async () => {
    const w = makeWatcher()
    answer = { probability: 0.01, mode: "active", callId: "c" }
    expect((await w.checkpoint({ taskKey: "t-8", source: "dispatch", agentId: "worker", message: "x", dueAt: T0 + MIN }))?.decision).toBe("attach")
    expect((await w.checkpoint({ taskKey: "t-9", source: "dispatch", agentId: "worker", message: "x", delegator: "lead" }))?.decision).toBe("attach")
  })

  it("does nothing when off or for a source that is not listed", async () => {
    settings = { ...settings, enabled: false }
    const w = makeWatcher()
    expect(await w.checkpoint({ taskKey: "t-10", source: "cron", agentId: "worker", message: "x" })).toBeUndefined()
    settings = { ...settings, enabled: true, sources: ["delegation"] }
    expect(await w.checkpoint({ taskKey: "t-11", source: "cron", agentId: "worker", message: "x" })).toBeUndefined()
    expect(store.listLive()).toHaveLength(0)
  })

  it("leaves a person's own chat turn alone unless its channel is listed", async () => {
    const w = makeWatcher()
    await w.taskStarted(started({ sender: { name: "Sam" }, channel: "telegram" }))
    expect(store.listLive()).toHaveLength(0)
    settings = { ...settings, dispatchChannels: ["telegram"] }
    await w.taskStarted(started({ sender: { name: "Sam" }, channel: "telegram", taskId: "trace-2" }))
    expect(store.listLive()).toHaveLength(1)
  })
})

describe("firing", () => {
  it("alerts the delegator when the owning chat ends with no result before the due time", async () => {
    const w = makeWatcher()
    await w.taskStarted(started({ dueAt: new Date(T0 + 60 * MIN).toISOString() }))
    clock = T0 + 10 * MIN
    await w.taskCompleted(completed({ error: "session ended" }))
    expect(alertAgent).toHaveBeenCalledTimes(1)
    expect(alertAgent.mock.calls[0][0]).toBe("lead")
    expect(alertAgent.mock.calls[0][1]).toMatch(/ended with an error: session ended/)
    expect(alertOwner).not.toHaveBeenCalled()
    expect(store.listLive()[0]).toMatchObject({ status: "fired" })
  })

  it("treats an empty answer as no result", async () => {
    const w = makeWatcher()
    await w.taskStarted(started())
    await w.taskCompleted(completed({ finalResponse: "  " }))
    expect(alertAgent).toHaveBeenCalledTimes(1)
    expect(alertAgent.mock.calls[0][1]).toMatch(/no result/)
  })

  it("is done when the run ends with a result, and never fires afterwards", async () => {
    const w = makeWatcher()
    await w.taskStarted(started({ dueAt: new Date(T0 + 60 * MIN).toISOString() }))
    await w.taskCompleted(completed({ finalResponse: "Published." }))
    clock = T0 + 120 * MIN
    await w.sweep()
    expect(alertAgent).not.toHaveBeenCalled()
    expect(store.listLive()).toHaveLength(0)
  })

  it("leaves a run cut by a shutdown armed", async () => {
    const w = makeWatcher()
    await w.taskStarted(started())
    await w.taskCompleted(completed({ error: "shutdown", interrupted: true }))
    expect(alertAgent).not.toHaveBeenCalled()
    expect(store.listLive()[0].status).toBe("armed")
  })

  it("hands a cut-off run's watcher to the run that resumes it", async () => {
    const w = makeWatcher()
    await w.taskStarted(started())
    await w.taskCompleted(completed({ error: "shutdown", interrupted: true }))
    await w.taskStarted(started({ taskId: "trace-2", resumedFrom: "trace-1" }))
    expect(store.listLive()).toHaveLength(1)
    await w.taskCompleted(completed({ taskId: "trace-2", finalResponse: "Published." }))
    expect(store.listLive()).toHaveLength(0)
    expect(alertAgent).not.toHaveBeenCalled()
  })

  it("waits for a checkpoint still in flight before handling the run's end", async () => {
    let release!: (a: SeatAnswer | null) => void
    const w = makeWatcher({ decide: () => new Promise((r) => { release = r }) })
    settings = { ...settings, dispatchChannels: ["cron-like"] }
    const start = w.taskStarted(started({ sender: undefined, channel: "cron-like" }))
    const end = w.taskCompleted(completed({ channel: "cron-like", finalResponse: "done" }))
    release(null)
    await Promise.all([start, end])
    expect(store.listLive()).toHaveLength(0)
  })

  it("fires when the due time passes, then escalates to the owner", async () => {
    const w = makeWatcher()
    await w.delegationStarted({ ...delegation(), dueAt: T0 + 60 * MIN })
    clock = T0 + 59 * MIN
    await w.sweep()
    expect(alertAgent).not.toHaveBeenCalled()

    clock = T0 + 61 * MIN
    await w.sweep()
    expect(alertAgent).toHaveBeenCalledTimes(1)
    expect(alertAgent.mock.calls[0][1]).toMatch(/due time .* passed/)
    await w.sweep()
    expect(alertAgent).toHaveBeenCalledTimes(1)

    clock = T0 + 61 * MIN + settings.escalateAfterMinutes * MIN
    await w.sweep()
    expect(alertOwner).toHaveBeenCalledTimes(1)
    expect(alertOwner.mock.calls[0][1]).toMatch(/lead was told/)
    expect(store.listLive()).toHaveLength(0)
    await w.sweep()
    expect(alertOwner).toHaveBeenCalledTimes(1)
  })

  it("does not escalate once a done signal arrives after the first alert", async () => {
    const w = makeWatcher()
    await w.delegationStarted({ ...delegation(), dueAt: T0 + MIN })
    clock = T0 + 2 * MIN
    await w.sweep()
    await w.delegationDone(delegation(), "done", "Published at 18:02")
    clock += settings.escalateAfterMinutes * MIN
    await w.sweep()
    expect(alertOwner).not.toHaveBeenCalled()
  })

  it("fires once when a delegation fails, whichever signal comes first", async () => {
    const w = makeWatcher()
    await w.delegationStarted(delegation())
    await w.taskStarted(started({ channel: "a2a", chatId: "a2a:lead:worker:dlg-abc123-0a1b2c3d" }))
    await w.taskCompleted(completed({ error: "timed out" }))
    await w.delegationDone(delegation(), "timeout", "No answer from worker after 30 minute(s).")
    expect(alertAgent).toHaveBeenCalledTimes(1)
  })

  it("alerts the owner directly when nobody delegated the task", async () => {
    const w = makeWatcher()
    await w.taskStarted(started({ channel: "cron", chatId: "cron:daily", sender: undefined }))
    await w.taskCompleted(completed({ channel: "cron", error: "boom" }))
    expect(alertAgent).not.toHaveBeenCalled()
    expect(alertOwner).toHaveBeenCalledTimes(1)
    expect(store.listLive()).toHaveLength(0)
  })

  it("fires a watcher with no due time that stays quiet too long", async () => {
    const w = makeWatcher()
    await w.delegationStarted(delegation())
    clock = T0 + settings.quietAfterHours * 3_600_000
    await w.sweep()
    expect(alertAgent).toHaveBeenCalledTimes(1)
    expect(alertAgent.mock.calls[0][1]).toMatch(/no done signal after/)
  })

  it("never lets a failing alert break the sweep", async () => {
    alertAgent.mockRejectedValue(new Error("offline"))
    const w = makeWatcher()
    await w.delegationStarted({ ...delegation(), dueAt: T0 })
    await expect(w.sweep()).resolves.toBeUndefined()
    expect(store.listLive()[0].status).toBe("fired")
  })
})

describe("wiring", () => {
  it("follows runs on the event bus and writes the decision on the trace", async () => {
    const bus = getEventBus()
    const traced: any[] = []
    const onStep = (p: any) => traced.push(p)
    bus.on("task:step", onStep)
    const attached = attachWatchers(db, { settings: () => settings, log: () => {}, decide: async () => null, alertAgent, alertOwner, now: () => clock })
    try {
      bus.emit("task:started", started({ taskId: "trace-bus" }))
      await flush()
      expect(attached.store.listLive()).toHaveLength(1)
      expect(traced.find((s) => s.taskId === "trace-bus")).toMatchObject({ name: "watcher", outputSummary: expect.stringMatching(/^attach p=n\/a watcher=wch-/) })
      bus.emit("task:completed", completed({ taskId: "trace-bus", error: "crashed" }))
      await flush()
      expect(alertAgent).toHaveBeenCalledTimes(1)
    } finally {
      attached.detach()
      bus.off("task:step", onStep)
    }
  })

  it("maps the task-watch seat answer to a probability", async () => {
    hoisted.askSeat.mockResolvedValue({ answers: { needsWatcher: { type: "noul", noul: 0.7 } }, callId: "call-7", mode: "active" })
    const r = await askTaskWatchSeat({ taskKey: "dlg-1", source: "delegation", agentId: "worker", message: "x", delegator: "lead", dueAt: T0 })
    expect(r).toEqual({ probability: 0.7, mode: "active", callId: "call-7" })
    const [seat, state, , opts] = hoisted.askSeat.mock.calls[0]
    expect(seat).toBe("task-watch")
    expect(state).toMatchObject({ startedBy: "delegation", handedOnBy: "lead", dueAt: new Date(T0).toISOString() })
    expect(opts.incumbent).toEqual({ needsWatcher: 1 })
    hoisted.askSeat.mockResolvedValue(null)
    expect(await askTaskWatchSeat({ taskKey: "t", source: "cron", agentId: "worker", message: "x" })).toBeNull()
  })
})
