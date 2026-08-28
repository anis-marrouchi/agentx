import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { buildMeshAnalytics, classifyCause } from "../src/storage/mesh-analytics"
import { listJobRuns, listThreadRuns, getRunShape } from "../src/storage/mesh-drill"
import { mergeMeshAnalytics } from "../src/daemon/mesh-analytics-api"

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
    expect(a.days).toEqual([])
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
    expect(a.days).toHaveLength(1)
    expect(a.days[0].cron).toEqual([1, 1])
    expect(a.days[0].workflow).toEqual([1, 0])
    expect(a.days[0].direct).toEqual([1, 0])
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
    expect(buildMeshAnalytics(db, { days: -5 }).windowDays).toBe(1)
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
