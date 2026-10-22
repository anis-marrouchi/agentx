import { Command } from "commander"
import chalk from "chalk"
import {
  notify as sendNotification,
  flushHeld,
  readHold,
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
import { defaultNotifyChannel } from "@/notify/push-settings"
import { noticeRuleBreak, withTodo } from "@/approvals/screen-gate"

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
function daemonSender(defaultChannel: string, defaultChatId: string, told?: Record<string, unknown>): { send: Sender; keptBack: () => string | null } {
  // The told-the-owner gate (#1126) may keep a notice back: already told,
  // or a nag kept for the daily digest. The daemon says so in its answer.
  let keptBack: string | null = null
  const send: Sender = async ({ title, message, channel, chatId }) => {
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
        ...(told ? { told } : {}),
      }),
    })
    if (!res.ok) {
      throw new Error(`daemon ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
    }
    const data = await res.json().catch(() => ({})) as { sent?: boolean; told?: string }
    keptBack = data.sent === false ? data.told ?? "kept back" : null
  }
  return { send, keptBack: () => keptBack }
}

/** The local banner and sound, as `notifications.local` in agentx.json
 *  sets them, minus whatever the flags switch off. A missing or invalid
 *  config means the defaults: a notification should never fail over a
 *  settings file. */
function configuredAlert(opts: { config?: string; sound: boolean; banner: boolean; channel?: string }): { alert: LocalAlert; banner: boolean; channel: string } {
  let cfg
  try {
    cfg = loadDaemonConfig(opts.config)
  } catch {
    cfg = undefined
  }
  const settings = localSettings(cfg?.notifications.local)
  if (!opts.sound) settings.sound = false
  if (!opts.banner) settings.banner = false
  // --channel wins; then notifications.channel; then push if it is on, else ntfy.
  const channel = opts.channel ?? defaultNotifyChannel(cfg)
  return { alert: localAlert(settings, { native: cfg?.native }), banner: settings.banner, channel }
}

export const notify = new Command()
  .name("notify")
  .description("tell the operator something, holding it if they are in Focus")
  .argument("[message]", "what to say")
  .option("--from <who>", "who is speaking", "agentx")
  .option("--title <text>", "notification title", "AgentX")
  .option("--todo <text>", "what the owner should do about it, shown as a To do line after the message (default: nothing, FYI)")
  .option("--priority <n>", "1 (min) to 5 (max)", "4")
  .option("--urgent", "deliver even during Focus, and even if the same thing was told already")
  .option("--key <id>", "what it is about, so it is told once across channels (default: its text)")
  .option("--request <id>", "the open request it belongs to")
  .option("--digest", "a nag (disk low, a channel down): wait for the daily digest instead of a push")
  .option("--told", "what the owner was told in the last 24 hours, by outcome")
  .option("--channel <name>", "delivery channel (default: notifications.channel, else push when it is on, else ntfy)")
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
    const state = readHold()
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

    if (opts.told) {
      const res = await fetch(`${DAEMON}/owner/told`).catch((e) => { throw new Error(`daemon not reachable at ${DAEMON}: ${e?.message ?? e}`) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) { console.log(chalk.red(`  ${data.error ?? `daemon ${res.status}`}`)); process.exit(1) }
      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
      const c = data.counts ?? {}
      console.log(`  Last 24 h: ${c.sent ?? 0} sent, ${c.held ?? 0} held for Focus or a call, ${c.digest ?? 0} kept for the digest, ${c.repeat ?? 0} not repeated, ${c.failed ?? 0} failed`)
      console.log(chalk.dim(`  ${data.waitingForDigest ?? 0} waiting for the next digest`))
      for (const r of (data.items ?? []).slice(0, 10)) {
        const when = new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        console.log(chalk.dim(`     ${when}  ${r.outcome.padEnd(6)} ${r.channel}  ${String(r.title).slice(0, 70)}`))
      }
      return
    }

    // What it is about, for the told-the-owner gate (#1126).
    const told = {
      ...(opts.key ? { key: String(opts.key) } : {}),
      ...(opts.request ? { requestId: String(opts.request) } : {}),
      ...(opts.digest ? { kind: "nag" } : {}),
      ...(opts.urgent ? { urgent: true } : {}),
      // A notice: the same words again within the window are a repeat.
      textKey: true,
      from: opts.from,
    }
    const sender = daemonSender(channel, opts.chatId, told)
    const send = sender.send
    // Kept back by the gate: nothing reached the phone, so nothing shows here either.
    const gatedAlert = async (title: string, text: string) => { if (!sender.keptBack()) await sendAlert(title, text) }

    if (opts.flush) {
      const n = await flushHeld(daemonSender(channel, opts.chatId).send, { queue, alert })
      console.log(n ? chalk.green(`  delivered ${n} held notification(s)`) : chalk.dim("  nothing was held"))
      return
    }

    if (!message?.trim()) {
      console.log(chalk.red("  nothing to say — pass a message, or use --status / --flush"))
      process.exit(1)
    }
    // What the owner must do comes last, after the message, and counts
    // toward the 300 characters like the rest of it.
    const text = withTodo(message.trim(), opts.todo)
    // The screen gate (#394): refused, never cut; the caller shortens it.
    const broken = noticeRuleBreak(opts.title, text)
    if (broken) {
      console.log(chalk.red(`  not sent: ${broken}. Say it so it reads in about ten seconds, or put the detail on a card or an issue.`))
      process.exit(1)
    }

    try {
      const result = await sendNotification(
        {
          message: text,
          from: opts.from,
          title: opts.title,
          priority: Number(opts.priority) || 4,
          urgent: Boolean(opts.urgent),
          channel,
          chatId: opts.chatId,
        },
        send,
        // A nag goes to the daemon at once: it waits for the digest there,
        // and the Focus queue would lose that it is one.
        { queue, alert: gatedAlert, focus: opts.digest ? { active: false, mode: null, reason: "kept for the digest" } : state },
      )
      const p = proof?.()
      const kept = sender.keptBack()
      if (opts.json) {
        const out = kept ? { ...result, delivered: false, told: kept, reason: kept === "repeat" ? "already told" : "kept for the daily digest" } : result
        console.log(JSON.stringify(p ? { ...out, proof: p } : out, null, 2))
        return
      }
      if (kept) {
        console.log(`  ${chalk.yellow("·")} not sent: ${kept === "repeat" ? "the owner was already told this" : "kept for the daily digest"}`)
        return
      }
      const mark = result.delivered ? chalk.green("→") : chalk.yellow("⏸")
      console.log(`  ${mark} ${result.reason}`)
      if (result.held) {
        console.log(chalk.dim("    it will arrive with the others when Focus or the call ends"))
      }
      if (p?.shot) console.log(`  ${p.error ? chalk.yellow("?") : chalk.green("✓")} banner: ${p.shot.path}${chalk.dim(` · ${p.shot.waitedMs}ms`)}`)
      if (p?.error) console.log(chalk.yellow(`    ${p.error}`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e?.message ?? e}`))
      // A failed push should still show up on this machine rather than
      // failing completely silently.
      await alert(opts.title, text)
      process.exit(1)
    }
  })
