import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { buildMeshAnalytics, classifyCause, dayKeysBetween, dayBounds } from "../src/storage/mesh-analytics"
import { listJobRuns, listThreadRuns, getRunShape, getDayActivity, getConversationSummary } from "../src/storage/mesh-drill"
import { mergeMeshAnalytics, mergeMeshDay } from "../src/daemon/mesh-analytics-api"

let tmp: string

beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-mesh-analytics-")) })
afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

function openTmp() { return openDb({ path: path.join(tmp, "db.sqlite") })! }

const DAY = 86_400_000
let seq = 0

function trace(db: Database.Database, o: {
  agent?: string; channel?: string; chat?: string; workflowId?: string
  status?: string; ago?: number; durationMs?: number; out?: number; error?: string
}): string {
  const id = `T${String(++seq).padStart(6, "0")}`
  db.prepare(`
    INSERT INTO task_traces (task_id, agent_id, channel, chat_id, workflow_id, status,
                             started_at, finished_at, duration_ms, output_tokens, error)
    VALUES (@id, @agent, @channel, @chat, @workflowId, @status, @started, @finished, @duration, @out, @error)
  `).run({
    id,
    agent: o.agent ?? "a1",
    channel: o.channel ?? "cron",
    chat: o.chat ?? null,
    workflowId: o.workflowId ?? null,
    status: o.status ?? "ok",
    started: Date.now() - (o.ago ?? 1) * DAY,
    finished: Date.now() - (o.ago ?? 1) * DAY + (o.durationMs ?? 1000),
    duration: o.durationMs ?? 1000,
    out: o.out ?? 100,
    error: o.error ?? null,
  })
  return id
}

describe("classifyCause", () => {
  it("maps real recorded error strings to their class", () => {
    expect(classifyCause("Failed to authenticate. API Error: 401 Invalid authentication credentials")).toBe("auth")
    expect(classifyCause("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)")).toBe("connectivity")
    expect(classifyCause("You've hit your weekly limit · resets Jun 17 at 5am")).toBe("quota")
    expect(classifyCause("Anthropic's API is temporarily overloaded.")).toBe("overload")
    expect(classifyCause("Claude Code timed out after 20m (SIGTERM).")).toBe("timeout")
    expect(classifyCause("persistent claude process error: claude process exited mid-turn")).toBe("crash")
    expect(classifyCause("Claude Code CLI not found on PATH. Install it before starting an agent")).toBe("misconfig")
  })

  it("is total — anything unrecognised or empty lands in other", () => {
    expect(classifyCause("something nobody has seen")).toBe("other")
    expect(classifyCause("")).toBe("other")
    expect(classifyCause(null)).toBe("other")
    expect(classifyCause(undefined)).toBe("other")
  })
})

