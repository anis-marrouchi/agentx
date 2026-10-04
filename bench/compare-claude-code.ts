// The same coding tasks run on the bare Claude Code CLI and through AgentX
// (`agentx exec`), same model, same prompt, several times each. Prints
// tokens, turns, wall time, the CLI's own cost figure, whether each task
// came out right, and, against the bare CLI, the ratio of medians with a
// 95% bootstrap interval and a verdict. Measures #455 (AgentX against
// Claude Code alone).
//
//   pnpm bench:compare                      # 3 runs each, Haiku, task fix-bugs, modes claude,agentx,agentx-lean
//   pnpm bench:compare --runs 10 --model claude-sonnet-5-5 --tasks all --json out.json
//   pnpm bench:compare --modes claude,agentx --tasks trace
//   pnpm bench:compare --keep               # keep the work directories
//
// Every run calls the model and costs money (cents on Haiku, more on larger
// models). The CLI must be signed in; both sides bill the same account.
//
// The tasks are in compare-tasks.ts: small Node projects with failing
// tests. The check afterwards is mechanical: the tests pass, and no file
// under test/ changed.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { primaryModelFromUsage } from "../src/agents/model-usage"
import { type CompareTask, TASKS, taskById } from "./compare-tasks"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")

type Mode = "claude" | "agentx" | "agentx-lean"

interface Options {
  runs: number
  model: string
  modes: Mode[]
  /** Task ids from compare-tasks.ts; runs interleave across them too. */
  tasks: string[]
  json?: string
  keep: boolean
  timeoutMinutes: number
}

