import { Command } from "commander"
import chalk from "chalk"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { resolve, join, dirname } from "path"
import {
  runGuard,
  runCheckFromStdin,
  listDecisions,
  loadPolicy,
  guessInstallRoot,
  GUARDRAILS_DIR,
  type GuardMode,
  type Verdict,
} from "@/guard"
import { SEED_FILES } from "@/guard/seeds"

// --- agentx guard ---
//
// Destructive-action guardrails (PRD: AgentX Destructive-Action Guardrails).
// `check` is the PreToolUse hook entrypoint (stdin -> stdout). The rest are
// operator tools: dry-run a command (`test`), read the audit trail (`log`),
// scaffold policy (`init`), and ping the daemon (`reload`).

export const guard = new Command().name("guard").description("destructive-action guardrails — policy, checks, audit")

function actionColor(a: string): (s: string) => string {
  if (a === "deny") return chalk.red
  if (a === "escalate" || a === "ask") return chalk.yellow
  if (a === "warn") return chalk.magenta
  return chalk.green
}

function rootOf(opts: { root?: string }): string {
  return opts.root ? resolve(opts.root) : guessInstallRoot()
}

// ---------------------------------------------------------------------------
// agentx guard check   (PreToolUse hook entrypoint — reads stdin)
// ---------------------------------------------------------------------------
guard
  .command("check")
  .description("PreToolUse hook entrypoint: read a tool-call payload on stdin, emit a Claude Code decision")
  .option("--agent <id>", "agent id this workspace belongs to")
  .option("--root <dir>", "AgentX install root (holds .agentx/guardrails + .agentx/db.sqlite)")
  .option("--env <name>", "environment scope (e.g. production)")
  .action(async (opts) => {
    await runCheckFromStdin({ root: rootOf(opts), agentId: opts.agent, env: opts.env })
    // Always exit 0 — the guard fails open at the hook layer; real blocking is
    // via the JSON decision on stdout, never a nonzero exit.
    process.exit(0)
  })

// ---------------------------------------------------------------------------
// agentx guard test "<command>"   (dry-run through the engine)
// ---------------------------------------------------------------------------
guard
  .command("test <command>")
  .description("dry-run a command through the policy engine and print the verdict")
  .option("--agent <id>", "evaluate as this agent")
  .option("--env <name>", "environment scope")
  .option("--tool <name>", "tool name", "Bash")
  .option("--cwd <dir>", "workspace cwd for $VAR/.env resolution", process.cwd())
  .option("--root <dir>", "AgentX install root (policy source)")
  .option("--enforce", "evaluate as if mode=enforce (show what WOULD block)")
  .option("--json", "emit JSON")
  .action((command: string, opts) => {
    const root = rootOf(opts)
    const modeOverride: GuardMode | undefined = opts.enforce ? "enforce" : undefined
    const { verdict, mode, ms } = runGuard(
      { tool: opts.tool, command, cwd: opts.cwd, agentId: opts.agent, env: opts.env },
      { root, agentId: opts.agent, env: opts.env, modeOverride, noAudit: true },
    )
    if (opts.json) {
      console.log(JSON.stringify({ verdict, mode, ms }, null, 2))
      return
    }
    printVerdict(verdict, mode, ms)
  })

function printVerdict(v: Verdict, mode: string, ms: number) {
  const col = actionColor(v.action)
  console.log()
  console.log(`  policy verdict   ${col(v.action.toUpperCase())}${v.matched ? "" : chalk.dim("  (no rule matched)")}`)
  console.log(`  enforced as      ${actionColor(v.effectiveAction)(v.effectiveAction)} ${chalk.dim(`(mode=${mode})`)}`)
  if (v.ruleId) console.log(`  rule             ${chalk.cyan(v.ruleId)}${v.severity ? chalk.dim(`  [${v.severity}]`) : ""}`)
  if (v.resolvedTarget) console.log(`  resolved target  ${chalk.yellow(v.resolvedTarget)}`)
  if (v.message) console.log(`  message          ${v.message}`)
  console.log(`  ${chalk.dim(`evaluated in ${ms}ms`)}`)
  console.log()
}