describe("buildMeshAnalytics", () => {
  it("returns empty-but-shaped output on a fresh database", () => {
    const a = buildMeshAnalytics(openTmp(), { days: 30 })
    expect(a.totals.runs).toBe(0)
    // The day series is still dense — an empty fleet has 31 zeroed columns,
    // not zero columns, so the chart keeps its axis.
    expect(a.days.length).toBeGreaterThanOrEqual(31)
    expect(a.days.every((d) => d.cron[0] + d.cron[1] + d.workflow[0] + d.workflow[1] + d.direct[0] + d.direct[1] === 0)).toBe(true)
    expect(a.jobs).toEqual([])
    expect(a.threads).toEqual([])
    expect(a.rotations.total).toBe(0)
  })

  it("excludes rows outside the window", () => {
    const db = openTmp()
    trace(db, { ago: 2 })
    trace(db, { ago: 40 })
    expect(buildMeshAnalytics(db, { days: 30 }).totals.runs).toBe(1)
    expect(buildMeshAnalytics(db, { days: 90 }).totals.runs).toBe(2)
  })

  it("splits day buckets by origin and counts timeouts as errors", () => {
    const db = openTmp()
    trace(db, { channel: "cron", ago: 1 })
    trace(db, { channel: "cron", ago: 1, status: "timeout", error: "timed out" })
    trace(db, { channel: "workflow", ago: 1, workflowId: "w" })
    trace(db, { channel: "telegram", ago: 1 })
    const a = buildMeshAnalytics(db, { days: 30 })
    const busy = a.days.filter((d) => d.cron[0] + d.cron[1] + d.workflow[0] + d.direct[0] > 0)
    expect(busy).toHaveLength(1)
    expect(busy[0].cron).toEqual([1, 1])
    expect(busy[0].workflow).toEqual([1, 0])
    expect(busy[0].direct).toEqual([1, 0])
    expect(a.totals.errors).toBe(1)
  })

  it("flags a job that succeeds for minutes and returns nothing", () => {
    const db = openTmp()
    for (let i = 0; i < 8; i++) trace(db, { chat: "cron:wiki-absorb", durationMs: 6 * 60_000, out: 2, ago: i + 1 })
    const job = buildMeshAnalytics(db, { days: 30 }).jobs.find((j) => j.label === "wiki-absorb")!
    expect(job.verdict).toBe("zombie")
    expect(job.okRuns).toBe(8)
    expect(job.avgOutput).toBeCloseTo(2, 5)
  })

  it("flags a job that has never once succeeded, and does not call it a zombie", () => {
    const db = openTmp()
    for (let i = 0; i < 6; i++) {
      trace(db, { chat: "cron:youtube", status: "error", error: "ENOTFOUND", out: 0, durationMs: 5 * 60_000, ago: i + 1 })
    }
    const job = buildMeshAnalytics(db, { days: 30 }).jobs.find((j) => j.label === "youtube")!
    expect(job.verdict).toBe("never-succeeded")
    expect(job.okRuns).toBe(0)
  })

  it("does not call a fast, productive job a zombie", () => {
    const db = openTmp()
    for (let i = 0; i < 8; i++) trace(db, { chat: "cron:brief", durationMs: 90_000, out: 1400, ago: i + 1 })
    expect(buildMeshAnalytics(db, { days: 30 }).jobs[0].verdict).toBe("healthy")
  })

  it("averages output over successful runs only", () => {
    const db = openTmp()
    for (let i = 0; i < 5; i++) trace(db, { chat: "cron:mixed", out: 500, ago: i + 1 })
    for (let i = 0; i < 5; i++) trace(db, { chat: "cron:mixed", status: "error", out: 0, error: "boom", ago: i + 1 })
    const job = buildMeshAnalytics(db, { days: 30 }).jobs.find((j) => j.label === "mixed")!
    expect(job.avgOutput).toBeCloseTo(500, 5)
    expect(job.runs).toBe(10)
    expect(job.errors).toBe(5)
  })

  it("orders threads by how long they lived, not how often they ran", () => {
    const db = openTmp()
    // Busy but instantaneous: 20 runs inside one day.
    for (let i = 0; i < 20; i++) trace(db, { agent: "burst", channel: "workflow", chat: "wf:done", ago: 3 })
    // Quiet but long-lived: 2 runs 20 days apart.
    trace(db, { agent: "longlived", channel: "telegram", chat: "c1", ago: 25 })
    trace(db, { agent: "longlived", channel: "telegram", chat: "c1", ago: 1 })
    const threads = buildMeshAnalytics(db, { days: 30 }).threads
    expect(threads[0].agent).toBe("longlived")
  })

  it("returns real cut timestamps, sampled and labelled when they overflow", () => {
    const db = openTmp()
    trace(db, { agent: "a1", channel: "cron", chat: "cron:j", ago: 20 })
    trace(db, { agent: "a1", channel: "cron", chat: "cron:j", ago: 1 })
    const ins = db.prepare(`INSERT INTO rotations (agent_id, channel, chat_id, reason, last_turn_input_tokens, rotated_at)
                            VALUES (?,?,?,?,?,?)`)
    for (let i = 0; i < 120; i++) {
      ins.run("a1", "cron", "cron:j", i % 2 ? "stale" : "tier-2", 1000, new Date(Date.now() - (i + 1) * 3_600_000).toISOString())
    }
    const t = buildMeshAnalytics(db, { days: 30 }).threads[0]
    expect(t.rotations).toBe(120)
    expect(t.cutsShown).toBe(48)
    expect(t.cuts).toHaveLength(48)
    // Every plotted tick is a real recorded timestamp, not an even spread.
    const real = new Set(db.prepare("SELECT rotated_at FROM rotations").all()
      .map((r: any) => Date.parse(r.rotated_at)))
    for (const c of t.cuts) expect(real.has(c.at)).toBe(true)
  })

  it("reports rotation tokens as a sum plus a sample count so merges stay exact", () => {
    const db = openTmp()
    const ins = db.prepare(`INSERT INTO rotations (agent_id, channel, chat_id, reason, last_turn_input_tokens, rotated_at)
                            VALUES (?,?,?,?,?,?)`)
    ins.run("a1", "cron", "c", "tier-2", 100, new Date().toISOString())
    ins.run("a1", "cron", "c", "tier-2", 300, new Date().toISOString())
    ins.run("a1", "cron", "c", "stale", null, new Date().toISOString())
    const r = buildMeshAnalytics(db, { days: 30 }).rotations
    expect(r.total).toBe(3)
    expect(r.tokenSum).toBe(400)
    expect(r.tokenSamples).toBe(2)
    expect(r.maxTokens).toBe(300)
  })

  it("reports how many traces still have steps", () => {
    const db = openTmp()
    const withSteps = trace(db, { ago: 1 })
    trace(db, { ago: 1 })
    db.prepare(`INSERT INTO task_trace_steps (task_id, seq, name, action, status, started_at)
                VALUES (?,0,'tool_use','Bash','ok',?)`).run(withSteps, Date.now())
    const a = buildMeshAnalytics(db, { days: 30 })
    expect(a.retention).toEqual({ traces: 2, tracesWithSteps: 1 })
  })

  it("clamps the window and the row limit rather than trusting the caller", () => {
    const db = openTmp()
    expect(buildMeshAnalytics(db, { days: 9999 }).windowDays).toBe(180)
    expect(buildMeshAnalytics(db, { days: -5 }).windowDays).toBe(0)
  })

  it("days:0 means since local midnight, not the last 24 hours", () => {
    const db = openTmp()
    const tzOffsetMinutes = 0
    const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000
    // 30 minutes before local midnight — yesterday, and must be excluded.
    db.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, status, started_at, duration_ms)
                VALUES ('Y','a','cron','ok',?,1000)`).run(midnight - 30 * 60_000)
    // 30 minutes after local midnight — today.
    db.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, status, started_at, duration_ms)
                VALUES ('N','a','cron','ok',?,1000)`).run(midnight + 30 * 60_000)
    const today = buildMeshAnalytics(db, { days: 0, tzOffsetMinutes })
    expect(today.totals.runs).toBe(1)
    expect(today.days).toHaveLength(1)
    expect(today.days[0].day).toBe(new Date(midnight).toISOString().slice(0, 10))
    // The 24-hour window would have caught both — that is the bug it avoids.
    expect(buildMeshAnalytics(db, { days: 1, tzOffsetMinutes }).totals.runs).toBe(2)
  })
})

