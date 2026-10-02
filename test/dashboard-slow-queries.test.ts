import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import Database from "better-sqlite3"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { TokenStore } from "../src/daemon/token-store"
import { PairCodeStore } from "../src/daemon/pair-codes"
import { MemberStore } from "../src/members/store"
import { inviteMember } from "../src/members/pairing"
import { decideCard, listCards } from "../src/approvals/cards"
import { runsOf } from "../src/people/activity"
import { RequestStore } from "../src/requests/store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart } from "../src/storage/traces"
import { queryName, watchSlowQueries, type QueryTiming } from "../src/storage/slow-queries"
import type { Person } from "../src/people/people"

// The dashboard froze for minutes on one query (#448): better-sqlite3 runs
// on the thread that serves every page, and the member page asked every 30 s
// for a person's turns with a read that walked every run ever recorded.
// A timing test would pass on a small or cached database, so the check here
// is the plan SQLite makes: no page may walk a table that grows with every run.

const GROWING_TABLES = ["task_traces", "task_trace_steps", "task_history", "guardrail_decisions", "session_reviews"]
const PEOPLE: Person[] = [
  { id: "anis", name: "Anis M", role: "owner", identities: [] },
  { id: "sara", name: "Sara B", role: "member", identities: ["gitlab:sara.b"] },
]

const home = process.cwd()
let dir: string
let server: Server
let base: string

beforeAll(async () => {
  closeDb()
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-slow-queries-")))
  dir = process.cwd()
  server = createServer((req, res) => {
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, people: PEOPLE })
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), config } as unknown as Ctx)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  closeDb()
  process.chdir(home)
  rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  closeDb()
  rmSync(join(dir, ".agentx"), { recursive: true, force: true })
})

/** The dashboard's database with every query recorded, whatever it took. */
function recordQueries(): { db: Database.Database; seen: QueryTiming[] } {
  const db = openDb()!
  const seen: QueryTiming[] = []
  watchSlowQueries(db, (q) => seen.push(q), { thresholdMs: 0 })
  return { db, seen }
}

/** Tables a query walks from end to end, as SQLite plans it. */
function walked(db: Database.Database, sql: string): string[] {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return []
  const blanks = new Array((sql.match(/\?/g) || []).length).fill(null)
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...blanks) as Array<{ detail: string }>
  return plan.map((p) => /^SCAN (\w+)/.exec(p.detail)?.[1]).filter((t): t is string => !!t && GROWING_TABLES.includes(t))
}

