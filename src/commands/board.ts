import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"
import { mutateAgentxConfig } from "@/daemon/config-mutate"

export const board = new Command()
  .name("board")
  .description("kanban board dashboard — visual work view over configured sources")

// agentx board serve — start the dashboard HTTP server
board
  .command("serve", { isDefault: true })
  .description("start the dashboard server (live view always; boards if configured)")
  .option("--port <n>", "override dashboard.port")
  .option("--bind <host>", "override dashboard.bind (e.g. 0.0.0.0)")
  .action(async (opts) => {
    try {
      const config = resolveServerConfig(opts.port, opts.bind)
      const { startBoardDashboard } = await import("@/daemon/board-dashboard")
      startBoardDashboard(config)
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      if (process.env.DEBUG && e.stack) console.log(chalk.dim(e.stack))
      process.exit(1)
    }
  })

/**
 * Load agentx.json if it exists; otherwise fabricate a minimal config so the
 * dashboard can serve the setup wizard. Without this, `agentx setup` on a
 * fresh machine would crash with "No config found" before the user has a
 * chance to create one.
 */
function resolveServerConfig(portOpt?: string, bindOpt?: string): any {
  try {
    const cfg = loadDaemonConfig()
    if (portOpt) cfg.dashboard.port = parseInt(portOpt, 10)
    if (bindOpt) cfg.dashboard.bind = bindOpt
    return cfg
  } catch (e: any) {
    console.log(chalk.yellow("  No agentx.json found — starting dashboard in setup-only mode."))
    console.log(chalk.dim("  Visit http://127.0.0.1:" + (portOpt || "4202") + " to run the wizard.\n"))
    return {
      node: { id: "setup", name: "Setup", bind: "127.0.0.1:18800" },
      providers: {},
      agents: {},
      channels: {},
      crons: {},
      mesh: { enabled: false, peers: [], discovery: "static", healthCheck: { interval: 60, timeout: 10 } },
      boards: [],
      dashboard: {
        enabled: true,
        port: portOpt ? parseInt(portOpt, 10) : 4202,
        bind: bindOpt || "127.0.0.1",
        daemonUrl: "http://localhost:18800",
        daemons: [],
      },
      business: undefined,
      session: { staleMinutes: 120 },
    }
  }
}

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

// agentx board add — append a board to agentx.json
board
  .command("add <id>")
  .description("add a GitLab board to agentx.json")
  .requiredOption("--name <name>", "human-readable board name")
  .requiredOption("--projects <paths>", "comma-separated GitLab project paths (e.g. 'mtgl/system,mtgl/website')")
  .option("--label <label>", "primary tool label ANDed into every query (e.g. 'Tool::Claude')")
  .option("--days <n>", "open-window time range in days", "30")
  .option("--closed-days <n>", "closed-window in days", "30")
  .action((id: string, opts) => {
    try {
      mutateConfig((cfg) => {
        if (!Array.isArray(cfg.boards)) cfg.boards = []
        if (cfg.boards.find((b: any) => b.id === id)) {
          throw new Error(`board "${id}" already exists`)
        }
        const projects = String(opts.projects).split(",").map((s) => s.trim()).filter(Boolean)
        if (projects.length === 0) throw new Error("--projects must include at least one path")
        const board: any = {
          id,
          name: opts.name,
          source: { type: "gitlab", projects },
          timeRangeDays: parseInt(opts.days, 10) || 30,
          closedWindowDays: parseInt(opts.closedDays, 10) || 30,
        }
        if (opts.label) board.primaryToolLabel = opts.label
        cfg.boards.push(board)
        return `added board "${id}" (${projects.join(", ")})`
      })
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

// agentx board remove — drop a board by id
board
  .command("remove <id>")
  .alias("rm")
  .description("remove a board from agentx.json")
  .action((id: string) => {
    try {
      mutateConfig((cfg) => {
        if (!Array.isArray(cfg.boards) || cfg.boards.length === 0) throw new Error("no boards configured")
        const before = cfg.boards.length
        cfg.boards = cfg.boards.filter((b: any) => b.id !== id)
        if (cfg.boards.length === before) throw new Error(`board "${id}" not found`)
        return `removed board "${id}"`
      })
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

/**
 * CLI-friendly wrapper around the shared mutateAgentxConfig helper — prints
 * colourized success + backup hint so `agentx board add/remove` feels the same
 * as it did before the refactor.
 */
function mutateConfig(mutator: (cfg: any) => string): void {
  const { summary, backupPath } = mutateAgentxConfig((cfg) => mutator(cfg))
  console.log(chalk.green(`\n  ✓ ${summary}\n`))
  if (backupPath) console.log(chalk.dim(`  Backup: ${backupPath}`))
  console.log(chalk.dim(`  Restart the dashboard to pick up the change if not auto-reloading.\n`))
}
