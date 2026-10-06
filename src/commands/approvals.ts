import { Command } from "commander"
import chalk from "chalk"
import { createCard, IF_SILENT_VALUES, type DecisionCard } from "@/approvals/cards"
import { registerCardCommands } from "./approvals-card"
import { decide, listInbox, type InboxAction, type InboxItem } from "@/approvals/inbox"
import { parseDestination, readApprovalSettings, updateApprovalSettings, type ApprovalSettingsPatch } from "@/approvals/settings"

// --- agentx approvals — one inbox for every pending decision ---
//
// Lists what is waiting for the operator across decision cards, schedule
// requests, held memory facts and wiki proposals (src/approvals/inbox.ts),
// and answers them. Each answer goes through the source's own approve or
// reject, so `agentx schedule approve`, `agentx memory facts approve` and
// `agentx wiki proposals approve` keep working and stay in step.

export const approvals = new Command("approvals")
  .description("one inbox for every decision waiting for you (cards, schedules, memory facts, wiki proposals, WhatsApp replies)")

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  card: "card",
  schedule: "schedule",
  memory: "memory",
  wiki: "wiki",
  whatsapp: "whatsapp",
  request: "request",
}

function ctx() {
  return { root: process.cwd() }
}

function when(iso: string): string {
  return iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "unknown"
}

function printItem(item: InboxItem): void {
  console.log(`  ${chalk.cyan(item.key)}  ${chalk.dim(`[${KIND_LABEL[item.kind]}] from ${item.raised_by}`)}${item.snoozed_until ? chalk.dim(` (later: until ${when(item.snoozed_until)})`) : ""}`)
  console.log(`    ${chalk.bold(item.title)}`)
  console.log(`    ${item.ask}`)
  if (item.recommend) console.log(`    ${chalk.green("Recommends:")} ${item.recommend}`)
  item.choices?.forEach((c, i) => console.log(`    ${chalk.magenta(`${i + 1}.`)} ${c}`))
  if (item.expires) console.log(chalk.yellow(`    Expires ${when(item.expires)}; then: ${item.if_silent}`))
  if (item.detail) console.log(chalk.dim(`    ${item.detail}`))
  if (item.source) console.log(chalk.dim(`    ${item.source}`))
  console.log(chalk.dim(`    yes: ${item.yes} · no: ${item.no}${item.more ? ` · more: ${item.more}` : ""}`))
}

approvals
  .command("list", { isDefault: true })
  .alias("ls")
  .description("what is waiting, most urgent first")
  .option("--all", "include items you put off with `later`")
  .option("--json", "machine-readable output")
  .action((opts: { all?: boolean; json?: boolean }) => {
    const listing = listInbox(ctx(), { includeSnoozed: opts.all })
    if (opts.json) { console.log(JSON.stringify(listing, null, 2)); return }
    for (const e of listing.errors) console.log(chalk.red(`  couldn't read ${e.kind}: ${e.error}`))
    if (listing.items.length === 0) {
      console.log(chalk.dim(`  nothing waiting${listing.snoozed ? ` (${listing.snoozed} put off; --all shows them)` : ""}`))
      return
    }
    console.log()
    for (const item of listing.items) { printItem(item); console.log() }
    console.log(chalk.dim(`  ${listing.items.length} waiting${listing.snoozed ? `, ${listing.snoozed} put off (--all)` : ""}. Answer with: agentx approvals approve|reject|later <key>`))
  })

async function answer(key: string, action: InboxAction, opts: { force?: boolean; note?: string; hours?: string; choice?: string; text?: string }): Promise<void> {
  const settings = readApprovalSettings()
  const hours = opts.hours ? Number(opts.hours) : settings.laterHours
  if (action === "later" && !(hours > 0)) {
    console.error(chalk.red("  --hours must be a positive number")); process.exitCode = 1; return
  }
  const r = await decide(ctx(), key, action, { force: opts.force, note: opts.note, laterHours: hours, choice: opts.choice, text: opts.text })
  if (!r.ok) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
  console.log(chalk.green(`  ✓ ${r.message}`))
}

approvals
  .command("approve")
  .alias("yes")
  .description("say yes: enables the schedule, lets the fact be used, writes the wiki article, or tells the agent yes")
  .argument("<key>", "item key from `agentx approvals list`, e.g. card:2026-01-05-publish-draft-ab12")
  .option("--force", "wiki: approve even if the article changed since the proposal")
  .option("--note <text>", "cards: a note passed to the agent with your answer")
  .option("--choice <n>", "cards with choices: which one, by number or label")
  .option("--text <message>", "cards with a suggested message: the message as you want it sent")
  .action((key: string, opts) => answer(key, "yes", opts))

approvals
  .command("reject")
  .alias("no")
  .description("say no: drops the request, keeps the fact out, declines the article, or tells the agent no")
  .argument("<key>", "item key from `agentx approvals list`")
  .option("--note <text>", "why; kept with cards and wiki proposals")
  .action((key: string, opts) => answer(key, "no", opts))

