import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { MemoryStore } from "../src/agents/memory-store"
import { AgentMemory } from "../src/agents/agent-memory"
import { storeRotationMemo } from "../src/agents/rotation-memo-store"
import { improveConfigSchema } from "../src/daemon/config"
import { decide, listInbox } from "../src/approvals/inbox"
import { undoTidyRoute } from "../src/daemon/approvals-panel"
import { listRuns, recordRun, showRun, trimAllRuns, RUN_KEEP_DAYS } from "../src/improve/tidy"
import { tidyStage } from "../src/improve/tidy-stage"
import {
  keptShare, recordKept, runDetail, runsToReview, tidyRunIdOf, TIDY_DETAIL_LINES, TIDY_KEPT_NUMBER, TIDY_REVIEW_DAYS,
} from "../src/improve/tidy-review"
import { NumberStore } from "../src/numbers/store"
import { extractMemories } from "../src/agents/memory-extract"

// memory-extract asks a model for the facts; here it answers two, offline.
vi.mock("../src/agent/providers", () => ({
  createProvider: () => ({
    generate: async () => ({ content: JSON.stringify([
      { category: "fact", content: "The client deploys on fridays", keywords: [] },
      { category: "fact", content: "The invoices go out monthly", keywords: [] },
    ]) }),
  }),
}))

// #2117 PR 3: a nightly tidy run waits in the Approvals inbox (yes keeps,
// no undoes), the Hub undo route, the `memory-tidy-kept` number, and
// pm's review conditions C1–C4 on PR 2.

let tmp: string
let store: MemoryStore
let notes: AgentMemory
const DAY = 86_400_000
const NOW = Date.parse("2026-11-26T12:00:00Z")

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-tidy-review-"))
  store = new MemoryStore(tmp, { lockWaitMs: 200 })
  notes = new AgentMemory({ baseDir: path.join(tmp, ".agentx") })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const settings = () => improveConfigSchema.parse({ enabled: false, tidy: { enabled: true } })
const src = { channel: "dashboard", chatId: "c", sender: "s", date: "2026-11-01" }
const add = (content: string, extra: Record<string, unknown> = {}) =>
  store.addMemory("a", { agentId: "a", category: "fact", content, keywords: [], source: src, ...extra } as any)
const contents = () => store.getAll("a").map((f) => f.content)
const ctx = (now = NOW) => ({ root: tmp, now, reload: false })

/** One committed tidy run for agent "a" that dropped one expired fact. */
async function oneRun(now = NOW): Promise<string> {
  add("stays")
  add("old task", { category: "task-state", expiresAt: new Date(now - DAY).toISOString() })
  const r = await tidyStage({ store, notes, settings: settings(), commit: true, now })
  return r.agents[0].runId!
}

describe("the tidy run's approvals item", () => {
  it("lists one memory item per run, with every change and the C2 note", async () => {
    const runId = await oneRun()
    const items = listInbox(ctx(), { kinds: ["memory"] }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: `memory:a/tidy-${runId}`, kind: "memory", raised_by: "a", if_silent: "keep",
      title: "Memory tidy for a: 1 change", more: `agentx memory tidy show ${runId}`,
      expires: new Date(NOW + TIDY_REVIEW_DAYS * DAY).toISOString(),
    })
    expect(items[0].detail).toContain("1. fact drop (expired): old task")
    expect(tidyRunIdOf(`a/tidy-${runId}`)).toBe(runId)
    expect(tidyRunIdOf("a/m-123")).toBeNull()
  })

  it("yes keeps the changes, records the answer and takes the item off the list", async () => {
    const runId = await oneRun()
    const r = await decide(ctx(), `memory:a/tidy-${runId}`, "yes", { by: "anis" })
    expect(r).toMatchObject({ ok: true })
    expect(contents()).toEqual(["stays"])
    expect(showRun(store, runId)!.review).toMatchObject({ answer: "yes", by: "anis" })
    expect(listInbox(ctx(), { kinds: ["memory"] }).items).toEqual([])
    expect(await decide(ctx(), `memory:a/tidy-${runId}`, "no")).toMatchObject({ ok: false })
  })

  it("no undoes the whole run", async () => {
    const runId = await oneRun()
    const r = await decide(ctx(), `memory:a/tidy-${runId}`, "no")
    expect(r).toMatchObject({ ok: true })
    expect(contents()).toEqual(["stays", "old task"])
    const run = showRun(store, runId)!
    expect(run.review?.answer).toBe("no")
    expect(run.changes[0].undoneAt).toBeDefined()
    expect(runsToReview(store, NOW)).toEqual([])
  })

  it("leaves after TIDY_REVIEW_DAYS, and is never made for a prune run or a fully undone run", async () => {
    const runId = await oneRun()
    expect(listInbox(ctx(NOW + TIDY_REVIEW_DAYS * DAY), { kinds: ["memory"] }).items).toEqual([])
    undoTidyRoute(ctx(), runId, {})
    expect(runsToReview(store, NOW)).toEqual([])
    add("old", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    expect(store.prune("a", NOW)).not.toBeNull()
    expect(runsToReview(store, NOW)).toEqual([])
  })

  it("refuses a run id that is not waiting", async () => {
    expect(await decide(ctx(), "memory:a/tidy-nope", "yes")).toMatchObject({ ok: false })
  })

  it("lists nothing and makes no folder when there are no run logs", () => {
    expect(listInbox(ctx(), { kinds: ["memory"] }).items).toEqual([])
  })

  it("caps the detail at TIDY_DETAIL_LINES and points at the CLI for the rest", () => {
    const facts = Array.from({ length: TIDY_DETAIL_LINES + 3 }, (_, i) => ({
      id: `m-${i}`, agentId: "a", category: "fact", content: `fact ${i}`, keywords: [], source: src, createdAt: new Date(NOW).toISOString(),
    }))
    const run = recordRun(store, "a", "tidy", facts.map((f) => ({ n: 0, store: "fact" as const, action: "drop" as const, reason: "stale", before: [f as any], after: null })), { now: NOW })
    const lines = runDetail(run).split("\n")
    expect(lines).toHaveLength(TIDY_DETAIL_LINES + 1)
    expect(lines.at(-1)).toBe(`… and 3 more: agentx memory tidy show ${run.runId}`)
  })
})

