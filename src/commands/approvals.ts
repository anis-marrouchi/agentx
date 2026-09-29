import { Command } from "commander"
import chalk from "chalk"
import { createCard, IF_SILENT_VALUES } from "@/approvals/cards"
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

async function answer(key: string, action: InboxAction, opts: { force?: boolean; note?: string; hours?: string }): Promise<void> {
  const settings = readApprovalSettings()
  const hours = opts.hours ? Number(opts.hours) : settings.laterHours
  if (action === "later" && !(hours > 0)) {
    console.error(chalk.red("  --hours must be a positive number")); process.exitCode = 1; return
  }
  const r = await decide(ctx(), key, action, { force: opts.force, note: opts.note, laterHours: hours })
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
  .action((opts: { agent: string; title: string; ask: string; recommend: string; ifSilent: string; expires?: string; source?: string }) => {
    const settings = readApprovalSettings()
    const r = createCard(process.cwd(), {
      raised_by: opts.agent, title: opts.title, ask: opts.ask, recommend: opts.recommend,
      if_silent: opts.ifSilent, expires: opts.expires, source: opts.source,
    }, { settings })
    if (!r.ok) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
    console.log(chalk.green(`  ✓ card:${r.card.id} raised; expires ${when(r.card.expires)}, then: ${r.card.if_silent}`))
  })

approvals
  .command("settings")
  .description("show or change expiry, \"later\" and digest settings (approvals in agentx.json)")
  .option("--expiry-days <n>", "days a card gets when it doesn't say")
  .option("--max-expiry-days <n>", "longest a card may wait")
  .option("--later-hours <n>", "how long `later` hides an item")
  .option("--notify-agent <on|off>", "tell the agent that raised a card its result")
  .option("--digest <on|off>", "the daily message about what is waiting")
  .option("--digest-time <HH:MM>", "when the digest goes out, 24-hour local time")
  .option("--digest-timezone <zone>", "IANA timezone for --digest-time; \"local\" for this machine's")
  .option("--digest-to <channel:chatId>", "where the digest goes; \"default\" for notifications.destination")
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
      patch.digestEnabled = onOff("--digest", opts.digest)
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
    console.log(`  "Later" hides an item   ${s.laterHours} hour(s)`)
    console.log(`  Tell the agent          ${s.notifyAgent ? "on" : "off"}`)
    console.log(`  Daily digest            ${s.digest.enabled ? `on, at ${s.digest.time}${s.digest.timezone ? ` (${s.digest.timezone})` : " (this machine's time)"}` : "off"}`)
    console.log(`  Digest goes to          ${dest ? `${dest.channel} ${dest.chatId}` : "notifications.destination"}`)
  })
