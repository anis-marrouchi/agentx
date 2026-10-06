import { Command } from "commander"
import chalk from "chalk"
import { existsSync } from "fs"
import { resolve } from "path"
import Database from "better-sqlite3"
import { readApprovalSettings } from "@/approvals/settings"
import { reviewWithClaude } from "@/daemon/session-monitor"
import { prepareRetro, raiseRetroCard, RETRO_PROMPT } from "@/retro/retro"

// --- agentx retro <taskId> (#743) ---
//
// Reads one run that struggled, asks a reviewer for up to four fixes to the
// agents' environment, and raises them as one decision card. Nothing
// changes until the operator picks: unanswered, the card is discarded.
// The pick goes back to the agent that ran the task, which builds the fix
// for a second review (src/approvals/origin.ts retroLines).

export const retro = new Command("retro")
  .description("turn one run that struggled into fix choices on a decision card")
  .argument("<taskId>", "the run, from `agentx trace list`")
  .option("--model <model>", "the reviewer model (default: AGENTX_RETRO_MODEL, else AGENTX_MONITOR_MODEL, else opus)")
  .option("--dry-run", "show the card without raising it")
  .option("--force", "raise a card even when the run shows no struggle, or one about the same failure is open")
  .option("--path <db>", "trace database (default: .agentx/db.sqlite)")
  .action(async (taskId: string, opts: { model?: string; dryRun?: boolean; force?: boolean; path?: string }) => {
    const root = process.cwd()
    const dbPath = resolve(root, opts.path ?? ".agentx/db.sqlite")
    if (!existsSync(dbPath)) {
      console.error(chalk.red(`  No trace database at ${dbPath}. Run this in the folder the daemon runs from.`))
      process.exitCode = 1
      return
    }
    const db = new Database(dbPath, { readonly: true })
    const model = opts.model || process.env.AGENTX_RETRO_MODEL || process.env.AGENTX_MONITOR_MODEL || "opus"
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
