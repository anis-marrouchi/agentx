import { Command } from "commander"
import chalk from "chalk"
import { spawn } from "child_process"
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "fs"
import { hostname } from "os"
import { join, resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"
import { runWizard } from "@/daemon/setup-wizard"
import { modelReadiness } from "@/daemon/model-ready"
import { findBinary } from "@/voice/transcribe"
import { readDotenv } from "@/utils/dotenv"
import { cliLoggedIn } from "@/utils/cli-login"
import { openBrowser } from "@/utils/open-browser"
import { cliCommand } from "./demo-startup"
import {
  chatUrl, daemonBaseUrl, dashboardBaseUrl, existingConfigPath, firstAgentPayload, isSameInstall, pickAgent,
} from "./start-plan"

// --- agentx start: one command to a working agent in the browser (#1163) ---
//
// Creates a minimal config with one agent when the folder has none, starts
// the daemon and the dashboard in the background, and opens the browser on
// that agent's chat. Safe to run again: an existing config is never
// touched, and a daemon or dashboard that already answers is reused.
// Same detached-spawn approach as `agentx demo` and the wizard's
// "Start daemon" button; logs go to .agentx/ in this folder.

export const start = new Command()
  .name("start")
  .description("one command to a working agent: config, daemon, dashboard, and the chat in your browser")
  .option("--port <n>", "daemon port for a new install (default 18800; an existing agentx.json keeps its own)")
  .option("--dashboard-port <n>", "dashboard port for a new install (default 4202)")
  .option("--startup-timeout <seconds>", "seconds the daemon and the dashboard each may take to answer", "60")
  .option("--no-open", "don't open the browser")
  .action(async (opts) => {
    const dir = process.cwd()
    const cmd = cliCommand()
    const cli = process.argv[1]
    if (!cli || !existsSync(cli)) fail("Cannot resolve the agentx CLI entrypoint. Run it as `agentx start` or `npx agentix-cli start`.")
    const timeoutMs = Math.max(1, Number(opts.startupTimeout) || 60) * 1000

    console.log()
    console.log(chalk.bold("  agentx start"))

    // 1. Config: create one with a single agent, or leave the existing one alone.
    let configPath = existingConfigPath(dir)
    if (configPath) {
      console.log(chalk.dim(`  Using ${configPath} (left as it is)`))
    } else {
      const hasClaude = Boolean(findBinary("claude"))
      const payload = firstAgentPayload(hostname().replace(/\.local$/, ""), hasClaude)
      runWizard(payload, dir, { daemonPort: port(opts.port, "--port"), dashboardPort: port(opts.dashboardPort, "--dashboard-port") })
      configPath = resolve(dir, "agentx.json")
      console.log(chalk.green(`  ✓ Created agentx.json with one agent, ${payload.agent.id} (engine: ${payload.agent.tier})`))
    }

    let cfg
    try { cfg = loadDaemonConfig(configPath) } catch (e: any) { fail(`${configPath}: ${e.message}`) }
    const agentId = pickAgent(cfg)
    if (!agentId) fail(`No agent in ${configPath}. Add one with \`${cmd} setup\`, then run \`${cmd} start\` again.`)

    const logDir = resolve(dir, ".agentx")
    mkdirSync(logDir, { recursive: true })

    // 2. Daemon.
    const daemonUrl = daemonBaseUrl(cfg)
    const running = await health(daemonUrl)
    if (running && !isSameInstall(running, cfg)) {
      fail(`${daemonUrl} is another AgentX install (${running.node?.name || running.node?.id}). Run this one on another port: set node.bind in ${configPath}, or for a new folder use \`${cmd} start --port 18810 --dashboard-port 4212\`.`)
    }
    if (running) {
      console.log(chalk.green(`  ✓ Daemon already running at ${daemonUrl}`))
    } else {
      const log = join(logDir, "daemon.log")
      spawnDetached(cli, ["daemon", "start", "-c", configPath], dir, log)
      await waitFor(`the daemon at ${daemonUrl}`, async () => Boolean(await health(daemonUrl)), timeoutMs, log)
      console.log(chalk.green(`  ✓ Daemon started at ${daemonUrl}`) + chalk.dim(`  (log: ${log})`))
    }

    // 3. Dashboard.
    const dashUrl = dashboardBaseUrl(cfg)
    if (await answers(`${dashUrl}/live`)) {
      console.log(chalk.green(`  ✓ Dashboard already running at ${dashUrl}`))
    } else {
      const log = join(logDir, "board.log")
      const pid = spawnDetached(cli, ["board", "serve"], dir, log)
      if (pid) writeFileSync(join(logDir, "board.pid"), String(pid))
      await waitFor(`the dashboard at ${dashUrl}`, () => answers(`${dashUrl}/live`), timeoutMs, log)
      console.log(chalk.green(`  ✓ Dashboard started at ${dashUrl}`) + chalk.dim(`  (log: ${log})`))
    }

    // 4. The result first: where the agent answers, or what it still needs.
    const url = chatUrl(cfg, agentId)
    const name = cfg.agents[agentId]?.name || agentId
    const ready = modelReadiness({
      rawConfig: JSON.parse(readFileSync(configPath, "utf-8")),
      agentId,
      env: process.env,
      dotenv: readDotenv(resolve(dir, ".env")),
      hasBinary: (bin) => Boolean(findBinary(bin)),
      cliLoggedIn,
    })
    console.log()
    if (ready.ready) {
      console.log(chalk.bold(`  Your first agent, ${name}, is answering at ${chalk.cyan(url)}`))
    } else {
      console.log(chalk.bold(`  Your first agent, ${name}, is waiting for a model at ${chalk.cyan(url)}`))
      if (ready.hint) console.log(`  ${ready.hint}`)
    }
    console.log(chalk.dim(`  Run \`${cmd} start\` again any time: it reuses what is running.`))
    const boardPid = join(logDir, "board.pid")
    console.log(chalk.dim(`  Stop the daemon: ${cmd} daemon stop` + (existsSync(boardPid) ? `   ·   the dashboard: kill $(cat .agentx/board.pid)` : "")))
    console.log()
    if (opts.open !== false) openBrowser(url)
  })

function fail(message: string): never {
  console.error(chalk.red(`  ${message}`))
  process.exit(1)
}

function port(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`${flag} must be a port number, got "${value}"`)
  return n
}

function spawnDetached(cli: string, args: string[], cwd: string, logPath: string): number | undefined {
  const fd = openSync(logPath, "a")
  const child = spawn(process.execPath, [cli, ...args], { cwd, detached: true, stdio: ["ignore", fd, fd] })
  child.unref()
  return child.pid
}

async function health(baseUrl: string): Promise<any | null> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
    return r.ok ? await r.json().catch(() => ({})) : null
  } catch { return null }
}

async function answers(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number, log: string): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 400))
  }
  fail(`Timed out after ${timeoutMs / 1000}s waiting for ${what}. See ${log}, or raise --startup-timeout.`)
}
