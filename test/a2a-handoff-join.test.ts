import { describe, it, expect, onTestFinished } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import Database from "better-sqlite3"
import { HandoffStore } from "../src/a2a/handoff-store"
import { DelegationManager, type CallerTurn, type DelegationDeps } from "../src/a2a/delegation"
import { joinedBody } from "../src/daemon/delegation-wiring"
import { repeatOf } from "../src/daemon/send-agent"

// #2007 piece 3: one run per hand-off message. The same message from the
// same caller, chat and home while the first is still open joins it: the
// same id comes back with duplicate:true and nothing starts. On today's
// dlg- paths only; who gets a 202 and which session a run continues are
// unchanged.

function freshDb(): Database.Database {
  const db = new Database(":memory:")
  onTestFinished(() => db.close())
  return db
}

const turn = (chatId: string): CallerTurn => ({ agentId: "front", taskId: `run-${chatId}`, context: { channel: "telegram", chatId, sender: "Sam" } })
const CHAT_1 = turn("chat-1")
const CHAT_2 = turn("chat-2")

function manager(db: Database.Database | null, over: Partial<DelegationDeps> = {}) {
  const logs: string[] = []
  const runs: string[] = []
  let now = 1_000_000
  const store = db ? new HandoffStore(db) : null
  const deps: DelegationDeps = {
    timeoutMs: 60 * 60_000,
    pollMs: 1,
    runLocal: (_agent, message) => { runs.push(message); return new Promise(() => {}) },
    runPeer: () => new Promise(() => {}),
    cancelLocal: () => {},
    injectTurn: async () => ({ content: "ok" }),
    isChatBusy: () => false,
    canDeliver: () => true,
    deliver: async () => {},
    log: (m) => logs.push(m),
    now: () => now,
    ...(store ? { store } : {}),
    ...over,
  }
  const mgr = new DelegationManager(deps)
  onTestFinished(() => mgr.stop())
  return { mgr, logs, runs, store, tick: (ms: number) => { now += ms } }
}

const keyOf = (db: Database.Database, id: string) =>
  (db.prepare("SELECT join_key FROM handoffs WHERE id = ?").get(id) as { join_key: string | null }).join_key
const statusOf = (db: Database.Database, id: string) =>
  (db.prepare("SELECT status FROM handoffs WHERE id = ?").get(id) as { status: string | null }).status

describe("the join key (#2007 B1, B2)", () => {
  it("is written on start, from caller, callee, home, the caller's chat and the full message", () => {
    const db = freshDb()
    const { mgr } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "fix the header", home: "acme/site#12" })
    const key = keyOf(db, a.taskId)
    expect(key).toBeTruthy()
    // Hashes only: the key never holds the message or the chat.
    expect(key).not.toContain("fix the header")
    expect(key).not.toContain("chat-1")
    expect(mgr.joinKeyOf({ caller: CHAT_1, callee: "worker", message: "fix the header", home: "acme/site#12" })).toBe(key)
    expect(mgr.joinKeyOf({ caller: CHAT_1, callee: "worker", message: "fix the header" })).not.toBe(key)
    expect(mgr.joinKeyOf({ caller: CHAT_2, callee: "worker", message: "fix the header", home: "acme/site#12" })).not.toBe(key)
    // The full message counts, not the 500-character clip the row keeps.
    const long = "x".repeat(600)
    expect(mgr.joinKeyOf({ caller: CHAT_1, callee: "worker", message: long + "a" })).not.toBe(mgr.joinKeyOf({ caller: CHAT_1, callee: "worker", message: long + "b" }))
  })
})

