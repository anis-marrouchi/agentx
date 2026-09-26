import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { closeDb, openDb } from "../../src/storage/sqlite"
import { recordTraceEnd, recordTraceStart, recordTraceStep } from "../../src/storage/traces"
import {
  errorClass,
  failingTool,
  failuresToCandidates,
  failureStamp,
  loadFailedTraces,
  sessionOf,
  type FailedTrace,
} from "../../src/wiki/failure-candidates"
import { getUnpromotedMemories } from "../../src/wiki/promote"

// Recurring failures → promotion candidates. What must hold:
//   - a failure recurring across ≥N sessions becomes one candidate, with
//     counts, example runs and sessions
//   - one-off failures, and repeats inside one session, are ignored
//   - different agents, tools, outcomes and error classes stay apart
//   - synthetic traces in SQLite load with the tool the run failed in

const DAY = 864e5
const T0 = Date.UTC(2026, 8, 20)

let n = 0
const fail = (over: Partial<FailedTrace> = {}): FailedTrace => ({
  taskId: `t${++n}`,
  agentId: "ops-agent",
  chatId: `chat-${n}`,
  sessionId: `session-${n}`,
  status: "error",
  startedAt: T0 + n * 1000,
  error: `Bash exited 127: command not found: deploy-cli (pid ${300 + n})`,
  messagePreview: "Open a merge request for the fix",
  tool: "Bash",
  ...over,
})

describe("errorClass", () => {
  it("keeps the words and drops what changes between runs", () => {
    expect(errorClass("error", "ENOENT: no such file '/tmp/a1b2/x.json' at line 42"))
      .toBe(errorClass("error", "ENOENT: no such file '/var/run/other.json' at line 7"))
  })

  it("falls back to the status when there is no message", () => {
    expect(errorClass("timeout", null)).toBe("timeout")
  })
})

describe("sessionOf", () => {
  it("uses the provider session, else the run — never the chat", () => {
    expect(sessionOf({ taskId: "t", finalSessionId: "s2", resumeSessionId: "s1" })).toBe("s2")
    expect(sessionOf({ taskId: "t", finalSessionId: null, resumeSessionId: "s1" })).toBe("s1")
    expect(sessionOf({ taskId: "t", finalSessionId: null, resumeSessionId: null })).toBe("t")
  })
})

describe("failingTool", () => {
  it("pairs an errored tool_result with the call before it", () => {
    expect(failingTool([
      { name: "tool_use", action: "Read", status: "in-flight", error: null, outputSummary: null },
      { name: "tool_result", action: null, status: "ok", error: null, outputSummary: "file" },
      { name: "tool_use", action: "Bash", status: "in-flight", error: null, outputSummary: null },
      { name: "tool_result", action: null, status: "error", error: null, outputSummary: "permission denied" },
      { name: "tool_use", action: "Grep", status: "in-flight", error: null, outputSummary: null },
      { name: "tool_result", action: null, status: "ok", error: null, outputSummary: "" },
    ])).toEqual({ tool: "Bash", error: "permission denied" })
  })

  it("falls back to the last tool used, with no error of its own", () => {
    expect(failingTool([
      { name: "tool_use", action: "Read", status: "in-flight", error: null, outputSummary: null },
      { name: "tool_result", action: null, status: "ok", error: null, outputSummary: "" },
    ])).toEqual({ tool: "Read", error: null })
    expect(failingTool([])).toEqual({ tool: null, error: null })
  })
})

