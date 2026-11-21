import { describe, it, expect, onTestFinished } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import Database from "better-sqlite3"
import { HandoffStore } from "../src/a2a/handoff-store"
import { DelegationManager, NONE_ORIGIN, type CallerTurn, type DelegationDeps, type DelegationRecord } from "../src/a2a/delegation"
import { agentCallerOf, ignoredFlags, noneBody, type CallerHint } from "../src/daemon/delegation-wiring"
import * as sendAgent from "../src/daemon/send-agent"
import { waitForHandoffReply } from "../src/commands/demo-handoff"

// #2007 piece 2: who calls decides, not the flags. An agent caller always
// gets a 202 receipt on /send/agent, /task and /mesh/task; a caller that
// names no agent (CLI, workflow steps, peers, the phone relay, `agentx
// mesh ask`, the stream proxy) stays synchronous. Every agent send goes
// through the hand-off journal: queueSend and the snd- ids are gone.

function freshDb(): Database.Database {
  const db = new Database(":memory:")
  onTestFinished(() => db.close())
  return db
}

const HOUR = 3_600_000

interface Harness {
  mgr: DelegationManager
  logs: string[]
  runs: Array<{ agent: string; message: string; context: Record<string, unknown>; resumeFrom?: Array<{ channel: string; chatId: string }> }>
  turns: unknown[]
  delivered: unknown[]
  notified: Array<{ rec: DelegationRecord; status: string }>
  finish: Array<(r: { content: string; error?: string }) => void>
  tick: (ms: number) => void
}

function manager(db: Database.Database | null, over: Partial<DelegationDeps> = {}, start = 100 * HOUR): Harness {
  const logs: string[] = []
  const runs: Harness["runs"] = []
  const turns: unknown[] = []
  const delivered: unknown[] = []
  const notified: Harness["notified"] = []
  const finish: Harness["finish"] = []
  let now = start
  const store = db ? new HandoffStore(db) : null
  const deps: DelegationDeps = {
    timeoutMs: 60 * 60_000,
    pollMs: 1,
    runLocal: (agent, message, context, opts) => {
      runs.push({ agent, message, context, ...(opts.resumeFrom ? { resumeFrom: opts.resumeFrom } : {}) })
      return new Promise((r) => finish.push(r))
    },
    runPeer: () => new Promise(() => {}),
    cancelLocal: () => {},
    injectTurn: async (t) => { turns.push(t); return { content: "ok" } },
    isChatBusy: () => false,
    canDeliver: () => true,
    deliver: async (m) => { delivered.push(m) },
    notify: (rec, result) => { notified.push({ rec, status: result.status }) },
    log: (m) => logs.push(m),
    now: () => now,
    ...(store ? { store } : {}),
    ...over,
  }
  const mgr = new DelegationManager(deps)
  onTestFinished(() => mgr.stop())
  return { mgr, logs, runs, turns, delivered, notified, finish, tick: (ms) => { now += ms } }
}

const flush = () => new Promise((r) => setTimeout(r, 5))
const agentCaller = (agentId: string): CallerTurn => ({ agentId, context: {} })
const row = (db: Database.Database, id: string) => db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Record<string, unknown>

describe("who counts as an agent caller (B4, C1)", () => {
  const registry = { getAgent: (id: string) => (id === "builder" || id === "front" ? { id } : undefined) }
  const hint = (h: Partial<CallerHint>): CallerHint => ({ meshForwarded: false, local: true, ...h })

  it("is the agent of a resolved turn", () => {
    expect(agentCallerOf(hint({}), { agentId: "front", taskId: "t", context: {} }, registry)).toBe("front")
  })

  it("is a loopback request naming a local agent, with no turn", () => {
    expect(agentCallerOf(hint({ senderAgentId: "builder" }), null, registry)).toBe("builder")
  })

  it("is never a peer or a mesh forward naming a local agent's id (C1)", () => {
    expect(agentCallerOf(hint({ senderAgentId: "builder", local: false }), null, registry)).toBeNull()
    expect(agentCallerOf(hint({ senderAgentId: "builder", meshForwarded: true }), null, registry)).toBeNull()
  })

  it("is nobody for the CLI, a workflow step, the phone relay or a script naming no local agent", () => {
    expect(agentCallerOf(hint({}), null, registry)).toBeNull()
    expect(agentCallerOf(hint({ senderAgentId: "someone-else" }), null, registry)).toBeNull()
  })
})

