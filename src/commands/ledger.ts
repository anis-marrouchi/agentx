import { Command } from "commander"
import chalk from "chalk"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { resolve, join } from "path"
import { existsSync } from "fs"
import Database from "better-sqlite3"
import { IntentLedger } from "@/intent/ledger"
import { replay } from "@/intent/replay"
import type { IntentDecision, IntentEvent, IntentResolution } from "@/intent/types"

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

// ---------------------------------------------------------------------------
// agentx ledger lineage
// ---------------------------------------------------------------------------
//
// Walk the (project, subject) correlation for an event and print every
// decision + resolution that landed on the same subject in chronological
// order. Answers "what's the dispatch lineage of this event?" without
// the operator having to write SQL. Foundation for a future in-product
// diff viewer (deferred); the CLI version is the 80/20.

ledger
  .command("lineage <eventOrSubject>")
  .description("walk the dispatch chain on the same (project, subject) and print every decision + resolution")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--path <path>", "ledger path relative to cwd", ".agentx/intent/ledger.sqlite")
  .option("--by-subject", "treat the argument as `<project>:<subject>` instead of an event id")
  .option("--json", "emit JSON")
  .action((eventOrSubject: string, opts) => {
    const db = openReadOnly(opts)

    let project: string | null = null
    let subject: string | null = null

    if (opts.bySubject) {
      const idx = eventOrSubject.indexOf(":")
      if (idx < 0) {
        console.log(chalk.red(`  --by-subject expects "<project>:<subject>"`))
        process.exit(1)
      }
      project = eventOrSubject.slice(0, idx)
      subject = eventOrSubject.slice(idx + 1)
    } else {
      const row = db
        .prepare(`SELECT project, subject FROM intent_events WHERE id = ?`)
        .get(eventOrSubject) as { project: string | null; subject: string | null } | undefined
      if (!row) {
        console.log(chalk.red(`  no event with id ${eventOrSubject}`))
        process.exit(1)
      }
      project = row.project
      subject = row.subject
      if (project === null || subject === null) {
        console.log(chalk.yellow(`  event ${eventOrSubject} has no (project, subject) — lineage requires both`))
        if (project) console.log(chalk.dim(`    project: ${project}`))
        if (subject) console.log(chalk.dim(`    subject: ${subject}`))
        process.exit(1)
      }
    }

    // All events sharing this (project, subject), ordered by ts.
    const events = db
      .prepare(
        `SELECT id, ts, source, COALESCE(intent, '-') AS intent, COALESCE(source_event_id, '-') AS source_event_id
         FROM intent_events WHERE project = ? AND subject = ? ORDER BY ts ASC`,
      )
      .all(project, subject) as Array<{
        id: string; ts: number; source: string; intent: string; source_event_id: string
      }>

    if (events.length === 0) {
      console.log(chalk.dim(`  (no events for ${project}:${subject})`))
      return
    }

    // All decisions + resolutions for those events, grouped by event_id.
    const eventIds = events.map((e) => e.id)
    const placeholders = eventIds.map((_, i) => `@id${i}`).join(", ")
    const params = Object.fromEntries(eventIds.map((id, i) => [`id${i}`, id]))

    const decisions = db
      .prepare(`
        SELECT d.event_id, d.decided_at, d.decided_by, d.agent_id, d.outcome, d.reason,
               r.resolved_at, r.status AS resolution_status, r.duration_ms, r.result_summary
        FROM intent_decisions d
        LEFT JOIN intent_resolutions r
          ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
        WHERE d.event_id IN (${placeholders})
        ORDER BY d.decided_at ASC
      `)
      .all(params) as Array<{
        event_id: string; decided_at: number; decided_by: string; agent_id: string | null;
        outcome: string; reason: string | null;
        resolved_at: number | null; resolution_status: string | null;
        duration_ms: number | null; result_summary: string | null;
      }>

    if (opts.json) {
      const grouped = events.map((e) => ({
        event: e,
        decisions: decisions.filter((d) => d.event_id === e.id),
      }))
      console.log(JSON.stringify({ project, subject, lineage: grouped }, null, 2))
      return
    }

    const distinctAgents = new Set<string>()
    for (const d of decisions) {
      if (d.outcome === "dispatched" && d.agent_id) distinctAgents.add(d.agent_id)
    }

    console.log()
    console.log(chalk.bold(`  Lineage for ${chalk.cyan(project + ":" + subject)}`))
    console.log(chalk.dim(`  ${events.length} event(s), ${decisions.length} decision(s), ${distinctAgents.size} distinct agent(s) dispatched`))
    console.log()

    for (const e of events) {
      const dt = new Date(e.ts).toISOString().slice(0, 19).replace("T", " ")
      console.log(`  ${chalk.dim(dt)} ${chalk.bold(e.id)} ${chalk.dim(`(${e.source}/${e.intent})`)}`)
      const evDecisions = decisions.filter((d) => d.event_id === e.id)
      if (evDecisions.length === 0) {
        console.log(chalk.dim(`           (no decisions yet)`))
        continue
      }
      for (const d of evDecisions) {
        const outcome = d.outcome === "dispatched"
          ? chalk.green(d.outcome)
          : d.outcome === "dropped"
            ? chalk.dim(d.outcome)
            : chalk.yellow(d.outcome)
        const agent = d.agent_id ? chalk.cyan(d.agent_id) : chalk.dim("-")
        const reason = d.reason ? chalk.dim(` — ${d.reason.slice(0, 60)}`) : ""
        console.log(`           ${chalk.dim(d.decided_by)} → ${outcome} ${agent}${reason}`)
        if (d.resolution_status) {
          const status = d.resolution_status === "ok"
            ? chalk.green(d.resolution_status)
            : chalk.red(d.resolution_status)
          const dur = d.duration_ms ? `${(d.duration_ms / 1000).toFixed(1)}s` : "-"
          console.log(`             ${chalk.dim("resolved")} ${status} ${chalk.dim(dur)}`)
        } else if (d.outcome === "dispatched") {
          console.log(`             ${chalk.yellow("(in-flight, no resolution)")}`)
        }
      }
    }
    console.log()
  })

