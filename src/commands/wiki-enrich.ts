import type { Command } from "commander"
import chalk from "chalk"
import { randomUUID } from "crypto"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

// --- agentx wiki enrich: scheduled enrichment of entity pages (#820) ---
//
// `run` brings the pages due a refresh up to date through the configured
// agent; the `wiki-enrich` schedule calls it. `status` shows the last
// runs and each page's outcome. `config` sets the agent, the page types,
// the sources it may read, the caps per run, and the schedule.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")

function fail(msg: string): void {
  console.error(chalk.red(`  ${msg}`))
  process.exitCode = 1
}

function safe<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try { await fn(...args) } catch (e: any) { fail(e?.message ?? String(e)) }
  }
}

export function registerWikiEnrich(wiki: Command): void {
  const enrich = wiki
    .command("enrich")
    .description("keep person, organisation, project, place and asset pages up to date on a schedule: run, status, config")

  enrich
    .command("run")
    .description("refresh the pages whose sources changed since the last run, through the configured agent")
    .option("--dir <path>", "wiki directory (default: .agentx/wiki)")
    .option("-c, --config <path>", "config file (default: ./agentx.json)")
    .option("--page <title>", "refresh only this page, even when enrichment is off")
    .option("--force", "refresh even when nothing changed")
    .option("--limit <n>", "refresh at most this many pages this time")
    .option("--max-cost <usd>", "spending cap for this run in US dollars, instead of wikiEnrich.maxSpendUsd")
    .option("--dry-run", "ask the agent and show what would change, without writing")
    .option("--json", "print the run record as JSON")
    .action(safe(async (opts) => {
      const { loadDaemonConfig } = await import("@/daemon/config")
      const { WikiHub } = await import("@/wiki/hub")
      const { runEnrichment } = await import("@/wiki/enrich")
      const { wikiEnrichSettings } = await import("@/wiki/enrich-settings")
      const config = loadDaemonConfig(opts.config ? resolve(opts.config) : undefined)
      const settings = wikiEnrichSettings((config as any).wikiEnrich)
      if (opts.maxCost !== undefined) {
        const cap = Number(opts.maxCost)
        if (!Number.isFinite(cap) || cap < 0) { fail("--max-cost must be a number of dollars, 0 or more"); return }
        settings.maxSpendUsd = cap
      }
      let limit: number | undefined
      if (opts.limit !== undefined) {
        limit = Number(opts.limit)
        if (!/^\d+$/.test(String(opts.limit).trim()) || !Number.isInteger(limit) || limit < 1) { fail("--limit must be a whole number of pages, 1 or more"); return }
      }
      if (!settings.agent) { fail("no enrichment agent set; run `agentx wiki enrich config --agent <id>` first"); return }
      if (!config.agents[settings.agent]) { fail(`no agent "${settings.agent}" on this node`); return }
      if (!settings.enabled && !opts.page && !opts.dryRun) { fail("wiki enrichment is off on this node; turn it on with `agentx wiki enrich config --enable`, or name one page with --page"); return }

      const hub = new WikiHub(wikiDir(opts.dir), () => {}, "graph")
      const copiedFrom = hub.syncedFrom(settings.agent)
      if (copiedFrom) { fail(`${settings.agent}'s pages are copied from ${copiedFrom.node} and read-only here; run the enrichment on ${copiedFrom.node}`); return }

      const { AgentRegistry } = await import("@/agents/registry")
      const { LandscapeBuilder } = await import("@/agents/landscape")
      const quiet = (...args: unknown[]) => { if (process.env.AGENTX_DEBUG) console.error("[wiki enrich]", ...args) }
      const registry = new AgentRegistry(config, quiet)
      try {
        const landscape = new LandscapeBuilder(config)
        landscape.build()
        registry.setLandscape(landscape)
      } catch { /* a run without the landscape still works */ }

      const { agentNamesOf } = await import("@/wiki/ontology/agent-names")
      const record = await runEnrichment({
        hub,
        settings,
        agentIds: agentNamesOf(config.agents as any),
        dryRun: !!opts.dryRun,
        only: opts.page,
        force: !!opts.force || !!opts.page,
        limit,
        log: (m) => { if (!opts.json) console.log(chalk.dim(`  ${m}`)) },
        ask: async (message) => {
          const r = await registry.execute({
            agentId: settings.agent,
            message,
            ...(settings.model ? { model: settings.model } : {}),
            context: { channel: "wiki-enrich", chatId: `wiki-enrich-${randomUUID()}`, sender: "cli" },
          })
          return { text: r.content ?? "", costUsd: r.costUsd, error: r.error }
        },
        lookupFacts: async (e, sources) => {
          const { defaultSources, mergeRecords, resolveFacts } = await import("@/wiki/facts")
          const picked = defaultSources().filter(s => (sources as string[]).includes(s.name))
          if (!picked.length) return []
          const { records } = await resolveFacts([{ name: e.title, origin: "article", ...(e.type === "person" ? { type: "person" } : {}) }], { sources: picked, timeoutMs: 60_000, maxEntities: 1 })
          return mergeRecords(records).flatMap(m => Object.entries(m.fields).map(([field, v]) => ({ field, value: v.value, source: v.source })))
        },
      })

      if (opts.json) console.log(JSON.stringify(record, null, 2))
      else {
        for (const it of record.items) {
          if (!it.plan) continue
          console.log(chalk.bold(`\n  ${it.title} (${it.type})`))
          if (it.plan.overview) console.log(`  overview: ${it.plan.overview}`)
          for (const s of it.plan.statements) console.log(`  + ${s}`)
          for (const h of it.plan.history) console.log(`  history: ${h}`)
          for (const n of it.plan.newEvents) console.log(`  new event page: ${n}`)
          for (const d of it.plan.dropped) console.log(chalk.dim(`  left out: ${d}`))
        }
        const cost = `$${record.spentUsd.toFixed(2)}${record.costUnknown ? ` (+${record.costUnknown} call${record.costUnknown === 1 ? "" : "s"} with no reported cost)` : ""}`
        console.log(`  ${record.dryRun ? "dry run: " : ""}${record.refreshed} refreshed, ${record.failed} failed, ${record.unchanged} unchanged${record.givenUp ? `, ${record.givenUp} left alone after repeated failures` : ""}, ${Math.max(0, record.due - record.items.length)} left for the next run · spent ${cost}${record.stoppedBy ? ` · stopped by ${record.stoppedBy}` : ""}`)
      }
      // A finished run exits 0 even when pages failed: the failures are in
      // _enrich.json and `status`. A non-zero exit would make the command
      // cron retry the whole run, each time with a fresh spending cap.
      // The registry holds timers and pooled CLI processes open.
      process.exit(process.exitCode ?? 0)
    }))

  enrich
    .command("status")
    .description("show the last enrichment runs and what each page got")
    .option("--dir <path>", "wiki directory (default: .agentx/wiki)")
    .option("--runs <n>", "how many runs to show", "5")
    .option("--json")
    .action(safe(async (opts) => {
      const { EnrichState } = await import("@/wiki/enrich")
      const state = new EnrichState(wikiDir(opts.dir)).load()
      if (state.unreadable) { fail(`the enrichment state file could not be read: ${state.unreadable}`); return }
      const runs = state.runs.slice(-Math.max(1, Number(opts.runs) || 5)).reverse()
      if (opts.json) { console.log(JSON.stringify({ runs, pages: state.pages }, null, 2)); return }
      if (runs.length === 0) { console.log(chalk.dim("  no enrichment run yet")); return }
      for (const r of runs) {
        console.log(`  ${chalk.bold(r.at.slice(0, 16).replace("T", " "))}  ${r.agent}  ${r.refreshed} refreshed, ${r.failed} failed, ${r.unchanged} unchanged · $${r.spentUsd.toFixed(2)}${r.stoppedBy ? ` · stopped by ${r.stoppedBy}` : ""}`)
        for (const it of r.items) {
          const mark = it.outcome === "refreshed" ? chalk.green("✓") : it.outcome === "failed" ? chalk.red("✗") : chalk.dim("·")
          console.log(`    ${mark} ${it.title} ${chalk.dim(`(${it.type})`)}${it.statements ? ` ${it.statements} statements` : ""}${it.events ? `, ${it.events} new events` : ""}${it.reason ? chalk.dim(` — ${it.reason}`) : ""}`)
        }
      }
    }))

  enrich
    .command("config")
    .description("show or set the agent, page types, sources, caps and schedule")
    .option("--agent <id>", "agent that runs the enrichment and owns the pages it writes (\"\" clears it)")
    .option("--types <ids>", "comma-separated page types, for example person,organization,project,place")
    .option("--sources <ids>", "comma-separated sources it may read: entries, contacts, wacli, gitlab, gog, web")
    .option("--max-pages <n>", "most pages refreshed in one run (1-200)")
    .option("--max-spend <usd>", "spending cap per run in US dollars (0 = no cap)")
    .option("--max-entries <n>", "most messages given for one page (1-200)")
    .option("--max-events <n>", "most new event pages one page may create in a run (0-20)")
    .option("--model <model>", "model for the agent's calls (\"\" uses the agent's own model)")
    .option("--schedule <cron>", "when it runs, as a five-field cron schedule (\"\" removes the schedule)")
    .option("--timezone <tz>", "time zone for --schedule, for example Europe/Paris")
    .option("--enable", "turn wiki enrichment on")
    .option("--disable", "turn wiki enrichment off")
    .option("--json")
    .action(safe(async (opts) => {
      const { patchEnrichCron, patchWikiEnrich, wikiEnrichSettings, ENRICH_CRON_ID } = await import("@/wiki/enrich-settings")
      const patch: Record<string, unknown> = {}
      const csv = (v: string) => String(v).split(",")
      if (opts.agent !== undefined) patch.agent = opts.agent
      if (opts.types !== undefined) patch.types = csv(opts.types)
      if (opts.sources !== undefined) patch.sources = csv(opts.sources)
      if (opts.maxPages !== undefined) patch.maxPages = opts.maxPages
      if (opts.maxSpend !== undefined) patch.maxSpendUsd = opts.maxSpend
      if (opts.maxEntries !== undefined) patch.maxEntriesPerPage = opts.maxEntries
      if (opts.maxEvents !== undefined) patch.maxNewEvents = opts.maxEvents
      if (opts.model !== undefined) patch.model = opts.model
      if (opts.enable && opts.disable) { fail("pick one of --enable and --disable"); return }
      if (opts.enable) patch.enabled = true
      if (opts.disable) patch.enabled = false

      if (Object.keys(patch).length > 0 || opts.schedule !== undefined) {
        const { mutateAgentxConfig } = await import("@/daemon/config-mutate")
        const cli = process.argv[1] || "dist/cli.js"
        const { summary } = mutateAgentxConfig((cfg) => {
          const said: string[] = []
          if (Object.keys(patch).length > 0) said.push(patchWikiEnrich(cfg, patch))
          if (opts.schedule !== undefined) said.push(patchEnrichCron(cfg, String(opts.schedule), cli, opts.timezone))
          return said.join("; ")
        })
        console.log(chalk.green(`  ${summary}`))
      }
      const file = resolve(process.cwd(), "agentx.json")
      if (!existsSync(file)) { fail(`agentx.json not found at ${file}`); return }
      const raw = JSON.parse(readFileSync(file, "utf-8"))
      const view = wikiEnrichSettings(raw?.wikiEnrich)
      const cron = raw?.crons?.[ENRICH_CRON_ID]
      if (opts.json) { console.log(JSON.stringify({ ...view, schedule: cron ? { id: ENRICH_CRON_ID, schedule: cron.schedule, timezone: cron.timezone, enabled: cron.enabled !== false } : null }, null, 2)); return }
      console.log(`  wiki enrichment: ${view.enabled ? chalk.green("on") : chalk.dim("off")}`)
      console.log(`  agent: ${view.agent || chalk.dim("not set")}`)
      console.log(`  page types: ${view.types.join(", ")}`)
      console.log(`  sources: ${view.sources.length ? view.sources.join(", ") : chalk.dim("none")}`)
      console.log(`  most pages per run: ${view.maxPages}`)
      console.log(`  spending cap per run: ${view.maxSpendUsd > 0 ? `$${view.maxSpendUsd}` : "none"}`)
      console.log(`  most messages per page: ${view.maxEntriesPerPage}`)
      console.log(`  most new event pages per page: ${view.maxNewEvents}`)
      console.log(`  model: ${view.model || chalk.dim("the agent's own")}`)
      console.log(`  schedule: ${cron ? `${ENRICH_CRON_ID} · ${cron.schedule} (${cron.timezone ?? "UTC"})${cron.enabled === false ? " · paused" : ""}` : chalk.dim("none")}`)
    }))
}