describe("a duplicate send joins the open hand-off (#2007 piece 3)", () => {
  it("same message from the same chat while open: same id, duplicate:true, one run", () => {
    const db = freshDb()
    const { mgr, runs } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })
    const b = mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })
    expect(a.duplicate).toBeFalsy()
    expect(b).toMatchObject({ taskId: a.taskId, duplicate: true })
    expect(runs).toEqual(["Check the build"])
    expect(db.prepare("SELECT COUNT(*) AS n FROM handoffs").get()).toEqual({ n: 1 })
    expect(mgr.joined(mgr.joinKeyOf({ caller: CHAT_1, callee: "worker", message: "Check the build" })!)).toBe(a.taskId)
  })

  it("a different message on the same home is new work: its own row and run (B1)", () => {
    const db = freshDb()
    const { mgr } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "fix the header", home: "acme/site#12" })
    const b = mgr.start({ caller: CHAT_1, callee: "worker", message: "also fix the footer", home: "acme/site#12" })
    expect(b.duplicate).toBeFalsy()
    expect(b.taskId).not.toBe(a.taskId)
    expect(db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE status IS NULL").get()).toEqual({ n: 2 })
  })

  it("the same text from two chats runs twice, and says so once in the log (B2)", () => {
    const db = freshDb()
    const { mgr, runs, logs } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })
    const b = mgr.start({ caller: CHAT_2, callee: "worker", message: "Check the build" })
    expect(b.duplicate).toBeFalsy()
    expect(b.taskId).not.toBe(a.taskId)
    expect(runs).toHaveLength(2)
    const lines = logs.filter((l) => l.includes("same text already open from another chat"))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(a.taskId)
    expect(lines[0]).toContain("(1 since start)")
    expect(mgr.sameTextOtherChat()).toBe(1)
  })

  it("inserts once more when the open row it clashed with ended in between (C3)", () => {
    const db = freshDb()
    const { mgr, store, runs } = manager(db)
    // The first insert clashes with a row that ends before it is read.
    const real = store!.insert.bind(store!)
    let calls = 0
    store!.insert = (rec, at, source) => (++calls === 1 ? false : real(rec, at, source))
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })
    expect(calls).toBe(2)
    expect(a.duplicate).toBeFalsy()
    expect(statusOf(db, a.taskId)).toBeNull()
    expect(keyOf(db, a.taskId)).toBeTruthy()
    expect(runs).toHaveLength(1)
  })

  it("an error after the insert ends the row, so the key is not left taken (C3)", () => {
    const db = freshDb()
    let fail = true
    const { mgr } = manager(db, {
      runLocal: () => {
        if (fail) throw new Error("spawn failed")
        return new Promise(() => {})
      },
    })
    expect(() => mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })).toThrow("spawn failed")
    const row = db.prepare("SELECT id, status FROM handoffs").get() as { id: string; status: string }
    expect(row.status).toBe("error")
    fail = false
    const again = mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })
    expect(again.duplicate).toBeFalsy()
    expect(again.taskId).not.toBe(row.id)
  })

  it("a row that ended waiting on something frees the key: a resend is a new run (Q6)", async () => {
    const db = freshDb()
    const { mgr, runs } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    await mgr.complete(a.taskId, { status: "waiting", text: "waiting for the review", waiting: { on: "the review" }, state: { state: "waiting", on: "the review" } })
    const b = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    expect(b.duplicate).toBeFalsy()
    expect(b.taskId).not.toBe(a.taskId)
    expect(runs).toHaveLength(2)
  })

  it("a row whose callee carries on (continue) keeps the key inside its wake window (Q6)", async () => {
    const db = freshDb()
    const { mgr, runs, tick } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    await mgr.complete(a.taskId, { status: "waiting", text: "half done", waiting: { on: "worker to carry on: tests" }, state: { state: "continue", left: "tests" } })
    const b = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    expect(b).toMatchObject({ taskId: a.taskId, duplicate: true })
    expect(runs).toHaveLength(1)
    // Past the wake window it is new work again.
    tick(11 * 60_000)
    const c = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    expect(c.duplicate).toBeFalsy()
    expect(runs).toHaveLength(2)
  })

  it("a resend that joins an ended continue row is marked carried; an open join is not (#2042)", async () => {
    const db = freshDb()
    const { mgr } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    const open = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    expect(open).toMatchObject({ taskId: a.taskId, duplicate: true })
    expect(open.carried).toBeUndefined()
    await mgr.complete(a.taskId, { status: "waiting", text: "half done", waiting: { on: "worker to carry on: tests" }, state: { state: "continue", left: "tests" } })
    expect(mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })).toMatchObject({ taskId: a.taskId, duplicate: true, carried: true })
    expect(mgr.carriedByJob(a.taskId)).toBe(true)
  })

  it("keeps the continue window as long as continueJoinMs says (#2042)", async () => {
    const db = freshDb()
    const { mgr, tick } = manager(db, { continueJoinMs: 30 * 60_000 })
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    await mgr.complete(a.taskId, { status: "waiting", text: "half done", waiting: { on: "worker to carry on" }, state: { state: "continue", left: "tests" } })
    tick(20 * 60_000)
    expect(mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" }).duplicate).toBe(true)
    tick(11 * 60_000)
    expect(mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" }).duplicate).toBeFalsy()
  })

  it("records the row without its key when the keyed insert gives up after two tries (#2042)", () => {
    const db = freshDb()
    const { mgr, store, runs, logs } = manager(db)
    const real = store!.insert.bind(store!)
    // Two clashes whose open row is gone each time it is read.
    store!.insert = (rec, at, source) => (rec.joinKey ? false : real(rec, at, source))
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })
    expect(a.duplicate).toBeFalsy()
    expect(statusOf(db, a.taskId)).toBeNull()
    expect(keyOf(db, a.taskId)).toBeNull()
    expect(store!.read(a.taskId)).toBeTruthy()
    expect(runs).toHaveLength(1)
    expect(logs.some((l) => l.includes("recorded without it"))).toBe(true)
  })

  it("a continue row with a due time keeps the key until that time (Q6)", async () => {
    const db = freshDb()
    const { mgr, tick } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })
    await mgr.complete(a.taskId, { status: "waiting", text: "half done", waiting: { on: "worker to carry on", dueAt: 1_000_000 + 60 * 60_000 }, state: { state: "continue", left: "tests" } })
    tick(30 * 60_000)
    expect(mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" })).toMatchObject({ taskId: a.taskId, duplicate: true })
    tick(31 * 60_000)
    expect(mgr.start({ caller: CHAT_1, callee: "worker", message: "Deploy it" }).duplicate).toBeFalsy()
  })

  it("a row that ended done frees the key at once", async () => {
    const db = freshDb()
    const { mgr } = manager(db)
    const a = mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })
    await mgr.complete(a.taskId, { status: "done", text: "green" })
    expect(mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" }).duplicate).toBeFalsy()
  })

  it("a node with no database starts every send, as before", () => {
    const { mgr, runs } = manager(null)
    mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" })
    expect(mgr.start({ caller: CHAT_1, callee: "worker", message: "Check the build" }).duplicate).toBeFalsy()
    expect(runs).toHaveLength(2)
  })
})

