import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CACHE_AWARE_PRICING } from "../src/daemon/token-tracker"

// bench/slice-replay.py (#928) reads Claude Code session logs. Each fake
// session below has 4 requests: gh pr view, then gh pr diff, then a memory
// edit, then a reply with no tool. Every request re-reads 1M cached tokens
// on Opus 5 (0.50 USD) and writes 100 output tokens.
const ROOT = resolve(__dirname, "..")
const run = (args: string[]) => spawnSync("python3", ["bench/slice-replay.py", ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 })

function line(id: string, content: unknown[]) {
  return JSON.stringify({
    type: "assistant", isSidechain: false, timestamp: "2026-10-10T08:00:00Z",
    message: { id, model: "claude-opus-5-5", content, usage: { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 } },
  })
}
const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `t${Math.random()}`, name, input })

function session(n: number): string {
  return [
    line(`m${n}a`, [tool("Bash", { command: `cd /w && gh pr view ${n} --json body` })]),
    // A message split over two lines repeats its usage; it is counted once.
    line(`m${n}b`, [{ type: "text", text: "ok" }]),
    line(`m${n}b`, [tool("Bash", { command: `gh pr diff ${n}` })]),
    line(`m${n}c`, [tool("Edit", { file_path: "/w/memory/notes.md", old_string: "a", new_string: "b" })]),
    line(`m${n}d`, [{ type: "text", text: "done" }]),
  ].join("\n")
}

describe("bench/slice-replay.py", () => {
  let dir = ""
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "slice-replay-"))
    for (const [seat, ids] of [["seat-a", [1, 2, 3]], ["seat-b", [4, 5]]] as const) {
      mkdirSync(join(dir, seat))
      for (const n of ids) writeFileSync(join(dir, seat, `s${n}.jsonl`), session(n))
    }
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("keeps its price table equal to the dashboard's", () => {
    const r = run(["prices"])
    expect(r.error, "python3 must be on PATH").toBeUndefined()
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(CACHE_AWARE_PRICING)
  })

  it("counts a slice repeated across sessions and seats and prices the round trips it removes", () => {
    const out = join(dir, "count.json")
    const r = run(["count", "--from", "2026-10-09", "--to", "2026-10-12", "--projects", dir, "--json", out])
    expect(r.status, r.stderr).toBe(0)
    const c = JSON.parse(readFileSync(out, "utf8"))
    expect(c).toMatchObject({ sessions: 5, seats: 2, toolRequests: 15, calls: 15, coveredCalls: 15, coveredShare: 100 })
    expect(c.topPatterns[0].slice).toEqual(["bash:gh pr view", "bash:gh pr diff", "Edit:memory"])
    // 2 of 4 requests removed per session: re-reads 0.50 of 2.0125 USD each.
    const perRequest = 0.5 + 100 / 1e6 * 25
    expect(c.savingLowPct).toBeCloseTo((2 * 0.5) / (4 * perRequest) * 100, 1)
    expect(c.savingHighPct).toBeCloseTo(50, 1)
  })

  it("needs the slice on enough seats", () => {
    const out = join(dir, "count3.json")
    const r = run(["count", "--from", "2026-10-09", "--to", "2026-10-12", "--projects", dir, "--min-seats", "3", "--json", out])
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ patterns: 0, coveredCalls: 0, savingHighPct: 0 })
  })

  it("marks a catalog on unseen sessions only and writes a bounded hand check", () => {
    const mine = join(dir, "mine")
    let r = run(["outline", "--from", "2026-10-09", "--to", "2026-10-12", "--projects", dir, "--sample", "2", "--out", mine])
    expect(r.status, r.stderr).toBe(0)
    const seen: string[] = JSON.parse(readFileSync(join(mine, "seen.json"), "utf8"))
    expect(seen).toHaveLength(2)

    const catalog = join(dir, "catalog.json")
    writeFileSync(catalog, JSON.stringify([{ id: "pr-read", steps: ["^bash:gh pr view\\t", "^bash:gh pr diff\\t"] }]))
    const marked = join(dir, "marked")
    r = run(["mark", "--from", "2026-10-09", "--to", "2026-10-12", "--projects", dir, "--catalog", catalog, "--seen", join(mine, "seen.json"), "--out", marked])
    expect(r.status, r.stderr).toBe(0)
    const m = JSON.parse(readFileSync(join(marked, "mark.json"), "utf8"))
    expect(m).toMatchObject({ unseenSessions: 3, leftOut: 2, places: 3 })
    expect(m.savingHighPct).toBeCloseTo(25, 1)
    const check = readFileSync(join(marked, "hand-check.md"), "utf8")
    expect(check).toContain("gh pr view <n> --json body")
    expect(check).toContain("next: `Edit:memory  /w/memory/notes.md`")
    expect(check).not.toContain("old_string")
  })
})
