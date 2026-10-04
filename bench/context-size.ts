// Level 0 benchmark: how much context agentx adds before the model starts.
//
//   pnpm bench:context                         # clean bench agent, estimate
//   pnpm bench:context --exact                 # exact counts (free Anthropic
//                                              # count_tokens; needs ANTHROPIC_API_KEY)
//   pnpm bench:context --budget 4000           # exit 1 above 4000 tokens
//   pnpm bench:context --config agentx.json --agent devops   # a real agent
//   pnpm bench:context --channel github --sections          # one channel, split
//                                              # by prompt section (#615)
//   pnpm bench:context --channel a2a --profile lean          # force a profile
//
// It runs the real `agentx exec` path, but with a fake `claude` first on
// PATH that records what agentx hands it and returns an empty result. No
// model is called, so it costs nothing and is deterministic: run it on
// every commit.
//
// What it counts, for a fresh session on the claude-code tier:
//   preamble   the --append-system-prompt text (agent system prompt etc.)
//   prompt     the -p text minus the task itself: every context layer
//              agentx prepends or appends (wiki, skills, memory, history…)
//   workspace  files agentx wrote into the workspace that Claude Code loads
//              on its own: CLAUDE.md, .claude/rules/*.md, and their @imports
//              (skipped when the run's --setting-sources leaves out project)
//
// Claude Code's own system prompt and tools are identical with or without
// agentx, so they are left out: this is the delta agentx is responsible for.
// Everything counted here is re-read (as cache reads) on every model call
// of every task, which is why a small number here matters.
//
// Not measurable statically, so only listed: hooks in .claude/settings.json
// (they can inject text at run time) and MCP servers (their tool schemas).
// bench/context-profiles.ts compares the full and lean profiles per channel.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { benchConfig, runExec, writeFakeClaude } from "./context-exec"

const DEFAULT_TASK = "Fix the failing test in this repository and make sure the whole suite passes."
const EXACT_MODEL = "claude-haiku-4-5"

export interface Section { name: string; text: string; tokens: number; exact: boolean }

export interface MeasureOptions {
  task: string
  /** Channel the run is attributed to (default `exec`). */
  channel?: string
  /** Force `full` or `lean` for that channel. */
  profile?: "full" | "lean"
  /** Split the preamble and prompt by their bracketed section headers. */
  sections?: boolean
  exact?: boolean
  apiKey?: string
  /** A real config and agent instead of the clean bench agent. */
  configPath?: string
  agentId?: string
  /** Runs with the same chat id before the measured one, so the measured
   *  run starts with a chat history; one more run on another chat gives
   *  it cross-chat context. 0 (default) measures a first contact. */
  warmTurns?: number
}

export interface Measurement {
  exact: boolean
  total: number
  sections: Section[]
  /** The lean flags found on the claude command line, if any. */
  flags: string[]
  unmeasured: string[]
}

/** ~4 characters per token for English prose and code. Deterministic, so a
 *  change in it is a change in content; use --exact for absolute numbers. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** The -p prompt with the task removed: what agentx wrapped around it. */
export function promptOverhead(prompt: string, task: string): string {
  const i = prompt.lastIndexOf(task)
  return i < 0 ? prompt : (prompt.slice(0, i) + prompt.slice(i + task.length)).trim()
}

/** Headers that continue the section they appear in rather than start
 *  one: the landscape's own sub-blocks and the `[End …]` footers. */
const CONTINUES_SECTION = new Set(["rules", "cross-channel messaging", "conversation recall", "background monitoring", "agent teams"])

/** Split a block on its `[Header]` lines: one part per section, the text
 *  before the first header as `lead`. Blank parts are dropped. */
