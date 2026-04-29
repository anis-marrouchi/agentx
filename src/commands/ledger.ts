import { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"
import { existsSync } from "fs"
import Database from "better-sqlite3"

// --- agentx ledger ---
//
// Read-only triage CLI for the intent ledger at .agentx/intent/ledger.sqlite,
// the canonical record of every dispatch decision (Phase 1 of the
// architectural rescue, see docs/architecture/research-rescue-plan.md).
//
// Built for the 1b shadow-mode soak: an operator runs these commands
// against a freshly-rsync'd copy of the ledger to inspect divergences,
// in-flight dispatches, and source-by-source activity. The CLI does not
// modify the ledger — opens read-only.
//
// Use `--path` to point at an alternate ledger (e.g., one rsync'd
// locally from clawd-server). Default is .agentx/intent/ledger.sqlite
// in the cwd.

export const ledger = new Command()
  .name("ledger")
  .description("inspect the intent ledger (.agentx/intent/ledger.sqlite)")

interface OpenOpts {
  cwd?: string
  path?: string
}

function openReadOnly(opts: OpenOpts) {
  const root = resolve(opts.cwd ?? process.cwd())
  const path = resolve(root, opts.path ?? ".agentx/intent/ledger.sqlite")
  if (!existsSync(path)) {
    console.log(chalk.red(`  No ledger at ${path}`))
    console.log(chalk.dim(`  Make sure the daemon has run with INTENT_LEDGER_MODE != "off". The file is created on first ledger write.`))
    process.exit(1)
  }
  try {
    return new Database(path, { readonly: true })
  } catch (e: any) {
    console.log(chalk.red(`  Could not open ${path}: ${e.message}`))
    if (/NODE_MODULE_VERSION/.test(e.message)) {
      console.log(chalk.dim(`  Run \`pnpm rebuild better-sqlite3\` under the daemon's Node version.`))
    }
    process.exit(1)
  }
}

function emit(rows: any[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log(chalk.dim("  (no rows)"))
    return
  }
  const cols = Object.keys(rows[0])
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  )
  const fmt = (cells: any[]) =>
    cells.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ")
  console.log(fmt(cols))
  console.log(cols.map((_, i) => "-".repeat(widths[i])).join("  "))
  for (const row of rows) console.log(fmt(cols.map((c) => row[c])))
}

/** Convert a duration string ("1h", "30m", "7d") to milliseconds.
 *  Returns null if unparseable. */
