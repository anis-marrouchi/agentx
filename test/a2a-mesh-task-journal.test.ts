import { describe, it, expect, onTestFinished } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import Database from "better-sqlite3"
import { HandoffStore } from "../src/a2a/handoff-store"
import { DelegationManager, type DelegationDeps } from "../src/a2a/delegation"
import { meshDeliverJoined, startMeshDeliver } from "../src/daemon/delegation-wiring"

// #2007 piece 4b (S5): /mesh/task with an explicit async:true runs on the
// hand-off journal. It writes one `handoffs` row (way_home 'deliver', with
// a join key), returns that row's dlg- id at once, ends the row once with
// its result_text, and still delivers the raw answer to the named chat.
// Who decides async, and the sync and stream callers, are unchanged.

function freshDb(): Database.Database {
  const db = new Database(":memory:")
  onTestFinished(() => db.close())
  return db
}

type Delivered = Parameters<DelegationDeps["deliver"]>[0]

function manager(db: Database.Database | null, over: Partial<DelegationDeps> = {}) {
  const logs: string[] = []
  const delivered: Delivered[] = []
  const started: string[] = []
  const done: string[] = []
  let now = 1_000_000
  const store = db ? new HandoffStore(db) : null
  const deps: DelegationDeps = {
    timeoutMs: 60 * 60_000,
    pollMs: 1,
    runLocal: () => new Promise(() => {}),
    runPeer: () => { throw new Error("a deliver row runs through its own call, never runPeer") },
    cancelLocal: () => {},
    injectTurn: async () => { throw new Error("a deliver row has no callback turn") },
    isChatBusy: () => false,
    canDeliver: () => true,
    deliver: async (m) => { delivered.push(m) },
    log: (m) => logs.push(m),
    onStarted: (r) => started.push(r.id),
    onDone: (r) => done.push(r.id),
    now: () => now,
    ...(store ? { store } : {}),
    ...over,
  }
  const mgr = new DelegationManager(deps)
  onTestFinished(() => mgr.stop())
  return { mgr, logs, delivered, started, done, store, tick: (ms: number) => { now += ms } }
}

const CHAT = { channel: "telegram", chatId: "chat-9", agentId: "front" }

