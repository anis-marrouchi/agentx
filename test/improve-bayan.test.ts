import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { ensureHandoffTable } from "../src/a2a/handoff-store"
import { readSignals, recordSignal, setSignalDb, SIGNAL_KINDS, SIGNAL_MEANING } from "../src/improve/signals"
import { KIND_WEIGHT, groupKey, normalizeDetail } from "../src/improve/rank"
import { ruleEligible } from "../src/improve/rules"
import {
  asksSubject, channelLabel, classifyRun, emitBayanSignals, emitOwnerSubjectSignal, senderAgentOf,
} from "../src/improve/bayan"
import type { RunEnd } from "../src/improve/awareness"

// #1998: unclear hand-offs and replies, found from text and records, each
// recorded on the sender so the rule goes to the sender.

const MIN = 60_000
const NOW = Date.parse("2026-11-20T12:00:00Z")
const isAgent = (id: string) => ["agent-a", "agent-b"].includes(id)

describe("the kinds are wired", () => {
  it("are known kinds with a meaning and the agreed weights", () => {
    for (const k of ["a2a_extra_rounds", "clarification_asked", "owner_asked_subject"] as const) {
      expect(SIGNAL_KINDS).toContain(k)
      expect(SIGNAL_MEANING[k]).toBeTruthy()
      expect(ruleEligible({ kind: k, agentId: "agent-a", pattern: "x", sample: null })).toBe(true)
    }
    expect(KIND_WEIGHT.a2a_extra_rounds).toBe(1)
    expect(KIND_WEIGHT.clarification_asked).toBe(1)
    expect(KIND_WEIGHT.owner_asked_subject).toBe(2)
    expect(SIGNAL_MEANING.handoff_refused).toMatch(/missing information/)
    expect(ruleEligible({ kind: "handoff_refused", agentId: "agent-a", pattern: "missing information -> agent-b: blocked", sample: null })).toBe(true)
  })
})

describe("senderAgentOf (B1)", () => {
  it("takes only an agent of this registry", () => {
    expect(senderAgentOf("agent:agent-a", isAgent)).toBe("agent-a")
    expect(senderAgentOf("agent:far-away", isAgent)).toBeNull()
    expect(senderAgentOf("system", isAgent)).toBeNull()
    expect(senderAgentOf(undefined, isAgent)).toBeNull()
  })
})

describe("classifyRun", () => {
  const waiting = { state: "waiting" as const, on: "agent-a" }
  it("a question back with waiting is a clarification", () => {
    expect(classifyRun("I can do it. Which branch do you mean?", waiting)).toBe("asked")
    expect(classifyRun("Should I deploy to staging or production?", { state: "blocked", why: "needs a choice" })).toBe("asked")
  })
  it("a done or continue run that offers more is work, not a question", () => {
    expect(classifyRun("Merged. Do you want me to also tag it?", { state: "done", proof: "PR #9" })).toBe("working")
    expect(classifyRun("Half done. Should I keep the old flag?", { state: "continue", left: "tests" })).toBe("working")
  })
  it("no question mark, or no ask word, is not a clarification", () => {
    expect(classifyRun("Waiting for the build.", waiting)).toBe("working")
    expect(classifyRun("Is it raining?", waiting)).toBe("working")
  })
  it("strips the state line before the question test (C2)", () => {
    expect(classifyRun("Which branch do you mean?\n\n[Job state] waiting on agent-a", waiting)).toBe("asked")
    expect(classifyRun("Which branch do you mean?" + " Working on it now.".repeat(30) + "\nState: waiting — agent-a", waiting)).toBe("working")
  })
  it("blocked for missing input is a refusal only, even with a question (C1)", () => {
    expect(classifyRun("Which issue do you mean?", { state: "blocked", why: "missing the issue link" })).toBe("refused")
    expect(classifyRun("Done?", { state: "blocked", why: "CI is red" })).toBe("other")
  })
  it("no state: nothing", () => {
    expect(classifyRun("Which branch do you mean?", undefined)).toBeNull()
    expect(classifyRun("Which branch do you mean?", { state: "stalled" })).toBeNull()
  })
})

describe("asksSubject", () => {
  it("matches the subject phrases in four languages", () => {
    for (const t of ["What is this about?", "what's this about", "Which one?", "c'est quoi ça ?", "chnowa hedha", "شنوة هذا؟", "ما هذا؟", "3la chnowa?"]) {
      expect(asksSubject(t)).toBe(true)
    }
  })
  it("does not match longer messages or other questions", () => {
    expect(asksSubject("Which one is better for the release we planned with the team last week, A or B?")).toBe(false)
    expect(asksSubject("which one is cheaper")).toBe(false)
    expect(asksSubject("c'est quoi le statut ?")).toBe(false)
    expect(asksSubject("deploy it")).toBe(false)
  })
})