describe("the 202 an agent caller gets", () => {
  it("flags stream:true, an SSE Accept header and async:false as ignored", () => {
    expect(ignoredFlags({ stream: true }, "")).toEqual({ streamIgnored: true })
    expect(ignoredFlags({}, "text/event-stream")).toEqual({ streamIgnored: true })
    expect(ignoredFlags({ async: false }, "")).toEqual({ asyncIgnored: true })
    expect(ignoredFlags({ async: true }, "application/json")).toEqual({})
  })

  it("says a none receipt is read by its id, and never asks to wait", () => {
    const body = noneBody("dlg-1", "worker", undefined, false)
    expect(body).toMatchObject({ accepted: true, mode: "none", taskId: "dlg-1", agent: "worker" })
    expect(String(body.note)).toContain("GET /a2a/delegations/dlg-1")
    expect(String(body.note)).toMatch(/do not wait/i)
    expect(noneBody("dlg-1", "worker", "vps", true)).toMatchObject({ duplicate: true, peer: "vps" })
  })
})

describe("a none row (an agent caller with no way to be called back)", () => {
  it("is written with way_home 'none' and no origin, and reads back by id", async () => {
    const db = freshDb()
    const h = manager(db)
    const r = h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "check the build", kind: "send", wayHome: "none" })
    const stored = row(db, r.taskId)
    expect(stored.way_home).toBe("none")
    expect(stored.origin_json).toBeNull()
    expect(h.runs[0].context.chatId).toBe(`a2a:builder:worker:${r.taskId}`)
    expect(h.mgr.journalReader()!.read(r.taskId)).toMatchObject({ wayHome: "none", status: "running" })
    h.finish[0]({ content: "green" })
    await flush()
    expect(h.mgr.journalReader()!.read(r.taskId)).toMatchObject({ status: "done", text: "green", wayHome: "none" })
    // No callback turn and nothing sent to a chat.
    expect(h.turns).toHaveLength(0)
    expect(h.delivered).toHaveLength(0)
  })

  it("tells a named sender with a notice when it settles (C7)", async () => {
    const db = freshDb()
    const h = manager(db)
    const r = h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "x", kind: "send", wayHome: "none" })
    h.finish[0]({ content: "", error: "boom" })
    await flush()
    expect(h.notified).toHaveLength(1)
    expect(h.notified[0]).toMatchObject({ status: "error" })
    expect(h.notified[0].rec.id).toBe(r.taskId)
  })

  it("tells nobody when the sender is unnamed", async () => {
    const db = freshDb()
    const h = manager(db)
    h.mgr.start({ caller: agentCaller("?"), callee: "worker", message: "x", kind: "send", wayHome: "none" })
    h.finish[0]({ content: "done" })
    await flush()
    expect(h.notified).toHaveLength(0)
  })

  it("is read back after a restart and settles lost, with a notice and no callback", async () => {
    const db = freshDb()
    const a = manager(db)
    const r = a.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "x", kind: "send", wayHome: "none" })
    a.mgr.stop()
    const b = manager(db)
    expect(b.mgr.isPending(r.taskId)).toBe(true)
    await b.mgr.recover()
    expect(row(db, r.taskId).status).toBe("lost")
    expect(b.notified.map((n) => n.status)).toEqual(["lost"])
    expect(b.turns).toHaveLength(0)
    expect(b.logs.join("\n")).not.toMatch(/way home unreadable/)
  })

  it("joins the open one when the same message is sent again", () => {
    const db = freshDb()
    const h = manager(db)
    const a = h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "same", kind: "send", wayHome: "none" })
    const b = h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "same", kind: "send", wayHome: "none" })
    expect(b).toMatchObject({ taskId: a.taskId, duplicate: true })
    expect(h.runs).toHaveLength(1)
    expect(h.mgr.joinKeyOf({ caller: agentCaller("builder"), callee: "worker", message: "same", wayHome: "none" })).toBe(row(db, a.taskId).join_key)
  })

  it("is never the target of a callee's reply relay", () => {
    const db = freshDb()
    const h = manager(db)
    const r = h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "x", kind: "send", wayHome: "none" })
    expect(h.mgr.replyTarget({ agentId: "worker", chatId: `a2a:builder:worker:${r.taskId}` }, "builder")).toBeNull()
  })
})