export interface RunResult {
  task?: string
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

const FIX_BUGS = taskById("fix-bugs")!

/** The prompt of the first task, kept under its old name. */
export const PROMPT = FIX_BUGS.prompt

/** Write a task's project into dir (the first task by default). */
export function writeFixture(dir: string, task: CompareTask = FIX_BUGS): void {
  for (const [path, content] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { runs: 3, model: "claude-haiku-4-5-20251001", modes: ["claude", "agentx", "agentx-lean"], tasks: ["fix-bugs"], keep: false, timeoutMinutes: 10 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--runs") opts.runs = Math.max(1, Number(next()))
    else if (a === "--model") opts.model = next()
    else if (a === "--modes") opts.modes = next().split(",").map((m) => m.trim()).filter(Boolean) as Mode[]
    else if (a === "--tasks") {
      const v = next()
      opts.tasks = v === "all" ? TASKS.map((t) => t.id) : v.split(",").map((t) => t.trim()).filter(Boolean)
    }
    else if (a === "--json") opts.json = next()
    else if (a === "--keep") opts.keep = true
    else if (a === "--timeout") opts.timeoutMinutes = Math.max(1, Number(next()))
    else if (a === "-h" || a === "--help") { console.log(usage()); process.exit(0) }
    else { console.error(`unknown option ${a}\n${usage()}`); process.exit(2) }
  }
  for (const m of opts.modes) {
    if (!["claude", "agentx", "agentx-lean"].includes(m)) { console.error(`unknown mode "${m}"`); process.exit(2) }
  }
  for (const t of opts.tasks) {
    if (!taskById(t)) { console.error(`unknown task "${t}" (known: ${TASKS.map((x) => x.id).join(", ")}, or all)`); process.exit(2) }
  }
  return opts
}

function usage(): string {
  return "pnpm bench:compare [--runs N] [--model id] [--modes claude,agentx,agentx-lean] [--tasks fix-bugs,implement,trace|all] [--json file] [--keep] [--timeout minutes]"
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

function runOnce(task: CompareTask, mode: Mode, run: number, opts: Options, root: string): RunResult {
  const dir = join(root, `${task.id}-${mode}-${run}`)
  const work = join(dir, "work")
  writeFixture(work, task)
  const testFiles = Object.keys(task.files).filter((f) => f.startsWith("test/")).map((f) => join(work, f))
  const before = testFiles.map(sha)
  const prompt = task.prompt
  const timeoutMs = opts.timeoutMinutes * 60_000
  const env = { ...process.env }
  let parsed: Parsed
  const started = Date.now()
  if (mode === "claude") {
    const r = spawnSync("claude", [
      "-p", prompt, "--model", opts.model, "--output-format", "json", "--dangerously-skip-permissions",
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
    const r = spawnSync(process.execPath, args, { cwd: state, input: prompt, encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 })
    parsed = r.stdout && r.stdout.includes("{")
      ? safeParse(() => parseAgentx(r.stdout), r.stderr)
      : { error: (r.stderr || `agentx exited ${r.status}`).trim().slice(-500), usage: zeroUsage() }
  }
  const wallMs = Date.now() - started
  const untouched = testFiles.every((f, i) => existsSync(f) && sha(f) === before[i])
  const pass = untouched && testsPass(work)
  const u = parsed.usage
  return {
    task: task.id, mode, run, ok: !parsed.error && pass, testsPass: pass, testsUntouched: untouched, error: parsed.error,
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
  lines.push(`Model: ${opts.model}. Runs per mode: ${opts.runs}.`)
  const taskIds = [...new Set(results.map((r) => r.task))]
  for (const taskId of taskIds) {
    const task = taskId ? taskById(taskId) : undefined
    const rs = results.filter((r) => r.task === taskId)
    lines.push("")
    if (task) lines.push(`### Task ${task.id}: ${task.title}`, "")
    lines.push("| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |")
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|")
    for (const r of rs) {
      const correct = r.ok ? "yes" : r.error ? `no (${r.error.slice(0, 40).replace(/\|/g, "/")})` : r.testsUntouched ? "no (tests fail)" : "no (tests edited)"
      lines.push(`| ${r.mode} | ${r.run} | ${correct} | ${r.numTurns ?? "-"} | ${fmtK(r.inputTokens)} | ${fmtK(r.outputTokens)} | ${fmtK(r.cacheReadTokens)} | ${fmtK(r.cacheCreateTokens)} | ${fmtK(r.totalTokens)} | ${fmtUsd(r.costUsd)} | ${fmtS(r.wallMs)} |`)
    }
    lines.push("", "Medians per mode:", "")
    lines.push("| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |")
    lines.push("|---|---|---|---|---|---|---|")
    for (const mode of opts.modes) {
      const ms = rs.filter((r) => r.mode === mode)
      if (!ms.length) continue
      const ok = ms.filter((r) => r.ok).length
      const costs = ms.map((r) => r.costUsd).filter((c): c is number => typeof c === "number")
      lines.push(`| ${mode} | ${ok}/${ms.length} | ${median(ms.map((r) => r.numTurns ?? 0))} | ${fmtK(median(ms.map((r) => r.totalTokens)))} | ${fmtK(median(ms.map((r) => r.cacheReadTokens)))} | ${costs.length ? fmtUsd(median(costs)) : "-"} | ${fmtS(median(ms.map((r) => r.wallMs)))} |`)
    }
  }
  const verdicts = compareToBare(results, opts.modes)
  if (verdicts.length) lines.push("", renderVerdicts(verdicts))
  return lines.join("\n")
}

// --- The decision: is an AgentX mode's token use (or cost) different
// from the bare CLI's, and by how much? The ratio of medians (AgentX over
// bare) per task, with a 95% bootstrap interval, and across tasks the
// geometric mean of those ratios. Every run counts, correct or not: tokens
// spent on a wrong answer are still spent. The interval decides:
//   upper bound below 1   AgentX uses less
//   lower bound above 1   AgentX uses more
//   otherwise             no clear difference at this sample size
// and "within 10%" when the whole interval sits between 0.90 and 1.10.

export type Metric = "totalTokens" | "costUsd"

export interface Verdict {
  metric: Metric
  mode: Mode
  /** Undefined for the row pooled over every task. */
  task?: string
  ratio: number
  lo: number
  hi: number
  runs: { agentx: number; bare: number }
  verdict: "less" | "more" | "unclear"
  within10: boolean
}

/** A small seeded generator so the same results give the same interval. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function resample(values: number[], rand: () => number): number[] {
  return values.map(() => values[Math.floor(rand() * values.length)])
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[i]
}

function values(rs: RunResult[], metric: Metric): number[] {
  return rs.map((r) => r[metric]).filter((v): v is number => typeof v === "number" && v > 0)
}

export function compareToBare(results: RunResult[], modes: Mode[], iterations = 5000): Verdict[] {
  if (!modes.includes("claude")) return []
  const out: Verdict[] = []
  const taskIds = [...new Set(results.map((r) => r.task))]
  for (const metric of ["totalTokens", "costUsd"] as Metric[]) {
    for (const mode of modes.filter((m) => m !== "claude")) {
      const pairs = taskIds.map((task) => ({
        task,
        a: values(results.filter((r) => r.task === task && r.mode === mode), metric),
        b: values(results.filter((r) => r.task === task && r.mode === "claude"), metric),
      })).filter((p) => p.a.length >= 2 && p.b.length >= 2)
      if (!pairs.length) continue
      const rand = rng(455)
      const perTask = pairs.map(() => [] as number[])
      const pooled: number[] = []
      for (let i = 0; i < iterations; i++) {
        let logSum = 0
        pairs.forEach((p, k) => {
          const ratio = median(resample(p.a, rand)) / median(resample(p.b, rand))
          perTask[k].push(ratio)
          logSum += Math.log(ratio)
        })
        pooled.push(Math.exp(logSum / pairs.length))
      }
      const make = (task: string | undefined, ratio: number, draws: number[], runs: { agentx: number; bare: number }): Verdict => {
        const sorted = [...draws].sort((x, y) => x - y)
        const lo = percentile(sorted, 0.025)
        const hi = percentile(sorted, 0.975)
        return { metric, mode, task, ratio, lo, hi, runs, verdict: hi < 1 ? "less" : lo > 1 ? "more" : "unclear", within10: lo >= 0.9 && hi <= 1.1 }
      }
      const ratios = pairs.map((p) => median(p.a) / median(p.b))
      pairs.forEach((p, k) => out.push(make(p.task, ratios[k], perTask[k], { agentx: p.a.length, bare: p.b.length })))
      if (pairs.length > 1) {
        const geo = Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length)
        out.push(make(undefined, geo, pooled, {
          agentx: pairs.reduce((n, p) => n + p.a.length, 0), bare: pairs.reduce((n, p) => n + p.b.length, 0),
        }))
      }
    }
  }
  return out
}

export function renderVerdicts(verdicts: Verdict[]): string {
  const pct = (x: number) => `${x >= 1 ? "+" : ""}${((x - 1) * 100).toFixed(0)}%`
  const word = (v: Verdict) => {
    const what = v.metric === "costUsd" ? "costs" : "uses"
    const base = v.verdict === "less" ? `${what} less` : v.verdict === "more" ? `${what} more` : "no clear difference"
    return v.within10 ? `${base}; within 10%` : base
  }
  const lines = [
    "Against the bare CLI (AgentX median over bare median, 95% bootstrap interval; every run counts):",
    "",
    "| Metric | Mode | Task | Runs (AgentX/bare) | Ratio | 95% interval | Verdict |",
    "|---|---|---|---|---|---|---|",
  ]
  for (const v of verdicts) {
    lines.push(`| ${v.metric === "costUsd" ? "cost" : "tokens"} | ${v.mode} | ${v.task ?? "all tasks"} | ${v.runs.agentx}/${v.runs.bare} | ${v.ratio.toFixed(2)} (${pct(v.ratio)}) | ${v.lo.toFixed(2)} to ${v.hi.toFixed(2)} | ${word(v)} |`)
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
  const tasks = opts.tasks.map((id) => taskById(id)!)
  const results: RunResult[] = []
  const save = () => {
    if (!opts.json) return
    writeFileSync(opts.json, JSON.stringify({
      model: opts.model, runs: opts.runs, modes: opts.modes,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, prompt: t.prompt })),
      at: new Date().toISOString(), results,
    }, null, 2) + "\n")
  }
  // Interleave tasks and modes so a slow hour hits every mode the same way.
  // The raw file is rewritten after every run, so a long series that stops
  // part way keeps what it measured.
  const total = opts.runs * tasks.length * opts.modes.length
  for (let run = 1; run <= opts.runs; run++) {
    for (const task of tasks) {
      for (const mode of opts.modes) {
        const tag = `[${results.length + 1}/${total} ${task.id} ${mode} ${run}/${opts.runs}]`
        console.error(`${tag} running…`)
        const r = runOnce(task, mode, run, opts, root)
        results.push(r)
        save()
        console.error(`${tag} ${r.ok ? "correct" : "NOT correct"} turns=${r.numTurns ?? "-"} tokens=${fmtK(r.totalTokens)} cost=${fmtUsd(r.costUsd)} wall=${fmtS(r.wallMs)}${r.error ? ` error=${r.error.slice(0, 120)}` : ""}`)
      }
    }
  }
  console.log(renderTable(results, opts))
  if (opts.json) console.error(`raw results written to ${opts.json}`)
  if (!opts.keep) rmSync(root, { recursive: true, force: true })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch((e) => { console.error(e); process.exit(1) })
