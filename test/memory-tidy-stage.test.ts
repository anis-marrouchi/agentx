import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawn } from "child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { MemoryStore } from "../src/agents/memory-store"
import { AgentMemory } from "../src/agents/agent-memory"
import { LockBusyError } from "../src/wiki/facts/ledger-file"
import { improveConfigSchema } from "../src/daemon/config"
import { listRuns, showRun, undoRun } from "../src/improve/tidy"
import { factsAlike, findNotePairs, planFactTidy, tidyAgents, tidyStage } from "../src/improve/tidy-stage"
import { spentToday } from "../src/improve/budget"

// #2117 PR 2: the nightly memory tidy (stage 5), the facts lock (B1).

let tmp: string
let store: MemoryStore
let notes: AgentMemory
const DAY = 86_400_000
const NOW = Date.parse("2026-11-26T12:00:00Z")

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-tidy-stage-"))
  store = new MemoryStore(tmp, { lockWaitMs: 200 })
  notes = new AgentMemory({ baseDir: path.join(tmp, ".agentx") })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const settings = (over: { enabled?: boolean; tidy?: Record<string, unknown> } = {}) =>
  improveConfigSchema.parse({ enabled: over.enabled ?? false, tidy: { enabled: true, ...(over.tidy ?? {}) } })

const src = { channel: "dashboard", chatId: "c", sender: "s", date: "2026-11-01" }
let clock = 0
/** A fact with a distinct, rising createdAt. */
const add = (content: string, extra: Record<string, unknown> = {}) => {
  store.addMemory("a", { agentId: "a", category: "fact", content, keywords: [], source: src, ...extra } as any)
  const all = store.getAll("a")
  all[all.length - 1].createdAt = new Date(NOW - 30 * DAY + ++clock * 1000).toISOString()
  store.rewrite("a", all)
}
const contents = () => store.getAll("a").map((f) => f.content)

describe("B1: one facts lock for append and rewrite", () => {
  it("an append waits while another process holds the lock, and is kept", async () => {
    add("first fact")
    const file = store.fileFor("a")
    // Another process (the nightly sweep) reads the file, holds the lock
    // for 400 ms, then rewrites what it read.
    const child = spawn(process.execPath, ["-e", `
      const fs = require("fs")
      const fd = fs.openSync(${JSON.stringify(file + ".lock")}, "wx")
      const read = fs.readFileSync(${JSON.stringify(file)}, "utf-8")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
      fs.writeFileSync(${JSON.stringify(file)}, read)
      fs.closeSync(fd); fs.unlinkSync(${JSON.stringify(file + ".lock")})
    `])
    const done = new Promise((r) => child.on("exit", r))
    const t0 = Date.now()
    while (!existsSync(file + ".lock") && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5))
    const patient = new MemoryStore(tmp, { lockWaitMs: 5000 })
    expect(patient.addMemory("a", { agentId: "a", category: "fact", content: "appended during the rewrite", keywords: [], source: src })).toBe(true)
    await done
    expect(contents()).toEqual(["first fact", "appended during the rewrite"])
  })

  it("a write that cannot get the lock fails loudly, it does not write around it", () => {
    add("first fact")
    const before = readFileSync(store.fileFor("a"), "utf-8")
    writeFileSync(store.fileFor("a") + ".lock", "")
    expect(() => store.addMemory("a", { agentId: "a", category: "fact", content: "x", keywords: [], source: src })).toThrow(LockBusyError)
    expect(() => store.prune("a")).toThrow(LockBusyError)
    expect(readFileSync(store.fileFor("a"), "utf-8")).toBe(before)
    rmSync(store.fileFor("a") + ".lock")
  })

  it("is re-entrant: a rewrite inside the lock does not wait on itself", () => {
    add("first fact")
    store.withFactsLock("a", () => store.rewrite("a", []))
    expect(contents()).toEqual([])
  })
})