describe("one session per sender, kept as an implicit key (section 5, N2)", () => {
  it("seeds the first send after the deploy from the legacy per-sender chat", () => {
    const db = freshDb()
    const h = manager(db)
    h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "first", kind: "send", wayHome: "none" })
    expect(h.runs[0].resumeFrom).toEqual([{ channel: "a2a", chatId: "builder" }])
    h.mgr.start({ caller: agentCaller("?"), callee: "worker", message: "unnamed", kind: "send", wayHome: "none" })
    expect(h.runs[1].resumeFrom).toEqual([{ channel: "a2a", chatId: "a2a" }])
  })

  it("never seeds the #1749 caller-chat key from the legacy chat", () => {
    const db = freshDb()
    const h = manager(db)
    const turn: CallerTurn = { agentId: "builder", taskId: "t1", context: { channel: "a2a", chatId: "a2a:lead:builder:dlg-x" } }
    h.mgr.start({ caller: turn, callee: "worker", message: "callback send", kind: "send" })
    expect(h.runs[0].resumeFrom).toBeUndefined()
  })

  it("continues the last run of the same sender once it ended", async () => {
    const db = freshDb()
    const h = manager(db)
    const a = h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "one", kind: "send", wayHome: "none" })
    h.finish[0]({ content: "ok" })
    await flush()
    h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "two", kind: "send", wayHome: "none" })
    expect(h.runs[1].resumeFrom?.[0]).toEqual({ channel: "a2a", chatId: `a2a:builder:worker:${a.taskId}` })
  })

  it("starts a follow-up fresh beside a run still going, and counts it (C5)", () => {
    const db = freshDb()
    const h = manager(db)
    h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "one", kind: "send", wayHome: "none" })
    h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "two", kind: "send", wayHome: "none" })
    expect(h.runs[1].resumeFrom).toBeUndefined()
    expect(h.mgr.midTurnFollowUps()).toBe(1)
    expect(h.logs.join("\n")).toMatch(/follow-up from builder to worker while its last run is going/)
  })

  it("rebuilds the key after a restart from the newest ended none row", async () => {
    const db = freshDb()
    const a = manager(db)
    const first = a.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "one", kind: "send", wayHome: "none" })
    a.finish[0]({ content: "ok" })
    await flush()
    a.mgr.stop()
    const b = manager(db, {}, 101 * HOUR)
    b.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "two", kind: "send", wayHome: "none" })
    expect(b.runs[0].resumeFrom?.[0]).toEqual({ channel: "a2a", chatId: `a2a:builder:worker:${first.taskId}` })
  })

  function seed(db: Database.Database, id: string, o: { status: string; endedAt: number; wayHome?: string | null; home?: string | null; caller?: string; peer?: string | null }) {
    new HandoffStore(db)
    db.prepare(`INSERT INTO handoffs (id, caller, callee, peer, home, request, origin_json, root_json, started_at, status, ended_at, way_home, updated_at)
      VALUES (?, ?, 'worker', ?, ?, 'r', ?, '{"kind":"agent","channel":"api"}', ?, ?, ?, ?, ?)`)
      .run(id, o.caller ?? "builder", o.peer ?? null, o.home ?? null, o.wayHome === "none" ? null : '{"channel":"a2a","chatId":"c"}', o.endedAt - 1000, o.status, o.endedAt, o.wayHome ?? null, o.endedAt)
  }

  it("rebuilds only from none rows with no home (R3)", () => {
    const db = freshDb()
    const now = 100 * HOUR
    seed(db, "dlg-none", { status: "done", endedAt: now - 3 * HOUR, wayHome: "none" })
    seed(db, "dlg-callback", { status: "done", endedAt: now - 1 * HOUR, wayHome: null })
    seed(db, "dlg-home", { status: "done", endedAt: now - 2 * HOUR, wayHome: "none", home: "acme/site#3" })
    const h = manager(db, {}, now)
    h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "x", kind: "send", wayHome: "none" })
    expect(h.runs[0].resumeFrom?.[0]).toEqual({ channel: "a2a", chatId: "a2a:builder:worker:dlg-none" })
  })

  it("skips lost rows and rows older than the stale window (R4)", () => {
    const db = freshDb()
    const now = 100 * HOUR
    seed(db, "dlg-ok", { status: "timeout", endedAt: now - 4 * HOUR, wayHome: "none" })
    seed(db, "dlg-lost", { status: "lost", endedAt: now - 1 * HOUR, wayHome: "none" })
    seed(db, "dlg-old", { status: "done", endedAt: now - 13 * HOUR, wayHome: "none", caller: "front" })
    const h = manager(db, {}, now)
    h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "x", kind: "send", wayHome: "none" })
    expect(h.runs[0].resumeFrom?.[0]).toEqual({ channel: "a2a", chatId: "a2a:builder:worker:dlg-ok" })
    // Too old: the legacy chat is the seed, not the stale row.
    h.mgr.start({ caller: agentCaller("front"), callee: "worker", message: "y", kind: "send", wayHome: "none" })
    expect(h.runs[1].resumeFrom).toEqual([{ channel: "a2a", chatId: "front" }])
  })
})

