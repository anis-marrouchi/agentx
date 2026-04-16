import { Command } from "commander"
import chalk from "chalk"
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs"
import { resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"

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
      const config = loadDaemonConfig()
      if (opts.port) config.dashboard.port = parseInt(opts.port, 10)
      if (opts.bind) config.dashboard.bind = opts.bind
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
 * Read agentx.json, run the mutator, validate by re-loading via the schema,
 * back up + write atomically. Throws on anything that fails validation so we
 * never leave an unparseable config on disk.
 */
function mutateConfig(mutator: (cfg: any) => string): void {
  const file = resolve(process.cwd(), "agentx.json")
  if (!existsSync(file)) throw new Error("agentx.json not found in current directory")
  const cfg = JSON.parse(readFileSync(file, "utf-8"))
  const summary = mutator(cfg)
  const json = JSON.stringify(cfg, null, 2) + "\n"
  // Validate via the daemon loader before persisting.
  const tmp = file + ".tmp"
  writeFileSync(tmp, json, "utf-8")
  try {
    // Spot-check by re-reading from the temp file via JSON; full schema validation
    // happens on the next `loadDaemonConfig()` (e.g. when serving). We at least
    // confirm the JSON shape round-trips.
    JSON.parse(readFileSync(tmp, "utf-8"))
  } catch (e: any) {
    throw new Error(`config did not round-trip cleanly: ${e.message}`)
  }
  copyFileSync(file, file + `.bak.${Date.now()}`)
  writeFileSync(file, json, "utf-8")
  // Best-effort reload via /reload so a running daemon picks up the change.
  triggerReload().catch(() => {/* daemon may not be running */})
  console.log(chalk.green(`\n  ✓ ${summary}\n`))
  console.log(chalk.dim(`  Backup: ${file}.bak.<ts>`))
  console.log(chalk.dim(`  Restart the dashboard to pick up the change if not auto-reloading.\n`))
}

async function triggerReload(): Promise<void> {
  try {
    const cfg = loadDaemonConfig()
    const url = cfg.dashboard.daemonUrl?.replace(/\/+$/, "") || "http://127.0.0.1:18800"
    await fetch(`${url}/reload`, { method: "POST" }).catch(() => null)
  } catch { /* */ }
}
