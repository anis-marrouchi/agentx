import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx process — operator surface for the persistent claude registry ---
//
// Two subcommands:
//   agentx process list                  list every live handle
//   agentx process kill <agentId> <channel> <chatId>   force-rotate one handle
//
// Both talk to the local daemon's HTTP API. The registry is in-memory
// (no SQLite persistence) so a daemon restart fully resets it; this CLI
// is the only mid-flight operator surface short of a restart.

export const process_ = new Command()
  .name("process")
  .description("inspect / rotate persistent claude processes (--persistentProcess agents)")

interface ResolvedDaemon {
  baseUrl: string
  token: string
}

function resolveDaemon(opts: { node?: string; token?: string; config?: string }): ResolvedDaemon {
  let baseUrl = typeof opts.node === "string" ? opts.node : ""
  let token = typeof opts.token === "string" ? opts.token : ""
  if (!baseUrl || !token) {
    try {
      const cfg = loadDaemonConfig(opts.config)
      if (!baseUrl) baseUrl = cfg.dashboard?.daemonUrl || ""
      if (!token) token = cfg.dashboard?.token || ""
    } catch { /* fall back to defaults */ }
  }
  if (!baseUrl) baseUrl = "http://localhost:18800"
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token }
}

function authHeaders(token: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {}
  if (token) h["Authorization"] = `Bearer ${token}`
  if (contentType) h["Content-Type"] = contentType
  return h
}

function fmtAge(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function stateColor(s: string): (text: string) => string {
  if (s === "warm-hot") return chalk.green
  if (s === "warm-cold") return chalk.cyan
  if (s === "idle") return chalk.yellow
  if (s === "dead") return chalk.red
  return chalk.dim
}

// ---------------------------------------------------------------------------
// agentx process list
// ---------------------------------------------------------------------------

process_
  .command("list")
  .description("list every live persistent claude process")
  .option("-c, --config <path>", "daemon config file")
  .option("--node <url>", "daemon URL (defaults to dashboard.daemonUrl)")
  .option("--token <token>", "bearer token (defaults to dashboard.token)")
  .option("--json", "emit JSON")
  .action(async (opts) => {
    const { baseUrl, token } = resolveDaemon(opts)
    let res: Response
    try {
      res = await fetch(`${baseUrl}/api/processes`, { headers: authHeaders(token) })
    } catch (e: any) {
      console.log(chalk.red(`  could not reach daemon at ${baseUrl}: ${e.message || e}`))
      process.exit(1)
    }
    if (res.status === 503) {
      console.log(chalk.dim(`  daemon at ${baseUrl} has no agents with persistentProcess: true`))
      return
    }
    if (!res.ok) {
      console.log(chalk.red(`  HTTP ${res.status} from ${baseUrl}/processes`))
      process.exit(1)
    }
    const body = (await res.json()) as { processes: Array<Record<string, any>> }
    const procs = body.processes ?? []

    if (opts.json) {
      console.log(JSON.stringify(procs, null, 2))
      return
    }
    if (procs.length === 0) {
      console.log(chalk.dim(`  (no processes)`))
      return
    }

    for (const p of procs) {
      const state = stateColor(p.state)(p.state.padEnd(9))
      const age = fmtAge(p.spawnedAt)
      const lastTurn = p.lastTurnAt ? fmtAge(p.lastTurnAt) + " ago" : "—"
      const tokens = p.lastInputTokens ? chalk.dim(`last_in=${p.lastInputTokens} tok`) : ""
      const session = p.claudeSessionId ? chalk.dim(`sess=${p.claudeSessionId.slice(0, 8)}…`) : chalk.dim("sess=—")
      const pending = p.pendingTaskId ? chalk.cyan(`task=${String(p.pendingTaskId).slice(0, 12)}`) : ""
      console.log(
        `${state} ${chalk.bold(p.key.agentId)}${chalk.dim(":" + p.key.channel + ":" + p.key.chatId)}` +
        ` ${chalk.dim("·")} pid=${p.pid ?? "?"} age=${age} turn#${p.turnCount} last=${lastTurn} ${session} ${tokens} ${pending}`,
      )
      if (p.deadReason) console.log(`    ${chalk.red("dead:")} ${p.deadReason}`)
    }
  })

// ---------------------------------------------------------------------------
// agentx process kill
// ---------------------------------------------------------------------------

process_
  .command("kill <agentId> <channel> <chatId>")
  .description("force-kill one persistent process (the next dispatch will spawn fresh)")
  .option("-c, --config <path>", "daemon config file")
  .option("--node <url>", "daemon URL (defaults to dashboard.daemonUrl)")
  .option("--token <token>", "bearer token (defaults to dashboard.token)")
  .option("-r, --reason <reason>", "kill reason (recorded on the dead-process snapshot)", "operator-cli")
  .action(async (agentId: string, channel: string, chatId: string, opts) => {
    const { baseUrl, token } = resolveDaemon(opts)
    let res: Response
    try {
      res = await fetch(`${baseUrl}/api/processes/kill`, {
        method: "POST",
        headers: authHeaders(token, "application/json"),
        body: JSON.stringify({ agentId, channel, chatId, reason: opts.reason }),
      })
    } catch (e: any) {
      console.log(chalk.red(`  could not reach daemon at ${baseUrl}: ${e.message || e}`))
      process.exit(1)
    }
    if (res.status === 503) {
      console.log(chalk.dim(`  daemon has no persistent-process registry`))
      return
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { const body = (await res.json()) as { error?: string }; if (body.error) msg += ` — ${body.error}` } catch { /* */ }
      console.log(chalk.red(`  ${msg}`))
      process.exit(1)
    }
    console.log(chalk.green(`  killed ${agentId}:${channel}:${chatId}`))
  })
