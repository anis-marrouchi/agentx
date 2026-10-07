import { Command } from "commander"
import chalk from "chalk"
import { existsSync } from "fs"
import { resolve } from "path"
import Database from "better-sqlite3"
import { readApprovalSettings } from "@/approvals/settings"
import { reviewWithClaude } from "@/daemon/session-monitor"
import { prepareRetro, raiseRetroCard, RETRO_PROMPT } from "@/retro/retro"
import { DEFAULT_RETRO_PER_DAY, DEFAULT_SWEEP_HOURS, sweepRetros } from "@/retro/sweep"
import { beforeAfter, CHECK_WINDOW_DAYS, DEFAULT_CHECK_REVIEWS, DEFAULT_MIN_GOOD_FIRES, reviewChecksPass } from "@/retro/checks"

// --- agentx retro <taskId> (#743) ---
//
// Reads one run that struggled, asks a reviewer for up to four fixes to the
// agents' environment, and raises them as one decision card. Nothing
// changes until the operator picks: unanswered, the card is discarded.
// The pick goes back to the agent that ran the task, which builds the fix
// for a second review (src/approvals/origin.ts retroLines).

function reviewerModel(model?: string): string {
  return model || process.env.AGENTX_RETRO_MODEL || process.env.AGENTX_MONITOR_MODEL || "opus"
}

/** The trace database, or undefined (with the error printed) when missing. */
function openTraceDb(root: string, path?: string): Database.Database | undefined {
  const dbPath = resolve(root, path ?? ".agentx/db.sqlite")
  if (!existsSync(dbPath)) {
    console.error(chalk.red(`  No trace database at ${dbPath}. Run this in the folder the daemon runs from.`))
    process.exitCode = 1
    return undefined
  }
  return new Database(dbPath, { readonly: true })
}

/** "24h", "2d" → milliseconds; null when it isn't one of those. */
export function sweepWindowMs(input: string): number | null {
  const m = /^(\d+)\s*([hd])$/.exec(input.trim())
  return m && Number(m[1]) > 0 ? Number(m[1]) * (m[2] === "h" ? 3_600_000 : 86_400_000) : null
}

export const retro = new Command("retro")
  .description("turn one run that struggled into fix choices on a decision card")
  .argument("<taskId>", "the run, from `agentx trace list`")
  .option("--model <model>", "the reviewer model (default: AGENTX_RETRO_MODEL, else AGENTX_MONITOR_MODEL, else opus)")
  .option("--dry-run", "show the card without raising it")
  .option("--force", "raise a card even when the run shows no struggle, or one about the same failure is open")
  .option("--path <db>", "trace database (default: .agentx/db.sqlite)")
  .action(async (taskId: string, opts: { model?: string; dryRun?: boolean; force?: boolean; path?: string }) => {
    const root = process.cwd()
    const db = openTraceDb(root, opts.path)
    if (!db) return
    const model = reviewerModel(opts.model)
    console.log(chalk.dim(`  Reading run ${taskId} and asking ${model} for fixes…`))
    const r = await prepareRetro({
      root, db, taskId, force: opts.force,
      propose: (input) => reviewWithClaude(input, model, undefined, RETRO_PROMPT),
    }).finally(() => db.close())

    for (const s of r.signals ?? []) console.log(chalk.dim(`  · ${s.kind}: ${s.text}`))
    for (const d of r.dropped ?? []) console.log(chalk.dim(`  ✗ dropped "${d.label}": ${d.why}`))
    if (!r.ok) {
      console.error(chalk.red(`  ${r.error}`))
      process.exitCode = 1
      return
    }

    const c = r.card
    console.log("")
    console.log(`  ${chalk.bold(c.title as string)}`)
    if (c.context) console.log(chalk.dim(`  ${c.context}`))
    console.log(`  ${c.ask}`)
    ;(c.choices as string[]).forEach((label, i) => console.log(`    ${chalk.magenta(`${i + 1}.`)} ${label}`))
    console.log(`  ${chalk.green("Recommends:")} ${c.recommend}`)
    if (opts.dryRun) {
      console.log(chalk.dim("\n  Dry run: no card raised."))
      return
    }

    const raised = raiseRetroCard(root, c, readApprovalSettings())
    if (!raised.ok) {
      console.error(chalk.red(`  ${raised.error}`))
      process.exitCode = 1
      return
    }
    console.log(chalk.green(`\n  ✓ card:${raised.card.id} raised for ${raised.card.raised_by}. Pick a fix on /approvals, in the phone app, or with`))
    console.log(chalk.green(`    agentx approvals approve card:${raised.card.id} --choice <n>`))
  })

// --- agentx retro sweep (#743, P1) ---
//
// The nightly pass: ranks the window's struggled runs and, with --commit,
// raises cards for the worst few, within the daily limit. Without --commit
// it only ranks, so it is safe to run by hand to see what tonight would do.