approvals
  .command("later")
  .description("put an item off; it leaves the list and comes back later (a card still expires on time)")
  .argument("<key>", "item key from `agentx approvals list`")
  .option("--hours <n>", "how long (default: approvals.laterHours, 24)")
  .action((key: string, opts) => answer(key, "later", opts))

approvals
  .command("request")
  .description("raise a decision card yourself, for example to test the inbox (agents use the agentx_approval tool)")
  .requiredOption("--agent <id>", "the agent the card is from; it gets the result")
  .requiredOption("--title <text>", "what it is, in one line")
  .requiredOption("--ask <text>", "the yes/no question")
  .requiredOption("--recommend <text>", "the advice and why, in one line")
  .requiredOption("--if-silent <value>", `what applies if nobody answers: ${IF_SILENT_VALUES.join(", ")}`)
  .option("--expires <when>", "ISO date or time, or like 12h / 3d (default: approvals.defaultExpiryDays)")
  .option("--source <link>", "link to the draft, PR or issue")
  .option("--choice <label>", "a ready-made answer; repeat for up to 5", (v: string, all: string[] = []) => [...all, v])
  .option("--draft <message>", "a suggested message; {choice} is replaced by the pick")
  .option("--say <line>", "the short line the Mac popup speaks (default: the title)")
  .option("--context <text>", "a few lines of background, shown above the question")
  .action(async (opts: { agent: string; title: string; ask: string; recommend: string; ifSilent: string; expires?: string; source?: string; choice?: string[]; draft?: string; say?: string; context?: string }) => {
    const settings = readApprovalSettings()
    const input = {
      raised_by: opts.agent, title: opts.title, ask: opts.ask, recommend: opts.recommend,
      if_silent: opts.ifSilent, expires: opts.expires, source: opts.source,
      choices: opts.choice, draft: opts.draft, say: opts.say, context: opts.context,
    }
    // This node's cards go to another machine (approvals.forwardTo): the
    // daemon does the forwarding, so the card goes through it (#668).
    const r = settings.forwardTo ? await raiseThroughDaemon(input) : createCard(process.cwd(), input, { settings })
    if (!r.ok) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
    const where = settings.forwardTo ? ` on ${settings.forwardTo}` : ""
    console.log(chalk.green(`  ✓ card:${r.card.id} raised${where}; expires ${when(r.card.expires)}, then: ${r.card.if_silent}`))
  })

/** POST /approvals on this node's daemon, which forwards it. */
async function raiseThroughDaemon(input: Record<string, unknown>): Promise<{ ok: true; card: DecisionCard } | { ok: false; error: string }> {
  const base = (process.env.AGENTX_DAEMON_URL || "http://127.0.0.1:18800").replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (process.env.MESH_TOKEN) headers.Authorization = `Bearer ${process.env.MESH_TOKEN}`
  try {
    const res = await fetch(`${base}/approvals`, { method: "POST", headers, body: JSON.stringify(input), signal: AbortSignal.timeout(15_000) })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    return { ok: true, card: data.card as DecisionCard }
  } catch (e: any) {
    return { ok: false, error: `couldn't reach the daemon at ${base} (it forwards cards when approvals.forwardTo is set): ${e?.message ?? e}` }
  }
}

registerCardCommands(approvals)

