import { Command } from "commander"
import chalk from "chalk"
import { existsSync } from "fs"
import { openDb } from "@/storage/sqlite"
import { findConfigPath } from "@/daemon/config-mutator"
import { readSignals, SIGNAL_KINDS, SIGNAL_MEANING, summarizeSignals, type SignalKind } from "@/improve/signals"

// --- agentx improve — self-improvement, stage 1: count failure signals (#1783) ---

export const improve = new Command("improve")
  .description("what went wrong for the owner, counted, so the worst can be fixed first")

/** "24h", "7d", "30m", or a date. Default: the last 24 hours. */
export function parseSince(value: string | undefined, now = Date.now()): number | null {
  if (!value) return now - 86_400_000
  const rel = value.match(/^(\d+)([dhm])$/)
  if (rel) return now - Number(rel[1]) * (rel[2] === "d" ? 86_400_000 : rel[2] === "h" ? 3_600_000 : 60_000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : at
}

improve
  .command("signals")
  .description("count the failure signals: reopened requests, owner-words mismatches, refused or failed hand-offs, repeats")
  .option("--since <when>", "how far back: 24h, 7d, 30m or a date", "24h")
  .option("--kind <kind>", `list the rows of one kind: ${SIGNAL_KINDS.join(", ")}`)
  .option("--json", "print the counts as JSON")
  .action((opts: { since?: string; kind?: string; json?: boolean }) => {
    // openDb creates the file: never in a folder that is not an install.
    if (!existsSync(findConfigPath())) { console.error(chalk.red("  no agentx.json here: run this from the install folder, the one that holds agentx.json")); process.exitCode = 1; return }
    const since = parseSince(opts.since)
    if (since === null) { console.error(chalk.red(`  --since must look like 24h, 7d, 30m or a date, not "${opts.since}"`)); process.exitCode = 1; return }
    if (opts.kind && !(SIGNAL_KINDS as readonly string[]).includes(opts.kind)) { console.error(chalk.red(`  unknown kind "${opts.kind}": use ${SIGNAL_KINDS.join(", ")}`)); process.exitCode = 1; return }
    const db = openDb()
    if (!db) { process.exitCode = 1; return }

    if (opts.kind) {
      const rows = readSignals(db, since).filter((r) => r.kind === opts.kind)
      if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return }
      console.log(chalk.bold(`\n  ${opts.kind}: ${SIGNAL_MEANING[opts.kind as SignalKind]}`))
      if (!rows.length) { console.log(chalk.dim("  none in this window")); return }
      for (const r of rows) console.log(`  ${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")}  ${(r.agentId ?? "-").padEnd(20)} ${r.ref ?? ""}${r.detail ? chalk.dim(`  ${r.detail}`) : ""}`)
      return
    }

    const s = summarizeSignals(db, since)
    if (opts.json) { console.log(JSON.stringify(s, null, 2)); return }
    console.log(chalk.bold(`\n  Failure signals since ${new Date(since).toISOString().slice(0, 16).replace("T", " ")} UTC: ${s.total}`))
    if (!s.total) { console.log(chalk.dim("  none in this window")); return }
    console.log(chalk.bold("\n  By kind"))
    for (const k of s.byKind) console.log(`  ${String(k.count).padStart(5)}  ${k.kind.padEnd(24)} ${chalk.dim(SIGNAL_MEANING[k.kind])}`)
    console.log(chalk.bold("\n  By agent"))
    for (const a of s.byAgent) console.log(`  ${String(a.count).padStart(5)}  ${a.agentId.padEnd(24)} ${chalk.dim(Object.entries(a.kinds).map(([k, n]) => `${k} ${n}`).join(", "))}`)
    if (s.top.length) {
      console.log(chalk.bold("\n  Seen more than once"))
      for (const t of s.top) console.log(`  ${String(t.count).padStart(5)}  ${t.kind.padEnd(24)} ${(t.agentId ?? "-").padEnd(18)} ${chalk.dim(t.detail.slice(0, 110))}`)
    }
    console.log(chalk.dim(`\n  One kind's rows: agentx improve signals --kind <kind> --since ${opts.since ?? "24h"}`))
  })
