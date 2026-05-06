// One-shot migration to fix model attribution on `usage_daily`.
//
// Why: until commit ecaf499, attachSqliteSubscribers wrote a daemon-wide
// constant (default "claude-opus-4-7") into usage_daily.model regardless
// of which model actually billed. Codex-cli (gpt-5.5) and SDK agents on
// non-Claude providers ended up tagged as Opus and priced as Opus on
// /admin/cost — inflating the spend figure significantly.
//
// What this does: rewrites historical rows where model='claude-opus-4-7'
// for agents whose CURRENT tier in agentx.json is codex-cli. That's the
// only case we're confident about retroactively — codex-cli always routes
// through OpenAI, never Anthropic. SDK / claude-code agents are left as
// opus-tagged because we can't tell from current config whether past rows
// were opus, sonnet, or haiku.
//
// Run with:
//   pnpm tsx scripts/migrate-cost-attribution.ts                  # dry-run
//   pnpm tsx scripts/migrate-cost-attribution.ts --commit         # write
//   pnpm tsx scripts/migrate-cost-attribution.ts --cwd /path/to   # alt root

import { resolve } from "path"
import { existsSync, readFileSync } from "fs"
import Database from "better-sqlite3"

interface Args {
  cwd: string
  db?: string
  commit: boolean
  since: string
}

// Default since-date: 2026-05-04, the day commit be3f695 added the
// codex-cli engine. Before that, no agent could've been routed through
// codex; any opus-tagged rows were genuine Anthropic spend and must NOT
// be retagged.
const DEFAULT_SINCE = "2026-05-04"

function parseArgs(argv: string[]): Args {
  const out: Args = { cwd: process.cwd(), commit: false, since: DEFAULT_SINCE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--commit") out.commit = true
    else if (a === "--cwd") out.cwd = resolve(argv[++i] || "")
    else if (a === "--db") out.db = argv[++i]
    else if (a === "--since") out.since = argv[++i] || DEFAULT_SINCE
    else if (a === "--help" || a === "-h") {
      console.log("usage: migrate-cost-attribution [--commit] [--cwd <dir>] [--db <path>] [--since YYYY-MM-DD]")
      console.log(`  --since defaults to ${DEFAULT_SINCE} (the day codex-cli engine shipped)`)
      process.exit(0)
    }
  }
  return out
}

interface AgentConf {
  tier?: string
  model?: string
  provider?: string
}

