import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { queryFailed, recordQueryRun, summariseQueryRuns } from "../../src/wiki/query-runs"
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
      total: 3, failed: 1, byStatus: { ok: 2, error: 1 }, wallMsP50: 4000, wallMsP95: 9000,
    })
    expect(summariseQueryRuns(text, "2026-10-09")).toMatchObject({ total: 2, failed: 1 })
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