describe("rollback (v2 §7, test 10)", () => {
  const ROLLBACK = "UPDATE handoffs SET status='lost', ended_at=@now, updated_at=@now WHERE status IS NULL AND way_home IN ('none','deliver')"

  it("closes open none and deliver rows and leaves callbacks and ended rows alone", () => {
    const db = freshDb()
    const h = manager(db)
    const none = h.mgr.start({ caller: agentCaller("builder"), callee: "worker", message: "a", kind: "send", wayHome: "none" })
    const deliver = h.mgr.start({ caller: { agentId: "front", context: { channel: "telegram", chatId: "c1" } }, callee: "default", peer: "vps", message: "b", wayHome: "deliver", run: () => new Promise(() => {}) })
    const callback = h.mgr.start({ caller: { agentId: "front", taskId: "t", context: { channel: "telegram", chatId: "c1" } }, callee: "worker", message: "c" })
    const changed = db.prepare(ROLLBACK).run({ now: 123 }).changes
    expect(changed).toBe(2)
    expect(row(db, none.taskId).status).toBe("lost")
    expect(row(db, deliver.taskId).status).toBe("lost")
    expect(row(db, callback.taskId).status).toBeNull()
    // Old rows (way_home NULL) still load as callbacks.
    expect(new HandoffStore(db).open().map((r) => r.id)).toEqual([callback.taskId])
  })

  it("is the statement the docs give", () => {
    const doc = readFileSync(join(__dirname, "../docs/reference/a2a.md"), "utf-8")
    expect(doc).toContain("WHERE status IS NULL AND way_home IN ('none','deliver')")
  })
})

