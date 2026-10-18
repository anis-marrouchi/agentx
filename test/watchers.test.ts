import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { WatcherStore } from "../src/watchers/store"
import {
  WatchCheckpoint, WATCHER_CHANNEL, classify, taskStartOf,
  type CheckpointDeps, type DecideResult, type TaskStart, type WatcherSettings,
} from "../src/watchers/checkpoint"
import { attachWatchers } from "../src/watchers/attach"
import { handleWatchersApi } from "../src/watchers/daemon-api"
import { dueAtOf } from "../src/watchers/due"
import { watchersConfigSchema } from "../src/daemon/config"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { getEventBus } from "../src/events/bus"
import { taskWatchQuestions, taskWatchState } from "../src/decisions/seats/task-watch"

const MIN = 60_000
const ON: WatcherSettings = {
  enabled: true, skipChannels: [], defaultDueMinutes: 120, noBelow: 0.2, yesAt: 0.7,
  escalateAfterMinutes: 30, retentionDays: 30, doneSignal: "result",
}

let tmp: string
let db: Database.Database
let store: WatcherStore
let settings: WatcherSettings
let clock: number
let decided: DecideResult | Error
let decideCalls: number
let agentAlerts: Array<{ agentId: string; text: string }>
let ownerAlerts: Array<{ title: string; text: string }>
let agents: Set<string>

function deps(over: Partial<CheckpointDeps> = {}): CheckpointDeps {
  return {
    store,
    settings: () => settings,
    decide: async () => {
      decideCalls++
      if (decided instanceof Error) throw decided
      return decided
    },
    hasAgent: (id) => agents.has(id),
    alertAgent: async (agentId, text) => { agentAlerts.push({ agentId, text }) },
    alertOwner: async (title, text) => { ownerAlerts.push({ title, text }) },
    log: () => {},
    now: () => clock,
    ...over,
  }
}

let cp: WatchCheckpoint

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-watchers-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  // The trace table the daemon opens; the store adds its columns.
  db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY)")
  store = new WatcherStore(db)
  settings = { ...ON }
  clock = 1_000_000_000
  decided = { probability: 0.9, callId: null, mode: "active" }
  decideCalls = 0
  agentAlerts = []
  ownerAlerts = []
  agents = new Set(["coo", "social"])
  cp = new WatchCheckpoint(deps())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const trace = (id: string) => db.prepare("SELECT * FROM task_traces WHERE task_id = ?").get(id) as any
const addTrace = (id: string) => db.prepare("INSERT INTO task_traces (task_id) VALUES (?)").run(id)

function task(over: Partial<TaskStart> = {}): TaskStart {
  return {
    key: "trace-1", traceId: "trace-1", kind: "dispatch", agentId: "social", channel: "telegram",
    delegator: null, message: "publish the approved video at 18:00", dueAt: null, ...over,
  }
}

const started = (over: Record<string, unknown> = {}) => ({
  agentId: "social", channel: "telegram", chatId: "chat-1", taskId: "trace-1",
  messagePreview: "publish the video", fullMessage: "publish the video", at: new Date(clock).toISOString(),
  ...over,
}) as any

describe("settings", () => {
  it("is off by default with fail-safe thresholds", () => {
    const s = watchersConfigSchema.parse(undefined)
    expect(s.enabled).toBe(false)
    expect(s.defaultDueMinutes).toBe(120)
    expect(s.noBelow).toBe(0.2)
    expect(s.yesAt).toBe(0.7)
    expect(s.escalateAfterMinutes).toBe(30)
    expect(s.owner).toEqual({})
    expect(s.doneSignal).toBe("result")
    expect(watchersConfigSchema.parse({ doneSignal: "explicit" }).doneSignal).toBe("explicit")
    expect(watchersConfigSchema.safeParse({ doneSignal: "reply" }).success).toBe(false)
  })

  it("refuses a no threshold above the yes threshold", () => {
    expect(watchersConfigSchema.safeParse({ noBelow: 0.8, yesAt: 0.5 }).success).toBe(false)
  })

  it("does nothing while off", async () => {
    settings = { ...ON, enabled: false }
    expect(await cp.check(task())).toEqual({ action: "skipped" })
    expect(store.list()).toHaveLength(0)
    expect(decideCalls).toBe(0)
  })

  it("gates /watchers like /requests", () => {
    expect(isMeshGatedPath("/watchers")).toBe(true)
    expect(isMeshGatedPath("/watchers/watch-x/done")).toBe(true)
  })
})

