import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { attentionText, pickupEnded, runRequestsSweep } from "../src/requests/sweep"
import { resendCause } from "../src/requests/resend"

// Resend once (#1542): a request stopped by a usage limit or a restart goes
// back to its agent one time, on its own, and the owner hears of it only
// if that does not fix it.

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse("2030-03-01T12:00:00Z")

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let settings: RequestSettings
let clock: number
let told: string[]
let sent: Array<{ agentId: string; text: string }>
let held: boolean

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-resend-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  settings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
  clock = T0
  told = []
  sent = []
  held = false
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function start(taskId: string) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId,
    messagePreview: "fix it", fullMessage: "fix the login bug",
    at: new Date(clock).toISOString(), humanRoot: true, sender: { name: "Owner", id: "4242" },
  } as any)
}
function fail(taskId: string, error: string) {
  tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, durationMs: 10, error, at: new Date(clock).toISOString() } as any)
}
function interrupt(taskId: string) {
  tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, durationMs: 10, interrupted: true, at: new Date(clock).toISOString() } as any)
}

const sweep = (over: Partial<Parameters<typeof runRequestsSweep>[0]> = {}) =>
  runRequestsSweep({
    store, settings, log: () => {}, now: clock,
    hasAgent: () => true,
    limitHeld: () => held,
    notify: async (title, text) => { told.push(text) },
    tellAgent: async (agentId, text) => { sent.push({ agentId, text }) },
    ...over,
  })

describe("what counts as mechanical", () => {
  it("reads limits and restarts, and nothing else", () => {
    expect(resendCause("coder failed: You've hit your weekly limit · resets Nov 3")).toBe("limit")
    expect(resendCause("coder failed: 429 Too Many Requests")).toBe("limit")
    expect(resendCause("The work handed to devops failed: rate_limit_error")).toBe("limit")
    expect(resendCause("Cut off by a restart and not picked up again (started 45 min ago (limit 30))")).toBe("restart")
    expect(resendCause("Cut off by a restart and not picked up again (no record of how to resume it)")).toBe("restart")
    expect(resendCause(`Cut off by a restart and not picked up again (nothing would deliver its answer (channel "none"))`)).toBe("restart")
    expect(resendCause("Cut off by a restart and not picked up again (resume failed: spawn ENOENT)")).toBe("restart")
    expect(resendCause("The work handed to devops was lost in a restart: gone")).toBe("restart")
    expect(resendCause("The answer from devops was not passed on after a restart (x). It said: y")).toBe("restart")
    expect(resendCause("coder failed: TypeError: cannot read x")).toBeNull()
    expect(resendCause("No activity for 24 h")).toBeNull()
    expect(resendCause(null)).toBeNull()
  })

  it("leaves restarts the resume step chose not to run again to the owner", () => {
    for (const why of [
      "stopped by stop-all ord-1: it resumes from its plan",
      "delegation result relay: the delegation manager runs it again",
      "stop signal wind-down: its task got a plan from the trace",
      "scheduled job: the next scheduled run covers it",
      "3+ restarts within 10 min; not resuming",
      "cut off again while resuming; not retried",
      "workflow step: the workflow engine owns retries",
      "resume is turned off",
      `channel "telegram" is set to report only`,
      "no session",
    ]) expect(resendCause(`Cut off by a restart and not picked up again (${why})`), why).toBeNull()
  })
})