describe("the answer a joined send gets", () => {
  it("is the first send's 202, marked duplicate, telling the agent it hears once", () => {
    const body = joinedBody("dlg-1", "worker", undefined, true)
    expect(body).toMatchObject({ accepted: true, mode: "callback", taskId: "dlg-1", agent: "worker", duplicate: true })
    expect(String(body.note)).toContain("dlg-1")
    expect(String(body.note)).toMatch(/once/)
  })
})

describe("a joined send whose run ended and whose job carries on (#2042)", () => {
  it("is told the result comes through the job, not that it hears once", () => {
    const note = String(joinedBody("dlg-1", "worker", undefined, true, true).note)
    expect(note).toMatch(/comes through the job/)
    expect(note).not.toMatch(/hear its answer once/)
  })

  it("the continue window is the job wake's grace setting, read from config", () => {
    const wiring = readFileSync(join(__dirname, "../src/daemon/delegation-wiring.ts"), "utf8")
    expect(wiring).toMatch(/continueJoinMs: \(w\.config\.requests\?\.jobs\?\.wake\?\.graceMinutes/)
  })
})

describe("the send dedupe window beside the join key (S2)", () => {
  const started = { accepted: true, mode: "callback", taskId: "dlg-1" }
  const queued = { accepted: true, status: "queued", taskId: "snd-1" }
  const relayed = { accepted: true, status: "delivered", taskId: "dlg-2" }

  it("leaves a callback start to the join key when the node has the table", () => {
    expect(repeatOf(started, true)).toBeNull()
    expect(repeatOf(started, false)).toBe(started)
  })

  it("still catches queued sends and relayed replies", () => {
    expect(repeatOf(queued, true)).toBe(queued)
    expect(repeatOf(relayed, true)).toBe(relayed)
    expect(repeatOf(null, true)).toBeNull()
  })
})

describe("a duplicate spends no budget and writes no ledger row (C2)", () => {
  const src = readFileSync(join(__dirname, "../src/daemon/index.ts"), "utf-8")
  const gate = src.slice(src.indexOf("  private delegationGate("), src.indexOf("  private handOffRefusal("))

  it("looks the join up before the hand-off budget", () => {
    const joined = gate.indexOf("this.delegations.joined(")
    expect(joined).toBeGreaterThan(-1)
    expect(joined).toBeLessThan(gate.indexOf("this.handOffRefusal("))
    expect(joined).toBeLessThan(gate.indexOf("this.startCallback("))
  })

  it("writes the intent-ledger row only in startCallback, after the gate's join check", () => {
    expect(gate).not.toContain("this.recordInboundDispatch(")
    const start = src.slice(src.indexOf("  private startCallback("), src.indexOf("  private recordInboundDispatch("))
    expect(start).toContain("this.recordInboundDispatch(")
  })

  it("lets /send/agent through its dedupe window for a callback start when the table is there", () => {
    const route = src.slice(src.indexOf("  private async sendToAgent("), src.indexOf("  private delegationGate("))
    expect(route).toContain('repeatOf(this.sendAgentDedupe.get(dedupeKey), this.delegations.journalMode() === "database")')
  })
})
