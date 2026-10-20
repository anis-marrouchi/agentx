import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { WatcherStore } from "../src/watchers/store"
import {
  WatchCheckpoint, WATCHER_CHANNEL, agentAlertText, classify, taskStartOf,
  type CheckpointDeps, type DecideResult, type TaskStart, type WatcherSettings,
} from "../src/watchers/checkpoint"
import { attachWatchers } from "../src/watchers/attach"
import { handleWatchersApi } from "../src/watchers/daemon-api"
import { dueAtOf, taskTypeOf } from "../src/watchers/due"
import { checkEvidence, evidenceExample, evidenceRuleFor, parseEvidence, type EvidenceRule } from "../src/watchers/evidence"
import { DelegationManager, type DelegationDeps } from "../src/a2a/delegation"
import { CronScheduler } from "../src/crons/scheduler"
import { buildAgentContext } from "../src/agents/context"
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
    // An alert told in the delegator's own chat (#1100) is not a new task.
    const w = { id: "w-1", taskKey: "dlg-1", agentId: "x", summary: "s", dueAt: 0 } as any
    expect(taskStartOf(started({ channel: "mcp", chatId: "mcp:a:b:1", fullMessage: agentAlertText(w, "late") }), ON)).toBeNull()
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

  it("leaves a run for a delegation another node started to that node", async () => {
    const peer = new WatchCheckpoint(deps({ isLocalDelegation: () => false }))
    expect(await peer.check(task({ key: "dlg-remote", traceId: "run-r", kind: "delegation", delegator: "secretary" })))
      .toEqual({ action: "skipped" })
    expect(store.list()).toHaveLength(0)
    expect(decideCalls).toBe(0)
  })

  it("takes the due time the callee run gives over the delegation's default", async () => {
    const local = new WatchCheckpoint(deps({ isLocalDelegation: () => true }))
    await local.delegationStarted({ id: "dlg-8", caller: "coo", callee: "social", request: "post it at 18:00" })
    expect(store.byKey("dlg-8")?.dueAt).toBe(clock + 120 * MIN)
    await local.check(task({ key: "dlg-8", traceId: "callee-8", kind: "delegation", delegator: "coo", dueAt: clock + 600 * MIN }))
    expect(store.byKey("dlg-8")?.dueAt).toBe(clock + 600 * MIN)
    expect(store.list()).toHaveLength(1)
  })

  it("leaves a delegation's watcher to the delegation's own end", async () => {
    await cp.delegationStarted({ id: "dlg-4", caller: "coo", callee: "social", request: "post it" })
    await cp.check(task({ key: "dlg-4", traceId: "callee", kind: "delegation", delegator: "coo" }))
    await cp.taskEnded({ taskId: "callee", agentId: "social", channel: "a2a", chatId: "x", durationMs: 5, error: "boom", at: "" } as any)
    expect(agentAlerts).toHaveLength(0)
  })

  it("stays open, due when the wait ends, for a run that said it ends waiting (#1100)", async () => {
    await cp.check(task({ delegator: "coo", kind: "delegation" }))
    const due = clock + 90 * MIN
    expect(cp.markWaiting("trace-1", due)).toBe(store.byKey("trace-1")?.id)
    await cp.taskEnded({ taskId: "trace-1", agentId: "social", channel: "telegram", chatId: "x", durationMs: 5, finalResponse: "Build started; waiting for it.", at: "" } as any)
    expect(store.byKey("trace-1")?.state).toBe("open")
    expect(store.byKey("trace-1")?.dueAt).toBe(due)
    expect(cp.markWaiting("trace-unknown")).toBeNull()

    await cp.delegationStarted({ id: "dlg-9", caller: "coo", callee: "social", request: "build it" })
    await cp.delegationEnded({ id: "dlg-9" }, "waiting", "started", due)
    expect(store.byKey("dlg-9")?.state).toBe("open")
    expect(store.byKey("dlg-9")?.dueAt).toBe(due)
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
    await failing.settled()
    expect(ownerAlerts).toHaveLength(1)
    expect(ownerAlerts[0].text).toContain("coo could not be told")
  })

  it("does not let one slow alert turn hold up the other watchers", async () => {
    let release!: () => void
    const slow = new WatchCheckpoint(deps({
      alertAgent: (agentId, text) => {
        agentAlerts.push({ agentId, text })
        return agentId === "coo" ? new Promise<void>((r) => { release = r }) : Promise.resolve()
      },
    }))
    await slow.check(task({ key: "a", traceId: "a", delegator: "coo", kind: "delegation", dueAt: clock + MIN }))
    await slow.check(task({ key: "b", traceId: "b", delegator: "social", kind: "delegation", dueAt: clock + MIN }))
    clock += 2 * MIN
    await slow.sweep()
    expect(agentAlerts.map((a) => a.agentId)).toEqual(["coo", "social"])
    release()
    await slow.settled()
  })

  it("stops after it is marked done", async () => {
    await cp.check(task({ delegator: "coo", kind: "delegation", dueAt: clock + MIN }))
    expect(cp.markDone("watch-trace-1", "posted").changed).toBe(true)
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
    expect(cp.markDone("watch-trace-1", "https://example.com/v/1").changed).toBe(true)
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

  it("tells the delegator how to close the watcher in the result, only when the done signal is explicit", async () => {
    await cp.delegationStarted({ id: "dlg-7", caller: "coo", callee: "social", request: "post it" })
    expect(cp.doneNote("dlg-7")).toBeUndefined()
    settings = { ...ON, doneSignal: "explicit" }
    expect(cp.doneNote("dlg-7")).toContain("POST /watchers/watch-dlg-7/done")
    expect(cp.doneNote("dlg-unknown")).toBeUndefined()
    cp.markDone("watch-dlg-7")
    expect(cp.doneNote("dlg-7")).toBeUndefined()
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

describe("evidence on done (#1049)", () => {
  const TEST: EvidenceRule = { accept: ["test"], minOutputChars: 40, linkHosts: [] }
  const PUBLISH: EvidenceRule = { accept: ["link"], minOutputChars: 40, linkHosts: ["example.com"] }
  const REPORT: EvidenceRule = { accept: ["output", "link"], minOutputChars: 20, linkHosts: [] }
  const ended = (taskId: string, finalResponse = "all done") =>
    ({ taskId, agentId: "social", channel: "x", chatId: "x", durationMs: 5, finalResponse, at: "" }) as any

  beforeEach(() => {
    settings = { ...ON, evidence: { code: TEST, publish: PUBLISH, cron: REPORT } }
  })

  it("has no rules by default, and reads per-type rules with defaults", () => {
    expect(watchersConfigSchema.parse({}).evidence).toEqual({})
    const parsed = watchersConfigSchema.parse({ evidence: { code: { accept: ["test"] } } })
    expect(parsed.evidence.code).toEqual({ accept: ["test"], minOutputChars: 40, linkHosts: [] })
    expect(() => watchersConfigSchema.parse({ evidence: { code: { accept: [] } } })).toThrow()
    expect(() => watchersConfigSchema.parse({ evidence: { code: { accept: ["vibes"] } } })).toThrow()
  })

  it("reads the task type from the run context and the task start", () => {
    expect(taskTypeOf({ taskType: " code " })).toBe("code")
    expect(taskTypeOf({ taskType: 3 })).toBeUndefined()
    expect(taskStartOf(started({ taskType: "code" }), ON)?.taskType).toBe("code")
    expect(taskStartOf(started(), ON)?.taskType).toBeNull()
  })

  it("picks the rule by task type, else by the watcher's kind", () => {
    const rules = settings.evidence!
    expect(evidenceRuleFor(rules, { taskType: "code", kind: "dispatch" })).toBe(TEST)
    expect(evidenceRuleFor(rules, { taskType: null, kind: "cron" })).toBe(REPORT)
    expect(evidenceRuleFor(rules, { taskType: "chat", kind: "cron" })).toBe(REPORT)
    expect(evidenceRuleFor(rules, { taskType: "chat", kind: "dispatch" })).toBeNull()
    expect(evidenceRuleFor(undefined, { taskType: "code", kind: "dispatch" })).toBeNull()
  })

  it("reads strings and typed objects, and refuses malformed evidence", () => {
    expect(parseEvidence(undefined)).toBeNull()
    expect(parseEvidence("  ")).toBeNull()
    expect(parseEvidence("https://example.com/p/1")).toEqual({ type: "link", url: "https://example.com/p/1" })
    expect(parseEvidence("posted it")).toEqual({ type: "output", text: "posted it" })
    expect(parseEvidence({ type: "test", passed: 12, failed: 0, command: "pnpm test" })).toEqual({ type: "test", passed: 12, failed: 0, command: "pnpm test" })
    expect(parseEvidence({ type: "test", passed: "12" })).toMatch(/whole numbers/)
    expect(parseEvidence({ type: "link", url: "ftp://x" })).toMatch(/http/)
    expect(parseEvidence({ type: "output" })).toMatch(/needs text/)
    expect(parseEvidence({ type: "screenshot" })).toMatch(/must be one of/)
    expect(parseEvidence([1])).toMatch(/string or an object/)
    // A cut link points elsewhere: refused, as in the object form.
    expect(parseEvidence(`https://example.com/${"a".repeat(1000)}`)).toMatch(/longer than 1000/)
  })

  it("accepts only the proof each type defines", () => {
    expect(checkEvidence(TEST, null)).toMatch(/needs evidence: a passing test run/)
    expect(checkEvidence(TEST, { type: "test", passed: 3, failed: 0 })).toBeNull()
    expect(checkEvidence(TEST, { type: "test", passed: 3, failed: 1 })).toBe("1 test failed")
    expect(checkEvidence(TEST, { type: "test", passed: 0, failed: 0 })).toBe("no test passed")
    expect(checkEvidence(TEST, { type: "link", url: "https://example.com" })).toMatch(/link evidence does not count/)
    expect(checkEvidence(PUBLISH, { type: "link", url: "https://cdn.example.com/v/1" })).toBeNull()
    expect(checkEvidence(PUBLISH, { type: "link", url: "https://example.com.evil.test/v/1" })).toMatch(/must be on example.com/)
    expect(checkEvidence(REPORT, { type: "output", text: "done" })).toMatch(/shorter than 20/)
    expect(checkEvidence(REPORT, { type: "output", text: "Weekly report: 14 items closed, 2 open." })).toBeNull()
  })

  it("rejects done without the required evidence and closes on accepted evidence", async () => {
    await cp.check(task({ taskType: "code" }))
    expect(store.get("watch-trace-1")?.taskType).toBe("code")
    expect(cp.markDone("watch-trace-1")).toMatchObject({ changed: false, error: expect.stringMatching(/needs evidence/) })
    expect(cp.markDone("watch-trace-1", "done, trust me")).toMatchObject({ changed: false, error: expect.stringMatching(/output evidence does not count/) })
    expect(cp.markDone("watch-trace-1", { type: "test", passed: 4, failed: 2 })).toMatchObject({ changed: false, error: "2 tests failed" })
    expect(store.get("watch-trace-1")?.state).toBe("open")
    expect(cp.markDone("watch-trace-1", { type: "test", passed: 40, failed: 0, command: "pnpm test" })).toEqual({ changed: true })
    expect(store.get("watch-trace-1")).toMatchObject({
      state: "done", reason: "tests: 40 passed, 0 failed (pnpm test)",
      evidence: { type: "test", passed: 40, failed: 0, command: "pnpm test" },
    })
  })

  it("does not close a task with a rule on its reply, even in result mode", async () => {
    await cp.check(task({ taskType: "publish", delegator: "coo", kind: "delegation", dueAt: clock + 10 * MIN }))
    await cp.taskEnded(ended("trace-1", "Published!"))
    expect(store.byKey("trace-1")?.state).toBe("open")
    await cp.delegationStarted({ id: "dlg-9", caller: "coo", callee: "social", request: "post it" })
    // The callee's own run on this node names the type.
    await cp.check(taskStartOf(started({ channel: "a2a", chatId: "a2a:coo:social:dlg-9", taskId: "run-9", sender: { name: "agent:coo" }, taskType: "publish" }), ON)!)
    expect(store.byKey("dlg-9")?.taskType).toBe("publish")
    await cp.delegationEnded({ id: "dlg-9" }, "done", "posted")
    expect(store.byKey("dlg-9")?.state).toBe("open")
    expect(cp.doneNote("dlg-9")).toContain("It needs evidence: a link on example.com")
    clock += 11 * MIN
    await cp.sweep()
    expect(agentAlerts[0].text).toContain("Done needs evidence: a link on example.com")
  })

  it("keeps a task with no rule for its type as today", async () => {
    await cp.check(task({ taskType: "chat" }))
    await cp.taskEnded(ended("trace-1"))
    expect(store.byKey("trace-1")?.state).toBe("done")
    await cp.check(task({ key: "trace-2", traceId: "trace-2" }))
    expect(cp.markDone("watch-trace-2", { type: "bogus" })).toEqual({ changed: true })
    expect(store.get("watch-trace-2")).toMatchObject({ state: "done", reason: "marked done", evidence: null })
  })

  it("takes the type a delegation's callee run gives", async () => {
    await cp.delegationStarted({ id: "dlg-3", caller: "coo", callee: "social", request: "fix the bug" })
    await cp.check(task({ key: "dlg-3", traceId: "run-3", kind: "delegation", delegator: "coo", taskType: "code" }))
    expect(store.byKey("dlg-3")?.taskType).toBe("code")
    expect(cp.markDone("watch-dlg-3", "https://example.com/pr/1").changed).toBe(false)
  })

  it("answers 422 on refused evidence through the API", async () => {
    await cp.check(task({ taskType: "publish" }))
    const api = (body?: any) => handleWatchersApi("POST", "/watchers/watch-trace-1/done", new URLSearchParams(), body, { store, checkpoint: cp })
    const refused = api({ evidence: "https://elsewhere.test/v/1" })
    expect(refused.status).toBe(422)
    expect(refused.body).toMatchObject({ error: expect.stringMatching(/example.com/), required: expect.stringMatching(/a link on example.com/) })
    const ok = api({ evidence: { type: "link", url: "https://example.com/v/1" } })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ changed: true, watcher: { state: "done", reason: "link: https://example.com/v/1", evidence: { type: "link" } } })
  })

  it("shows a done example the task's rule accepts", async () => {
    expect(evidenceExample(null)).toBe(`"<proof>"`)
    expect(evidenceExample(TEST)).toMatch(/^\{"type":"test","passed":<n>,"failed":0/)
    expect(evidenceExample(PUBLISH)).toContain(`"url":"https://example.com/`)
    expect(evidenceExample(REPORT)).toContain(`"type":"output"`)
    const hints: Array<EvidenceRule | null> = []
    cp = new WatchCheckpoint(deps({ doneHint: (w, rule) => { hints.push(rule); return `done ${w.id} ${evidenceExample(rule)}` } }))
    await cp.check(task({ taskType: "code", delegator: "coo", kind: "delegation", dueAt: clock + MIN }))
    clock += 2 * MIN
    await cp.sweep()
    expect(hints).toEqual([TEST])
    expect(agentAlerts[0].text).toContain(`done watch-trace-1 {"type":"test"`)
  })

  it("tells a cron or dispatch run with a rule how to close its own watcher", async () => {
    const cron = started({ channel: "cron", chatId: "cron:weekly", taskId: "run-c" })
    const note = cp.runNote(cron)!
    expect(note).toContain("[agentx:watcher id=watch-run-c]")
    expect(note).toContain("POST /watchers/watch-run-c/done")
    expect(note).toContain(`{"evidence":{"type":"output"`)
    expect(note).toMatch(/Done needs evidence: the output, at least 20 characters/)
    // The type a caller gives wins over the kind's rule.
    expect(cp.runNote(started({ taskId: "run-d", taskType: "code" }))).toMatch(/a passing test run/)
    // No rule, result mode: the reply closes it, nothing to say.
    expect(cp.runNote(started({ taskId: "run-e" }))).toBeUndefined()
    // A delegating agent is told instead (doneNote, the alert).
    expect(cp.runNote(started({ taskId: "run-f", sender: { name: "agent:coo" }, taskType: "code" }))).toBeUndefined()
    // Explicit mode needs a done whatever the type.
    settings = { ...settings, doneSignal: "explicit" }
    expect(cp.runNote(started({ taskId: "run-e" }))).toContain(`{"evidence":"<proof>"}`)
    // Off, or already done: nothing.
    await cp.check(task({ key: "run-c", traceId: "run-c", kind: "cron", channel: "cron" }))
    cp.markDone("watch-run-c", "Weekly report: 14 items closed, 2 still open.")
    expect(cp.runNote(cron)).toBeUndefined()
    settings = { ...settings, enabled: false }
    expect(cp.runNote(started({ taskId: "run-d", taskType: "code" }))).toBeUndefined()
  })

  it("puts the run's note in its prompt", () => {
    const ctx = buildAgentContext({ channel: "cron", message: "Summarise the week", watcherNote: "[agentx:watcher id=watch-x] mark it done" })
    expect(ctx).toContain("[agentx:watcher id=watch-x] mark it done")
  })

  it("carries a delegation's task type to its watcher, local or on a peer", async () => {
    const runs: Array<Record<string, unknown>> = []
    const dlgDeps: DelegationDeps = {
      timeoutMs: 60_000, pollMs: 1,
      runLocal: (_c, _m, context) => { runs.push(context); return new Promise(() => {}) },
      runPeer: (_p, _c, _m, context) => { runs.push(context); return new Promise(() => {}) },
      injectTurn: async () => ({ content: "" }), isChatBusy: () => false, canDeliver: () => true,
      deliver: async () => {}, log: () => {},
      onStarted: (rec) => { void cp.delegationStarted(rec) },
    }
    const mgr = new DelegationManager(dlgDeps)
    const caller = { agentId: "coo", taskId: "run-1", context: { channel: "telegram", chatId: "chat-1", sender: "Sam" } }
    const { record } = mgr.start({ caller, callee: "social", message: "fix the bug", calleeContext: { taskType: "code" } })
    const peer = mgr.start({ caller, callee: "social", peer: "node-b", message: "post it", calleeContext: { taskType: "publish" } })
    mgr.stop()
    await cp.settled()
    await new Promise((r) => setTimeout(r, 5))
    expect(record.taskType).toBe("code")
    expect(runs[0]).toMatchObject({ channel: "a2a", taskType: "code" })
    expect(runs[1]).toMatchObject({ taskType: "publish" })
    expect(store.byKey(record.id)?.taskType).toBe("code")
    expect(store.byKey(peer.record.id)?.taskType).toBe("publish")
    expect(cp.doneNote(peer.record.id)).toContain("a link on example.com")
  })

  it("gives a cron run the job's task type", async () => {
    const execute = async (t: any) => { calls.push(t.context); return { content: "ok", duration: 1 } }
    const calls: any[] = []
    const prev = process.cwd()
    process.chdir(tmp)
    try {
      const job = { enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "social", prompt: "Weekly report", timeout: 30, onError: ["log"] }
      const s: any = new CronScheduler({ crons: { weekly: { ...job, taskType: "report" }, daily: job }, agents: {}, notifications: {} } as any, { execute } as any)
      s.scheduleNext = () => {}
      s.running = true
      await s.executeJob("weekly")
      await s.executeJob("daily")
    } finally {
      process.chdir(prev)
    }
    expect(calls[0]).toEqual({ channel: "cron", chatId: "cron:weekly", taskType: "report" })
    expect(calls[1]).toEqual({ channel: "cron", chatId: "cron:daily" })
  })
})
