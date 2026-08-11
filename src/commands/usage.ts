import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

export const usage = new Command()
  .name("usage")
  .description("token usage analysis and reporting")

// agentx usage — quick today summary
usage
  .command("today", { isDefault: true })
  .description("show today's token usage")
  .action(async () => {
    try {
      const config = loadDaemonConfig()
      const [host, port] = config.node.bind.split(":")
      const res = await fetch(`http://${host || "127.0.0.1"}:${port}/usage`, { signal: AbortSignal.timeout(3000) })
      const data = await res.json() as any

      console.log()
      console.log(chalk.bold(`  Token Usage (last 7 days)`))
      console.log()

      if (data.totalTasks === 0) {
        console.log(chalk.dim("  No tasks recorded yet"))
        console.log()
        return
      }

      const fmt = (n: number) => n.toLocaleString()

      console.log(`  Total: ${chalk.bold(fmt(data.totalTokens))} tokens across ${data.totalTasks} tasks`)
      console.log(`    Input:        ${fmt(data.totalInput)}`)
      console.log(`    Output:       ${fmt(data.totalOutput)}`)
      console.log(`    Cache read:   ${fmt(data.totalCacheRead)}`)
      console.log(`    Cache create: ${fmt(data.totalCacheCreate)}`)
      if (data.cacheHitRatio > 0) {
        console.log(`    Cache hit:    ${(data.cacheHitRatio * 100).toFixed(1)}%`)
      }
      if (data.totalErrors > 0) {
        console.log(`    Errors:       ${chalk.red(String(data.totalErrors))}`)
      }

      console.log()
      console.log(chalk.bold("  By Agent:"))
      const agents = Object.entries(data.byAgent || {}) as Array<[string, any]>
      agents.sort((a, b) => b[1].total - a[1].total)

      for (const [id, ag] of agents) {
        const total = fmt(ag.total || (ag.input + ag.output + ag.cacheRead + ag.cacheCreate))
        const avgMs = ag.avgDuration ? `${(ag.avgDuration / 1000).toFixed(1)}s avg` : ""
        console.log(`    ${chalk.cyan(id)}: ${total} tokens (${ag.tasks} tasks) ${chalk.dim(avgMs)}`)
      }
      console.log()
    } catch (e: any) {
      if (e.cause?.code === "ECONNREFUSED") {
        console.log(chalk.red("  Daemon not running. Start with: agentx daemon start"))
      } else {
        console.log(chalk.red(`  ${e.message}`))
      }
    }
  })

// `agentx usage serve` was removed — the same data now lives at
// /admin/cost on the dashboard, so there's no second port to keep
// running. Anyone with a stale `usage serve` bookmark gets a redirect
// from the dashboard root pointing to /admin/cost.

// agentx usage report — run Python analyzer
usage
  .command("report")
  .description("run full session analysis (parses Claude Code JSONL files)")
  .option("--days <n>", "analyze last N days", "7")
  .action(async (opts) => {
    const { execSync } = await import("child_process")
    const { existsSync } = await import("fs")
    const { resolve } = await import("path")

    const scriptPath = resolve(process.cwd(), "scripts/token-report.py")
    if (!existsSync(scriptPath)) {
      console.log(chalk.red(`  Script not found: ${scriptPath}`))
      console.log(chalk.dim("  The token analyzer script should be at scripts/token-report.py"))
      return
    }

    console.log(chalk.dim("  Analyzing Claude Code sessions..."))
    try {
      execSync(`SINCE_DAYS=${opts.days} python3 "${scriptPath}"`, { stdio: "inherit" })
    } catch {
      console.log(chalk.red("  Analysis failed. Is Python 3 installed?"))
    }
  })

// ---------------------------------------------------------------------------
// agentx usage surfaces — which CLI commands and dashboard pages get used
// ---------------------------------------------------------------------------
//
// The evidence side of the surface-reduction work. `usage today` answers
// "what did the agents cost"; this answers "which of the 46 commands and 16
// pages does anyone actually open". Reads straight from SQLite — no daemon
// needed, and it works on a node whose daemon is stopped.
//
// See docs/architecture/surface-reduction.md for the bar a surface must clear.
usage
  .command("surfaces")
  .description("which CLI commands and dashboard pages are actually used")
  .option("--days <n>", "window in days", "30")
  .option("--kind <kind>", "cli | page (default: both)")
  .option("--unused", "list registered surfaces with ZERO recorded use instead")
  .option("--json", "raw JSON output")
  .action(async (opts) => {
    const { listSurfaceUse } = await import("@/observability/surface-usage")
    const kind = opts.kind === "cli" || opts.kind === "page" ? opts.kind : undefined
    const rows = listSurfaceUse({ kind, sinceDays: Number(opts.days) || 30 })

    if (opts.unused) {
      const { buildProgram } = await import("@/program")
      const program = await buildProgram()
      const seen = new Set(rows.filter((r) => r.kind === "cli").map((r) => r.name))
      const registered: string[] = []
      const walk = (cmd: any, prefix: string) => {
        for (const sub of cmd.commands ?? []) {
          const name = prefix ? `${prefix} ${sub.name()}` : sub.name()
          registered.push(name)
          walk(sub, name)
        }
      }
      walk(program, "")
      const unused = registered.filter((c) => !seen.has(c)).sort()

      if (opts.json) {
        console.log(JSON.stringify({ windowDays: Number(opts.days) || 30, unused }, null, 2))
        return
      }
      console.log()
      console.log(chalk.bold(`  Never used in the last ${opts.days} days  (${unused.length}/${registered.length})`))
      console.log()
      for (const c of unused) console.log(`  ${chalk.dim("·")} ${c}`)
      console.log()
      console.log(chalk.dim("  Zero use is necessary but not sufficient to remove a surface —"))
      console.log(chalk.dim("  it must also fail the impact test. See docs/architecture/surface-reduction.md"))
      console.log()
      return
    }

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }

    if (rows.length === 0) {
      console.log()
      console.log(chalk.dim(`  No surface usage recorded in the last ${opts.days} days.`))
      console.log(chalk.dim("  Counting starts once this build has been running for a while."))
      console.log()
      return
    }

    console.log()
    console.log(chalk.bold(`  Surface usage — last ${opts.days} days`))
    console.log()
    let lastKind = ""
    for (const r of rows) {
      if (r.kind !== lastKind) {
        console.log(chalk.dim(`  ${r.kind === "cli" ? "CLI commands" : "Dashboard pages"}`))
        lastKind = r.kind
      }
      const count = String(r.count).padStart(6)
      const days = chalk.dim(`${r.days}d`)
      console.log(`  ${chalk.cyan(count)}  ${r.name.padEnd(28)} ${days}`)
    }
    console.log()
    console.log(chalk.dim(`  ${rows.length} surface(s) with recorded use. See --unused for the rest.`))
    console.log()
  })
