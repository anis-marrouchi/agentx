import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, isOwnerTurn, senderOf, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep, attentionText } from "../src/requests/sweep"
import { requestsConfigSchema } from "../src/daemon/config"
import { DelegationManager, type DelegationDeps } from "../src/a2a/delegation"
import { attachRequests } from "../src/requests/attach"
import { getEventBus } from "../src/events/bus"

const HOUR = 3_600_000
const ON: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let settings: RequestSettings
let clock: number
let logs: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-requests-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  settings = { ...ON }
  clock = 1_000_000
  logs = []
  tracker = new RequestTracker(store, () => settings, (m) => logs.push(m), () => clock)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A turn the owner starts on Telegram. */
function start(taskId: string, over: Record<string, unknown> = {}) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId,
    messagePreview: "build the report", fullMessage: "build the report and deploy it",
    at: new Date(clock).toISOString(), humanRoot: true, sender: { name: "Owner", id: "4242" },
    ...over,
  } as any)
}

function end(taskId: string, over: Record<string, unknown> = {}) {
  tracker.taskCompleted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, durationMs: 10,
    at: new Date(clock).toISOString(), ...over,
  } as any)
}

const dlg = (id: string) => ({ id, caller: "coder", callee: "devops", origin: { channel: "telegram", chatId: "chat-1" } })

