import { Command } from "commander"
import chalk from "chalk"
import {
  notify as sendNotification,
  flushHeld,
  readFocus,
  focusLabel,
  NotificationQueue,
  localAlert,
  localSettings,
  type LocalAlert,
  type Sender,
} from "@/notify"
import { loadDaemonConfig } from "@/daemon/config"
import { proofAlert, type Proof } from "@/notify/proof"
import { resolveRegion } from "@/computer-use/capture"
import { readScreenSettings } from "@/computer-use/capture-settings"

// --- `agentx notify "<message>"` ---
//
// A shoulder tap for the person running the fleet, routed so that it never
// arrives during a Focus they explicitly turned on.
//
// It goes through the daemon rather than talking to a push service directly, because
// the daemon already owns the channel router — the same path that POST
// /send, cron failure pings and channel.reply all use. A second delivery
// path would mean a second place for the topic, the token and the retry
// behaviour to drift.

const DAEMON = process.env.AGENTX_DAEMON_URL ?? "http://127.0.0.1:18800"

/** Push through the daemon's channel router.
 *
 *  The push and ntfy adapters take the TITLE FROM THE FIRST LINE of the text — a
 *  separate `title` field is ignored — so the title is prepended rather
 *  than passed alongside. Sending it as its own field looked like it
 *  worked: the push arrived, with the default title, and the real one
 *  silently discarded. */
function daemonSender(defaultChannel: string, defaultChatId: string): Sender {
  return async ({ title, message, channel, chatId }) => {
    const text = title && !message.startsWith(title) ? `${title}\n${message}` : message
    const res = await fetch(`${DAEMON}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A held entry remembers where it was going; anything else uses the
      // channel this invocation was given.
      body: JSON.stringify({
        channel: channel ?? defaultChannel,
        chatId: chatId ?? defaultChatId,
        text,
      }),
    })
    if (!res.ok) {
      throw new Error(`daemon ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
    }
  }
}

/** The local banner and sound, as `notifications.local` in agentx.json
 *  sets them, minus whatever the flags switch off. A missing or invalid
 *  config means the defaults: a notification should never fail over a
 *  settings file. */
function configuredAlert(opts: { config?: string; sound: boolean; banner: boolean; channel?: string }): { alert: LocalAlert; banner: boolean; channel: string } {
  let notifications
  try {
    notifications = loadDaemonConfig(opts.config).notifications
  } catch {
    notifications = undefined
  }
  const settings = localSettings(notifications?.local)
  if (!opts.sound) settings.sound = false
  if (!opts.banner) settings.banner = false
  // --channel wins; otherwise notifications.channel, which defaults to push.
  const channel = opts.channel ?? notifications?.channel ?? "push"
  return { alert: localAlert(settings), banner: settings.banner, channel }
}

export const notify = new Command()
  .name("notify")
  .description("tell the operator something, holding it if they are in Focus")
  .argument("[message]", "what to say")
  .option("--from <who>", "who is speaking", "agentx")
  .option("--title <text>", "notification title", "AgentX")
  .option("--priority <n>", "1 (min) to 5 (max)", "4")
  .option("--urgent", "deliver even during Focus")
  .option("--channel <name>", "delivery channel (default: notifications.channel, which is push)")
  .option("--chat-id <id>", "channel address", "default")
  .option("--no-sound", "do not play a sound on this machine")
  .option("--no-banner", "do not show a banner on this machine")
  .option("-c, --config <path>", "agentx.json to read local settings from (default: ./agentx.json)")
  .option("--proof", "capture the banner as it shows and print the frame's path")
  .option("--status", "show Focus state and anything being held")
  .option("--flush", "deliver everything held, as one message")
  .option("--json", "emit the result as JSON")
  .action(async (message: string | undefined, opts) => {
    const queue = new NotificationQueue()
    const state = readFocus()
    const { alert, banner, channel } = configuredAlert(opts)
    // --proof applies to this call's own banner only: not to --flush, and
    // not to the fallback alert after a failed push.
    let sendAlert = alert
    let proof: (() => Proof) | undefined
    if (opts.proof && !banner) {
      proof = () => ({ shot: null, error: "the banner is off, so there is nothing to capture" })
    } else if (opts.proof) {
      // The banner region from agentx.json when one is named
      // "notifications", else the helper's built-in corner.
      const settings = readScreenSettings(opts.config)
      const wrapped = proofAlert(alert, resolveRegion("notifications", settings), { settings })
      sendAlert = wrapped.alert
      proof = wrapped.proof
    }

    if (opts.status) {
      const waiting = queue.list()
      if (opts.json) {
        console.log(JSON.stringify({ focus: state, held: waiting }, null, 2))
        return
      }
      console.log(`  ${state.active ? chalk.yellow("◐") : chalk.green("○")} ${focusLabel(state)} ${chalk.dim(`· ${state.reason}`)}`)
      console.log(`  ${waiting.length} held`)
      for (const w of waiting.slice(0, 8)) {
        const when = new Date(w.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        console.log(chalk.dim(`     ${when}  ${w.from}: ${w.message.slice(0, 70)}`))
      }
      return
    }

    const send = daemonSender(channel, opts.chatId)

    if (opts.flush) {
      const n = await flushHeld(send, { queue, alert })
      console.log(n ? chalk.green(`  delivered ${n} held notification(s)`) : chalk.dim("  nothing was held"))
      return
    }

    if (!message?.trim()) {
      console.log(chalk.red("  nothing to say — pass a message, or use --status / --flush"))
      process.exit(1)
    }

    try {
      const result = await sendNotification(
        {
          message: message.trim(),
          from: opts.from,
          title: opts.title,
          priority: Number(opts.priority) || 4,
          urgent: Boolean(opts.urgent),
          channel,
          chatId: opts.chatId,
        },
        send,
        { queue, alert: sendAlert, focus: state },
      )
      const p = proof?.()
      if (opts.json) {
        console.log(JSON.stringify(p ? { ...result, proof: p } : result, null, 2))
        return
      }
      const mark = result.delivered ? chalk.green("→") : chalk.yellow("⏸")
      console.log(`  ${mark} ${result.reason}`)
      if (result.held) {
        console.log(chalk.dim("    it will arrive with the others when Focus ends"))
      }
      if (p?.shot) console.log(`  ${p.error ? chalk.yellow("?") : chalk.green("✓")} banner: ${p.shot.path}${chalk.dim(` · ${p.shot.waitedMs}ms`)}`)
      if (p?.error) console.log(chalk.yellow(`    ${p.error}`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e?.message ?? e}`))
      // A failed push should still show up on this machine rather than
      // failing completely silently.
      await alert(opts.title, message.trim())
      process.exit(1)
    }
  })
