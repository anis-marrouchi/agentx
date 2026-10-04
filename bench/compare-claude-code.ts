// Level 1, small: the same multi-step coding task run on the bare Claude
// Code CLI and through AgentX (`agentx exec`), same model, same prompt,
// several times each. Prints tokens, turns, wall time, the CLI's own cost
// figure, and whether the task came out right. The first measured run of
// #455 (AgentX against Claude Code alone).
//
//   pnpm bench:compare                      # 3 runs each, Haiku, modes claude,agentx,agentx-lean
//   pnpm bench:compare --runs 5 --model claude-sonnet-5-5
//   pnpm bench:compare --modes claude,agentx --json out.json
//   pnpm bench:compare --keep               # keep the work directories
//
// Every run calls the model and costs money (cents on Haiku, more on larger
// models). The CLI must be signed in; both sides bill the same account.
//
// The task: a tiny Node project whose tests fail because of four bugs
// across two source files. The agent has to run the tests, read the
// code, fix it, and run the tests again. The check afterwards is
// mechanical: the tests pass, and the test file is untouched.
//
// What each mode is:
//   claude       `claude -p <prompt> --dangerously-skip-permissions` in a
//                fresh copy of the project. No CLAUDE.md, no AgentX.
//   agentx       `agentx exec` with one `claude-code` agent whose workspace
//                is the same fresh copy, the managed workspace files
//                written first as the daemon does, the `exec` channel
//                (full profile).
//   agentx-lean  the same with `--profile lean` (#615).
//
// Only the agentx MCP tool server differs in tooling: the bare CLI has
// none, AgentX gives the agent its own. The guard hook fails open without
// a daemon, so no tool call is blocked.

import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { primaryModelFromUsage } from "../src/agents/model-usage"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")

type Mode = "claude" | "agentx" | "agentx-lean"

interface Options {
  runs: number
  model: string
  modes: Mode[]
  json?: string
  keep: boolean
  timeoutMinutes: number
}

interface RunResult {
  mode: Mode
  run: number
  ok: boolean
  testsPass: boolean
  testsUntouched: boolean
  error?: string
  numTurns?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  totalTokens: number
  costUsd?: number
  wallMs: number
  reportedMs?: number
  billedModel?: string
}

export const PROMPT = [
  "Run `npm test` in this project. Some tests fail.",
  "Fix the code under src/ so that every test passes. Do not change anything under test/.",
  "Run the tests again to confirm, then reply with one line: how many tests pass.",
].join(" ")

/** The project the task works on. Four bugs: mean divides by n+1, median
 *  ignores even lengths, mode returns the count instead of the value, and
 *  the report formats the range with the wrong separator. */
export function writeFixture(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true })
  mkdirSync(join(dir, "test"), { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "stats-fixture", version: "1.0.0", private: true, type: "module",
    scripts: { test: "node --test" },
  }, null, 2) + "\n")
  writeFileSync(join(dir, "src", "stats.js"), `// Small statistics helpers.
export function mean(values) {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / (values.length + 1)
}

export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function mode(values) {
  if (values.length === 0) return null
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  let best = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count }
  }
  return bestCount
}

export function range(values) {
  if (values.length === 0) return 0
  return Math.max(...values) - Math.min(...values)
}
`)
  writeFileSync(join(dir, "src", "format.js"), `import { mean, median, mode, range } from "./stats.js"

/** One line per statistic, "name: value", joined by newlines. */
export function formatReport(values) {
  const lines = [
    \`mean: \${mean(values)}\`,
    \`median: \${median(values)}\`,
    \`mode: \${mode(values)}\`,
    \`range: \${range(values)}\`,
  ]
  return lines.join(", ")
}
`)
  writeFileSync(join(dir, "test", "stats.test.js"), `import { test } from "node:test"
import assert from "node:assert/strict"
import { mean, median, mode, range } from "../src/stats.js"
import { formatReport } from "../src/format.js"

test("mean of an empty list is 0", () => assert.equal(mean([]), 0))
test("mean of 2, 4, 6 is 4", () => assert.equal(mean([2, 4, 6]), 4))
test("mean of one value is that value", () => assert.equal(mean([7]), 7))
test("median of an odd count is the middle value", () => assert.equal(median([5, 1, 3]), 3))
test("median of an even count is the average of the two middle values", () => assert.equal(median([1, 2, 3, 4]), 2.5))
test("median of an empty list is 0", () => assert.equal(median([]), 0))
test("mode is the most frequent value, not its count", () => assert.equal(mode([5, 7, 5]), 5))
test("mode of an empty list is null", () => assert.equal(mode([]), null))
test("range is max minus min", () => assert.equal(range([4, 9, 1]), 8))
test("report has one statistic per line", () => {
  assert.equal(formatReport([1, 2, 2, 3]), "mean: 2\\nmedian: 2\\nmode: 2\\nrange: 2")
})
`)
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { runs: 3, model: "claude-haiku-4-5-20251001", modes: ["claude", "agentx", "agentx-lean"], keep: false, timeoutMinutes: 10 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--runs") opts.runs = Math.max(1, Number(next()))
    else if (a === "--model") opts.model = next()
    else if (a === "--modes") opts.modes = next().split(",").map((m) => m.trim()).filter(Boolean) as Mode[]
    else if (a === "--json") opts.json = next()
    else if (a === "--keep") opts.keep = true
    else if (a === "--timeout") opts.timeoutMinutes = Math.max(1, Number(next()))
    else if (a === "-h" || a === "--help") { console.log(usage()); process.exit(0) }
    else { console.error(`unknown option ${a}\n${usage()}`); process.exit(2) }
  }
  for (const m of opts.modes) {
    if (!["claude", "agentx", "agentx-lean"].includes(m)) { console.error(`unknown mode "${m}"`); process.exit(2) }
  }
  return opts
}

