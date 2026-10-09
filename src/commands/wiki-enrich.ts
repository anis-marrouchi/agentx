import type { Command } from "commander"
import chalk from "chalk"
import { spawn } from "child_process"
import { resolve } from "path"

// --- agentx wiki enrich: full overview, typed facts and linked history per entity (#820) ---
//
// Runs on demand or from a scheduled job with `command`. Each entity
// costs one model call; `--max-cost` stops the run before the next call
// once the spend reaches it.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")

/** One `claude -p` call with no tools; cost from the JSON envelope.
 *  The prompt carries raw message text, so no built-in tool, MCP server,
 *  hook or settings file is loaded: an injected instruction has nothing
 *  to write or send with. */
export function claudeCall(model: string): (prompt: string) => Promise<{ text: string; costUsd: number }> {
  return async (prompt) => {
    const { claudeCliEnv } = await import("@/utils/workspace-env")
    const args = ["-p", "-", "--output-format", "json", "--max-turns", "1", "--model", model,
      "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", '{"disableAllHooks":true}', "--setting-sources", "", "--no-session-persistence"]
    const out = await new Promise<string>((ok, fail) => {
      const child = spawn("claude", args, { env: claudeCliEnv(), stdio: ["pipe", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => child.kill("SIGTERM"), 240_000)
      child.stdout.on("data", d => { stdout += d })
      child.stderr.on("data", d => { stderr += d })
      child.on("error", err => { clearTimeout(timer); fail(err) })
      child.on("close", code => {
        clearTimeout(timer)
        if (code === 0) ok(stdout)
        else fail(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 200)}`))
      })
      child.stdin.end(prompt)
    })
    const envelope = JSON.parse(out) as { result?: string; total_cost_usd?: number; is_error?: boolean }
    if (envelope.is_error) throw new Error(`model error: ${String(envelope.result).slice(0, 200)}`)
    return { text: String(envelope.result ?? ""), costUsd: Number(envelope.total_cost_usd) || 0 }
  }
}

export function registerWikiEnrich(wiki: Command): void {
  wiki
    .command("enrich [entities...]")
    .description("write a full overview, sourced typed facts and linked history on entity pages (person, organization, project, place, assets)")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .option("--types <list>", "comma-separated entity types", "person,organization,project,place,device,server,app,domain,account")
    .option("--max <n>", "most entities per run", "10")
    .option("--max-cost <usd>", "stop before the next call once the run spent this much", "1")
    .option("--model <m>", "model", "sonnet")
    .option("--force", "redo entities whose sources did not change")
    .option("--dry-run", "show what would be written, write nothing")
    .option("--create <title>", "first create a page for a thing other pages only name, then enrich it (needs --as and --owner)")
    .option("--as <type>", "type of the page --create makes, e.g. organization")
    .option("--owner <agent>", "agent whose wiki gets the page --create makes")
    .option("--json", "print the run as JSON")
    .action(async (entities: string[], opts: { dir?: string; types: string; max: string; maxCost: string; model: string; force?: boolean; dryRun?: boolean; json?: boolean; create?: string; as?: string; owner?: string }) => {
      const { WikiHub } = await import("@/wiki/hub")
      const { GraphCache } = await import("@/wiki/ontology/graph")
      const { loadOntology } = await import("@/wiki/ontology/load")
      const { loadRoster } = await import("@/wiki/ontology/roster")
      const { ENRICH_TYPES, loadEnrichState, runEnrich, saveEnrichState } = await import("@/wiki/enrich")
      const dir = wikiDir(opts.dir)
      const types = opts.types.split(",").map(s => s.trim()).filter(Boolean)
      const unknown = types.filter(t => !ENRICH_TYPES.includes(t))
      if (unknown.length) {
        console.error(chalk.red(`  not an entity type this job handles: ${unknown.join(", ")} (use ${ENRICH_TYPES.join(", ")})`))
        process.exitCode = 1
        return
      }
      const max = Number(opts.max)
      if (!Number.isInteger(max) || max < 1) {
        console.error(chalk.red("  --max must be a whole number of entities, 1 or more"))
        process.exitCode = 1
        return
      }
      const maxCostUsd = Number(opts.maxCost)
      if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        console.error(chalk.red("  --max-cost must be a positive number of dollars"))
        process.exitCode = 1
        return
      }
      const hub = new WikiHub(dir, () => {})
      if (opts.create) {
        const { createEntityPage } = await import("@/wiki/enrich")
        if (!opts.as || !ENRICH_TYPES.includes(opts.as) || !opts.owner) {
          console.error(chalk.red(`  --create needs --as <${ENRICH_TYPES.join("|")}> and --owner <agent>`))
          process.exitCode = 1
          return
        }
        if (hub.syncedFrom(opts.owner)) {
          console.error(chalk.red(`  ${opts.owner}'s pages are copied from another node; pick an agent that runs here`))
          process.exitCode = 1
          return
        }
        if (opts.dryRun) {
          console.log(chalk.dim(`  --dry-run: would create "${opts.create}" (${opts.as}) in ${opts.owner}'s wiki`))
        } else {
          const path = createEntityPage(hub, opts.create, opts.as, opts.owner, new Date().toISOString().slice(0, 10))
          console.log(path ? chalk.green(`  created ${opts.owner}/${path}`) : chalk.dim(`  ${opts.owner} already has a page titled "${opts.create}"`))
        }
        entities = [...entities, opts.create]
        if (!types.includes(opts.as)) types.push(opts.as)
      }
      const { ontology } = loadOntology(dir)
      const g = new GraphCache().get(hub, ontology, loadRoster(dir, hub.listAgents([]), ontology.agent_names))
      const state = loadEnrichState(dir)
      const run = await runEnrich(hub, g, claudeCall(opts.model), {
        types, only: entities, max, maxCostUsd, dryRun: !!opts.dryRun, force: !!opts.force, today: new Date().toISOString().slice(0, 10),
        save: s => saveEnrichState(dir, s),
      }, state)

      if (opts.json) {
        console.log(JSON.stringify(run, null, 2))
        return
      }
      for (const o of run.outcomes) {
        const mark = o.status === "written" ? chalk.green("✓") : o.status === "dry-run" ? chalk.cyan("~") : chalk.yellow("·")
        console.log(`  ${mark} ${o.title}  ${chalk.dim(`${o.status} · ${o.page ?? "no page"} · overview ${o.overview ? "yes" : "no"} · ${o.statements} facts · ${o.links} links · $${o.costUsd.toFixed(3)}`)}`)
        for (const f of o.facts ?? []) console.log(chalk.dim(`      fact: ${f.property} → ${f.value}${f.role ? ` (${f.role})` : ""} · source ${f.source}`))
        for (const d of o.dropped.slice(0, 6)) console.log(chalk.dim(`      dropped: ${d}`))
        if (o.preview) console.log(chalk.dim(o.preview.split("\n").slice(0, 12).map(l => `      | ${l}`).join("\n")))
      }
      if (run.outcomes.length === 0) console.log(chalk.dim("  nothing to do: no entity of these types changed since the last run (--force redoes them)"))
      console.log(chalk.dim(`  spent $${run.costUsd.toFixed(3)} of $${maxCostUsd}${run.capped ? " · stopped at the cap" : ""}`))
    })
}
