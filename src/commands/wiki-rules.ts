import type { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"
import { claudeCall } from "./wiki-enrich"

// --- agentx wiki rules: one obligation page per rule, with deadline, penalty, source and check date (#811) ---
//
// Runs on demand or from a scheduled job with `command`. Each source page
// costs one model call; `--max-cost` stops the run before the next call
// once the spend reaches it.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")

export function registerWikiRules(wiki: Command): void {
  wiki
    .command("rules [pages...]")
    .description("write one obligation page per rule the wiki states, with deadline, penalty, source and check date")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .option("--words <list>", "comma-separated words that mark a page as stating rules (default: deadline, penalty, filing… in English, French and Arabic)")
    .option("--max <n>", "most source pages per run", "10")
    .option("--max-cost <usd>", "stop before the next call once the run spent this much", "1")
    .option("--model <m>", "model", "sonnet")
    .option("--force", "read again pages that did not change")
    .option("--dry-run", "show what would be written, write nothing")
    .option("--json", "print the run as JSON")
    .action(async (pages: string[], opts: { dir?: string; words?: string; max: string; maxCost: string; model: string; force?: boolean; dryRun?: boolean; json?: boolean }) => {
      const { WikiHub } = await import("@/wiki/hub")
      const { GraphCache } = await import("@/wiki/ontology/graph")
      const { loadOntology } = await import("@/wiki/ontology/load")
      const { loadRoster } = await import("@/wiki/ontology/roster")
      const { loadRulesState, ruleWordsPattern, runRules, saveRulesState } = await import("@/wiki/rules")
      const dir = wikiDir(opts.dir)
      const max = Number(opts.max)
      if (!Number.isInteger(max) || max < 1) {
        console.error(chalk.red("  --max must be a whole number of pages, 1 or more"))
        process.exitCode = 1
        return
      }
      const maxCostUsd = Number(opts.maxCost)
      if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        console.error(chalk.red("  --max-cost must be a positive number of dollars"))
        process.exitCode = 1
        return
      }
      const words = opts.words?.split(",").map(s => s.trim()).filter(Boolean)
      if (opts.words !== undefined && !words?.length) {
        console.error(chalk.red("  --words needs at least one word"))
        process.exitCode = 1
        return
      }
      const hub = new WikiHub(dir, () => {})
      const { ontology } = loadOntology(dir)
      if (!ontology.types.some(t => t.id === "obligation")) {
        console.error(chalk.red("  ontology.yaml has no `obligation` type; add it back to write rule pages"))
        process.exitCode = 1
        return
      }
      const g = new GraphCache().get(hub, ontology, loadRoster(dir, hub.listAgents([]), ontology.agent_names))
      const state = loadRulesState(dir)
      const run = await runRules(hub, g, claudeCall(opts.model), {
        only: pages, words: ruleWordsPattern(words), max, maxCostUsd, dryRun: !!opts.dryRun, force: !!opts.force,
        today: new Date().toISOString().slice(0, 10), save: s => saveRulesState(dir, s),
      }, state)

      if (opts.json) {
        console.log(JSON.stringify(run, null, 2))
        return
      }
      for (const o of run.outcomes) {
        const mark = o.status === "written" ? chalk.green("✓") : o.status === "dry-run" ? chalk.cyan("~") : chalk.yellow("·")
        console.log(`  ${mark} ${o.title}  ${chalk.dim(`${o.status} · ${o.page ?? "no page"} · ${o.rules.length} rules · $${o.costUsd.toFixed(3)}`)}`)
        for (const r of o.rules) {
          const gaps = [r.deadline ? "" : "no deadline", r.penalty ? "" : "no penalty"].filter(Boolean)
          console.log(`      ${r.created ? "new" : "updated"}: ${r.title} ${chalk.dim(`· ${r.page}${gaps.length ? ` · ${gaps.join(", ")}` : ""}${r.linked.length ? ` · linked from ${r.linked.join(", ")}` : ""}`)}`)
          if (r.preview) console.log(chalk.dim(r.preview.split("\n").map(l => `        | ${l}`).join("\n")))
        }
        for (const d of o.dropped.slice(0, 6)) console.log(chalk.dim(`      dropped: ${d}`))
      }
      if (run.outcomes.length === 0) console.log(chalk.dim("  nothing to do: no page that states rules changed since the last run (--force reads them again)"))
      console.log(chalk.dim(`  spent $${run.costUsd.toFixed(3)} of $${maxCostUsd}${run.capped ? " · stopped at the cap" : ""}`))
    })
}