describe("mesh drill-down", () => {
  it("lists a job's attempts with a classified cause and no payload", () => {
    const db = openTmp()
    trace(db, { chat: "cron:j", status: "error", error: "API Error: Unable to connect (ENOTFOUND)", ago: 1 })
    trace(db, { chat: "cron:j", ago: 2 })
    const runs = listJobRuns(db, { kind: "cron", key: "j" })
    expect(runs).toHaveLength(2)
    expect(runs[0].cause).toBe("connectivity")
    expect(runs[1].cause).toBeNull()
    expect(Object.keys(runs[0])).not.toContain("error")
  })

  it("lists a thread's attempts newest first", () => {
    const db = openTmp()
    trace(db, { agent: "a", channel: "telegram", chat: "c", ago: 5 })
    trace(db, { agent: "a", channel: "telegram", chat: "c", ago: 1 })
    const runs = listThreadRuns(db, { agent: "a", channel: "telegram", chatId: "c" })
    expect(runs).toHaveLength(2)
    expect(runs[0].startedAt).toBeGreaterThan(runs[1].startedAt)
  })

  it("summarises what a run touched from tool names alone", () => {
    const db = openTmp()
    const id = trace(db, { ago: 1 })
    const step = db.prepare(`INSERT INTO task_trace_steps (task_id, seq, name, action, status, ms, started_at)
                             VALUES (?,?,?,?,?,?,?)`)
    step.run(id, 0, "tool_use", "Bash", "in-flight", 10, Date.now())
    step.run(id, 1, "tool_result", null, "error", 5, Date.now())
    step.run(id, 2, "tool_use", "Write", "in-flight", 10, Date.now())
    step.run(id, 3, "tool_use", "Read", "in-flight", 10, Date.now())
    const shape = getRunShape(db, id)
    expect(shape.found).toBe(true)
    expect(shape.writes).toBe(1)
    expect(shape.reads).toBe(2)
    expect(shape.sends).toBe(0)
    expect(shape.tools.find((t) => t.tool === "Bash")).toEqual({ tool: "Bash", used: 1, failed: 1 })
    expect(shape.stepsPruned).toBe(false)
  })

  it("says so when a trace exists but its steps were pruned", () => {
    const db = openTmp()
    const id = trace(db, { ago: 1 })
    const shape = getRunShape(db, id)
    expect(shape.found).toBe(true)
    expect(shape.stepsPruned).toBe(true)
    expect(shape.steps).toEqual([])
  })

  it("reports a missing task as not found instead of throwing", () => {
    expect(getRunShape(openTmp(), "nope").found).toBe(false)
  })
})

