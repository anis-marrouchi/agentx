import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, pickupContext, isPickup, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep } from "../src/requests/sweep"
import { JobStore } from "../src/jobs/store"
import { JobDoors, RUN_ENDED_PROOF, doorOf, homeOfForgeChat, jobsOn } from "../src/jobs/doors"
import { attachRequests } from "../src/requests/attach"
import { getEventBus } from "../src/events/bus"
import { requestsConfigSchema } from "../src/daemon/config"

const ON: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242", "github:the-owner"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let requests: RequestStore
let jobs: JobStore
let tracker: RequestTracker
let doors: JobDoors
let enabled: boolean
let clock: number
let logs: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-doors-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  requests = new RequestStore(db)
  jobs = new JobStore(db)
  clock = 1_000_000
  logs = []
  enabled = true
  tracker = new RequestTracker(requests, () => ON, (m) => logs.push(m), () => clock)
  doors = new JobDoors({ jobs, requests, settings: () => ({ enabled }), log: (m) => logs.push(m), now: () => clock })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A run starts: the tracker sees it first, then the doors, as attached. */
function start(taskId: string, over: Record<string, unknown> = {}) {
  const p = {
    agentId: "coder", channel: "a2a", chatId: "pm", taskId, messagePreview: "build the report",
    fullMessage: "build the report and deploy it", at: new Date(clock).toISOString(),
    sender: { name: "agent:pm" }, humanRoot: false, ...over,
  } as any
  tracker.taskStarted(p)
  doors.taskStarted(p)
}

function end(taskId: string, over: Record<string, unknown> = {}) {
  const p = { agentId: "coder", channel: "a2a", chatId: "pm", taskId, durationMs: 10, at: new Date(clock).toISOString(), ...over } as any
  tracker.taskCompleted(p)
  doors.taskCompleted(p)
}

const ownerTurn = { channel: "telegram", chatId: "chat-1", sender: { name: "Owner", id: "4242" }, humanRoot: true }

describe("which door", () => {
  it("reads the door and the requester from the run", () => {
    expect(doorOf({ channel: "a2a", chatId: "a2a:pm:coder:dlg-1-ab", sender: { name: "agent:pm" } })).toEqual({ door: "a2a", requester: "pm" })
    expect(doorOf({ channel: "a2a", chatId: "pm", sender: { name: "agent:pm" } })).toEqual({ door: "a2a", requester: "pm" })
    expect(doorOf({ channel: "github", chatId: "org/repo:issue:12", sender: { username: "someone" } })).toEqual({ door: "mention", requester: "someone" })
    expect(doorOf({ channel: "gitlab", chatId: "g/p:merge_request:3", sender: { username: "dev" } })).toEqual({ door: "mention", requester: "dev" })
    expect(doorOf({ channel: "cron", chatId: "cron:nightly" })).toEqual({ door: "cron", requester: "cron:nightly" })
    expect(doorOf({ channel: "workflow", chatId: "workflow:run-9", sender: { name: "workflow" } })).toEqual({ door: "workflow", requester: "workflow:run-9" })
    expect(doorOf({ channel: "events", chatId: "coder", humanRoot: false })).toEqual({ door: "api", requester: null })
    // A chat answer to a person who is not the owner is not a job.
    expect(doorOf({ channel: "whatsapp", chatId: "123", sender: { id: "123" }, humanRoot: true })).toBeNull()
  })

  it("reads the home of an issue thread from its chat", () => {
    expect(homeOfForgeChat("Org/Repo:issue:12")).toBe("org/repo#12")
    expect(homeOfForgeChat("org/repo:pull:7")).toBe("org/repo#7")
    expect(homeOfForgeChat("group/sub/project:merge_request:3")).toBe("group/sub/project!3")
    expect(homeOfForgeChat("chat-1")).toBeNull()
  })
})

