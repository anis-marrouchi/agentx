import { Command } from "commander"
import chalk from "chalk"
import { spawn } from "child_process"
import { existsSync, readFileSync, unlinkSync } from "fs"
import { resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"
import {
  cliRestartPlan, describeService, waitForIdle,
  type RestartStep, type ServiceInfo,
} from "@/daemon/restart"
import { detectService, launchdLoaded, launchdPlistPath, pidListeningOn } from "@/daemon/restart-host"
import { SHUTDOWN_REQUEST_FILE, writeShutdownRequest } from "@/daemon/shutdown"

// --- agentx daemon restart [--when-idle] ---
//
// Restarts the daemon through whatever runs it (launchd, systemd, or a plain
// detached process), optionally waiting until no task is running first, and
// always waits for the new daemon to answer before reporting. See
// docs/jobs/restart-safely.md.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

/** In-flight count: the restart endpoint, else /health (older daemons only
 *  report per-agent active counts there). Null when the daemon is silent. */
async function readInflight(base: string): Promise<number | null> {
  const info = await getJson(`${base}/daemon/restart`)
  if (typeof info?.inflight?.total === "number") return info.inflight.total
  const h = await getJson(`${base}/health`)
  if (!h) return null
  if (typeof h.inflight?.total === "number") return h.inflight.total
  return Array.isArray(h.agents) ? h.agents.reduce((n: number, a: any) => n + (Number(a.active) || 0), 0) : null
}

function pidFromFiles(cwd: string): number | null {
  for (const f of [resolve(cwd, ".agentx/daemon.pid"), "/tmp/agentx-daemon.pid"]) {
    try {
      const pid = parseInt(readFileSync(f, "utf-8").trim(), 10)
      if (Number.isFinite(pid) && isAlive(pid)) return pid
    } catch { /* next */ }
  }
  return null
}

function execStep(argv: string[]): Promise<number> {
  return new Promise((ok) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" })
    child.on("error", () => ok(127))
    child.on("exit", (code) => ok(code ?? 1))
  })
}

export const restartCommand = new Command("restart")
  .description("restart the daemon through launchd, systemd or a plain stop + start; --when-idle waits for running tasks first")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--when-idle", "wait until no task is running before restarting")
  .option("--timeout <minutes>", "how long --when-idle waits", "30")
  .option("--abort-on-timeout", "with --when-idle: give up instead of restarting when the wait runs out")
  .option("--interval <seconds>", "how often --when-idle checks", "5")
  .option("--reload-service", "also re-read the service's settings file (launchd plist / systemd unit)")
  .option("--dry-run", "show what would run, without restarting")
  .action(async (opts) => {
    const config = loadDaemonConfig(opts.config)
    const [host, portStr] = config.node.bind.split(":")
    const port = parseInt(portStr || "18800", 10)
    const base = `http://${!host || host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`

    const health = await getJson(`${base}/health`)
    if (!health) {
      console.log(chalk.red(`  The daemon is not answering on ${base}; nothing to restart.`))
      console.log(chalk.dim("  Start it with: agentx daemon start --detach (or through its service)"))
      process.exit(1)
    }

    // Older daemons have no /daemon/restart; ask the host instead.
    const info = await getJson(`${base}/daemon/restart`)
    const pid: number | null = info?.pid ?? pidListeningOn(port) ?? pidFromFiles(process.cwd())
    const service: ServiceInfo = info?.service ?? (pid ? detectService(pid) : { kind: "none" })
    const daemonCwd: string = info?.cwd ?? process.cwd()
    const configPath: string | undefined = opts.config ?? info?.configPath

    const isRoot = process.getuid?.() === 0
    const plan = cliRestartPlan(service, {
      isRoot,
      reloadService: !!opts.reloadService,
      plistPath: service.kind === "launchd" && opts.reloadService ? launchdPlistPath(service) : null,
      interactive: !!process.stdin.isTTY,
    })

    console.log()
    console.log(`  Daemon ${chalk.bold(health.node?.name || health.node?.id || base)}${pid ? chalk.dim(` (PID ${pid})`) : ""}`)
    console.log(`  Run by: ${describeService(service)}`)
    if (!plan.ok) {
      console.log(chalk.red(`  ${plan.reason}`))
      console.log(chalk.dim(`  Restart it by hand: ${plan.manual}`))
      process.exit(1)
    }
    if (service.kind === "none" && !pid) {
      console.log(chalk.red("  Can't find the daemon's process, so it can't be stopped safely."))
      console.log(chalk.dim("  Run `agentx daemon stop`, then `agentx daemon start --detach`, from the directory holding agentx.json."))
      process.exit(1)
    }

    if (opts.dryRun) {
      console.log(chalk.dim("  Would run:"))
      for (const s of plan.steps) console.log(chalk.dim(`    ${describeStep(s, pid)}`))
      console.log()
      return
    }

    if (opts.whenIdle) {
      const minutes = Number(opts.timeout)
      const every = Math.max(1, Number(opts.interval) || 5)
      if (!Number.isFinite(minutes) || minutes < 0) {
        console.log(chalk.red("  --timeout must be a number of minutes"))
        process.exit(1)
      }
      let shown: number | null | undefined
      const r = await waitForIdle({
        read: () => readInflight(base),
        intervalMs: every * 1000,
        timeoutMs: minutes * 60_000,
        onCheck: (n) => {
          if (n !== shown && n !== null && n > 0) console.log(chalk.dim(`  Waiting: ${n} task(s) running...`))
          shown = n
        },
      })
      if (r.outcome === "unreachable") {
        console.log(chalk.red("  The daemon stopped answering while waiting. Not restarting it."))
        console.log(chalk.dim("  Check with: agentx daemon status"))
        process.exit(1)
      }
      if (r.outcome === "timeout") {
        const still = r.inflight ?? "some"
        if (opts.abortOnTimeout) {
          console.log(chalk.yellow(`  Still ${still} task(s) running after ${minutes} min. Not restarting (--abort-on-timeout).`))
          process.exit(1)
        }
        console.log(chalk.yellow(`  Still ${still} task(s) running after ${minutes} min. Restarting anyway:`))
        console.log(chalk.yellow("  they get the usual time to finish, and anything cut off is picked up again after the restart."))
      } else {
        console.log(chalk.green(`  No tasks running${r.waitedMs >= 1000 ? ` (waited ${Math.round(r.waitedMs / 1000)}s)` : ""}.`))
      }
    }

    // The daemon's log names who asked (daemon/shutdown.ts).
    const agentxDir = resolve(daemonCwd, ".agentx")
    try { writeShutdownRequest(agentxDir, { by: "agentx daemon restart", pid: process.pid, at: new Date().toISOString() }) } catch { /* best effort */ }

    const issuedAt = Date.now()
    const drainLimitMs = parseInt(process.env.AGENTX_DRAIN_TIMEOUT_MS || "300000", 10) + 60_000
    console.log(chalk.dim("  Restarting..."))
    for (const step of plan.steps) {
      const ok = await runStep(step, { pid, daemonCwd, configPath, drainLimitMs, service })
      if (ok) continue
      if (step.kind === "exec" && step.mayFail) continue
      // Nothing was stopped yet if the first step failed.
      const first = step === plan.steps[0]
      try { if (first) unlinkSync(resolve(agentxDir, SHUTDOWN_REQUEST_FILE)) } catch { /* */ }
      console.log(chalk.red(`  Step failed: ${describeStep(step, pid)}`))
      console.log(first
        ? chalk.dim(`  The daemon is still running. Restart it with: ${plan.manual}`)
        : chalk.red(`  The daemon may be down. Start it with: ${plan.manual}`))
      process.exit(1)
    }

    // Never report success until the new daemon answers.
    const backMs = 120_000
    const t0 = Date.now()
    while (Date.now() - t0 < backMs) {
      const h = await getJson(`${base}/health`)
      if (h && typeof h.uptime === "number" && h.uptime * 1000 <= Date.now() - issuedAt + 2000) {
        const now = await getJson(`${base}/daemon/restart`)
        console.log(chalk.green(`  Daemon is back${now?.pid ? ` (PID ${now.pid})` : ""} after ${Math.round((Date.now() - issuedAt) / 1000)}s.`))
        console.log()
        return
      }
      await sleep(1000)
    }
    console.log(chalk.red(`  The daemon did not come back within ${backMs / 60_000} min.`))
    console.log(chalk.dim(`  Start it with: ${plan.manual}`))
    console.log(chalk.dim("  Then check the log: agentx daemon logs"))
    process.exit(1)
  })