describe("settings", () => {
  it("is off by default, with a 24 hour quiet time and 90 day retention", () => {
    expect(requestsConfigSchema.parse(undefined)).toEqual({ enabled: false, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 })
  })

  it("records nothing while it is off", () => {
    settings.enabled = false
    start("t1")
    end("t1", { error: "boom" })
    expect(db.prepare("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 })
  })
})

describe("who counts as the owner", () => {
  it("takes this node's own surfaces without a from list", () => {
    for (const ch of ["voice", "app", "dashboard", "webrtc"]) expect(isOwnerTurn({ channels: [], from: [] }, ch, undefined)).toBe(true)
  })

  it("skips turns the daemon itself starts on those surfaces", () => {
    expect(isOwnerTurn({ channels: [], from: [] }, "voice", { name: "Camera" })).toBe(false)
    expect(isOwnerTurn({ channels: [], from: [] }, "voice", { name: "Owner" })).toBe(true)
  })

  it("takes nobody on a public channel when the from list is empty", () => {
    expect(isOwnerTurn({ channels: [], from: [] }, "github", { id: "1", username: "anyone" })).toBe(false)
  })

  it("matches a sender id or username on its own channel only, never a display name", () => {
    const s = { channels: [], from: ["telegram:4242", "github:Octo", "telegram:@handle"] }
    expect(isOwnerTurn(s, "telegram", { id: "4242" })).toBe(true)
    expect(isOwnerTurn(s, "github", { username: "octo" })).toBe(true)
    expect(isOwnerTurn(s, "telegram", { username: "Handle" })).toBe(true)
    // The same id or login on another channel is another person.
    expect(isOwnerTurn(s, "gitlab", { username: "octo" })).toBe(false)
    expect(isOwnerTurn(s, "whatsapp", { id: "4242" })).toBe(false)
    expect(isOwnerTurn(s, "telegram", { id: "9" })).toBe(false)
    // An entry for another channel is never compared as a plain string.
    expect(isOwnerTurn(s, "gitlab", { id: "github:octo" })).toBe(false)
    expect(senderOf({ sender: "4242", senderId: "9" })).toEqual({ name: "4242", id: "9", username: undefined })
    expect(isOwnerTurn(s, "telegram", senderOf({ sender: "4242", senderId: "9" }))).toBe(false)
  })

  it("accepts only channel:id entries in the settings", () => {
    expect(requestsConfigSchema.safeParse({ from: ["marrouchi"] }).success).toBe(false)
    expect(requestsConfigSchema.safeParse({ from: ["gitlab:marrouchi"] }).success).toBe(true)
  })

  it("keeps to the listed channels when there are any", () => {
    expect(isOwnerTurn({ channels: ["telegram"], from: ["telegram:4242"] }, "voice", undefined)).toBe(false)
    expect(isOwnerTurn({ channels: ["telegram"], from: ["telegram:4242"] }, "telegram@bot2", { id: "4242" })).toBe(true)
  })
})

describe("capture", () => {
  it("opens nothing for a turn that answers and ends cleanly", () => {
    start("t1")
    expect(store.get("req-t1")?.state).toBe("candidate")
    end("t1")
    expect(store.get("req-t1")).toBeNull()
    expect(store.listOpen()).toEqual([])
  })

  it("ignores turns from other people, delegated hops and callbacks", () => {
    start("t1", { sender: { name: "Owner", id: "777" } })
    start("t2", { humanRoot: false })
    expect(db.prepare("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 })
  })

  it("records who, where, when, the words and the agent", () => {
    start("t1")
    end("t1", { error: "exploded" })
    expect(store.listOpen()[0]).toMatchObject({
      id: "req-t1", channel: "telegram", chatId: "chat-1", sender: "Owner", agentId: "coder",
      text: "build the report and deploy it", createdAt: 1_000_000,
    })
  })
})

describe("on the daemon's event bus", () => {
  it("follows the run events the registry emits, and stops when detached", () => {
    const attached = attachRequests(db, () => settings, () => {})
    const bus = getEventBus()
    const at = new Date().toISOString()
    bus.emit("task:started", {
      agentId: "coder", channel: "voice", chatId: "mac", taskId: "bus-1", messagePreview: "ship it", fullMessage: "ship it",
      at, humanRoot: true,
    })
    expect(attached.store.get("req-bus-1")?.state).toBe("candidate")
    bus.emit("task:completed", { agentId: "coder", channel: "voice", chatId: "mac", taskId: "bus-1", durationMs: 5, error: "Task timed out after 60 minutes", at })
    expect(attached.store.get("req-bus-1")?.state).toBe("needs_attention")

    attached.detach()
    bus.emit("task:started", { agentId: "coder", channel: "voice", chatId: "mac", taskId: "bus-2", messagePreview: "x", at, humanRoot: true })
    expect(attached.store.get("req-bus-2")).toBeNull()
  })
})

describe("failure", () => {
  it("moves the request to needs attention with what happened", () => {
    start("t1")
    end("t1", { error: "model refused the request" })
    const r = store.get("req-t1")!
    expect(r.state).toBe("needs_attention")
    expect(r.attentionReason).toBe("coder failed: model refused the request")
  })

  it("does not treat a run the person stopped as a failure", () => {
    start("t1")
    end("t1", { error: "cancelled by operator", errorKind: "cancelled" })
    expect(store.get("req-t1")).toBeNull()
  })

  it("covers a failed delegation: the request the turn handed on comes back", () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
    expect(store.get("req-t1")?.state).toBe("waiting_other")
    tracker.delegationDone(dlg("dlg-1"), "error", "devops crashed")
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", attentionReason: "The work handed to devops failed: devops crashed" })
  })

  it("does not attach a delegation from someone else's turn to the owner's open request", () => {
    start("t1")
    end("t1", { error: "boom" })
    start("t2", { sender: { name: "Guest", id: "777" } })
    tracker.delegationStarted(dlg("dlg-2"))
    end("t2")
    expect(store.byLink("delegation", "dlg-2")).toBeNull()
    expect(store.get("req-t1")?.state).toBe("needs_attention")
  })

  it("keeps a request open after a delegation finishes: closing is explicit", () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
    tracker.delegationDone(dlg("dlg-1"), "done", "all good")
    expect(store.get("req-t1")?.state).toBe("in_progress")
  })
})

describe("timeout", () => {
  it("names a run that hit its time limit", () => {
    start("t1")
    end("t1", { error: "Task timed out after 60 minutes" })
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", attentionReason: "coder timed out: Task timed out after 60 minutes" })
  })

  it("names a delegation that did not answer in time", () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
    tracker.delegationDone(dlg("dlg-1"), "timeout", "No answer from devops after 30 minute(s).")
    expect(store.get("req-t1")?.attentionReason).toBe("The work handed to devops did not answer in time: No answer from devops after 30 minute(s).")
  })

  it("is fed by the delegation manager itself", async () => {
    start("t1")
    const deps: DelegationDeps = {
      timeoutMs: 60_000,
      runLocal: () => Promise.resolve({ content: "", error: "callee blew up" }),
      runPeer: () => Promise.resolve(""),
      injectTurn: async () => ({ content: "told" }),
      isChatBusy: () => false,
      canDeliver: () => true,
      deliver: async () => {},
      log: () => {},
      onStarted: (rec) => tracker.delegationStarted(rec),
      onDone: (rec, result) => tracker.delegationDone(rec, result.status, result.text),
    }
    const mgr = new DelegationManager(deps)
    mgr.start({ caller: { agentId: "coder", context: { channel: "telegram", chatId: "chat-1", sender: "Owner" } }, callee: "devops", message: "deploy it" })
    expect(store.get("req-t1")?.state).toBe("waiting_other")
    await new Promise((r) => setTimeout(r, 10))
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", attentionReason: "The work handed to devops failed: callee blew up" })
  })
})

describe("restart", () => {
  it("keeps the request while the shutdown cuts the run, then follows the boot's decision", () => {
    start("t1")
    end("t1", { error: "daemon stopping", interrupted: true })
    expect(store.get("req-t1")?.state).toBe("candidate")

    tracker.resumeOutcome({ taskId: "t1", decision: "reported", reason: "started 45 min ago (limit 30)" })
    expect(store.get("req-t1")).toMatchObject({
      state: "needs_attention",
      attentionReason: "Cut off by a restart and not picked up again (started 45 min ago (limit 30))",
    })
  })

  it("leaves nothing behind when a plain turn is resumed and then just answers", () => {
    start("t1")
    end("t1", { interrupted: true, error: "daemon stopping" })
    tracker.resumeOutcome({ taskId: "t1", decision: "resumed", reason: "cut off by a restart" })
    start("t2", { resumedFrom: "t1" })
    expect(store.byLink("run", "t2")?.id).toBe("req-t1")
    end("t2")
    expect(store.get("req-t1")).toBeNull()
    expect(store.listOpen()).toEqual([])
  })

  it("stays one open request when a resumed run had already handed work on", () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1", { interrupted: true, error: "daemon stopping" })
    tracker.resumeOutcome({ taskId: "t1", decision: "resumed", reason: "cut off by a restart" })
    start("t2", { resumedFrom: "t1" })
    end("t2")
    expect(store.listOpen().map((r) => r.id)).toEqual(["req-t1"])
    expect(store.get("req-t1")?.state).toBe("in_progress")
  })

  it("raises a resumed turn that fails", () => {
    start("t1")
    end("t1", { interrupted: true, error: "daemon stopping" })
    tracker.resumeOutcome({ taskId: "t1", decision: "resumed", reason: "cut off by a restart" })
    start("t2", { resumedFrom: "t1" })
    end("t2", { error: "model overloaded" })
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", attentionReason: "coder failed: model overloaded" })
  })

  it("comes back when the resumed run fails too", () => {
    start("t1")
    end("t1", { interrupted: true, error: "daemon stopping" })
    tracker.resumeOutcome({ taskId: "t1", decision: "resume-failed", reason: "resume failed: no adapter" })
    expect(store.get("req-t1")?.state).toBe("needs_attention")
  })

  it("survives the restart itself: the record is on disk", () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    db.close()
    db = new Database(path.join(tmp, "db.sqlite"))
    store = new RequestStore(db)
    tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
    tracker.delegationDone(dlg("dlg-1"), "lost", "This machine restarted while the work was in progress.")
    expect(store.get("req-t1")?.attentionReason).toBe("The work handed to devops was lost in a restart: This machine restarted while the work was in progress.")
  })
})

