import { describe, it, expect, onTestFinished } from "vitest"
import Database from "better-sqlite3"
import { HandoffStore, RESULT_TEXT_CAP } from "../src/a2a/handoff-store"
import { DelegationManager, type CallerTurn, type DelegationDeps, type DelegationRecord } from "../src/a2a/delegation"
import { mayReadHandoff, readHandoff } from "../src/a2a/handoff-read"

// #2007 piece 1: the hand-off journal keeps the answer and can be read by
// its id. Nothing here changes who gets a 202, the sync paths or which
// session a run continues: the delegation and send tests run unchanged.

function rec(id: string, over: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    id,
    caller: "front",
    callee: "worker",
    request: "Find the report",
    origin: { channel: "telegram", chatId: "chat-1" },
    root: { kind: "human", channel: "telegram", chatId: "chat-1" } as any,
    startedAt: 1000,
    ...over,
  }
}

function freshDb(): Database.Database {
  const db = new Database(":memory:")
  onTestFinished(() => db.close())
  return db
}

const columns = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(handoffs)").all() as Array<{ name: string }>).map((c) => c.name)

/** The table as the release before piece 1 made it. */
function oldTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE handoffs (
      id TEXT PRIMARY KEY, caller TEXT, callee TEXT, peer TEXT, kind TEXT, depth INTEGER, home TEXT, task_type TEXT,
      request TEXT, origin_json TEXT, root_json TEXT, started_at INTEGER, status TEXT, ended_at INTEGER,
      relay_json TEXT, relay_attempt INTEGER, relay_at INTEGER, source TEXT NOT NULL DEFAULT 'db', updated_at INTEGER NOT NULL
    );
  `)
  const origin = JSON.stringify({ channel: "telegram", chatId: "chat-1" })
  const ins = db.prepare("INSERT INTO handoffs (id, caller, callee, request, origin_json, root_json, started_at, status, updated_at) VALUES (?, ?, ?, ?, ?, 'null', ?, ?, 1)")
  ins.run("dlg-open-1", "front", "worker", "a", origin, 10, null)
  ins.run("dlg-open-2", "front", "worker", "a", origin, 20, null)
  ins.run("dlg-ended", "front", "worker", "b", origin, 30, "done")
  // A done-only line from the #1962 import: no caller, no start.
  db.prepare("INSERT INTO handoffs (id, status, ended_at, source, updated_at) VALUES ('dlg-stub', 'done', 5, 'file', 5)").run()
}

describe("the journal columns (#2007 piece 1)", () => {
  it("adds join_key, way_home, result_text and waiting_json to an old table, keeping its rows", () => {
    const db = freshDb()
    oldTable(db)
    const store = new HandoffStore(db)
    expect(columns(db)).toEqual(expect.arrayContaining(["join_key", "way_home", "result_text", "waiting_json"]))
    expect(store.open().map((r) => r.id)).toEqual(["dlg-open-1", "dlg-open-2"])
    // Old rows have no key and no way home: a NULL way home is a callback.
    expect(db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE join_key IS NULL AND way_home IS NULL").get()).toEqual({ n: 4 })
  })

  it("is safe to make twice, as two processes on one database do", () => {
    const db = freshDb()
    new HandoffStore(db)
    expect(() => new HandoffStore(db)).not.toThrow()
    expect(columns(db).filter((c) => c === "result_text")).toHaveLength(1)
  })

  it("has a unique index on the key of open rows only", () => {
    const db = freshDb()
    oldTable(db)
    new HandoffStore(db)
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_handoffs_join'").get() as { sql: string }
    expect(idx.sql).toMatch(/UNIQUE INDEX/i)
    expect(idx.sql).toMatch(/WHERE status IS NULL/i)
    const add = db.prepare("INSERT OR IGNORE INTO handoffs (id, caller, callee, started_at, join_key, updated_at) VALUES (?, 'front', 'worker', 1, ?, 1)")
    expect(add.run("dlg-k1", "k").changes).toBe(1)
    // The same key while the first is open: ignored, nothing inserted.
    expect(add.run("dlg-k2", "k").changes).toBe(0)
    // Once the first ends its key is free again.
    db.prepare("UPDATE handoffs SET status = 'done' WHERE id = 'dlg-k1'").run()
    expect(add.run("dlg-k3", "k").changes).toBe(1)
  })

  it("nothing writes a join key or a way home yet", () => {
    const db = freshDb()
    const store = new HandoffStore(db)
    store.insert(rec("dlg-a"), 1000)
    store.end("dlg-a", "done", 2000, undefined, { status: "done", text: "ok" })
    expect(db.prepare("SELECT join_key, way_home FROM handoffs WHERE id = 'dlg-a'").get()).toEqual({ join_key: null, way_home: null })
  })
})

describe("the answer is kept where the hand-off ends", () => {
  it("stores the callee's answer in the same write that ends the row", () => {
    const db = freshDb()
    const store = new HandoffStore(db)
    store.insert(rec("dlg-a"), 1000)
    expect(store.end("dlg-a", "done", 2000, undefined, { status: "done", text: "The report is ready" })).toBe("ended")
    expect(store.read("dlg-a")).toMatchObject({ id: "dlg-a", status: "done", text: "The report is ready" })
  })

  it(`caps the answer at ${RESULT_TEXT_CAP.toLocaleString("en")} characters`, () => {
    expect(RESULT_TEXT_CAP).toBe(12_000)
    const db = freshDb()
    const store = new HandoffStore(db)
    store.insert(rec("dlg-a"), 1000)
    store.end("dlg-a", "done", 2000, undefined, { status: "done", text: "x".repeat(20_000) })
    expect(store.read("dlg-a")!.text!.length).toBe(RESULT_TEXT_CAP)
  })

  it("keeps the first outcome's text: a late answer does not replace it", () => {
    const db = freshDb()
    const store = new HandoffStore(db)
    store.insert(rec("dlg-a"), 1000)
    store.end("dlg-a", "timeout", 2000, undefined, { status: "timeout", text: "no answer in time" })
    expect(store.end("dlg-a", "done", 3000, undefined, { status: "done", text: "late" })).toBe("taken")
    expect(store.read("dlg-a")).toMatchObject({ status: "timeout", text: "no answer in time" })
  })

  it("stores what a waiting callee waits for, with the kind of wait", () => {
    const db = freshDb()
    const store = new HandoffStore(db)
    store.insert(rec("dlg-w"), 1000)
    store.insert(rec("dlg-c"), 1000)
    store.insert(rec("dlg-s"), 1000)
    store.end("dlg-w", "waiting", 2000, undefined, {
      status: "waiting", text: "waiting", waiting: { on: "the build", dueAt: 5000 }, state: { state: "waiting", on: "the build" } as any,
    })
    store.end("dlg-c", "waiting", 2000, undefined, {
      status: "waiting", text: "more to do", waiting: { on: "worker to carry on: tests" }, state: { state: "continue", left: "tests" } as any,
    })
    // Said with agentx_waiting (markWaiting), no job state: a wait.
    store.end("dlg-s", "waiting", 2000, undefined, { status: "waiting", text: "later", waiting: { on: "a reply" } })
    const json = (id: string) => JSON.parse((db.prepare("SELECT waiting_json FROM handoffs WHERE id = ?").get(id) as any).waiting_json)
    expect(json("dlg-w")).toEqual({ kind: "waiting", on: "the build", dueAt: 5000 })
    expect(json("dlg-c")).toEqual({ kind: "continue", on: "worker to carry on: tests" })
    expect(json("dlg-s")).toEqual({ kind: "waiting", on: "a reply" })
    expect(store.read("dlg-w")!.waiting).toEqual({ kind: "waiting", on: "the build", dueAt: new Date(5000).toISOString() })
    expect(store.read("dlg-c")!.waiting).toEqual({ kind: "continue", on: "worker to carry on: tests" })
  })

  it("writes no waiting for an outcome that is not a wait", () => {
    const db = freshDb()
    const store = new HandoffStore(db)
    store.insert(rec("dlg-a"), 1000)
    store.end("dlg-a", "done", 2000, undefined, { status: "done", text: "ok" })
    expect(db.prepare("SELECT waiting_json FROM handoffs WHERE id = 'dlg-a'").get()).toEqual({ waiting_json: null })
    expect(store.read("dlg-a")!.waiting).toBeUndefined()
  })
})

describe("read by id and the list from the table", () => {
  it("reads an open row as running, with no text", () => {
    const db = freshDb()
    const store = new HandoffStore(db)
    store.insert(rec("dlg-a", { peer: "east" }), 1000)
    expect(store.read("dlg-a")).toEqual({
      id: "dlg-a", caller: "front", callee: "worker", peer: "east", status: "running", startedAt: new Date(1000).toISOString(),
    })
    expect(store.read("dlg-missing")).toBeNull()
  })

  it("never reads an import stub: it has no caller", () => {
    const db = freshDb()
    oldTable(db)
    const store = new HandoffStore(db)
    expect(store.read("dlg-stub")).toBeNull()
  })

  it("lists newest first, without import stubs and without any text", () => {
    const db = freshDb()
    oldTable(db)
    const store = new HandoffStore(db)
    store.insert(rec("dlg-new", { startedAt: 40 }), 40)
    store.end("dlg-new", "done", 50, undefined, { status: "done", text: "secret answer" })
    const list = store.list(10)
    expect(list.map((r) => r.id)).toEqual(["dlg-new", "dlg-ended", "dlg-open-2", "dlg-open-1"])
    expect(list[0]).toEqual({ id: "dlg-new", caller: "front", callee: "worker", status: "done", startedAt: new Date(40).toISOString(), endedAt: new Date(50).toISOString() })
    expect(list[2]).toMatchObject({ id: "dlg-open-2", status: "running" })
    expect(JSON.stringify(list)).not.toContain("secret answer")
    expect(store.list(2).map((r) => r.id)).toEqual(["dlg-new", "dlg-ended"])
  })
})

const HUMAN_TURN: CallerTurn = { agentId: "front", taskId: "run-1", context: { channel: "telegram", chatId: "chat-1", sender: "Sam" } }

function manager(db: Database.Database | null) {
  const deps: DelegationDeps = {
    timeoutMs: 60_000,
    pollMs: 1,
    runLocal: () => new Promise(() => {}),
    runPeer: () => new Promise(() => {}),
    cancelLocal: () => {},
    injectTurn: async () => ({ content: "ok" }),
    isChatBusy: () => false,
    canDeliver: () => true,
    deliver: async () => {},
    log: () => {},
    ...(db ? { store: new HandoffStore(db) } : {}),
  }
  const mgr = new DelegationManager(deps)
  onTestFinished(() => mgr.stop())
  return mgr
}

describe("the manager on the journal", () => {
  it("keeps the answer when a hand-off completes, readable by its id", async () => {
    const db = freshDb()
    const mgr = manager(db)
    const { taskId } = mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Check the build" })
    await mgr.complete(taskId, { status: "done", text: "Build is green" })
    expect(new HandoffStore(db).read(taskId)).toMatchObject({ status: "done", text: "Build is green" })
  })

  it("lists hand-offs after a restart: the list reads the table, not memory", async () => {
    const db = freshDb()
    const first = manager(db)
    const { taskId } = first.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    await first.complete(taskId, { status: "done", text: "ok" })
    first.stop()
    const again = manager(db)
    expect(again.list()).toEqual([expect.objectContaining({ id: taskId, caller: "front", callee: "worker", status: "done" })])
  })

  it("keeps the in-memory list on a node with no database", () => {
    const mgr = manager(null)
    const { taskId } = mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    expect(mgr.list()).toEqual([expect.objectContaining({ id: taskId, status: "running" })])
  })
})

describe("who may read a hand-off by its id (review Q1)", () => {
  const local = { caller: "front", callee: "worker" }
  const toPeer = { caller: "front", callee: "far-agent", peer: "east" }

  it("the operator key reads every row", () => {
    expect(mayReadHandoff({ operator: true, local: false, as: null, peer: null }, toPeer)).toBe(true)
  })

  it("on this machine, only when the request names the caller or the callee", () => {
    expect(mayReadHandoff({ operator: false, local: true, as: "front", peer: null }, local)).toBe(true)
    expect(mayReadHandoff({ operator: false, local: true, as: "worker", peer: null }, local)).toBe(true)
    expect(mayReadHandoff({ operator: false, local: true, as: "other", peer: null }, local)).toBe(false)
    expect(mayReadHandoff({ operator: false, local: true, as: null, peer: null }, local)).toBe(false)
  })

  it("a peer reads only rows it is the callee of", () => {
    expect(mayReadHandoff({ operator: false, local: false, as: "far-agent", peer: null }, toPeer)).toBe(true)
    expect(mayReadHandoff({ operator: false, local: false, as: "far-agent", peer: "east" }, toPeer)).toBe(true)
    // Its token names another peer.
    expect(mayReadHandoff({ operator: false, local: false, as: "far-agent", peer: "west" }, toPeer)).toBe(false)
    // An agent of this node is never a peer's to read as.
    expect(mayReadHandoff({ operator: false, local: false, as: "front", peer: null }, toPeer)).toBe(false)
    expect(mayReadHandoff({ operator: false, local: false, as: "worker", peer: null }, local)).toBe(false)
    expect(mayReadHandoff({ operator: false, local: false, as: null, peer: "east" }, toPeer)).toBe(false)
  })
})

describe("GET /a2a/delegations/:id", () => {
  function setup() {
    const db = freshDb()
    const store = new HandoffStore(db)
    store.insert(rec("dlg-a"), 1000)
    store.end("dlg-a", "done", 2000, undefined, { status: "done", text: "Here it is" })
    return store
  }

  it("returns the bounded fields to the caller", () => {
    const r = readHandoff(setup(), "dlg-a", { operator: false, local: true, as: "front", peer: null })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      id: "dlg-a", caller: "front", callee: "worker", status: "done", text: "Here it is",
      startedAt: new Date(1000).toISOString(), endedAt: new Date(2000).toISOString(),
    })
  })

  it("answers 404 for an unknown id and for one the asker may not read, alike", () => {
    const store = setup()
    const unknown = readHandoff(store, "dlg-zzz", { operator: false, local: true, as: "front", peer: null })
    const refused = readHandoff(store, "dlg-a", { operator: false, local: true, as: "other", peer: null })
    expect(unknown.status).toBe(404)
    expect(refused.status).toBe(404)
    expect(refused.body).toEqual(unknown.body)
  })

  it("asks the reader to name itself when it shows no operator key", () => {
    const r = readHandoff(setup(), "dlg-a", { operator: false, local: true, as: null, peer: null })
    expect(r.status).toBe(400)
    expect(String((r.body as any).error)).toContain("?as=")
  })

  it("answers 409 on a node with no database", () => {
    expect(readHandoff(null, "dlg-a", { operator: true, local: true, as: null, peer: null }).status).toBe(409)
  })
})