function describeStep(s: RestartStep, pid: number | null): string {
  switch (s.kind) {
    case "exec": return s.argv.join(" ")
    case "sigterm": return `kill -TERM ${pid ?? "<pid>"}  (the daemon finishes running tasks, then exits)`
    case "wait-exit": return "wait for the old daemon to exit"
    case "wait-unloaded": return "wait until launchd has unloaded the job"
    case "start-detached": return "agentx daemon start --detach"
  }
}

async function runStep(
  s: RestartStep,
  ctx: { pid: number | null; daemonCwd: string; configPath?: string; drainLimitMs: number; service: ServiceInfo },
): Promise<boolean> {
  switch (s.kind) {
    case "exec":
      return (await execStep(s.argv)) === 0
    case "sigterm":
      if (!ctx.pid) return false
      try { process.kill(ctx.pid, "SIGTERM"); return true } catch { return false }
    case "wait-exit": {
      if (!ctx.pid) return true
      const t0 = Date.now()
      let told = false
      while (isAlive(ctx.pid) && Date.now() - t0 < ctx.drainLimitMs) {
        if (!told && Date.now() - t0 > 3000) {
          console.log(chalk.dim("  Waiting for the old daemon to finish its tasks and exit..."))
          told = true
        }
        await sleep(500)
      }
      if (isAlive(ctx.pid)) {
        console.log(chalk.yellow(`  The old daemon (PID ${ctx.pid}) is still finishing tasks; not starting a second one.`))
        return false
      }
      return true
    }
    case "wait-unloaded": {
      if (ctx.service.kind !== "launchd") return true
      const t0 = Date.now()
      while (launchdLoaded(ctx.service) && Date.now() - t0 < 30_000) await sleep(500)
      return !launchdLoaded(ctx.service)
    }
    case "start-detached": {
      const cli = process.argv[1]
      if (!cli || !existsSync(cli)) return false
      const args = [cli, "daemon", "start", "--detach", ...(ctx.configPath ? ["-c", ctx.configPath] : [])]
      return new Promise((ok) => {
        const child = spawn(process.execPath, args, { cwd: ctx.daemonCwd, stdio: "inherit" })
        child.on("error", () => ok(false))
        child.on("exit", (code) => ok(code === 0))
      })
    }
  }
}
