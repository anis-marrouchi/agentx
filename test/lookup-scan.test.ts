import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { handleLookup, type LookupDeps } from "../src/daemon/lookup-api"

// The live Mac table on 11-08: about 62k runs, about 16k of them in the last
// 7 days, long messages. A work lookup there took 11 s in one blocking query.
const NOW = Date.parse("2026-11-08T10:00:00Z")
const DAY = 86_400_000
const ROWS = 62_000
const RECENT = 16_000
const FILLER = "x".repeat(3000)
let db: Database.Database

beforeAll(() => {
  db = new Database(":memory:")
  db.exec(`CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel TEXT, chat_id TEXT, status TEXT NOT NULL,
    started_at INTEGER NOT NULL, original_message TEXT, final_response TEXT, error TEXT, sender TEXT)`)
  const ins = db.prepare("INSERT INTO task_traces VALUES (?,?,?,?,?,?,?,?,?,?)")
  const old = ROWS - RECENT
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) {
      // Rows go in in start order, as the daemon writes them.
      const at = i < old ? NOW - 60 * DAY + i * ((53 * DAY) / old) : NOW - 7 * DAY + 60_000 + (i - old) * ((7 * DAY - 120_000) / RECENT)
      const msg = i === 50 ? "old: team/app!52 merged" : i === old + 5 ? "Rebase team/app!52 please" : `run ${i} on other work !${i % 90} ${FILLER}`
      ins.run(`t${i}`, "builder", "a2a", "dlg", "ok", Math.round(at), msg, i === old + 5 ? "Rebased team/app!52." : "done", null, "")
    }
  })()
})
afterAll(() => db.close())

function deps(over: Partial<LookupDeps> = {}): LookupDeps {
  return { db, hasAgent: () => true, running: () => [], openRequests: () => [], handOffs: () => [], now: NOW, ...over }
}

/** Longest stretch the event loop went without a turn while `run` ran. */
async function longestBlock<T>(run: () => Promise<T>): Promise<{ value: T; maxGap: number; total: number }> {
  let last = performance.now()
  let maxGap = 0
  let on = true
  const tick = () => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; if (on) setImmediate(tick) }
  setImmediate(tick)
  const t0 = performance.now()
  const value = await run()
  const total = performance.now() - t0
  on = false
  return { value, maxGap: Math.max(maxGap, performance.now() - last), total }
}

describe("agentx_lookup work scan at the live table size", () => {
  it("reads only the 7-day window by rowid, never the whole table", () => {
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM task_traces WHERE rowid BETWEEN ? AND ? AND started_at >= ? AND (original_message LIKE ?) ORDER BY rowid DESC",
    ).all(1, 2, 0, "%a%") as Array<{ detail: string }>
    const detail = plan.map((p) => p.detail).join(" | ")
    expect(detail).toMatch(/rowid>\? AND rowid<\?|INTEGER PRIMARY KEY/)
    expect(detail).not.toContain("TEMP B-TREE")
  })

  it("finds the run and never blocks the event loop for long", async () => {
    const { value, maxGap, total } = await longestBlock(() => handleLookup(new URLSearchParams("work=team/app!52"), deps()))
    const text = String(value.body.text)
    expect(text).toContain("Rebased team/app!52.")
    expect(text).not.toContain("old: team/app!52")
    expect(value.body.partial).toBeUndefined()
    // One slice of 2000 rows at a time; the old blocking query on this
    // shape held the loop for the whole scan.
    expect(maxGap).toBeLessThan(250)
    expect(total).toBeLessThan(5000)
  })

  it("stops at its time budget and says the answer is partial", async () => {
    const a = await handleLookup(new URLSearchParams("work=team/app!52"), deps({ scanSlice: 50, scanBudgetMs: 0 }))
    expect(a.body.partial).toBe(true)
    expect(String(a.body.text)).toContain("Search stopped early")
  })
})