describe("what a task start is", () => {
  it("keys a delegation's callee run by the delegation id and names the caller", () => {
    const t = taskStartOf(started({ channel: "a2a", chatId: "a2a:coo:social:dlg-abc-12ef", sender: { name: "agent:coo" } }), ON)
    expect(t).toMatchObject({ key: "dlg-abc-12ef", traceId: "trace-1", kind: "delegation", delegator: "coo" })
  })

  it("reads a cron run, a sync hand-off and a dispatch", () => {
    expect(taskStartOf(started({ channel: "cron", chatId: "cron:daily" }), ON)).toMatchObject({ kind: "cron", key: "trace-1", delegator: null })
    expect(taskStartOf(started({ channel: "a2a", chatId: "x", sender: { name: "agent:coo" } }), ON)).toMatchObject({ kind: "delegation", key: "trace-1", delegator: "coo" })
    expect(taskStartOf(started(), ON)).toMatchObject({ kind: "dispatch", delegator: null })
  })

  it("skips its own alert turns, configured channels and delegation relays", () => {
    expect(taskStartOf(started({ channel: WATCHER_CHANNEL }), ON)).toBeNull()
    expect(taskStartOf(started({ channel: "voice" }), { skipChannels: ["voice"] })).toBeNull()
    expect(taskStartOf(started({ fullMessage: "[agentx:delegation-result task=dlg-1 from=x status=done]\n..." }), ON)).toBeNull()
  })

  it("reads a due time from the run context", () => {
    expect(dueAtOf({ dueAt: "2026-10-18T18:00:00Z" })).toBe(Date.parse("2026-10-18T18:00:00Z"))
    expect(dueAtOf({ dueAt: 1234 })).toBe(1234)
    expect(dueAtOf({ dueAt: "soon" })).toBeUndefined()
    expect(dueAtOf(undefined)).toBeUndefined()
  })
})

describe("decide", () => {
  it("classifies a probability into yes, no or uncertain", () => {
    expect(classify(0.9, ON)).toBe("yes")
    expect(classify(0.1, ON)).toBe("no")
    expect(classify(0.5, ON)).toBe("uncertain")
    expect(classify(null, ON)).toBe("uncertain")
  })

  it("asks one yes/no question over the task", () => {
    expect(taskWatchQuestions.needsWatcher.type).toBe("noul")
    expect(taskWatchState({ message: "x", agent: "a", kind: "cron", delegator: "coo" })).toMatchObject({ kind: "cron", handedOverBy: "coo" })
  })

  it("attaches on an uncertain answer (fail-safe)", async () => {
    decided = { probability: 0.5, callId: null, mode: "active" }
    const r = await cp.check(task())
    expect(r).toMatchObject({ action: "attached", decision: "uncertain" })
    expect(store.list()).toHaveLength(1)
  })

  it("attaches when the seat is off or fails", async () => {
    decided = { probability: null, callId: null, mode: "off" }
    expect(await cp.check(task({ key: "a", traceId: "a" }))).toMatchObject({ action: "attached", decision: "uncertain" })
    decided = new Error("backend down")
    expect(await cp.check(task({ key: "b", traceId: "b" }))).toMatchObject({ action: "attached", decision: "uncertain" })
  })

  it("attaches through the real seat when it is off (no decision configured)", async () => {
    const real = new WatchCheckpoint(deps({ decide: undefined }))
    expect(await real.check(task())).toMatchObject({ action: "attached", decision: "uncertain" })
    expect(store.byKey("trace-1")?.probability).toBeNull()
  })

  it("skips only on a confident no from an active seat", async () => {
    addTrace("a")
    decided = { probability: 0.05, callId: null, mode: "active" }
    expect(await cp.check(task({ key: "a", traceId: "a" }))).toMatchObject({ action: "declined", probability: 0.05 })
    expect(store.byKey("a")).toBeNull()
    expect(trace("a")).toMatchObject({ watch_decision: "no", watch_probability: 0.05, watcher_id: null })

    // Shadow mode records, and never changes what happens.
    decided = { probability: 0.05, callId: null, mode: "shadow" }
    expect(await cp.check(task({ key: "b", traceId: "b" }))).toMatchObject({ action: "attached", decision: "no" })
  })
})