approvals
  .command("settings")
  .description("show or change expiry, \"later\" and digest settings (approvals in agentx.json)")
  .option("--expiry-days <n>", "days a card gets when it doesn't say")
  .option("--max-expiry-days <n>", "longest a card may wait")
  .option("--later-hours <n>", "how long `later` hides an item")
  .option("--notify-agent <on|off>", "tell the agent that raised a card its result")
  .option("--expiry-approve <on|off>", "let a card say yes by itself when nobody answers (if_silent approve)")
  .option("--forward-to <peer>", "send this machine's cards to that mesh peer's inbox and popup; \"none\" to keep them here")
  .option("--digest <on|off>", "the daily message about what is waiting")
  .option("--digest-time <HH:MM>", "when the digest goes out, 24-hour local time")
  .option("--digest-timezone <zone>", "IANA timezone for --digest-time; \"local\" for this machine's")
  .option("--digest-to <channel:chatId>", "where the digest goes; \"default\" for notifications.destination")
  .option("--popup <on|off>", "Mac popup for new cards (macOS)")
  .option("--popup-speak <on|off>", "the popup speaks a short line")
  .option("--popup-voice <name>", "voice for the spoken line; \"default\" for the system voice")
  .option("--popup-sound <name>", "system sound, like Glass; \"none\" for silence")
  .option("--popup-timeout <seconds>", "how long the popup waits for you")
  .option("--popup-style <card|dialog>", "the web card, or plain macOS dialogs")
  .option("--popup-theme <system|light|dark>", "the card's colours")
  .option("--checkin <on|off>", "check-ins: waiting cards and open reminders, a few times a day (macOS)")
  .option("--checkin-times <HH:MM,...>", "local times of the normal passes")
  .option("--checkin-daily <HH:MM>", "local time of the daily pass")
  .option("--checkin-lists <list,...>", "your Reminders lists to look at")
  .option("--checkin-agent <id>", "agent that writes cards for reminders no agent owns; \"none\" to clear")
  .action(async (opts: Record<string, string | undefined>) => {
    const patch: ApprovalSettingsPatch = {}
    const num = (flag: string, v: string | undefined) => {
      if (v === undefined) return undefined
      const n = Number(v)
      if (!(n > 0)) throw new Error(`${flag} must be a positive number`)
      return n
    }
    const onOff = (flag: string, v: string | undefined) => {
      if (v === undefined) return undefined
      if (v === "on") return true
      if (v === "off") return false
      throw new Error(`${flag} takes on or off`)
    }
    try {
      patch.defaultExpiryDays = num("--expiry-days", opts.expiryDays)
      patch.maxExpiryDays = num("--max-expiry-days", opts.maxExpiryDays)
      patch.laterHours = num("--later-hours", opts.laterHours)
      patch.notifyAgent = onOff("--notify-agent", opts.notifyAgent)
      patch.allowApproveOnExpiry = onOff("--expiry-approve", opts.expiryApprove)
      if (opts.forwardTo !== undefined) patch.forwardTo = opts.forwardTo === "none" ? null : opts.forwardTo
      patch.digestEnabled = onOff("--digest", opts.digest)
      patch.popupEnabled = onOff("--popup", opts.popup)
      patch.popupSpeak = onOff("--popup-speak", opts.popupSpeak)
      if (opts.popupVoice !== undefined) patch.popupVoice = opts.popupVoice === "default" ? null : opts.popupVoice
      if (opts.popupSound !== undefined) patch.popupSound = opts.popupSound === "none" ? "" : opts.popupSound
      patch.popupTimeoutSeconds = num("--popup-timeout", opts.popupTimeout)
      if (opts.popupStyle !== undefined) patch.popupStyle = opts.popupStyle as ApprovalSettingsPatch["popupStyle"]
      if (opts.popupTheme !== undefined) patch.popupTheme = opts.popupTheme as ApprovalSettingsPatch["popupTheme"]
      patch.checkinEnabled = onOff("--checkin", opts.checkin)
      const list = (v: string | undefined) => v?.split(",").map((x) => x.trim()).filter(Boolean)
      patch.checkinTimes = list(opts.checkinTimes)
      if (opts.checkinDaily !== undefined) patch.checkinDailyAt = opts.checkinDaily
      patch.checkinLists = list(opts.checkinLists)
      if (opts.checkinAgent !== undefined) patch.checkinAgent = opts.checkinAgent === "none" ? null : opts.checkinAgent
      if (opts.digestTime !== undefined) patch.digestTime = opts.digestTime
      if (opts.digestTimezone !== undefined) patch.digestTimezone = opts.digestTimezone === "local" ? null : opts.digestTimezone
      if (opts.digestTo !== undefined) {
        if (opts.digestTo === "default") patch.destination = null
        else {
          const d = parseDestination(opts.digestTo)
          if (!d) throw new Error("--digest-to takes channel:chatId, for example telegram:123456")
          patch.destination = d
        }
      }
    } catch (e: any) {
      console.error(chalk.red(`  ${e.message}`)); process.exitCode = 1; return
    }
    const changing = Object.values(patch).some((v) => v !== undefined)
    if (changing) {
      const r = await updateApprovalSettings(patch)
      if (!r.success) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
      console.log(chalk.green("  ✓ saved") + (r.reloaded ? chalk.dim(" (daemon reloaded)") : ""))
    }
    const s = readApprovalSettings()
    const dest = s.digest.destination
    console.log(`  Cards expire after      ${s.defaultExpiryDays} day(s) unless they say (at most ${s.maxExpiryDays})`)
    console.log(`  Yes on expiry           ${s.allowApproveOnExpiry === false ? "off: a card never approves itself" : "on: a card may say approve for when nobody answers"}`)
    console.log(`  "Later" hides an item   ${s.laterHours} hour(s)`)
    console.log(`  Tell the agent          ${s.notifyAgent ? "on" : "off"}`)
    console.log(`  Cards go to             ${s.forwardTo ? `${s.forwardTo} (mesh peer)` : "this machine"}`)
    console.log(`  Daily digest            ${s.digest.enabled ? `on, at ${s.digest.time}${s.digest.timezone ? ` (${s.digest.timezone})` : " (this machine's time)"}` : "off"}`)
    console.log(`  Digest goes to          ${dest ? `${dest.channel} ${dest.chatId}` : "notifications.destination"}`)
    const p = s.popup!
    console.log(`  Mac popup               ${p.enabled ? `on: ${p.style}, sound ${p.sound || "none"}, ${p.speak ? `speaks${p.voice ? ` (${p.voice})` : ""}` : "silent"}, waits ${p.timeoutSeconds}s` : "off"}`)
    const c = s.checkin!
    console.log(`  Check-ins               ${c.enabled ? `on: daily ${c.dailyAt}, then ${c.times.join(", ")}; lists ${c.lists.join(", ")}; agent ${c.agent ?? "none"}` : "off"}`)
  })