describe("a run that is not the owner's turn", () => {
  it("opens a job at the a2a door, and closes it when the run ends clean", () => {
    start("t1")
    const job = jobs.byRun("t1")!
    expect(job).toMatchObject({ id: "job-t1", door: "a2a", state: "working", requester: "pm", assignee: "coder", text: "build the report and deploy it" })
    expect(doors.liveJobId("coder", "a2a", "pm")).toBe("job-t1")
    end("t1", { finalResponse: "Done, see https://x.test/pr/4." })
    expect(jobs.get("job-t1")).toMatchObject({ state: "done", proof: "https://x.test/pr/4", declaredRun: "t1" })
    expect(doors.liveJobId("coder", "a2a", "pm")).toBeNull()
  })

  it("closes with a plain proof when the answer gives no link", () => {
    start("t1")
    end("t1", { finalResponse: "ok" })
    expect(jobs.get("job-t1")!.proof).toBe(RUN_ENDED_PROOF)
  })

  it("is blocked when the run fails, times out or is stopped; left alone when a shutdown cut it", () => {
    start("t1"); end("t1", { error: "boom" })
    expect(jobs.get("job-t1")).toMatchObject({ state: "blocked", note: "coder failed: boom" })
    start("t2"); end("t2", { error: "Claude Code timed out after 30m", errorKind: "timeout" })
    expect(jobs.get("job-t2")!.note).toMatch(/^coder timed out: /)
    start("t3"); end("t3", { error: "stop signal", stopped: true })
    expect(jobs.get("job-t3")).toMatchObject({ state: "blocked", note: "coder was stopped: stop signal" })
    start("t4"); end("t4", { interrupted: true, error: "shutdown" })
    expect(jobs.get("job-t4")!.state).toBe("working")
  })

  it("the run that continues a cut-off one belongs to the same job", () => {
    start("t1"); end("t1", { error: "Claude Code timed out after 30m", errorKind: "timeout" })
    start("t2", { resumedFrom: "t1" })
    expect(jobs.byRun("t2")!.id).toBe("job-t1")
    expect(jobs.get("job-t1")!.state).toBe("working")
    end("t2")
    expect(jobs.get("job-t1")!.state).toBe("done")
    expect(jobs.runs("job-t1").map((r) => r.runId)).toEqual(["t1", "t2"])
  })

  it("the turn that asks for the job's state keeps the ask on the job", () => {
    doors = new JobDoors({ jobs, requests, settings: () => ({ enabled }), log: (m) => logs.push(m), now: () => clock, onUndeclared: () => true })
    start("t1"); end("t1")
    expect(jobs.get("job-t1")!.state).toBe("working")
    jobs.markStateAsked("job-t1", clock)
    start("t2", { resumedFrom: "t1", jobStateAsk: true })
    expect(jobs.byRun("t2")!.id).toBe("job-t1")
    expect(jobs.get("job-t1")).toMatchObject({ state: "working", stateAskedAt: clock })
    end("t2")
    expect(jobs.get("job-t1")).toMatchObject({ state: "working", stateAskedAt: clock })
    // A run that takes the work up again clears it.
    start("t3", { resumedFrom: "t1" })
    expect(jobs.get("job-t1")!.stateAskedAt).toBeNull()
  })

  it("a state the run declared itself stands at its end", () => {
    start("t1")
    jobs.declare("job-t1", { state: "continue", wakeAt: clock + 60_000, note: "the build" }, { runId: "t1", now: clock })
    end("t1")
    expect(jobs.get("job-t1")).toMatchObject({ state: "continue", note: "the build" })
  })

  it("lets phase 2 take a clean end with no state", () => {
    const seen: string[] = []
    doors.setOnUndeclared((job) => { seen.push(job.id); return true })
    start("t1"); end("t1")
    expect(seen).toEqual(["job-t1"])
    expect(jobs.get("job-t1")!.state).toBe("working")
  })

  it("opens one job per cron firing and per workflow step, the step under its request", () => {
    start("c1", { channel: "cron", chatId: "cron:nightly", sender: undefined })
    expect(jobs.byRun("c1")).toMatchObject({ door: "cron", requester: "cron:nightly" })
    // The owner's request a workflow run serves.
    start("o1", ownerTurn)
    requests.progress("req-o1", clock)
    requests.link("req-o1", "workflow", "run-9", clock)
    start("w1", { channel: "workflow", chatId: "workflow:run-9", sender: { name: "workflow" } })
    expect(jobs.byRun("w1")).toMatchObject({ door: "workflow", parentId: "req-o1" })
  })

  it("a mention opens a job at its issue; the next comment there continues it", () => {
    const mention = { channel: "github", chatId: "org/repo:issue:12", sender: { username: "someone" }, humanRoot: true }
    start("m1", mention)
    const job = jobs.byRun("m1")!
    expect(job).toMatchObject({ door: "mention", requester: "someone", home: { kind: "issue", link: "org/repo#12" } })
    jobs.declare(job.id, { state: "waiting", on: "someone", until: clock + 3_600_000 }, { runId: "m1", now: clock })
    end("m1", mention)
    start("m2", mention)
    expect(jobs.byRun("m2")!.id).toBe(job.id)
    expect(jobs.get(job.id)!.state).toBe("working")
    end("m2", mention)
    // Closed: the next mention is a new job.
    start("m3", mention)
    expect(jobs.byRun("m3")!.id).toBe("job-m3")
    // A hand-off naming the same home is its own job, with that home.
    start("a1", { home: "https://github.com/org/repo/issues/12" })
    expect(jobs.byRun("a1")).toMatchObject({ id: "job-a1", home: { kind: "issue", link: "org/repo#12" } })
    expect(jobs.get("job-m3")!.state).toBe("working")
  })

  it("leaves a chat answer to another person, and a plan step's pick-up, alone", () => {
    start("p1", { channel: "whatsapp", chatId: "555", sender: { id: "555" }, humanRoot: true })
    expect(jobs.byRun("p1")).toBeNull()
    start("o1", ownerTurn)
    requests.progress("req-o1", clock)
    const ctx = pickupContext("req-o1")
    start("s1", { agentId: "devops", channel: ctx.channel, chatId: ctx.chatId, pickup: isPickup(ctx), sender: { name: "operator" } })
    expect(jobs.byRun("s1")).toBeNull()
    expect(jobs.query({ limit: 50 }).items.map((j) => j.id)).toEqual(["req-o1"])
  })

  it("does nothing when turned off", () => {
    enabled = false
    start("t1")
    expect(jobs.byRun("t1")).toBeNull()
  })
})

