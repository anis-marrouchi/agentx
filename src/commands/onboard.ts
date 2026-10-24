// --- agentx onboard: one command from nothing to a running agent ---
//
// `npx agentix-cli onboard` installs (npx does that), starts the dashboard,
// opens the setup wizard, starts the daemon the moment the wizard has saved
// a team, and ends by saying what is now running and where. Both programs
// are children of this one process: one terminal, one Ctrl-C.
//
// The daemon and dashboard are the same ones `agentx daemon start` and
// `agentx board serve` run; onboard only sequences them. The dashboard is
// restarted once after the wizard saves, because it read the folder before
// agentx.json existed (`board serve` falls back to a setup-only config).

import { Command } from "commander"
import chalk from "chalk"
import { spawn, type ChildProcess } from "child_process"
import { existsSync, mkdirSync, openSync, readFileSync } from "fs"
import { homedir, hostname } from "os"
import { join } from "path"
import { runWizard } from "@/daemon/setup-wizard"
import { openBrowser } from "@/utils/open-browser"
import { busyPorts, cliCommand } from "./demo-startup"
import {
  ONBOARD_ENV, bindPort, defaultPayload, loopbackUrl, onPath, pickEngine, readTeam, resolveHomeDir, summaryLines,
} from "./onboard-logic"

async function ok(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

async function health(daemonUrl: string): Promise<any | undefined> {
  try {
    const r = await fetch(daemonUrl + "/health", { signal: AbortSignal.timeout(3000) })
    return r.ok ? await r.json() : undefined
  } catch { return undefined }
}

/** Resolves true once `check` passes, false if `child` exits first or the time runs out. */
async function until(check: () => Promise<boolean>, timeoutMs: number, child?: ChildProcess): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (child && child.exitCode !== null) return false
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function tail(file: string, lines = 20): string {
  try { return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).map((l) => "    " + l).join("\n") } catch { return "" }
}

