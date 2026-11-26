import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { MemoryStore } from "../src/agents/memory-store"
import { listRuns, MAX_BACKUPS, MAX_RUNS, recordRun, showRun, undoRun } from "../src/improve/tidy"

// #2117 PR 1: a fact cleanup leaves a run log, so every fact it drops or
// merges can be listed and put back.

let tmp: string
let store: MemoryStore
const DAY = 86_400_000
const NOW = Date.parse("2026-11-26T12:00:00Z")

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-memory-tidy-"))
  store = new MemoryStore(tmp)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const src = { channel: "dashboard", chatId: "c", sender: "s", date: "2026-11-01" }
const add = (content: string, extra: Record<string, unknown> = {}) =>
  store.addMemory("a", { agentId: "a", category: "fact", content, keywords: [content], source: src, ...extra } as any)
const contents = () => store.getAll("a").map((f) => f.content)

describe("prune keeps history", () => {
  it("logs each dropped fact, backs up first, and keeps unreadable lines", () => {
    add("stays")
    add("old task", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    appendFileSync(store.fileFor("a"), "{not json\n")

    const run = store.prune("a", NOW)!
    expect(contents()).toEqual(["stays"])
    expect(readFileSync(store.fileFor("a"), "utf-8")).toContain("{not json")
    expect(run.by).toBe("prune")
    expect(run.changes).toHaveLength(1)
    expect(run.changes[0]).toMatchObject({ n: 1, store: "fact", action: "drop", reason: "expired", after: null })
    expect(run.changes[0].before[0].content).toBe("old task")
    expect(readFileSync(run.backup!, "utf-8")).toContain("old task")
    expect(showRun(store, run.runId)).toEqual(run)
    expect(listRuns(store, "a").map((r) => r.runId)).toEqual([run.runId])
  })

  it("logs facts dropped over the cap", () => {
    for (let i = 0; i < 202; i++) add(`fact ${i}`)
    const run = store.prune("a", NOW)!
    expect(run.changes.map((c) => [c.reason, c.before[0].content])).toEqual([
      ["over-cap", "fact 0"], ["over-cap", "fact 1"],
    ])
    expect(store.getAll("a")).toHaveLength(200)
  })

  it("leaves the file and the log alone when nothing is dropped", () => {
    add("stays")
    const before = readFileSync(store.fileFor("a"), "utf-8")
    expect(store.prune("a", NOW)).toBeNull()
    expect(readFileSync(store.fileFor("a"), "utf-8")).toBe(before)
    expect(listRuns(store)).toEqual([])
  })
})

describe("undo", () => {
  it("puts a dropped fact back once, under its own id", () => {
    add("stays")
    add("old task", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    const id = store.getAll("a")[1].id
    const run = store.prune("a", NOW)!

    expect(undoRun(store, run.runId, { now: NOW })).toEqual({ runId: run.runId, restored: [1], skipped: [] })
    expect(store.getAll("a").map((f) => f.id)).toContain(id)
    expect(contents()).toEqual(["stays", "old task"])
    expect(showRun(store, run.runId)!.changes[0].undoneAt).toBeDefined()

    const again = undoRun(store, run.runId)
    expect(again.restored).toEqual([])
    expect(again.skipped).toEqual([{ n: 1, why: "already undone" }])
    expect(contents()).toEqual(["stays", "old task"])
  })

  it("undoes a merge, and skips it when the kept fact changed since", () => {
    add("deploys on friday")
    add("deploys happen friday")
    const [older, newer] = store.getAll("a")
    // A merge as the nightly tidy will log it: the newest is kept.
    const run = recordRun(store, "a", "tidy",
      [{ store: "fact", action: "merge", reason: "duplicate", before: [older, newer], after: newer }])
    store.rewrite("a", [newer])

    // The kept fact is edited after the tidy: undo leaves it alone.
    store.review("a", newer.id, "approved")
    expect(undoRun(store, run.runId).skipped).toEqual([{ n: 1, why: "the kept fact changed after the tidy" }])
    expect(contents()).toEqual(["deploys happen friday"])

    // --force puts both originals back, the kept one as it was.
    expect(undoRun(store, run.runId, { force: true }).restored).toEqual([1])
    const facts = store.getAll("a")
    expect(facts.map((f) => f.id).sort()).toEqual([older.id, newer.id].sort())
    expect(facts.find((f) => f.id === newer.id)!.review).toBeUndefined()
  })

  it("undoes one change of a run with --change", () => {
    add("t1", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    add("t2", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    const run = store.prune("a", NOW)!
    expect(undoRun(store, run.runId, { change: 2 }).restored).toEqual([2])
    expect(contents()).toEqual(["t2"])
    expect(() => undoRun(store, run.runId, { change: 9 })).toThrow(/no change 9/)
  })

  it("refuses an unknown or unsafe run id", () => {
    expect(showRun(store, "../a")).toBeNull()
    expect(() => undoRun(store, "nope")).toThrow(/no tidy run/)
  })
})

describe("history is bounded", () => {
  it("keeps at most MAX_BACKUPS prune backups per agent", () => {
    for (let i = 0; i <= MAX_BACKUPS + 2; i++) {
      add(`t${i}`, { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
      store.prune("a", NOW + i * 1000)
    }
    const dir = path.join(store.memoryRoot(), "_backup")
    expect(readdirSync(dir).filter((f) => f.startsWith("a.prune."))).toHaveLength(MAX_BACKUPS)
  })

  it("keeps at most MAX_RUNS run logs, dropping the oldest", () => {
    const first = recordRun(store, "a", "prune", [], { at: "2026-01-01T00:00:00.000Z" })
    for (let i = 0; i < MAX_RUNS; i++) {
      recordRun(store, "a", "prune", [], { at: new Date(NOW + i * 1000).toISOString() })
    }
    expect(readdirSync(path.join(store.memoryRoot(), "_tidy"))).toHaveLength(MAX_RUNS)
    expect(existsSync(path.join(store.memoryRoot(), "_tidy", `${first.runId}.json`))).toBe(false)
  })
})