function deferred() {
  let resolve!: (v: string) => void
  let reject!: (e: Error) => void
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise((r) => setTimeout(r, 5))

const rowOf = (db: Database.Database, id: string) =>
  db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Record<string, any> | undefined

describe("/mesh/task async:true on the hand-off journal (#2007 S5)", () => {
  it("writes one row with way_home 'deliver' and a join key, and answers 202 with its dlg- id", () => {
    const db = freshDb()
    const { mgr } = manager(db)
    const run = deferred()
    const r = startMeshDeliver(mgr, { peer: "far", agent: "worker", message: "Check the build", context: CHAT, run: () => run.promise })
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ accepted: true, mode: "deliver", agent: "worker", peer: "far", deliverTo: "telegram:chat-9" })
    const id = String(r.body.taskId)
    expect(id).toMatch(/^dlg-/)
    const rows = db.prepare("SELECT * FROM handoffs").all() as Array<Record<string, any>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, caller: "front", callee: "worker", peer: "far", way_home: "deliver", status: null })
    expect(rows[0].join_key).toBeTruthy()
    expect(JSON.parse(rows[0].origin_json)).toMatchObject({ channel: "telegram", chatId: "chat-9" })
  })

  it("ends the row with result_text, delivers the raw answer once, and is readable by id", async () => {
    const db = freshDb()
    const { mgr, delivered, store } = manager(db)
    const run = deferred()
    const id = String(startMeshDeliver(mgr, { peer: "far", agent: "worker", message: "Check the build", context: CHAT, run: () => run.promise }).body.taskId)
    run.resolve("Build is green.")
    await flush()
    expect(rowOf(db, id)).toMatchObject({ status: "done", result_text: "Build is green.", relay_attempt: null })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ channel: "telegram", chatId: "chat-9", text: "Build is green.", agentId: "front", taskId: id, outcome: "done", countsAsReply: true })
    expect(store!.read(id)).toMatchObject({ id, caller: "front", callee: "worker", peer: "far", status: "done", text: "Build is green.", wayHome: "deliver" })
    // The first outcome wins: a late copy changes nothing.
    expect(await mgr.complete(id, { status: "done", text: "again" })).toBe(false)
    expect(delivered).toHaveLength(1)
  })

  it("a failed call ends the row 'error' and tells the same chat once, as a notice", async () => {
    const db = freshDb()
    const { mgr, delivered } = manager(db)
    const run = deferred()
    const id = String(startMeshDeliver(mgr, { peer: "far", agent: "worker", message: "Check the build", context: CHAT, run: () => run.promise }).body.taskId)
    run.reject(new Error("peer unreachable"))
    await flush()
    expect(rowOf(db, id)).toMatchObject({ status: "error", result_text: "peer unreachable" })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ chatId: "chat-9", outcome: "error", countsAsReply: false })
    expect(delivered[0].text).toBe("Delegation to far/worker failed: peer unreachable")
  })

  it("times out on the row's own timer and says so in the chat", async () => {
    const db = freshDb()
    const { mgr, delivered } = manager(db, { timeoutMs: 20 })
    const id = String(startMeshDeliver(mgr, { peer: "far", agent: "worker", message: "Check the build", context: CHAT, run: () => new Promise(() => {}) }).body.taskId)
    await new Promise((r) => setTimeout(r, 60))
    expect(rowOf(db, id)?.status).toBe("timeout")
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toMatch(/^Delegation to far\/worker failed: No answer from worker@far/)
  })

  it("a duplicate while open joins: same id, duplicate:true, one call", () => {
    const db = freshDb()
    const { mgr } = manager(db)
    let calls = 0
    const run = () => { calls++; return new Promise<string>(() => {}) }
    const o = { peer: "far", agent: "worker", message: "Check the build", context: CHAT, run }
    const a = startMeshDeliver(mgr, o)
    expect(meshDeliverJoined(mgr, o)).toMatchObject({ accepted: true, mode: "deliver", taskId: a.body.taskId, duplicate: true })
    const b = startMeshDeliver(mgr, o)
    expect(b.status).toBe(202)
    expect(b.body).toMatchObject({ taskId: a.body.taskId, duplicate: true, deliverTo: "telegram:chat-9" })
    expect(calls).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM handoffs").get() as { n: number }).n).toBe(1)
    // Another chat, another peer, or another message is new work.
    expect(meshDeliverJoined(mgr, { ...o, context: { ...CHAT, chatId: "chat-10" } })).toBeNull()
    expect(meshDeliverJoined(mgr, { ...o, peer: "near" })).toBeNull()
    expect(meshDeliverJoined(mgr, { ...o, agent: undefined })).toBeNull()
    expect(meshDeliverJoined(mgr, { ...o, message: "Check the tests" })).toBeNull()
  })

  it("an ended row frees its key: a resend starts fresh", async () => {
    const db = freshDb()
    const { mgr } = manager(db)
    const run = deferred()
    const o = { peer: "far", agent: "worker", message: "Check the build", context: CHAT, run: () => run.promise }
    const a = startMeshDeliver(mgr, o)
    run.resolve("ok")
    await flush()
    expect(meshDeliverJoined(mgr, o)).toBeNull()
    const b = startMeshDeliver(mgr, { ...o, run: () => new Promise(() => {}) })
    expect(b.body.taskId).not.toBe(a.body.taskId)
    expect(b.body.duplicate).toBeUndefined()
  })

  it("no agent named: the peer picks one; the row names it 'default'", async () => {
    const db = freshDb()
    const { mgr, delivered } = manager(db)
    const run = deferred()
    const r = startMeshDeliver(mgr, { peer: "far", message: "hello", context: CHAT, run: () => run.promise })
    expect(r.body).not.toHaveProperty("agent")
    run.reject(new Error("boom"))
    await flush()
    expect(rowOf(db, String(r.body.taskId))).toMatchObject({ callee: "default", peer: "far", status: "error" })
    expect(delivered[0].text).toBe("Delegation to far/default failed: boom")
  })

  it("is not an open request or a job: the request and job listeners are not told", async () => {
    const db = freshDb()
    const { mgr, started, done } = manager(db)
    const run = deferred()
    startMeshDeliver(mgr, { peer: "far", agent: "worker", message: "x", context: CHAT, run: () => run.promise })
    run.resolve("ok")
    await flush()
    expect(started).toEqual([])
    expect(done).toEqual([])
  })

  it("a peer answer that states blocked or stalled is the peer's answer: delivered raw, as a reply", async () => {
    for (const answer of ["Tried the deploy.\nState: blocked — the deploy key is missing", "Looked at it.\n[job stalled] no state given"]) {
      const db = freshDb()
      const { mgr, delivered } = manager(db)
      const run = deferred()
      const id = String(startMeshDeliver(mgr, { peer: "far", agent: "worker", message: "Deploy", context: CHAT, run: () => run.promise }).body.taskId)
      run.resolve(answer)
      await flush()
      expect(rowOf(db, id)?.status).toBe("error")
      expect(delivered).toHaveLength(1)
      expect(delivered[0].text).not.toMatch(/^Delegation to /)
      expect(delivered[0].text).toContain(answer.split("\n")[0])
      expect(delivered[0].countsAsReply).toBe(true)
    }
  })

  it("an unnamed caller is not passed on as an agent", async () => {
    const db = freshDb()
    const { mgr, delivered } = manager(db)
    const run = deferred()
    const id = String(startMeshDeliver(mgr, { peer: "far", agent: "worker", message: "x", context: { channel: "telegram", chatId: "chat-9" }, run: () => run.promise }).body.taskId)
    expect(rowOf(db, id)?.caller).toBe("?")
    run.resolve("ok")
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].agentId).toBeUndefined()
    expect(delivered[0].record).toBe(false)
  })

  it("a restart while open ends it 'lost' and tells the named chat once", async () => {
    const db = freshDb()
    const first = manager(db)
    const id = String(startMeshDeliver(first.mgr, { peer: "far", agent: "worker", message: "Check the build", context: CHAT, run: () => new Promise(() => {}) }).body.taskId)
    first.mgr.stop()
    const second = manager(db)
    expect(await second.mgr.recover()).toBe(1)
    expect(rowOf(db, id)?.status).toBe("lost")
    expect(second.delivered).toHaveLength(1)
    expect(second.delivered[0]).toMatchObject({ channel: "telegram", chatId: "chat-9", taskId: id, outcome: "error", countsAsReply: false })
    expect(second.delivered[0].text).toMatch(/^Delegation to far\/worker failed: This machine restarted/)
  })

  it("works on a node with no database, in memory", async () => {
    const { mgr, delivered } = manager(null)
    const run = deferred()
    const r = startMeshDeliver(mgr, { peer: "far", agent: "worker", message: "x", context: CHAT, run: () => run.promise })
    expect(String(r.body.taskId)).toMatch(/^dlg-/)
    run.resolve("ok")
    await flush()
    expect(delivered.map((d) => d.text)).toEqual(["ok"])
  })
})