export const onboard = new Command()
  .name("onboard")
  .description("one command to a running agent: starts the dashboard and daemon together and opens the setup wizard")
  .option("--dir <path>", "folder for your team (default: this folder if it has agentx.json, else ~/agentx)")
  .option("--port <n>", "dashboard port", "4202")
  .option("-y, --yes", "skip the wizard: create an agent named Assistant with the engine found on this machine")
  .option("--no-open", "don't open the browser")
  .option("--startup-timeout <seconds>", "seconds the daemon and dashboard may take to start", "60")
  .action(async (opts) => {
    const started = Date.now()
    const cmd = cliCommand()
    const port = parseInt(opts.port, 10)
    const timeoutMs = Math.max(1, Number(opts.startupTimeout) || 60) * 1000
    const dashboardUrl = `http://127.0.0.1:${port}`
    const { dir, reason } = resolveHomeDir({ dir: opts.dir, cwd: process.cwd(), home: homedir() })
    mkdirSync(join(dir, ".agentx"), { recursive: true })

    const cli = process.argv[1]
    if (!cli || !existsSync(cli)) {
      console.error(chalk.red("  Cannot resolve the agentx CLI entrypoint — run via `npx agentix-cli onboard` or the installed `agentx` binary."))
      process.exit(1)
    }

    console.log()
    console.log(chalk.bold("  agentx onboard"))
    console.log(chalk.dim(`  Team folder: ${dir} (${reason})`))

    if ((await busyPorts([port])).length) {
      console.error(chalk.red(`  Port ${port} is already in use. Another dashboard (or \`${cmd} setup\`) is probably running.`))
      console.error(`  Stop it, or pick another port: ${cmd} onboard --port ${port + 1}`)
      process.exit(1)
    }

    // --yes: fill the wizard's form with defaults instead of opening it.
    let team = readTeam(dir)
    if (opts.yes && !team.agents.length) {
      const engine = pickEngine({ onPath: (b) => onPath(b), env: process.env })
      if (engine) {
        try {
          const r = runWizard(defaultPayload(hostname().replace(/\.local$/, ""), engine, process.env), dir)
          console.log(chalk.green(`  ✓ ${r.summary} Engine: ${engine}.`))
          team = readTeam(dir)
        } catch (e: any) {
          console.log(chalk.yellow(`  Couldn't write a default team (${e.message}); opening the setup page instead.`))
        }
      } else {
        console.log(chalk.yellow("  --yes: no Claude Code, Codex or OpenCode on PATH and no ANTHROPIC_API_KEY set,"))
        console.log(chalk.yellow("  so there is no engine to pick for you. Opening the setup page instead."))
      }
    }

    const children: ChildProcess[] = []
    let stopping = false
    const stop = (code: number) => {
      if (stopping) return
      stopping = true
      for (const c of children) { try { c.kill("SIGTERM") } catch { /* gone */ } }
      setTimeout(() => process.exit(code), 800)
    }
    process.on("SIGINT", () => { console.log(chalk.dim("\n  Stopping the daemon and dashboard…")); stop(0) })
    process.on("SIGTERM", () => stop(0))

    const dashboardLog = join(dir, ".agentx", "onboard-dashboard.log")
    const daemonLog = join(dir, ".agentx", "onboard-daemon.log")
    const env = { ...process.env, [ONBOARD_ENV]: "1" }

    const startDashboard = async (): Promise<ChildProcess> => {
      const fd = openSync(dashboardLog, "a")
      const child = spawn(process.execPath, [cli, "board", "serve", "--port", String(port)], { cwd: dir, env, stdio: ["ignore", fd, fd] })
      children.push(child)
      if (!(await until(() => ok(dashboardUrl + "/setup"), timeoutMs, child))) {
        console.error(chalk.red(`  The dashboard did not start. Last lines of ${dashboardLog}:`))
        console.error(tail(dashboardLog))
        stop(1)
        throw new Error("dashboard failed")
      }
      return child
    }

    try {
      let dashboard = await startDashboard()
      const dashboardHadTeam = team.agents.length > 0
      console.log(chalk.green(`  ✓ dashboard up at ${dashboardUrl} (${Math.round((Date.now() - started) / 1000)}s)`))

      // No team yet: the wizard writes one. Wait for it, however long the
      // person takes to fill the form.
      let openedWizard = false
      if (!team.agents.length) {
        console.log()
        console.log(`  Fill in the setup page: ${chalk.cyan(dashboardUrl + "/setup")}`)
        console.log(chalk.dim("  The daemon starts by itself as soon as you select Save and continue."))
        if (opts.open !== false) openBrowser(dashboardUrl + "/setup")
        openedWizard = true
        while (!readTeam(dir).agents.length) {
          if (dashboard.exitCode !== null) {
            console.error(chalk.red(`  The dashboard stopped. Last lines of ${dashboardLog}:`))
            console.error(tail(dashboardLog))
            return stop(1)
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        team = readTeam(dir)
        console.log(chalk.green(`  ✓ setup saved: ${team.agents.map((a) => "@" + a.id).join(", ")}`))
      }

      // The daemon. One already answering for this team is used as is.
      const daemonUrl = loopbackUrl(team.bind)
      const nodeId = (() => { try { return JSON.parse(readFileSync(join(dir, "agentx.json"), "utf8"))?.node?.id } catch { return undefined } })()
      const running = await health(daemonUrl)
      if (running) {
        if (nodeId && running.node?.id && running.node.id !== nodeId) {
          console.error(chalk.red(`  ${daemonUrl} is answered by another AgentX team (${running.node.name || running.node.id}).`))
          console.error(`  Stop that daemon, or change node.bind in ${join(dir, "agentx.json")}.`)
          return stop(1)
        }
        console.log(chalk.dim(`  A daemon for this team is already running at ${daemonUrl}; using it.`))
      } else {
        if ((await busyPorts([bindPort(team.bind)])).length) {
          console.error(chalk.red(`  Port ${bindPort(team.bind)} (node.bind) is in use by something that is not an AgentX daemon.`))
          console.error(`  Free it, or change node.bind in ${join(dir, "agentx.json")}.`)
          return stop(1)
        }
        console.log(chalk.dim(`  Starting the daemon (log: ${daemonLog})…`))
        const fd = openSync(daemonLog, "a")
        const daemon = spawn(process.execPath, [cli, "daemon", "start", "-c", join(dir, "agentx.json")], { cwd: dir, env, stdio: ["ignore", fd, fd] })
        children.push(daemon)
        if (!(await until(async () => Boolean(await health(daemonUrl)), timeoutMs, daemon))) {
          console.error(chalk.red(`  The daemon did not start. Last lines of ${daemonLog}:`))
          console.error(tail(daemonLog))
          console.error(chalk.dim(`  Fix what it reports (often a missing key in ${join(dir, ".env")}), then run \`${cmd} onboard\` again.`))
          return stop(1)
        }
        daemon.on("exit", (code) => {
          if (stopping) return
          console.error(chalk.red(`  The daemon stopped (exit ${code}). Last lines of ${daemonLog}:`))
          console.error(tail(daemonLog))
          stop(1)
        })
      }
      console.log(chalk.green(`  ✓ daemon up at ${daemonUrl}`))

      // The dashboard read the folder before the team existed. Give the
      // wizard page a moment to see the daemon, then reload it with the team.
      if (!dashboardHadTeam) {
        await new Promise((r) => setTimeout(r, 1500))
        const old = dashboard
        children.splice(children.indexOf(old), 1)
        await new Promise<void>((done) => { old.once("exit", () => done()); old.kill("SIGTERM") })
        dashboard = await startDashboard()
      }
      dashboard.on("exit", (code) => {
        if (stopping) return
        console.error(chalk.red(`  The dashboard stopped (exit ${code}). Last lines of ${dashboardLog}:`))
        console.error(tail(dashboardLog))
        stop(1)
      })

      // The wizard tab already links to the dashboard; open it only when
      // there was no wizard.
      if (!openedWizard && opts.open !== false) openBrowser(dashboardUrl + "/live")

      console.log()
      const lines = summaryLines({ team, daemonUrl, dashboardUrl, dir, cmd, seconds: Math.round((Date.now() - started) / 1000) })
      console.log(chalk.bold.green("  " + lines[0]))
      for (const l of lines.slice(1)) console.log("  " + l)
      console.log()
      console.log(chalk.bold("  Both keep running while this terminal is open. Press Ctrl-C to stop them."))
    } catch (e: any) {
      if (e?.message !== "dashboard failed") {
        console.error(chalk.red(`  Onboard failed: ${e?.message || e}`))
        stop(1)
      }
    }
  })
