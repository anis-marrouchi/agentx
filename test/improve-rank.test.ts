import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { recordSignal } from "../src/improve/signals"
import { applyMerge, groupSignals, normalizeDetail, rankSignals, readRanking, saveRanking } from "../src/improve/rank"
import { canSpend, recordSpend, spentToday, CALL_ESTIMATE_USD } from "../src/improve/budget"
import { improvePass } from "../src/improve/nightly"
import { improveConfigSchema } from "../src/daemon/config"

let db: Database.Database
beforeEach(() => { db = new Database(":memory:") })
afterEach(() => { db.close() })

const T = Date.parse("2026-11-08T10:00:00Z")
const ON = { ...improveConfigSchema.parse(undefined), enabled: true, dailyUsd: 1 }

describe("normalizeDetail", () => {
  it("takes ids, numbers, links and quotes out, so one problem reads the same each time", () => {
    const a = normalizeDetail("request_stalled", "timed out after 612s on req-01M6TKA0ABCDEF, see https://x.tld/a?b=1")
    const b = normalizeDetail("request_stalled", "Timed out after 30s on req-9, see https://x.tld/zz")
    expect(a).toBe(b)
    expect(a).toBe("timed out after <n>s on <id>, see <url>")
    expect(normalizeDetail("delegation_failed", 'builder error: "no such file" at 4f9a2c1d')).toBe("builder error: <text> at <id>")
  })

  it("keeps the owner's own words out of the pattern: they never repeat", () => {
    expect(normalizeDetail("owner_reopened", "this is not what I asked")).toBe("")
    expect(normalizeDetail("owner_check_mismatch", "the close skipped the invoice")).toBe("")
  })
})

describe("groupSignals and rankSignals", () => {
  function seed() {
    // 4 separate requests stalled the same way for builder.
    for (let i = 0; i < 4; i++) recordSignal(db, { kind: "request_stalled", agentId: "builder", ref: `req-${i}`, detail: `timed out after ${100 + i}s` }, T + i)
    // The owner reopened planner's closes 3 times, each in their own words.
    for (let i = 0; i < 3; i++) recordSignal(db, { kind: "owner_reopened", agentId: "planner", ref: `req-r${i}`, detail: `not done ${"x".repeat(i)}` }, T + i)
    // One hand-off refused 5 times, but always for the same task: one ref.
    for (let i = 0; i < 5; i++) recordSignal(db, { kind: "handoff_refused", agentId: "ops", ref: "task-1", detail: "budget -> builder" }, T + i * 11 * 60_000)
  }

  it("groups by kind, agent and pattern, and counts separate references", () => {
    seed()
    const groups = groupSignals(db, T - 1)
    const stalled = groups.find((g) => g.kind === "request_stalled")!
    expect(stalled).toMatchObject({ agentId: "builder", rows: 4, refs: 4, score: 8, pattern: "timed out after <n>s" })
    expect(groups.find((g) => g.kind === "owner_reopened")).toMatchObject({ rows: 3, refs: 3, score: 9 })
    expect(groups.find((g) => g.kind === "handoff_refused")).toMatchObject({ rows: 5, refs: 1 })
  })

  it("keeps groups seen in 3+ separate references, worst first, with no model call", async () => {
    seed()
    const r = await rankSignals(db, { since: T - 1, now: T + 3_600_000 })
    expect(r.groups.map((g) => g.kind)).toEqual(["owner_reopened", "request_stalled"])
    expect(r.below).toBe(1)
    expect(r.merge.ran).toBe(false)
  })

  it("reads nothing, and does not throw, on a node with no signals table", async () => {
    expect(groupSignals(db, 0)).toEqual([])
    expect((await rankSignals(db, { since: 0 })).groups).toEqual([])
  })
})

describe("applyMerge", () => {
  it("folds groups of the same kind and agent, and ignores unknown keys and mixed lists", () => {
    for (let i = 0; i < 2; i++) recordSignal(db, { kind: "delegation_failed", agentId: "a", ref: `d${i}`, detail: "builder timeout" }, T + i)
    for (let i = 0; i < 2; i++) recordSignal(db, { kind: "delegation_failed", agentId: "a", ref: `e${i}`, detail: "builder ran out of time" }, T + i)
    for (let i = 0; i < 2; i++) recordSignal(db, { kind: "delegation_failed", agentId: "b", ref: `f${i}`, detail: "builder timeout" }, T + i)
    const groups = groupSignals(db, 0)
    const [x, y] = groups.filter((g) => g.agentId === "a").map((g) => g.key)
    const other = groups.find((g) => g.agentId === "b")!.key
    const out = applyMerge(groups, JSON.stringify({ merge: [[x, y, "nope"], [other, "missing"]] }))
    expect(out).toHaveLength(2)
    expect(out.find((g) => g.agentId === "a")).toMatchObject({ rows: 4, refs: 4 })
    expect(out.find((g) => g.agentId === "a")!.members.sort()).toEqual([x, y].sort())
    expect(applyMerge(groups, "not json")).toBe(groups)
  })
})

