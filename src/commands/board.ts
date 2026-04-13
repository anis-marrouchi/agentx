import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

export const board = new Command()
  .name("board")
  .description("kanban board dashboard — visual work view over configured sources")

// agentx board serve — start the dashboard HTTP server
board
  .command("serve", { isDefault: true })
  .description("start the kanban board dashboard")
  .option("--port <n>", "override dashboard.port")
  .option("--bind <host>", "override dashboard.bind (e.g. 0.0.0.0)")
  .action(async (opts) => {
    try {
      const config = loadDaemonConfig()
      if (opts.port) config.dashboard.port = parseInt(opts.port, 10)
      if (opts.bind) config.dashboard.bind = opts.bind
      if (!config.boards || config.boards.length === 0) {
        console.log(chalk.yellow("\n  No boards configured in agentx.json."))
        console.log(chalk.dim("  Add a 'boards' array — see docs/reference/boards.md for the schema.\n"))
        process.exit(1)
      }
      const { startBoardDashboard } = await import("@/daemon/board-dashboard")
      startBoardDashboard(config)
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

// agentx board list — show configured boards (quick sanity check)
board
  .command("list")
  .description("list configured boards")
  .action(() => {
    try {
      const config = loadDaemonConfig()
      if (!config.boards?.length) {
        console.log(chalk.dim("\n  No boards configured.\n"))
        return
      }
      console.log()
      for (const b of config.boards) {
        console.log(`  ${chalk.cyan(b.id)}  — ${b.name}`)
        const src = b.source as any
        console.log(chalk.dim(`    source: ${src.type}${src.projects ? " (" + src.projects.join(", ") + ")" : ""}`))
        if (b.primaryToolLabel) console.log(chalk.dim(`    primary label: ${b.primaryToolLabel}`))
        console.log(chalk.dim(`    window: ${b.timeRangeDays} days`))
      }
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })
