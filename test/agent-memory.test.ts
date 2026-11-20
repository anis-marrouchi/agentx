import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
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
      description: "Alex is a solo founder — prefers terse tech replies.",
      body: "He's juggling 4 projects; context-switch cost is high.\n\nKeep bullet lists tight.",
    })
    expect(rec.name).toBe("role")
    expect(rec.type).toBe("user")
    expect(rec.body).toContain("4 projects")
    const rehydrated = s.get("atlas", "role")!
    expect(rehydrated.description).toContain("solo founder")
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
  const START = "<!-- AGENTX-MEMORY-START — auto-managed by agentx; edit via `agentx memory` -->"
  const END = "<!-- AGENTX-MEMORY-END -->"

  it("writes .agentx-memory.md with the full index when memories exist", () => {
    const s = store()
    s.save({ agentId: "a", type: "user", name: "role", description: "founder", body: "tl;dr" })
    s.syncToWorkspace("a", ws)
    const content = readFileSync(resolve(ws, ".agentx-memory.md"), "utf-8")
    expect(content).toContain("# Memory — a")
    expect(content).toContain("**role**")
  })

  // #2009 B1: the index is put in the task text of each fresh start, so
  // the workspace CLAUDE.md (read into the cached system prompt) no
  // longer carries a copy that changes on every memory write.
  it("never creates CLAUDE.md", () => {
    const s = store()
    s.save({ agentId: "a", type: "feedback", name: "x", description: "d", body: "b" })
    s.syncToWorkspace("a", ws)
    expect(existsSync(resolve(ws, "CLAUDE.md"))).toBe(false)
  })

  it("leaves a CLAUDE.md without a managed block byte for byte as it was", () => {
    writeFileSync(resolve(ws, "CLAUDE.md"), "# Agent briefing\n\nI am an atlas agent.")
    const s = store()
    s.save({ agentId: "a", type: "user", name: "pref", description: "terse", body: "always short" })
    s.syncToWorkspace("a", ws)
    expect(readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")).toBe("# Agent briefing\n\nI am an atlas agent.")
  })

  it("removes an old merged block once, by its markers, and keeps the rest", () => {
    writeFileSync(resolve(ws, "CLAUDE.md"), `# Briefing\n\nUser content.\n\n${START}\n# Memory — a\n- **old** — d\n${END}\n\n## After\n`)
    const s = store()
    s.save({ agentId: "a", type: "user", name: "p1", description: "d1", body: "b1" })
    s.syncToWorkspace("a", ws)
    const claude = readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")
    expect(claude).toBe("# Briefing\n\nUser content.\n\n## After\n")
    s.syncToWorkspace("a", ws)
    expect(readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")).toBe(claude)
  })

  // Review of PR #2035, item 4: only the marked text and at most one
  // adjoining blank line change; the rest of the file is left as written.
  it("changes only the marked block and one adjoining blank line", () => {
    const head = "# Briefing  \n\n\n\nText\n\n"
    const tail = "\n## After\n\n\n"
    writeFileSync(resolve(ws, "CLAUDE.md"), `${head}${START}\n- **old** — d\n${END}\n\n${tail}`)
    const s = store()
    s.save({ agentId: "a", type: "user", name: "p1", description: "d1", body: "b1" })
    s.syncToWorkspace("a", ws)
    expect(readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")).toBe(`${head}${tail}`)
  })

  it("leaves an empty CLAUDE.md, not a deleted one, when the block was all it held", () => {
    writeFileSync(resolve(ws, "CLAUDE.md"), `${START}\n- **old** — d\n${END}\n`)
    const s = store()
    s.save({ agentId: "a", type: "user", name: "p1", description: "d1", body: "b1" })
    s.syncToWorkspace("a", ws)
    expect(existsSync(resolve(ws, "CLAUDE.md"))).toBe(true)
    expect(readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")).toBe("")
  })

  it("leaves a CLAUDE.md that git tracks untouched, and says so once", () => {
    const original = `# Repo rules\n\n${START}\n- **old** — d\n${END}\n`
    writeFileSync(resolve(ws, "CLAUDE.md"), original)
    execFileSync("git", ["init", "-q"], { cwd: ws })
    execFileSync("git", ["add", "CLAUDE.md"], { cwd: ws })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const s = store()
      s.save({ agentId: "a", type: "user", name: "p1", description: "d1", body: "b1" })
      s.syncToWorkspace("a", ws)
      s.syncToWorkspace("a", ws)
      expect(readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")).toBe(original)
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("tracked by git"))).toHaveLength(1)
      expect(existsSync(resolve(ws, ".agentx-memory.md"))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it("removes .agentx-memory.md and any old block when all memories are deleted", () => {
    writeFileSync(resolve(ws, "CLAUDE.md"), `# Briefing\n\nUser content.\n\n${START}\n- **x** — d\n${END}\n`)
    const s = store()
    s.save({ agentId: "a", type: "user", name: "x", description: "d", body: "b" })
    s.syncToWorkspace("a", ws)
    expect(existsSync(resolve(ws, ".agentx-memory.md"))).toBe(true)
    s.remove("a", "x")
    s.syncToWorkspace("a", ws)
    expect(existsSync(resolve(ws, ".agentx-memory.md"))).toBe(false)
    const claude = readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")
    expect(claude).not.toContain("AGENTX-MEMORY-START")
    expect(claude).toBe("# Briefing\n\nUser content.\n")
  })
})
