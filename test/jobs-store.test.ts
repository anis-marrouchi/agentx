import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore, OPEN_STATES } from "../src/requests/store"
import { JobStore, JOB_COLUMNS, JOB_ROW_STATE, ensureJobColumns } from "../src/jobs/store"
import { isOwned, statusLine, stallReason, ago } from "../src/jobs/status"
import { handleJobsApi } from "../src/jobs/api"

const MIN = 60_000
const HOUR = 60 * MIN

let tmp: string
let db: Database.Database
let requests: RequestStore
let jobs: JobStore
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0)

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-jobs-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  requests = new RequestStore(db)
  jobs = new JobStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function openA2a(id = "job-1", over: Partial<Parameters<JobStore["open"]>[0]> = {}) {
  return jobs.open({
    id, door: "a2a", requester: "pm", assignee: "coder", channel: "a2a", chatId: "pm",
    text: "build the report", runId: `run-${id}`, now: T0, ...over,
  })
}

/** An owner's request, open and in progress. */
function ownerRequest(id = "req-1") {
  requests.addCandidate({ id, runId: `run-${id}`, channel: "telegram", chatId: "c1", sender: "anis", agentId: "coder", text: "ship it", now: T0 })
  requests.progress(id, T0)
}

describe("job columns", () => {
  it("adds every job column to a requests table from before them, twice without harm", () => {
    const old = new Database(path.join(tmp, "old.sqlite"))
    old.exec("CREATE TABLE requests (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL, sender TEXT, agent_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
    old.prepare("INSERT INTO requests VALUES ('req-old', 'in_progress', 'telegram', 'c', 'anis', 'coder', 'old work', 1, 1)").run()
    ensureJobColumns(old)
    ensureJobColumns(old)
    const cols = (old.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>).map((c) => c.name)
    for (const [name] of JOB_COLUMNS) expect(cols).toContain(name)
    const job = new JobStore(old).get("req-old")
    expect(job).toMatchObject({ door: "owner", state: "working", assignee: "coder", ownerRequest: true })
    old.close()
  })
})

describe("a job opened at another door", () => {
  it("is working, linked to its run, with requester, assignee, home and parent", () => {
    openA2a("job-p")
    expect(openA2a("job-1", { parentId: "job-p", home: { kind: "issue", link: "https://x.test/i/1" } })).toBe(true)
    const job = jobs.get("job-1")!
    expect(job).toMatchObject({
      door: "a2a", state: "working", requester: "pm", assignee: "coder", parentId: "job-p",
      home: { kind: "issue", link: "https://x.test/i/1" }, ownerRequest: false, wakeCount: 0,
    })
    expect(jobs.byRun("run-job-1")?.id).toBe("job-1")
    expect(jobs.children("job-p").map((j) => j.id)).toEqual(["job-1"])
    // A hand-off that names the issue is not the job a new comment continues.
    expect(jobs.openAtHome("coder", "https://x.test/i/1")).toBeNull()
  })

  it("continues only a mention job at its home", () => {
    const home = { kind: "issue" as const, link: "https://x.test/i/1" }
    openA2a("job-a2a", { home })
    expect(openA2a("job-m", { door: "mention", requester: "someone", chatId: "group/p:issue:1", home, now: T0 - 1 })).toBe(true)
    expect(jobs.openAtHome("coder", "https://x.test/i/1")?.id).toBe("job-m")
    expect(jobs.openAtHome("other", "https://x.test/i/1")).toBeNull()
    jobs.declare("job-m", { state: "done", proof: "fixed in abc123" }, { now: T0 + 1 })
    expect(jobs.openAtHome("coder", "https://x.test/i/1")).toBeNull()
  })

  it("does not open twice under one id", () => {
    expect(openA2a()).toBe(true)
    expect(openA2a("job-1", { text: "another" })).toBe(false)
    expect(jobs.get("job-1")!.text).toBe("build the report")
  })

  it("is invisible to every reader of the owner's requests", () => {
    openA2a()
    jobs.markStalled("job-1", "run ended with no state", T0 + HOUR)
    expect(requests.listOpen()).toEqual([])
    expect(requests.awaitingNotice()).toEqual([])
    expect(requests.quietSince([...OPEN_STATES], T0 + 100 * HOUR)).toEqual([])
    expect(requests.overdue(T0 + 100 * HOUR, T0 + 100 * HOUR)).toEqual([])
    expect(requests.withoutHeadline()).toEqual([])
    expect(requests.flowRows(0)).toEqual([])
    expect(requests.query({ states: [...OPEN_STATES, "done", "declined", "dropped"], limit: 10 }).total).toBe(0)
    expect(requests.get("job-1")).toBeNull()
    expect(requests.byLink("run", "run-job-1")).toBeNull()
    expect(db.prepare("SELECT state FROM requests WHERE id = 'job-1'").pluck().get()).toBe(JOB_ROW_STATE)
  })
})

describe("what a run declares", () => {
  it("done closes a job row with its proof, and a closed job takes nothing more", () => {
    openA2a()
    expect(jobs.declare("job-1", { state: "done", proof: "https://x.test/pr/9" }, { runId: "run-job-1", now: T0 + MIN })).toBe(true)
    expect(jobs.get("job-1")).toMatchObject({ state: "done", proof: "https://x.test/pr/9", closedAt: T0 + MIN, declaredRun: "run-job-1" })
    expect(jobs.declare("job-1", { state: "blocked", why: "late" }, { now: T0 + 2 * MIN })).toBe(false)
    expect(jobs.working("job-1", T0 + 2 * MIN)).toBe(false)
    expect(jobs.markStalled("job-1", "x", T0 + 2 * MIN)).toBe(false)
  })

  it("done needs a proof", () => {
    openA2a()
    expect(() => jobs.declare("job-1", { state: "done", proof: "  " }, { now: T0 })).toThrow(/proof/)
  })

  it("continue arms a wake with what is left; a new run clears it", () => {
    openA2a()
    jobs.declare("job-1", { state: "continue", wakeAt: T0 + HOUR, note: "the build" }, { now: T0 + MIN })
    expect(jobs.get("job-1")).toMatchObject({ state: "continue", wakeAt: T0 + HOUR, note: "the build" })
    expect(jobs.dueWakes(T0 + 30 * MIN)).toEqual([])
    expect(jobs.dueWakes(T0 + HOUR).map((j) => j.id)).toEqual(["job-1"])
    expect(jobs.takeWake("job-1", T0 + HOUR)).toBe(true)
    expect(jobs.takeWake("job-1", T0 + HOUR)).toBe(false)
    expect(jobs.get("job-1")).toMatchObject({ wakeAt: null, wakeCount: 1 })
    jobs.working("job-1", T0 + HOUR)
    expect(jobs.get("job-1")!.state).toBe("working")
  })

  it("waiting names who and until when; blocked says why", () => {
    openA2a()
    jobs.declare("job-1", { state: "waiting", on: "devops", until: T0 + 2 * HOUR }, { now: T0 })
    expect(jobs.get("job-1")).toMatchObject({ state: "waiting", waitingOn: "devops", until: T0 + 2 * HOUR })
    expect(() => jobs.declare("job-1", { state: "waiting", on: " ", until: 1 }, { now: T0 })).toThrow(/waits on/)
    jobs.declare("job-1", { state: "blocked", why: "no access to the server" }, { now: T0 })
    expect(jobs.get("job-1")).toMatchObject({ state: "blocked", note: "no access to the server", waitingOn: null })
  })

  it("on an owner's request, keeps the state beside the request's own and never closes it", () => {
    ownerRequest()
    expect(jobs.declare("req-1", { state: "continue", wakeAt: T0 + HOUR, note: "tests" }, { now: T0 })).toBe(true)
    expect(jobs.get("req-1")).toMatchObject({ state: "continue", door: "owner", ownerRequest: true })
    expect(requests.get("req-1")!.state).toBe("in_progress")
    expect(jobs.declare("req-1", { state: "done", proof: "https://x.test/1" }, { now: T0 })).toBe(false)
    expect(requests.get("req-1")!.state).toBe("in_progress")
    // Closed by its own machinery: the job is done whatever was declared.
    requests.close("req-1", "done", "https://x.test/1", T0 + MIN, null, "owner")
    expect(jobs.get("req-1")).toMatchObject({ state: "done", proof: "https://x.test/1" })
  })
})

describe("an owner's request read as a job", () => {
  it("maps each request state", () => {
    ownerRequest("req-a")
    ownerRequest("req-b"); requests.waitOnOwner("req-b", "which colour?", T0)
    ownerRequest("req-c"); requests.progress("req-c", T0, "waiting_other")
    ownerRequest("req-d"); requests.needsAttention("req-d", "coder failed: boom", T0)
    ownerRequest("req-e"); requests.close("req-e", "dropped", "not needed", T0, null, "owner")
    expect(jobs.get("req-a")).toMatchObject({ state: "working", requester: "anis" })
    expect(jobs.get("req-b")).toMatchObject({ state: "waiting", waitingOn: "owner", note: "which colour?" })
    expect(jobs.get("req-c")!.state).toBe("waiting")
    expect(jobs.get("req-d")).toMatchObject({ state: "blocked", note: "coder failed: boom" })
    expect(jobs.get("req-e")!.state).toBe("dropped")
  })
})

describe("stalled", () => {
  it("is marked once, and its requester is told once", () => {
    openA2a()
    expect(jobs.markStalled("job-1", "run ended 3 h ago with no state", T0 + 3 * HOUR)).toBe(true)
    expect(jobs.markStalled("job-1", "again", T0 + 4 * HOUR)).toBe(false)
    expect(jobs.get("job-1")).toMatchObject({ state: "stalled", stalledAt: T0 + 3 * HOUR, note: "run ended 3 h ago with no state" })
    expect(jobs.stalledUntold().map((j) => j.id)).toEqual(["job-1"])
    expect(jobs.markRequesterTold("job-1", T0 + 3 * HOUR)).toBe(true)
    expect(jobs.markRequesterTold("job-1", T0 + 3 * HOUR)).toBe(false)
    expect(jobs.stalledUntold()).toEqual([])
    // A new run takes it out of stalled, and a later stall is told again.
    jobs.working("job-1", T0 + 5 * HOUR)
    expect(jobs.get("job-1")).toMatchObject({ state: "working", stalledAt: null, requesterToldAt: null })
  })

  it("asks a run for its state once", () => {
    openA2a()
    expect(jobs.markStateAsked("job-1", T0)).toBe(true)
    expect(jobs.markStateAsked("job-1", T0)).toBe(false)
    jobs.working("job-1", T0 + MIN)
    expect(jobs.markStateAsked("job-1", T0 + MIN)).toBe(true)
  })
})

describe("lists", () => {
  it("filters by state, door, assignee, requester and parent, newest activity first", () => {
    ownerRequest("req-1")
    openA2a("job-1")
    openA2a("job-2", { assignee: "devops", parentId: "job-1", now: T0 + MIN })
    jobs.open({ id: "job-3", door: "cron", requester: "cron:nightly", assignee: "coder", channel: "cron", chatId: "nightly", text: "sweep", now: T0 + 2 * MIN })
    jobs.declare("job-3", { state: "done", proof: "ran" }, { now: T0 + 3 * MIN })
    expect(jobs.query({ limit: 10 }).total).toBe(4)
    expect(jobs.query({ states: ["working"], limit: 10 }).items.map((j) => j.id)).toEqual(["job-2", "job-1", "req-1"])
    expect(jobs.query({ door: "owner", limit: 10 }).items.map((j) => j.id)).toEqual(["req-1"])
    expect(jobs.query({ door: "cron", limit: 10 }).items.map((j) => j.id)).toEqual(["job-3"])
    expect(jobs.query({ assignee: "devops", limit: 10 }).items.map((j) => j.id)).toEqual(["job-2"])
    expect(jobs.query({ requester: "anis", limit: 10 }).items.map((j) => j.id)).toEqual(["req-1"])
    expect(jobs.query({ parentId: "job-1", limit: 10 }).items.map((j) => j.id)).toEqual(["job-2"])
    expect(jobs.query({ roots: true, limit: 10 }).total).toBe(3)
    expect(jobs.listOpen().map((j) => j.id)).toEqual(["req-1", "job-1", "job-2"])
    expect(jobs.counts()).toMatchObject({ working: 3, done: 1, stalled: 0 })
  })

  it("leaves a turn still being answered out", () => {
    requests.addCandidate({ id: "req-c", runId: "r", channel: "telegram", chatId: "c", agentId: "coder", text: "hi", now: T0 })
    expect(jobs.query({ limit: 10 }).total).toBe(0)
    expect(jobs.listOpen()).toEqual([])
  })

  it("prunes finished job rows only", () => {
    ownerRequest("req-1"); requests.close("req-1", "done", "https://x.test", T0, null, "owner")
    openA2a("job-1"); jobs.declare("job-1", { state: "done", proof: "p" }, { now: T0 })
    openA2a("job-2", { now: T0 + HOUR })
    expect(jobs.pruneDone(T0 + 1)).toBe(1)
    expect(jobs.get("job-1")).toBeNull()
    expect(jobs.get("job-2")).not.toBeNull()
    expect(jobs.get("req-1")).not.toBeNull()
  })

  it("ages out blocked, stalled and orphaned working job rows by their last move", () => {
    ownerRequest("req-1")
    openA2a("job-b"); jobs.declare("job-b", { state: "blocked", why: "the run failed" }, { now: T0 })
    openA2a("job-s"); jobs.markStalled("job-s", "no live run", T0)
    openA2a("job-w") // its run was cut by a restart: nothing moved it since
    openA2a("job-c"); jobs.declare("job-c", { state: "continue", wakeAt: T0 + 400 * 24 * HOUR, note: "later" }, { now: T0 })
    openA2a("job-n"); jobs.working("job-n", T0 + 2 * HOUR)
    expect(jobs.pruneDone(T0 + HOUR)).toBe(3)
    expect(["job-b", "job-s", "job-w"].map((id) => jobs.get(id))).toEqual([null, null, null])
    expect(jobs.get("job-c")).not.toBeNull()
    expect(jobs.get("job-n")).not.toBeNull()
    expect(jobs.get("req-1")).not.toBeNull()
  })

  it("lists a job's runs with what their traces say", () => {
    db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, status TEXT, started_at INTEGER, finished_at INTEGER, cost_usd REAL, error TEXT)")
    db.prepare("INSERT INTO task_traces VALUES ('run-job-1', 'ok', ?, ?, 0.12, NULL)").run(T0, T0 + MIN)
    openA2a()
    jobs.linkRun("job-1", "run-2", T0 + HOUR)
    expect(jobs.runs("job-1")).toEqual([
      { runId: "run-job-1", linkedAt: T0, status: "ok", startedAt: T0, finishedAt: T0 + MIN, costUsd: 0.12, error: null },
      { runId: "run-2", linkedAt: T0 + HOUR, status: null, startedAt: null, finishedAt: null, costUsd: null, error: null },
    ])
  })
})

