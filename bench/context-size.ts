// Level 0 benchmark: how much context agentx adds before the model starts.
//
//   pnpm bench:context                         # clean bench agent, estimate
//   pnpm bench:context --exact                 # exact counts (free Anthropic
//                                              # count_tokens; needs ANTHROPIC_API_KEY)
//   pnpm bench:context --budget 4000           # exit 1 above 4000 tokens
//   pnpm bench:context --config agentx.json --agent devops   # a real agent
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
//
// Claude Code's own system prompt and tools are identical with or without
// agentx, so they are left out: this is the delta agentx is responsible for.
// Everything counted here is re-read (as cache reads) on every model call
// of every task, which is why a small number here matters.
//
// Not measurable statically, so only listed: hooks in .claude/settings.json
// (they can inject text at run time) and MCP servers (their tool schemas).

import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_TASK = "Fix the failing test in this repository and make sure the whole suite passes."
const EXACT_MODEL = "claude-haiku-4-5"

export interface Section { name: string; text: string; tokens: number; exact: boolean }

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

/** A `claude` stand-in: records argv, answers like `--output-format json`. */
function writeFakeClaude(binDir: string, dump: string): void {
  const file = join(binDir, "claude")
  writeFileSync(file, `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(JSON.stringify({ type: "result", result: "ok", session_id: "context-size", num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
`)
  chmodSync(file, 0o755)
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const task = flag(args, "--message") ?? DEFAULT_TASK
  const budget = flag(args, "--budget")
  const exact = args.includes("--exact")
  const json = args.includes("--json")
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (exact && !apiKey) throw new Error("--exact needs ANTHROPIC_API_KEY (count_tokens is free)")

  const tmp = mkdtempSync(join(tmpdir(), "agentx-context-"))
  try {
    const bin = join(tmp, "bin")
    const workspace = join(tmp, "workspace")
    const state = join(tmp, "state")
    const dump = join(tmp, "argv.json")
    for (const d of [bin, workspace, state]) mkdirSync(d)
    writeFakeClaude(bin, dump)

    let configPath = flag(args, "--config")
    let agentId = flag(args, "--agent") ?? "bench"
    if (configPath) {
      configPath = resolve(configPath)
    } else {
      // Same shape as the Harbor adapter's config: an empty agentx.
      configPath = join(state, "agentx.json")
      writeFileSync(configPath, JSON.stringify({
        node: { id: "bench", name: "Bench", bind: "127.0.0.1:18899" },
        agents: { bench: { name: "Bench", workspace, tier: "claude-code", permissionMode: "bypassPermissions" } },
      }))
    }

    execFileSync(join(REPO, "node_modules/.bin/tsx"),
      ["--tsconfig", join(REPO, "tsconfig.json"), join(REPO, "src/cli.ts"),
        "exec", "-a", agentId, "-c", configPath, "--setup-workspace", "--json"],
      { cwd: state, input: task, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["pipe", "pipe", "pipe"] })

    const argv: string[] = JSON.parse(readFileSync(dump, "utf8"))
    const after = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : "" }
    const agentWorkspace = configPath === join(state, "agentx.json")
      ? workspace
      : JSON.parse(readFileSync(configPath, "utf8")).agents?.[agentId]?.workspace ?? workspace

    const raw: Array<[string, string]> = [
      ["preamble (--append-system-prompt)", after("--append-system-prompt")],
      ["prompt around the task", promptOverhead(after("-p"), task)],
      ...claudeLoadedFiles(agentWorkspace).map((f): [string, string] =>
        [`workspace ${relative(agentWorkspace, f)}`, readFileSync(f, "utf8")]),
    ]
    const sections: Section[] = []
    for (const [name, text] of raw) {
      sections.push({
        name, text,
        tokens: exact && text ? await countExact(text, apiKey!) : estimateTokens(text),
        exact,
      })
    }
    const total = sections.reduce((n, s) => n + s.tokens, 0)
    const notes = unmeasured(agentWorkspace)

    if (json) {
      process.stdout.write(JSON.stringify({
        exact, total, unmeasured: notes,
        sections: sections.map(({ name, text, tokens }) => ({ name, chars: text.length, tokens })),
      }) + "\n")
    } else {
      const mark = exact ? "" : "≈"
      for (const s of sections) console.log(`${(mark + s.tokens).padStart(8)}  ${s.name}`)
      console.log(`${(mark + total).padStart(8)}  total added by agentx${exact ? "" : " (estimate; --exact for real counts)"}`)
      if (notes.length) console.log(`\nnot counted (can add more at run time): ${notes.join(", ")}`)
    }

    if (budget && total > Number(budget)) {
      console.error(`\nover budget: ${total} > ${budget} tokens`)
      process.exitCode = 1
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e?.stderr?.toString() || e?.message || e); process.exit(1) })
}