export function splitSections(text: string, lead: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let name = lead
  let buf: string[] = []
  const flush = () => { if (buf.join("\n").trim()) out.push([name, buf.join("\n")]); buf = [] }
  for (const line of text.split("\n")) {
    const m = /^\[([^\]]{1,80})\]/.exec(line)
    if (m) {
      const header = m[1].replace(/\s+—.*$/, "").replace(/\s*\(.*$/, "").replace(/:.*$/, "").trim().toLowerCase()
      if (!CONTINUES_SECTION.has(header) && !header.startsWith("end ")) { flush(); name = header }
    }
    buf.push(line)
  }
  flush()
  return out
}

/** Instruction files Claude Code loads from a workspace, with their
 *  `@path` imports resolved (one file each, cycles ignored). */
export function claudeLoadedFiles(workspace: string): string[] {
  const roots = ["CLAUDE.md", ".claude/CLAUDE.md"].map((f) => join(workspace, f))
  const rulesDir = join(workspace, ".claude/rules")
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir, { recursive: true }) as string[]) {
      if (f.endsWith(".md")) roots.push(join(rulesDir, f))
    }
  }
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    for (const m of readFileSync(file, "utf8").matchAll(/(?:^|\s)@([\w./-]+\.md)\b/g)) {
      visit(resolve(dirname(file), m[1]))
    }
  }
  roots.forEach(visit)
  return [...seen]
}

/** Hooks and MCP servers the workspace configures: listed, not counted. */
export function unmeasured(workspace: string): string[] {
  const out: string[] = []
  const settings = join(workspace, ".claude/settings.json")
  if (existsSync(settings)) {
    const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks ?? {}
    for (const [event, entries] of Object.entries<any[]>(hooks)) {
      out.push(`hook ${event} (${entries.length})`)
    }
  }
  const mcp = join(workspace, ".mcp.json")
  if (existsSync(mcp)) {
    for (const name of Object.keys(JSON.parse(readFileSync(mcp, "utf8")).mcpServers ?? {})) {
      out.push(`mcp server ${name}`)
    }
  }
  return out
}

/** The lean-profile flags on a recorded claude command line, in words. */
export function leanFlags(argv: string[]): string[] {
  const out: string[] = []
  const after = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
  if (argv.includes("--strict-mcp-config")) {
    const cfg = after("--mcp-config")
    let names = "?"
    try { names = Object.keys(JSON.parse(cfg ?? "{}").mcpServers ?? {}).join(",") || "none" } catch { /* keep ? */ }
    out.push(`strict mcp config: ${names}`)
  }
  const sources = after("--setting-sources")
  if (sources !== undefined) out.push(`setting sources: ${sources || "none"}`)
  return out
}

/** Whether a run with these flags lets Claude Code read the workspace. */
export function loadsWorkspace(argv: string[]): boolean {
  const i = argv.indexOf("--setting-sources")
  return i < 0 || (argv[i + 1] ?? "").split(",").includes("project")
}

async function countExact(text: string, apiKey: string): Promise<number> {
  const body = (content: string) => JSON.stringify({ model: EXACT_MODEL, messages: [{ role: "user", content }] })
  const count = async (content: string) => {
    const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: body(content),
    })
    if (!res.ok) throw new Error(`count_tokens ${res.status}: ${await res.text()}`)
    return ((await res.json()) as { input_tokens: number }).input_tokens
  }
  // Subtract the fixed message framing so sections add up.
  return Math.max(0, (await count(text)) - (await count(".")) + 1)
}

