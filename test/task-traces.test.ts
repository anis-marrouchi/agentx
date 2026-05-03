import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { openDb, closeDb, getSchemaVersion, pruneSqliteTables } from "../src/storage/sqlite"
import {
  recordTraceStart,
  recordTraceEnd,
  recordTraceStep,
  getTrace,
  listTraces,
} from "../src/storage/traces"

let tmp: string

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-traces-"))
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

function openTmp() {
  return openDb({ path: path.join(tmp, "db.sqlite") })!
}

describe("task_traces migration", () => {
  it("migrates to schema v7 (task_traces + task_trace_steps)", () => {
    const db = openTmp()
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(7)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_traces'").get()).toBeDefined()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_trace_steps'").get()).toBeDefined()
  })
})

describe("recordTraceStart + recordTraceEnd", () => {
  it("inserts an in-flight row and finalizes it", () => {
    const db = openTmp()
    const taskId = recordTraceStart(db, {
      agentId: "atlas",
      channel: "telegram",
      chatId: "c1",
      messagePreview: "hello",
    })
    expect(taskId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/) // ULID

    const before = getTrace(db, taskId)!
    expect(before.task.status).toBe("in-flight")
    expect(before.task.finishedAt).toBeNull()
    expect(before.task.durationMs).toBeNull()

    recordTraceEnd(db, taskId, {
      status: "ok",
      finalSessionId: "sess-final",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheCreateTokens: 200,
    })

    const after = getTrace(db, taskId)!
    expect(after.task.status).toBe("ok")
    expect(after.task.finalSessionId).toBe("sess-final")
    expect(after.task.inputTokens).toBe(100)
    expect(after.task.cacheReadTokens).toBe(1000)
    expect(after.task.finishedAt).not.toBeNull()
    expect(after.task.durationMs).not.toBeNull()
    expect(after.task.durationMs!).toBeGreaterThanOrEqual(0)
  })

  it("preserves workflow + intent linkage when supplied", () => {
    const db = openTmp()
    const taskId = recordTraceStart(db, {
      agentId: "worker",
      workflowRunId: "wf-run-1",
      workflowId: "leadCapture",
      workflowNodeId: "step-3",
      intentEventId: "01H0EVENT",
      intentDecidedBy: "channel-router",
    })
    const t = getTrace(db, taskId)!.task
    expect(t.workflowRunId).toBe("wf-run-1")
    expect(t.workflowId).toBe("leadCapture")
    expect(t.workflowNodeId).toBe("step-3")
    expect(t.intentEventId).toBe("01H0EVENT")
    expect(t.intentDecidedBy).toBe("channel-router")
  })

  it("records error status with message", () => {
    const db = openTmp()
    const taskId = recordTraceStart(db, { agentId: "a" })
    recordTraceEnd(db, taskId, { status: "error", error: "boom" })
    const t = getTrace(db, taskId)!.task
    expect(t.status).toBe("error")
    expect(t.error).toBe("boom")
  })
})

describe("recordTraceStep", () => {
  it("appends steps with auto-incrementing seq", () => {
    const db = openTmp()
    const taskId = recordTraceStart(db, { agentId: "a" })
    const s1 = recordTraceStep(db, taskId, { name: "tool_use", action: "Read", inputSummary: '{"file":"foo"}' })
    const s2 = recordTraceStep(db, taskId, { name: "tool_result", action: "Read", outputSummary: "ok", status: "ok" })
    const s3 = recordTraceStep(db, taskId, { name: "tool_use", action: "Edit" })
    expect(s1).toBe(0)
    expect(s2).toBe(1)
    expect(s3).toBe(2)

    const trace = getTrace(db, taskId)!
    expect(trace.steps).toHaveLength(3)
    expect(trace.steps.map((s) => s.action)).toEqual(["Read", "Read", "Edit"])
    expect(trace.steps[0].inputSummary).toBe('{"file":"foo"}')
  })

  it("scopes seq per task — two tasks don't share a counter", () => {
    const db = openTmp()
    const a = recordTraceStart(db, { agentId: "a" })
    const b = recordTraceStart(db, { agentId: "b" })
    recordTraceStep(db, a, { name: "tool_use" })
    recordTraceStep(db, b, { name: "tool_use" })
    recordTraceStep(db, a, { name: "tool_result" })
    expect(getTrace(db, a)!.steps.map((s) => s.seq)).toEqual([0, 1])
    expect(getTrace(db, b)!.steps.map((s) => s.seq)).toEqual([0])
  })

  it("returns ordered steps even if started_at ms collide", () => {
    const db = openTmp()
    const taskId = recordTraceStart(db, { agentId: "a" })
    for (let i = 0; i < 50; i++) recordTraceStep(db, taskId, { name: "tick" })
    const seqs = getTrace(db, taskId)!.steps.map((s) => s.seq)
    expect(seqs).toEqual([...Array(50).keys()])
  })
})