function durationToMs(input: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(input.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3600_000 : 86_400_000
  return n * factor
}

function parseSince(input: string | undefined): number | undefined {
  if (!input) return undefined
  const ms = durationToMs(input)
  if (ms === null) {
    // Maybe an absolute ms epoch
    const n = Number(input)
    if (Number.isFinite(n) && n > 0) return n
    console.log(chalk.red(`  Invalid --since "${input}". Use a duration like "1h", "30m", "7d", or an ms epoch.`))
    process.exit(1)
  }
  return Date.now() - ms
}

// ---------------------------------------------------------------------------
// agentx ledger stats
// ---------------------------------------------------------------------------

ledger
  .command("stats")
  .description("overview: events by source, decisions, divergences, in-flight count")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--path <path>", "ledger path relative to cwd", ".agentx/intent/ledger.sqlite")
  .option("--since <duration>", "limit to events newer than (e.g. 1h, 24h, 7d)")
  .option("--json", "emit JSON")
  .action((opts) => {
    const db = openReadOnly(opts)
    const since = parseSince(opts.since)
    const sinceClause = since !== undefined ? "WHERE ts >= @since" : ""
    const sinceClauseDecisions = since !== undefined ? "WHERE decided_at >= @since" : ""
    const sinceClauseDivergences = sinceClause

    const eventsBySource = db
      .prepare(`SELECT source, COUNT(*) as n FROM intent_events ${sinceClause} GROUP BY source ORDER BY n DESC`)
      .all({ since })
    const totalDecisions = (db
      .prepare(`SELECT COUNT(*) as n FROM intent_decisions ${sinceClauseDecisions}`)
      .get({ since }) as { n: number }).n
    const decisionsByOutcome = db
      .prepare(`SELECT outcome, COUNT(*) as n FROM intent_decisions ${sinceClauseDecisions} GROUP BY outcome ORDER BY n DESC`)
      .all({ since })
    const totalDivergences = (db
      .prepare(`SELECT COUNT(*) as n FROM intent_divergences ${sinceClauseDivergences}`)
      .get({ since }) as { n: number }).n
    const divergencesBySource = db
      .prepare(`SELECT source, COUNT(*) as n FROM intent_divergences ${sinceClauseDivergences} GROUP BY source ORDER BY n DESC`)
      .all({ since })
    const inFlight = (db
      .prepare(`
        SELECT COUNT(*) as n FROM intent_decisions d
        LEFT JOIN intent_resolutions r
          ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
        WHERE d.outcome = 'dispatched' AND r.decision_event_id IS NULL
      `)
      .get() as { n: number }).n

    if (opts.json) {
      console.log(JSON.stringify({
        since: since ?? null,
        eventsBySource, totalDecisions, decisionsByOutcome,
        totalDivergences, divergencesBySource, inFlight,
      }, null, 2))
      return
    }

    console.log(chalk.bold("Events by source"))
    emit(eventsBySource, false)
    console.log()
    console.log(chalk.bold(`Decisions: ${totalDecisions}`))
    emit(decisionsByOutcome, false)
    console.log()
    console.log(chalk.bold(`Divergences: ${totalDivergences}`))
    emit(divergencesBySource, false)
    console.log()
    console.log(chalk.bold(`In-flight (dispatched, no resolution): ${inFlight}`))
  })

// ---------------------------------------------------------------------------
// agentx ledger divergences
// ---------------------------------------------------------------------------

ledger
  .command("divergences")
  .description("recent divergence rows (newest first)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--path <path>", "ledger path relative to cwd", ".agentx/intent/ledger.sqlite")
  .option("-s, --source <name>", "filter by source (telegram, gitlab, workflow, cron, mesh, github)")
  .option("--since <duration>", "limit to divergences newer than (e.g. 1h, 24h)")
  .option("-n, --limit <n>", "max rows", "50")
  .option("--json", "emit JSON")
  .action((opts) => {
    const db = openReadOnly(opts)
    const since = parseSince(opts.since)
    const where: string[] = []
    const params: Record<string, any> = { limit: Number(opts.limit) }
    if (opts.source) { where.push("source = @source"); params.source = opts.source }
    if (since !== undefined) { where.push("ts >= @since"); params.since = since }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
    const rows = db
      .prepare(`
        SELECT
          datetime(ts/1000, 'unixepoch') AS at,
          source,
          decided_by,
          ledger_outcome AS L_outcome,
          COALESCE(ledger_agent_id, '-') AS L_agent,
          legacy_outcome AS X_outcome,
          COALESCE(legacy_agent_id, '-') AS X_agent,
          substr(COALESCE(legacy_reason, ledger_reason, ''), 1, 60) AS reason
        FROM intent_divergences
        ${whereSql}
        ORDER BY ts DESC
        LIMIT @limit
      `)
      .all(params)
    emit(rows, !!opts.json)
  })

// ---------------------------------------------------------------------------
// agentx ledger active
// ---------------------------------------------------------------------------

ledger
  .command("active")
  .description("currently in-flight dispatched decisions (no resolution yet)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--path <path>", "ledger path relative to cwd", ".agentx/intent/ledger.sqlite")
  .option("-s, --source <name>", "filter by source")
  .option("-n, --limit <n>", "max rows", "50")
  .option("--json", "emit JSON")
  .action((opts) => {
    const db = openReadOnly(opts)
    const where: string[] = ["d.outcome = 'dispatched'", "r.decision_event_id IS NULL"]
    const params: Record<string, any> = { limit: Number(opts.limit) }
    if (opts.source) { where.push("e.source = @source"); params.source = opts.source }
    const rows = db
      .prepare(`
        SELECT
          datetime(d.decided_at/1000, 'unixepoch') AS dispatched_at,
          e.source,
          d.decided_by,
          COALESCE(d.agent_id, '-') AS agent,
          COALESCE(e.project, '-') AS project,
          COALESCE(e.subject, '-') AS subject,
          ROUND((strftime('%s', 'now')*1000 - d.decided_at) / 1000.0) AS age_s
        FROM intent_decisions d
        JOIN intent_events e ON e.id = d.event_id
        LEFT JOIN intent_resolutions r
          ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
        WHERE ${where.join(" AND ")}
        ORDER BY d.decided_at DESC
        LIMIT @limit
      `)
      .all(params)
    emit(rows, !!opts.json)
  })

// ---------------------------------------------------------------------------
// agentx ledger events
// ---------------------------------------------------------------------------

ledger
  .command("events")
  .description("recent events (newest first)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--path <path>", "ledger path relative to cwd", ".agentx/intent/ledger.sqlite")
  .option("-s, --source <name>", "filter by source")
  .option("-p, --project <name>", "filter by project")
  .option("--since <duration>", "limit to newer than (e.g. 1h, 24h)")
  .option("-n, --limit <n>", "max rows", "30")
  .option("--json", "emit JSON")
  .action((opts) => {
    const db = openReadOnly(opts)
    const since = parseSince(opts.since)
    const where: string[] = []
    const params: Record<string, any> = { limit: Number(opts.limit) }
    if (opts.source) { where.push("source = @source"); params.source = opts.source }
    if (opts.project) { where.push("project = @project"); params.project = opts.project }
    if (since !== undefined) { where.push("ts >= @since"); params.since = since }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
    const rows = db
      .prepare(`
        SELECT
          datetime(ts/1000, 'unixepoch') AS at,
          source,
          COALESCE(project, '-') AS project,
          COALESCE(subject, '-') AS subject,
          COALESCE(intent, '-') AS intent
        FROM intent_events
        ${whereSql}
        ORDER BY ts DESC
        LIMIT @limit
      `)
      .all(params)
    emit(rows, !!opts.json)
  })