function usage(): string {
  return "pnpm bench:compare [--runs N] [--model id] [--modes claude,agentx,agentx-lean] [--json file] [--keep] [--timeout minutes]"
}

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function testsPass(dir: string): boolean {
  const r = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
  return r.status === 0
}

interface Parsed {
  error?: string
  numTurns?: number
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }
  costUsd?: number
  reportedMs?: number
  billedModel?: string
}

function parseClaude(stdout: string): Parsed {
  const d = JSON.parse(stdout)
  const u = d.usage ?? {}
  return {
    error: d.is_error ? String(d.result ?? "error") : undefined,
    numTurns: d.num_turns,
    usage: {
      inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
    },
    costUsd: typeof d.total_cost_usd === "number" ? d.total_cost_usd : undefined,
    reportedMs: d.duration_ms,
    billedModel: primaryModelFromUsage(d.modelUsage),
  }
}

function parseAgentx(stdout: string): Parsed {
  const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}"
  const d = JSON.parse(line)
  const u = d.usage ?? {}
  return {
    error: d.error,
    numTurns: d.numTurns,
    usage: {
      inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0, cacheCreateTokens: u.cacheCreateTokens ?? 0,
    },
    costUsd: typeof d.costUsd === "number" ? d.costUsd : undefined,
    reportedMs: d.durationMs,
    billedModel: d.billedModel,
  }
}

function runOnce(mode: Mode, run: number, opts: Options, root: string): RunResult {
  const dir = join(root, `${mode}-${run}`)
  const work = join(dir, "work")
  writeFixture(work)
  const testFile = join(work, "test", "stats.test.js")
  const before = sha(testFile)
  const timeoutMs = opts.timeoutMinutes * 60_000
  const env = { ...process.env }
  let parsed: Parsed
  const started = Date.now()
  if (mode === "claude") {
    const r = spawnSync("claude", [
      "-p", PROMPT, "--model", opts.model, "--output-format", "json", "--dangerously-skip-permissions",
    ], { cwd: work, encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 })
    parsed = r.status === 0 || (r.stdout && r.stdout.trim().startsWith("{"))
      ? safeParse(() => parseClaude(r.stdout), r.stderr)
      : { error: (r.stderr || `claude exited ${r.status}`).trim().slice(0, 500), usage: zeroUsage() }
  } else {
    const state = join(dir, "state")
    mkdirSync(state, { recursive: true })
    const configPath = join(state, "agentx.json")
    writeFileSync(configPath, JSON.stringify({
      node: { id: "bench", name: "Bench", bind: "127.0.0.1:18899" },
      agents: {
        bench: {
          name: "Bench", workspace: work, tier: "claude-code", permissionMode: "bypassPermissions",
          maxExecutionMinutes: opts.timeoutMinutes, systemPrompt: "You are a careful software engineer. Keep answers short.",
        },
      },
    }, null, 2))
    const args = [join(REPO, "dist/cli.js"), "exec", "-a", "bench", "-c", configPath, "--setup-workspace", "--json",
      "-m", opts.model, "--channel", "exec", "--timeout", String(opts.timeoutMinutes)]
    if (mode === "agentx-lean") args.push("--profile", "lean")
    const r = spawnSync(process.execPath, args, { cwd: state, input: PROMPT, encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 })
    parsed = r.stdout && r.stdout.includes("{")
      ? safeParse(() => parseAgentx(r.stdout), r.stderr)
      : { error: (r.stderr || `agentx exited ${r.status}`).trim().slice(-500), usage: zeroUsage() }
  }
  const wallMs = Date.now() - started
  const untouched = existsSync(testFile) && sha(testFile) === before
  const pass = untouched && testsPass(work)
  const u = parsed.usage
  return {
    mode, run, ok: !parsed.error && pass, testsPass: pass, testsUntouched: untouched, error: parsed.error,
    numTurns: parsed.numTurns,
    inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheCreateTokens: u.cacheCreateTokens,
    totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreateTokens,
    costUsd: parsed.costUsd, wallMs, reportedMs: parsed.reportedMs, billedModel: parsed.billedModel,
  }
}

