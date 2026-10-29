import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore, type FlowRow, type RequestState } from "../src/requests/store"
import { dayIn, describeFlow, measureFlow } from "../src/requests/flow"
import { handleRequestsApi, type RequestsApiDeps } from "../src/requests/daemon-api"

// The daily flow rate of requests (#1542).

const HOUR = 3_600_000
// 15:00 Tunis (UTC+1) on 29 October 2030.
const NOW = Date.parse("2030-10-29T14:00:00Z")

let seq = 0
const row = (state: RequestState, createdAt: number, extra: Partial<FlowRow> = {}): FlowRow =>
  ({ id: `req-${++seq}`, state, createdAt, resentAt: null, closeReason: state === "dropped" || state === "declined" ? "duplicate" : null, ...extra })
const fake = (rows: FlowRow[]) => ({ flowRows: (since: number) => rows.filter((r) => r.createdAt >= since) })

describe("measureFlow", () => {
  it("counts today's requests by where they stand, and the rate is done plus dropped of asked", () => {
    const t = NOW - HOUR
    const rows = [
      ...Array.from({ length: 13 }, () => row("done", t)),
      ...Array.from({ length: 3 }, () => row("dropped", t)),
      row("declined", t),
      ...Array.from({ length: 5 }, () => row("in_progress", t)),
      ...Array.from({ length: 4 }, () => row("waiting_other", t)),
      ...Array.from({ length: 7 }, () => row("waiting_owner", t)),
      ...Array.from({ length: 5 }, () => row("needs_attention", t)),
    ]
    const f = measureFlow(fake(rows), { days: 1, now: NOW })
    const today = f.days[0]
    expect(today).toMatchObject({ day: "2030-10-29", asked: 38, done: 13, dropped: 4, moving: 9, waiting: 7, stuck: 5 })
    expect(today.rate).toBeCloseTo(17 / 38)
    expect(f.drops).toHaveLength(4)
    expect(describeFlow(f)).toContain("Today (2030-10-29, Africa/Tunis): 45% closed correctly (13 done + 4 dropped of 38 asked); 9 moving, 7 waiting on the owner, 5 stuck.")
  })

  it("splits days at midnight in the owner's time zone, not UTC", () => {
    // 23:30 UTC on the 28th is 00:30 on the 29th in Tunis.
    const late = Date.parse("2030-10-28T23:30:00Z")
    expect(dayIn(late, "Africa/Tunis")).toBe("2030-10-29")
    expect(dayIn(late, "UTC")).toBe("2030-10-28")
    const f = measureFlow(fake([row("done", late), row("done", Date.parse("2030-10-28T22:30:00Z"))]), { days: 2, now: NOW })
    expect(f.days.map((d) => [d.day, d.asked])).toEqual([["2030-10-28", 1], ["2030-10-29", 1]])
  })

  it("shows a trend, oldest day first, with no rate on a day nothing was asked", () => {
    const f = measureFlow(fake([row("done", NOW - 2 * 24 * HOUR), row("needs_attention", NOW - 2 * 24 * HOUR)]), { days: 3, now: NOW })
    expect(f.days.map((d) => d.rate)).toEqual([0.5, null, null])
    expect(f.total).toMatchObject({ asked: 2, done: 1, stuck: 1, rate: 0.5 })
    expect(describeFlow(f)).toContain("Trend: 10-27 50% of 2 · 10-28 n/a of 0 · 10-29 n/a of 0")
  })

  it("counts resent requests, and those done since", () => {
    const t = NOW - HOUR
    const f = measureFlow(fake([row("done", t, { resentAt: t + 1 }), row("needs_attention", t, { resentAt: t + 1 }), row("done", t)]), { days: 1, now: NOW })
    expect(f.days[0]).toMatchObject({ resent: 2, resentDone: 1 })
  })

  it("refuses a time zone Intl does not know", () => {
    expect(() => measureFlow(fake([]), { timeZone: "Mars/Olympus", now: NOW })).toThrow()
  })
})

describe("the store and GET /requests/flow", () => {
  let tmp: string
  let db: Database.Database
  let store: RequestStore

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-flow-"))
    db = new Database(path.join(tmp, "db.sqlite"))
    store = new RequestStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const deps = (query = ""): RequestsApiDeps => ({
    store, tracker: {} as any, enabled: true, hasAgent: () => true, runningTurn: () => null, query: new URLSearchParams(query), now: NOW,
  })

  it("leaves candidates out: a turn that only answered is not a request", () => {
    const t = NOW - HOUR
    store.addCandidate({ id: "req-a", runId: "a", channel: "telegram", chatId: "1", agentId: "coder", text: "hi", now: t })
    store.addCandidate({ id: "req-b", runId: "b", channel: "telegram", chatId: "1", agentId: "coder", text: "ship it", now: t })
    store.progress("req-b", t)
    expect(store.flowRows(0).map((r) => r.id)).toEqual(["req-b"])
  })

  it("answers with the report and its words", () => {
    store.addCandidate({ id: "req-b", runId: "b", channel: "telegram", chatId: "1", agentId: "coder", text: "ship it", now: NOW - HOUR })
    store.progress("req-b", NOW - HOUR)
    store.close("req-b", "done", "https://example.com/pr/1", NOW)
    const res = handleRequestsApi("GET", "/requests/flow", undefined, deps("days=2"))
    expect(res.status).toBe(200)
    expect((res.body as any).days).toHaveLength(2)
    expect((res.body as any).text).toContain("100% closed correctly (1 done + 0 dropped of 1 asked)")
  })

  it("refuses a bad days or time zone", () => {
    expect(handleRequestsApi("GET", "/requests/flow", undefined, deps("days=0")).status).toBe(400)
    expect(handleRequestsApi("GET", "/requests/flow", undefined, deps("days=61")).status).toBe(400)
    expect(handleRequestsApi("GET", "/requests/flow", undefined, deps("tz=Mars/Olympus")).status).toBe(400)
  })
})
