import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { queryFailed, recordQueryRun, summariseQueryRuns, timedQuery } from "../../src/wiki/query-runs"
import { wiki } from "../../src/commands/wiki"

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
      total: 3, failed: 1, byStatus: { ok: 2, error: 1 }, bySource: { cli: 3 }, wallMsP50: 4000, wallMsP95: 9000,
    })
    expect(summariseQueryRuns(text, "2026-10-09")).toMatchObject({ total: 2, failed: 1 })
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

  it("wiki query exits 1 and records the failure when no agent has a catalog", async () => {
    dir = mkdtempSync(join(tmpdir(), "query-runs-"))
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    await wiki.parseAsync(["query", "anything", "--dir", dir, "--own-only"], { from: "user" })

    expect(process.exitCode).toBe(1)
    const file = join(dir, "_query-runs.jsonl")
    expect(existsSync(file)).toBe(true)
    expect(summariseQueryRuns(readFileSync(file, "utf-8"))).toMatchObject({ total: 1, failed: 1, byStatus: { "no-catalog": 1 } })
  })
})
