import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { ensureHandoffTable } from "../src/a2a/handoff-store"
import { readSignals, setSignalDb, SIGNAL_KINDS, SIGNAL_MEANING } from "../src/improve/signals"
import { KIND_WEIGHT, groupKey, normalizeDetail } from "../src/improve/rank"
import { ruleEligible } from "../src/improve/rules"
import { emitAwarenessSignals, staleStatus, waitedOnAgent, type HandoffRow, type RunEnd } from "../src/improve/awareness"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import type { AgentResponse, AgentTask } from "../src/agents/runtime"

// #1997: an agent says it waits on another agent whose hand-off already
// ended done. Found from records AgentX owns, on a later tick.

const MIN = 60_000
const NOW = Date.parse("2026-11-20T12:00:00Z")
const isAgent = (id: string) => ["agent-a", "agent-b"].includes(id)
const run = (over: Partial<RunEnd> = {}): RunEnd => ({
  taskId: "trace-1", agentId: "agent-a", channel: "a2a", chatId: "a2a:pm:agent-a",
  jobState: { state: "waiting", on: "agent-b review" }, startedAt: NOW, ...over,
})
const doneRow = (over: Partial<HandoffRow> = {}): HandoffRow => ({
  id: "dlg-1", peer: null, status: "done", startedAt: NOW - 30 * MIN, endedAt: NOW - 10 * MIN, relayAttempt: null, ...over,
})
const DONE_ANSWER = "Reviewed.\nState: done — PR #9 approved"

describe("the kinds are wired", () => {
  it("are known signal kinds with a meaning and weight 2", () => {
    for (const k of ["duplicate_session", "stale_status_told"] as const) {
      expect(SIGNAL_KINDS).toContain(k)
      expect(SIGNAL_MEANING[k]).toBeTruthy()
      expect(KIND_WEIGHT[k]).toBe(2)
      expect(ruleEligible({ kind: k, agentId: "agent-a", pattern: "x", sample: null })).toBe(true)
    }
  })
})

describe("waitedOnAgent", () => {
  it("names a known agent the state waits on", () => {
    expect(waitedOnAgent({ state: "waiting", on: "agent-b review" }, "agent-a", isAgent)).toBe("agent-b")
    expect(waitedOnAgent({ state: "waiting", on: "@agent-b, until 18:00" }, "agent-a", isAgent)).toBe("agent-b")
  })
  it("is null for CI, a person, itself, or another state", () => {
    expect(waitedOnAgent({ state: "waiting", on: "ci for pr 12 by agent-b" }, "agent-a", isAgent)).toBeNull()
    expect(waitedOnAgent({ state: "waiting", on: "agent-a" }, "agent-a", isAgent)).toBeNull()
    expect(waitedOnAgent({ state: "blocked", why: "agent-b" }, "agent-a", isAgent)).toBeNull()
    expect(waitedOnAgent(undefined, "agent-a", isAgent)).toBeNull()
  })
})

describe("staleStatus", () => {
  it("fires when the callee's hand-off ended done before the run and its run stated done", () => {
    const s = staleStatus(run(), "agent-b", { handoffs: [doneRow()], calleeAnswer: DONE_ANSWER })
    expect(s).toEqual({ kind: "stale_status_told", agentId: "agent-a", ref: "trace-1", detail: "said waiting on agent-b, whose hand-off had ended done 10 min before" })
  })
  it("is silent while the hand-off is open: status NULL or waiting (C2)", () => {
    expect(staleStatus(run(), "agent-b", { handoffs: [doneRow({ status: null, endedAt: null })], calleeAnswer: DONE_ANSWER })).toBeNull()
    expect(staleStatus(run(), "agent-b", { handoffs: [doneRow({ status: "waiting" })], calleeAnswer: DONE_ANSWER })).toBeNull()
  })
  it("is silent when a newer hand-off to the callee is open", () => {
    const newer = doneRow({ id: "dlg-2", status: "waiting", startedAt: NOW - 5 * MIN, endedAt: NOW - 4 * MIN })
    expect(staleStatus(run(), "agent-b", { handoffs: [newer, doneRow()], calleeAnswer: DONE_ANSWER })).toBeNull()
  })
  it("is silent while the answer is still held for relay (C3)", () => {
    expect(staleStatus(run(), "agent-b", { handoffs: [doneRow({ relayAttempt: 0 })], calleeAnswer: DONE_ANSWER })).toBeNull()
    expect(staleStatus(run(), "agent-b", { handoffs: [doneRow({ relayAttempt: 1 })], calleeAnswer: DONE_ANSWER })).toBeNull()
  })
  it("is silent when the hand-off ended after the run started", () => {
    expect(staleStatus(run(), "agent-b", { handoffs: [doneRow({ endedAt: NOW + MIN })], calleeAnswer: DONE_ANSWER })).toBeNull()
  })
  it("is silent when the callee did not state done, or ran on a peer", () => {
    expect(staleStatus(run(), "agent-b", { handoffs: [doneRow()], calleeAnswer: "I send it at 17:30." })).toBeNull()
    expect(staleStatus(run(), "agent-b", { handoffs: [doneRow()], calleeAnswer: null })).toBeNull()
    expect(staleStatus(run(), "agent-b", { handoffs: [doneRow({ peer: "node-2" })], calleeAnswer: DONE_ANSWER })).toBeNull()
  })
  it("is silent with no hand-off", () => {
    expect(staleStatus(run(), "agent-b", { handoffs: [] })).toBeNull()
  })
  it("two runs with different minutes and ids land in one group", () => {
    const a = staleStatus(run({ taskId: "trace-1" }), "agent-b", { handoffs: [doneRow()], calleeAnswer: DONE_ANSWER })!
    const b = staleStatus(run({ taskId: "trace-2" }), "agent-b", { handoffs: [doneRow({ endedAt: NOW - 42 * MIN })], calleeAnswer: DONE_ANSWER })!
    const key = (d: string) => groupKey("stale_status_told", "agent-a", normalizeDetail("stale_status_told", d))
    expect(key(a.detail!)).toBe(key(b.detail!))
  })
})

