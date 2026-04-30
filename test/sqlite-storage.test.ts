import { describe, it, expect, beforeEach, afterAll } from "vitest"
import Database from "better-sqlite3"
import { openDb, closeDb, getSchemaVersion } from "../src/storage/sqlite"
import { attachSqliteSubscribers } from "../src/storage/subscribers"
import { getEventBus } from "../src/events/bus"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"

let tmp: string

beforeEach(() => {
  closeDb()
  getEventBus().removeAllListeners()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-sqlite-"))
})

function openTmp() {
  return openDb({ path: path.join(tmp, "db.sqlite") })
}

describe("openDb + migrations", () => {
  it("creates the file and migrates to the latest schema", () => {
    const db = openTmp()
    expect(db).not.toBeNull()
    expect(getSchemaVersion(db!)).toBeGreaterThanOrEqual(5)
  })

  it("has tier-2 columns on usage_daily after v5", () => {
    const db = openTmp()!
    const cols = (db.prepare("PRAGMA table_info(usage_daily)").all() as { name: string }[])
      .map(r => r.name)
    expect(cols).toContain("tier2_input_tokens")
    expect(cols).toContain("tier2_output_tokens")
    expect(cols).toContain("tier2_cache_read_tokens")
    expect(cols).toContain("tier2_cache_create_tokens")
  })

  it("is idempotent — second open returns the same instance", () => {
    const db1 = openTmp()
    const db2 = openTmp()
    expect(db1).toBe(db2)
  })

  it("creates the expected tables", () => {
    const db = openTmp()!
    const tables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]).map(r => r.name)
    expect(tables).toContain("task_history")
    expect(tables).toContain("usage_daily")
    expect(tables).toContain("rotations")
    expect(tables).toContain("route_traces")
  })

  it("is disabled by flag", () => {
    const db = openDb({ disabled: true })
    expect(db).toBeNull()
  })
})

describe("subscribers — task lifecycle", () => {
  it("writes one task_history row per (started, completed) pair", () => {
    const db = openTmp()!
    attachSqliteSubscribers(db)
    const bus = getEventBus()
    const at1 = "2026-04-27T19:00:00.000Z"
    const at2 = "2026-04-27T19:00:30.000Z"
    bus.emit("task:started", {
      agentId: "coder-agent",
      channel: "telegram",
      chatId: "1816212449",
      messagePreview: "fix prototype pollution",
      at: at1,
    })
    bus.emit("task:completed", {
      agentId: "coder-agent",
      channel: "telegram",
      chatId: "1816212449",
      durationMs: 30_000,
      inputTokens: 12_000,
      outputTokens: 800,
      cacheReadTokens: 250_000,
      cacheCreateTokens: 500,
      at: at2,
    })
    const rows = db
      .prepare("SELECT * FROM task_history ORDER BY started_at")
      .all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe("coder-agent")
    expect(rows[0].status).toBe("ok")
    expect(rows[0].duration_ms).toBe(30_000)
    expect(rows[0].input_tokens).toBe(12_000)
    expect(rows[0].started_at).toBe(at1)
    expect(rows[0].finished_at).toBe(at2)
    expect(rows[0].message_preview).toBe("fix prototype pollution")
  })

  it("records error status when task:completed has error", () => {
    const db = openTmp()!
    attachSqliteSubscribers(db)
    const bus = getEventBus()
    bus.emit("task:started", {
      agentId: "x", channel: "api", chatId: "y",
      messagePreview: "hi", at: "2026-04-27T19:00:00.000Z",
    })
    bus.emit("task:completed", {
      agentId: "x", channel: "api", chatId: "y",
      durationMs: 100, error: "boom",
      at: "2026-04-27T19:00:01.000Z",
    })
    const row = db.prepare("SELECT * FROM task_history").get() as any
    expect(row.status).toBe("error")
    expect(row.error).toBe("boom")
  })

  it("upserts usage_daily across multiple turns", () => {
    const db = openTmp()!
    attachSqliteSubscribers(db)
    const bus = getEventBus()
    const emit = (input: number, output: number) => {
      const at = "2026-04-27T19:00:00.000Z"
      bus.emit("task:started", { agentId: "a", channel: "api", chatId: "c", messagePreview: "", at })
      bus.emit("task:completed", { agentId: "a", channel: "api", chatId: "c", durationMs: 1, inputTokens: input, outputTokens: output, at })
    }
    emit(100, 50)
    emit(200, 75)
    emit(300, 100)
    const row = db.prepare("SELECT * FROM usage_daily WHERE agent_id='a'").get() as any
    expect(row.input_tokens).toBe(600)
    expect(row.output_tokens).toBe(225)
    expect(row.tasks).toBe(3)
    expect(row.day).toBe("2026-04-27")
  })
})

describe("subscribers — session rotation", () => {
  it("writes one rotation row per session:rotated event", () => {
    const db = openTmp()!
    attachSqliteSubscribers(db)
    const bus = getEventBus()
    bus.emit("session:rotated", {
      agentId: "coder-agent",
      channel: "telegram",
      chatId: "1816212449",
      reason: "tier-2",
      lastTurnInputTokens: 245_000,
      at: "2026-04-27T19:05:00.000Z",
    })
    const row = db.prepare("SELECT * FROM rotations").get() as any
    expect(row.reason).toBe("tier-2")
    expect(row.last_turn_input_tokens).toBe(245_000)
  })
})

describe("subscribers — route traces", () => {
  it("writes a route_traces row for matched and dropped events", () => {
    const db = openTmp()!
    attachSqliteSubscribers(db)
    const bus = getEventBus()
    bus.emit("message:matched", {
      channel: "telegram", chatId: "x", msgId: "1",
      agentId: "coder-agent", decidingStage: "dm-binding",
      at: "2026-04-27T19:10:00.000Z",
    })
    bus.emit("message:dropped", {
      channel: "telegram", chatId: "x", msgId: "2",
      decidingStage: "self-reply-guard", reason: "agentx-marker",
      at: "2026-04-27T19:10:01.000Z",
    })
    const rows = db.prepare("SELECT * FROM route_traces ORDER BY at").all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe("match")
    expect(rows[0].agent_id).toBe("coder-agent")
    expect(rows[1].kind).toBe("drop")
    expect(rows[1].reason).toBe("agentx-marker")
  })
})
