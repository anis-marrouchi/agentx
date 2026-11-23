import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"
import { DEFAULT_WAKE_SETTINGS, JobWake } from "../src/jobs/wake"
import { openPromise, setDueTime } from "../src/requests/promise"
import { closeOnStatedDone } from "../src/requests/stated-done"
import { recordRunState } from "../src/jobs/run-state-ledger"
import { jobStateInText } from "../src/agents/run-state"

// Two causes of the open-promise pile (#2081): "State: done" never closed
// the run's own request, and no command set a due time after a run ended.

const MIN = 60_000
const HOUR = 60 * MIN

let tmp: string
let db: Database.Database
let store: RequestStore
let jobs: JobStore
let wake: JobWake
let clock: number
let started: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-2081-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, status TEXT, started_at INTEGER, finished_at INTEGER, cost_usd REAL, error TEXT)")
  store = new RequestStore(db)
  jobs = new JobStore(db)
  clock = Date.UTC(2026, 10, 23, 8, 0, 0)
  started = []
  wake = new JobWake({
    jobs, settings: () => ({ ...DEFAULT_WAKE_SETTINGS }), log: () => {}, now: () => clock,
    facts: () => ({ lastRunEndedAt: clock - HOUR }),
    start: async (job) => { started.push(job.id); return {} },
    hasAgent: () => true,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const promise = (over: Partial<Parameters<typeof openPromise>[1]> = {}) => openPromise(store, {
  agentId: "coder", owedTo: "pm", text: "Open the PR for agentx#2081", channel: "a2a", chatId: "pm-1", now: clock, ...over,
})

/** What the daemon does when a run ends: the state goes on the job, and a done closes the run's request. */
const runEnds = (runId: string, reply: string) => {
  const state = jobStateInText(reply)!
  recordRunState(jobs, [runId], { kind: "stated", state }, clock)
  return state.state === "done" ? closeOnStatedDone(store, [runId], state.proof, clock) : null
}

describe("State: done closes the run's own promise (#2081 cause 1)", () => {
  it("closes the open promise linked to the run, with the proof, for the owner-words check", () => {
    const p = promise()
    store.link(p.id, "run", "run-1", clock)
    const out = runEnds("run-1", "PR opened.\nState: done — https://github.com/anis-marrouchi/agentx/pull/9999")
    expect(out).toEqual({ id: p.id, closed: true })
    expect(store.get(p.id)).toMatchObject({
      state: "done", evidence: "https://github.com/anis-marrouchi/agentx/pull/9999", closedBy: "coder", ownerCheck: "pending",
    })
  })

  it("closes an owner's request the run worked on", () => {
    store.addCandidate({ id: "req-1", runId: "run-2", channel: "telegram", chatId: "c", agentId: "coder", text: "fix the login", now: clock })
    store.progress("req-1", clock)
    expect(runEnds("run-2", "State: done — checked the login on staging, it works")).toEqual({ id: "req-1", closed: true })
    expect(store.get("req-1")?.state).toBe("done")
  })

  it("leaves a promise open when the proof has no link, and a run with no request alone", () => {
    const p = promise()
    store.link(p.id, "run", "run-3", clock)
    expect(runEnds("run-3", "State: done — all good")).toMatchObject({ id: p.id, closed: false })
    expect(store.get(p.id)?.state).toBe("in_progress")
    expect(runEnds("run-none", "State: done — https://x.test/1")).toBeNull()
  })

  it("leaves a loop with a checker to its check, and a continue changes nothing", () => {
    const p = promise({ closeWhen: { kind: "url", url: "https://x.test/up" } as any })
    store.link(p.id, "run", "run-4", clock)
    expect(runEnds("run-4", "State: done — https://x.test/up")).toMatchObject({ closed: false, why: "its check closes it" })
    const q = promise({ text: "second" })
    store.link(q.id, "run", "run-5", clock)
    expect(runEnds("run-5", "State: continue — tests, 2026-11-23T12:00:00Z")).toBeNull()
    expect(store.get(q.id)?.state).toBe("in_progress")
  })
})

describe("agentx requests due sets a due time after a run and arms its check (#2081 cause 2)", () => {
  it("sets the due time of an open promise and wakes its agent then", async () => {
    const p = promise()
    expect(store.get(p.id)?.dueAt ?? null).toBeNull()
    expect(setDueTime(store, p.id, clock + 2 * HOUR, clock)).toEqual({ wake: "armed" })
    expect(store.get(p.id)?.dueAt).toBe(clock + 2 * HOUR)
    clock += HOUR
    expect(wake.tick().woken).toBe(0)
    clock += HOUR
    expect(wake.tick().woken).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual([p.id])
  })

  it("moves the wake when the due time changes, later or sooner", () => {
    const p = promise({ dueAt: clock + 2 * HOUR })
    expect(setDueTime(store, p.id, clock + 5 * HOUR, clock)).toEqual({ wake: "moved" })
    clock += 3 * HOUR
    expect(wake.tick().woken).toBe(0)
    expect(setDueTime(store, p.id, clock + HOUR, clock)).toEqual({ wake: "moved" })
    clock += HOUR
    expect(wake.tick().woken).toBe(1)
  })

  it("refuses a closed request, a past time, and an unknown id", () => {
    const p = promise()
    expect(setDueTime(store, p.id, clock - 1, clock)).toBe("the due time must be ahead")
    store.close(p.id, "done", "https://x.test/1", clock)
    expect(setDueTime(store, p.id, clock + HOUR, clock)).toMatch(/is closed/)
    expect(setDueTime(store, "nope", clock + HOUR, clock)).toBe('no request "nope"')
  })
})