describe("getTrace", () => {
  it("returns null for an unknown task id", () => {
    const db = openTmp()
    expect(getTrace(db, "01XXXXX")).toBeNull()
  })
})

describe("listTraces", () => {
  it("filters by agentId, status, since/until and orders newest-first", () => {
    const db = openTmp()
    const a1 = recordTraceStart(db, { agentId: "a" })
    const a2 = recordTraceStart(db, { agentId: "a" })
    const b1 = recordTraceStart(db, { agentId: "b" })
    recordTraceEnd(db, a1, { status: "ok" })
    recordTraceEnd(db, a2, { status: "error", error: "x" })

    const allA = listTraces(db, { agentId: "a" })
    expect(allA).toHaveLength(2)
    // newest first: a2 was started after a1
    expect(allA[0].taskId).toBe(a2)
    expect(allA[1].taskId).toBe(a1)

    const errors = listTraces(db, { status: "error" })
    expect(errors.map((t) => t.taskId)).toEqual([a2])

    const inFlight = listTraces(db, { status: "in-flight" })
    expect(inFlight.map((t) => t.taskId)).toEqual([b1])
  })

  it("filters by workflowRunId", () => {
    const db = openTmp()
    const inWf = recordTraceStart(db, { agentId: "a", workflowRunId: "wf-1" })
    recordTraceStart(db, { agentId: "a" })
    expect(listTraces(db, { workflowRunId: "wf-1" }).map((t) => t.taskId)).toEqual([inWf])
  })

  it("respects limit (default 100, max 1000)", () => {
    const db = openTmp()
    for (let i = 0; i < 5; i++) recordTraceStart(db, { agentId: "a" })
    expect(listTraces(db, { limit: 2 })).toHaveLength(2)
    expect(listTraces(db, { limit: 9999 })).toHaveLength(5)
    expect(listTraces(db, { limit: -1 })).toHaveLength(1) // clamped to 1
  })
})