describe("mergeMeshAnalytics", () => {
  const node = (name: string) => ({ name, url: `http://${name}` })

  function payload(over: Partial<any> = {}): any {
    return {
      generatedAt: 1, windowDays: 30, since: 0,
      totals: { runs: 10, errors: 2, hours: 1.5, agents: 2, threads: 3 },
      days: [{ day: "2026-08-01", cron: [4, 1], workflow: [0, 0], direct: [5, 1] }],
      origins: [{ channel: "cron", runs: 5, errors: 1, hours: 1 }],
      causes: [{ cause: "auth", count: 2, agents: ["a1"], example: "401" }],
      jobs: [{ key: "cron:j", label: "j", kind: "cron", agent: "a1", runs: 5, errors: 1, okRuns: 4, hours: 1, avgMinutes: 12, avgOutput: 3, lastAt: 1, verdict: "zombie" }],
      threads: [{ key: "k", agent: "a1", channel: "cron", chatId: "c", runs: 5, errors: 1, firstAt: 0, lastAt: 100, hours: 1, rotations: 0, rotationReasons: [], cuts: [], cutsShown: 0 }],
      rotations: { total: 4, byReason: [{ reason: "stale", count: 4 }], tokenSum: 400, tokenSamples: 2, maxTokens: 300 },
      retention: { traces: 10, tracesWithSteps: 4 },
      ...over,
    }
  }

  it("sums fleet-wide aggregates and attributes actionable rows to their node", () => {
    const m = mergeMeshAnalytics([
      { node: node("n1"), data: payload() },
      { node: node("n2"), data: payload() },
    ], 30)
    expect(m.totals.runs).toBe(20)
    expect(m.days[0].cron).toEqual([8, 2])
    expect(m.origins[0]).toEqual({ channel: "cron", runs: 10, errors: 2, hours: 2 })
    expect(m.causes[0].count).toBe(4)
    expect(m.jobs.map((j) => j.node)).toEqual(["n1", "n2"])
    expect(m.threads.map((t) => t.node)).toEqual(["n1", "n2"])
  })

  it("keeps rotation token stats exact across nodes", () => {
    const m = mergeMeshAnalytics([
      { node: node("n1"), data: payload() },
      { node: node("n2"), data: payload({ rotations: { total: 1, byReason: [{ reason: "tier-2", count: 1 }], tokenSum: 800, tokenSamples: 1, maxTokens: 800 } }) },
    ], 30)
    expect(m.rotations.total).toBe(5)
    expect(m.rotations.tokenSum).toBe(1200)
    expect(m.rotations.tokenSamples).toBe(3)
    expect(m.rotations.maxTokens).toBe(800)
    expect(m.rotations.byReason.map((r) => r.reason).sort()).toEqual(["stale", "tier-2"])
  })

  it("carries the real window start rather than making the client derive it", () => {
    const m = mergeMeshAnalytics([
      { node: node("n1"), data: payload({ since: 5000 }) },
      { node: node("n2"), data: payload({ since: 7000 }) },
    ], 30)
    expect(m.since).toBe(5000)
  })

  it("reports an unreachable node instead of dropping it", () => {
    const m = mergeMeshAnalytics([
      { node: node("n1"), data: payload() },
      { node: node("down"), error: "timeout" },
    ], 30)
    expect(m.nodes).toHaveLength(2)
    expect(m.nodes[1]).toEqual({ name: "down", url: "http://down", ok: false, error: "timeout", runs: 0 })
    expect(m.totals.runs).toBe(10)
  })

  it("orders merged threads by lifespan, matching each node's own ordering", () => {
    const short = payload({ threads: [{ ...payload().threads[0], key: "short", firstAt: 0, lastAt: 10, runs: 900 }] })
    const long = payload({ threads: [{ ...payload().threads[0], key: "long", firstAt: 0, lastAt: 9999, runs: 2 }] })
    const m = mergeMeshAnalytics([{ node: node("n1"), data: short }, { node: node("n2"), data: long }], 30)
    expect(m.threads[0].key).toBe("long")
  })
})

