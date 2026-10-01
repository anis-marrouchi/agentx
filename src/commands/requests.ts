import { Command } from "commander"
import chalk from "chalk"
import { openDb } from "@/storage/sqlite"
import { RequestStore, type RequestRecord } from "@/requests/store"
import { readRequestSettings, updateRequestSettings, type RequestSettingsPatch } from "@/requests/settings"

// --- agentx requests — what you asked for that is not finished (#356) ---
//
// Reads and closes requests in .agentx/db.sqlite, the same file the daemon
// writes. Run it from the folder that holds agentx.json. This is an owner
// surface: it can drop a request, which agents cannot.

export const requests = new Command("requests")
  .description("what you asked agents for that is not finished, oldest first")

const STATE_LABEL: Record<string, string> = {
  in_progress: "in progress",
  waiting_owner: "waiting on you",
  waiting_other: "waiting on another agent",
  needs_attention: "needs attention",
  done: "done",
  declined: "declined",
  dropped: "dropped",
}

function store(): RequestStore | null {
  const db = openDb()
  if (!db) { console.error(chalk.red("  couldn't open .agentx/db.sqlite: run this from the folder that holds agentx.json")); process.exitCode = 1; return null }
  return new RequestStore(db)
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"

function printRequest(r: RequestRecord): void {
  const colour = r.state === "needs_attention" ? chalk.red : r.state === "waiting_owner" ? chalk.yellow : chalk.dim
  console.log(`  ${chalk.cyan(r.id)}  ${colour(`[${STATE_LABEL[r.state] ?? r.state}]`)} ${chalk.dim(`${when(r.createdAt)} · ${r.channel} · ${r.agentId}`)}`)
  console.log(`    ${r.text.replace(/\s+/g, " ").trim().slice(0, 240)}`)
  if (r.state === "waiting_owner" && r.question) console.log(chalk.yellow(`    Question: ${r.question}`))
  if (r.state === "needs_attention" && r.attentionReason) console.log(chalk.red(`    ${r.attentionReason}`))
  if (r.evidence) console.log(chalk.green(`    Evidence: ${r.evidence}`))
  if (r.closeReason) console.log(chalk.dim(`    Reason: ${r.closeReason}`))
}

requests
  .command("list", { isDefault: true })
  .alias("ls")
  .description("open requests, oldest first")
  .option("--json", "machine-readable output")
  .action((opts: { json?: boolean }) => {
    const s = store()
    if (!s) return
    const items = s.listOpen()
    if (opts.json) { console.log(JSON.stringify(items, null, 2)); return }
    if (!readRequestSettings().enabled) console.log(chalk.dim("  requests are off: turn them on with `agentx requests settings --enabled on`"))
    if (items.length === 0) { console.log(chalk.dim("  no open requests")); return }
    for (const r of items) printRequest(r)
    console.log(chalk.dim(`\n  ${items.length} open. Close one: agentx requests done <id> --evidence <link> · agentx requests drop <id>`))
  })

requests
  .command("show <id>")
  .description("one request and the runs, delegations and cards linked to it")
  .action((id: string) => {
    const s = store()
    if (!s) return
    const r = s.get(id)
    if (!r || r.state === "candidate") { console.error(chalk.red(`  no request "${id}"`)); process.exitCode = 1; return }
    printRequest(r)
    console.log(chalk.dim(`    Last activity ${when(r.updatedAt)}${r.closedAt ? ` · closed ${when(r.closedAt)}` : ""}`))
    for (const l of s.links(id)) console.log(chalk.dim(`    ${l.kind} ${l.ref} (${when(l.at)})`))
  })

function closeCommand(name: "done" | "drop", description: string, flag: string, missing: string): void {
  requests
    .command(`${name} <id>`)
    .description(description)
    .option(flag, name === "done" ? "link to the proof: PR, issue, message, deploy" : "why it is dropped")
    .action((id: string, opts: { evidence?: string; reason?: string }) => {
      const s = store()
      if (!s) return
      const detail = name === "done" ? opts.evidence : opts.reason ?? "dropped by the owner"
      if (!detail) { console.error(chalk.red(`  ${missing}`)); process.exitCode = 1; return }
      const r = s.get(id)
      if (!r || r.state === "candidate") { console.error(chalk.red(`  no request "${id}"`)); process.exitCode = 1; return }
      if (!s.close(id, name === "done" ? "done" : "dropped", detail, Date.now())) {
        console.error(chalk.red(`  ${id} is already closed (${STATE_LABEL[r.state] ?? r.state})`)); process.exitCode = 1; return
      }
      console.log(chalk.green(`  ✓ ${id} ${name === "done" ? "closed as done" : "dropped"}`))
    })
}
closeCommand("done", "close a request as finished, with a link to the evidence", "--evidence <link>", "a finished request needs --evidence <link>")
closeCommand("drop", "drop a request you no longer want", "--reason <text>", "")

requests
  .command("settings")
  .description("show or change the requests settings")
  .option("--enabled <on|off>", "record and follow your requests")
  .option("--from <id,...>", "who counts as you on channels other people can reach: sender ids or usernames, alone or as channel:id; \"none\" to clear")
  .option("--channels <name,...>", "channels to record on; \"all\" for every channel a person writes on")
  .option("--stale-hours <n>", "hours without activity before an open request comes back to you")
  .option("--retention-days <n>", "days a closed request is kept")
  .action(async (opts: Record<string, string | undefined>) => {
    const patch: RequestSettingsPatch = {}
    try {
      const num = (flag: string, v: string | undefined) => {
        if (v === undefined) return undefined
        const n = Number(v)
        if (!(n > 0)) throw new Error(`${flag} must be a positive number`)
        return n
      }
      const list = (v: string | undefined, empty: string) =>
        v === undefined ? undefined : v === empty ? [] : v.split(",").map((x) => x.trim()).filter(Boolean)
      if (opts.enabled !== undefined) {
        if (opts.enabled !== "on" && opts.enabled !== "off") throw new Error("--enabled takes on or off")
        patch.enabled = opts.enabled === "on"
      }
      patch.from = list(opts.from, "none")
      patch.channels = list(opts.channels, "all")
      patch.staleAfterHours = num("--stale-hours", opts.staleHours)
      patch.retentionDays = num("--retention-days", opts.retentionDays)
    } catch (e: any) {
      console.error(chalk.red(`  ${e.message}`)); process.exitCode = 1; return
    }
    if (Object.values(patch).some((v) => v !== undefined)) {
      const r = await updateRequestSettings(patch)
      if (!r.success) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
      console.log(chalk.green("  ✓ saved") + (r.reloaded ? chalk.dim(" (daemon reloaded)") : ""))
    }
    const s = readRequestSettings()
    console.log(`  Requests                ${s.enabled ? "on" : "off"}`)
    console.log(`  Channels                ${s.channels.length ? s.channels.join(", ") : "every channel a person writes on"}`)
    console.log(`  Counts as you           ${s.from.length ? s.from.join(", ") : "only voice, the app and the dashboard on this machine"}`)
    console.log(`  Comes back after        ${s.staleAfterHours} hour(s) without activity`)
    console.log(`  Closed requests kept    ${s.retentionDays} day(s)`)
  })