describe("attachSqliteSubscribers — task:started / task:completed → traces", () => {
  it("opens a trace at task:started and finalizes it at task:completed", async () => {
    const { attachSqliteSubscribers } = await import("../src/storage/subscribers")
    const { getEventBus } = await import("../src/events/bus")
    const db = openTmp()
    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      const startedAt = new Date().toISOString()
      bus.emit("task:started", {
        agentId: "atlas",
        channel: "telegram",
        chatId: "c-100",
        messagePreview: "hello",
        at: startedAt,
      })
      const inFlight = listTraces(db, { agentId: "atlas" })
      expect(inFlight).toHaveLength(1)
      expect(inFlight[0].status).toBe("in-flight")
      expect(inFlight[0].messagePreview).toBe("hello")
      expect(inFlight[0].workflowRunId).toBeNull()

      bus.emit("task:completed", {
        agentId: "atlas",
        channel: "telegram",
        chatId: "c-100",
        durationMs: 1234,
        inputTokens: 50,
        outputTokens: 25,
        cacheReadTokens: 100,
        cacheCreateTokens: 10,
        at: new Date().toISOString(),
      } as any)

      const done = listTraces(db, { agentId: "atlas" })
      expect(done).toHaveLength(1)
      expect(done[0].status).toBe("ok")
      expect(done[0].inputTokens).toBe(50)
      expect(done[0].cacheReadTokens).toBe(100)
      expect(done[0].finishedAt).not.toBeNull()
    } finally {
      dispose()
      bus.removeAllListeners()
    }
  })

  it("extracts workflowRunId from chatId convention 'workflow:<id>'", async () => {
    const { attachSqliteSubscribers } = await import("../src/storage/subscribers")
    const { getEventBus } = await import("../src/events/bus")
    const db = openTmp()
    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      bus.emit("task:started", {
        agentId: "worker",
        channel: "telegram",
        chatId: "workflow:run-abc",
        messagePreview: "step",
        at: new Date().toISOString(),
      })
      const traces = listTraces(db, { agentId: "worker" })
      expect(traces).toHaveLength(1)
      expect(traces[0].workflowRunId).toBe("run-abc")
      expect(traces[0].chatId).toBe("workflow:run-abc")
      // listTraces by workflowRunId must find it
      expect(listTraces(db, { workflowRunId: "run-abc" })).toHaveLength(1)
    } finally {
      dispose()
      bus.removeAllListeners()
    }
  })

  it("appends a session_rotation step on session:rotated within an in-flight task", async () => {
    const { attachSqliteSubscribers } = await import("../src/storage/subscribers")
    const { getEventBus } = await import("../src/events/bus")
    const db = openTmp()
    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      bus.emit("task:started", {
        agentId: "atlas",
        channel: "telegram",
        chatId: "c-200",
        messagePreview: "hi",
        at: new Date().toISOString(),
      })
      bus.emit("session:rotated", {
        agentId: "atlas",
        channel: "telegram",
        chatId: "c-200",
        reason: "tier-2",
        lastTurnInputTokens: 180_000,
        at: new Date().toISOString(),
      } as any)

      const traces = listTraces(db, { agentId: "atlas" })
      const trace = getTrace(db, traces[0].taskId)!
      expect(trace.steps).toHaveLength(1)
      expect(trace.steps[0].name).toBe("session_rotation")
      expect(trace.steps[0].action).toBe("tier-2")
      expect(trace.steps[0].inputSummary).toBe("last_turn_input_tokens=180000")
    } finally {
      dispose()
      bus.removeAllListeners()
    }
  })

  it("marks the trace status='error' when task:completed carries an error", async () => {
    const { attachSqliteSubscribers } = await import("../src/storage/subscribers")
    const { getEventBus } = await import("../src/events/bus")
    const db = openTmp()
    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      bus.emit("task:started", {
        agentId: "a",
        channel: "telegram",
        chatId: "c",
        messagePreview: "x",
        at: new Date().toISOString(),
      })
      bus.emit("task:completed", {
        agentId: "a",
        channel: "telegram",
        chatId: "c",
        durationMs: 100,
        error: "boom",
        at: new Date().toISOString(),
      } as any)
      const traces = listTraces(db, { agentId: "a" })
      expect(traces[0].status).toBe("error")
      expect(traces[0].error).toBe("boom")
    } finally {
      dispose()
      bus.removeAllListeners()
    }
  })
})

describe("pruneSqliteTables — task_traces cascade", () => {
  it("deletes old traces and cascades steps", () => {
    const db = openTmp()
    const oldId = recordTraceStart(db, { agentId: "a" })
    recordTraceStep(db, oldId, { name: "tool_use" })
    // Backdate to 31 days ago.
    const longAgo = Date.now() - 31 * 24 * 60 * 60 * 1000
    db.prepare("UPDATE task_traces SET started_at = ? WHERE task_id = ?").run(longAgo, oldId)

    const recent = recordTraceStart(db, { agentId: "a" })
    recordTraceStep(db, recent, { name: "tool_use" })

    const pruned = pruneSqliteTables(db, 30)
    expect(pruned.taskTraces).toBe(1)

    expect(getTrace(db, oldId)).toBeNull()
    expect(getTrace(db, recent)).not.toBeNull()
    // FK CASCADE means the old trace's steps are gone too.
    const orphanSteps = db
      .prepare("SELECT COUNT(*) AS c FROM task_trace_steps WHERE task_id = ?")
      .get(oldId) as { c: number }
    expect(orphanSteps.c).toBe(0)
  })
})
