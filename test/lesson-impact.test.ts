import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite.js"
import { recordTraceStart, recordTraceEnd, recordTraceStep, getTrace, type InjectedContext } from "../src/storage/traces.js"
import { lessonImpact, loadTaskSamples, type TaskSample } from "../src/storage/lesson-impact.js"
import { injectedContextOf, MAX_INJECTED_IDS } from "../src/agents/injected-context.js"
import { MemoryStore, type MemoryFact } from "../src/agents/memory-store.js"
import { change, renderLessonImpact } from "../src/commands/trace-lessons.js"

const DAY = 86_400_000

function freshDb(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), "agentx-98-")), "db.sqlite")
  return openDb({ path, quiet: true })!
}

function sample(p: Partial<TaskSample> & { startedAt: number }): TaskSample {
  return {
    taskId: `t${p.startedAt}`,
    agentId: "helper",
    cluster: "telegram:send-weekly-report:email",
    ok: true,
    tokens: 1000,
    turns: 5,
    durationMs: 10_000,
    injected: { memory: [], procedures: [], wiki: false },
    ...p,
  }
}

describe("injectedContextOf", () => {
  it("records only lessons whose text reached the assembled prompt", () => {
    const assembled = [
      "[Institutional Wiki — the single source of truth]",
      "[Known procedure: Send the weekly report]",
      "- [fact] Reports go out on Mondays (DM, 2026-01-01)",
    ].join("\n")
    const ctx = injectedContextOf(assembled, {
      memory: [
        { id: "m1", content: "Reports go out on Mondays" },
        { id: "m2", content: "Cut by the layer budget" },
      ],
      procedures: [
        { id: "p1", title: "Send the weekly report" },
        { id: "p2", title: "Dropped by the request selector" },
      ],
      wikiContext: "[Institutional Wiki — the single source of truth]",
    })
    expect(ctx).toEqual({ memory: ["m1"], procedures: ["p1"], wiki: true })
  })

  it("says no wiki when the catalog was not offered or was dropped", () => {
    expect(injectedContextOf("[Institutional Wiki", {}).wiki).toBe(false)
    expect(injectedContextOf("", { wikiContext: "[Institutional Wiki" }).wiki).toBe(false)
  })

  it("caps and de-duplicates ids", () => {
    const memory = Array.from({ length: 50 }, (_, i) => ({ id: `m${i % 30}`, content: "same" }))
    const ctx = injectedContextOf("same", { memory })
    expect(ctx.memory).toHaveLength(MAX_INJECTED_IDS)
    expect(new Set(ctx.memory).size).toBe(MAX_INJECTED_IDS)
  })
})

describe("MemoryStore.contextFacts", () => {
  it("returns exactly the facts buildContext renders", () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), "agentx-98-mem-")))
    const facts: MemoryFact[] = Array.from({ length: 40 }, (_, i) => ({
      id: `f${i}`,
      agentId: "helper",
      category: "fact",
      content: `Fact number ${i} ${"x".repeat(80)}`,
      keywords: [],
      source: { channel: "telegram", chatId: "100", sender: "someone", date: "2026-01-01" },
      createdAt: "2026-01-01T00:00:00Z",
    }))
    const rendered = store.buildContext(facts)
    const kept = store.contextFacts(facts)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(facts.length)
    for (const f of kept) expect(rendered).toContain(f.content)
    for (const f of facts.slice(kept.length)) expect(rendered).not.toContain(f.content)
    expect(store.buildContext([])).toBe("")
  })
})

