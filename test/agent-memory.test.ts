import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import { AgentMemory, parseMemoryFile } from "../src/agents/agent-memory"

const ROOT = resolve(__dirname, "../.test-agent-memory")

describe("AgentMemory", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
  })
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

  const store = () => new AgentMemory({ baseDir: ROOT })

  it("saves, reads, and round-trips a memory with frontmatter", () => {
    const s = store()
    const rec = s.save({
      agentId: "atlas",
      type: "user",
      name: "role",
      description: "Anis is a Tunisian founder — prefers terse tech replies.",
      body: "He's juggling 4 projects; context-switch cost is high.\n\nKeep bullet lists tight.",
    })
    expect(rec.name).toBe("role")
    expect(rec.type).toBe("user")
    expect(rec.body).toContain("4 projects")
    const rehydrated = s.get("atlas", "role")!
    expect(rehydrated.description).toContain("Tunisian founder")
    expect(rehydrated.body).toBe(rec.body)
    expect(rehydrated.createdAt).toBe(rec.createdAt)
  })

  it("lists memories grouped by type order (user > feedback > project > reference)", () => {
    const s = store()
    s.save({ agentId: "a", type: "project", name: "p1", description: "d", body: "b" })
    s.save({ agentId: "a", type: "user", name: "u1", description: "d", body: "b" })
    s.save({ agentId: "a", type: "feedback", name: "f1", description: "d", body: "b" })
    s.save({ agentId: "a", type: "reference", name: "r1", description: "d", body: "b" })
    const order = s.list("a").map((r) => r.type)
    expect(order).toEqual(["user", "feedback", "project", "reference"])
  })

  it("rewrites MEMORY.md index and inlines it via indexMarkdown()", () => {
    const s = store()
    s.save({ agentId: "a", type: "user", name: "role", description: "founder", body: "..." })
    s.save({ agentId: "a", type: "feedback", name: "no-mock-db", description: "no mocks", body: "..." })
    const md = s.indexMarkdown("a")
    expect(md).toContain("# Memory — a")
    expect(md).toContain("## User")
    expect(md).toContain("## Feedback")
    expect(md).toContain("**role**")
    expect(md).toContain("founder")
  })

  it("updates preserve createdAt; bump updatedAt", async () => {
    const s = store()
    const first = s.save({ agentId: "a", type: "user", name: "x", description: "d", body: "v1" })
    await new Promise((r) => setTimeout(r, 10))
    const second = s.save({ agentId: "a", type: "user", name: "x", description: "d2", body: "v2" })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt >= first.updatedAt).toBe(true)
    expect(second.body).toBe("v2")
  })

  it("remove deletes the file and rewrites the index", () => {
    const s = store()
    s.save({ agentId: "a", type: "user", name: "x", description: "d", body: "b" })
    s.save({ agentId: "a", type: "user", name: "y", description: "d", body: "b" })
    expect(s.remove("a", "x")).toBe(true)
    expect(s.list("a").map((r) => r.name)).toEqual(["y"])
    expect(s.remove("a", "does-not-exist")).toBe(false)
    const md = s.indexMarkdown("a")
    expect(md).toContain("**y**")
    expect(md).not.toContain("**x**")
  })

  it("indexMarkdown returns empty string for an agent with no memories", () => {
    const s = store()
    expect(s.indexMarkdown("nobody")).toBe("")
  })

  it("rejects invalid memory types", () => {
    const s = store()
    expect(() => s.save({ agentId: "a", type: "bogus" as any, name: "x", description: "d", body: "b" })).toThrow()
  })

  it("parseMemoryFile tolerates missing updated field (backfills from created)", () => {
    const raw = [
      "---",
      "name: x",
      "type: user",
      "description: sample",
      "created: 2026-04-23T10:00:00.000Z",
      "---",
      "",
      "body content",
    ].join("\n")
    const rec = parseMemoryFile(raw)!
    expect(rec.updatedAt).toBe(rec.createdAt)
    expect(rec.body).toBe("body content")
  })

  it("parseMemoryFile returns null on malformed input", () => {
    expect(parseMemoryFile("")).toBeNull()
    expect(parseMemoryFile("no frontmatter here")).toBeNull()
    expect(parseMemoryFile("---\nname: x\n---\n")).toBeNull()
  })

  it("slugifies names (spaces, punctuation become underscores)", () => {
    const s = store()
    s.save({ agentId: "a", type: "user", name: "Deep Go Expertise!", description: "d", body: "b" })
    expect(s.get("a", "deep_go_expertise")?.name).toBe("deep_go_expertise")
  })
})

