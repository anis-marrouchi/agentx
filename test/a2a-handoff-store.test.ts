import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { HandoffStore, handoffStoreFor } from "../src/a2a/handoff-store"
import type { DelegationRecord } from "../src/a2a/delegation"

// #1861: the hand-off log moves from .agentx/a2a/delegations.jsonl into a
// `handoffs` table of the jobs database.

function rec(id: string, over: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    id,
    caller: "front",
    callee: "worker",
    request: "Find the report",
    origin: { channel: "telegram", chatId: "chat-1", accountId: "acct-1", channelMeta: { thread: 7 } },
    root: { kind: "human", channel: "telegram", chatId: "chat-1" } as any,
    startedAt: 1000,
    ...over,
  }
}

let db: Database.Database
let store: HandoffStore
let dir: string

beforeEach(() => {
  db = new Database(":memory:")
  store = new HandoffStore(db)
  dir = mkdtempSync(join(tmpdir(), "agentx-handoffs-"))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("the handoffs table", () => {
  it("keeps a hand-off and its way home", () => {
    store.insert(rec("dlg-a", { peer: "vps", kind: "send", depth: 2, home: "group/app#3", taskType: "code" }), 1000)
    expect(store.open()).toEqual([rec("dlg-a", { peer: "vps", kind: "send", depth: 2, home: "group/app#3", taskType: "code" })])
  })

  it("ends a hand-off once: the first outcome wins", () => {
    store.insert(rec("dlg-a"), 1000)
    expect(store.end("dlg-a", "done", 2000)).toBe("ended")
    expect(store.end("dlg-a", "lost", 3000)).toBe("taken")
    expect(store.end("dlg-missing", "done", 3000)).toBe("missing")
    expect(store.statusOf("dlg-a")).toBe("done")
    expect(store.statusOf("dlg-missing")).toBeNull()
    expect(store.open()).toEqual([])
  })

  it("holds a callback, re-holds it as the re-run, and releases it", () => {
    store.insert(rec("dlg-a"), 1000)
    store.end("dlg-a", "done", 2000)
    store.hold(rec("dlg-a"), { result: { status: "done", text: "Here" }, reply: true }, 1, 3000)
    expect(store.held()).toEqual([{ record: rec("dlg-a"), result: { status: "done", text: "Here" }, attempt: 1, reply: true }])
    // The re-run is claimed once: a second process finds it taken.
    expect(store.claimRerun("dlg-a", 4000)).toBe(true)
    expect(store.claimRerun("dlg-a", 4001)).toBe(false)
    expect(store.held()[0].attempt).toBe(2)
    store.release("dlg-a", 5000)
    expect(store.held()).toEqual([])
  })

  it("marks an answer whose callback has not started, and clears the mark when it starts", () => {
    store.insert(rec("dlg-a"), 1000)
    store.insert(rec("dlg-b"), 1000)
    expect(store.end("dlg-a", "done", 2000, { result: { status: "done", text: "A" }, wrote: true })).toBe("ended")
    expect(store.end("dlg-b", "error", 2000, { result: { status: "error", text: "B" } })).toBe("ended")
    expect(store.held()).toEqual([
      { record: rec("dlg-a"), result: { status: "done", text: "A" }, attempt: 1, wrote: true, pending: true },
      { record: rec("dlg-b"), result: { status: "error", text: "B" }, attempt: 1, pending: true },
    ])
    store.clearPending(["dlg-a"], 3000)
    expect(store.held().map((h) => h.record.id)).toEqual(["dlg-b"])
  })

  it("never lets a pending mark replace a held callback", () => {
    store.insert(rec("dlg-a"), 1000)
    store.hold(rec("dlg-a"), { result: { status: "done", text: "progress" }, reply: true }, 1, 1500)
    store.end("dlg-a", "done", 2000, { result: { status: "done", text: "end" } })
    store.clearPending(["dlg-a"], 2500)
    expect(store.held()).toEqual([{ record: rec("dlg-a"), result: { status: "done", text: "progress" }, attempt: 1, reply: true }])
  })

  it("prunes ended hand-offs past retention, never one still out or still held", () => {
    store.insert(rec("dlg-old"), 1000)
    store.end("dlg-old", "done", 1000)
    store.insert(rec("dlg-held"), 1000)
    store.end("dlg-held", "done", 1000)
    store.hold(rec("dlg-held"), { result: { status: "done", text: "x" } }, 1, 1000)
    store.insert(rec("dlg-pending"), 1000)
    store.end("dlg-pending", "done", 1000, { result: { status: "done", text: "y" } })
    store.insert(rec("dlg-out"), 1000)
    store.insert(rec("dlg-new"), 1000)
    store.end("dlg-new", "done", 9000)
    expect(store.prune(5000)).toBe(1)
    expect(store.statusOf("dlg-old")).toBeNull()
    expect(store.open().map((r) => r.id)).toEqual(["dlg-out"])
    expect(store.held().map((h) => h.record.id).sort()).toEqual(["dlg-held", "dlg-pending"])
    expect(store.statusOf("dlg-new")).toBe("done")
  })

  it("names who each hand-off went to", () => {
    store.insert(rec("dlg-a"), 1000)
    store.insert(rec("dlg-b", { callee: "pm", peer: "vps" }), 1000)
    expect([...store.agents()].sort()).toEqual([["dlg-a", "worker"], ["dlg-b", "pm@vps"]])
  })

  it("lists the last finished ids, oldest first", () => {
    for (const [i, s] of (["done", "error", "lost"] as const).entries()) {
      store.insert(rec(`dlg-${i}`), 1000)
      store.end(`dlg-${i}`, s, 2000 + i)
    }
    expect(store.recentDone(2)).toEqual([["dlg-1", "error"], ["dlg-2", "lost"]])
  })

  it("skips a row whose way home cannot be read", () => {
    store.insert(rec("dlg-a"), 1000)
    store.insert(rec("dlg-b"), 1000)
    db.prepare("UPDATE handoffs SET origin_json = '{bad' WHERE id = 'dlg-a'").run()
    const logs: string[] = []
    expect(new HandoffStore(db, (m) => logs.push(m)).open().map((r) => r.id)).toEqual(["dlg-b"])
    expect(logs.join("\n")).toContain("dlg-a")
  })
})

describe("importing the old delegation log", () => {
  const line = (o: object) => JSON.stringify(o)
  const file = (lines: string[]) => {
    const p = join(dir, "delegations.jsonl")
    writeFileSync(p, lines.join("\n") + "\n")
    return p
  }
  const rows = () => db.prepare("SELECT id, caller, status, ended_at, relay_attempt, source FROM handoffs ORDER BY id").all()

  it("turns all four line types into rows, and a second import changes nothing", () => {
    const p = file([
      line({ type: "start", ts: 1000, ...rec("dlg-a") }),
      line({ type: "start", ts: 1000, ...rec("dlg-b") }),
      line({ type: "start", ts: 1000, ...rec("dlg-c") }),
      line({ type: "done", id: "dlg-b", status: "timeout", ts: 2000 }),
      line({ type: "done", id: "dlg-c", status: "done", ts: 2100 }),
      line({ type: "relay", id: "dlg-c", ts: 2200, record: rec("dlg-c"), result: { status: "done", text: "C" }, attempt: 1 }),
      '{"type":"start","id":"dlg-cut',
    ])
    expect(store.importFile(p)).toMatchObject({ skipped: 1 })
    const first = rows()
    expect(first).toEqual([
      { id: "dlg-a", caller: "front", status: null, ended_at: null, relay_attempt: null, source: "file" },
      { id: "dlg-b", caller: "front", status: "timeout", ended_at: 2000, relay_attempt: null, source: "file" },
      { id: "dlg-c", caller: "front", status: "done", ended_at: 2100, relay_attempt: 1, source: "file" },
    ])
    expect(store.held()).toEqual([{ record: rec("dlg-c"), result: { status: "done", text: "C" }, attempt: 1 }])
    store.importFile(p)
    expect(rows()).toEqual(first)
  })

  it("keeps the done ids of a compacted file as done-only rows", () => {
    const p = file([line({ type: "done", id: "dlg-old", status: "error", ts: 5000 })])
    store.importFile(p)
    expect(rows()).toEqual([{ id: "dlg-old", caller: null, status: "error", ended_at: 5000, relay_attempt: null, source: "file" }])
    expect(store.statusOf("dlg-old")).toBe("error")
    expect(store.open()).toEqual([])
  })

  it("never reopens or overwrites a hand-off the table already ended", () => {
    store.insert(rec("dlg-a"), 1000)
    store.end("dlg-a", "done", 2000)
    store.importFile(file([
      line({ type: "start", ts: 1000, ...rec("dlg-a", { callee: "other" }) }),
      line({ type: "done", id: "dlg-a", status: "lost", ts: 3000 }),
    ]))
    expect(store.statusOf("dlg-a")).toBe("done")
    expect([...store.agents()]).toEqual([["dlg-a", "worker"]])
  })

  it("merges what an older daemon wrote after the table's last word", () => {
    // The table: one out, one held (attempt 1 at 3000), one passed on at 4000.
    store.insert(rec("dlg-out"), 1000)
    store.insert(rec("dlg-held"), 1000)
    store.end("dlg-held", "done", 2000)
    store.hold(rec("dlg-held"), { result: { status: "done", text: "H" } }, 1, 3000)
    store.insert(rec("dlg-passed"), 1000)
    store.end("dlg-passed", "done", 2000)
    store.hold(rec("dlg-passed"), { result: { status: "done", text: "P" } }, 1, 3000)
    store.release("dlg-passed", 4000)
    store.importFile(file([
      // The older daemon reported the one still out as lost, re-ran the
      // held one (attempt 2) and passed it on, and started a new one.
      line({ type: "done", id: "dlg-out", status: "lost", ts: 5000 }),
      line({ type: "relay", id: "dlg-held", ts: 5000, record: rec("dlg-held"), result: { status: "done", text: "H" }, attempt: 2 }),
      line({ type: "relayed", id: "dlg-held", ts: 5100 }),
      line({ type: "start", ts: 5200, ...rec("dlg-new") }),
      // An old relay line, from before the table passed it on: ignored.
      line({ type: "relay", id: "dlg-passed", ts: 3000, record: rec("dlg-passed"), result: { status: "done", text: "P" }, attempt: 1 }),
    ]))
    expect(store.statusOf("dlg-out")).toBe("lost")
    expect(store.held()).toEqual([])
    expect(store.open().map((r) => r.id)).toEqual(["dlg-new"])
  })

  it("respects the order of a relay and its relayed line", () => {
    store.importFile(file([
      line({ type: "done", id: "dlg-a", status: "done", ts: 1000 }),
      line({ type: "relayed", id: "dlg-a", ts: 1500 }),
      line({ type: "relay", id: "dlg-a", ts: 2000, record: rec("dlg-a"), result: { status: "done", text: "again" }, attempt: 1, reply: true }),
    ]))
    // relayed came before the relay: it is still held.
    expect(store.held()).toEqual([{ record: rec("dlg-a"), result: { status: "done", text: "again" }, attempt: 1, reply: true }])
  })

  it("does nothing without a file", () => {
    expect(store.importFile(join(dir, "none.jsonl"))).toEqual({ lines: 0, skipped: 0 })
  })
})

describe("the daemon builds the delegations after the database opens (#1861)", () => {
  it("creates the manager with the open database, before the server and the channels start", () => {
    const src = readFileSync(join(__dirname, "../src/daemon/index.ts"), "utf-8")
    const opened = src.indexOf("const db = openDb()")
    const built = src.indexOf("this.delegations = createDelegations(")
    const call = src.slice(built, src.indexOf("})", src.indexOf("onRelayFailed:", built)))
    expect(opened).toBeGreaterThan(0)
    expect(built).toBeGreaterThan(opened)
    expect(call).toContain("db: this.db,")
    // Both in the constructor: the HTTP server and the channels start later.
    expect(built).toBeLessThan(src.indexOf("await this.router.startAll()"))
    expect(built).toBeLessThan(src.indexOf("async start("))
  })
})

describe("a node with no database (#1861)", () => {
  it("keeps hand-offs in memory only, and says so loudly at start", () => {
    const logs: string[] = []
    expect(handoffStoreFor(null, (m) => logs.push(m))).toBeNull()
    expect(logs.join("\n")).toMatch(/WARNING.*no database.*memory only/i)
  })

  it("uses the table when the database is open", () => {
    const logs: string[] = []
    const s = handoffStoreFor(db, (m) => logs.push(m))
    expect(s).toBeInstanceOf(HandoffStore)
    expect(logs).toEqual([])
  })
})