describe("the owner's turn", () => {
  it("stays the tracker's: one row, tagged as the owner door, no second job", () => {
    start("o1", ownerTurn)
    expect(jobs.query({ states: ["working"], limit: 10 }).total).toBe(0) // a candidate
    expect(doors.liveJobId("coder", "telegram", "chat-1")).toBe("req-o1")
    requests.progress("req-o1", clock)
    end("o1", ownerTurn)
    expect(jobs.get("req-o1")).toMatchObject({ door: "owner", state: "working", ownerRequest: true })
    expect(db.prepare("SELECT COUNT(*) FROM requests").pluck().get()).toBe(1)
  })

  it("a turn that just answers still leaves nothing", () => {
    start("o1", ownerTurn)
    end("o1", ownerTurn)
    expect(db.prepare("SELECT COUNT(*) FROM requests").pluck().get()).toBe(0)
  })

  it("the owner's mention on an issue is the owner's request, not a mention job", () => {
    start("g1", { channel: "github", chatId: "org/repo:issue:12", sender: { username: "the-owner" }, humanRoot: true })
    expect(jobs.byRun("g1")).toMatchObject({ id: "req-g1", ownerRequest: true })
  })
})

describe("a hand-off this node started", () => {
  const dlg = { id: "dlg-abc-12", caller: "coder", callee: "devops", origin: { channel: "telegram", chatId: "chat-1" } }
  const calleeRun = { agentId: "devops", channel: "a2a", chatId: "a2a:coder:devops:dlg-abc-12", sender: { name: "agent:coder" } }

  it("is a child of the job of the turn that started it, and ends with the delegation", () => {
    start("o1", ownerTurn)
    tracker.delegationStarted(dlg)
    doors.delegationStarted({ ...dlg, request: "deploy the build", home: "org/repo#12" })
    const job = jobs.get("job-dlg-abc-12")!
    expect(job).toMatchObject({
      door: "a2a", state: "working", requester: "coder", assignee: "devops", parentId: "req-o1",
      text: "deploy the build", home: { kind: "issue", link: "org/repo#12" },
    })
    start("d1", calleeRun)
    expect(jobs.byRun("d1")!.id).toBe("job-dlg-abc-12")
    // The callee's run ending does not close it: the delegation does.
    end("d1", { ...calleeRun, finalResponse: "deployed" })
    expect(jobs.get("job-dlg-abc-12")!.state).toBe("working")
    tracker.delegationDone(dlg, "done", "Deployed: https://x.test/deploy/1")
    doors.delegationDone(dlg, "done", "Deployed: https://x.test/deploy/1")
    expect(jobs.get("job-dlg-abc-12")).toMatchObject({ state: "done", proof: "https://x.test/deploy/1" })
    expect(jobs.children("req-o1").map((j) => j.id)).toEqual(["job-dlg-abc-12"])
    // The owner's request moved exactly as before.
    expect(requests.get("req-o1")!.state).toBe("in_progress")
    expect(requests.byLink("delegation", "dlg-abc-12")!.id).toBe("req-o1")
  })

  it("nests: the callee's own hand-off is a child of its job", () => {
    doors.delegationStarted(dlg)
    start("d1", calleeRun)
    doors.delegationStarted({ id: "dlg-def-34", caller: "devops", callee: "qa", origin: { channel: "a2a", chatId: calleeRun.chatId } })
    expect(jobs.get("job-dlg-def-34")!.parentId).toBe("job-dlg-abc-12")
  })

  it("waits when the callee said so, is blocked when it failed, timed out or was lost", () => {
    doors.delegationStarted(dlg)
    doors.delegationDone(dlg, "waiting", "waiting for the build", clock + 3_600_000)
    expect(jobs.get("job-dlg-abc-12")).toMatchObject({ state: "waiting", waitingOn: "devops", until: clock + 3_600_000 })
    doors.delegationDone(dlg, "timeout", "no answer")
    expect(jobs.get("job-dlg-abc-12")).toMatchObject({ state: "blocked", note: "devops did not answer in time: no answer" })
  })

  it("to another node waits on that node, and closes when its answer is back", () => {
    doors.delegationStarted({ ...dlg, peer: "clawd" })
    expect(jobs.get("job-dlg-abc-12")).toMatchObject({ state: "waiting", waitingOn: "devops@clawd", peer: "clawd" })
    doors.delegationDone({ ...dlg, peer: "clawd" }, "done", "ok")
    expect(jobs.get("job-dlg-abc-12")!.state).toBe("done")
  })

  it("a chat id naming someone else's hand-off does not take its job", () => {
    start("d1", calleeRun)
    end("d1", calleeRun)
    // A later run that writes the same chat id gets a job of its own.
    start("x1", calleeRun)
    expect(jobs.byRun("x1")!.id).toBe("job-x1")
    expect(jobs.runs("job-dlg-abc-12").map((r) => r.runId)).toEqual(["d1"])
  })

  it("after a restart, a hand-off still out is known from the delegations", () => {
    doors.delegationStarted(dlg)
    const fresh = new JobDoors({ jobs, requests, settings: () => ({ enabled: true }), log: () => {}, now: () => clock, pendingDelegation: (id) => id === "dlg-abc-12" })
    const p = { ...calleeRun, taskId: "d9", messagePreview: "x", at: "" } as any
    fresh.taskStarted(p)
    expect(jobs.byRun("d9")!.id).toBe("job-dlg-abc-12")
    fresh.taskCompleted({ ...calleeRun, taskId: "d9", durationMs: 1, at: "" } as any)
    expect(jobs.get("job-dlg-abc-12")!.state).toBe("working")
  })

  it("a hand-off that came from another node closes with its run", () => {
    start("d1", calleeRun)
    expect(jobs.byRun("d1")).toMatchObject({ id: "job-dlg-abc-12", requester: "coder" })
    end("d1", calleeRun)
    expect(jobs.get("job-dlg-abc-12")!.state).toBe("done")
  })
})

