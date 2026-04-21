import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx whatsapp: list & ingest WhatsApp data into the wiki ---
//
// Talks to the running daemon's HTTP API (same pattern as `agentx usage`).
// The daemon owns the Baileys socket; the CLI is just a thin client that
// renders the results. Keeps auth state on the daemon and avoids making
// the CLI ship Baileys + pair-again.

export const whatsapp = new Command()
  .name("whatsapp")
  .description("list WhatsApp chats/contacts and ingest them into the wiki as a data source")

whatsapp
  .command("list-chats")
  .description("list chats observed by the WhatsApp socket (cached, no live fetch)")
  .option("--format <format>", "output format: table | json", "table")
  .option("--group", "groups only")
  .option("--dm", "DMs only")
  .action(async (opts) => {
    try {
      const data = await getJSON("/whatsapp/chats") as { chats?: Array<any> }
      let chats = data.chats ?? []
      if (opts.group) chats = chats.filter((c) => c.isGroup)
      if (opts.dm) chats = chats.filter((c) => !c.isGroup)
      if (opts.format === "json") {
        console.log(JSON.stringify(chats, null, 2))
        return
      }
      if (chats.length === 0) { console.log(chalk.dim("  no chats cached yet")); return }
      console.log()
      console.log(chalk.bold(`  ${chats.length} chat${chats.length === 1 ? "" : "s"}`))
      console.log()
      for (const c of chats) {
        const kind = c.isGroup ? chalk.cyan("group") : chalk.dim("dm")
        const when = c.lastMessageAt ? new Date(c.lastMessageAt * 1000).toISOString().slice(0, 16).replace("T", " ") : "—"
        console.log(`  ${kind}  ${c.name.padEnd(30)}  ${chalk.dim(c.jid.padEnd(40))}  ${chalk.dim(when)}`)
      }
      console.log()
    } catch (e: any) {
      fail(e)
    }
  })

whatsapp
  .command("list-contacts")
  .description("list contacts observed by the WhatsApp socket (cached, no live fetch)")
  .option("--format <format>", "output format: table | json", "table")
  .action(async (opts) => {
    try {
      const data = await getJSON("/whatsapp/contacts") as { contacts?: Array<any> }
      const contacts = data.contacts ?? []
      if (opts.format === "json") {
        console.log(JSON.stringify(contacts, null, 2))
        return
      }
      if (contacts.length === 0) { console.log(chalk.dim("  no contacts cached yet")); return }
      console.log()
      console.log(chalk.bold(`  ${contacts.length} contact${contacts.length === 1 ? "" : "s"}`))
      console.log()
      for (const c of contacts) {
        const name = (c.name || c.pushName || c.phone || c.jid).padEnd(30)
        const phone = c.phone ? `+${c.phone}`.padEnd(16) : "—".padEnd(16)
        console.log(`  ${name}  ${chalk.dim(phone)}  ${chalk.dim(c.jid)}`)
      }
      console.log()
    } catch (e: any) {
      fail(e)
    }
  })

whatsapp
  .command("ingest-all")
  .description("run a full ingest sweep against the configured allowlist (writes raw wiki entries)")
  .option("--dry-run", "compute entries without writing them — review before enabling")
  .option("--agent <id>", "owner agent for the entries (defaults to channels.whatsapp.defaultAgent)")
  .option("--force", "bypass the channels.whatsapp.ingest.enabled guard")
  .action(async (opts) => {
    try {
      const body: Record<string, unknown> = { dryRun: !!opts.dryRun, force: !!opts.force }
      if (opts.agent) body.agent = opts.agent
      const report = await postJSON("/whatsapp/ingest", body)
      printReport(report, !!opts.dryRun)
    } catch (e: any) {
      fail(e)
    }
  })