describe("the sync agent-to-agent paths are gone", () => {
  const src = readFileSync(join(__dirname, "../src/daemon/index.ts"), "utf-8")
  const route = src.slice(src.indexOf("  private async sendToAgent("), src.indexOf("  private delegationGate("))
  const gate = src.slice(src.indexOf("  private delegationGate("), src.indexOf("  private handOffRefusal("))
  const task = src.slice(src.indexOf('case "POST /task": {'), src.indexOf('case "POST /mesh/task": {'))
  const meshTask = src.slice(src.indexOf('case "POST /mesh/task": {'), src.indexOf('case "POST /webrtc/signal/out"'))

  it("has no queueSend, no snd- id and no wait branch on /send/agent", () => {
    expect((sendAgent as Record<string, unknown>).queueSend).toBeUndefined()
    expect(readFileSync(join(__dirname, "../src/daemon/send-agent.ts"), "utf-8")).not.toContain("snd-")
    expect(route).not.toContain("queueSend(")
    expect(route).not.toMatch(/body\.async === false/)
    expect(route).not.toContain("mesh.sendTask(")
    expect(route).toMatch(/this\.delegationGate\([^;]*identity: true, unnamed: true/)
  })

  it("decides by the caller in the gate, after the caller is resolved", () => {
    const resolved = gate.indexOf("resolveCallerTurn(hint")
    const rule = gate.indexOf("agentCallerOf(hint, caller")
    expect(resolved).toBeGreaterThan(-1)
    expect(rule).toBeGreaterThan(resolved)
    // A none row is joined before the budget counts a hop (C2).
    expect(gate.indexOf("wayHome: \"none\"")).toBeLessThan(gate.indexOf("this.handOffRefusal("))
    expect(gate.indexOf("this.startNone(")).toBeGreaterThan(gate.indexOf("this.handOffRefusal("))
  })

  it("applies the rule on /task before the stream branch", () => {
    expect(task).toMatch(/this\.delegationGate\([\s\S]*?identity: true/)
    expect(task.indexOf("identity: true")).toBeLessThan(task.indexOf("if (wantStream)"))
  })

  it("applies the rule on /mesh/task right after the caller, before the stream branch (N1)", () => {
    const caller = meshTask.indexOf("const meshCaller = resolveCallerTurn(")
    const rule = meshTask.indexOf("agentCallerOf(")
    expect(rule).toBeGreaterThan(caller)
    expect(rule).toBeLessThan(meshTask.indexOf("if (wantStream)"))
    expect(rule).toBeLessThan(meshTask.indexOf("const result = await this.mesh.sendTask("))
  })

  it("leaves a guest host one synchronous request (R1)", () => {
    expect(meshTask).toMatch(/const meshAgent = host \|\| deliverReq \? null : agentCallerOf\(/)
    expect(meshTask.indexOf("const host = new GuestHostStore(")).toBeLessThan(meshTask.indexOf("agentCallerOf("))
    expect(meshTask).toContain("await askHost(host, String(body.message))")
  })

  it("keeps deliver for an explicit async:true only, and forwards the context on a callback (R2)", () => {
    expect(meshTask).toMatch(/const deliverReq = body\.async === true &&/)
    const agentBranch = meshTask.slice(meshTask.indexOf("if (meshAgent) {"), meshTask.indexOf("const overBudget"))
    expect(agentBranch).toContain("context: meshContext")
    expect(agentBranch).not.toContain("startMeshDeliver(")
  })
})

describe("agentx demo reads the reply by its id (C4)", () => {
  it("waits for the hand-off to end and returns its text", async () => {
    const calls: string[] = []
    const answers = [{ status: "running" }, { status: "running" }, { status: "done", text: "fixed in abc123" }]
    const text = await waitForHandoffReply((path) => { calls.push(path); return Promise.resolve(answers.shift()) }, "dlg-1", "cx", { pollMs: 1, timeoutMs: 1000 })
    expect(text).toBe("fixed in abc123")
    expect(calls[0]).toBe("/a2a/delegations/dlg-1?as=cx")
  })

  it("says how it ended when it did not finish, and gives up after its limit", async () => {
    expect(await waitForHandoffReply(async () => ({ status: "timeout", text: "no answer" }), "dlg-2", "cx", { pollMs: 1, timeoutMs: 100 })).toBe("(timeout) no answer")
    expect(await waitForHandoffReply(async () => ({ status: "running" }), "dlg-3", "cx", { pollMs: 1, timeoutMs: 10 })).toMatch(/still running.*dlg-3/)
  })

  it("no longer sends async:false", () => {
    const demo = readFileSync(join(__dirname, "../src/commands/demo.ts"), "utf-8")
    expect(demo).not.toMatch(/async: false/)
    expect(demo).toContain("waitForHandoffReply(")
  })
})

describe("NONE_ORIGIN", () => {
  it("is not a chat anything can be sent to", () => {
    expect(NONE_ORIGIN.channel).toBe("none")
  })
})
