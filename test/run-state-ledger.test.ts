import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"
import { DEFAULT_STATE_WAIT_MS, recordRunState, toDeclaration } from "../src/jobs/run-state-ledger"

const T0 = Date.UTC(2026, 10, 14, 18, 0, 0)

let tmp: string
let db: Database.Database
let jobs: JobStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-run-state-ledger-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  new RequestStore(db)
  jobs = new JobStore(db)
  jobs.open({ id: "job-1", door: "a2a", requester: "pm", assignee: "coder", channel: "a2a", chatId: "pm", text: "build", runId: "trace-1", now: T0 })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe("a run's state as a job declaration", () => {
  it("reads the times it can, and looks again in an hour when it cannot", () => {
    expect(toDeclaration({ state: "continue", left: "docs", when: "2026-11-14T20:00:00Z" }, T0))
      .toEqual({ state: "continue", wakeAt: Date.UTC(2026, 10, 14, 20), note: "docs" })
    expect(toDeclaration({ state: "continue", left: "docs", when: "tonight" }, T0))
      .toEqual({ state: "continue", wakeAt: T0 + DEFAULT_STATE_WAIT_MS, note: "docs (tonight)" })
    expect(toDeclaration({ state: "waiting", on: "devops" }, T0))
      .toEqual({ state: "waiting", on: "devops", until: T0 + DEFAULT_STATE_WAIT_MS })
    expect(toDeclaration({ state: "done", proof: "PR #9" }, T0)).toEqual({ state: "done", proof: "PR #9" })
  })
})

describe("recordRunState", () => {
  it("writes the state on the job of the first run that has one", () => {
    expect(recordRunState(jobs, [undefined, "nope", "trace-1"], { kind: "stated", state: { state: "waiting", on: "devops review", until: "2026-11-14T21:00:00Z" } }, T0)).toBe("job-1")
    expect(jobs.get("job-1")).toMatchObject({ state: "waiting", waitingOn: "devops review", until: Date.UTC(2026, 10, 14, 21), declaredRun: "nope" })
  })

  it("closes a job done with its proof", () => {
    recordRunState(jobs, ["trace-1"], { kind: "stated", state: { state: "done", proof: "PR #9" } }, T0)
    expect(jobs.get("job-1")).toMatchObject({ state: "done", proof: "PR #9" })
  })

  it("records the ask, then the stall, with its requester told by the answer", () => {
    recordRunState(jobs, ["trace-1"], { kind: "asked" }, T0)
    expect(jobs.get("job-1")?.stateAskedAt).toBe(T0)
    recordRunState(jobs, ["trace-1"], { kind: "stalled", reason: "no state" }, T0 + 1)
    expect(jobs.get("job-1")).toMatchObject({ state: "stalled", note: "no state", stalledAt: T0 + 1, requesterToldAt: T0 + 1 })
    expect(jobs.stalledUntold()).toEqual([])
  })

  it("leaves a run with no job alone", () => {
    expect(recordRunState(jobs, ["other"], { kind: "stalled", reason: "x" }, T0)).toBeNull()
    expect(jobs.get("job-1")?.state).toBe("working")
  })
})