whatsapp
  .command("ingest-contact <jid>")
  .description("ingest one contact (skips scope allowlist for this JID only)")
  .option("--dry-run", "compute entries without writing them")
  .option("--agent <id>", "owner agent for the entries")
  .action(async (jid, opts) => {
    try {
      const body: Record<string, unknown> = { dryRun: !!opts.dryRun, force: true, onlyJid: jid, onlyKind: "contact" }
      if (opts.agent) body.agent = opts.agent
      const report = await postJSON("/whatsapp/ingest", body)
      printReport(report, !!opts.dryRun)
    } catch (e: any) {
      fail(e)
    }
  })

whatsapp
  .command("ingest-chat <jid>")
  .description("ingest one chat (DM or group) including message window if `--messages` is set")
  .option("--dry-run", "compute entries without writing them")
  .option("--messages", "include the bounded message window for this chat (overrides config mode)")
  .option("--agent <id>", "owner agent for the entries")
  .action(async (jid, opts) => {
    try {
      const body: Record<string, unknown> = { dryRun: !!opts.dryRun, force: true, onlyJid: jid }
      if (opts.agent) body.agent = opts.agent
      if (opts.messages) body.forceMode = "messages"
      const report = await postJSON("/whatsapp/ingest", body)
      printReport(report, !!opts.dryRun)
    } catch (e: any) {
      fail(e)
    }
  })

whatsapp
  .command("status")
  .description("show WhatsApp channel + ingest status")
  .action(async () => {
    try {
      const state = await getJSON("/whatsapp/state")
      const chats = await getJSON("/whatsapp/chats") as { chats?: any[] }
      const contacts = await getJSON("/whatsapp/contacts") as { contacts?: any[] }
      console.log()
      console.log(chalk.bold("  WhatsApp status"))
      console.log()
      console.log(`  connection: ${(state as any).connection || "—"}`)
      console.log(`  cached chats: ${chats.chats?.length ?? 0}`)
      console.log(`  cached contacts: ${contacts.contacts?.length ?? 0}`)
      console.log()
    } catch (e: any) {
      fail(e)
    }
  })

function printReport(report: any, dryRun: boolean): void {
  console.log()
  console.log(chalk.bold(dryRun ? "  Ingest (dry-run)" : "  Ingest report"))
  console.log()
  console.log(`  scanned: contacts=${report.scannedContacts}, groups=${report.scannedGroups}`)
  console.log(`  wrote:   contacts=${report.wroteContacts}, groups=${report.wroteGroups}, dm-windows=${report.wroteDmWindows}, group-windows=${report.wroteGroupWindows}`)
  if (report.skippedUnchanged) console.log(`  skipped: ${report.skippedUnchanged} unchanged`)
  if (report.errors?.length) {
    console.log(chalk.yellow(`  errors: ${report.errors.length}`))
    for (const err of report.errors.slice(0, 5)) {
      console.log(chalk.yellow(`    - [${err.kind}] ${err.jid}: ${err.message}`))
    }
  }
  if (dryRun && report.dryRunEntries?.length) {
    console.log()
    console.log(chalk.dim("  would-be entries:"))
    for (const e of report.dryRunEntries.slice(0, 10)) {
      console.log(chalk.dim(`    - ${e.id}  (${e.source}, ${e.content.length} bytes)`))
    }
    if (report.dryRunEntries.length > 10) console.log(chalk.dim(`    …and ${report.dryRunEntries.length - 10} more`))
  }
  console.log()
}

function daemonUrl(): string {
  try {
    const config = loadDaemonConfig()
    const [host, port] = config.node.bind.split(":")
    return `http://${host || "127.0.0.1"}:${port || "19900"}`
  } catch {
    return "http://127.0.0.1:19900"
  }
}

async function getJSON(path: string): Promise<unknown> {
  const r = await fetch(`${daemonUrl()}${path}`, { signal: AbortSignal.timeout(10_000) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as any).error || `HTTP ${r.status}`)
  return data
}

async function postJSON(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${daemonUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60_000),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as any).error || `HTTP ${r.status}`)
  return data
}

function fail(e: any): never {
  console.error(chalk.red(`  ${e.message || e}`))
  process.exit(1)
}