describe("planFactTidy", () => {
  const plan = (max = 20) => planFactTidy(store.getAll("a"), { now: NOW, staleDays: 90, max })

  it("merges near-duplicates into the newest, drops expired and long-unverified facts", () => {
    add("the deploy window is friday afternoon")
    add("unrelated preference about dark mode")
    add("deploy window is friday afternoon only")
    add("old task", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    add("billing plan unverified", { unverified: { since: new Date(NOW - 100 * DAY).toISOString(), reason: "x" } })
    add("recently flagged", { unverified: { since: new Date(NOW - 10 * DAY).toISOString(), reason: "x" } })
    const p = plan()
    expect(p.map((c) => [c.action, c.reason, c.before.map((f) => f.content)])).toEqual([
      ["drop", "expired", ["old task"]],
      ["drop", "stale", ["billing plan unverified"]],
      ["merge", "duplicate", ["the deploy window is friday afternoon", "deploy window is friday afternoon only"]],
    ])
    expect(p[2].after!.content).toBe("deploy window is friday afternoon only")
  })

  it("never touches held facts or secrets", () => {
    add("the deploy window is friday afternoon", { review: "held" })
    add("deploy window is friday afternoon only")
    add("deploy window is friday afternoon", { source: { ...src, channel: "whatsapp", trust: "external" } })
    add("old secret", { category: "secret", unverified: { since: new Date(NOW - 200 * DAY).toISOString(), reason: "x" } })
    expect(plan()).toEqual([])
  })

  it("holds the per-agent cap", () => {
    for (let i = 0; i < 5; i++) add(`t${i}`, { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    expect(plan(3)).toHaveLength(3)
  })

  it("needs the words to match both ways", () => {
    expect(factsAlike("deploys on friday afternoon", "deploys friday afternoon")).toBe(true)
    expect(factsAlike("deploys friday", "deploys friday afternoon unless the client asks for monday")).toBe(false)
  })
})

describe("tidyStage", () => {
  const note = (name: string, description: string, body: string, type: "project" | "feedback" = "project", author?: string) =>
    notes.save({ agentId: "a", type, name, description, body, ...(author ? { author } : {}) })

  it("does nothing while improve.tidy.enabled is off", async () => {
    add("old task", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    const r = await tidyStage({ store, notes, settings: settings({ tidy: { enabled: false } }), commit: true, now: NOW })
    expect(r).toEqual({ ran: false, why: "improve.tidy.enabled is off", agents: [] })
    expect(contents()).toEqual(["old task"])
  })

  it("preview changes nothing", async () => {
    add("old task", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    note("deploy_a", "Deploy window friday", "The client deploys on friday afternoon after the review call")
    note("deploy_b", "Deploy window is friday", "Client deploys friday afternoon after review call")
    const before = readFileSync(store.fileFor("a"), "utf-8")
    const r = await tidyStage({ store, notes, settings: settings({ enabled: true }), commit: false, now: NOW })
    expect(r.agents).toEqual([{ agent: "a", facts: 1, notes: 0, notePairs: 1, notesWhy: "preview" }])
    expect(readFileSync(store.fileFor("a"), "utf-8")).toBe(before)
    expect(notes.list("a")).toHaveLength(2)
    expect(listRuns(store)).toEqual([])
  })

  it("commits fact changes into one run log that undo puts back", async () => {
    add("the deploy window is friday afternoon")
    add("deploy window is friday afternoon only")
    add("old task", { category: "task-state", expiresAt: new Date(NOW - DAY).toISOString() })
    const all = store.getAll("a")
    const r = await tidyStage({ store, notes, settings: settings(), commit: true, now: NOW })
    expect(r.agents[0]).toMatchObject({ agent: "a", facts: 2, notes: 0 })
    expect(contents()).toEqual(["deploy window is friday afternoon only"])
    const run = showRun(store, r.agents[0].runId!)!
    expect(run.by).toBe("tidy")
    expect(run.backup).toBeDefined()

    expect(undoRun(store, run.runId, { notes }).restored).toEqual([1, 2])
    expect(store.getAll("a").map((f) => f.id)).toEqual(all.map((f) => f.id))
  })

  it("skips note merges with improve.enabled off, and never pairs a fix rule", async () => {
    note("deploy_a", "Deploy window friday", "The client deploys on friday afternoon after the review call")
    note("deploy_b", "Deploy window is friday", "Client deploys friday afternoon after review call")
    note("loop_x", "Deploy window friday rule", "The client deploys on friday afternoon after the review call", "feedback", "improve")
    note("loop_y", "Deploy window friday rule", "The client deploys on friday afternoon after the review call", "feedback", "improve")
    expect(findNotePairs(notes.list("a"), 5).map(([a, b]) => [a.name, b.name])).toEqual([["deploy_a", "deploy_b"]])
    let called = 0
    const r = await tidyStage({ store, notes, settings: settings({ enabled: false }), commit: true, now: NOW, call: async () => { called++; return { text: "{}", usd: 0 } } })
    expect(called).toBe(0)
    expect(r.agents[0]).toMatchObject({ notes: 0, notePairs: 1, notesWhy: "improve.enabled is off: a note merge is a model call" })
    expect(notes.list("a")).toHaveLength(4)
  })

  it("merges a note pair with one booked model call, and undo brings both back", async () => {
    const db = new Database(":memory:")
    note("deploy_a", "Deploy window friday", "The client deploys on friday afternoon after the review call")
    await new Promise((r) => setTimeout(r, 5))
    note("deploy_b", "Deploy window is friday", "Client deploys friday afternoon after review call")
    const call = async () => ({ text: JSON.stringify({ merge: [{ pair: 1, description: "Deploys: friday afternoon", body: "The client deploys friday afternoon, after the review call." }] }), usd: 0.01 })
    const r = await tidyStage({ store, notes, db, call, settings: settings({ enabled: true }), commit: true, now: NOW })
    expect(r.agents[0]).toMatchObject({ notes: 1, facts: 0 })
    expect(notes.list("a").map((n) => [n.name, n.description])).toEqual([["deploy_b", "Deploys: friday afternoon"]])
    expect(spentToday(db, NOW).calls.tidy).toBe(1)

    const u = undoRun(store, r.agents[0].runId!, { notes })
    expect(u.restored).toEqual([1])
    expect(notes.list("a").map((n) => [n.name, n.description])).toEqual([
      ["deploy_a", "Deploy window friday"], ["deploy_b", "Deploy window is friday"],
    ])
    db.close()
  })

  it("leaves a merged note alone on undo when it changed since, unless force", async () => {
    const db = new Database(":memory:")
    note("deploy_a", "Deploy window friday", "The client deploys on friday afternoon after the review call")
    note("deploy_b", "Deploy window is friday", "Client deploys friday afternoon after review call")
    const call = async () => ({ text: JSON.stringify({ merge: [{ pair: 1, description: "Merged", body: "Merged body about friday deploys." }] }), usd: 0.01 })
    const r = await tidyStage({ store, notes, db, call, settings: settings({ enabled: true }), commit: true, now: NOW })
    const kept = notes.list("a")[0]
    notes.save({ agentId: "a", type: kept.type, name: kept.name, description: "Edited by hand", body: kept.body })
    expect(undoRun(store, r.agents[0].runId!, { notes }).skipped).toEqual([{ n: 1, why: "the kept note changed after the tidy" }])
    expect(undoRun(store, r.agents[0].runId!, { notes, force: true }).restored).toEqual([1])
    expect(notes.list("a")).toHaveLength(2)
    db.close()
  })
})

describe("scale", () => {
  it("plans 800 facts in well under a second, and skips hand-kept copies", () => {
    for (let i = 0; i < 800; i++) {
      store.addMemory("a", { agentId: "a", category: "fact", content: `fact number ${i} about project ${i % 37} and client ${i * 7} with a few more words here`, keywords: [], source: src })
    }
    const t = Date.now()
    planFactTidy(store.getAll("a"), { now: NOW, staleDays: 90, max: 20 })
    expect(Date.now() - t).toBeLessThan(1000)
    writeFileSync(path.join(store.memoryRoot(), "a.pruned-20260919.jsonl"), "")
    expect(tidyAgents(store, notes)).toEqual(["a"])
  })
})