function readAgents(cwd: string): Record<string, AgentConf> {
  const p = resolve(cwd, "agentx.json")
  if (!existsSync(p)) {
    console.error(`  agentx.json not found at ${p}`)
    process.exit(1)
  }
  const cfg = JSON.parse(readFileSync(p, "utf8"))
  return cfg.agents || {}
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.db ? resolve(args.cwd, args.db) : resolve(args.cwd, ".agentx/db.sqlite")
  if (!existsSync(dbPath)) {
    console.error(`  db not found at ${dbPath}`)
    process.exit(1)
  }

  const agents = readAgents(args.cwd)

  // Pick out agents we're CERTAIN should be retagged. codex-cli always
  // routes to OpenAI, so any usage_daily row tagged "claude-opus-4-7"
  // for those agents is the bug we're fixing. SDK + claude-code stay as
  // they are — we can't tell historical model from current config.
  const targets: Array<{ agentId: string; targetModel: string; tier: string }> = []
  for (const [aid, conf] of Object.entries(agents)) {
    if (conf.tier === "codex-cli" && conf.model) {
      targets.push({ agentId: aid, targetModel: conf.model, tier: conf.tier })
    }
  }

  if (targets.length === 0) {
    console.log("  no codex-cli agents in agentx.json — nothing to retag")
    return
  }

  console.log()
  console.log(`  ${args.commit ? "MIGRATING" : "DRY-RUN"}: ${dbPath}`)
  console.log(`  scope: rows on/after ${args.since}`)
  console.log(`  agents to retag (tier=codex-cli):`)
  for (const t of targets) console.log(`    ${t.agentId.padEnd(28)} → ${t.targetModel}`)
  console.log()

  const db = new Database(dbPath, { readonly: !args.commit })

  // For each target agent, find every usage_daily row stamped opus and
  // either UPDATE its model in place, OR (when a row with the target
  // model already exists for the same day) merge token sums into the
  // existing row and drop the source.
  let updates = 0
  let merges = 0
  let totalTier1Reattributed = 0
  let totalTier2Reattributed = 0

  const findRows = db.prepare(`
    SELECT day, agent_id, model, tasks,
           input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
           tier2_input_tokens, tier2_output_tokens, tier2_cache_read_tokens, tier2_cache_create_tokens
    FROM usage_daily
    WHERE agent_id = ? AND model = 'claude-opus-4-7' AND day >= ?
    ORDER BY day
  `)
  const findCollision = db.prepare(`
    SELECT 1 FROM usage_daily WHERE agent_id = ? AND model = ? AND day = ?
  `)
  const update = args.commit ? db.prepare(`
    UPDATE usage_daily SET model = @new WHERE agent_id = @agent AND model = @old AND day = @day
  `) : null
  const mergeInto = args.commit ? db.prepare(`
    UPDATE usage_daily
    SET tasks = tasks + @tasks,
        input_tokens = input_tokens + @i,
        output_tokens = output_tokens + @o,
        cache_read_tokens = cache_read_tokens + @cr,
        cache_create_tokens = cache_create_tokens + @cw,
        tier2_input_tokens = tier2_input_tokens + @t2i,
        tier2_output_tokens = tier2_output_tokens + @t2o,
        tier2_cache_read_tokens = tier2_cache_read_tokens + @t2cr,
        tier2_cache_create_tokens = tier2_cache_create_tokens + @t2cw
    WHERE agent_id = @agent AND model = @new AND day = @day
  `) : null
  const drop = args.commit ? db.prepare(`
    DELETE FROM usage_daily WHERE agent_id = @agent AND model = 'claude-opus-4-7' AND day = @day
  `) : null

  const txn = args.commit ? db.transaction((target: { agentId: string; targetModel: string }) => {
    const rows = findRows.all(target.agentId, args.since) as Array<{
      day: string; agent_id: string; model: string; tasks: number;
      input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_create_tokens: number;
      tier2_input_tokens: number; tier2_output_tokens: number; tier2_cache_read_tokens: number; tier2_cache_create_tokens: number;
    }>
    for (const r of rows) {
      const collides = findCollision.get(target.agentId, target.targetModel, r.day)
      if (collides) {
        mergeInto!.run({
          agent: target.agentId, new: target.targetModel, day: r.day,
          tasks: r.tasks,
          i: r.input_tokens, o: r.output_tokens, cr: r.cache_read_tokens, cw: r.cache_create_tokens,
          t2i: r.tier2_input_tokens, t2o: r.tier2_output_tokens, t2cr: r.tier2_cache_read_tokens, t2cw: r.tier2_cache_create_tokens,
        })
        drop!.run({ agent: target.agentId, day: r.day })
        merges++
      } else {
        update!.run({ agent: target.agentId, old: "claude-opus-4-7", new: target.targetModel, day: r.day })
        updates++
      }
      totalTier1Reattributed += (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_create_tokens || 0)
      totalTier2Reattributed += (r.tier2_input_tokens || 0) + (r.tier2_output_tokens || 0) + (r.tier2_cache_read_tokens || 0) + (r.tier2_cache_create_tokens || 0)
    }
  }) : null

  for (const t of targets) {
    const rows = findRows.all(t.agentId, args.since) as Array<{
      day: string; tasks: number;
      input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_create_tokens: number;
      tier2_input_tokens: number; tier2_output_tokens: number; tier2_cache_read_tokens: number; tier2_cache_create_tokens: number;
    }>
    if (rows.length === 0) continue
    console.log(`  ${t.agentId} → ${t.targetModel}  (${rows.length} day${rows.length === 1 ? "" : "s"})`)
    for (const r of rows) {
      const total = (r.input_tokens || 0) + (r.tier2_input_tokens || 0)
      console.log(`    ${r.day}  tasks=${String(r.tasks).padStart(4)}  raw_in=${total.toLocaleString().padStart(13)}`)
    }
    if (args.commit) txn!(t)
  }

  if (args.commit) {
    console.log()
    console.log(`  done. ${updates} row${updates === 1 ? "" : "s"} retagged in place, ${merges} merged into existing rows`)
    console.log(`        tier1 tokens reattributed: ${totalTier1Reattributed.toLocaleString()}`)
    console.log(`        tier2 tokens reattributed: ${totalTier2Reattributed.toLocaleString()}`)
  } else {
    console.log()
    console.log(`  dry-run only. Pass --commit to write.`)
  }
  db.close()
}

main()
