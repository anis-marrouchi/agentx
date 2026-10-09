import type { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"

// --- agentx wiki events: importance and subject for event pages (#811) ---
//
// Runs on demand or from a scheduled job with `command`. The ontology's
// rules decide what they can for free; the rest goes to a model in
// batches, and `--max-cost` stops the run before the next call.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")
const today = () => new Date().toISOString().slice(0, 10)

async function open(dir: string) {
  const { WikiHub } = await import("@/wiki/hub")
  const { GraphCache } = await import("@/wiki/ontology/graph")
  const { loadOntology } = await import("@/wiki/ontology/load")
  const { loadRoster } = await import("@/wiki/ontology/roster")
  const hub = new WikiHub(dir, () => {})
  const { ontology } = loadOntology(dir)
  const g = new GraphCache().get(hub, ontology, loadRoster(dir, hub.listAgents([]), ontology.agent_names))
  return { hub, g }
}

function wholeNumber(value: string, flag: string): number | null {
  const n = Number(value)
  if (Number.isInteger(n) && n >= 1) return n
  console.error(chalk.red(`  ${flag} must be a whole number, 1 or more`))
  process.exitCode = 1
  return null
}

export function registerWikiEvents(wiki: Command): void {
  const events = wiki
    .command("events")
    .description("give each event page an importance level (minor, normal, major) and the pages it is about")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .option("--about <titles...>", "only events linked to or naming these pages (a pilot)")
    .option("--max <n>", "most events per run", "200")
    .option("--batch <n>", "events per model call", "20")
    .option("--max-cost <usd>", "stop before the next call once the run spent this much", "1")
    .option("--model <m>", "model", "haiku")
    .option("--rules-only", "use only the importance rules in ontology.yaml; no model call")
    .option("--force", "redo events whose level this job set earlier")
    .option("--dry-run", "show what would be written, write nothing")
    .option("--json", "print the run as JSON")
    .action(async (opts: { dir?: string; about?: string[]; max: string; batch: string; maxCost: string; model: string; rulesOnly?: boolean; force?: boolean; dryRun?: boolean; json?: boolean }) => {
      const { runEvents, summariseAbout } = await import("@/wiki/event-levels")
      const { claudeCall } = await import("./wiki-enrich")
      const max = wholeNumber(opts.max, "--max")
      const batch = wholeNumber(opts.batch, "--batch")
      if (max === null || batch === null) return
      const maxCostUsd = Number(opts.maxCost)
      if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        console.error(chalk.red("  --max-cost must be a positive number of dollars"))
        process.exitCode = 1
        return
      }
      const { hub, g } = await open(wikiDir(opts.dir))
      const about = opts.about ?? []
      const { normName } = await import("@/wiki/ontology/graph")
      const unknown = about.filter(a => !g.names.has(normName(a)) && !g.entities.has(a))
      if (unknown.length) {
        console.error(chalk.red(`  no page is titled: ${unknown.join(", ")}`))
        process.exitCode = 1
        return
      }
      const run = await runEvents(hub, g, claudeCall(opts.model), {
        about, max, batch, maxCostUsd, dryRun: !!opts.dryRun, force: !!opts.force, rulesOnly: !!opts.rulesOnly, today: today(),
      })
      const summary = summariseAbout(g, run, about)
      if (opts.json) {
        console.log(JSON.stringify({ ...run, about: summary }, null, 2))
        return
      }
      for (const o of run.outcomes) {
        const mark = o.status === "written" ? chalk.green("✓") : o.status === "dry-run" ? chalk.cyan("~") : chalk.yellow("·")
        const level = o.importance ? `${o.importance}${o.proposed ? ` (proposed ${o.proposed})` : ""}` : o.status
        console.log(`  ${mark} ${o.date || "no date   "}  ${level.padEnd(8)} ${o.title}  ${chalk.dim(`${o.by ?? o.status}${o.about.length ? ` · about ${o.about.join(", ")}` : ""}${o.why ? ` · ${o.why}` : ""}`)}`)
        for (const d of o.dropped.slice(0, 4)) console.log(chalk.dim(`      dropped: ${d}`))
      }
      for (const s of summary) {
        console.log(chalk.bold(`  ${s.title}`) + chalk.dim(` (${s.type}): ${s.before} events in its History before · after: ${s.after.major} major, ${s.after.normal} normal, ${s.after.minor} minor (folded)`))
      }
      const done = run.outcomes.filter(o => o.importance).length
      if (run.outcomes.length === 0) console.log(chalk.dim("  nothing to do: every event in scope already has a level (--force redoes the ones this job set)"))
      console.log(chalk.dim(`  ${done} event${done === 1 ? "" : "s"} ${opts.dryRun ? "would get" : "got"} a level · ${run.left} left · ${run.calls} model call${run.calls === 1 ? "" : "s"} · spent $${run.costUsd.toFixed(3)} of $${maxCostUsd}${run.capped ? " · stopped at the cap" : ""}`))
      if (run.outcomes.some(o => o.status === "failed")) process.exitCode = 1
    })

  events
    .command("set <title> <level>")
    .description("set an event's importance yourself (minor, normal or major); no later run changes it")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .action(async (title: string, level: string, _opts: unknown, cmd: Command) => {
      const { setEventLevel } = await import("@/wiki/event-levels")
      const { IMPORTANCE_LEVELS } = await import("@/wiki/ontology/types")
      const lv = level.toLowerCase() as (typeof IMPORTANCE_LEVELS)[number]
      if (!IMPORTANCE_LEVELS.includes(lv)) {
        console.error(chalk.red(`  level must be one of ${IMPORTANCE_LEVELS.join(", ")}`))
        process.exitCode = 1
        return
      }
      const { hub, g } = await open(wikiDir(cmd.optsWithGlobals().dir))
      const r = setEventLevel(hub, g, title, lv)
      if (r.ok) console.log(chalk.green(`  ${r.title} is now ${lv}`) + chalk.dim(` (${r.page})`))
      else {
        console.error(chalk.red(`  not set: ${r.reason}`))
        process.exitCode = 1
      }
    })

  events
    .command("proposed")
    .description("list events a run suggests as major, waiting for you to decide")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .option("--json", "print as JSON")
    .action(async (_opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals() as { dir?: string; json?: boolean }
      const { g } = await open(wikiDir(o.dir))
      const list = [...g.entities.values()]
        .filter(e => e.type === "event" && e.importanceProposed && e.importanceProposed !== e.importance)
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      if (o.json) {
        console.log(JSON.stringify(list.map(e => ({ id: e.id, title: e.title, date: e.date, importance: e.importance, proposed: e.importanceProposed })), null, 2))
        return
      }
      for (const e of list) console.log(`  ${e.date || "no date   "}  ${e.title}  ${chalk.dim(`now ${e.importance}, proposed ${e.importanceProposed}`)}`)
      console.log(chalk.dim(list.length ? `  ${list.length} waiting. Decide each with: agentx wiki events set "<title>" major   (or normal)` : "  none waiting"))
    })
}
