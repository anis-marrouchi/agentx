import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { allIndexed, spendByAgentSince, spendByChatSince, unpricedRunsByAgentSince } from "../src/storage/traces"
import { concurrentOfSql, concurrentOfAllSql } from "../src/daemon/wall-api"
import { monthSums, resetBudgetSumsCache, BUDGET_SUMS_TTL_MS } from "../src/daemon/observability-panel"

// #2322: the month's cost sums froze the Hub (25–52 s on 193k rows) because
// the planner walked idx_traces_agent_started and read every row. They must
// stay on the covering index, and the budgets endpoint keeps them 60 s.

let dir: string
let db: Database.Database
const SINCE = Date.parse("2026-11-01T00:00:00Z")

function insert(agent: string, chat: string, startedAt: number, cost: number | null, tokens = 100) {
  db.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, cost_usd, input_tokens, output_tokens)
    VALUES (?, ?, 'a2a', ?, 'done', ?, ?, ?, ?)`).run(`t${Math.random()}`, agent, chat, startedAt, cost, tokens, tokens)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-2322-"))
  db = openDb({ path: join(dir, "db.sqlite"), quiet: true })!
  resetBudgetSumsCache()
})
afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe("month cost sums (#2322)", () => {
  it("the migration creates idx_traces_started_cost", () => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_traces_started_cost'").get() as { sql: string } | undefined
    expect(row?.sql).toContain("started_at, agent_id, chat_id, cost_usd, input_tokens, output_tokens")
  })

  it("all three queries read only the covering index", () => {
    const src = readFileSync(join(__dirname, "../src/storage/traces.ts"), "utf8")
    const sqls = [...src.matchAll(/(SELECT [^`]*?FROM task_traces INDEXED BY idx_traces_started_cost[^`]*)`/g)].map((m) => m[1])
    expect(sqls).toHaveLength(3)
    for (const sql of sqls) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(SINCE) as Array<{ detail: string }>).map((r) => r.detail).join(" | ")
      expect(plan).toMatch(/USING COVERING INDEX idx_traces_started_cost/)
    }
  })

  it("sums stay correct", () => {
    insert("scout", "c1", SINCE + 1, 1.5)
    insert("scout", "c2", SINCE + 2, 2)
    insert("coder", "c1", SINCE + 3, 4)
    insert("coder", "c1", SINCE + 4, null)
    insert("coder", "c1", SINCE + 5, null, 0)
    insert("scout", "c1", SINCE - 1, 99)
    expect(spendByAgentSince(db, SINCE)).toEqual({ scout: 3.5, coder: 4 })
    expect(spendByChatSince(db, SINCE)).toHaveLength(3)
    expect(unpricedRunsByAgentSince(db, SINCE)).toEqual({ coder: 1 })
  })

  it("the budgets endpoint keeps the sums 60 s, per month", () => {
    insert("scout", "c1", SINCE + 1, 1)
    const now = SINCE + 1000
    expect(monthSums(db, SINCE, now).byAgent).toEqual({ scout: 1 })
    insert("scout", "c1", SINCE + 2, 1)
    expect(monthSums(db, SINCE, now + BUDGET_SUMS_TTL_MS - 1).byAgent).toEqual({ scout: 1 })
    expect(monthSums(db, SINCE, now + BUDGET_SUMS_TTL_MS).byAgent).toEqual({ scout: 2 })
    // A new month never reuses last month's sums.
    expect(monthSums(db, SINCE + 2, now + BUDGET_SUMS_TTL_MS + 1).byAgent).toEqual({ scout: 1 })
  })

  it("a handle without the index (opened before the migration) still sums, without the hint", () => {
    insert("scout", "c1", SINCE + 1, 1.5)
    insert("coder", "c1", SINCE + 2, null)
    db.exec("DROP INDEX idx_traces_started_cost")
    expect(() => db.prepare("SELECT 1 FROM task_traces INDEXED BY idx_traces_started_cost").all()).toThrow(/no such index/)
    expect(spendByAgentSince(db, SINCE)).toEqual({ scout: 1.5 })
    expect(spendByChatSince(db, SINCE)).toEqual([{ agentId: "scout", chatId: "c1", usd: 1.5 }])
    expect(unpricedRunsByAgentSince(db, SINCE)).toEqual({ coder: 1 })
  })

  it("the fallback only swallows a missing index", () => {
    expect(() => allIndexed(db, "SELECT nope FROM task_traces INDEXED BY idx_traces_started_cost")).toThrow(/no such column/)
  })
})

// #2322 B1: the Wall's concurrent-run reads walked idx_traces_agent_started
// and read every row. The Mac DB has idx_traces_agent_started_span built by
// hand; the migration adds it under the same name and columns.
describe("Wall span index (#2322 B1)", () => {
  it("the migration creates idx_traces_agent_started_span", () => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_traces_agent_started_span'").get() as { sql: string } | undefined
    expect(row?.sql).toContain("agent_id, started_at, task_id, channel, chat_id, status, finished_at, duration_ms")
  })

  it("concurrentOf and concurrentOfAll read only the span index", () => {
    for (const n of [1, 3]) {
      const agents = Array.from({ length: n }, (_, i) => `a${i}`)
      const cases: Array<[string, unknown[]]> = [
        [concurrentOfSql(n), [...agents, SINCE, SINCE + 1000, SINCE]],
        [concurrentOfAllSql(n), [...agents, SINCE, SINCE + 1000]],
      ]
      for (const [sql, params] of cases) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail).join(" | ")
        expect(plan).toMatch(/USING COVERING INDEX idx_traces_agent_started_span/)
      }
    }
  })
})
