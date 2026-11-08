import { Command } from "commander"
import chalk from "chalk"
import { existsSync } from "fs"
import { openDb } from "@/storage/sqlite"
import { findConfigPath } from "@/daemon/config-mutator"
import { readSignals, SIGNAL_KINDS, SIGNAL_MEANING, summarizeSignals, type SignalKind } from "@/improve/signals"
import { improvePass, type ImprovePassResult } from "@/improve/nightly"
import { reviewWithClaudeCost } from "@/daemon/session-monitor"

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

// --- agentx improve rank — stage 2: rank recurring problems (#1783) ---
//
// The nightly `agentx retro sweep` runs the same pass. By hand it is a
// preview: nothing saved, no model called. --commit saves the day's ranking
// and, when improve.enabled is on, lets the once-a-day merge call run.

/** Print a ranking: worst group first. */
export function printRanking(r: ImprovePassResult, limit = 10): void {
  console.log(chalk.bold(`\n  Recurring problems: ${r.groups.length}`) + chalk.dim(` (seen in ${r.settings.minRefs}+ separate requests, hand-offs or runs; ${r.below} below that)`))
  for (const [i, g] of r.groups.slice(0, limit).entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${String(g.score).padStart(4)}  ${g.kind.padEnd(24)} ${(g.agentId ?? "-").padEnd(18)} ${g.rows} rows, ${g.refs} refs`)
    const what = g.pattern || (g.sample ?? "")
    if (what) console.log(chalk.dim(`      ${what.slice(0, 110)}`))
    if (g.sampleRefs.length) console.log(chalk.dim(`      e.g. ${g.sampleRefs.slice(0, 3).join(", ")}`))
  }
  console.log(chalk.dim(`  Merge call: ${r.merge.ran ? `ran, ${r.merge.folded} group(s) folded${r.merge.usd != null ? `, $${r.merge.usd.toFixed(3)}` : ""}` : `not run (${r.merge.why})`}. Spent in 24 hours: $${r.spent.usd.toFixed(2)} of $${r.settings.dailyUsd.toFixed(2)}.`))
  if (r.savedDay) console.log(chalk.green(`  ✓ ranking saved for ${r.savedDay}`))
  if (r.handoff) {
    if (r.handoff.why) console.log(chalk.dim(`  Retro on the worst problem: not run (${r.handoff.why}).`))
    else console.log(chalk.dim(`  Retro on the worst problem: room for ${r.handoff.room} card(s) today (improve.maxCardsPerDay ${r.settings.maxCardsPerDay}).`))
    for (const o of r.handoff.outcomes) {
      if (o.result === "raised") console.log(chalk.green(`  ✓ card:${o.cardId} raised for problem ${o.key} (run ${o.taskId}${o.usd != null ? `, $${o.usd.toFixed(2)}` : ""})`))
      else if (o.result === "would-try") console.log(`  → would retro problem ${o.key} with run ${o.taskId}`)
      else console.log(chalk.dim(`  ✗ problem ${o.key}: ${o.why}`))
    }
  }
}

improve
  .command("rank")
  .description("rank the problems that keep coming back, worst first (preview unless --commit)")
  .option("--since <when>", "how far back: 24h, 7d, 30m or a date", "24h")
  .option("--commit", "save the day's ranking, and run the once-a-day merge call if improve.enabled is on")
  .option("--json", "print the ranking as JSON")
  .action(async (opts: { since?: string; commit?: boolean; json?: boolean }) => {
    if (!existsSync(findConfigPath())) { console.error(chalk.red("  no agentx.json here: run this from the install folder, the one that holds agentx.json")); process.exitCode = 1; return }
    const since = parseSince(opts.since)
    if (since === null) { console.error(chalk.red(`  --since must look like 24h, 7d, 30m or a date, not "${opts.since}"`)); process.exitCode = 1; return }
    const db = openDb()
    if (!db) { process.exitCode = 1; return }
    const r = await improvePass({ db, since, commit: opts.commit, call: (input, model, prompt) => reviewWithClaudeCost(input, model, undefined, prompt) })
    if (opts.json) { console.log(JSON.stringify({ groups: r.groups, below: r.below, merge: r.merge, savedDay: r.savedDay ?? null, spentUsd: r.spent.usd }, null, 2)); return }
    printRanking(r)
    if (!opts.commit) console.log(chalk.dim("\n  Preview: nothing saved, no model called. Add --commit to save the ranking."))
  })