describe("AgentMemory.syncToWorkspace", () => {
  let ws: string
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    ws = resolve(ROOT, "workspace-a")
    mkdirSync(ws, { recursive: true })
  })
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

  const store = () => new AgentMemory({ baseDir: ROOT })

  it("writes .agentx-memory.md with the full index when memories exist", () => {
    const { readFileSync } = require("fs") as typeof import("fs")
    const s = store()
    s.save({ agentId: "a", type: "user", name: "role", description: "founder", body: "tl;dr" })
    s.syncToWorkspace("a", ws)
    const content = readFileSync(resolve(ws, ".agentx-memory.md"), "utf-8")
    expect(content).toContain("# Memory — a")
    expect(content).toContain("**role**")
  })

  it("creates CLAUDE.md with a sentinel block when none exists", () => {
    const { readFileSync } = require("fs") as typeof import("fs")
    const s = store()
    s.save({ agentId: "a", type: "feedback", name: "x", description: "d", body: "b" })
    s.syncToWorkspace("a", ws)
    const claude = readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")
    expect(claude).toContain("<!-- AGENTX-MEMORY-START")
    expect(claude).toContain("<!-- AGENTX-MEMORY-END -->")
    expect(claude).toContain("**x**")
  })

  it("preserves existing CLAUDE.md content and appends the sentinel block", () => {
    const { readFileSync, writeFileSync } = require("fs") as typeof import("fs")
    writeFileSync(resolve(ws, "CLAUDE.md"), "# Agent briefing\n\nI am an atlas agent.")
    const s = store()
    s.save({ agentId: "a", type: "user", name: "pref", description: "terse", body: "always short" })
    s.syncToWorkspace("a", ws)
    const claude = readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")
    expect(claude).toContain("# Agent briefing")
    expect(claude).toContain("I am an atlas agent.")
    expect(claude).toContain("<!-- AGENTX-MEMORY-START")
    expect(claude).toContain("**pref**")
  })

  it("replaces only the sentinel block on re-sync (idempotent)", () => {
    const { readFileSync, writeFileSync } = require("fs") as typeof import("fs")
    writeFileSync(resolve(ws, "CLAUDE.md"), "# Briefing\n\nUser content.")
    const s = store()
    s.save({ agentId: "a", type: "user", name: "p1", description: "d1", body: "b1" })
    s.syncToWorkspace("a", ws)
    s.save({ agentId: "a", type: "user", name: "p2", description: "d2", body: "b2" })
    s.syncToWorkspace("a", ws)
    const claude = readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")
    // User content still there exactly once
    expect(claude.match(/Briefing/g)?.length).toBe(1)
    expect(claude.match(/User content/g)?.length).toBe(1)
    // Both memories present, only one sentinel pair
    expect(claude).toContain("**p1**")
    expect(claude).toContain("**p2**")
    expect(claude.match(/AGENTX-MEMORY-START/g)?.length).toBe(1)
    expect(claude.match(/AGENTX-MEMORY-END/g)?.length).toBe(1)
  })

  it("removes the sentinel block + .agentx-memory.md when all memories are deleted", () => {
    const { existsSync, readFileSync, writeFileSync } = require("fs") as typeof import("fs")
    writeFileSync(resolve(ws, "CLAUDE.md"), "# Briefing\n\nUser content.")
    const s = store()
    s.save({ agentId: "a", type: "user", name: "x", description: "d", body: "b" })
    s.syncToWorkspace("a", ws)
    expect(existsSync(resolve(ws, ".agentx-memory.md"))).toBe(true)
    s.remove("a", "x")
    s.syncToWorkspace("a", ws)
    expect(existsSync(resolve(ws, ".agentx-memory.md"))).toBe(false)
    const claude = readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")
    expect(claude).not.toContain("AGENTX-MEMORY-START")
    expect(claude).toContain("Briefing")
    expect(claude).toContain("User content")
  })
})