function zeroUsage() { return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 } }

function safeParse(parse: () => Parsed, stderr: string): Parsed {
  try { return parse() } catch (e: any) { return { error: `unreadable output: ${e?.message} ${(stderr || "").slice(-300)}`, usage: zeroUsage() } }
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function fmtK(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n) }
function fmtUsd(n?: number): string { return n === undefined ? "-" : `$${n.toFixed(4)}` }
function fmtS(ms?: number): string { return ms === undefined ? "-" : `${(ms / 1000).toFixed(0)}s` }

export function renderTable(results: RunResult[], opts: Options): string {
  const lines: string[] = []
  lines.push(`Model: ${opts.model}. Runs per mode: ${opts.runs}. Task: fix four bugs so ten tests pass.`, "")
  lines.push("| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |")
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|")
  for (const r of results) {
    const correct = r.ok ? "yes" : r.error ? `no (${r.error.slice(0, 40).replace(/\|/g, "/")})` : r.testsUntouched ? "no (tests fail)" : "no (tests edited)"
    lines.push(`| ${r.mode} | ${r.run} | ${correct} | ${r.numTurns ?? "-"} | ${fmtK(r.inputTokens)} | ${fmtK(r.outputTokens)} | ${fmtK(r.cacheReadTokens)} | ${fmtK(r.cacheCreateTokens)} | ${fmtK(r.totalTokens)} | ${fmtUsd(r.costUsd)} | ${fmtS(r.wallMs)} |`)
  }
  lines.push("", "Medians per mode:", "")
  lines.push("| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |")
  lines.push("|---|---|---|---|---|---|---|")
  for (const mode of opts.modes) {
    const rs = results.filter((r) => r.mode === mode)
    if (!rs.length) continue
    const ok = rs.filter((r) => r.ok).length
    const costs = rs.map((r) => r.costUsd).filter((c): c is number => typeof c === "number")
    lines.push(`| ${mode} | ${ok}/${rs.length} | ${median(rs.map((r) => r.numTurns ?? 0))} | ${fmtK(median(rs.map((r) => r.totalTokens)))} | ${fmtK(median(rs.map((r) => r.cacheReadTokens)))} | ${costs.length ? fmtUsd(median(costs)) : "-"} | ${fmtS(median(rs.map((r) => r.wallMs)))} |`)
  }
  return lines.join("\n")
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(join(REPO, "dist/cli.js")) && opts.modes.some((m) => m !== "claude")) {
    console.error("dist/cli.js is missing: run `pnpm build` first")
    process.exit(2)
  }
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }) } catch {
    console.error("the `claude` CLI is not on PATH")
    process.exit(2)
  }
  const root = mkdtempSync(join(tmpdir(), "agentx-compare-"))
  console.error(`work directories under ${root}${opts.keep ? "" : " (removed at the end; --keep keeps them)"}`)
  const results: RunResult[] = []
  // Interleave the modes so a slow hour hits every mode the same way.
  for (let run = 1; run <= opts.runs; run++) {
    for (const mode of opts.modes) {
      console.error(`[${mode} ${run}/${opts.runs}] running…`)
      const r = runOnce(mode, run, opts, root)
      results.push(r)
      console.error(`[${mode} ${run}/${opts.runs}] ${r.ok ? "correct" : "NOT correct"} turns=${r.numTurns ?? "-"} tokens=${fmtK(r.totalTokens)} cost=${fmtUsd(r.costUsd)} wall=${fmtS(r.wallMs)}${r.error ? ` error=${r.error.slice(0, 120)}` : ""}`)
    }
  }
  const table = renderTable(results, opts)
  console.log(table)
  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify({ model: opts.model, runs: opts.runs, prompt: PROMPT, at: new Date().toISOString(), results }, null, 2) + "\n")
    console.error(`raw results written to ${opts.json}`)
  }
  if (!opts.keep) rmSync(root, { recursive: true, force: true })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch((e) => { console.error(e); process.exit(1) })
