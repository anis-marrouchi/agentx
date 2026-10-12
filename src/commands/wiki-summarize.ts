import type { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"

// --- agentx wiki summarize: one line per page for `wiki query` to pick from (#855) ---
//
// Runs on demand or from the `wiki-summarize` job. Only pages with no
// line, or whose text changed since the line was written, cost a model
// call. The lines go to `_summaries.json` beside each catalog; no page
// is edited.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")

interface SummarizeFlags {
  dir?: string
  agent?: string
  all?: boolean
  model?: string
  batch?: string
  workers: string
  limit: string
  dryRun?: boolean
  json?: boolean
}

export function registerWikiSummarize(wiki: Command): void {
  wiki
    .command("summarize")
    .description("write the one-line page summaries `wiki query` picks pages from; only new or changed pages are summarised")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .option("--agent <id>", "summarise this agent's pages (default: the calling agent)")
    .option("--all", "summarise every agent's pages and the shared pages")
    .option("--model <m>", "model (default: wiki.summaries.model, haiku)")
    .option("--batch <n>", "pages per model call (default: wiki.summaries.batchSize, 20)")
    .option("--workers <n>", "model calls running at once", "4")
    .option("--limit <n>", "most pages to summarise per agent in this run (0 = all)", "0")
    .option("--dry-run", "show how many pages are due, call no model, write nothing")
    .option("--json", "print the run as JSON")
    .action(async (opts: SummarizeFlags) => {
      const { WikiHub } = await import("@/wiki")
      const { summarizeStore } = await import("@/wiki/summaries")
      const { claudeModelCall } = await import("@/wiki/model-call")
      let settings = { model: "haiku", batchSize: 20, maxWords: 35 }
      try {
        const { loadDaemonConfig } = await import("@/daemon/config")
        settings = loadDaemonConfig().wiki.summaries
      } catch {
        // No config here: the defaults above.
      }

      const hub = new WikiHub(wikiDir(opts.dir), undefined, "graph")
      const named = opts.agent || process.env.AGENTX_AGENT_ID
      if (!opts.all && !named) {
        console.log(chalk.red("  Name an agent with --agent <id>, or pass --all."))
        process.exitCode = 1
        return
      }
      const targets = opts.all
        ? [...hub.sharedScope("").map((s) => ({ id: s.id, store: s.store, skip: s.skip }))]
        : [{ id: named!, store: hub.getAgentWiki(named!), skip: undefined }]

      const runs = []
      for (const t of targets) {
        const result = await summarizeStore(t.store, {
          call: claudeModelCall,
          model: opts.model ?? settings.model,
          batchSize: opts.batch ? parseInt(opts.batch) : settings.batchSize,
          maxWords: settings.maxWords,
          workers: parseInt(opts.workers),
          limit: parseInt(opts.limit),
          dryRun: opts.dryRun,
          skip: t.skip,
          log: opts.json ? undefined : (line) => console.log(chalk.dim(`  ${t.id}: ${line}`)),
        })
        runs.push({ agent: t.id, ...result })
        if (!opts.json && (result.pages > 0 || result.removed > 0)) {
          const did = opts.dryRun
            ? `${result.due} due`
            : `${result.written} written${result.failed ? chalk.yellow(`, ${result.failed} failed`) : ""}${result.removed ? `, ${result.removed} removed` : ""}`
          console.log(`  ${chalk.bold(t.id)}: ${result.pages} pages, ${did}`)
        }
      }
      if (opts.json) console.log(JSON.stringify(runs, null, 2))
      if (runs.some((r) => r.failed > 0)) process.exitCode = 1
    })
}