describe("budget", () => {
  it("refuses every call while improve.enabled is off", () => {
    expect(canSpend(db, { enabled: false, dailyUsd: 5 }, "merge", T)).toMatchObject({ ok: false })
  })

  it("refuses a call that would pass improve.dailyUsd in 24 hours, and books unknown costs at the estimate", () => {
    expect(canSpend(db, ON, "retro", T)).toMatchObject({ ok: false }) // $2 estimate > $1
    expect(canSpend(db, ON, "merge", T).ok).toBe(true)
    recordSpend(db, "merge", null, null, T)
    expect(spentToday(db, T + 1)).toEqual({ usd: CALL_ESTIMATE_USD.merge, calls: { merge: 1 } })
    recordSpend(db, "merge", 0.85, null, T)
    expect(canSpend(db, ON, "merge", T + 1)).toMatchObject({ ok: false })
    expect(canSpend(db, ON, "merge", T + 86_400_001).ok).toBe(true)
  })
})

describe("rankSignals merge call", () => {
  function twoNearDuplicates() {
    for (let i = 0; i < 2; i++) recordSignal(db, { kind: "delegation_failed", agentId: "a", ref: `d${i}`, detail: "builder timeout" }, T + i)
    for (let i = 0; i < 2; i++) recordSignal(db, { kind: "delegation_failed", agentId: "a", ref: `e${i}`, detail: "builder ran out of time" }, T + i)
  }

  it("runs once a day, books its cost, and can lift two small groups over the line", async () => {
    twoNearDuplicates()
    let calls = 0
    const merge = async (input: string) => {
      calls++
      const keys = JSON.parse(input).map((g: { key: string }) => g.key)
      return { text: JSON.stringify({ merge: [keys] }), usd: 0.01 }
    }
    const r = await rankSignals(db, { since: 0, now: T + 10, merge, settings: ON })
    expect(r.merge).toEqual({ ran: true, folded: 1, usd: 0.01 })
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].refs).toBe(4)
    const again = await rankSignals(db, { since: 0, now: T + 20, merge, settings: ON })
    expect(again.merge).toMatchObject({ ran: false, why: expect.stringContaining("already ran") })
    expect(calls).toBe(1)
  })

  it("is not called when no two groups could merge", async () => {
    for (let i = 0; i < 3; i++) recordSignal(db, { kind: "request_stalled", agentId: "a", ref: `r${i}`, detail: "quiet" }, T + i)
    let called = false
    const r = await rankSignals(db, { since: 0, now: T + 10, settings: ON, merge: async () => { called = true; return { text: "{}", usd: 0 } } })
    expect(called).toBe(false)
    expect(r.merge.ran).toBe(false)
  })

  it("a failed call still counts against the day", async () => {
    twoNearDuplicates()
    const r = await rankSignals(db, { since: 0, now: T + 10, settings: ON, merge: async () => { throw new Error("boom") } })
    expect(r.merge).toMatchObject({ ran: false, why: expect.stringContaining("boom") })
    expect(spentToday(db, T + 11).calls.merge).toBe(1)
  })
})

describe("improvePass", () => {
  it("previews without saving or calling, and saves the day's ranking with commit", async () => {
    for (let i = 0; i < 3; i++) recordSignal(db, { kind: "request_stalled", agentId: "a", ref: `r${i}`, detail: "quiet" }, T + i)
    let called = false
    const call = async () => { called = true; return { text: "{}", usd: 0 } }
    const preview = await improvePass({ db, since: 0, settings: ON, call, now: T + 10 })
    expect(preview.savedDay).toBeUndefined()
    expect(readRanking(db)).toEqual([])
    const off = await improvePass({ db, since: 0, commit: true, settings: { ...ON, enabled: false }, call, now: T + 10 })
    expect(off.merge).toMatchObject({ ran: false, why: "improve.enabled is off" })
    expect(off.savedDay).toBe("2026-11-08")
    expect(readRanking(db)).toMatchObject([{ rank: 1, kind: "request_stalled", agentId: "a", refs: 3, day: "2026-11-08" }])
    expect(called).toBe(false)
  })

  it("replaces an earlier save of the same day", () => {
    const g = { key: "k1", kind: "request_stalled" as const, agentId: "a", pattern: "p", rows: 3, refs: 3, score: 6, firstAt: T, lastAt: T, sample: null, sampleRefs: [], members: ["k1"] }
    saveRanking(db, [g], T)
    saveRanking(db, [{ ...g, key: "k2", members: ["k2"] }], T + 1000)
    expect(readRanking(db, "2026-11-08").map((r) => r.key)).toEqual(["k2"])
  })
})