async function pairMember(person: string): Promise<string> {
  const members = new MemberStore(dir)
  const inv = inviteMember({ tokens: new TokenStore(dir), codes: new PairCodeStore(dir), members, people: () => PEOPLE }, person)
  if (!inv.ok) throw new Error(inv.error)
  const r = await fetch(`${base}/api/member/pair-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: inv.code, machine: "Laptop" }) })
  expect(r.status).toBe(200)
  const card = listCards(dir, "pending").find((c) => c.id === members.byToken(inv.tokenId)?.cardId)!
  expect(decideCard(dir, card.id, "yes", { by: "owner" }).ok).toBe(true)
  return (r.headers.get("set-cookie") || "").split(";")[0]
}

describe("a person's latest turns", () => {
  it("are found through an index, newest first, without walking every run", () => {
    const db = openDb()!
    for (let i = 0; i < 40; i++) recordTraceStart(db, { agentId: "coder", channel: "gitlab", person: i % 10 === 0 ? "sara" : undefined } as any, `T${String(i).padStart(2, "0")}`)
    db.prepare("UPDATE task_traces SET started_at = CAST(substr(task_id, 2) AS INTEGER)").run()
    recordTraceStart(db, { agentId: "coder", channel: "a2a", person: "sara" } as any, "T-hop")

    expect(runsOf(db, "sara", 3).map((r) => r.taskId)).toEqual(["T30", "T20", "T10"])
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT task_id FROM task_traces WHERE person = ? AND (channel IS NULL OR channel != 'a2a') ORDER BY started_at DESC LIMIT ?",
    ).all("sara", 3) as Array<{ detail: string }>
    expect(plan.map((p) => p.detail)).toEqual([expect.stringContaining("USING INDEX idx_traces_person_started")])
  })

  it("get the index on a database made before it existed", () => {
    const db = openDb()!
    db.exec("DROP INDEX idx_traces_person_started")
    closeDb()
    const again = openDb()!
    expect(again.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_traces_person_started'").get()).toBeTruthy()
  })
})

describe("the pages a teammate and the owner keep open", () => {
  it("never walk a table that grows with every run", async () => {
    const { db, seen } = recordQueries()
    new RequestStore(db).addCandidate({ id: "r1", runId: "T1", channel: "gitlab", chatId: "team/app:issue:7", agentId: "coder", text: "ask", now: 1_000, person: "sara" } as any)
    recordTraceStart(db, { agentId: "coder", channel: "gitlab", person: "sara" } as any, "T1")
    const cookie = await pairMember("sara")
    seen.length = 0

    const work = await fetch(`${base}/api/member/work`, { headers: { cookie } })
    expect(((await work.json()) as any).runs.map((r: any) => r.taskId)).toEqual(["T1"])
    const person = await fetch(`${base}/api/admin/people/sara`)
    expect(((await person.json()) as any).runs.map((r: any) => r.taskId)).toEqual(["T1"])
    expect((await fetch(`${base}/api/admin/people`)).status).toBe(200)

    expect(seen.some((q) => /FROM task_traces/.test(q.sql))).toBe(true)
    const offenders = [...new Set(seen.map((q) => q.sql))].filter((sql) => walked(db, sql).length > 0)
    expect(offenders.map((sql) => queryName(sql))).toEqual([])
  })

  it("serve the member page and the phone app shells with no database query", async () => {
    const { seen } = recordQueries()
    const cookie = await pairMember("sara")
    const phone = new TokenStore(dir).create({ name: "Phone", scopes: ["app"] }).token
    seen.length = 0

    expect((await fetch(`${base}/member`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${base}/member`)).status).toBe(401)
    expect((await fetch(`${base}/app`, { headers: { Authorization: `Bearer ${phone}` } })).status).toBe(200)
    expect((await fetch(`${base}/app`)).status).toBe(401)
    expect(seen.map((q) => queryName(q.sql))).toEqual([])
  })
})

describe("the slow query log", () => {
  const clock = (steps: number[]) => () => steps.shift() ?? 0

  it("reports a query that held the process for the set time or longer, by its text", () => {
    const db = new Database(":memory:")
    db.exec("CREATE TABLE t (a INTEGER)")
    const seen: QueryTiming[] = []
    // Two clock readings per call: 250 ms for the insert, 40 ms and 200 ms for the reads.
    watchSlowQueries(db, (q) => seen.push(q), { thresholdMs: 200, now: clock([0, 250, 1000, 1040, 2000, 2200]) })
    db.prepare("INSERT INTO t (a) VALUES (?)").run(1)
    expect(db.prepare("SELECT a FROM t").all()).toEqual([{ a: 1 }])
    expect(db.prepare("SELECT a   FROM t\n WHERE a = ?").get(1)).toEqual({ a: 1 })
    expect(seen).toEqual([
      { sql: "INSERT INTO t (a) VALUES (?)", ms: 250 },
      { sql: "SELECT a   FROM t\n WHERE a = ?", ms: 200 },
    ])
    db.close()
  })

  it("reports a query that failed, and lets the error through", () => {
    const db = new Database(":memory:")
    db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY)")
    const seen: QueryTiming[] = []
    watchSlowQueries(db, (q) => seen.push(q), { thresholdMs: 200, now: clock([0, 0, 0, 300]) })
    const insert = db.prepare("INSERT INTO t (a) VALUES (?)")
    insert.run(1)
    expect(() => insert.run(1)).toThrow(/UNIQUE/)
    expect(seen).toEqual([{ sql: "INSERT INTO t (a) VALUES (?)", ms: 300 }])
    db.close()
  })

  it("watches a database once, however often it is asked to", () => {
    const db = new Database(":memory:")
    const seen: QueryTiming[] = []
    watchSlowQueries(db, (q) => seen.push(q), { thresholdMs: 0 })
    watchSlowQueries(db, (q) => seen.push(q), { thresholdMs: 0 })
    db.prepare("SELECT 1").get()
    expect(seen).toHaveLength(1)
    db.close()
  })

  it("names a query on one line, cut to a length a log line can carry", () => {
    expect(queryName("SELECT a,\n       b\n  FROM t   WHERE a = ?")).toBe("SELECT a, b FROM t WHERE a = ?")
    expect(queryName(`SELECT ${"x, ".repeat(100)}y FROM t`)).toHaveLength(160)
  })
})
