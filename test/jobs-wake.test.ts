import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore, type JobRecord } from "../src/jobs/store"
import { JobDoors } from "../src/jobs/doors"
import { BACKGROUND_WAITER, DEFAULT_WAKE_SETTINGS, JobWake, wakeContext, wakeText, wokenJobId, type JobWakeSettings } from "../src/jobs/wake"
import type { JobFacts } from "../src/jobs/status"
import { requestsConfigSchema } from "../src/daemon/config"

const MIN = 60_000
const HOUR = 60 * MIN

let tmp: string
let db: Database.Database
let requests: RequestStore
let jobs: JobStore
let wake: JobWake
let doors: JobDoors
let settings: JobWakeSettings
let clock: number
let logs: string[]
let started: Array<{ id: string; text: string }>
let startError: string | undefined
let live: Set<string>
let held: Set<string>
let background: number

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-wake-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, status TEXT, started_at INTEGER, finished_at INTEGER, cost_usd REAL, error TEXT)")
  requests = new RequestStore(db)
  jobs = new JobStore(db)
  settings = { ...DEFAULT_WAKE_SETTINGS }
  clock = Date.UTC(2026, 10, 14, 10, 0, 0)
  logs = []; started = []; startError = undefined; live = new Set(); held = new Set(); background = 0
  wake = new JobWake({
    jobs, settings: () => settings, log: (m) => logs.push(m), now: () => clock,
    facts: (job): JobFacts => (live.has(job.id) ? { liveRun: { runId: "r", startedAt: clock } } : { lastRunEndedAt: clock - HOUR }),
    start: async (job, text) => { started.push({ id: job.id, text }); return startError ? { error: startError } : {} },
    hasAgent: (id) => id !== "ghost",
    held: (job) => held.has(job.id),
  })
  doors = new JobDoors({
    jobs, requests, settings: () => ({ enabled: true }), log: (m) => logs.push(m), now: () => clock,
    leftBackground: (job, end) => wake.runLeftBackground(job, background, end.taskId),
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function open(id = "job-1", over: Partial<Parameters<JobStore["open"]>[0]> = {}) {
  jobs.open({ id, door: "a2a", requester: "pm", assignee: "coder", channel: "a2a", chatId: "pm", text: "build the report", runId: `run-${id}`, now: clock, ...over })
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("the wake", () => {
  it("starts the next run when the time has come, once, in the job's chat with its note", async () => {
    open()
    jobs.declare("job-1", { state: "continue", wakeAt: clock + HOUR, note: "the build" }, { now: clock })
    expect(wake.tick()).toEqual({ woken: 0, capped: 0, stalled: 0 })
    clock += HOUR
    expect(wake.tick()).toEqual({ woken: 1, capped: 0, stalled: 0 })
    await flush()
    expect(started.map((s) => s.id)).toEqual(["job-1"])
    expect(started[0].text).toContain("[agentx:job-wake id=job-1]")
    expect(started[0].text).toContain("build the report")
    expect(started[0].text).toContain("Why you are woken now: the build")
    expect(started[0].text).toContain("(by pm)")
    expect(jobs.get("job-1")).toMatchObject({ wakeAt: null, wakeCount: 1 })
    expect(wake.tick().woken).toBe(0)
  })

  it("marks the run it starts, and the doors link that run to the job", () => {
    open()
    const job = jobs.get("job-1")!
    const ctx = wakeContext(job)
    expect(ctx).toMatchObject({ channel: "a2a", chatId: "pm", sender: "system:job-wake" })
    expect(wokenJobId(ctx)).toBe("job-1")
    // A JSON body cannot carry the mark.
    expect(wokenJobId(JSON.parse(JSON.stringify(ctx)))).toBeUndefined()
    expect(wokenJobId({ jobId: "job-1" })).toBeUndefined()
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    doors.taskStarted({ agentId: "coder", channel: "a2a", chatId: "pm", taskId: "w1", messagePreview: "wake", at: "", jobId: "job-1" } as any)
    expect(jobs.byRun("w1")!.id).toBe("job-1")
    expect(jobs.get("job-1")!.state).toBe("working")
    expect(db.prepare("SELECT COUNT(*) FROM requests").pluck().get()).toBe(1)
  })

  it("stops at the cap of wakes, and at the cap of cost, and says why", async () => {
    settings.maxWakes = 2
    open()
    for (let i = 0; i < 2; i++) {
      jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "more" }, { now: clock })
      expect(wake.tick().woken).toBe(1)
      // The next wake waits for this start to come back.
      await flush()
    }
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "still more" }, { now: clock })
    expect(wake.tick()).toEqual({ woken: 0, capped: 1, stalled: 0 })
    expect(jobs.get("job-1")).toMatchObject({ state: "stalled", wakeAt: null })
    expect(jobs.get("job-1")!.note).toMatch(/woken 2 times.*What was left: still more/)
    await flush()
    expect(started).toHaveLength(2)

    settings.maxWakes = 20; settings.maxCostUsd = 1
    open("job-2")
    db.prepare("INSERT INTO task_traces VALUES ('run-job-2', 'ok', ?, ?, 1.5, NULL)").run(clock, clock)
    jobs.declare("job-2", { state: "continue", wakeAt: clock, note: "more" }, { now: clock })
    expect(wake.tick().capped).toBe(1)
    expect(jobs.get("job-2")!.note).toMatch(/cost \$1\.50/)
  })

  it("does not start a second run beside a live one, and arms again when the start fails", async () => {
    open()
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    live.add("job-1")
    expect(wake.tick().woken).toBe(0)
    live.clear()
    startError = "agent busy"
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(jobs.get("job-1")).toMatchObject({ state: "continue", wakeAt: clock + 5 * MIN, wakeCount: 1 })
  })

  it("a wake run that began and was stopped, failed or was cut is not armed again", async () => {
    for (const id of ["job-stop", "job-fail", "job-cut"]) {
      open(id)
      jobs.declare(id, { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    }
    // The wake run begins (the doors link it), then ends with an error
    // before execute() resolves, as on the live bus.
    wake = new JobWake({
      jobs, settings: () => settings, log: (m) => logs.push(m), now: () => clock,
      facts: (): JobFacts => ({ lastRunEndedAt: clock - HOUR }),
      start: async (job) => {
        const runId = `wake-${job.id}`
        jobs.linkRun(job.id, runId, clock)
        const end = job.id === "job-stop" ? { stopped: true, error: "stopped by owner" }
          : job.id === "job-fail" ? { error: "model error" } : { interrupted: true, error: "daemon shutdown" }
        doors.taskCompleted({ taskId: runId, agentId: job.assignee, channel: job.channel, chatId: job.chatId, ...end } as any)
        return { error: end.error }
      },
      hasAgent: () => true,
    })
    expect(wake.tick().woken).toBe(3)
    await flush()
    expect(jobs.get("job-stop")).toMatchObject({ state: "blocked", wakeAt: null, wakeCount: 1 })
    expect(jobs.get("job-fail")).toMatchObject({ state: "blocked", wakeAt: null, wakeCount: 1 })
    expect(jobs.get("job-cut")).toMatchObject({ wakeAt: null, wakeCount: 1 })
    expect(logs.filter((l) => l.includes("not armed again"))).toHaveLength(3)
    clock += 10 * MIN
    expect(wake.tick().woken).toBe(0)
  })

  it("a wake queued behind a busy agent is not armed a second time, and its job is not stalled while it waits", async () => {
    open()
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    startError = "__queued__:collect:2"
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(jobs.get("job-1")).toMatchObject({ state: "continue", wakeAt: null, wakeCount: 1 })
    clock += 20 * MIN
    expect(wake.tick()).toEqual({ woken: 0, capped: 0, stalled: 0 })
    // Past the wait for a slot, nobody holds it.
    clock += 30 * MIN
    expect(wake.tick().stalled).toBe(1)
  })

  it("a wake run that began and failed is not armed again: the state its end left stands", async () => {
    open()
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    // The run starts, hits its time limit, and the registry answers with the error.
    const ctx = { agentId: "coder", channel: "a2a", chatId: "pm" }
    const w = new JobWake({
      jobs, settings: () => settings, log: (m) => logs.push(m), now: () => clock, hasAgent: () => true,
      start: async () => {
        doors.taskStarted({ ...ctx, taskId: "w1", messagePreview: "wake", at: "", jobId: "job-1" } as any)
        clock += 30 * MIN
        doors.taskCompleted({ ...ctx, taskId: "w1", durationMs: 5, at: "", error: "timed out after 30m" } as any)
        return { error: "timed out after 30m" }
      },
    })
    expect(w.tick().woken).toBe(1)
    await flush()
    expect(jobs.get("job-1")).toMatchObject({ state: "blocked", wakeAt: null, wakeCount: 1 })
    expect(jobs.get("job-1")!.note).toMatch(/coder timed out/)
    expect(logs.some((l) => l.includes("not armed again"))).toBe(true)
    clock += HOUR
    expect(w.tick()).toEqual({ woken: 0, capped: 0, stalled: 0 })
  })

  it("a run that declared waiting and then failed keeps what it declared", async () => {
    open()
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    const w = new JobWake({
      jobs, settings: () => settings, log: (m) => logs.push(m), now: () => clock, hasAgent: () => true,
      start: async () => {
        jobs.linkRun("job-1", "w1", clock)
        jobs.working("job-1", clock)
        jobs.declare("job-1", { state: "waiting", on: "devops", until: clock + HOUR }, { runId: "w1", now: clock })
        return { error: "the model failed" }
      },
    })
    w.tick()
    await flush()
    expect(jobs.get("job-1")).toMatchObject({ state: "waiting", waitingOn: "devops", wakeAt: null })
  })

  it("holds the job while its wake waits for a slot, and wakes it once, even when a reply arms it meanwhile", async () => {
    open()
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    let release!: (r: { error?: string }) => void
    let starts = 0
    const w = new JobWake({
      jobs, settings: () => settings, log: (m) => logs.push(m), now: () => clock, hasAgent: () => true,
      start: () => { starts++; return new Promise((r) => { release = r }) },
    })
    expect(w.tick().woken).toBe(1)
    await flush()
    // 25 minutes for a slot, with no run and no wake set: not stalled.
    clock += 25 * MIN
    expect(w.tick()).toEqual({ woken: 0, capped: 0, stalled: 0 })
    // A closing reply meanwhile: the waiting run will see the work itself.
    expect(w.backgroundEnded({ agentId: "coder", channel: "a2a", chatId: "pm" }, "done")).toBe(false)
    // And a wake set some other way is not taken beside the one waiting.
    jobs.armWake("job-1", clock, "again", clock)
    expect(w.tick().woken).toBe(0)
    expect(starts).toBe(1)
    // The slot never came: armed again, and the hold is gone.
    jobs.takeWake("job-1", clock)
    release({ error: 'Agent "coder" busy — slot wait timed out after 25m' })
    await flush()
    expect(jobs.get("job-1")).toMatchObject({ state: "continue", wakeAt: clock + 5 * MIN })
    clock += 5 * MIN
    expect(w.tick().woken).toBe(1)
  })

  it("a start that did not take does not arm a job something else moved meanwhile", async () => {
    open()
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    const w = new JobWake({
      jobs, settings: () => settings, log: (m) => logs.push(m), now: () => clock, hasAgent: () => true,
      start: async () => {
        jobs.declare("job-1", { state: "blocked", why: "stopped by the operator" }, { now: clock })
        return { error: "agent busy" }
      },
    })
    w.tick()
    await flush()
    expect(jobs.get("job-1")).toMatchObject({ state: "blocked", wakeAt: null })
  })

  it("a schedule's job is never woken", async () => {
    open("job-1", { door: "cron", requester: "cron:nightly", channel: "cron", chatId: "cron:nightly" })
    expect(wake.runLeftBackground(jobs.get("job-1")!, 2)).toBe(false)
    expect(wake.backgroundEnded({ agentId: "coder", channel: "cron", chatId: "cron:nightly" }, "done")).toBe(false)
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "the rest" }, { now: clock })
    expect(wake.tick()).toEqual({ woken: 0, capped: 0, stalled: 1 })
    await flush()
    expect(started).toEqual([])
    expect(jobs.get("job-1")!.note).toMatch(/schedule's job is not woken.*What was left: the rest/)
  })

  it("a job whose agent is not here is stalled, not woken", () => {
    open("job-1", { assignee: "ghost" })
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    expect(wake.tick()).toEqual({ woken: 0, capped: 0, stalled: 1 })
    expect(started).toEqual([])
  })

  it("does nothing when turned off", () => {
    settings.enabled = false
    open()
    jobs.declare("job-1", { state: "continue", wakeAt: clock, note: "x" }, { now: clock })
    clock += HOUR
    expect(wake.tick()).toEqual({ woken: 0, capped: 0, stalled: 0 })
    expect(jobs.get("job-1")!.state).toBe("continue")
  })

  it("has its settings in the config, on by default", () => {
    expect(requestsConfigSchema.parse({}).jobs).toEqual({ enabled: true, wake: DEFAULT_WAKE_SETTINGS })
  })

  it("tells the woken run what to do", () => {
    open("job-1", { home: { kind: "issue", link: "acme/app#12" } })
    const text = wakeText(jobs.get("job-1")!, settings)
    expect(text).toContain("Where the work lives: acme/app#12")
    expect(text).toContain("wake 1 of at most 20")
    expect(text).toMatch(/state the job's state: done with its proof, continue/)
  })
})

describe("the invariant, each minute", () => {
  it("marks an open job with no live run, no wake and no waiter as stalled, after the grace time", () => {
    open()
    expect(wake.tick().stalled).toBe(0) // inside the grace time
    clock += 11 * MIN
    live.add("job-1")
    expect(wake.tick().stalled).toBe(0) // a live run
    live.clear()
    expect(wake.tick().stalled).toBe(1)
    expect(jobs.get("job-1")).toMatchObject({ state: "stalled", note: "run ended 60 min ago with no state" })
    expect(wake.tick().stalled).toBe(0) // once
    expect(jobs.stalledUntold().map((j) => j.id)).toEqual(["job-1"])
  })

  it("leaves a job with an armed wake, a named waiter with a due time, or a hand-off still out", () => {
    open("job-a"); jobs.declare("job-a", { state: "continue", wakeAt: clock + 5 * HOUR, note: "x" }, { now: clock })
    open("job-b"); jobs.declare("job-b", { state: "waiting", on: "devops", until: clock + 2 * HOUR }, { now: clock })
    open("job-c"); held.add("job-c")
    open("job-d"); jobs.declare("job-d", { state: "blocked", why: "no access" }, { now: clock })
    clock += HOUR
    expect(wake.tick().stalled).toBe(0)
    // The wait ran out and nothing came.
    clock += 90 * MIN
    expect(wake.tick().stalled).toBe(1)
    expect(jobs.get("job-b")!.note).toMatch(/^waited on devops until .*, and nothing came$/)
    expect(jobs.get("job-a")!.state).toBe("continue")
    expect(jobs.get("job-c")!.state).toBe("working")
    expect(jobs.get("job-d")!.state).toBe("blocked")
  })

  it("leaves the owner's requests to their own checks until a run declares a job state, and jobs on another node to that node", () => {
    requests.addCandidate({ id: "req-1", runId: "o1", channel: "telegram", chatId: "c1", sender: "owner", agentId: "coder", text: "ship it", now: clock })
    requests.progress("req-1", clock)
    open("job-p", { peer: "clawd", state: "waiting", waitingOn: "devops@clawd" })
    clock += 5 * HOUR
    expect(wake.tick().stalled).toBe(0)
    expect(requests.get("req-1")!.state).toBe("in_progress")
    // Once a run declared a state on the request, the invariant holds it too.
    jobs.declare("req-1", { state: "waiting", on: "devops", until: clock + MIN }, { now: clock })
    clock += HOUR
    expect(wake.tick().stalled).toBe(1)
    expect(jobs.get("req-1")!.state).toBe("stalled")
    expect(requests.get("req-1")!.state).toBe("in_progress")
  })
})

describe("background work belongs to the job", () => {
  const run = { agentId: "coder", channel: "a2a", chatId: "pm" }

  it("a run that ends with background work open leaves the job waiting on it, not closed", () => {
    doors.taskStarted({ ...run, taskId: "t1", messagePreview: "build", at: "", sender: { name: "agent:pm" } } as any)
    background = 2
    doors.taskCompleted({ ...run, taskId: "t1", durationMs: 5, at: "" } as any)
    expect(jobs.get("job-t1")).toMatchObject({
      state: "waiting", waitingOn: BACKGROUND_WAITER, until: clock + 180 * MIN, note: "2 background tasks still running when the run ended",
    })
    expect(wake.tick().stalled).toBe(0)
  })

  it("when the work ends, its closing reply wakes the job instead of being dropped", async () => {
    doors.taskStarted({ ...run, taskId: "t1", messagePreview: "build", at: "", sender: { name: "agent:pm" } } as any)
    background = 1
    doors.taskCompleted({ ...run, taskId: "t1", durationMs: 5, at: "" } as any)
    clock += 20 * MIN
    expect(wake.backgroundEnded(run, "The build passed:\n 412 tests green.")).toBe(true)
    expect(jobs.get("job-t1")).toMatchObject({ state: "continue", wakeAt: clock })
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(started[0].text).toContain("background work you left running has ended. Its closing reply: The build passed: 412 tests green.")
  })

  it("stalls the job when the work never reports back", () => {
    doors.taskStarted({ ...run, taskId: "t1", messagePreview: "build", at: "", sender: { name: "agent:pm" } } as any)
    background = 1
    doors.taskCompleted({ ...run, taskId: "t1", durationMs: 5, at: "" } as any)
    clock += 181 * MIN
    expect(wake.tick().stalled).toBe(1)
    expect(jobs.get("job-t1")!.note).toMatch(/^waited on its background work until/)
  })

  it("drops the reply as before when no open job is in that chat, a run is live, or it is an owner's request nobody declared on", () => {
    expect(wake.backgroundEnded(run, "done")).toBe(false)
    open("job-1")
    live.add("job-1")
    expect(wake.backgroundEnded(run, "done")).toBe(false)
    requests.addCandidate({ id: "req-1", runId: "o1", channel: "telegram", chatId: "c1", sender: "owner", agentId: "coder", text: "ship it", now: clock })
    requests.progress("req-1", clock)
    expect(wake.backgroundEnded({ agentId: "coder", channel: "telegram", chatId: "c1" }, "done")).toBe(false)
    expect(started).toEqual([])
  })

  it("a stray closing reply does not start a blocked, stalled or otherwise waiting job again", () => {
    open("job-1")
    jobs.declare("job-1", { state: "blocked", why: "stopped by the operator" }, { now: clock })
    expect(wake.backgroundEnded(run, "done")).toBe(false)
    expect(jobs.get("job-1")!.state).toBe("blocked")
    open("job-2"); clock += MIN
    jobs.declare("job-2", { state: "waiting", on: "devops", until: clock + HOUR }, { now: clock })
    expect(wake.backgroundEnded(run, "done")).toBe(false)
    expect(jobs.get("job-2")!.state).toBe("waiting")
  })

  it("wakes the job that waits on the work, not a newer job of the same chat", async () => {
    doors.taskStarted({ ...run, taskId: "t1", messagePreview: "build", at: "", sender: { name: "agent:pm" } } as any)
    background = 1
    doors.taskCompleted({ ...run, taskId: "t1", durationMs: 5, at: "" } as any)
    // A newer job in the same chat, working, and another waiting on a person.
    clock += MIN
    open("job-new")
    live.add("job-new")
    clock += MIN
    open("job-other")
    jobs.declare("job-other", { state: "waiting", on: "devops", until: clock + HOUR }, { now: clock })
    expect(jobs.latestInChat("coder", "a2a", "pm")!.id).toBe("job-other")
    clock += MIN
    expect(wake.backgroundEnded(run, "built")).toBe(true)
    expect(jobs.get("job-t1")).toMatchObject({ state: "continue", wakeAt: clock })
    expect(jobs.get("job-new")).toMatchObject({ state: "working", wakeAt: null })
    expect(jobs.get("job-other")).toMatchObject({ state: "waiting", waitingOn: "devops", wakeAt: null })
  })

  it("with several jobs waiting on background work in a chat, each reply wakes the one that waited longest", () => {
    for (const id of ["t1", "t2"]) {
      doors.taskStarted({ ...run, taskId: id, messagePreview: "build", at: "", sender: { name: "agent:pm" } } as any)
      background = 1
      doors.taskCompleted({ ...run, taskId: id, durationMs: 5, at: "" } as any)
      clock += MIN
    }
    expect(wake.backgroundEnded(run, "first")).toBe(true)
    expect(jobs.get("job-t1")!.state).toBe("continue")
    expect(jobs.get("job-t2")!.state).toBe("waiting")
    expect(wake.backgroundEnded(run, "second")).toBe(true)
    expect(jobs.get("job-t2")!.state).toBe("continue")
  })

  it("counts what the turn nobody asked for cost toward the job's cost cap", () => {
    settings.maxCostUsd = 1
    doors.taskStarted({ ...run, taskId: "t1", messagePreview: "build", at: "", sender: { name: "agent:pm" } } as any)
    background = 1
    doors.taskCompleted({ ...run, taskId: "t1", durationMs: 5, at: "" } as any)
    expect(wake.backgroundEnded(run, "built", 1.25)).toBe(true)
    expect(jobs.costUsd("job-t1")).toBeCloseTo(1.25)
    expect(wake.tick()).toEqual({ woken: 0, capped: 1, stalled: 0 })
    expect(jobs.get("job-t1")!.note).toMatch(/cost \$1\.25/)
  })

  it("a job marked stalled while its run was still on it closes when that run ends", () => {
    doors.taskStarted({ ...run, taskId: "t1", messagePreview: "build", at: "", sender: { name: "agent:pm" } } as any)
    expect(doors.hasLiveRun("job-t1")).toBe(true)
    jobs.markStalled("job-t1", "run ended 60 min ago with no state", clock)
    doors.taskCompleted({ ...run, taskId: "t1", durationMs: 5, at: "" } as any)
    expect(jobs.get("job-t1")!.state).toBe("done")
    expect(doors.hasLiveRun("job-t1")).toBe(false)
  })

  it("with no background work open, the run ends as before", () => {
    doors.taskStarted({ ...run, taskId: "t1", messagePreview: "build", at: "", sender: { name: "agent:pm" } } as any)
    doors.taskCompleted({ ...run, taskId: "t1", durationMs: 5, at: "" } as any)
    expect(jobs.get("job-t1")!.state).toBe("done")
  })
})

describe("store", () => {
  it("finds the newest open job of a chat and sums what its runs cost", () => {
    open("job-1"); clock += MIN
    open("job-2")
    jobs.declare("job-2", { state: "done", proof: "p" }, { now: clock })
    expect(jobs.latestInChat("coder", "a2a", "pm")!.id).toBe("job-1")
    expect(jobs.latestInChat("coder", "a2a", "other")).toBeNull()
    db.prepare("INSERT INTO task_traces VALUES ('run-job-1', 'ok', 1, 2, 0.25, NULL)").run()
    jobs.linkRun("job-1", "r2", clock)
    db.prepare("INSERT INTO task_traces VALUES ('r2', 'ok', 1, 2, 0.5, NULL)").run()
    expect(jobs.costUsd("job-1")).toBeCloseTo(0.75)
    const job: JobRecord = jobs.get("job-1")!
    expect(jobs.armWake(job.id, clock + MIN, "try again", clock)).toBe(true)
    expect(jobs.get("job-1")).toMatchObject({ state: "continue", wakeAt: clock + MIN, note: "try again" })
  })
})

describe("other paths wake the job (#1861 box 4)", () => {
  it("wakeFor arms the job's wake, and the next tick starts the run with the note", async () => {
    open()
    expect(wake.wakeFor("job-1", "watcher w-1 fired: the hand-off is overdue")).toBe(true)
    expect(jobs.get("job-1")).toMatchObject({ state: "continue", wakeAt: clock })
    wake.tick()
    await flush()
    expect(started).toHaveLength(1)
    expect(started[0].text).toContain("watcher w-1 fired")
    expect(jobs.get("job-1")!.wakeCount).toBe(1)
  })

  it("wakeFor counts toward the job's cap", async () => {
    open()
    settings.maxWakes = 1
    wake.wakeFor("job-1", "first"); wake.tick()
    jobs.declare("job-1", { state: "waiting", on: "pm", until: clock + HOUR }, { now: clock })
    wake.wakeFor("job-1", "second"); wake.tick()
    await flush()
    expect(started).toHaveLength(1)
    expect(jobs.get("job-1")!.state).toBe("stalled")
  })

  it("wakeFor leaves the caller its old path: wake off, closed, missing, a schedule's or another node's job", () => {
    open()
    settings.enabled = false
    expect(wake.wakeFor("job-1", "x")).toBe(false)
    settings.enabled = true
    expect(wake.wakeFor("nope", "x")).toBe(false)
    open("job-cron", { door: "cron", requester: "cron:daily" })
    expect(wake.wakeFor("job-cron", "x")).toBe(false)
    open("job-peer", { peer: "clawd", remoteId: "r1", state: "waiting", waitingOn: "clawd" })
    expect(wake.wakeFor("job-peer", "x")).toBe(false)
    open("job-ghost", { assignee: "ghost" })
    expect(wake.wakeFor("job-ghost", "x")).toBe(false)
    jobs.declare("job-1", { state: "done", proof: "PR 1" }, { now: clock })
    expect(wake.wakeFor("job-1", "x")).toBe(false)
  })

  it("delegatorJob finds the job that handed the work out, only for that agent", () => {
    open("job-parent", { assignee: "pm", requester: "owner" })
    open("job-dlg-1", { assignee: "coder", requester: "pm", parentId: "job-parent" })
    expect(wake.delegatorJob("dlg-1", "pm")).toBe("job-parent")
    expect(wake.delegatorJob("dlg-1", "someone-else")).toBeNull()
    expect(wake.delegatorJob("dlg-none", "pm")).toBeNull()
    open("job-dlg-2", { assignee: "coder", requester: "pm" })
    expect(wake.delegatorJob("dlg-2", "pm")).toBeNull()
  })
})
