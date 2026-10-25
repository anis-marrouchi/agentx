import { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"
import { CLOUD_SESSIONS_DEFAULTS, CloudSessionStore } from "@/agents/cloud-sessions"

// --- agentx cloud-sessions — the Claude cloud sessions this node started (#1367) ---
//
//   agentx cloud-sessions list [--all]        sessions that still block their issue
//   agentx cloud-sessions close <owner/repo#n>…  forget them, so the next comment runs normally
//
// Reads and writes .agentx/cloud-sessions.json in the folder `agentx` runs
// from, like the daemon. The daemon re-reads the file when it changes, so a
// close takes effect without a restart.

export const cloudSessionsCmd = new Command()
  .name("cloud-sessions")
  .description("list and close the Claude cloud sessions that block their GitHub issue")

interface Opts { file?: string; config?: string }

const common = (c: Command) => c
  .option("--file <path>", "session file", ".agentx/cloud-sessions.json")
  .option("-c, --config <path>", "daemon config file, for each agent's openHours")

function store(opts: Opts): CloudSessionStore {
  return new CloudSessionStore(resolve(process.cwd(), opts.file || ".agentx/cloud-sessions.json"))
}

/** Each agent's openHours, from the daemon config; the default when it cannot be read. */
function openHoursOf(opts: Opts): (agentId: string) => number {
  let agents: Record<string, { cloudSessions?: { openHours?: number } }> = {}
  try { agents = loadDaemonConfig(opts.config).agents as typeof agents } catch { /* defaults */ }
  return (agentId) => agents[agentId]?.cloudSessions?.openHours ?? CLOUD_SESSIONS_DEFAULTS.openHours
}

/** "owner/repo#42" or "owner/repo:issue:42" (the GitHub chat id). */
export function parseIssueRef(ref: string): { repo: string; number: number } | undefined {
  const m = ref.trim().match(/^([^\/\s#:]+\/[^\/\s#:]+)(?:#|:(?:issue|pull):)(\d+)$/)
  if (!m) return undefined
  const number = Number(m[2])
  return number > 0 ? { repo: m[1], number } : undefined
}

common(cloudSessionsCmd
  .command("list")
  .description("cloud sessions still open for their issue, newest first")
  .option("--all", "include sessions whose open time is over"))
  .action((opts: Opts & { all?: boolean }) => {
    const hours = openHoursOf(opts)
    const now = Date.now()
    const rows = store(opts).all()
      .map((s) => ({ s, open: now - s.startedAt < hours(s.agentId) * 3600_000 }))
      .filter((r) => opts.all || r.open)
      .sort((a, b) => b.s.startedAt - a.s.startedAt)
    if (!rows.length) {
      console.log(chalk.dim(`  no ${opts.all ? "" : "open "}cloud sessions`))
      return
    }
    for (const { s, open } of rows) {
      const started = new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " ")
      console.log(`  ${s.repo}#${s.number}  ${s.sessionId}  ${chalk.dim(`${s.agentId}, started ${started}`)}  ${open ? chalk.yellow("open") : chalk.dim("over")}`)
    }
  })

common(cloudSessionsCmd
  .command("close <refs...>")
  .description("forget the session for each issue (owner/repo#42), so its next comment runs normally"))
  .action((refs: string[], opts: Opts) => {
    const s = store(opts)
    let failed = false
    for (const ref of refs) {
      const target = parseIssueRef(ref)
      if (!target) {
        console.log(chalk.red(`  ${ref}: expected owner/repo#number`))
        failed = true
        continue
      }
      if (s.close(target.repo, target.number)) console.log(chalk.green(`  closed ${target.repo}#${target.number}`))
      else console.log(chalk.dim(`  ${target.repo}#${target.number}: no session recorded`))
    }
    if (failed) process.exitCode = 1
  })