describe("status line and the invariant", () => {
  const now = T0 + 3 * HOUR
  it("says what holds the job, from facts", () => {
    openA2a()
    const working = jobs.get("job-1")!
    expect(statusLine(working, { liveRun: { runId: "r", startedAt: now - 5 * MIN, lastToolAt: now - 40_000 } }, now)).toBe("working, last tool call 40 s ago")
    expect(statusLine(working, { liveRun: { runId: "r", startedAt: now - 5 * MIN } }, now)).toBe("working, run started 5 min ago")
    expect(isOwned(working, { liveRun: { runId: "r", startedAt: now } }, now)).toBe(true)
    expect(isOwned(working, { lastRunEndedAt: T0 }, now)).toBe(false)
    expect(stallReason(working, { lastRunEndedAt: T0 }, now)).toBe("run ended 3 h ago with no state")
    expect(statusLine(working, { lastRunEndedAt: T0 }, now)).toBe("nobody on it, run ended 3 h ago with no state")

    jobs.declare("job-1", { state: "continue", wakeAt: now + HOUR, note: "the build" }, { now })
    const sleeping = jobs.get("job-1")!
    expect(statusLine(sleeping, {}, now)).toMatch(/^sleeping until \d\d:\d\d for the build$/)
    expect(isOwned(sleeping, {}, now)).toBe(true)

    jobs.declare("job-1", { state: "waiting", on: "devops", until: now + HOUR }, { now })
    const waiting = jobs.get("job-1")!
    expect(statusLine(waiting, {}, now)).toMatch(/^waiting on devops until \d\d:\d\d$/)
    expect(isOwned(waiting, {}, now)).toBe(true)
    expect(isOwned(waiting, {}, now + 2 * HOUR)).toBe(false)
    expect(stallReason(waiting, {}, now + 2 * HOUR)).toMatch(/^waited on devops until .*, and nothing came$/)

    jobs.markStalled("job-1", "run ended 3 h ago with no state", now)
    expect(statusLine(jobs.get("job-1")!, {}, now)).toBe("stalled, run ended 3 h ago with no state")
    expect(isOwned(jobs.get("job-1")!, {}, now)).toBe(true)
  })

  it("an owner request waiting with no due time is not owned", () => {
    ownerRequest(); requests.progress("req-1", T0, "waiting_other")
    expect(isOwned(jobs.get("req-1")!, {}, now)).toBe(false)
    expect(ago(49 * HOUR)).toBe("2 d")
  })
})