describe("trace rows", () => {
  afterEach(() => closeDb())

  it("store turns and injected lessons, bounded", () => {
    const db = freshDb()
    const id = recordTraceStart(db, { agentId: "helper", channel: "telegram", chatId: "1", originalMessage: "hi" })
    const many = Array.from({ length: 60 }, (_, i) => `m${i}`)
    recordTraceEnd(db, id, {
      status: "ok",
      numTurns: 7,
      injectedContext: { memory: many, procedures: ["p1"], wiki: true },
    })
    const t = getTrace(db, id)!.task
    expect(t.numTurns).toBe(7)
    expect(t.injectedContext?.memory).toHaveLength(MAX_INJECTED_IDS)
    expect(t.injectedContext?.procedures).toEqual(["p1"])
    expect(t.injectedContext?.wiki).toBe(true)
  })

  it("are filled from task:completed", async () => {
    const { attachSqliteSubscribers } = await import("../src/storage/subscribers")
    const { getEventBus } = await import("../src/events/bus")
    const db = freshDb()
    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      const at = new Date().toISOString()
      bus.emit("task:started", { agentId: "helper", channel: "telegram", chatId: "c1", messagePreview: "hi", at })
      bus.emit("task:completed", {
        agentId: "helper",
        channel: "telegram",
        chatId: "c1",
        durationMs: 5,
        numTurns: 4,
        injectedContext: { memory: ["m1"], procedures: [], wiki: true },
        at,
      })
      const [row] = loadTaskSamples(db)
      expect(row.turns).toBe(4)
      expect(row.injected).toEqual({ memory: ["m1"], procedures: [], wiki: true })
    } finally {
      dispose()
    }
  })

  it("read as no injected context when nothing was recorded", () => {
    const db = freshDb()
    const id = recordTraceStart(db, { agentId: "helper" })
    recordTraceEnd(db, id, { status: "ok" })
    const t = getTrace(db, id)!.task
    expect(t.injectedContext).toBeNull()
    expect(t.numTurns).toBeNull()
  })
})

describe("lessonImpact", () => {
  const withMemory: InjectedContext = { memory: ["m1"], procedures: [], wiki: false }

  it("compares tasks before the lesson with tasks that received it", () => {
    const samples = [
      sample({ startedAt: 1 * DAY, ok: false, tokens: 3000, turns: 9 }),
      sample({ startedAt: 2 * DAY, ok: true, tokens: 2000, turns: 7 }),
      sample({ startedAt: 3 * DAY, injected: withMemory, tokens: 1000, turns: 4 }),
      sample({ startedAt: 4 * DAY, injected: withMemory, tokens: 1200, turns: 4 }),
      sample({ startedAt: 5 * DAY, injected: withMemory, tokens: 800, turns: 2 }),
    ]
    const [row, ...rest] = lessonImpact(samples)
    expect(rest).toHaveLength(0)
    expect(row.lesson).toBe("memory:m1")
    expect(row.addedAt).toBe(3 * DAY)
    expect(row.before).toMatchObject({ n: 2, successRate: 0.5, medianTokens: 2500, medianTurns: 8 })
    expect(row.after).toMatchObject({ n: 3, successRate: 1, medianTokens: 1000, medianTurns: 4 })
  })

  it("never counts unrecorded tasks as before", () => {
    const samples = [
      sample({ startedAt: 1 * DAY, injected: null }),
      sample({ startedAt: 2 * DAY, injected: null }),
      sample({ startedAt: 3 * DAY, injected: withMemory }),
      sample({ startedAt: 4 * DAY, injected: withMemory }),
    ]
    expect(lessonImpact(samples)).toEqual([])
    expect(lessonImpact(samples, { minSamples: 1 })).toEqual([])
  })

  it("dates a lesson from its first use by the same agent, not another agent", () => {
    const samples = [
      sample({ agentId: "other", cluster: "x", startedAt: 0, injected: { memory: [], procedures: ["p1"], wiki: false } }),
      sample({ startedAt: 1 * DAY }),
      sample({ startedAt: 2 * DAY }),
      sample({ startedAt: 3 * DAY, injected: { memory: [], procedures: ["p1"], wiki: false } }),
      sample({ startedAt: 4 * DAY, injected: { memory: [], procedures: ["p1"], wiki: false } }),
    ]
    const rows = lessonImpact(samples)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agentId: "helper", lesson: "procedure:p1", addedAt: 3 * DAY })
    expect(rows[0].before.n).toBe(2)
  })

  it("reports the wiki catalog as a lesson and respects minSamples", () => {
    const wiki: InjectedContext = { memory: [], procedures: [], wiki: true }
    const samples = [
      sample({ startedAt: 1 * DAY }),
      sample({ startedAt: 2 * DAY, injected: wiki }),
    ]
    expect(lessonImpact(samples)).toEqual([])
    const rows = lessonImpact(samples, { minSamples: 1 })
    expect(rows.map((r) => r.lesson)).toEqual(["wiki"])
  })
})