retro
  .command("sweep")
  .description("rank the day's struggled runs and raise retro cards for the worst (preview unless --commit)")
  .option("--since <window>", `how far back to read, e.g. 24h or 2d (default: ${DEFAULT_SWEEP_HOURS}h)`)
  .option("--max <n>", `retro cards allowed in any 24 hours, counting ones raised by hand (default: ${DEFAULT_RETRO_PER_DAY})`)
  .option("--commit", "ask the reviewer and raise the cards (default: rank only)")
  .option("--model <model>", "the reviewer model (default: AGENTX_RETRO_MODEL, else AGENTX_MONITOR_MODEL, else opus)")
  .option("--path <db>", "trace database (default: .agentx/db.sqlite)")
  .action(async (opts: { since?: string; max?: string; commit?: boolean; model?: string; path?: string }) => {
    const windowMs = sweepWindowMs(opts.since ?? `${DEFAULT_SWEEP_HOURS}h`)
    if (windowMs === null) {
      console.error(chalk.red(`  Invalid --since "${opts.since}". Use hours or days, such as 24h or 2d.`))
      process.exitCode = 1
      return
    }
    const max = opts.max === undefined ? DEFAULT_RETRO_PER_DAY : Number(opts.max)
    if (!Number.isInteger(max) || max < 0) {
      console.error(chalk.red(`  Invalid --max "${opts.max}". Use a whole number, 0 or more.`))
      process.exitCode = 1
      return
    }
    const root = process.cwd()
    const db = openTraceDb(root, opts.path)
    if (!db) return
    const model = reviewerModel(opts.model)
    const r = await sweepRetros({
      root, db, max, commit: opts.commit,
      since: Date.now() - windowMs,
      settings: readApprovalSettings(),
      propose: (input) => reviewWithClaude(input, model, undefined, RETRO_PROMPT),
    }).finally(() => db.close())

    console.log(`  ${r.ranked.length} struggled run(s), one per failure. Room for ${r.room} more retro card(s) today (limit ${max}).`)
    for (const run of r.ranked.slice(0, 10)) {
      console.log(chalk.dim(`  ${String(run.score).padStart(2)}  ${run.task.taskId}  ${run.task.agentId}  ${run.signals.map((s) => s.kind).join(", ")}`))
    }
    if (r.error) {
      console.error(chalk.red(`  ${r.error}`))
      process.exitCode = 1
      return
    }
    for (const o of r.outcomes) {
      if (o.result === "raised") console.log(chalk.green(`  ✓ card:${o.cardId} raised for ${o.agentId} (run ${o.taskId})`))
      else if (o.result === "would-try") console.log(`  → would retro ${o.taskId} (${o.agentId})`)
      else console.log(chalk.dim(`  ✗ ${o.taskId}: ${o.why}`))
    }
    if (!opts.commit) console.log(chalk.dim("\n  Preview: no reviewer asked, no card raised. Add --commit to raise them."))
  })

// --- agentx retro checks (#743, P2) ---
//
// The monthly pass: lists the guard rules retros added (tagged
// `retro:<taskId>`), how often each fired on work that went well, and how
// the agent's runs did before and after it. With --commit, a check that
// fires often on good work comes back as a keep / loosen / remove card.

/** A whole number, 0 or more; null otherwise. */
function count(input: string | undefined, fallback: number): number | null {
  const n = input === undefined ? fallback : Number(input)
  return Number.isInteger(n) && n >= 0 ? n : null
}

retro
  .command("checks")
  .description("review the guard rules retros added; raise a keep/loosen/remove card for each that fires on good work (preview unless --commit)")
  .option("--min-fires <n>", `fires on runs that went well, in the last ${CHECK_WINDOW_DAYS} days, before a check is reviewed (default: ${DEFAULT_MIN_GOOD_FIRES})`)
  .option("--max <n>", `review cards raised in one pass (default: ${DEFAULT_CHECK_REVIEWS})`)
  .option("--commit", "raise the review cards (default: list only)")
  .option("--path <db>", "trace database (default: .agentx/db.sqlite)")
  .action((opts: { minFires?: string; max?: string; commit?: boolean; path?: string }) => {
    const minGoodFires = count(opts.minFires, DEFAULT_MIN_GOOD_FIRES)
    const max = count(opts.max, DEFAULT_CHECK_REVIEWS)
    if (minGoodFires === null || max === null) {
      console.error(chalk.red(`  Invalid ${minGoodFires === null ? `--min-fires "${opts.minFires}"` : `--max "${opts.max}"`}. Use a whole number, 0 or more.`))
      process.exitCode = 1
      return
    }
    const root = process.cwd()
    const db = openTraceDb(root, opts.path)
    if (!db) return
    let r
    try {
      r = reviewChecksPass({ root, db, minGoodFires, max, commit: opts.commit, settings: readApprovalSettings() })
    } finally {
      db.close()
    }

    if (!r.reviews.length) {
      console.log("  No guard rule carries a retro:<taskId> tag yet. Nothing to review.")
      return
    }
    console.log(`  ${r.reviews.length} check(s) added by a retro. Last ${CHECK_WINDOW_DAYS} days:`)
    for (const v of r.reviews) {
      const mark = v.noisy ? chalk.yellow("!") : " "
      console.log(`  ${mark} ${v.check.rule.id}  ${chalk.dim(v.check.file)}  retro:${v.check.taskId}`)
      console.log(chalk.dim(`      ${v.fires.total} fire(s): ${v.fires.good} on good runs, ${v.fires.failed} on failed runs, ${v.fires.unknown} unknown`))
      console.log(chalk.dim(`      ${v.agents.join(", ") || "no agent"} ${beforeAfter(v)}`))
    }
    if (r.error) {
      console.error(chalk.red(`  ${r.error}`))
      process.exitCode = 1
      return
    }
    for (const o of r.outcomes) {
      if (o.result === "raised") console.log(chalk.green(`  ✓ card:${o.cardId} asks whether to keep, loosen or remove ${o.ruleId}`))
      else if (o.result === "would-raise") console.log(`  → would ask about ${o.ruleId}`)
      else console.log(chalk.dim(`  ✗ ${o.ruleId}: ${o.why}`))
    }
    if (!r.outcomes.length) console.log(chalk.dim(`  No check fired ${minGoodFires} or more times on good runs. No card needed.`))
    if (!opts.commit) console.log(chalk.dim("\n  Preview: no card raised. Add --commit to raise them."))
  })