describe("the minute check", () => {
  const sweep = (over: Partial<Parameters<typeof runRequestsSweep>[0]> = {}) => {
    const told: string[] = []
    return runRequestsSweep({
      store, settings, log: (m) => logs.push(m), now: clock,
      notify: async (_title, message, r) => { told.push(`${r.id}|${message}`) },
      ...over,
    }).then((result) => ({ result, told }))
  }

  it("tells the owner once about a request that needs attention", async () => {
    start("t1")
    end("t1", { error: "Task timed out after 60 minutes" })
    const first = await sweep()
    expect(first.result.notified).toBe(1)
    expect(first.told[0]).toContain("build the report and deploy it")
    expect(first.told[0]).toContain("coder timed out")
    clock += HOUR
    const second = await sweep()
    expect(second.result.notified).toBe(0)
    expect(second.told).toEqual([])
    expect(store.get("req-t1")?.state).toBe("needs_attention")
  })

  it("tries again at the next check when the notice could not be sent, then stops", async () => {
    start("t1")
    end("t1", { error: "boom" })
    await sweep({ notify: async () => { throw new Error("push down") } })
    expect(logs.join("\n")).toContain("couldn't tell the owner about req-t1, will try again")
    expect((await sweep()).told).toHaveLength(1)
    expect((await sweep()).told).toEqual([])
  })

  it("brings back a request with no activity for staleAfterHours, not sooner", async () => {
    settings.staleAfterHours = 2
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    clock += 2 * HOUR - 1
    expect((await sweep()).result.quiet).toBe(0)
    clock += 2
    const { result, told } = await sweep()
    expect(result).toMatchObject({ quiet: 1, notified: 1 })
    expect(told[0]).toContain("No activity for 2 h")
  })

  it("brings back a turn that never reported an end", async () => {
    start("t1")
    clock += 25 * HOUR
    await sweep()
    expect(store.get("req-t1")?.attentionReason).toContain("never reported an end")
  })

  it("keeps older open requests listed first when newer ones arrive", async () => {
    start("t1"); end("t1", { error: "a" })
    clock += 1000
    start("t2"); end("t2", { error: "b" })
    clock += 1000
    start("t3"); end("t3")
    expect(store.listOpen().map((r) => r.id)).toEqual(["req-t1", "req-t2"])
  })

  it("deletes closed requests after retentionDays and never an open one", async () => {
    start("t1"); end("t1", { error: "a" })
    start("t2"); end("t2", { error: "b" })
    store.close("req-t2", "done", "https://example.test/pr/1", clock)
    clock += 91 * 24 * HOUR
    expect((await sweep()).result.pruned).toBe(1)
    expect(store.get("req-t2")).toBeNull()
    expect(store.get("req-t1")?.state).toBe("needs_attention")
    expect(store.links("req-t2")).toEqual([])
  })

  it("does nothing while the feature is off", async () => {
    start("t1"); end("t1", { error: "a" })
    settings.enabled = false
    expect((await sweep()).result).toEqual({ quiet: 0, notified: 0, pruned: 0, pickedUp: 0 })
  })
})

