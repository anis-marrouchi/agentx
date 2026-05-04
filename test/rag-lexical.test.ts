import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { buildIndex, lexicalSearch, indexInfo } from "../src/rag/lexical-index"
import {
  registerAllBuiltins,
  runBuiltin,
  _resetBuiltinsForTesting,
} from "../src/actions/builtin"

let workspace: string
let baseDir: string

beforeEach(() => {
  _resetBuiltinsForTesting()
  registerAllBuiltins()
  workspace = mkdtempSync(path.join(tmpdir(), "agentx-rag-"))
  baseDir = path.join(workspace, ".rag")
  mkdirSync(path.join(workspace, "docs"), { recursive: true })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  _resetBuiltinsForTesting()
})

const writeDoc = (rel: string, contents: string) => {
  const abs = path.join(workspace, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
}

describe("buildIndex + lexicalSearch (with explicit cwd / baseDir)", () => {
  // All tests pass cwd: workspace + baseDir: workspace/.rag so they
  // never depend on process.cwd(). This works under vitest's threaded
  // pool which forbids process.chdir().

  it("indexes markdown docs and returns hits ordered by score", async () => {
    writeDoc("docs/ledger.md", "# Intent Ledger\nPhase 1 ledger work — append-only SQLite store for dispatch decisions.")
    writeDoc("docs/workflows.md", "# Workflows\nYAML-authored DAGs with action chaining.")
    writeDoc("docs/notes.md", "# Notes\nSome unrelated content.")

    const r = await buildIndex("test-agent", ["docs/**/*.md"], { cwd: workspace, baseDir })
    expect(r.docs).toBe(3)

    const hits = lexicalSearch("test-agent", "ledger", { baseDir })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].title).toBe("Intent Ledger")
    expect(hits[0].path).toContain("ledger.md")
    expect(hits[0].score).toBeGreaterThan(0)
    expect(hits[0].snippet.toLowerCase()).toContain("ledger")
  })

  it("falls back to filename when there is no H1", async () => {
    writeDoc("docs/no-h1.md", "Some body without a heading; mentions dispatcher.")
    await buildIndex("test-agent", ["docs/**/*.md"], { cwd: workspace, baseDir })
    const hits = lexicalSearch("test-agent", "dispatcher", { baseDir })
    expect(hits[0].title).toBe("no-h1")
  })

  it("returns empty array when no index exists for the agent", () => {
    const hits = lexicalSearch("never-indexed", "anything", { baseDir })
    expect(hits).toEqual([])
  })

  it("returns empty array on empty query results without errors", async () => {
    writeDoc("docs/x.md", "# X\nbody")
    await buildIndex("test-agent", ["docs/**/*.md"], { cwd: workspace, baseDir })
    const hits = lexicalSearch("test-agent", "zzz_no_such_term_zzz", { baseDir })
    expect(hits).toEqual([])
  })

  it("respects k cap and never returns more than configured", async () => {
    for (let i = 0; i < 10; i++) {
      writeDoc(`docs/doc-${i}.md`, `# Doc ${i}\ntopic-zebra appears here many times zebra zebra`)
    }
    await buildIndex("test-agent", ["docs/**/*.md"], { cwd: workspace, baseDir })
    const top3 = lexicalSearch("test-agent", "zebra", { k: 3, baseDir })
    expect(top3).toHaveLength(3)
    const top10 = lexicalSearch("test-agent", "zebra", { k: 10, baseDir })
    expect(top10.length).toBeGreaterThanOrEqual(3)
  })

  it("snippet excerpts around the matched term, not just file head", async () => {
    const padding = "x ".repeat(500)
    writeDoc("docs/long.md", `# Long\n${padding}\nFINDME this is the magic line\n${padding}`)
    await buildIndex("test-agent", ["docs/**/*.md"], { cwd: workspace, baseDir })
    const hits = lexicalSearch("test-agent", "FINDME", { baseDir })
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet.toLowerCase()).toContain("findme")
    expect(hits[0].snippet).toMatch(/^…/) // truncation marker since match is mid-doc
  })

  it("indexInfo reports doc count without loading the search engine", async () => {
    writeDoc("docs/a.md", "# A\nx")
    writeDoc("docs/b.md", "# B\ny")
    await buildIndex("test-agent", ["docs/**/*.md"], { cwd: workspace, baseDir })
    const info = indexInfo("test-agent", { baseDir })
    expect(info.exists).toBe(true)
    expect(info.docs).toBe(2)
  })

  it("indexInfo on missing index returns exists=false, docs=0", () => {
    const info = indexInfo("never-built", { baseDir })
    expect(info.exists).toBe(false)
    expect(info.docs).toBe(0)
  })

  it("rebuild replaces the prior index, not append", async () => {
    writeDoc("docs/a.md", "# A\nfirst")
    await buildIndex("test-agent", ["docs/**/*.md"], { cwd: workspace, baseDir })
    expect(indexInfo("test-agent", { baseDir }).docs).toBe(1)
    writeDoc("docs/b.md", "# B\nsecond")
    writeDoc("docs/c.md", "# C\nthird")
    await buildIndex("test-agent", ["docs/**/*.md"], { cwd: workspace, baseDir })
    expect(indexInfo("test-agent", { baseDir }).docs).toBe(3) // a + b + c, no duplicates
  })
})

describe("rag.lexical built-in action — input validation surface", () => {
  // The handler reads from a process-cwd-relative path that we can't
  // override without chdir. We only verify the input/output schema
  // surface; integration tests above cover the underlying retrieval.

  it("rejects bad input via Zod (empty agentId or query)", async () => {
    await expect(runBuiltin("rag.lexical", { agentId: "", query: "x" })).rejects.toThrow()
    await expect(runBuiltin("rag.lexical", { agentId: "a", query: "" })).rejects.toThrow()
  })

  it("returns empty hits when the agent has no index (gracefully degrades)", async () => {
    const out: any = await runBuiltin("rag.lexical", { agentId: "no-index-very-unlikely-name-xyz", query: "anything" })
    expect(out.hits).toEqual([])
  })

  it("respects k cap (validation only)", async () => {
    await expect(runBuiltin("rag.lexical", { agentId: "x", query: "y", k: 51 })).rejects.toThrow()
    await expect(runBuiltin("rag.lexical", { agentId: "x", query: "y", k: 0 })).rejects.toThrow()
  })
})