describe("attach and record", () => {
  it("attaches exactly one watcher to a delegated task with a due time, recorded on the task", async () => {
    const due = clock + 3 * 60 * MIN
    // The delegation starts, then its callee run starts on this node.
    const first = cp.delegationStarted({ id: "dlg-1", caller: "coo", callee: "social", request: "publish the approved video" }, due)
    addTrace("callee-run")
    const second = cp.check(task({ key: "dlg-1", traceId: "callee-run", kind: "delegation", delegator: "coo", dueAt: due }))
    const [a, b] = await Promise.all([first, second])

    expect(a).toMatchObject({ action: "attached", decision: "yes" })
    expect(b).toMatchObject({ action: "existing", watcherId: "watch-dlg-1" })
    expect(decideCalls).toBe(1)
    const all = store.list()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      id: "watch-dlg-1", taskKey: "dlg-1", traceId: "callee-run", kind: "delegation", agentId: "social",
      delegator: "coo", dueAt: due, state: "open", decision: "yes", probability: 0.9,
    })
    expect(trace("callee-run")).toMatchObject({ watcher_id: "watch-dlg-1", watch_probability: 0.9 })
  })

  it("records the decision, probability and watcher id on the run's trace", async () => {
    addTrace("trace-1")
    await cp.check(task())
    expect(trace("trace-1")).toMatchObject({ watch_decision: "yes", watch_probability: 0.9, watcher_id: "watch-trace-1" })
  })

  it("uses the default due time when the task gives none", async () => {
    await cp.check(task())
    expect(store.byKey("trace-1")?.dueAt).toBe(clock + 120 * MIN)
  })

  it("creates no second watcher for a task that has one", async () => {
    await cp.check(task())
    expect(await cp.check(task())).toMatchObject({ action: "existing", watcherId: "watch-trace-1" })
    expect(store.list()).toHaveLength(1)
    expect(decideCalls).toBe(1)
  })

  it("creates none when another watcher already follows the task", async () => {
    addTrace("trace-1")
    const withPlan = new WatchCheckpoint(deps({ lookups: [({ traceId }) => (traceId === "trace-1" ? "plan req-9" : null)] }))
    expect(await withPlan.check(task())).toEqual({ action: "existing", watcherId: null, found: "plan req-9" })
    expect(store.list()).toHaveLength(0)
    expect(decideCalls).toBe(0)
    expect(trace("trace-1")).toMatchObject({ watch_decision: "existing", watcher_id: "plan req-9" })
  })

  it("keeps one watcher when two processes race on the key", () => {
    const row = { taskKey: "k", traceId: null, kind: "dispatch", agentId: "a", delegator: null, summary: "s", dueAt: 1, decision: "yes" as const, probability: 1, decisionCallId: null, createdAt: 1 }
    expect(store.add(row).created).toBe(true)
    expect(store.add(row).created).toBe(false)
    expect(store.list()).toHaveLength(1)
  })
})

