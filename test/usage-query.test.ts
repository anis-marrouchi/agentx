import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { attachSqliteSubscribers } from "../src/storage/subscribers"
import { getEventBus } from "../src/events/bus"
import {
  loadDailyUsage,
  loadTodayRollup,
  loadUsageRange,
  getUsageReadMode,
} from "../src/storage/usage-query"
import { TokenTracker, CONTEXT_TIER_THRESHOLD } from "../src/daemon/token-tracker"

let tmp: string

beforeEach(() => {
  closeDb()
  getEventBus().removeAllListeners()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-usage-query-"))
})

function openTmp() {
  return openDb({ path: path.join(tmp, "db.sqlite") })!
}

function emitTask(args: {
  agentId: string
  channel?: string
  chatId?: string
  at: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
  tier2InputTokens?: number
  tier2OutputTokens?: number
  tier2CacheReadTokens?: number
  tier2CacheCreateTokens?: number
}) {
  const bus = getEventBus()
  const channel = args.channel ?? "api"
  const chatId = args.chatId ?? "c"
  bus.emit("task:started", {
    agentId: args.agentId,
    channel,
    chatId,
    messagePreview: "",
    at: args.at,
  })
  bus.emit("task:completed", {
    agentId: args.agentId,
    channel,
    chatId,
    durationMs: 1,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cacheReadTokens: args.cacheReadTokens,
    cacheCreateTokens: args.cacheCreateTokens,
    tier2InputTokens: args.tier2InputTokens,
    tier2OutputTokens: args.tier2OutputTokens,
    tier2CacheReadTokens: args.tier2CacheReadTokens,
    tier2CacheCreateTokens: args.tier2CacheCreateTokens,
    at: args.at,
  })
}

describe("loadDailyUsage", () => {
  it("returns null when no rows for that day", () => {
    const db = openTmp()
    expect(loadDailyUsage(db, "2026-04-30")).toBeNull()
  })

  it("returns null when db is null", () => {
    expect(loadDailyUsage(null, "2026-04-30")).toBeNull()
  })

  it("aggregates per-agent tier1+tier2 across multiple events", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({ agentId: "a", at: "2026-04-30T10:00:00.000Z", inputTokens: 100, outputTokens: 50 })
    emitTask({
      agentId: "a", at: "2026-04-30T11:00:00.000Z",
      tier2InputTokens: 5_000, tier2OutputTokens: 800,
      tier2CacheReadTokens: 200_000,
    })
    const daily = loadDailyUsage(db, "2026-04-30")
    expect(daily).not.toBeNull()
    expect(daily!.date).toBe("2026-04-30")
    expect(daily!.agents.a.inputTokens).toBe(100)
    expect(daily!.agents.a.tier2InputTokens).toBe(5_000)
    expect(daily!.agents.a.tier2CacheReadTokens).toBe(200_000)
    expect(daily!.agents.a.tasks).toBe(2)
  })

  it("folds same-agent multi-model rows into one entry", () => {
    const db = openTmp()
    // Bypass the subscriber to write two rows on different model keys.
    db.prepare(
      `INSERT INTO usage_daily (agent_id, model, day, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, tier2_input_tokens, tier2_output_tokens, tier2_cache_read_tokens, tier2_cache_create_tokens, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("a", "claude-opus-4-7", "2026-04-30", 100, 50, 0, 0, 0, 0, 0, 0, 1)
    db.prepare(
      `INSERT INTO usage_daily (agent_id, model, day, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, tier2_input_tokens, tier2_output_tokens, tier2_cache_read_tokens, tier2_cache_create_tokens, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("a", "claude-haiku", "2026-04-30", 200, 75, 0, 0, 0, 0, 0, 0, 1)
    const daily = loadDailyUsage(db, "2026-04-30")
    expect(Object.keys(daily!.agents)).toEqual(["a"])
    expect(daily!.agents.a.inputTokens).toBe(300)
    expect(daily!.agents.a.tasks).toBe(2)
  })
})

describe("loadUsageRange", () => {
  it("returns [] when db is null", () => {
    expect(loadUsageRange(null, "2026-04-01", "2026-04-30")).toEqual([])
  })

  it("returns [] for empty SQLite", () => {
    const db = openTmp()
    expect(loadUsageRange(db, "2026-04-01", "2026-04-30")).toEqual([])
  })

  it("honors inclusive range and sorts ASC by date", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({ agentId: "a", at: "2026-04-28T10:00:00.000Z", inputTokens: 100, outputTokens: 50 })
    emitTask({ agentId: "a", at: "2026-04-29T10:00:00.000Z", inputTokens: 200, outputTokens: 75 })
    emitTask({ agentId: "a", at: "2026-04-30T10:00:00.000Z", inputTokens: 300, outputTokens: 100 })
    const range = loadUsageRange(db, "2026-04-29", "2026-04-30")
    expect(range.map(d => d.date)).toEqual(["2026-04-29", "2026-04-30"])
    expect(range[0].input).toBe(200)
    expect(range[1].input).toBe(300)
  })

  it("matches JSON loader shape — UsageDay with agents map and totals", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({
      agentId: "a", at: "2026-04-30T10:00:00.000Z",
      inputTokens: 1_000, outputTokens: 200,
      cacheReadTokens: 5_000, cacheCreateTokens: 100,
    })
    const [day] = loadUsageRange(db, "2026-04-30", "2026-04-30")
    expect(day.date).toBe("2026-04-30")
    expect(day.tasks).toBe(1)
    expect(day.input).toBe(1_000)
    expect(day.output).toBe(200)
    expect(day.cacheRead).toBe(5_000)
    expect(day.cacheCreate).toBe(100)
    expect(day.agents.a).toBeDefined()
    expect(typeof day.agents.a.cost).toBe("number")
    expect(day.cost).toBeGreaterThan(0)
  })

  it("tier-2 cost matches TokenTracker.calculateCost on equivalent AgentUsage", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({
      agentId: "a", at: "2026-04-30T10:00:00.000Z",
      tier2InputTokens: 10_000,
      tier2OutputTokens: 1_000,
      tier2CacheReadTokens: CONTEXT_TIER_THRESHOLD + 1,
      tier2CacheCreateTokens: 0,
    })
    const [day] = loadUsageRange(db, "2026-04-30", "2026-04-30")
    const expected = TokenTracker.calculateCost({
      tasks: 1, totalDuration: 0, errors: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      tier2InputTokens: 10_000, tier2OutputTokens: 1_000,
      tier2CacheReadTokens: CONTEXT_TIER_THRESHOLD + 1, tier2CacheCreateTokens: 0,
      // Subscriber writes rows with model="claude-opus-4-7" by default;
      // pin the model here so cost lookup uses the same pricing slot.
      model: "claude-opus-4-7",
    })
    expect(day.agents.a.cost).toBeCloseTo(expected, 9)
    expect(day.cost).toBeCloseTo(expected, 9)
  })

  it("displays input/output as tier1 + tier2 sum (real volume operators paid for)", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({
      agentId: "a", at: "2026-04-30T10:00:00.000Z",
      inputTokens: 100, outputTokens: 50,
    })
    emitTask({
      agentId: "a", at: "2026-04-30T11:00:00.000Z",
      tier2InputTokens: 5_000, tier2OutputTokens: 800,
    })
    const [day] = loadUsageRange(db, "2026-04-30", "2026-04-30")
    expect(day.input).toBe(5_100)
    expect(day.output).toBe(850)
    expect(day.agents.a.input).toBe(5_100)
  })

  it("multiple agents on the same day produce per-agent entries", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({ agentId: "a", at: "2026-04-30T10:00:00.000Z", inputTokens: 100, outputTokens: 50 })
    emitTask({ agentId: "b", at: "2026-04-30T10:00:00.000Z", inputTokens: 200, outputTokens: 75 })
    const [day] = loadUsageRange(db, "2026-04-30", "2026-04-30")
    expect(Object.keys(day.agents).sort()).toEqual(["a", "b"])
    expect(day.tasks).toBe(2)
  })

  it("omits zero-task days from the range", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({ agentId: "a", at: "2026-04-30T10:00:00.000Z", inputTokens: 100, outputTokens: 50 })
    const range = loadUsageRange(db, "2026-04-25", "2026-04-30")
    expect(range.map(d => d.date)).toEqual(["2026-04-30"])
  })

  it("handles boundary days where from === to", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({ agentId: "a", at: "2026-04-30T10:00:00.000Z", inputTokens: 100, outputTokens: 50 })
    const range = loadUsageRange(db, "2026-04-30", "2026-04-30")
    expect(range).toHaveLength(1)
    expect(range[0].date).toBe("2026-04-30")
  })
})