// ---------------------------------------------------------------------------
// agentx guard log   (read the audit trail)
// ---------------------------------------------------------------------------
guard
  .command("log")
  .description("read the guardrail decision audit trail (newest first)")
  .option("--root <dir>", "AgentX install root (holds .agentx/db.sqlite)")
  .option("--verdict <v>", "filter by verdict (deny|escalate|warn|allow)")
  .option("--agent <id>", "filter by agent")
  .option("--task <id>", "filter by task id")
  .option("-n, --limit <n>", "max rows", "30")
  .option("--json", "emit JSON")
  .action((opts) => {
    const rows = listDecisions({
      root: rootOf(opts),
      verdict: opts.verdict,
      agentId: opts.agent,
      taskId: opts.task,
      limit: parseInt(opts.limit, 10) || 30,
    })
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }
    if (rows.length === 0) {
      console.log(chalk.dim("  (no guardrail decisions recorded yet)"))
      return
    }
    for (const r of rows) {
      const when = new Date(r.ts).toISOString().replace("T", " ").slice(0, 19)
      const col = actionColor(r.verdict)
      const eff = r.effective_action !== r.verdict ? chalk.dim(`->${r.effective_action}`) : ""
      console.log(
        `  ${chalk.dim(when)}  ${col(r.verdict.toUpperCase().padEnd(8))}${eff}  ` +
          `${chalk.cyan((r.agent_id ?? "?").padEnd(16))} ${chalk.dim((r.matched_rule ?? "-").padEnd(24))} ` +
          `${(r.command ?? "").slice(0, 70)}`,
      )
      if (r.resolved_target) console.log(chalk.dim(`             target: ${r.resolved_target}`))
    }
  })

// ---------------------------------------------------------------------------
// agentx guard init   (scaffold .agentx/guardrails/)
// ---------------------------------------------------------------------------
guard
  .command("init")
  .description("scaffold .agentx/guardrails/ with a starter policy + protected-resource example")
  .option("--root <dir>", "where to create .agentx/guardrails/", process.cwd())
  .option("--force", "overwrite existing files")
  .action((opts) => {
    const base = join(resolve(opts.root), GUARDRAILS_DIR)
    let created = 0
    for (const f of SEED_FILES) {
      const path = join(base, f.relPath)
      if (existsSync(path) && !opts.force) {
        console.log(chalk.dim(`  skip (exists)  ${f.relPath}`))
        continue
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, f.content)
      console.log(chalk.green(`  created        ${f.relPath}`))
      created++
    }
    console.log()
    console.log(`  Guardrails scaffolded under ${chalk.cyan(base)}`)
    console.log(chalk.dim(`  Edit environments/production.yaml with YOUR prod hosts/URLs, then`))
    console.log(chalk.dim(`  \`agentx guard test "<cmd>" --enforce\` to preview, and flip mode: enforce when ready.`))
  })

// ---------------------------------------------------------------------------
// agentx guard reload   (ping the daemon; policy is read live regardless)
// ---------------------------------------------------------------------------
guard
  .command("reload")
  .description("signal the daemon to reload (note: guard policy is read live per tool call already)")
  .option("--url <url>", "daemon base url", process.env.AGENTX_DAEMON_URL || "http://localhost:19900")
  .action(async (opts) => {
    try {
      const res = await fetch(`${String(opts.url).replace(/\/$/, "")}/reload`, { method: "POST" })
      if (res.ok) console.log(chalk.green(`  daemon reloaded (${opts.url})`))
      else console.log(chalk.yellow(`  daemon reachable but returned ${res.status}`))
    } catch (e: any) {
      console.log(chalk.dim(`  daemon not reachable (${e.message}). Policy files are still read live on each check.`))
    }
  })

// ---------------------------------------------------------------------------
// agentx guard policy   (show the resolved policy for an agent)
// ---------------------------------------------------------------------------
guard
  .command("policy")
  .description("print the resolved (merged) policy for an agent")
  .option("--agent <id>", "agent id")
  .option("--root <dir>", "AgentX install root")
  .action((opts) => {
    const p = loadPolicy(rootOf(opts), opts.agent)
    console.log(JSON.stringify(p, null, 2))
  })
