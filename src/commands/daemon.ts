import { Command } from "commander"
import { AgentXDaemon } from "@/daemon"
import { loadDaemonConfig, validateWorkspaces } from "@/daemon/config"
import chalk from "chalk"

// --- agentx daemon: start/stop/status/logs ---

export const daemon = new Command()
  .name("daemon")
  .description("manage the agentx daemon — start, stop, status, logs")

// agentx daemon start
daemon
  .command("start")
  .description("start the daemon (default if no subcommand)")
  .option("-c, --config <path>", "path to agentx.json")
  .option("-d, --detach", "run in background (detached)")
  .option("--port <port>", "override bind port")
  .action(async (opts) => {
    if (opts.detach) {
      const { spawn } = await import("child_process")
      const args = ["dist/cli.js", "daemon", "start"]
      if (opts.config) args.push("-c", opts.config)
      if (opts.port) args.push("--port", opts.port)

      const child = spawn("node", args, {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        cwd: process.cwd(),
      })
      child.unref()

      const { writeFileSync } = await import("fs")
      writeFileSync("/tmp/agentx-daemon.pid", String(child.pid))
      console.log(chalk.green(`Daemon started in background (PID: ${child.pid})`))
      console.log(chalk.dim(`  Logs: tail -f /tmp/agentx-daemon.log`))
      console.log(chalk.dim(`  Stop: agentx daemon stop`))
      return
    }

    const d = new AgentXDaemon(opts.config)
    await d.start()
  })

// agentx daemon stop
daemon
  .command("stop")
  .description("stop the running daemon")
  .action(async () => {
    const { readFileSync, existsSync } = await import("fs")
    const pidFile = "/tmp/agentx-daemon.pid"

    if (!existsSync(pidFile)) {
      console.log(chalk.yellow("No daemon PID file found. Trying to find process..."))
    }

    try {
      // Try PID file first
      if (existsSync(pidFile)) {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
        process.kill(pid, "SIGTERM")
        console.log(chalk.green(`Daemon stopped (PID: ${pid})`))
        return
      }
    } catch {
      // PID might be stale
    }

    // Fallback: kill by process name
    const { execSync } = await import("child_process")
    try {
      execSync("pkill -f 'node dist/cli.js daemon'", { stdio: "ignore" })
      console.log(chalk.green("Daemon stopped"))
    } catch {
      console.log(chalk.yellow("No daemon process found"))
    }
  })

// agentx daemon status
daemon
  .command("status")
  .alias("st")
  .description("show daemon status, agents, crons, and mesh")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--json", "output as JSON")
  .action(async (opts) => {
    // Try connecting to running daemon first
    try {
      const config = loadDaemonConfig(opts.config)
      const [host, port] = config.node.bind.split(":")
      const url = `http://${host || "127.0.0.1"}:${port}/health`
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      const data = await res.json() as any

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }

      console.log()
      console.log(chalk.bold(`  ${data.node.name}`) + chalk.dim(` (${data.node.id})`))
      console.log(chalk.green("  Status: running") + chalk.dim(` — uptime ${formatDuration(data.uptime)}`))
      console.log()

      // Agents
      console.log(chalk.bold("  Agents:"))
      for (const a of data.agents) {
        const active = a.active > 0 ? chalk.yellow(` [${a.active} active]`) : ""
        const errors = a.errors > 0 ? chalk.red(` (${a.errors} errors)`) : ""
        console.log(`    ${chalk.cyan(a.name)} ${chalk.dim(`(${a.tier})`)}${active}${errors}`)
        console.log(chalk.dim(`      ${a.workspace}`))
      }

      // Crons
      const enabledCrons = data.crons.filter((c: any) => c.enabled)
      if (data.crons.length) {
        console.log()
        console.log(chalk.bold(`  Crons: ${enabledCrons.length} enabled / ${data.crons.length} total`))
        for (const c of data.crons) {
          const icon = c.enabled ? chalk.green("●") : chalk.dim("○")
          const next = c.nextRun ? chalk.dim(` next: ${new Date(c.nextRun).toLocaleTimeString()}`) : ""
          console.log(`    ${icon} ${c.id}${next}`)
        }
      }

      // Mesh
      if (data.mesh?.length) {
        console.log()
        console.log(chalk.bold("  Mesh:"))
        for (const p of data.mesh) {
          const icon = p.healthy ? chalk.green("●") : chalk.red("●")
          const skills = p.skills?.length ? chalk.dim(` (${p.skills.length} agents)`) : ""
          console.log(`    ${icon} ${p.peer} ${chalk.dim(p.peerUrl)}${skills}`)
        }
      }

      console.log()
    } catch (e: any) {
      if (e.cause?.code === "ECONNREFUSED" || e.name === "TimeoutError") {
        console.log(chalk.red("  Daemon is not running"))
        console.log(chalk.dim("  Start with: agentx daemon start"))
      } else {
        // No running daemon — show config info
        try {
          const config = loadDaemonConfig(opts.config)
          const warnings = validateWorkspaces(config)
          console.log()
          console.log(chalk.bold(`  ${config.node.name}`) + chalk.dim(` (${config.node.id})`))
          console.log(chalk.yellow("  Status: stopped"))
          console.log(chalk.dim(`  ${Object.keys(config.agents).length} agents, ${Object.keys(config.crons).length} crons configured`))
          if (warnings.length) {
            console.log()
            for (const w of warnings) console.log(chalk.yellow(`  ⚠ ${w}`))
          }
          console.log()
        } catch (err: any) {
          console.log(chalk.red(`  ${err.message}`))
        }
      }
    }
  })

