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
