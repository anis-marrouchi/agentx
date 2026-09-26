import { Command } from "commander"
import chalk from "chalk"
import { mutateAgentxConfig } from "@/daemon/config-mutate"
import { loadDaemonConfig } from "@/daemon/config"
import { localSettings, patchLocal } from "@/notify/local"
import { ntfyStatus, patchNtfy } from "@/notify/ntfy-settings"

// --- agentx notifications — manage where + when AgentX pings the operator ---
//
// Closes the audit gap: notifications.* in agentx.json had no CLI surface.
// Operators tuning where task-error pings land or which event types are
// surfaced were stuck hand-editing JSON.
//
// The whole notifications block is small: a destination (channel/chatId/
// accountId), three event toggles (taskComplete / taskError / taskQueued),
// a longTaskThreshold, and `local` — the banner and sound `agentx notify`
// gives on this Mac.

function readNotifications(): any {
  try { return (loadDaemonConfig() as any).notifications || {} } catch { return {} }
}

function readNtfy(): any {
  try { return (loadDaemonConfig() as any).channels?.ntfy } catch { return undefined }
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
    const local = localSettings(n.local)
    console.log(`  local.banner      ${local.banner ? "on" : chalk.dim("off")}`)
    console.log(`  local.sound       ${local.sound ? `${local.soundName} at ${local.volume}` : chalk.dim("off")}`)
    console.log(`  local.icon        ${local.icon ?? chalk.dim("AgentX logo")}`)
    const ntfy = ntfyStatus(readNtfy())
    console.log(`  ntfy              ${ntfy.enabled ? "on" : chalk.dim("off")} ${chalk.dim(`${ntfy.server} · topic ${ntfy.topicSet ? "set" : "unset"} · token ${ntfy.tokenSet ? "set" : "unset"}`)}`)
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

notifications
  .command("local")
  .description("set what `agentx notify` does on this Mac: banner, sound, sound name, volume, banner icon")
  .option("--banner <state>", "on | off")
  .option("--sound <state>", "on | off")
  .option("--sound-name <name>", "a macOS system sound, e.g. Glass, Ping, Tink")
  .option("--volume <n>", "0 to 1")
  .option("--icon <path>", 'image for the banner icon (.png, .jpg, .icns); "" for the AgentX logo')
  .action((opts) => {
    const onOff = (flag: string, v: string): boolean => {
      const s = v.toLowerCase()
      if (["on", "true", "1"].includes(s)) return true
      if (["off", "false", "0"].includes(s)) return false
      console.log(chalk.red(`  ${flag} must be on|off`))
      process.exit(1)
    }
    const patch: Record<string, unknown> = {}
    if (opts.banner !== undefined) patch.banner = onOff("--banner", opts.banner)
    if (opts.sound !== undefined) patch.sound = onOff("--sound", opts.sound)
    if (opts.soundName !== undefined) patch.soundName = opts.soundName
    if (opts.volume !== undefined) patch.volume = opts.volume
    if (opts.icon !== undefined) patch.icon = opts.icon
    if (Object.keys(patch).length === 0) {
      console.log(chalk.red("  nothing to change — pass --banner, --sound, --sound-name, --volume or --icon"))
      process.exit(1)
    }
    try {
      mutate((n) => {
        n.local = patchLocal(n.local, patch)
        return `notifications.local = ${JSON.stringify(n.local)}`
      })
      if (opts.icon !== undefined) console.log(chalk.dim(`  Run agentx desktop install to put the new icon on the helper.\n`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e?.message ?? e}`))
      process.exit(1)
    }
  })

notifications
  .command("ntfy")
  .description("set up phone push through ntfy: server, topic, token, on/off")
  .option("--server <url>", "ntfy server (default https://ntfy.sh)")
  .option("--topic <topic>", 'topic to publish to; a secret on ntfy.sh — "${NTFY_TOPIC}" reads it from .env')
  .option("--token <token>", 'access token for a protected topic; "${NTFY_TOKEN}" reads it from .env; "" removes it')
  .option("--enable", "turn the channel on")
  .option("--disable", "turn the channel off")
  .action((opts) => {
    const patch: Record<string, unknown> = {}
    if (opts.server !== undefined) patch.server = opts.server
    if (opts.topic !== undefined) patch.topic = opts.topic
    if (opts.token !== undefined) patch.token = opts.token
    if (opts.enable) patch.enabled = true
    if (opts.disable) patch.enabled = false
    if (Object.keys(patch).length === 0) {
      console.log(chalk.red("  nothing to change — pass --server, --topic, --token, --enable or --disable"))
      process.exit(1)
    }
    try {
      const { summary, backupPath } = mutateAgentxConfig((cfg) => {
        cfg.channels = cfg.channels || {}
        cfg.channels.ntfy = patchNtfy(cfg.channels.ntfy, patch)
        const s = ntfyStatus(cfg.channels.ntfy)
        return `channels.ntfy ${s.enabled ? "on" : "off"} · ${s.server} · topic ${s.topicSet ? "set" : "unset"} · token ${s.tokenSet ? "set" : "unset"}`
      })
      console.log(chalk.green(`\n  ✓ ${summary}`))
      if (backupPath) console.log(chalk.dim(`  Backup: ${backupPath}`))
      console.log(chalk.dim(`  Restart the daemon for a channel change to take effect.\n`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e?.message ?? e}`))
      process.exit(1)
    }
  })
