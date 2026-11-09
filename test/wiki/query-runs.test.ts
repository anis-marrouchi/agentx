import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { queryFailed, recordQueryRun, summariseQueryRuns, timedQuery } from "../../src/wiki/query-runs"
import { wiki } from "../../src/commands/wiki"
import { existingWikiDir } from "../../src/wiki/hub"

// #603: a failed `wiki query` is counted, not only printed.

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe("query runs", () => {
  it("treats an error or a missing catalog as a failure, and no answer as not", () => {
    expect(queryFailed("error")).toBe(true)
    expect(queryFailed("no-catalog")).toBe(true)
    expect(queryFailed("no-candidates")).toBe(false)
    expect(queryFailed("ok")).toBe(false)
  })

  it("appends one line per query and counts them by status", () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    const file = join(dir, "_query-runs.jsonl")
    recordQueryRun(file, { at: "2026-10-08T10:00:00.000Z", agent: "a", status: "ok", method: "summaries", wallMs: 4000 })
    recordQueryRun(file, { at: "2026-10-09T10:00:00.000Z", agent: "a", status: "error", wallMs: 1000 })
    recordQueryRun(file, { at: "2026-10-09T11:00:00.000Z", agent: "a", status: "ok", wallMs: 9000 })
    const text = readFileSync(file, "utf-8") + "not json\n"

    expect(summariseQueryRuns(text)).toEqual({
      total: 3, failed: 1, byStatus: { ok: 2, error: 1 }, bySource: { cli: 3 },
      byAgent: { a: { total: 3, failed: 1 } },
      byDay: { "2026-10-08": { total: 1, failed: 0 }, "2026-10-09": { total: 2, failed: 1 } },
      wallMsP50: 4000, wallMsP95: 9000,
    })
    expect(summariseQueryRuns(text, "2026-10-09")).toMatchObject({ total: 2, failed: 1 })
  })

  it("leaves no-catalog lines out of the times but counts them as failed", () => {
    const text = [
      { at: "2026-10-09T10:00:00.000Z", agent: "a", status: "ok", wallMs: 4000 },
      { at: "2026-10-09T10:01:00.000Z", agent: "", status: "no-catalog", source: "tool", wallMs: 0 },
      { at: "2026-10-09T10:02:00.000Z", agent: "", status: "no-catalog", source: "tool", wallMs: 0 },
    ].map((r) => JSON.stringify(r)).join("\n")

    expect(summariseQueryRuns(text)).toMatchObject({ total: 3, failed: 2, wallMsP50: 4000, wallMsP95: 4000 })
  })

  it("records a query that throws as an error and throws it on", async () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    const file = join(dir, "_query-runs.jsonl")
    await expect(timedQuery(file, "a", "tool", async () => { throw new Error("model down") })).rejects.toThrow("model down")
    const ok = await timedQuery(file, "a", "cli", async () => ({ status: "ok" as const, method: "summaries" }))
    expect(ok.status).toBe("ok")

    const text = readFileSync(file, "utf-8")
    expect(text).not.toContain("model down")
    expect(summariseQueryRuns(text)).toMatchObject({ total: 2, failed: 1, byStatus: { error: 1, ok: 1 }, bySource: { tool: 1, cli: 1 } })
  })

  it("cuts the file to its newest lines once it passes the size limit", () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    const file = join(dir, "_query-runs.jsonl")
    for (let i = 0; i < 100; i++) {
      recordQueryRun(file, { at: `2026-10-09T10:00:${String(i % 60).padStart(2, "0")}.000Z`, agent: `a${i}`, status: "ok", wallMs: i }, 2000)
    }
    expect(statSync(file).size).toBeLessThanOrEqual(2000)
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.map((l) => JSON.parse(l).agent).at(-1)).toBe("a99")
    expect(lines.every((l) => JSON.parse(l).status === "ok")).toBe(true)
  })

  it("never throws when the file cannot be written", () => {
    expect(() => recordQueryRun("/nonexistent-dir/x/_query-runs.jsonl", { at: "", agent: "a", status: "ok", wallMs: 0 })).not.toThrow()
  })

  it("wiki query exits 1 and records the failure when the agent has no catalog", async () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    withCatalog(dir, "other-agent")
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    await wiki.parseAsync(["query", "anything", "--dir", dir, "--agent", "a", "--own-only"], { from: "user" })

    expect(process.exitCode).toBe(1)
    const file = join(dir, "_query-runs.jsonl")
    expect(existsSync(file)).toBe(true)
    expect(summariseQueryRuns(readFileSync(file, "utf-8"))).toMatchObject({ total: 1, failed: 1, byStatus: { "no-catalog": 1 } })
  })

  it("wiki query on a folder with no wiki exits 1 and creates nothing there (#1820)", async () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    writeFileSync(join(dir, "CLAUDE.md"), "an agent workspace\n")
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    await wiki.parseAsync(["query", "anything", "--dir", dir], { from: "user" })

    expect(process.exitCode).toBe(1)
    expect(readdirSync(dir)).toEqual(["CLAUDE.md"])
  })

  it("wiki query on a file exits 1 instead of crashing (#1820)", async () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    const file = join(dir, "not-a-folder")
    writeFileSync(file, "")
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(wiki.parseAsync(["query", "anything", "--dir", file], { from: "user" })).resolves.toBeDefined()
    expect(process.exitCode).toBe(1)
  })

  it("wiki query given a node's folder reads the wiki inside it", async () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    withCatalog(join(dir, ".agentx/wiki"), "other-agent")
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    await wiki.parseAsync(["query", "anything", "--dir", dir, "--agent", "a", "--own-only"], { from: "user" })

    expect(process.exitCode).toBe(1)
    const file = join(dir, ".agentx/wiki/_query-runs.jsonl")
    expect(summariseQueryRuns(readFileSync(file, "utf-8"))).toMatchObject({ total: 1, byStatus: { "no-catalog": 1 } })
    expect(existsSync(join(dir, "agents"))).toBe(false)
  })

  it("an empty wiki left behind (agents/ only) is no wiki: the query falls through to the next one", async () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    mkdirSync(join(dir, "agents/coder-agent"), { recursive: true })
    expect(existingWikiDir(dir)).toBeNull()

    withCatalog(join(dir, ".agentx/wiki"), "other-agent")
    expect(existingWikiDir(dir)).toBe(join(dir, ".agentx/wiki"))
    expect(existingWikiDir(join(dir, ".agentx/wiki"))).toBe(join(dir, ".agentx/wiki"))
  })

  it("wiki query on an empty agents/-only wiki says no wiki and records nothing there", async () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    mkdirSync(join(dir, "agents"))
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    await wiki.parseAsync(["query", "anything", "--dir", dir, "--own-only"], { from: "user" })

    expect(process.exitCode).toBe(1)
    expect(log.mock.calls.flat().join(" ")).toContain("No wiki at")
    expect(readdirSync(dir)).toEqual(["agents"])
  })
})

function withCatalog(wikiDir: string, agent: string): void {
  mkdirSync(join(wikiDir, "agents", agent, "graph"), { recursive: true })
  writeFileSync(join(wikiDir, "agents", agent, "graph", "_index.md"), "# Catalog\n")
}