describe("loadTaskSamples", () => {
  afterEach(() => closeDb())

  function task(db: Database.Database, at: number, opts: { tools: string[]; injected?: InjectedContext; ok?: boolean }) {
    const id = recordTraceStart(db, { agentId: "helper", channel: "telegram", chatId: "1", originalMessage: "Send the June report to the team" })
    for (const tool of opts.tools) recordTraceStep(db, id, { name: "tool_use", action: tool })
    recordTraceEnd(db, id, {
      status: opts.ok === false ? "error" : "ok",
      inputTokens: 100,
      outputTokens: 50,
      numTurns: 3,
      injectedContext: opts.injected,
      error: opts.ok === false ? "failed" : null,
    })
    db.prepare("UPDATE task_traces SET started_at = ? WHERE task_id = ?").run(at, id)
    return id
  }

  it("groups repeated tasks with the miner's cluster key", () => {
    const db = freshDb()
    task(db, 1 * DAY, { tools: ["Bash", "mcp__gmail__send"], injected: { memory: [], procedures: [], wiki: false } })
    task(db, 2 * DAY, { tools: ["Bash", "mcp__gmail__send"], injected: { memory: [], procedures: [], wiki: false }, ok: false })
    task(db, 3 * DAY, { tools: ["Bash", "Bash", "mcp__gmail__send"], injected: { memory: ["m1"], procedures: [], wiki: false } })
    task(db, 4 * DAY, { tools: ["Bash", "mcp__gmail__send"], injected: { memory: ["m1"], procedures: [], wiki: false } })
    const samples = loadTaskSamples(db)
    expect(samples).toHaveLength(4)
    expect(new Set(samples.map((s) => s.cluster)).size).toBe(1)
    expect(samples[0]).toMatchObject({ tokens: 150, turns: 3, ok: true })
    const rows = lessonImpact(samples)
    expect(rows).toHaveLength(1)
    expect(rows[0].before).toMatchObject({ n: 2, successRate: 0.5 })
    expect(rows[0].after).toMatchObject({ n: 2, successRate: 1 })
    expect(loadTaskSamples(db, { since: 3 * DAY })).toHaveLength(2)
    expect(loadTaskSamples(db, { agentId: "nobody" })).toHaveLength(0)
  })

  it("reads a database that predates the lesson columns", () => {
    const db = freshDb()
    task(db, 1 * DAY, { tools: [] })
    db.exec("ALTER TABLE task_traces DROP COLUMN num_turns; ALTER TABLE task_traces DROP COLUMN injected_context;")
    const [s] = loadTaskSamples(db)
    expect(s.injected).toBeNull()
    expect(s.turns).toBeNull()
  })
})

describe("renderLessonImpact", () => {
  it("shows sample sizes and changes", () => {
    const lines = renderLessonImpact(
      lessonImpact([
        sample({ startedAt: 1 * DAY, tokens: 2000 }),
        sample({ startedAt: 2 * DAY, tokens: 2000 }),
        sample({ startedAt: 3 * DAY, tokens: 1000, injected: { memory: ["m1"], procedures: [], wiki: false } }),
        sample({ startedAt: 4 * DAY, tokens: 1000, injected: { memory: ["m1"], procedures: [], wiki: false } }),
      ]),
      { minSamples: 2 },
    ).join("\n")
    expect(lines).toContain("memory:m1")
    expect(lines).toContain("n=2")
    expect(lines).toContain("(-50%)")
  })

  it("explains an empty report", () => {
    expect(renderLessonImpact([], { minSamples: 2 }).join("\n")).toContain("at least 2")
  })

  it("formats changes", () => {
    expect(change(100, 80)).toBe(" (-20%)")
    expect(change(100, 120)).toBe(" (+20%)")
    expect(change(100, 100)).toBe(" (=)")
    expect(change(null, 5)).toBe("")
  })
})
