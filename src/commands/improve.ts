import { Command } from "commander"
import chalk from "chalk"
import { existsSync } from "fs"
import { openDb } from "@/storage/sqlite"
import { findConfigPath } from "@/daemon/config-mutator"
import { readSignals, SIGNAL_KINDS, SIGNAL_MEANING, summarizeSignals, type SignalKind } from "@/improve/signals"
import { improvePass, type ImprovePassResult } from "@/improve/nightly"
import { checkHeld, costLine, HELD_WINDOW_DAYS } from "@/improve/held"
import { KIND_WEIGHT } from "@/improve/rank"
import { COST_KIND_SET } from "@/improve/cost"
import { reviewWithClaudeCost } from "@/daemon/session-monitor"
import { AgentMemory } from "@/agents/agent-memory"
import { RULE_BUDGET, retireRulesOfKinds, rulesReport } from "@/improve/rules"

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

/** Every kind with its weight in the ranking and what it means. */
export function kindLines(): string[] {
  return SIGNAL_KINDS.map((k) => `  ${k.padEnd(24)} ${String(KIND_WEIGHT[k]).padStart(2)}  ${SIGNAL_MEANING[k]}${COST_KIND_SET.has(k) ? " (cost)" : ""}`)
}

improve
  .command("kinds")
  .description("list every signal kind, its weight in the ranking and what it means")
  .action(() => {
    console.log(chalk.bold(`\n  ${"Kind".padEnd(24)} ${"Wt".padStart(2)}  Recorded when`))
    for (const line of kindLines()) console.log(line)
  })

improve
  .command("signals")
  .description("count the failure and cost signals: reopened requests, owner-words mismatches, refused or failed hand-offs, repeats, token waste")
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
    console.log(chalk.bold(`\n  Signals since ${new Date(since).toISOString().slice(0, 16).replace("T", " ")} UTC: ${s.total}`))
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
  for (const h of r.held ?? []) {
    if (h.verdict === "waiting") continue
    const line = `  ${h.verdict === "held" ? "✓ held" : "✗ did not hold"}: card:${h.cardId} "${h.choice.slice(0, 50)}" (${h.agentId}): ${h.cost ? costLine(h.cost) : `${h.before} before, ${h.after} after`}`
    console.log(h.verdict === "held" ? chalk.green(line) : chalk.yellow(line))
  }
  if (r.rules) {
    if (r.rules.why) console.log(chalk.dim(`  Fix rules: not run (${r.rules.why}).`))
    for (const o of r.rules.outcomes) {
      const line = `  rule ${o.result}: ${o.agentId} ${o.key}${o.retired ? ` (retired ${o.retired} to make room)` : ""}${o.why ? `: ${o.why.slice(0, 120)}` : ""}`
      console.log(o.result === "added" || o.result === "kept" ? chalk.green(line) : o.result === "retired" ? chalk.yellow(line) : chalk.dim(line))
    }
  }
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

// --- agentx improve held — stage 4: did a picked fix lower its count (#1783) ---

improve
  .command("held")
  .description(`for each fix picked on a self-improvement card: the problem's count in the ${HELD_WINDOW_DAYS} days after the pick against the ${HELD_WINDOW_DAYS} before`)
  .option("--json", "print as JSON")
  .action((opts: { json?: boolean }) => {
    if (!existsSync(findConfigPath())) { console.error(chalk.red("  no agentx.json here: run this from the install folder, the one that holds agentx.json")); process.exitCode = 1; return }
    const db = openDb()
    if (!db) { process.exitCode = 1; return }
    const checks = checkHeld(db, process.cwd())
    if (opts.json) { console.log(JSON.stringify(checks, null, 2)); return }
    if (!checks.length) { console.log(chalk.dim("  No fix picked on a self-improvement card yet.")); return }
    for (const h of checks) {
      const day = new Date(h.pickedAt).toISOString().slice(0, 10)
      const verdict = h.verdict === "held" ? chalk.green("held") : h.verdict === "not-held" ? chalk.yellow("did not hold") : chalk.dim(`waiting, ${h.daysLeft} day(s) left`)
      console.log(`  ${day}  card:${h.cardId}  ${h.agentId.padEnd(18)} ${String(h.before).padStart(4)} before  ${String(h.after).padStart(4)} after  ${verdict}`)
      if (h.cost) console.log(chalk.dim(`      cost problem: ${costLine(h.cost)}`))
      console.log(chalk.dim(`      ${h.choice.slice(0, 110)}`))
    }
  })

// --- agentx improve rules — one fix rule per agent, at most 3 (#1996) ---

/** A rollback retires a kind's rules on every agent: `--agent` does not
 *  narrow it, so say so. */
export function retireKindWarning(opts: { retireKind?: string; agent?: string }): string | null {
  return opts.retireKind && opts.agent ? `--agent ${opts.agent} is ignored: --retire-kind retires the rules of ${opts.retireKind} on every agent` : null
}

improve
  .command("rules")
  .description(`the fix rules the nightly pass wrote into each agent's memory (at most ${RULE_BUDGET} per agent), with their signal and verdict, and the last retirements`)
  .option("--agent <id>", "one agent only")
  .option("--json", "print as JSON")
  .option("--retire-kind <kind>", "retire every rule written for this signal kind, on every agent (the rollback of a kind)")
  .action((opts: { agent?: string; json?: boolean; retireKind?: string }) => {
    if (!existsSync(findConfigPath())) { console.error(chalk.red("  no agentx.json here: run this from the install folder, the one that holds agentx.json")); process.exitCode = 1; return }
    const db = openDb()
    if (!db) { process.exitCode = 1; return }
    if (opts.retireKind) {
      if (!(SIGNAL_KINDS as readonly string[]).includes(opts.retireKind)) { console.error(chalk.red(`  unknown kind "${opts.retireKind}": see agentx improve kinds`)); process.exitCode = 1; return }
      const warning = retireKindWarning(opts)
      if (warning) console.error(chalk.yellow(`  ${warning}`))
      const out = retireRulesOfKinds(db, new AgentMemory(), [opts.retireKind])
      if (opts.json) { console.log(JSON.stringify(out, null, 2)); return }
      if (!out.length) { console.log(chalk.dim(`  No rule written for ${opts.retireKind}.`)); return }
      for (const r of out) console.log(`  retired ${r.agentId} ${r.key}`)
      return
    }
    const report = rulesReport(db, new AgentMemory(), Date.now(), opts.agent)
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return }
    if (!report.length) { console.log(chalk.dim(opts.agent ? `  No fix rule for ${opts.agent} yet.` : "  No fix rule written yet.")); return }
    for (const a of report) {
      console.log(chalk.bold(`\n  ${a.agentId}: ${a.rules.length} of ${RULE_BUDGET} rules`))
      for (const r of a.rules) {
        const verdict = r.verdict === "held" ? chalk.green("held") : r.verdict === "not-held" ? chalk.yellow(`did not hold (${r.why})`) : chalk.dim(`waiting, ${r.daysLeft} day(s) left`)
        console.log(`  ${new Date(r.addedAt).toISOString().slice(0, 10)}  ${r.key}  ${r.before} before, ${r.after} after; owner signals ${r.ownerBefore}→${r.ownerAfter}  ${verdict}`)
        console.log(chalk.dim(`      ${r.text}`))
      }
      for (const l of a.retired) console.log(chalk.dim(`  retired ${new Date(l.at).toISOString().slice(0, 10)}  ${l.key}: ${l.reason ?? ""}`))
    }
  })
