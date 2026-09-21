import { Command } from "commander"
import chalk from "chalk"
import {
  notify as sendNotification,
  flushHeld,
  readFocus,
  focusLabel,
  NotificationQueue,
  playSound,
  type Sender,
} from "@/notify"

// --- `agentx notify "<message>"` ---
//
// A shoulder tap for the person running the fleet, routed so that it never
// arrives during a Focus they explicitly turned on.
//
// It goes through the daemon rather than talking to ntfy directly, because
// the daemon already owns the channel router — the same path that POST
// /send, cron failure pings and channel.reply all use. A second delivery
// path would mean a second place for the topic, the token and the retry
// behaviour to drift.

const DAEMON = process.env.AGENTX_DAEMON_URL ?? "http://127.0.0.1:18800"

/** Push through the daemon's channel router.
 *
 *  The ntfy adapter takes its TITLE FROM THE FIRST LINE of the text — a
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

export const notify = new Command()
  .name("notify")
  .description("tell the operator something, holding it if they are in Focus")
  .argument("[message]", "what to say")
  .option("--from <who>", "who is speaking", "agentx")
  .option("--title <text>", "notification title", "Secretary")
  .option("--priority <n>", "1 (min) to 5 (max)", "4")
  .option("--urgent", "deliver even during Focus")
  .option("--channel <name>", "delivery channel", "ntfy")
  .option("--chat-id <id>", "channel address", "default")
  .option("--no-sound", "do not play a sound on this machine")
  .option("--status", "show Focus state and anything being held")
  .option("--flush", "deliver everything held, as one message")
  .option("--json", "emit the result as JSON")
  .action(async (message: string | undefined, opts) => {
    const queue = new NotificationQueue()
    const state = readFocus()
    const sound = opts.sound === false ? false : undefined

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

    const send = daemonSender(opts.channel, opts.chatId)

    if (opts.flush) {
      const n = await flushHeld(send, { queue, sound })
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
          channel: opts.channel,
          chatId: opts.chatId,
        },
        send,
        { queue, sound, focus: state },
      )
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      const mark = result.delivered ? chalk.green("→") : chalk.yellow("⏸")
      console.log(`  ${mark} ${result.reason}`)
      if (result.held) {
        console.log(chalk.dim("    it will arrive with the others when Focus ends"))
      }
    } catch (e: any) {
      console.log(chalk.red(`  ${e?.message ?? e}`))
      // A failed push should still make a noise on this machine rather
      // than failing completely silently.
      if (sound !== false) playSound()
      process.exit(1)
    }
  })