describe("waiting on the owner", () => {
  it("shows the question and is not treated as quiet", async () => {
    start("t1")
    store.waitOnOwner("req-t1", "Deploy to the server now, or after the review?", clock)
    end("t1")
    expect(store.listOpen()[0]).toMatchObject({ state: "waiting_owner", question: "Deploy to the server now, or after the review?" })
    clock += 72 * HOUR
    const result = await runRequestsSweep({ store, settings, log: () => {}, now: clock, notify: async () => {} })
    expect(result).toEqual({ quiet: 0, notified: 0, pruned: 0, pickedUp: 0 })
    expect(store.get("req-t1")?.state).toBe("waiting_owner")
  })

  const card = (over: Record<string, unknown> = {}) => ({
    id: "card-1", raised_by: "coder", ask: "Deploy to production today?", if_silent: "discard",
    reply: { channel: "telegram", chatId: "chat-1" }, status: "pending", ...over,
  })

  it("starts when the agent raises a decision card from the request's turn", () => {
    start("t1")
    tracker.cardRaised(card())
    end("t1")
    expect(store.get("req-t1")).toMatchObject({ state: "waiting_owner", question: "Deploy to production today?" })
    expect(store.byLink("card", "card-1")?.id).toBe("req-t1")
  })

  it("leaves a card raised outside a recorded turn alone", () => {
    tracker.cardRaised(card())
    tracker.cardRaised(card({ id: "card-2", reply: undefined }))
    expect(store.byLink("card", "card-1")).toBeNull()
  })

  it("goes on once the owner answers the card", () => {
    start("t1"); tracker.cardRaised(card()); end("t1")
    tracker.cardResolved(card({ status: "decided", verdict: "yes" }))
    expect(store.get("req-t1")).toMatchObject({ state: "in_progress", question: null })
  })

  it("needs attention when the card expires unanswered; it does not close", async () => {
    start("t1"); tracker.cardRaised(card()); end("t1")
    tracker.cardResolved(card({ status: "expired", outcome: "discard" }))
    expect(store.get("req-t1")).toMatchObject({
      state: "needs_attention",
      attentionReason: 'Your answer did not come before the card expired (Deploy to production today?); "discard" was applied',
    })
    const told: string[] = []
    await runRequestsSweep({ store, settings, log: () => {}, now: clock, notify: async (_t, m) => { told.push(m) } })
    expect(told).toHaveLength(1)
  })

  it("stays in progress when the card's default on expiry is approve", () => {
    start("t1"); tracker.cardRaised(card({ if_silent: "approve" })); end("t1")
    tracker.cardResolved(card({ status: "expired", outcome: "approve", if_silent: "approve" }))
    expect(store.get("req-t1")?.state).toBe("in_progress")
  })

  it("goes back to in progress once work continues, and the question is cleared", () => {
    start("t1")
    store.waitOnOwner("req-t1", "Which server?", clock)
    store.progress("req-t1", clock + 1)
    expect(store.get("req-t1")).toMatchObject({ state: "in_progress", question: null })
  })
})