describe("failuresToCandidates", () => {
  it("turns a failure recurring across sessions into one candidate with counts and examples", () => {
    const traces = [fail(), fail(), fail(), fail({ sessionId: "session-1" })] // last: same session again
    const [c, ...rest] = failuresToCandidates(traces)
    expect(rest).toHaveLength(0)
    expect(c.occurrences).toBe(3)
    expect(c.failure).toMatchObject({ tool: "Bash", runs: 4 })
    expect(c.tasks).toHaveLength(4)
    expect(c.sessions).toHaveLength(3)
    expect(c.memory.type).toBe("feedback")
    expect(c.stamp.startsWith("failure:")).toBe(true)
    expect(c.memory.description).toContain("Bash")
    expect(c.memory.body).toContain("3 separate sessions (4 runs)")
    expect(c.memory.body).toContain(`\`${traces[0].taskId}\``)
    expect(c.memory.body).toContain("Open a merge request for the fix")
  })

  it("ignores one-off failures and failures below the session threshold", () => {
    const traces = [
      fail({ tool: "WebFetch", error: "403 Forbidden" }),
      fail({ tool: "Read", error: "file too large" }),
      fail({ tool: "Read", error: "file too large" }),
    ]
    expect(failuresToCandidates(traces)).toHaveLength(0)
    expect(failuresToCandidates(traces, { minSessions: 2 })).toHaveLength(1)
  })

  it("never treats one session as a pattern, whatever the threshold", () => {
    const traces = [fail({ sessionId: "s" }), fail({ sessionId: "s" }), fail({ sessionId: "s" })]
    expect(failuresToCandidates(traces, { minSessions: 1 })).toHaveLength(0)
  })

  it("keeps different agents, tools, outcomes and error classes apart", () => {
    const traces = [0, 1, 2].flatMap(() => [
      fail(),
      fail({ agentId: "build-agent" }),
      fail({ tool: "Edit" }),
      fail({ status: "timeout", error: null, tool: null }),
      fail({ status: "timeout" }),
    ])
    const out = failuresToCandidates(traces)
    expect(out).toHaveLength(5)
    expect(out.every((c) => c.occurrences === 3)).toBe(true)
  })

  it("re-offers a signature only when its recurrence doubles", () => {
    expect(failureStamp("sig", 3)).toBe(failureStamp("sig", 2))
    expect(failureStamp("sig", 4)).not.toBe(failureStamp("sig", 3))
    expect(failureStamp("sig", 7)).toBe(failureStamp("sig", 4))
  })

  it("is not re-offered once proposed, skipped or rejected", () => {
    const [c] = failuresToCandidates([fail(), fail(), fail()])
    const index = { articles: [], updated: "" } as never
    expect(getUnpromotedMemories([c], index, [], { now: T0 + DAY })).toHaveLength(1)
    for (const decision of ["proposed", "skipped", "rejected"] as const) {
      const ledger = [{ stamp: c.stamp, decision, at: "" }]
      expect(getUnpromotedMemories([c], index, ledger, { now: T0 + DAY })).toHaveLength(0)
    }
  })

  it("keeps its evidence through candidate selection", () => {
    const [c] = failuresToCandidates([fail(), fail(), fail()])
    const [out] = getUnpromotedMemories([c], { articles: [], updated: "" } as never, [], { now: T0 + DAY })
    expect(out).toMatchObject({ occurrences: 3, sessions: c.sessions, tasks: c.tasks, failure: c.failure })
  })
})

describe("loadFailedTraces", () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "agentx-failures-")) })
  afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

  it("reads failed and timed-out runs with the failing tool, and skips ok runs and learning passes", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    const failed = recordTraceStart(db, { agentId: "a", chatId: "c1", messagePreview: "deploy" })
    recordTraceStep(db, failed, { name: "tool_use", action: "Read", status: "in-flight" })
    recordTraceStep(db, failed, { name: "tool_result", status: "ok", outputSummary: "ok" })
    recordTraceStep(db, failed, { name: "tool_use", action: "Bash", status: "in-flight" })
    recordTraceStep(db, failed, { name: "tool_result", status: "error", outputSummary: "exit 1: permission denied" })
    recordTraceStep(db, failed, { name: "tool_use", action: "Grep", status: "in-flight" })
    recordTraceEnd(db, failed, { status: "error", error: "agent gave up", finalSessionId: "sess-1" })

    const timedOut = recordTraceStart(db, { agentId: "a", chatId: "c2" })
    recordTraceEnd(db, timedOut, { status: "timeout" })

    const ok = recordTraceStart(db, { agentId: "a", chatId: "c3" })
    recordTraceEnd(db, ok, { status: "ok" })

    const self = recordTraceStart(db, { agentId: "a", chatId: "memory-promote-2026-09-20" })
    recordTraceEnd(db, self, { status: "error", error: "bad json" })

    const out = loadFailedTraces(db)
    expect(out.map((t) => t.taskId).sort()).toEqual([failed, timedOut].sort())
    const f = out.find((t) => t.taskId === failed)!
    expect(f).toMatchObject({ tool: "Bash", error: "exit 1: permission denied", sessionId: "sess-1" })
    expect(out.find((t) => t.taskId === timedOut)).toMatchObject({ tool: null, sessionId: timedOut })
  })

  it("yields a proposal candidate only for the failure that recurs across sessions", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    const run = (session: string, tool: string, error: string) => {
      const id = recordTraceStart(db, { agentId: "ops", chatId: "cron:nightly", messagePreview: "ship" })
      recordTraceStep(db, id, { name: "tool_use", action: tool, status: "in-flight" })
      recordTraceStep(db, id, { name: "tool_result", status: "error", outputSummary: error })
      recordTraceEnd(db, id, { status: "error", error: "failed", finalSessionId: session })
    }
    for (const s of ["s1", "s2", "s3"]) run(s, "Bash", `command not found: deploy-cli (${s}9)`)
    run("s4", "WebFetch", "403 Forbidden") // one-off

    const out = failuresToCandidates(loadFailedTraces(db))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ agentId: "ops", occurrences: 3, failure: { tool: "Bash", runs: 3 } })
    expect(out[0].sessions.sort()).toEqual(["s1", "s2", "s3"])
  })
})