describe("channelLabel (C6)", () => {
  it("keeps a person channel, else other", () => {
    expect(channelLabel("telegram")).toBe("telegram")
    expect(channelLabel("anything-a-caller-names")).toBe("other")
    expect(channelLabel(undefined)).toBe("other")
  })
})

// --- With the database ---

let tmp: string
let db: Database.Database

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-improve-bayan-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
  ensureHandoffTable(db)
  setSignalDb(db)
})

afterEach(() => {
  setSignalDb(null)
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

const ROOT = JSON.stringify({ kind: "person", channel: "telegram", chatId: "chat-1", agentId: "agent-a" })
function handoff(id: string, o: { caller?: string; callee?: string; peer?: string | null; root?: string; startedAt?: number } = {}) {
  db.prepare(`INSERT INTO handoffs (id, caller, callee, peer, root_json, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, o.caller ?? "agent-a", o.callee ?? "agent-b", o.peer ?? null, o.root ?? ROOT, o.startedAt ?? NOW - 5 * MIN, NOW)
}
const calleeRun = (dlg: string, over: Partial<RunEnd> = {}): RunEnd => ({
  taskId: `trace-${dlg}`, agentId: "agent-b", channel: "a2a", chatId: `a2a:agent-a:agent-b:${dlg}`, sender: "agent:agent-a",
  content: "Which branch do you mean?", jobState: { state: "waiting", on: "agent-a" }, startedAt: NOW - 4 * MIN, ...over,
})
const rows = () => readSignals(db, 0).map((r) => [r.kind, r.agentId, r.ref, r.detail])

describe("emitBayanSignals", () => {
  it("records a clarification on the sender, keyed on the hand-off id", () => {
    handoff("dlg-1")
    emitBayanSignals(calleeRun("dlg-1"), isAgent, NOW)
    expect(rows()).toEqual([["clarification_asked", "agent-a", "dlg-1", "agent-b asked back before starting"]])
  })

  it("records missing information as handoff_refused only (C1)", () => {
    handoff("dlg-1")
    emitBayanSignals(calleeRun("dlg-1", { content: "Which issue?", jobState: { state: "blocked", why: "missing the issue link" } }), isAgent, NOW)
    expect(rows()).toEqual([["handoff_refused", "agent-a", "dlg-1", "missing information -> agent-b: blocked"]])
  })

  it("is silent for a peer or unknown sender, a peer hop, or no hand-off row (B1)", () => {
    handoff("dlg-1")
    handoff("dlg-2", { peer: "node-2" })
    handoff("dlg-3", { caller: "agent-x" })
    emitBayanSignals(calleeRun("dlg-1", { sender: "agent:far-away" }), isAgent, NOW)
    emitBayanSignals(calleeRun("dlg-1", { sender: "system" }), isAgent, NOW)
    emitBayanSignals(calleeRun("dlg-2"), isAgent, NOW)
    emitBayanSignals(calleeRun("dlg-3"), isAgent, NOW)
    emitBayanSignals(calleeRun("dlg-9"), isAgent, NOW)
    emitBayanSignals(calleeRun("dlg-1", { chatId: "agent-a" }), isAgent, NOW)
    expect(rows()).toEqual([])
  })

  it("counts rounds on (caller, callee, root) across hand-offs (B2)", () => {
    handoff("dlg-1", { startedAt: NOW - 20 * MIN })
    emitBayanSignals(calleeRun("dlg-1", { startedAt: NOW - 19 * MIN }), isAgent, NOW - 18 * MIN)
    handoff("dlg-2", { startedAt: NOW - 10 * MIN })
    emitBayanSignals(calleeRun("dlg-2", { content: "On it.", jobState: { state: "done", proof: "PR #9" } }), isAgent, NOW)
    expect(rows()[0]).toEqual(["a2a_extra_rounds", "agent-a", "dlg-2", "agent-b: 2 rounds before work started"])
  })

  it("does not count a clarification of another root, one older than 2 h, or a round already counted", () => {
    const other = JSON.stringify({ kind: "person", channel: "telegram", chatId: "chat-2", agentId: "agent-a" })
    handoff("dlg-old", { startedAt: NOW - 3 * 60 * MIN })
    recordSignal(db, { kind: "clarification_asked", agentId: "agent-a", ref: "dlg-old", detail: "agent-b asked back before starting" }, NOW - 3 * 60 * MIN)
    handoff("dlg-other", { root: other, startedAt: NOW - 20 * MIN })
    recordSignal(db, { kind: "clarification_asked", agentId: "agent-a", ref: "dlg-other", detail: "agent-b asked back before starting" }, NOW - 19 * MIN)
    handoff("dlg-2")
    emitBayanSignals(calleeRun("dlg-2", { content: "On it.", jobState: { state: "done", proof: "x" } }), isAgent, NOW)
    expect(rows().map((r) => r[0])).not.toContain("a2a_extra_rounds")

    handoff("dlg-a", { startedAt: NOW - 30 * MIN })
    recordSignal(db, { kind: "clarification_asked", agentId: "agent-a", ref: "dlg-a", detail: "agent-b asked back before starting" }, NOW - 29 * MIN)
    handoff("dlg-b", { startedAt: NOW - 20 * MIN })
    recordSignal(db, { kind: "a2a_extra_rounds", agentId: "agent-a", ref: "dlg-b", detail: "agent-b: 2 rounds before work started" }, NOW - 19 * MIN)
    handoff("dlg-c", { startedAt: NOW - 2 * MIN })
    emitBayanSignals(calleeRun("dlg-c", { content: "More work.", jobState: { state: "done", proof: "y" } }), isAgent, NOW)
    expect(rows().filter((r) => r[0] === "a2a_extra_rounds")).toHaveLength(1)
  })

  it("rounds with different counts land in one group", () => {
    const key = (d: string) => groupKey("a2a_extra_rounds", "agent-a", normalizeDetail("a2a_extra_rounds", d))
    expect(key("agent-b: 2 rounds before work started")).toBe(key("agent-b: 3 rounds before work started"))
  })

  it("never throws without the tables", () => {
    db.exec("DROP TABLE handoffs")
    expect(() => emitBayanSignals(calleeRun("dlg-1"), isAgent, NOW)).not.toThrow()
  })
})

describe("emitOwnerSubjectSignal", () => {
  function reply(o: { id: string; startedAt: number; channel?: string; chat?: string; agent?: string }) {
    db.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, finished_at, final_response) VALUES (?, ?, ?, ?, 'ok', ?, ?, 'A reply.')`)
      .run(o.id, o.agent ?? "agent-a", o.channel ?? "telegram", o.chat ?? "chat-1", o.startedAt, o.startedAt + MIN)
  }
  const turn = (over: Record<string, unknown> = {}) => ({ taskId: "turn-1", agentId: "agent-a", channel: "telegram", chatId: "chat-1", text: "what is this about?", startedAt: NOW, waitingQuestions: 0, ...over })

  it("fires 10 min after the agent's reply in the chat", () => {
    reply({ id: "r-1", startedAt: NOW - 10 * MIN })
    emitOwnerSubjectSignal(turn(), NOW)
    expect(rows()).toEqual([["owner_asked_subject", "agent-a", "turn-1", "the owner asked what the reply was about (telegram)"]])
  })

  it("does not find the current turn itself (C4)", () => {
    reply({ id: "turn-1", startedAt: NOW - 1000 })
    reply({ id: "r-late", startedAt: NOW + 1000 })
    emitOwnerSubjectSignal(turn(), NOW)
    expect(rows()).toEqual([])
  })

  it("is silent with no reply in 6 h, a long message, or a question the agent asked (C3)", () => {
    reply({ id: "r-old", startedAt: NOW - 7 * 60 * MIN })
    emitOwnerSubjectSignal(turn(), NOW)
    reply({ id: "r-1", startedAt: NOW - 10 * MIN })
    emitOwnerSubjectSignal(turn({ taskId: "turn-2", text: "what is this about? " + "x".repeat(80) }), NOW)
    emitOwnerSubjectSignal(turn({ taskId: "turn-3", waitingQuestions: 1 }), NOW)
    expect(rows()).toEqual([])
  })

  it("writes other for a channel outside the fixed set (C6)", () => {
    reply({ id: "r-1", startedAt: NOW - 10 * MIN, channel: "made-up" })
    emitOwnerSubjectSignal(turn({ channel: "made-up" }), NOW)
    expect(rows()[0][3]).toBe("the owner asked what the reply was about (other)")
  })
})
