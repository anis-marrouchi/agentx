import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROMPT, renderTable, writeFixture } from "../bench/compare-claude-code"

// #455 — the task the comparison benchmark hands to both sides must be a
// real multi-step fix: several tests fail for several reasons, and the
// prompt forbids touching the tests. No model is called here.

describe("bench:compare fixture", () => {
  it("fails five of ten tests across the four planted bugs, and passes once they are fixed", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-compare-"))
    try {
      writeFixture(dir)
      const before = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" })
      expect(before.status).not.toBe(0)
      expect(before.stdout).toMatch(/^# tests 10$/m)
      expect(before.stdout).toMatch(/^# fail 5$/m)
      // The fixes a correct run makes.
      const stats = join(dir, "src", "stats.js")
      const format = join(dir, "src", "format.js")
      const fixedStats = readFileSync(stats, "utf8")
        .replace("sum / (values.length + 1)", "sum / values.length")
        .replace("return sorted[Math.floor(sorted.length / 2)]", "const m = Math.floor(sorted.length / 2)\n  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2")
        .replace("return bestCount\n}", "return best\n}")
      const fixedFormat = readFileSync(format, "utf8").replace('lines.join(", ")', 'lines.join("\\n")')
      writeFileSync(stats, fixedStats)
      writeFileSync(format, fixedFormat)
      const after = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" })
      expect(after.status, after.stdout).toBe(0)
      expect(after.stdout).toMatch(/^# pass 10$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("asks for the tests to be run, fixed without touching test/, and run again", () => {
    expect(PROMPT).toContain("npm test")
    expect(PROMPT).toContain("Do not change anything under test/")
    expect(PROMPT).toContain("Run the tests again")
  })
})

describe("bench:compare table", () => {
  it("lists every run and the medians per mode, with the CLI cost when reported", () => {
    const base = { testsPass: true, testsUntouched: true, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10_000, cacheCreateTokens: 2_000, totalTokens: 12_150, wallMs: 30_000 }
    const table = renderTable([
      { ...base, mode: "claude", run: 1, ok: true, numTurns: 8, costUsd: 0.05 },
      { ...base, mode: "claude", run: 2, ok: true, numTurns: 10, costUsd: 0.07, wallMs: 50_000 },
      { ...base, mode: "agentx", run: 1, ok: false, testsPass: false, numTurns: 12, costUsd: 0.09 },
      { ...base, mode: "agentx", run: 2, ok: true, numTurns: 9 },
    ] as any, { runs: 2, model: "claude-haiku-4-5-20251001", modes: ["claude", "agentx"], keep: false, timeoutMinutes: 10 })
    expect(table).toContain("| claude | 1 | yes | 8 |")
    expect(table).toContain("| agentx | 1 | no (tests fail) | 12 |")
    expect(table).toContain("| claude | 2/2 | 9 |")
    expect(table).toContain("| agentx | 1/2 | 10.5 |")
    expect(table).toContain("$0.0600")
    expect(table).toContain("$0.0900")
    expect(table).toContain("| 40s |")
  })
})
