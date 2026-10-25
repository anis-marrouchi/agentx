import { Command } from "commander"
import chalk from "chalk"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { isOptedOut, leadLine, newLeads, quietLeads, readLeads, readOptOuts, recordOptOut } from "@/sales/leads"
import { unsourcedClaims } from "@/sales/sources"
import { changesSince, checkCompetitors, formatChanges } from "@/sales/watch"

// --- agentx sales (#1288) ---
//
// The deterministic half of the sales team's work, run by the `sales` agent
// in its workspace: which leads are new or quiet (opt-outs left out), what
// changed on the competitor pages, and whether an answer cites a source for
// every fact. The model writes; these commands decide.

const DAY = 86_400_000

const today = () => new Date().toISOString().slice(0, 10)

function workspaceOf(opts: { workspace?: string }): string {
  return resolve(opts.workspace ?? process.cwd())
}

/** `24h`, `3d` or a plain number of hours, as milliseconds. */
function parseSince(value: string): number {
  const m = value.trim().match(/^(\d+)\s*([hd]?)$/i)
  if (!m) throw new Error(`"${value}" is not a duration like 24h or 2d`)
  return Number(m[1]) * (m[2].toLowerCase() === "d" ? DAY : DAY / 24)
}

export const sales = new Command()
  .name("sales")
  .description("the sales team's lead list, opt-outs and competitor watch (run in the sales agent's folder)")

sales
  .command("leads")
  .description("new and quiet leads from leads.md, leaving out everyone in opt-outs.md")
  .option("--workspace <dir>", "the sales agent's folder (default: this folder)")
  .option("--days <n>", "days without contact before a lead is quiet", "7")
  .option("--quiet-only", "list only the quiet leads")
  .action((opts) => {
    const ws = workspaceOf(opts)
    const days = Number(opts.days)
    if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a whole number of days, 1 or more")
    const leads = readLeads(ws)
    const optOuts = readOptOuts(ws)
    const quiet = quietLeads(leads, optOuts, today(), days)
    const out: string[] = []
    if (!opts.quietOnly) {
      // Two days: the morning brief also shows what was added after
      // yesterday's brief.
      const fresh = newLeads(leads, optOuts, today(), 2)
      out.push("New leads (added today or yesterday):", ...(fresh.length ? fresh.map(leadLine) : ["- None."]), "")
    }
    out.push(`Quiet leads (no contact for ${days} days or more):`, ...(quiet.length ? quiet.map(leadLine) : ["- None."]))
    const skipped = leads.filter((l) => isOptedOut(l, optOuts)).length
    if (skipped) out.push("", `Summary: ${skipped} opted-out lead${skipped === 1 ? "" : "s"} left out. Never contact them.`)
    console.log(out.join("\n"))
  })

sales
  .command("opt-out <name>")
  .description("record that someone asked not to be contacted; they are left out of every list and draft")
  .option("--company <company>", "their company (unset: the person at every company)")
  .option("--reason <text>", "why, in a few words")
  .option("--workspace <dir>", "the sales agent's folder (default: this folder)")
  .action((name: string, opts) => {
    const added = recordOptOut(workspaceOf(opts), { name, company: opts.company, reason: opts.reason }, today())
    const who = opts.company ? `${name} (${opts.company})` : name
    console.log(added ? `  ${who} is opted out. No message will be drafted for them.` : `  ${who} was already opted out.`)
  })

sales
  .command("watch")
  .description("check the pages in competitors.md and print only what changed since the last check")
  .option("--workspace <dir>", "the sales agent's folder (default: this folder)")
  .action(async (opts) => {
    const ws = workspaceOf(opts)
    const r = await checkCompetitors(ws)
    const out = r.changes.length ? ["Competitor changes:", ...formatChanges(r.changes)] : ["No competitor changes."]
    for (const c of r.baselined) out.push(`- Now watching [${c.name}](${c.url}); changes show from the next check.`)
    for (const f of r.failed) out.push(`- Could not check [${f.competitor.name}](${f.competitor.url}): ${f.error}`)
    if (!r.changes.length && !r.baselined.length && !r.failed.length && !r.unchanged) {
      out.push("Summary: competitors.md lists no pages to watch.")
    }
    console.log(out.join("\n"))
  })

sales
  .command("changes")
  .description("competitor changes recorded by `sales watch`, for the brief")
  .option("--since <duration>", "how far back, like 24h or 3d", "24h")
  .option("--workspace <dir>", "the sales agent's folder (default: this folder)")
  .action((opts) => {
    const changes = changesSince(workspaceOf(opts), new Date(Date.now() - parseSince(opts.since)))
    console.log(changes.length ? ["Competitor changes:", ...formatChanges(changes)].join("\n") : "No competitor changes.")
  })

sales
  .command("check <file>")
  .description("list the lines of an answer that state a fact without a source link (- reads standard input)")
  .action(async (file: string) => {
    let text: string
    if (file === "-") {
      const chunks: Buffer[] = []
      for await (const c of process.stdin) chunks.push(c as Buffer)
      text = Buffer.concat(chunks).toString("utf-8")
    } else {
      const path = resolve(file)
      if (!existsSync(path)) throw new Error(`No file at ${path}`)
      text = readFileSync(path, "utf-8")
    }
    const missing = unsourcedClaims(text)
    if (!missing.length) {
      console.log(chalk.green("  Every fact has a source."))
      return
    }
    console.log(chalk.yellow(`  ${missing.length} line${missing.length === 1 ? "" : "s"} without a source:`))
    for (const m of missing) console.log(`  line ${m.line}: ${m.text}`)
    process.exitCode = 1
  })
