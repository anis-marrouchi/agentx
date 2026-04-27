import { Command } from "commander"
import { AgentXDaemon } from "@/daemon"
import { loadDaemonConfig, validateWorkspaces } from "@/daemon/config"
import chalk from "chalk"
import { existsSync, readFileSync } from "fs"

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

    // Single-instance guard — only one daemon can run at a time.
    // If another process is alive with the recorded PID, exit immediately.
    const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("fs")
    const { resolve } = await import("path")
    const lockDir = resolve(process.cwd(), ".agentx")
    if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true })
    const pidPath = resolve(lockDir, "daemon.pid")

    if (existsSync(pidPath)) {
      const oldPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10)
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0) // throws if process doesn't exist
          console.error(`Another agentx daemon is already running (PID ${oldPid}). Exiting.`)
          process.exit(0)
        } catch {
          // Old process is dead — we can proceed
        }
      }
    }
    writeFileSync(pidPath, String(process.pid))

    // Auto-load .env from the working directory so `{{env.FOO}}` in
    // workflows + agent prompts just works without editing systemd
    // units. Existing process.env values win — we never overwrite what
    // the runtime was launched with.
    try { loadDotenv(resolve(process.cwd(), ".env")) } catch { /* best effort */ }

    const d = new AgentXDaemon(opts.config)
    await d.start()
  })

/** Minimal .env parser: KEY=VALUE lines. Quotes around the value are
 *  stripped. Blank lines + comments ignored. No substitution, no export
 *  keyword — we don't want to pull dotenv for this. Variables already in
 *  process.env take precedence so a systemd override always wins. */
function loadDotenv(path: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!existsSync(path)) return
  const text = readFileSync(path, "utf-8")
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (!key || process.env[key] !== undefined) continue
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
}

// agentx daemon stop
daemon
  .command("stop")
  .description("stop the running daemon")
  .action(async () => {
    const { readFileSync, existsSync, unlinkSync } = await import("fs")
    const { resolve } = await import("path")

    // Check both PID file locations
    const pidFiles = [
      resolve(process.cwd(), ".agentx/daemon.pid"),
      "/tmp/agentx-daemon.pid",
    ]

    for (const pidFile of pidFiles) {
      if (!existsSync(pidFile)) continue
      try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
        process.kill(pid, "SIGTERM")
        // Wait briefly for graceful shutdown
        await new Promise(r => setTimeout(r, 2000))
        try { unlinkSync(pidFile) } catch {}
        console.log(chalk.green(`Daemon stopped (PID: ${pid})`))
        return
      } catch {
        try { unlinkSync(pidFile) } catch {}
      }
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

// agentx daemon watch — live stream of agent activity
daemon
  .command("watch")
  .description("stream live agent activity (SSE)")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (opts) => {
    const config = loadDaemonConfig(opts.config)
    const bind = config.node.bind || "127.0.0.1:18800"
    const url = `http://${bind.replace("0.0.0.0", "127.0.0.1")}/events`

    console.log(chalk.dim(`  Connecting to ${url}...`))
    console.log(chalk.dim("  Press Ctrl+C to stop\n"))

    try {
      const res = await fetch(url)
      if (!res.ok || !res.body) {
        console.log(chalk.red(`  Failed: ${res.status}`))
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6))
              const time = new Date(data.time).toLocaleTimeString()
              const msg = data.message?.replace(/^\[agentx\]\s*/, "") || ""
              // Color-code by content
              if (msg.includes("executing")) console.log(`${chalk.dim(time)} ${chalk.cyan("▶")} ${msg}`)
              else if (msg.includes("completed")) console.log(`${chalk.dim(time)} ${chalk.green("✓")} ${msg}`)
              else if (msg.includes("error") || msg.includes("Error")) console.log(`${chalk.dim(time)} ${chalk.red("✗")} ${msg}`)
              else if (msg.includes("Routing")) console.log(`${chalk.dim(time)} ${chalk.yellow("→")} ${msg}`)
              else if (msg.includes("mention")) console.log(`${chalk.dim(time)} ${chalk.magenta("@")} ${msg}`)
              else if (msg.includes("Skipping")) console.log(`${chalk.dim(time)} ${chalk.dim("⊘")} ${chalk.dim(msg)}`)
              else console.log(`${chalk.dim(time)}   ${msg}`)
            } catch { /* skip malformed */ }
          } else if (line.startsWith("event: status")) {
            // First event — show current state
          }
        }
      }
    } catch (e: any) {
      console.log(chalk.red(`  Connection failed: ${e.message}`))
      console.log(chalk.dim("  Is the daemon running? Try: agentx daemon status"))
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
  .option("-u, --user <user>", "SSH user", "root")
  .option("-p, --path <path>", "remote agentx path", "~/agentx")
  .option("--restart", "restart remote daemon after deploy", false)
  .option("--skip-checks", "skip build and test before deploy", false)
  .action(async (host, opts) => {
    const { execSync } = await import("child_process")
    const sshKey = opts.identity ? `-e "ssh -i ${opts.identity}"` : ""
    const remote = `${opts.user}@${host}:${opts.path}/dist/`

    // Pre-deploy checks
    if (!opts.skipChecks) {
      try {
        console.log(chalk.dim("  Running tests..."))
        execSync("npx vitest run --reporter=dot", { stdio: "pipe", cwd: process.cwd() })
        console.log(chalk.green("  ✓ Tests passed"))
      } catch (e: any) {
        console.log(chalk.red("  ✗ Tests failed — aborting deploy"))
        console.log(chalk.dim("  Use --skip-checks to deploy anyway"))
        return
      }

      // Check dist exists and is recent
      const { existsSync, statSync } = await import("fs")
      const { resolve } = await import("path")
      const cliPath = resolve(process.cwd(), "dist/cli.js")
      if (!existsSync(cliPath)) {
        console.log(chalk.red("  ✗ dist/ not found — run build first"))
        return
      }
      const age = Date.now() - statSync(cliPath).mtimeMs
      if (age > 300_000) {
        console.log(chalk.yellow("  ⚠ dist/ is older than 5 minutes — rebuilding..."))
        execSync("npx tsup --no-dts", { stdio: "pipe", cwd: process.cwd() })
        console.log(chalk.green("  ✓ Build complete"))
      }
    }

    console.log(chalk.dim(`  Deploying to ${opts.user}@${host}:${opts.path}...`))

    try {
      execSync(`rsync -avzL --delete ${sshKey} dist/ ${remote}`, {
        stdio: "inherit",
        cwd: process.cwd(),
      })
      console.log(chalk.green("  ✓ Deploy complete"))

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
