import { Command } from "commander"
import chalk from "chalk"
import { mutateAgentxConfig } from "@/daemon/config-mutate"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx notifications — manage where + when AgentX pings the operator ---
//
// Closes the audit gap: notifications.* in agentx.json had no CLI surface.
// Operators tuning where task-error pings land or which event types are
// surfaced were stuck hand-editing JSON.
//
// The whole notifications block is small: a destination (channel/chatId/
// accountId), three event toggles (taskComplete / taskError / taskQueued),
// and a longTaskThreshold.

function readNotifications(): any {
  try { return (loadDaemonConfig() as any).notifications || {} } catch { return {} }
}

function mutate(mutator: (n: any) => string): void {
  const { summary, backupPath } = mutateAgentxConfig((cfg) => {
    cfg.notifications = cfg.notifications || {}
    return mutator(cfg.notifications)
  })
  console.log(chalk.green(`\n  ✓ ${summary}`))
  if (backupPath) console.log(chalk.dim(`  Backup: ${backupPath}`))
  console.log(chalk.dim(`  Restart the daemon (or POST /reload) for the change to take effect.\n`))
}

export const notifications = new Command()
  .name("notifications")
  .description("manage notifications routing — destination, event toggles, long-task threshold")

notifications
  .command("show")
  .description("print current notifications config")
  .option("--json", "JSON output")
  .action((opts) => {
    const n = readNotifications()
    if (opts.json) { console.log(JSON.stringify(n, null, 2)); return }
    console.log()
    if (n.destination) {
      const acct = n.destination.accountId ? ` · account=${n.destination.accountId}` : ""
      console.log(`  destination       ${chalk.cyan(n.destination.channel + ":" + n.destination.chatId)}${chalk.dim(acct)}`)
    } else {
      console.log(`  destination       ${chalk.dim("(unset — notifications go to the daemon log only)")}`)
    }
    console.log(`  longTaskThreshold ${n.longTaskThreshold ?? 30}s ${chalk.dim("(0 disables long-task pings)")}`)
    const on = n.on || {}
    console.log(`  on.taskComplete   ${on.taskComplete === false ? chalk.dim("off") : "on"}`)
    console.log(`  on.taskError      ${on.taskError === false ? chalk.dim("off") : "on"}`)
    console.log(`  on.taskQueued     ${on.taskQueued ? "on" : chalk.dim("off")}`)
    console.log()
  })

notifications
  .command("route")
  .description("set the destination channel/chatId for notifications")
  .requiredOption("--channel <name>", "telegram | whatsapp | slack | discord")
  .requiredOption("--chat-id <id>", "native chat id (e.g. -100…, JID, channel id)")
  .option("--account-id <id>", "channel account id when the channel is multi-account (telegram with multiple bots)")
  .option("--clear", "clear the destination instead of setting it")
  .action((opts) => {
    if (opts.clear) {
      mutate((n) => { delete n.destination; return "notifications destination cleared" })
      return
    }
    mutate((n) => {
      n.destination = {
        channel: opts.channel,
        chatId: opts.chatId,
        ...(opts.accountId ? { accountId: opts.accountId } : {}),
      }
      return `notifications destination → ${opts.channel}:${opts.chatId}${opts.accountId ? ` (account=${opts.accountId})` : ""}`
    })
  })

notifications
  .command("event <name> <state>")
  .description("toggle an event: name in {taskComplete, taskError, taskQueued}; state in {on, off}")
  .action((name: string, state: string) => {
    const known = ["taskComplete", "taskError", "taskQueued"]
    if (!known.includes(name)) {
      console.log(chalk.red(`  unknown event "${name}". Pick from: ${known.join(", ")}`))
      process.exit(1)
    }
    const onv = state.toLowerCase()
    if (!["on", "off", "true", "false", "1", "0"].includes(onv)) {
      console.log(chalk.red(`  state must be on|off`))
      process.exit(1)
    }
    const enabled = onv === "on" || onv === "true" || onv === "1"
    mutate((n) => {
      n.on = n.on || {}
      n.on[name] = enabled
      return `notifications.on.${name} = ${enabled}`
    })
  })

notifications
  .command("threshold <seconds>")
  .description("set the long-task threshold in seconds (0 disables long-task pings)")
  .action((seconds: string) => {
    const n = parseInt(seconds, 10)
    if (!Number.isFinite(n) || n < 0) {
      console.log(chalk.red("  threshold must be a non-negative integer"))
      process.exit(1)
    }
    mutate((cfg) => {
      cfg.longTaskThreshold = n
      return `longTaskThreshold = ${n}s`
    })
  })