// --- With the database ---

let tmp: string
let db: Database.Database

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-improve-awareness-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})

afterEach(() => {
  setSignalDb(null)
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

function handoff(o: { id: string; caller?: string; callee?: string; status: string | null; startedAt: number; endedAt?: number | null; relay?: number | null; peer?: string | null }) {
  db.prepare(`INSERT INTO handoffs (id, caller, callee, peer, status, started_at, ended_at, relay_attempt, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.id, o.caller ?? "agent-a", o.callee ?? "agent-b", o.peer ?? null, o.status, o.startedAt, o.endedAt ?? null, o.relay ?? null, o.startedAt)
}

function trace(o: { id: string; agent: string; chat: string; startedAt: number; answer: string }) {
  db.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, finished_at, final_response) VALUES (?, ?, 'a2a', ?, 'ok', ?, ?, ?)`)
    .run(o.id, o.agent, o.chat, o.startedAt, o.startedAt + MIN, o.answer)
}

describe("emitAwarenessSignals", () => {
  it("joins the callee's run by the hand-off chat, not by time (C1)", () => {
    ensureHandoffTable(db)
    setSignalDb(db)
    handoff({ id: "dlg-1", status: "done", startedAt: NOW - 30 * MIN, endedAt: NOW - 10 * MIN })
    // Another run of the callee in the same window, in another chat, says nothing done.
    trace({ id: "t-other", agent: "agent-b", chat: "a2a:agent-c:agent-b:dlg-9", startedAt: NOW - 25 * MIN, answer: "Still going." })
    trace({ id: "t-mine", agent: "agent-b", chat: "a2a:agent-a:agent-b:dlg-1", startedAt: NOW - 29 * MIN, answer: DONE_ANSWER })
    emitAwarenessSignals(run(), isAgent, NOW)
    expect(readSignals(db, 0).map((r) => r.kind)).toEqual(["stale_status_told"])
  })

  it("stays silent when only an unrelated run of the callee stated done", () => {
    ensureHandoffTable(db)
    setSignalDb(db)
    handoff({ id: "dlg-1", status: "done", startedAt: NOW - 30 * MIN, endedAt: NOW - 10 * MIN })
    trace({ id: "t-other", agent: "agent-b", chat: "a2a:agent-c:agent-b:dlg-9", startedAt: NOW - 25 * MIN, answer: DONE_ANSWER })
    emitAwarenessSignals(run(), isAgent, NOW)
    expect(readSignals(db, 0)).toEqual([])
  })

  it("never throws when the hand-off table is missing", () => {
    setSignalDb(db)
    expect(() => emitAwarenessSignals(run(), isAgent, NOW)).not.toThrow()
    expect(readSignals(db, 0)).toEqual([])
  })
})

describe("registry.execute queues the check (C5)", () => {
  function registry(result: AgentResponse) {
    const config = daemonConfigSchema.parse({
      node: { id: "t", name: "t" },
      agents: { "agent-a": { name: "A", tier: "claude-code", workspace: tmp }, "agent-b": { name: "B", tier: "claude-code", workspace: tmp } },
    })
    const r = new AgentRegistry(config, () => {})
    ;(r as any).executeInternal = async (task: AgentTask) => {
      task.taskId = "trace-run"
      task.runningTaskId = "run-1"
      return result
    }
    return r
  }
  const tick = () => new Promise((r) => setImmediate(r))

  it("records on a later tick, after the reply is back", async () => {
    ensureHandoffTable(db)
    setSignalDb(db)
    const now = Date.now()
    handoff({ id: "dlg-1", status: "done", startedAt: now - 30 * MIN, endedAt: now - 10 * MIN })
    trace({ id: "t-mine", agent: "agent-b", chat: "a2a:agent-a:agent-b:dlg-1", startedAt: now - 29 * MIN, answer: DONE_ANSWER })
    const r = registry({ content: "Waiting.\nState: waiting — agent-b review" })
    const res = await r.execute({ agentId: "agent-a", message: "status?", context: { channel: "a2a", chatId: "a2a:pm:agent-a" } })
    expect(res.content).toBe("Waiting.\nState: waiting — agent-b review")
    expect(readSignals(db, 0)).toEqual([])
    await tick()
    expect(readSignals(db, 0).map((s) => [s.kind, s.agentId, s.ref])).toEqual([["stale_status_told", "agent-a", "trace-run"]])
  })

  it("skips an errored run, and a failing read leaves the response as it was", async () => {
    setSignalDb(db) // no handoffs table: the read throws
    const r = registry({ content: "Waiting.\nState: waiting — agent-b review" })
    const res = await r.execute({ agentId: "agent-a", message: "status?", context: { channel: "a2a", chatId: "a2a:pm:agent-a" } })
    await tick()
    expect(res.content).toBe("Waiting.\nState: waiting — agent-b review")
    expect(readSignals(db, 0)).toEqual([])
    ensureHandoffTable(db)
    const failed = registry({ content: "", error: "boom" })
    expect((await failed.execute({ agentId: "agent-a", message: "x", context: { channel: "a2a", chatId: "a2a:pm:agent-a" } })).error).toBe("boom")
    await tick()
    expect(readSignals(db, 0)).toEqual([])
  })
})
