import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep, attentionText } from "../src/requests/sweep"
import { resendKind } from "../src/requests/resend"

// One resend of a request a usage limit or a restart stopped (#1542).

const MIN = 60_000
const HOUR = 60 * MIN
const base: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const AGENTS = new Set(["coder"])
const LIMIT = "Claude plan limit reached: Claude Code reports the weekly window as rejected."

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let clock: number
let settings: RequestSettings
let limitHeld: boolean
let told: Array<{ agentId: string; text: string }>
let notices: Array<{ title: string; message: string }>
let plans: Set<string>

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-resend-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  clock = Date.parse("2030-03-01T12:00:00Z")
  settings = { ...base }
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
  limitHeld = false
  told = []
  notices = []
  plans = new Set()
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function ownerTurn(taskId: string) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, messagePreview: "ship it", fullMessage: "ship it",
    at: "", humanRoot: true, sender: { id: "4242" }, person: { id: "owner" },
  } as any)
}

function failRun(taskId: string, error: string) {
  tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, error } as any)
}

const sweep = () => runRequestsSweep({
  store, settings, log: () => {}, now: clock,
  hasAgent: (id) => AGENTS.has(id),
  inPlan: (id) => plans.has(id),
  limitHeld: () => limitHeld,
  tellAgent: async (agentId, text) => { told.push({ agentId, text }) },
  notify: async (title, message) => { notices.push({ title, message }) },
})

describe("resendKind", () => {
  it("reads limits and restarts from the reasons the tracker writes", () => {
    expect(resendKind(`coder failed: ${LIMIT}`)).toBe("limit")
    expect(resendKind("coder failed: You've hit your limit · resets 3pm")).toBe("limit")
    expect(resendKind("coder failed: 429 Too Many Requests")).toBe("limit")
    expect(resendKind("Cut off by a restart and not picked up again (daemon stopped)")).toBe("restart")
    expect(resendKind("The work handed to devops was lost in a restart: gone")).toBe("restart")
    expect(resendKind("The answer from devops was not passed on after a restart (x). It said: y")).toBe("restart")
    expect(resendKind("No activity for 24 h")).toBeNull()
    expect(resendKind("coder failed: TypeError: x is undefined")).toBeNull()
    expect(resendKind(null)).toBeNull()
  })
})

describe("resend after a limit", () => {
  it("holds the notice while the limit is held, resends once it lifts, and the agent is told at the next check", async () => {
    ownerTurn("t1")
    failRun("t1", LIMIT)
    expect(store.get("req-t1")?.state).toBe("needs_attention")

    limitHeld = true
    let r = await sweep()
    expect(r.resent).toBe(0)
    expect(notices).toHaveLength(0)
    expect(store.get("req-t1")?.notifiedAt).toBeNull()

    // The hold lifted, but not afterMinutes yet.
    limitHeld = false
    clock += MIN
    r = await sweep()
    expect(r.resent).toBe(0)
    limitHeld = true
    clock += 5 * MIN
    r = await sweep()
    expect(r.resent).toBe(0)

    limitHeld = false
    clock += MIN
    r = await sweep()
    expect(r.resent).toBe(1)
    expect(notices).toHaveLength(0)
    const back = store.get("req-t1")!
    expect(back.state).toBe("in_progress")
    expect(back.resentAt).toBe(clock)

    clock += MIN
    r = await sweep()
    expect(r.pickedUp).toBe(1)
    expect(told).toHaveLength(1)
    expect(told[0].text).toContain("[agentx:request-pickup id=req-t1]")
  })

  it("resends only once: a second stop is told, and says it was resent", async () => {
    ownerTurn("t1")
    failRun("t1", LIMIT)
    clock += 5 * MIN
    await sweep()
    clock += MIN
    await sweep()
    expect(told).toHaveLength(1)

    // The pick-up turn hits the limit again.
    store.needsAttention("req-t1", `Could not hand it back to coder: ${LIMIT}`, clock)
    clock += MIN
    const r = await sweep()
    expect(r.resent).toBe(0)
    expect(notices).toHaveLength(1)
    expect(notices[0].message).toContain("handed back to coder once on its own")
    expect(notices[0].message).not.toContain("Nothing is retrying it.")
    expect(told).toHaveLength(1)
  })

  it("tells the owner when the hold lasts past holdMaxHours", async () => {
    ownerTurn("t1")
    failRun("t1", LIMIT)
    limitHeld = true
    await sweep()
    expect(notices).toHaveLength(0)
    clock += 12 * HOUR
    await sweep()
    expect(notices).toHaveLength(1)
    expect(notices[0].message).toContain("Nothing is retrying it.")
    expect(store.get("req-t1")?.resentAt).toBeNull()
  })
})

describe("resend after a restart", () => {
  it("waits afterMinutes, then resends", async () => {
    ownerTurn("t1")
    tracker.resumeOutcome({ taskId: "t1", decision: "reported", reason: "the daemon restarted" })
    expect(store.get("req-t1")?.state).toBe("needs_attention")
    await sweep()
    expect(store.get("req-t1")?.state).toBe("needs_attention")
    expect(notices).toHaveLength(0)
    clock += 5 * MIN
    const r = await sweep()
    expect(r.resent).toBe(1)
    expect(store.get("req-t1")?.state).toBe("in_progress")
  })
})

describe("what is never resent", () => {
  it("a failure that is not a limit or a restart is told at once, as before", async () => {
    ownerTurn("t1")
    failRun("t1", "TypeError: x is undefined")
    const r = await sweep()
    expect(r.resent).toBe(0)
    expect(notices).toHaveLength(1)
    expect(attentionText(store.get("req-t1")!)).toContain("Nothing is retrying it.")
  })

  it("a request in an active plan is left to the plan check", async () => {
    ownerTurn("t1")
    failRun("t1", LIMIT)
    plans.add("req-t1")
    const r = await sweep()
    expect(r.resent).toBe(0)
    expect(notices).toHaveLength(1)
  })

  it("an agent not on this node is told, not resent", async () => {
    tracker.taskStarted({
      agentId: "gone", channel: "telegram", chatId: "chat-2", taskId: "t2", messagePreview: "x", fullMessage: "x",
      at: "", humanRoot: true, sender: { id: "4242" }, person: { id: "owner" },
    } as any)
    tracker.taskCompleted({ agentId: "gone", channel: "telegram", chatId: "chat-2", taskId: "t2", error: LIMIT } as any)
    const r = await sweep()
    expect(r.resent).toBe(0)
    expect(notices).toHaveLength(1)
  })

  it("autoResend.enabled false turns it off", async () => {
    settings = { ...base, autoResend: { enabled: false, afterMinutes: 5, holdMaxHours: 12 } }
    ownerTurn("t1")
    failRun("t1", LIMIT)
    const r = await sweep()
    expect(r.resent).toBe(0)
    expect(notices).toHaveLength(1)
  })
})