describe("fire", () => {
  it("tells the delegator when the owning chat ends without a result before the due time", async () => {
    await cp.check(task({ kind: "delegation", delegator: "coo", dueAt: clock + 60 * MIN }))
    await cp.taskEnded({ taskId: "trace-1", agentId: "social", channel: "a2a", chatId: "x", durationMs: 5, finalResponse: "", at: "" } as any)
    expect(agentAlerts).toHaveLength(1)
    expect(agentAlerts[0].agentId).toBe("coo")
    expect(agentAlerts[0].text).toContain("the run ended without a result")
    expect(agentAlerts[0].text).toContain("watch-trace-1")
    expect(store.byKey("trace-1")?.state).toBe("alerted")
    expect(ownerAlerts).toHaveLength(0)
  })

  it("tells the delegator when a delegation fails, and closes on a done one", async () => {
    await cp.delegationStarted({ id: "dlg-2", caller: "coo", callee: "social", request: "post it" })
    await cp.delegationEnded({ id: "dlg-2" }, "error", "chat closed")
    expect(agentAlerts.map((a) => a.agentId)).toEqual(["coo"])
    expect(agentAlerts[0].text).toContain("the delegation failed: chat closed")

    await cp.delegationStarted({ id: "dlg-3", caller: "coo", callee: "social", request: "post it" })
    await cp.delegationEnded({ id: "dlg-3" }, "done")
    expect(store.byKey("dlg-3")?.state).toBe("done")
    expect(agentAlerts).toHaveLength(1)
  })

  it("leaves a delegation's watcher to the delegation's own end", async () => {
    await cp.delegationStarted({ id: "dlg-4", caller: "coo", callee: "social", request: "post it" })
    await cp.check(task({ key: "dlg-4", traceId: "callee", kind: "delegation", delegator: "coo" }))
    await cp.taskEnded({ taskId: "callee", agentId: "social", channel: "a2a", chatId: "x", durationMs: 5, error: "boom", at: "" } as any)
    expect(agentAlerts).toHaveLength(0)
  })

  it("is done when the run ends with a result", async () => {
    await cp.check(task({ delegator: "coo", kind: "delegation" }))
    await cp.taskEnded({ taskId: "trace-1", agentId: "social", channel: "telegram", chatId: "x", durationMs: 5, finalResponse: "Published: https://example.com/v/1", at: "" } as any)
    expect(store.byKey("trace-1")?.state).toBe("done")
    clock += 500 * MIN
    await cp.sweep()
    expect(agentAlerts).toHaveLength(0)
    expect(ownerAlerts).toHaveLength(0)
  })

  it("waits for the decision when the run ends before it", async () => {
    let release!: () => void
    const slow = new WatchCheckpoint(deps({ decide: () => new Promise((r) => { release = () => r({ probability: 0.9, callId: null, mode: "active" }) }) }))
    const checking = slow.check(task({ delegator: "coo", kind: "delegation" }))
    const ending = slow.taskEnded({ taskId: "trace-1", agentId: "social", channel: "telegram", chatId: "x", durationMs: 5, finalResponse: "done", at: "" } as any)
    release()
    await Promise.all([checking, ending])
    expect(store.byKey("trace-1")?.state).toBe("done")
  })

  it("keeps watching a run a restart or a stop cut, and its resumed run shares the watcher", async () => {
    await cp.check(task({ delegator: "coo", kind: "delegation" }))
    await cp.taskEnded({ taskId: "trace-1", agentId: "social", channel: "x", chatId: "x", durationMs: 5, interrupted: true, at: "" } as any)
    expect(store.byKey("trace-1")?.state).toBe("open")

    expect(await cp.check(task({ key: "trace-2", traceId: "trace-2", resumedFrom: "trace-1", delegator: "coo", kind: "delegation" })))
      .toMatchObject({ action: "existing", watcherId: "watch-trace-1" })
    expect(store.list()).toHaveLength(1)
    await cp.taskEnded({ taskId: "trace-2", agentId: "social", channel: "x", chatId: "x", durationMs: 5, finalResponse: "posted", at: "" } as any)
    expect(store.byKey("trace-1")?.state).toBe("done")
  })

  it("spares the owner when the result arrives after the delegator was told", async () => {
    await cp.check(task({ delegator: "coo", kind: "delegation", dueAt: clock + MIN }))
    clock += 2 * MIN
    await cp.sweep()
    expect(agentAlerts).toHaveLength(1)
    await cp.taskEnded({ taskId: "trace-1", agentId: "social", channel: "x", chatId: "x", durationMs: 5, finalResponse: "posted late", at: "" } as any)
    clock += 60 * MIN
    await cp.sweep()
    expect(ownerAlerts).toHaveLength(0)
    expect(store.byKey("trace-1")?.state).toBe("done")
  })

  it("fires when the due time passes, then tells the owner if nothing happens", async () => {
    await cp.check(task({ delegator: "coo", kind: "delegation", dueAt: clock + 10 * MIN }))
    clock += 9 * MIN
    await cp.sweep()
    expect(agentAlerts).toHaveLength(0)

    clock += 2 * MIN
    await cp.sweep()
    expect(agentAlerts).toHaveLength(1)
    expect(agentAlerts[0].text).toContain("the due time passed with no done signal")

    clock += 29 * MIN
    await cp.sweep()
    expect(ownerAlerts).toHaveLength(0)
    clock += 2 * MIN
    await cp.sweep()
    expect(ownerAlerts).toHaveLength(1)
    expect(ownerAlerts[0].text).toContain("handed over by coo")
    expect(store.byKey("trace-1")?.state).toBe("escalated")

    // Once each.
    clock += 60 * MIN
    await cp.sweep()
    expect(agentAlerts).toHaveLength(1)
    expect(ownerAlerts).toHaveLength(1)
  })

  it("tells the owner at once when there is no delegating agent on this node", async () => {
    await cp.check(task({ kind: "cron", dueAt: clock + MIN }))
    await cp.check(task({ key: "t2", traceId: "t2", kind: "delegation", delegator: "peer-agent", dueAt: clock + MIN }))
    clock += 2 * MIN
    await cp.sweep()
    expect(agentAlerts).toHaveLength(0)
    expect(ownerAlerts).toHaveLength(2)
  })

  it("tells the owner when the delegator cannot be told", async () => {
    const failing = new WatchCheckpoint(deps({ alertAgent: async () => { throw new Error("no turn") } }))
    await failing.check(task({ delegator: "coo", kind: "delegation", dueAt: clock + MIN }))
    clock += 2 * MIN
    await failing.sweep()
    expect(ownerAlerts).toHaveLength(1)
    expect(ownerAlerts[0].text).toContain("coo could not be told")
  })

  it("stops after it is marked done", async () => {
    await cp.check(task({ delegator: "coo", kind: "delegation", dueAt: clock + MIN }))
    expect(cp.markDone("watch-trace-1", "posted")).toBe(true)
    clock += 2 * MIN
    await cp.sweep()
    expect(agentAlerts).toHaveLength(0)
    expect(store.get("watch-trace-1")).toMatchObject({ state: "done", reason: "posted" })
  })

  it("keeps watching a promise-only reply when the done signal is explicit", async () => {
    settings = { ...ON, doneSignal: "explicit" }
    await cp.check(task({ delegator: "coo", kind: "delegation", dueAt: clock + 10 * MIN }))
    await cp.taskEnded({ taskId: "trace-1", agentId: "social", channel: "x", chatId: "x", durationMs: 5, finalResponse: "I'll publish at 18:00", at: "" } as any)
    expect(store.byKey("trace-1")?.state).toBe("open")
    clock += 11 * MIN
    await cp.sweep()
    expect(agentAlerts.map((a) => a.agentId)).toEqual(["coo"])
    expect(cp.markDone("watch-trace-1", "https://example.com/v/1")).toBe(true)
    clock += 60 * MIN
    await cp.sweep()
    expect(ownerAlerts).toHaveLength(0)
    expect(store.get("watch-trace-1")).toMatchObject({ state: "done", reason: "https://example.com/v/1" })
  })

  it("keeps an answered delegation open when the done signal is explicit, and still fires a failed one", async () => {
    settings = { ...ON, doneSignal: "explicit" }
    await cp.delegationStarted({ id: "dlg-5", caller: "coo", callee: "social", request: "post it" })
    await cp.delegationEnded({ id: "dlg-5" }, "done", "will post tonight")
    expect(store.byKey("dlg-5")?.state).toBe("open")
    await cp.delegationStarted({ id: "dlg-6", caller: "coo", callee: "social", request: "post it" })
    await cp.delegationEnded({ id: "dlg-6" }, "error", "chat closed")
    expect(store.byKey("dlg-6")?.state).toBe("alerted")
  })

  it("still fires at once on a run without a result when the done signal is explicit", async () => {
    settings = { ...ON, doneSignal: "explicit" }
    await cp.check(task({ delegator: "coo", kind: "delegation", dueAt: clock + 60 * MIN }))
    await cp.taskEnded({ taskId: "trace-1", agentId: "social", channel: "x", chatId: "x", durationMs: 5, finalResponse: "", at: "" } as any)
    expect(store.byKey("trace-1")?.state).toBe("alerted")
  })

  it("deletes finished watchers after the retention period", async () => {
    await cp.check(task())
    cp.markDone("watch-trace-1")
    clock += 31 * 24 * 60 * MIN
    await cp.sweep()
    expect(store.list()).toHaveLength(0)
  })
})