export async function measure(opts: MeasureOptions): Promise<Measurement> {
  const exact = Boolean(opts.exact)
  if (exact && !opts.apiKey) throw new Error("--exact needs ANTHROPIC_API_KEY (count_tokens is free)")
  const tmp = mkdtempSync(join(tmpdir(), "agentx-context-"))
  try {
    const bin = join(tmp, "bin"), workspace = join(tmp, "workspace"), state = join(tmp, "state"), dump = join(tmp, "argv.json")
    for (const d of [bin, workspace, workspace + "-helper", state]) mkdirSync(d)
    writeFakeClaude(bin, dump)

    let configPath = opts.configPath ? resolve(opts.configPath) : join(state, "agentx.json")
    const agentId = opts.agentId ?? "bench"
    if (!opts.configPath) writeFileSync(configPath, JSON.stringify(benchConfig(workspace)))
    const agentWorkspace = opts.configPath
      ? JSON.parse(readFileSync(configPath, "utf8")).agents?.[agentId]?.workspace ?? workspace
      : workspace

    const chatId = `bench-${opts.channel ?? "exec"}`
    const base = { state, bin, configPath, agentId, channel: opts.channel, profile: opts.profile }
    for (let i = 0; i < (opts.warmTurns ?? 0); i++) {
      runExec({ ...base, chatId, task: `Earlier step ${i + 1}: ${opts.task}` })
      runExec({ ...base, chatId: `${chatId}-other`, task: `Side chat ${i + 1}: ${opts.task}` })
    }
    runExec({ ...base, chatId, task: opts.task })

    const argv: string[] = JSON.parse(readFileSync(dump, "utf8"))
    const after = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : "" }
    const preamble = after("--append-system-prompt"), prompt = promptOverhead(after("-p"), opts.task)
    const raw: Array<[string, string]> = opts.sections
      ? [
          ...splitSections(preamble, "agent system prompt").map(([n, t]): [string, string] => [`preamble: ${n}`, t]),
          ...splitSections(prompt, "channel and scope").map(([n, t]): [string, string] => [`prompt: ${n}`, t]),
        ]
      : [["preamble (--append-system-prompt)", preamble], ["prompt around the task", prompt]]
    if (loadsWorkspace(argv)) {
      raw.push(...claudeLoadedFiles(agentWorkspace).map((f): [string, string] =>
        [`workspace ${relative(agentWorkspace, f)}`, readFileSync(f, "utf8")]))
    }
    const sections: Section[] = []
    for (const [name, text] of raw) {
      sections.push({ name, text, tokens: exact && text ? await countExact(text, opts.apiKey!) : estimateTokens(text), exact })
    }
    return {
      exact,
      total: sections.reduce((n, s) => n + s.tokens, 0),
      sections,
      flags: leanFlags(argv),
      unmeasured: loadsWorkspace(argv) ? unmeasured(agentWorkspace) : [],
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const budget = flag(args, "--budget")
  const profile = flag(args, "--profile")
  if (profile !== undefined && profile !== "full" && profile !== "lean") throw new Error("--profile must be full or lean")
  const result = await measure({
    task: flag(args, "--message") ?? DEFAULT_TASK,
    channel: flag(args, "--channel"),
    profile,
    sections: args.includes("--sections"),
    exact: args.includes("--exact"),
    apiKey: process.env.ANTHROPIC_API_KEY,
    configPath: flag(args, "--config"),
    agentId: flag(args, "--agent"),
    warmTurns: Number(flag(args, "--warm") ?? 0),
  })

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({
      exact: result.exact, total: result.total, flags: result.flags, unmeasured: result.unmeasured,
      sections: result.sections.map(({ name, text, tokens }) => ({ name, chars: text.length, tokens })),
    }) + "\n")
  } else {
    const mark = result.exact ? "" : "≈"
    for (const s of result.sections) console.log(`${(mark + s.tokens).padStart(8)}  ${s.name}  (${s.text.length} chars)`)
    console.log(`${(mark + result.total).padStart(8)}  total added by agentx${result.exact ? "" : " (estimate; --exact for real counts)"}`)
    if (result.flags.length) console.log(`\nclaude started with: ${result.flags.join("; ")}`)
    if (result.unmeasured.length) console.log(`\nnot counted (can add more at run time): ${result.unmeasured.join(", ")}`)
  }

  if (budget && result.total > Number(budget)) {
    console.error(`\nover budget: ${result.total} > ${budget} tokens`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e?.stderr?.toString() || e?.message || e); process.exit(1) })
}