describe("Hub undo route", () => {
  it("undoes a run, then reports it already undone", async () => {
    const runId = await oneRun()
    const r = undoTidyRoute(ctx(), runId, {})
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, restored: [1] })
    expect(contents()).toEqual(["stays", "old task"])
    expect(undoTidyRoute(ctx(), runId, {}).body).toMatchObject({ restored: [], skipped: [{ n: 1, why: "already undone" }] })
  })

  it("answers 404 for an unknown run and 400 for a bad change number", async () => {
    expect(undoTidyRoute(ctx(), "nope", {}).status).toBe(404)
    const runId = await oneRun()
    expect(undoTidyRoute(ctx(), runId, { change: 0 }).status).toBe(400)
    expect(undoTidyRoute(ctx(), runId, { change: "1" }).status).toBe(400)
    expect(undoTidyRoute(ctx(), runId, { change: 1 }).status).toBe(200)
  })

  it("answers 409 while the facts lock is busy, and changes nothing", async () => {
    const runId = await oneRun()
    writeFileSync(store.fileFor("a") + ".lock", "")
    const r = undoTidyRoute({ ...ctx(), root: tmp }, runId, {})
    // The route builds its own store with the default wait; the lock is
    // fresh, so it times out rather than taking it over.
    expect(r.status).toBe(409)
    rmSync(store.fileFor("a") + ".lock")
    expect(contents()).toEqual(["stays"])
  }, 10_000)
})