describe("resend once", () => {
  it("holds a limit failure until the hold lifts, then resends it once without telling the owner", async () => {
    start("t1")
    fail("t1", "Claude AI usage limit reached")
    clock += 10 * MIN
    held = true
    let res = await sweep()
    expect(res).toMatchObject({ held: 1, resent: 0, notified: 0 })
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", notifiedAt: null })
    expect(told).toEqual([])

    held = false
    clock += MIN
    res = await sweep()
    expect(res).toMatchObject({ resent: 1, pickedUp: 1, notified: 0 })
    expect(store.get("req-t1")).toMatchObject({ state: "in_progress", resentAt: clock })
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain("[agentx:request-pickup id=req-t1]")
    expect(sent[0].text).toContain("stopped on a usage limit, which has reset")
    expect(sent[0].text).not.toContain("The owner asked you to pick")
    expect(told).toEqual([])
  })

  it("resends a restart loss after the delay", async () => {
    start("t1")
    interrupt("t1")
    tracker.resumeOutcome({ taskId: "t1", decision: "reported", reason: "no record of how to resume it" })
    let res = await sweep()
    expect(res).toMatchObject({ held: 1, resent: 0 })
    clock += 5 * MIN
    res = await sweep()
    expect(res).toMatchObject({ resent: 1 })
    expect(sent[0].text).toContain("stopped by a restart")
  })

  it("resends a run whose resume failed", async () => {
    start("t1")
    interrupt("t1")
    tracker.resumeOutcome({ taskId: "t1", decision: "resume-failed", reason: "resume failed: spawn ENOENT" })
    clock += 5 * MIN
    expect(await sweep()).toMatchObject({ resent: 1, notified: 0 })
  })

  it("resends nothing after a stop-all, a crash loop or max attempts", async () => {
    const cases: Array<[string, string]> = [
      ["skipped", "stopped by stop-all ord-1: it resumes from its plan"],
      ["reported", "3+ restarts within 10 min; not resuming"],
      ["reported", "cut off again while resuming; not retried"],
    ]
    cases.forEach(([decision, reason], i) => {
      start(`t${i}`)
      interrupt(`t${i}`)
      tracker.resumeOutcome({ taskId: `t${i}`, decision, reason })
    })
    clock += 6 * MIN
    expect(await sweep()).toMatchObject({ resent: 0, held: 0, notified: 3 })
    clock += 13 * HOUR
    expect(await sweep()).toMatchObject({ resent: 0 })
    expect(sent).toEqual([])
  })

  it("resends only once: a second stop is told, and says it was resent", async () => {
    start("t1")
    fail("t1", "rate limit exceeded")
    clock += 6 * MIN
    await sweep()
    const r = store.get("req-t1")!
    // The resend's turn could not start: the limit is back.
    clock += MIN
    pickupEnded(store, r, { error: "rate limit exceeded" }, clock)
    clock += 6 * MIN
    const res = await sweep()
    expect(res).toMatchObject({ resent: 0, held: 0, notified: 1 })
    expect(sent).toHaveLength(1)
    expect(told[0]).toContain(`Resent once at ${new Date(r.resentAt!).toISOString().slice(0, 16).replace("T", " ")} UTC, stopped again.`)
    expect(told[0]).not.toContain("Nothing is retrying it.")
  })

  it("tells the owner once the hold has lasted holdMaxHours", async () => {
    start("t1")
    fail("t1", "usage limit reached")
    held = true
    clock += 6 * MIN
    expect(await sweep()).toMatchObject({ held: 1, notified: 0 })
    clock += 12 * HOUR
    expect(await sweep()).toMatchObject({ held: 0, notified: 1, resent: 0 })
    expect(told[0]).toContain("Nothing is retrying it.")
  })

  it("tells at once a failure that is not mechanical", async () => {
    start("t1")
    fail("t1", "TypeError: x is undefined")
    expect(await sweep()).toMatchObject({ held: 0, notified: 1, resent: 0 })
  })

  it("leaves promises, plans and agents not on this node to the notice", async () => {
    start("t1")
    fail("t1", "usage limit reached")
    clock += 6 * MIN
    expect(await sweep({ inPlan: () => true })).toMatchObject({ resent: 0, notified: 1 })

    start("t2")
    fail("t2", "usage limit reached")
    clock += 6 * MIN
    expect(await sweep({ hasAgent: () => false })).toMatchObject({ resent: 0, notified: 1 })

    store.addPromise({ id: "p1", channel: "telegram", chatId: "chat-1", agentId: "coder", text: "send the file", owedTo: "owner", now: clock })
    store.needsAttention("p1", "Cut off by a restart and not picked up again (x)", clock)
    clock += 6 * MIN
    expect(await sweep()).toMatchObject({ resent: 0, notified: 1 })
    expect(sent).toEqual([])
  })

  it("is off with autoResend.enabled false", async () => {
    settings = { ...settings, autoResend: { enabled: false, afterMinutes: 5, holdMaxHours: 12 } }
    start("t1")
    fail("t1", "usage limit reached")
    expect(await sweep()).toMatchObject({ held: 0, notified: 1, resent: 0 })
    expect(attentionText(store.get("req-t1")!)).toContain("Nothing is retrying it.")
  })
})