describe("GET /jobs", () => {
  const get = (p: string, q = "") => handleJobsApi("GET", p, { store: jobs, query: new URLSearchParams(q), now: T0 + HOUR })

  it("lists open jobs by default, each with its status line, and the counts", () => {
    ownerRequest("req-1")
    openA2a("job-1")
    openA2a("job-2"); jobs.declare("job-2", { state: "done", proof: "https://x.test/pr/2" }, { now: T0 })
    const open = get("/jobs").body as any
    expect(open.jobs.map((j: any) => j.id).sort()).toEqual(["job-1", "req-1"])
    expect(open.total).toBe(2)
    expect(open.counts).toMatchObject({ working: 2, done: 1 })
    expect(open.jobs[0].status).toMatch(/^nobody on it/)
    const all = get("/jobs", "state=all").body as any
    expect(all.total).toBe(3)
    const done = get("/jobs", "state=done&door=a2a&agent=coder").body as any
    expect(done.jobs.map((j: any) => [j.id, j.status])).toEqual([["job-2", "done: https://x.test/pr/2"]])
  })

  it("refuses bad filters and writes", () => {
    expect(get("/jobs", "state=nope").status).toBe(400)
    expect(get("/jobs", "door=window").status).toBe(400)
    expect(get("/jobs", "limit=0").status).toBe(400)
    expect(handleJobsApi("POST", "/jobs", { store: jobs }).status).toBe(405)
  })

  it("returns one job with its runs, parent and children", () => {
    openA2a("job-p")
    openA2a("job-1", { parentId: "job-p" })
    openA2a("job-c", { parentId: "job-1" })
    const one = get("/jobs/job-1")
    expect(one.status).toBe(200)
    const body = one.body as any
    expect(body.job.id).toBe("job-1")
    expect(body.parent.id).toBe("job-p")
    expect(body.children.map((j: any) => j.id)).toEqual(["job-c"])
    expect(body.runs.map((r: any) => r.runId)).toEqual(["run-job-1"])
    expect(get("/jobs/none").status).toBe(404)
  })

  it("uses the daemon's live facts when given", () => {
    openA2a()
    const reply = handleJobsApi("GET", "/jobs", {
      store: jobs, now: T0 + HOUR,
      facts: () => ({ liveRun: { runId: "run-job-1", startedAt: T0, lastToolAt: T0 + HOUR - 40_000 } }),
    })
    expect((reply.body as any).jobs[0].status).toBe("working, last tool call 40 s ago")
  })
})

describe("the retired watcher ledger (#1861 phase 4)", () => {
  const table = (d: Database.Database) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_watchers'").get()

  it("is dropped when empty, and kept with its rows when not", () => {
    const empty = new Database(path.join(tmp, "empty.sqlite"))
    empty.exec("CREATE TABLE task_watchers (id TEXT PRIMARY KEY, summary TEXT NOT NULL)")
    new JobStore(empty)
    expect(table(empty)).toBeUndefined()
    empty.close()

    const kept = new Database(path.join(tmp, "kept.sqlite"))
    kept.exec("CREATE TABLE task_watchers (id TEXT PRIMARY KEY, summary TEXT NOT NULL)")
    kept.prepare("INSERT INTO task_watchers VALUES ('w-1', 'old watcher')").run()
    new JobStore(kept)
    expect(kept.prepare("SELECT summary FROM task_watchers").pluck().all()).toEqual(["old watcher"])
    kept.close()

    // A database that never had it: nothing to do.
    expect(table(db)).toBeUndefined()
  })
})
