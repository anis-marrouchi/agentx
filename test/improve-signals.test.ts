import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { DEDUPE_MS, RETENTION_DAYS, emitSignal, readSignals, recordSignal, setSignalDb, summarizeSignals } from "../src/improve/signals"
import { RequestStore } from "../src/requests/store"
import { parseSince } from "../src/commands/improve"

let db: Database.Database
beforeEach(() => { db = new Database(":memory:") })
afterEach(() => { setSignalDb(null); db.close() })

const T = Date.parse("2026-11-08T10:00:00Z")

describe("recordSignal", () => {
  it("writes a row, and keeps a repeat of the same kind and reference inside the window as one", () => {
    expect(recordSignal(db, { kind: "delegation_failed", agentId: "planner", ref: "dlg-1", detail: "builder timeout" }, T)).toBe(true)
    expect(recordSignal(db, { kind: "delegation_failed", agentId: "planner", ref: "dlg-1", detail: "again" }, T + DEDUPE_MS - 1)).toBe(false)
    expect(recordSignal(db, { kind: "delegation_failed", agentId: "planner", ref: "dlg-1" }, T + DEDUPE_MS + 1)).toBe(true)
    expect(recordSignal(db, { kind: "handoff_refused", agentId: "planner", ref: "dlg-1" }, T)).toBe(true)
    expect(readSignals(db, 0)).toHaveLength(3)
  })

  it("never throws, and deletes rows past the retention", () => {
    const closed = new Database(":memory:"); closed.close()
    expect(recordSignal(closed, { kind: "request_stalled" }, T)).toBe(false)
    recordSignal(db, { kind: "request_stalled", ref: "old" }, T - (RETENTION_DAYS + 1) * 86_400_000)
    recordSignal(db, { kind: "request_stalled", ref: "new" }, T + 2 * 3_600_000)
    expect(readSignals(db, 0).map((r) => r.ref)).toEqual(["new"])
  })

  it("emits through the daemon's database only when one is set", () => {
    expect(emitSignal({ kind: "same_work_waited", agentId: "ops", ref: "req-1" }, T)).toBe(false)
    setSignalDb(db)
    expect(emitSignal({ kind: "same_work_waited", agentId: "ops", ref: "req-1" }, T)).toBe(true)
  })
})

describe("summarizeSignals", () => {
  it("counts by kind and agent, and lists what keeps happening", () => {
    for (let i = 0; i < 3; i++) recordSignal(db, { kind: "handoff_refused", agentId: "planner", ref: `t${i}`, detail: "budget -> builder: limit 15" }, T + i)
    recordSignal(db, { kind: "owner_reopened", agentId: "builder", ref: "req-9", detail: "not what I asked" }, T)
    recordSignal(db, { kind: "owner_reopened", agentId: "builder", ref: "req-old" }, T - 3 * 86_400_000)
    const s = summarizeSignals(db, T - 86_400_000)
    expect(s.total).toBe(4)
    expect(s.byKind).toEqual([{ kind: "handoff_refused", count: 3 }, { kind: "owner_reopened", count: 1 }])
    expect(s.byAgent[0]).toEqual({ agentId: "planner", count: 3, kinds: { handoff_refused: 3 } })
    expect(s.top).toEqual([{ kind: "handoff_refused", agentId: "planner", detail: "budget -> builder: limit 15", count: 3 }])
  })
})

describe("signals from the request store", () => {
  function open(store: RequestStore, id: string) {
    store.addCandidate({ id, runId: `run-${id}`, channel: "telegram", chatId: "c1", agentId: "builder", text: "ship it", now: T } as any)
    store.progress(id, T)
  }
  it("records the owner reopening, the owner-words mismatch and a stalled request, with the request's agent", () => {
    const store = new RequestStore(db)
    open(store, "r1")
    expect(store.needsAttention("r1", "the run failed: timeout", T + 1)).toBe(true)
    store.close("r1", "declined", "waits on the tester", T + 2, null, "builder")
    expect(store.reopenForOwnerCheck("r1", "you removed the tester step", T + 3)).toBe(true)
    open(store, "r2")
    store.close("r2", "done", "https://example.com/pr/1", T + 4, null, "owner")
    expect(store.reopen("r2", "this is not what I asked", T + 5)).toBe(true)
    const kinds = readSignals(db, 0).map((r) => `${r.kind}:${r.agentId}:${r.ref}`).sort()
    expect(kinds).toEqual(["owner_check_mismatch:builder:r1", "owner_reopened:builder:r2", "request_stalled:builder:r1"])
  })
})

describe("parseSince", () => {
  it("reads 24h, 7d, 30m and dates, and refuses the rest", () => {
    expect(parseSince("24h", T)).toBe(T - 86_400_000)
    expect(parseSince("7d", T)).toBe(T - 7 * 86_400_000)
    expect(parseSince("30m", T)).toBe(T - 1_800_000)
    expect(parseSince("2026-11-01", T)).toBe(Date.parse("2026-11-01"))
    expect(parseSince("soon", T)).toBeNull()
    expect(parseSince(undefined, T)).toBe(T - 86_400_000)
  })
})