describe("closing", () => {
  it("needs evidence for done and a reason for declined or dropped", () => {
    start("t1"); end("t1", { error: "a" })
    expect(() => store.close("req-t1", "done", "  ", clock)).toThrow(/evidence/)
    expect(() => store.close("req-t1", "dropped", "", clock)).toThrow(/reason/)
    expect(store.close("req-t1", "done", "https://example.test/pr/7", clock)).toBe(true)
    expect(store.get("req-t1")).toMatchObject({ state: "done", evidence: "https://example.test/pr/7", closedAt: clock })
  })

  it("stays closed whatever arrives afterwards", () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
    store.close("req-t1", "dropped", "no longer needed", clock)
    tracker.delegationDone(dlg("dlg-1"), "error", "late failure")
    expect(store.get("req-t1")).toMatchObject({ state: "dropped", closeReason: "no longer needed" })
    expect(store.close("req-t1", "done", "x", clock)).toBe(false)
  })

  it("raises a second failure again after work resumed", async () => {
    start("t1"); end("t1", { error: "first" })
    await runRequestsSweep({ store, settings, log: () => {}, now: clock, notify: async () => {} })
    store.progress("req-t1", clock)
    expect(store.needsAttention("req-t1", "second", clock)).toBe(true)
    expect(store.awaitingNotice().map((r) => r.id)).toEqual(["req-t1"])
    expect(attentionText(store.get("req-t1")!)).toContain("What happened: second")
  })
})
