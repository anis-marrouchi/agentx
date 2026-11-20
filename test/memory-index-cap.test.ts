import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { AgentMemory, agentMemoryStartBlock, MEMORY_INDEX_CUT_NOTE, MEMORY_INDEX_RENDER_MAX, trimMemoryIndex } from "../src/agents/agent-memory"

// #615, #2009 — the agent-memory index is shown once per fresh start, in
// the task text. `session.memoryIndexMaxChars` caps that rendered block;
// .agentx-memory.md keeps the whole index for the agent to Read on demand.

const ROOT = resolve(tmpdir(), `agentx-memory-cap-${process.pid}`)

function index(entries: number, references = 1): string {
  const lines = ["# Memory — a", "", "This is the agent's experiential memory.", "", "## User", ""]
  for (let i = 0; i < entries; i++) lines.push(`- **fact_${i}** — something the agent learned, number ${i} _(updated 2026-10-04)_`)
  lines.push("", "## Reference", "")
  for (let i = 0; i < references; i++) lines.push(`- **board_${i}** — where the work is tracked, number ${i} _(updated 2026-10-04)_`)
  lines.push("")
  return lines.join("\n")
}

describe("trimMemoryIndex", () => {
  it("returns the index unchanged with no cap, or when it fits", () => {
    const md = index(3)
    expect(trimMemoryIndex(md, 0)).toBe(md)
    expect(trimMemoryIndex(md, -5)).toBe(md)
    expect(trimMemoryIndex(md, md.length)).toBe(md)
    expect(trimMemoryIndex("", 100)).toBe("")
  })

  it("keeps whole lines in order, stays under the cap, and counts what it left out", () => {
    const md = index(40)
    const cut = trimMemoryIndex(md, 1200)
    expect(cut.length).toBeLessThanOrEqual(1200)
    expect(cut.startsWith("# Memory — a")).toBe(true)
    expect(cut).toContain("- **fact_0**")
    expect(cut).not.toContain("- **board_0**")
    const kept = cut.split("\n").filter((l) => l.startsWith("- ")).length
    expect(kept).toBeGreaterThan(0)
    expect(cut.trim().endsWith(`_(${41 - kept} more ${MEMORY_INDEX_CUT_NOTE})_`)).toBe(true)
    // No entry is cut in the middle.
    for (const line of cut.split("\n").filter((l) => l.startsWith("- "))) expect(line).toMatch(/_\(updated 2026-10-04\)_$/)
  })

  it("drops a type heading left with nothing under it", () => {
    const md = index(2, 10)
    // Room for the header, the two User entries and the note, plus the
    // Reference heading but none of its entries.
    const reserve = `_(12 more ${MEMORY_INDEX_CUT_NOTE})_`.length + 2
    const cap = md.indexOf("## Reference") + reserve + 40
    expect(cap).toBeLessThan(md.length)
    const cut = trimMemoryIndex(md, cap)
    expect(cut).toContain("## User")
    expect(cut).toContain("- **fact_1**")
    expect(cut).not.toContain("## Reference")
    expect(cut).toContain("_(10 more ")
  })

  it("with a cap too small for one entry gives just the note", () => {
    const cut = trimMemoryIndex(index(5), 150)
    expect(cut.length).toBeLessThanOrEqual(150)
    expect(cut).toContain("_(6 more ")
    expect(cut).not.toContain("- **")
  })
})

describe("AgentMemory with the cap", () => {
  let ws: string
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    ws = resolve(ROOT, "workspace")
    mkdirSync(ws, { recursive: true })
  })
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

  function filled(): AgentMemory {
    const s = new AgentMemory({ baseDir: ROOT })
    for (let i = 0; i < 30; i++) {
      s.save({ agentId: "a", type: "project", name: `fact_${i}`, description: `a long description of the thing the agent learned, number ${i}`, body: "body" })
    }
    return s
  }

  it("inlines a capped index for the prompt, and the whole one without a cap", () => {
    const s = filled()
    const full = s.indexMarkdown("a")
    expect(full.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(30)
    const capped = s.indexMarkdown("a", 800)
    expect(capped.length).toBeLessThanOrEqual(800)
    expect(capped).toContain(MEMORY_INDEX_CUT_NOTE)
    expect(s.indexMarkdown("a", 0)).toBe(full)
  })

  it("keeps the full index in .agentx-memory.md and writes no capped copy anywhere (#2009)", () => {
    const s = filled()
    writeFileSync(resolve(ws, "CLAUDE.md"), "# Project rules\n\nKeep tests green.\n")
    s.syncToWorkspace("a", ws)
    expect(readFileSync(resolve(ws, "CLAUDE.md"), "utf-8")).toBe("# Project rules\n\nKeep tests green.\n")
    const explicit = readFileSync(resolve(ws, ".agentx-memory.md"), "utf-8")
    expect(explicit.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(30)
    expect(explicit).not.toContain(MEMORY_INDEX_CUT_NOTE)
  })
})

// #2009 part 1, condition 3: only the rendered block is capped, at 4000
// characters by default, and it names the file that holds the whole index.
describe("agentMemoryStartBlock (#2009)", () => {
  const FULL = "/work/space/.agentx-memory.md"

  it("is empty with no index", () => {
    expect(agentMemoryStartBlock("", FULL)).toBe("")
    expect(agentMemoryStartBlock("  \n", FULL)).toBe("")
  })

  it("renders a small index whole, with one header naming the full file", () => {
    const md = index(3)
    const block = agentMemoryStartBlock(md, FULL)
    expect(block).toContain(md.trim())
    expect(block).toContain(FULL)
    expect(block.match(/Agent memory index/g)).toHaveLength(1)
  })

  it("caps the index at 4000 characters by default and points at the full file for the rest", () => {
    expect(MEMORY_INDEX_RENDER_MAX).toBe(4000)
    const md = index(200)
    expect(md.length).toBeGreaterThan(8000)
    const block = agentMemoryStartBlock(md, FULL)
    const body = block.slice(block.indexOf("# Memory — a"))
    expect(body.length).toBeLessThanOrEqual(4000 + "\n</system-reminder>".length)
    expect(block).toMatch(/_\(\d+ more memories not shown here\. Read \/work\/space\/\.agentx-memory\.md for the full index\.\)_/)
    expect(agentMemoryStartBlock(md, FULL, 0)).toContain("- **fact_199**")
  })
})
