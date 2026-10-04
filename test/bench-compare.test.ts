import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compareToBare, PROMPT, renderTable, renderVerdicts, writeFixture } from "../bench/compare-claude-code"
import { TASKS } from "../bench/compare-tasks"

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

describe("bench:compare tasks", () => {
  for (const task of TASKS) {
    it(`${task.id}: fails as written and passes with the reference edits, which touch only src/`, () => {
      const dir = mkdtempSync(join(tmpdir(), `bench-${task.id}-`))
      try {
        writeFixture(dir, task)
        const before = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" })
        expect(before.status).not.toBe(0)
        for (const [path, content] of Object.entries(task.reference)) {
          expect(path.startsWith("src/")).toBe(true)
          expect(content).not.toBe(task.files[path])
          writeFileSync(join(dir, path), content)
        }
        const after = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" })
        expect(after.status, after.stdout).toBe(0)
        expect(after.stdout).toMatch(/^# fail 0$/m)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it("fails the planted number of tests per task", () => {
    const failing: Record<string, string> = { "fix-bugs": "5", implement: "13", trace: "5" }
    for (const task of TASKS) {
      const dir = mkdtempSync(join(tmpdir(), `bench-${task.id}-`))
      try {
        writeFixture(dir, task)
        const r = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" })
        expect(r.stdout, task.id).toMatch(new RegExp(`^# fail ${failing[task.id]}$`, "m"))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})

describe("bench:compare verdict", () => {
  const run = (task: string, mode: string, totalTokens: number, costUsd: number) =>
    ({ task, mode, run: 1, ok: true, testsPass: true, testsUntouched: true, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens, costUsd, wallMs: 1000 }) as any

  it("calls a clear gap more or less, and overlapping samples unclear", () => {
    const results = [
      ...[100, 102, 98, 101, 99].map((t) => run("a", "claude", t * 1000, t / 1000)),
      ...[130, 128, 132, 131, 129].map((t) => run("a", "agentx", t * 1000, t / 1000)),
      ...[80, 120, 95, 105, 90].map((t) => run("a", "agentx-lean", t * 1000, t / 1000)),
    ]
    const v = compareToBare(results, ["claude", "agentx", "agentx-lean"])
    const tokens = (mode: string) => v.find((x) => x.metric === "totalTokens" && x.mode === mode)!
    expect(tokens("agentx").verdict).toBe("more")
    expect(tokens("agentx").ratio).toBeCloseTo(1.3, 2)
    expect(tokens("agentx").lo).toBeGreaterThan(1)
    expect(tokens("agentx-lean").verdict).toBe("unclear")
    expect(tokens("agentx-lean").lo).toBeLessThan(1)
    expect(tokens("agentx-lean").hi).toBeGreaterThan(1)
    expect(renderVerdicts(v)).toContain("| tokens | agentx | a | 5/5 | 1.30 (+30%) |")
  })

  it("pools tasks with the geometric mean of the per-task ratios", () => {
    const results = [
      ...[100, 100, 100].map((t) => run("a", "claude", t, t)),
      ...[200, 200, 200].map((t) => run("a", "agentx", t, t)),
      ...[100, 100, 100].map((t) => run("b", "claude", t, t)),
      ...[50, 50, 50].map((t) => run("b", "agentx", t, t)),
    ]
    const pooled = compareToBare(results, ["claude", "agentx"]).find((x) => x.metric === "totalTokens" && x.task === undefined)!
    expect(pooled.ratio).toBeCloseTo(1, 5)
    expect(pooled.runs).toEqual({ agentx: 6, bare: 6 })
    expect(pooled.within10).toBe(true)
  })
})