describe("loadTodayRollup", () => {
  it("returns empty agents map when SQLite is null", () => {
    const today = "2026-04-30"
    const r = loadTodayRollup(null, today)
    expect(r.date).toBe(today)
    expect(r.agents).toEqual({})
  })

  it("returns empty agents map when SQLite has no rows for today", () => {
    const db = openTmp()
    const today = "2026-04-30"
    const r = loadTodayRollup(db, today)
    expect(r.date).toBe(today)
    expect(r.agents).toEqual({})
  })

  it("returns the same shape as TokenTracker.today() when SQLite has data", () => {
    const db = openTmp()
    attachSqliteSubscribers(db)
    emitTask({ agentId: "a", at: "2026-04-30T10:00:00.000Z", inputTokens: 100, outputTokens: 50 })
    const r = loadTodayRollup(db, "2026-04-30")
    expect(r.date).toBe("2026-04-30")
    expect(r.agents.a).toBeDefined()
    expect(r.agents.a.tasks).toBe(1)
    expect(r.agents.a.inputTokens).toBe(100)
  })
})

describe("getUsageReadMode", () => {
  it("defaults to sqlite-then-json when env var is unset", () => {
    expect(getUsageReadMode({})).toBe("sqlite-then-json")
  })

  it("accepts sqlite, json, sqlite-then-json case-insensitively", () => {
    expect(getUsageReadMode({ AGENTX_USAGE_READ: "sqlite" })).toBe("sqlite")
    expect(getUsageReadMode({ AGENTX_USAGE_READ: "JSON" })).toBe("json")
    expect(getUsageReadMode({ AGENTX_USAGE_READ: "  Sqlite-Then-Json  " })).toBe("sqlite-then-json")
  })

  it("falls back to default when env value is invalid", () => {
    expect(getUsageReadMode({ AGENTX_USAGE_READ: "garbage" })).toBe("sqlite-then-json")
    expect(getUsageReadMode({ AGENTX_USAGE_READ: "" })).toBe("sqlite-then-json")
  })
})