describe("/mesh/task: only explicit async:true moves (#2007 S5)", () => {
  const src = readFileSync(join(__dirname, "../src/daemon/index.ts"), "utf-8")
  const meshTask = src.slice(src.indexOf('case "POST /mesh/task"'), src.indexOf('case "POST /webrtc/signal/out"'))

  it("the async branch starts a deliver row and no longer makes a mesh- id", () => {
    const asyncBranch = meshTask.slice(meshTask.indexOf("if (body.async === true)"), meshTask.lastIndexOf("const result = await this.mesh.sendTask("))
    expect(asyncBranch).toMatch(/startMeshDeliver\(this\.delegations,/)
    expect(asyncBranch).not.toMatch(/`mesh-\$\{/)
  })

  it("a duplicate joins before the hand-off budget counts a hop", () => {
    const join = meshTask.indexOf("meshDeliverJoined(this.delegations,")
    expect(join).toBeGreaterThan(0)
    expect(join).toBeLessThan(meshTask.indexOf("this.handOffRefusal(meshCaller"))
  })

  it("the stream and sync ways are unchanged", () => {
    expect(meshTask).toMatch(/const wantStream = body\.stream === true \|\| acceptHeader\.includes\("text\/event-stream"\)/)
    expect(meshTask).toMatch(/for await \(const ev of this\.mesh\.sendTaskStream\(/)
    expect(meshTask).toMatch(/const result = await this\.mesh\.sendTask\(\s*body\.peer as string,\s*body\.message as string,\s*body\.agent as string \| undefined,\s*\{ context: meshContext, senderAgentId: meshSender, vouchOwner \},\s*\)\s*this\.json\(res, 200, \{ response: result \}\)/)
    // The stream branch comes before the async one: a stream never becomes a row.
    expect(meshTask.indexOf("if (wantStream)")).toBeLessThan(meshTask.indexOf("if (body.async === true)"))
  })
})