// ---------------------------------------------------------------------------
// agentx ledger replay
// ---------------------------------------------------------------------------
//
// Reads (events, decisions, resolutions) from the source ledger and
// replays them onto a fresh tmp ledger via src/intent/replay.ts.
// Reports any divergences. The Phase 7 regression test in CLI form.
//
// Usage:
//   agentx ledger replay                              # all rows
//   agentx ledger replay --since 24h                  # last 24h only
//   agentx ledger replay --source gitlab              # one source only
//   agentx ledger replay --path /tmp/clawd-ledger/ledger.sqlite

ledger
  .command("replay")
  .description("replay the source ledger onto a fresh tmp ledger; report divergences")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--path <path>", "ledger path relative to cwd", ".agentx/intent/ledger.sqlite")
  .option("--since <duration>", "limit to events newer than (e.g. 1h, 24h, 7d)")
  .option("-s, --source <name>", "filter to one source")
  .option("-n, --limit <n>", "max events to replay (defaults to all)")
  .option("--json", "emit JSON")
  .action((opts) => {
    const sourceDb = openReadOnly(opts)
    const since = parseSince(opts.since)

    // Pull events from the source ledger as IntentEvent[].
    const eventWhere: string[] = []
    const eventParams: Record<string, any> = {}
    if (opts.source) { eventWhere.push("source = @source"); eventParams.source = opts.source }
    if (since !== undefined) { eventWhere.push("ts >= @since"); eventParams.since = since }
    const eventLimit = opts.limit ? `LIMIT ${Number(opts.limit)}` : ""
    const events: IntentEvent[] = (sourceDb
      .prepare(`
        SELECT id, ts, source, source_event_id, project, subject, intent, raw_json
        FROM intent_events
        ${eventWhere.length ? "WHERE " + eventWhere.join(" AND ") : ""}
        ORDER BY ts ASC
        ${eventLimit}
      `)
      .all(eventParams) as Array<any>)
      .map((r) => ({
        id: r.id, ts: r.ts, source: r.source,
        sourceEventId: r.source_event_id, project: r.project, subject: r.subject,
        intent: r.intent, rawJson: r.raw_json,
      }))

    // Pull decisions + resolutions for those events. Joining by event id
    // keeps the snapshot internally consistent — no orphan rows.
    if (events.length === 0) {
      console.log(chalk.dim("  (no events match filter)"))
      return
    }
    const eventIds = new Set(events.map((e) => e.id))
    const placeholders = events.map((_, i) => `@id${i}`).join(", ")
    const eventIdParams: Record<string, any> = Object.fromEntries(
      events.map((e, i) => [`id${i}`, e.id]),
    )

    const decisions: IntentDecision[] = (sourceDb
      .prepare(`
        SELECT event_id, decided_at, decided_by, agent_id, outcome, reason
        FROM intent_decisions
        WHERE event_id IN (${placeholders})
      `)
      .all(eventIdParams) as Array<any>)
      .map((r) => ({
        eventId: r.event_id, decidedAt: r.decided_at, decidedBy: r.decided_by,
        agentId: r.agent_id, outcome: r.outcome, reason: r.reason,
      }))

    const resolutions: IntentResolution[] = (sourceDb
      .prepare(`
        SELECT decision_event_id, decision_decided_by, resolved_at, status, duration_ms, result_summary
        FROM intent_resolutions
        WHERE decision_event_id IN (${placeholders})
      `)
      .all(eventIdParams) as Array<any>)
      .map((r) => ({
        decisionEventId: r.decision_event_id, decisionDecidedBy: r.decision_decided_by,
        resolvedAt: r.resolved_at, status: r.status,
        durationMs: r.duration_ms, resultSummary: r.result_summary,
      }))

    void eventIds // for clarity; not used directly

    // Open a fresh tmp ledger and run the replay.
    const tmpDir = mkdtempSync(join(tmpdir(), "agentx-ledger-replay-"))
    const target = new IntentLedger({ path: join(tmpDir, "target.sqlite") })
    try {
      const result = replay(target, events, decisions, resolutions)

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      console.log(chalk.bold(`Replayed ${result.eventsCount} events, ${result.decisionsCount} decisions, ${resolutions.length} resolutions`))
      if (result.divergences.length === 0) {
        console.log(chalk.green(`  ✓ 0 divergences — ledger mechanics are deterministic on this snapshot`))
      } else {
        console.log(chalk.red(`  ✗ ${result.divergences.length} divergences`))
        emit(
          result.divergences.map((d) => ({
            event_id: d.eventId,
            decided_by: d.decidedBy,
            recorded: `${d.expected.outcome}/${d.expected.agentId ?? "-"}`,
            replayed: `${d.actual.outcome}/${d.actual.agentId ?? "-"}`,
            reason: d.reason.slice(0, 80),
          })),
          false,
        )
      }
    } finally {
      target.close()
    }
  })