describe("bus and API", () => {
  it("checks every run start and follows its end", async () => {
    const attached = attachWatchers(db, { ...deps(), decide: async () => ({ probability: 0.9, callId: null, mode: "active" }) })
    const bus = getEventBus()
    try {
      bus.emit("task:started", started({ taskId: "bus-1", channel: "a2a", chatId: "x", sender: { name: "agent:coo" } }))
      await new Promise((r) => setTimeout(r, 10))
      expect(attached.store.byKey("bus-1")).toMatchObject({ state: "open", delegator: "coo" })
      bus.emit("task:completed", { agentId: "social", channel: "a2a", chatId: "x", taskId: "bus-1", durationMs: 5, error: "chat ended", at: "" })
      await new Promise((r) => setTimeout(r, 10))
      expect(attached.store.byKey("bus-1")?.state).toBe("alerted")
    } finally {
      attached.detach()
    }
  })

  it("lists watchers and marks one done", async () => {
    await cp.check(task())
    const api = (m: string, p: string, q = "", body?: any) => handleWatchersApi(m, p, new URLSearchParams(q), body, { store, checkpoint: cp })
    expect((api("GET", "/watchers").body as any).watchers).toHaveLength(1)
    expect((api("GET", "/watchers", "state=done").body as any).watchers).toHaveLength(0)
    expect(api("GET", "/watchers", "state=bogus").status).toBe(400)
    expect(api("GET", "/watchers/nope").status).toBe(404)
    const done = api("POST", "/watchers/watch-trace-1/done", "", { evidence: "https://example.com/post/1" })
    expect(done.body).toMatchObject({ changed: true, watcher: { state: "done", reason: "https://example.com/post/1" } })
  })
})