describe("memory-tidy-kept", () => {
  it("is the share of the last 7 days' tidy changes not undone, one reading a day", async () => {
    const db = new Database(":memory:")
    add("a1", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    add("a2", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    add("a3", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    add("a4", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    const r = await tidyStage({ store, notes, settings: settings(), commit: true, now: NOW, db })
    expect(r.kept).toEqual({ kept: 4, undone: 0, value: 100 })
    undoTidyRoute(ctx(), r.agents[0].runId!, { change: 1 })
    expect(keptShare(store, NOW)).toEqual({ kept: 3, undone: 1, value: 75 })
    recordKept(store, db, NOW)
    const numbers = new NumberStore(db)
    expect(numbers.get(TIDY_KEPT_NUMBER)).toMatchObject({ unit: "%", rhythm: "daily", target: { value: 90, direction: "up" } })
    const readings = numbers.readings(TIDY_KEPT_NUMBER)
    expect(readings).toHaveLength(1)
    expect(readings[0].value).toBe(75)
    expect(keptShare(store, NOW + TIDY_REVIEW_DAYS * DAY).value).toBeNull()
    db.close()
  })

  it("writes nothing when the tidy changed nothing, and nothing for a one-agent or preview run", async () => {
    const db = new Database(":memory:")
    add("stays")
    const r = await tidyStage({ store, notes, settings: settings(), commit: true, now: NOW, db })
    expect(r.kept).toEqual({ kept: 0, undone: 0, value: null })
    expect(new NumberStore(db).get(TIDY_KEPT_NUMBER)).toBeNull()
    add("old", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    expect((await tidyStage({ store, notes, settings: settings(), commit: true, now: NOW, db, agent: "a" })).kept).toBeUndefined()
    expect((await tidyStage({ store, notes, settings: settings(), commit: false, now: NOW, db })).kept).toBeUndefined()
    db.close()
  })
})

describe("pm's review conditions on PR 2", () => {
  it("C1: a busy facts lock keeps the pinned rotation memo and reports the lost fact", () => {
    const pinned: string[] = []
    writeFileSync(store.fileFor("a") + ".lock", "")
    const r = storeRotationMemo(store, { setRotationMemo: (_a, _c, _i, m) => { pinned.push(m) } }, {
      wikiDir: path.join(tmp, "wiki"), agentId: "a", channel: "dashboard", chatId: "c1", reason: "tier-2",
      memo: "- Reviewing PR #12 for the importer",
    })
    rmSync(store.fileFor("a") + ".lock")
    expect(pinned).toHaveLength(1)
    expect(r.error).toMatch(/memo not saved as a fact \(pinned copy kept\)/)
    expect(store.getAll("a")).toEqual([])
  })

  it("C1: extracted facts after one that hits a busy lock are still written", async () => {
    let calls = 0
    const real = store.addMemory.bind(store)
    const flaky = Object.assign(Object.create(store), {
      addMemory: (agent: string, f: any) => { if (calls++ === 0) throw new Error("memory facts of a is busy"); return real(agent, f) },
    }) as MemoryStore
    await expect(extractMemories("a", "Remember: the client deploys on fridays and invoices go out monthly.",
      "Noted, I will keep both of those in mind for the next deploy and invoice runs.",
      { channel: "telegram", chatId: "1", sender: "owner" }, flaky)).rejects.toThrow(/1 memory fact\(s\) not stored/)
    expect(contents()).toEqual(["The invoices go out monthly"])
  })

  it("C2: a note merge whose older note changed during the call is still logged and undone", async () => {
    const db = new Database(":memory:")
    notes.save({ agentId: "a", type: "project", name: "deploy_a", description: "Deploy window friday", body: "The client deploys on friday afternoon after the review call" })
    await new Promise((r) => setTimeout(r, 5))
    notes.save({ agentId: "a", type: "project", name: "deploy_b", description: "Deploy window is friday", body: "Client deploys friday afternoon after review call" })
    const call = async () => {
      // The older note changes while the model call runs.
      notes.save({ agentId: "a", type: "project", name: "deploy_a", description: "Edited by hand", body: "The client deploys on friday afternoon after the review call" })
      return { text: JSON.stringify({ merge: [{ pair: 1, description: "Merged", body: "Merged body about friday deploys." }] }), usd: 0.01 }
    }
    const r = await tidyStage({ store, notes, db, call, settings: improveConfigSchema.parse({ enabled: true, tidy: { enabled: true } }), commit: true, now: NOW })
    expect(r.agents[0].notes).toBe(1)
    const run = showRun(store, r.agents[0].runId!)!
    expect(run.changes[0]).toMatchObject({ store: "note", action: "merge", reason: "duplicate, older note kept" })
    expect(notes.list("a").map((n) => n.description).sort()).toEqual(["Edited by hand", "Merged"])
    expect(undoTidyRoute(ctx(), run.runId, {}).body).toMatchObject({ restored: [1] })
    expect(notes.list("a").map((n) => n.description).sort()).toEqual(["Deploy window is friday", "Edited by hand"])
    db.close()
  })

  it("C3: recordAccess never waits for a busy lock and never throws", () => {
    add("stays")
    const id = store.getAll("a")[0].id
    writeFileSync(store.fileFor("a") + ".lock", "")
    const slow = new MemoryStore(tmp, { lockWaitMs: 5000 })
    const t0 = Date.now()
    expect(() => slow.recordAccess("a", [id])).not.toThrow()
    expect(Date.now() - t0).toBeLessThan(1000)
    rmSync(store.fileFor("a") + ".lock")
    expect(store.getAll("a")[0].accessCount ?? 0).toBe(0)
  })

  it("C4: undo writes the run log under the facts lock", async () => {
    const runId = await oneRun()
    writeFileSync(store.fileFor("a") + ".lock", "")
    expect(undoTidyRoute(ctx(), runId, {}).status).toBe(409)
    rmSync(store.fileFor("a") + ".lock")
    expect(showRun(store, runId)!.changes[0].undoneAt).toBeUndefined()
  }, 10_000)

  it("C4: the nightly sweep ages out the logs of an agent that is no longer tidied", async () => {
    add("x", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    const r = store.prune("a", NOW)!
    expect(listRuns(store, "a").map((x) => x.runId)).toEqual([r.runId])
    // Off or on, a committed nightly pass ages out every agent's old logs,
    // though agent "a" never gets a new run.
    const later = NOW + (RUN_KEEP_DAYS + 1) * DAY
    await tidyStage({ store, notes, settings: improveConfigSchema.parse({ tidy: { enabled: false } }), commit: false, now: later })
    expect(listRuns(store, "a")).toHaveLength(1)
    await tidyStage({ store, notes, settings: improveConfigSchema.parse({ tidy: { enabled: false } }), commit: true, now: later })
    expect(listRuns(store, "a")).toEqual([])
    expect(trimAllRuns(store, later)).toEqual([])
  })
})