// agentx daemon logs
daemon
  .command("logs")
  .description("tail daemon logs")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("-f, --follow", "follow log output", false)
  .action(async (opts) => {
    const { execSync, spawn: spawnProc } = await import("child_process")
    const logFile = "/tmp/agentx-daemon.log"

    const { existsSync } = await import("fs")
    if (!existsSync(logFile)) {
      console.log(chalk.yellow("No log file found at /tmp/agentx-daemon.log"))
      return
    }

    if (opts.follow) {
      const tail = spawnProc("tail", ["-f", "-n", opts.lines, logFile], { stdio: "inherit" })
      process.on("SIGINT", () => { tail.kill(); process.exit(0) })
    } else {
      execSync(`tail -n ${opts.lines} ${logFile}`, { stdio: "inherit" })
    }
  })

// agentx daemon send — send a task to an agent
daemon
  .command("send <agent> <message...>")
  .description("send a task to an agent via the daemon API")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--peer <peer>", "send to a mesh peer's agent")
  .option("--json", "output raw JSON response")
  .action(async (agent, messageParts, opts) => {
    const message = messageParts.join(" ")

    try {
      const config = loadDaemonConfig(opts.config)
      const [host, port] = config.node.bind.split(":")
      const baseUrl = `http://${host || "127.0.0.1"}:${port}`

      let url: string
      let body: Record<string, unknown>

      if (opts.peer) {
        url = `${baseUrl}/mesh/task`
        body = { peer: opts.peer, message, agent }
      } else {
        url = `${baseUrl}/task`
        body = { agent, message }
      }

      console.log(chalk.dim(`  Sending to ${opts.peer ? `${opts.peer}/${agent}` : agent}...`))

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await res.json() as any

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
      } else if (data.error) {
        console.log(chalk.red(`  Error: ${data.error}`))
      } else {
        console.log()
        console.log(data.content || data.response || "No response")
        if (data.duration) {
          console.log(chalk.dim(`\n  (${(data.duration / 1000).toFixed(1)}s)`))
        }
      }
    } catch (e: any) {
      console.log(chalk.red(`  Failed: ${e.message}`))
      console.log(chalk.dim("  Is the daemon running? Try: agentx daemon status"))
    }
  })

// agentx daemon deploy — rsync dist to a remote server
daemon
  .command("deploy <host>")
  .description("deploy agentx to a remote server via rsync")
  .option("-i, --identity <key>", "SSH identity file")
  .option("-u, --user <user>", "SSH user", "clawd")
  .option("-p, --path <path>", "remote agentx path", "~/agentx")
  .option("--restart", "restart remote daemon after deploy", false)
  .action(async (host, opts) => {
    const { execSync } = await import("child_process")
    const sshKey = opts.identity ? `-e "ssh -i ${opts.identity}"` : ""
    const remote = `${opts.user}@${host}:${opts.path}/dist/`

    console.log(chalk.dim(`  Deploying to ${opts.user}@${host}:${opts.path}...`))

    try {
      execSync(`rsync -avz --delete ${sshKey} dist/ ${remote}`, {
        stdio: "inherit",
        cwd: process.cwd(),
      })
      console.log(chalk.green("  Deploy complete"))

      if (opts.restart) {
        console.log(chalk.dim("  Restarting remote daemon..."))
        const ssh = opts.identity ? `ssh -i ${opts.identity}` : "ssh"
        execSync(
          `${ssh} ${opts.user}@${host} "pkill -f 'node dist/cli.js daemon' 2>/dev/null; sleep 2; cd ${opts.path} && nohup node dist/cli.js daemon start > /tmp/agentx-daemon.log 2>&1 &"`,
          { stdio: "inherit" },
        )
        console.log(chalk.green("  Remote daemon restarted"))
      }
    } catch (e: any) {
      console.log(chalk.red(`  Deploy failed: ${e.message}`))
    }
  })

// Default: `agentx daemon` without subcommand starts the daemon
daemon.action(async (opts) => {
  const d = new AgentXDaemon(opts.config)
  await d.start()
})

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
  return `${Math.round(seconds / 86400)}d ${Math.round((seconds % 86400) / 3600)}h`
}