describe("day keys", () => {
  it("covers every local day in the range, inclusive of both ends", () => {
    const tz = 60 * 60_000
    const from = Date.parse("2026-08-01T10:00:00Z")
    const to = Date.parse("2026-08-04T10:00:00Z")
    expect(dayKeysBetween(from, to, tz)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"])
  })

  it("shifts the day boundary by the caller's offset, not the host's", () => {
    // 00:30 UTC on the 2nd is still the 1st for a caller at UTC-2.
    const at = Date.parse("2026-08-02T00:30:00Z")
    expect(dayKeysBetween(at, at, -120 * 60_000)).toEqual(["2026-08-01"])
    expect(dayKeysBetween(at, at, 0)).toEqual(["2026-08-02"])
  })

  it("round-trips against dayBounds", () => {
    const tz = 60 * 60_000
    const { start, end } = dayBounds("2026-08-15", tz)
    expect(dayKeysBetween(start, start, tz)).toEqual(["2026-08-15"])
    expect(dayKeysBetween(end - 1, end - 1, tz)).toEqual(["2026-08-15"])
    expect(dayKeysBetween(end, end, tz)).toEqual(["2026-08-16"])
  })
})

describe("dense day series", () => {
  it("emits a column for every day in the window, including empty ones and today", () => {
    const db = openTmp()
    trace(db, { ago: 5 })
    const a = buildMeshAnalytics(db, { days: 7, tzOffsetMinutes: 0 })
    // 7 days back plus today, inclusive.
    expect(a.days.length).toBeGreaterThanOrEqual(8)
    const today = new Date().toISOString().slice(0, 10)
    expect(a.days[a.days.length - 1].day).toBe(today)
    // Days with no runs are present and zeroed, not missing.
    const empty = a.days.filter((d) => d.cron[0] + d.cron[1] + d.direct[0] + d.direct[1] + d.workflow[0] + d.workflow[1] === 0)
    expect(empty.length).toBeGreaterThan(0)
  })

  it("keeps the series sorted and gap-free", () => {
    const db = openTmp()
    trace(db, { ago: 1 })
    trace(db, { ago: 6 })
    const days = buildMeshAnalytics(db, { days: 10, tzOffsetMinutes: 0 }).days.map((d) => d.day)
    for (let i = 1; i < days.length; i++) {
      const gap = (Date.parse(days[i]) - Date.parse(days[i - 1])) / 86_400_000
      expect(gap).toBe(1)
    }
  })
})

describe("getDayActivity", () => {
  it("counts only the runs inside that local day", () => {
    const db = openTmp()
    const today = new Date().toISOString().slice(0, 10)
    trace(db, { ago: 0, out: 40 })
    trace(db, { ago: 0, status: "error", error: "ENOTFOUND", out: 0 })
    trace(db, { ago: 3 })
    const d = getDayActivity(db, { day: today, tzOffsetMinutes: 0 })
    expect(d.totals.runs).toBe(2)
    expect(d.totals.errors).toBe(1)
    expect(d.totals.outputTokens).toBe(40)
    expect(d.causes).toEqual([{ cause: "connectivity", count: 1 }])
  })

  it("groups the day's work into conversations ordered by runtime", () => {
    const db = openTmp()
    const today = new Date().toISOString().slice(0, 10)
    trace(db, { agent: "a", channel: "cron", chat: "quick", ago: 0, durationMs: 1_000 })
    trace(db, { agent: "b", channel: "cron", chat: "slow", ago: 0, durationMs: 60_000 })
    trace(db, { agent: "b", channel: "cron", chat: "slow", ago: 0, durationMs: 60_000 })
    const convs = getDayActivity(db, { day: today, tzOffsetMinutes: 0 }).conversations
    expect(convs[0].chatId).toBe("slow")
    expect(convs[0].turns).toBe(2)
    expect(convs[0].ms).toBe(120_000)
  })

  it("returns an empty-but-shaped day when nothing ran", () => {
    const d = getDayActivity(openTmp(), { day: "2020-01-01", tzOffsetMinutes: 0 })
    expect(d.totals.runs).toBe(0)
    expect(d.conversations).toEqual([])
    expect(d.origins).toEqual([])
  })
})

describe("getConversationSummary", () => {
  it("summarises turns, timing and tokens over all history", () => {
    const db = openTmp()
    for (let i = 0; i < 4; i++) {
      trace(db, { agent: "a", channel: "telegram", chat: "c", ago: i + 1, durationMs: 2_000, out: 50 })
    }
    trace(db, { agent: "a", channel: "telegram", chat: "c", ago: 40, durationMs: 10_000, status: "error", error: "401 authenticate", out: 0 })
    const s = getConversationSummary(db, { agent: "a", channel: "telegram", chatId: "c" })
    expect(s.found).toBe(true)
    expect(s.turns).toBe(5)
    expect(s.ok).toBe(4)
    expect(s.errors).toBe(1)
    expect(s.totalMs).toBe(18_000)
    expect(s.avgMs).toBe(3_600)
    expect(s.maxMs).toBe(10_000)
    expect(s.outputTokens).toBe(200)
    expect(s.causes).toEqual([{ cause: "auth", count: 1 }])
    expect(s.activeDays).toBe(5)
    expect(s.spanDays).toBeGreaterThanOrEqual(40)
  })

  it("counts tool usage only over the turns whose steps survived", () => {
    const db = openTmp()
    const withSteps = trace(db, { agent: "a", channel: "cron", chat: "c", ago: 1 })
    trace(db, { agent: "a", channel: "cron", chat: "c", ago: 2 })
    const step = db.prepare(`INSERT INTO task_trace_steps (task_id, seq, name, action, status, started_at)
                             VALUES (?,?,?,?,?,?)`)
    step.run(withSteps, 0, "tool_use", "Bash", "in-flight", Date.now())
    step.run(withSteps, 1, "tool_use", "Bash", "in-flight", Date.now())
    step.run(withSteps, 2, "tool_use", "Read", "in-flight", Date.now())
    const s = getConversationSummary(db, { agent: "a", channel: "cron", chatId: "c" })
    expect(s.turns).toBe(2)
    expect(s.toolRunsCounted).toBe(1)
    expect(s.tools).toEqual([{ tool: "Bash", used: 2 }, { tool: "Read", used: 1 }])
  })

  it("does not leak another conversation's turns into this one", () => {
    const db = openTmp()
    trace(db, { agent: "a", channel: "cron", chat: "mine", ago: 1 })
    trace(db, { agent: "a", channel: "cron", chat: "theirs", ago: 1 })
    trace(db, { agent: "b", channel: "cron", chat: "mine", ago: 1 })
    expect(getConversationSummary(db, { agent: "a", channel: "cron", chatId: "mine" }).turns).toBe(1)
  })

  it("reports not-found rather than throwing on an unknown conversation", () => {
    const s = getConversationSummary(openTmp(), { agent: "nope", channel: "x", chatId: "y" })
    expect(s.found).toBe(false)
    expect(s.turns).toBe(0)
  })
})

describe("mergeMeshDay", () => {
  const node = (name: string) => ({ name, url: `http://${name}` })
  const day = (over: any = {}): any => ({
    day: "2026-08-28",
    totals: { runs: 5, errors: 1, ms: 1000, inputTokens: 10, outputTokens: 20 },
    origins: [{ channel: "cron", runs: 5, errors: 1, ms: 1000 }],
    causes: [{ cause: "auth", count: 1 }],
    conversations: [{ key: "k", agent: "a", channel: "cron", chatId: "c", turns: 5, errors: 1, ms: 1000, inputTokens: 10, outputTokens: 20, firstAt: 1, lastAt: 2 }],
    ...over,
  })

  it("sums a day across nodes and keeps conversations attributed", () => {
    const m = mergeMeshDay([{ node: node("n1"), data: day() }, { node: node("n2"), data: day() }], "2026-08-28")
    expect(m.totals.runs).toBe(10)
    expect(m.totals.outputTokens).toBe(40)
    expect(m.origins[0].runs).toBe(10)
    expect(m.causes[0]).toEqual({ cause: "auth", count: 2 })
    expect(m.conversations.map((c) => c.node)).toEqual(["n1", "n2"])
  })

  it("surfaces an unreachable node so partial totals are visible", () => {
    const m = mergeMeshDay([{ node: node("n1"), data: day() }, { node: node("down"), error: "timeout" }], "2026-08-28")
    expect(m.totals.runs).toBe(5)
    expect(m.nodes.find((n) => !n.ok)).toMatchObject({ name: "down", error: "timeout" })
  })
})