describe("no behaviour change for the owner's requests", () => {
  it("the requests check sees no job row", async () => {
    start("t1"); end("t1", { error: "boom" })
    start("t2")
    const told: string[] = []
    const result = await runRequestsSweep({
      store: requests, settings: ON, now: clock + 100 * 24 * 3_600_000, log: () => {},
      notify: async (_title, message) => { told.push(message) },
    })
    expect(told).toEqual([])
    expect(result).toEqual({ checked: 0, verified: 0, homesClosed: 0, settled: 0, quiet: 0, notified: 0, pruned: 0, pickedUp: 0, resent: 0, held: 0 })
    expect(jobs.query({ limit: 10 }).total).toBe(2)
  })
})

describe("attached to the bus", () => {
  it("opens jobs after the tracker, and the setting follows requests.enabled when unset", () => {
    expect(requestsConfigSchema.parse({}).jobs.enabled).toBeUndefined()
    expect(jobsOn(requestsConfigSchema.parse({ enabled: true }))).toBe(true)
    expect(jobsOn(requestsConfigSchema.parse({}))).toBe(false)
    expect(jobsOn(requestsConfigSchema.parse({ jobs: { enabled: true } }))).toBe(true)
    expect(jobsOn(requestsConfigSchema.parse({ enabled: true, jobs: { enabled: false } }))).toBe(false)
    const attached = attachRequests(db, () => ({ ...ON, jobs: { enabled: true } }), () => {})
    const bus = getEventBus()
    try {
      bus.emit("task:started", { agentId: "coder", channel: "cron", chatId: "cron:nightly", taskId: "b1", messagePreview: "sweep", at: "" } as any)
      bus.emit("task:started", { agentId: "coder", ...ownerTurn, taskId: "b2", messagePreview: "ship it", at: "" } as any)
      expect(attached.jobs.byRun("b1")).toMatchObject({ door: "cron", state: "working" })
      expect(attached.jobs.byRun("b2")).toMatchObject({ id: "req-b2", ownerRequest: true })
      bus.emit("task:completed", { agentId: "coder", channel: "cron", chatId: "cron:nightly", taskId: "b1", durationMs: 1, at: "" } as any)
      expect(attached.jobs.byRun("b1")!.state).toBe("done")
    } finally {
      attached.detach()
    }
  })

  /** One hand-off run and one owner turn through the bus, with these settings. */
  function through(settings: Partial<RequestSettings>) {
    const attached = attachRequests(db, () => ({ ...ON, ...settings }), () => {})
    const bus = getEventBus()
    try {
      bus.emit("task:started", { agentId: "coder", channel: "a2a", chatId: "pm", taskId: "s1", messagePreview: "build", sender: { name: "agent:pm" }, at: "" } as any)
      bus.emit("task:started", { agentId: "coder", ...ownerTurn, taskId: "s2", messagePreview: "ship it", at: "" } as any)
      return { job: attached.jobs.byRun("s1"), owner: attached.jobs.byRun("s2") }
    } finally {
      attached.detach()
    }
  }

  it("requests off, jobs on: the hand-off opens a job, the owner's turn leaves no record", () => {
    const { job, owner } = through({ enabled: false, jobs: { enabled: true } })
    expect(job).toMatchObject({ door: "a2a", state: "working", requester: "pm" })
    expect(owner).toBeNull()
  })

  it("requests off, jobs unset: nothing opens", () => {
    expect(through({ enabled: false }).job).toBeNull()
  })

  it("requests on, jobs unset: the hand-off opens a job", () => {
    expect(through({ enabled: true }).job).toMatchObject({ door: "a2a" })
  })

  it("jobs off: nothing opens, whatever requests says", () => {
    expect(through({ enabled: true, jobs: { enabled: false } }).job).toBeNull()
  })
})
