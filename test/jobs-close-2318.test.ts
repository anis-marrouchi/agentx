import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"

// #2318: a stalled job whose chat is closed can be closed by its requester
// or assignee, with a proof line, and the row keeps who, when and the proof.

const T0 = Date.UTC(2026, 10, 26, 10, 0, 0)
let tmp: string
let db: Database.Database
let requests: RequestStore
let jobs: JobStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-2318-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  requests = new RequestStore(db)
  jobs = new JobStore(db)
  // A hand-off from pm to devops on a chat that is closed now: no run
  // can start there, and the job stalled.
  jobs.open({ id: "job-1", door: "a2a", requester: "pm-agent", assignee: "devops-agent", channel: "a2a", chatId: "dlg-closed", text: "deploy 0.277.0", now: T0 })
  jobs.markStalled("job-1", "no run, no wake, no waiter", T0 + 1000)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const close = (by: string, over: Partial<Parameters<JobStore["closeFromOutside"]>[1]> = {}) =>
  jobs.closeFromOutside("job-1", { state: "done", proof: "clawd /health answers 0.277.0 bffdedf7", by, now: T0 + 5000, ...over })

describe("closing a stalled job from outside its chat (#2318)", () => {
  it("its requester closes it as done, and the row keeps who, when and the proof", () => {
    expect(jobs.get("job-1")!.state).toBe("stalled")
    expect(close("pm-agent")).toBeNull()
    const j = jobs.get("job-1")!
    expect(j).toMatchObject({ state: "done", closedBy: "pm-agent", closedAt: T0 + 5000, proof: "clawd /health answers 0.277.0 bffdedf7" })
    expect(j.note).toBe("closed by pm-agent from outside its chat")
    expect(jobs.listOpen().map((x) => x.id)).not.toContain("job-1")
  })

  it("its assignee drops it", () => {
    expect(close("devops-agent", { state: "dropped", proof: "replaced by job-2" })).toBeNull()
    expect(jobs.get("job-1")).toMatchObject({ state: "dropped", closedBy: "devops-agent" })
  })

  it("anyone else is refused, and the job stays stalled", () => {
    expect(close("coder-agent")).toMatch(/only its requester \(pm-agent\) or its assignee \(devops-agent\)/)
    expect(close("owner")).toMatch(/only its requester/)
    expect(jobs.get("job-1")).toMatchObject({ state: "stalled", closedBy: null, closedAt: null })
  })

  it("needs a proof line, and a closed job is not closed twice", () => {
    expect(close("pm-agent", { proof: "   " })).toBe("a close needs its proof line")
    expect(close("pm-agent")).toBeNull()
    expect(close("devops-agent")).toMatch(/already closed \(done\)/)
    expect(jobs.get("job-1")!.closedBy).toBe("pm-agent")
  })

  it("refuses a job a run is on, and an owner's request", () => {
    jobs.open({ id: "job-2", door: "a2a", requester: "pm-agent", assignee: "coder", channel: "a2a", chatId: "c", text: "x", now: T0 })
    expect(jobs.closeFromOutside("job-2", { state: "done", proof: "p", by: "pm-agent", now: T0 })).toMatch(/has a run on it/)
    requests.addCandidate({ id: "req-1", runId: "run-req-1", channel: "telegram", chatId: "c1", sender: "anis", agentId: "coder", text: "ship it", now: T0 })
    requests.progress("req-1", T0)
    expect(jobs.closeFromOutside("req-1", { state: "done", proof: "p", by: "coder", now: T0 })).toMatch(/is a request: close it with agentx requests/)
    expect(jobs.closeFromOutside("job-none", { state: "done", proof: "p", by: "pm-agent", now: T0 })).toBe('no job "job-none"')
  })
})
