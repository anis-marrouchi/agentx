import { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"
import { existsSync } from "fs"
import { openDb } from "@/storage/sqlite"

// --- agentx db ---
//
// Read-only CLI for exploring the operational SQLite at .agentx/db.sqlite
// (built by the Move 2 storage layer). Named queries for the data the
// daemon's bus subscribers persist. The escape hatch `agentx db query`
// runs raw SQL for anything not exposed as a named subcommand.
//
// Defaults to human-readable column output; `--json` emits a JSON array
// per row (one row per object) for piping into jq / dashboards.

export const db = new Command()
  .name("db")
  .description("explore the operational SQLite store at .agentx/db.sqlite")

function openReadOnly(cwd: string) {
  const path = resolve(cwd, ".agentx/db.sqlite")
  if (!existsSync(path)) {
    console.log(chalk.red(`  No SQLite at ${path}`))
    console.log(chalk.dim(`  Make sure the daemon has started since Move 2 shipped — the file is created on first boot.`))
    process.exit(1)
  }
  const handle = openDb({ path })
  if (!handle) {
    console.log(chalk.red(`  Could not open ${path}`))
    console.log(chalk.dim(`  If you see "NODE_MODULE_VERSION mismatch", run \`pnpm rebuild better-sqlite3\` under the daemon's Node version.`))
    process.exit(1)
  }
  return handle
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
  // Column rendering: compute widths + print a header / separator / rows.
  const cols = Object.keys(rows[0])
  const widths = cols.map(c =>
    Math.max(c.length, ...rows.map(r => String(r[c] ?? "").length))
  )
  const fmt = (cells: any[]) =>
    cells.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ")
  console.log(fmt(cols))
  console.log(cols.map((_, i) => "-".repeat(widths[i])).join("  "))
  for (const row of rows) console.log(fmt(cols.map(c => row[c])))
}

// --- db tasks ---

db
  .command("tasks")
  .description("recent task_history rows (one per agent task)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("-a, --agent <id>", "filter by agent id")
  .option("-d, --day <YYYY-MM-DD>", "filter by start day (UTC)")
  .option("-s, --status <status>", "ok | error")
  .option("-n, --limit <n>", "max rows", "20")
  .option("--json", "emit JSON")
  .action((opts) => {
    const handle = openReadOnly(resolve(opts.cwd))
    const where: string[] = []
    const params: Record<string, any> = {}
    if (opts.agent) { where.push("agent_id = @agent"); params.agent = opts.agent }
    if (opts.day) { where.push("started_at LIKE @day"); params.day = `${opts.day}%` }
    if (opts.status) { where.push("status = @status"); params.status = opts.status }
    const sql = `
      SELECT agent_id, channel, status, duration_ms,
             input_tokens, output_tokens,
             substr(message_preview, 1, 60) AS message,
             started_at
      FROM task_history
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY started_at DESC
      LIMIT @limit
    `
    const rows = handle.prepare(sql).all({ ...params, limit: Number(opts.limit) })
    emit(rows, !!opts.json)
  })

// --- db rotations ---

db
  .command("rotations")
  .description("session rotation events (stale | tier-2 | max-turns)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("-a, --agent <id>", "filter by agent id")
  .option("-r, --reason <r>", "stale | tier-2 | max-turns")
  .option("-n, --limit <n>", "max rows", "20")
  .option("--summary", "group by agent + reason")
  .option("--json", "emit JSON")
  .action((opts) => {
    const handle = openReadOnly(resolve(opts.cwd))
    const where: string[] = []
    const params: Record<string, any> = {}
    if (opts.agent) { where.push("agent_id = @agent"); params.agent = opts.agent }
    if (opts.reason) { where.push("reason = @reason"); params.reason = opts.reason }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : ""
    const sql = opts.summary
      ? `
        SELECT agent_id, reason, COUNT(*) AS n,
               ROUND(AVG(last_turn_input_tokens)) AS avg_input_tokens,
               MAX(last_turn_input_tokens) AS max_input_tokens
        FROM rotations
        ${whereSql}
        GROUP BY agent_id, reason
        ORDER BY n DESC
      `
      : `
        SELECT agent_id, channel, reason, last_turn_input_tokens, rotated_at
        FROM rotations
        ${whereSql}
        ORDER BY rotated_at DESC
        LIMIT @limit
      `
    const rows = handle.prepare(sql).all({ ...params, limit: Number(opts.limit) })
    emit(rows, !!opts.json)
  })

// --- db usage ---

db
  .command("usage")
  .description("token usage rolled up per (agent, model, day)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("-a, --agent <id>", "filter by agent id")
  .option("-d, --day <YYYY-MM-DD>", "filter by day (UTC)")
  .option("--json", "emit JSON")
  .action((opts) => {
    const handle = openReadOnly(resolve(opts.cwd))
    const where: string[] = []
    const params: Record<string, any> = {}
    if (opts.agent) { where.push("agent_id = @agent"); params.agent = opts.agent }
    if (opts.day) { where.push("day = @day"); params.day = opts.day }
    const sql = `
      SELECT day, agent_id, model, tasks,
             input_tokens AS in_tok, output_tokens AS out_tok,
             cache_read_tokens AS cache_read, cache_create_tokens AS cache_create
      FROM usage_daily
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY day DESC, agent_id
    `
    const rows = handle.prepare(sql).all(params)
    emit(rows, !!opts.json)
  })

// --- db routes ---

db
  .command("routes")
  .description("inbound routing decisions captured by the pipeline trace")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("-c, --channel <ch>", "filter by channel (telegram, gitlab, github, ...)")
  .option("-k, --kind <k>", "match | drop")
  .option("-n, --limit <n>", "max rows", "20")
  .option("--summary", "group by channel + kind + deciding stage")
  .option("--json", "emit JSON")
  .action((opts) => {
    const handle = openReadOnly(resolve(opts.cwd))
    const where: string[] = []
    const params: Record<string, any> = {}
    if (opts.channel) { where.push("channel = @channel"); params.channel = opts.channel }
    if (opts.kind) { where.push("kind = @kind"); params.kind = opts.kind }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : ""
    const sql = opts.summary
      ? `
        SELECT channel, kind, deciding_stage, COUNT(*) AS n
        FROM route_traces
        ${whereSql}
        GROUP BY channel, kind, deciding_stage
        ORDER BY n DESC
      `
      : `
        SELECT channel, chat_id, kind, deciding_stage, agent_id,
               substr(reason, 1, 60) AS reason, at
        FROM route_traces
        ${whereSql}
        ORDER BY at DESC
        LIMIT @limit
      `
    const rows = handle.prepare(sql).all({ ...params, limit: Number(opts.limit) })
    emit(rows, !!opts.json)
  })

// --- db errors ---

db
  .command("errors")
  .description("failed tasks (status='error') with their error message")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("-a, --agent <id>", "filter by agent id")
  .option("-n, --limit <n>", "max rows", "20")
  .option("--json", "emit JSON")
  .action((opts) => {
    const handle = openReadOnly(resolve(opts.cwd))
    const where: string[] = ["status = 'error'"]
    const params: Record<string, any> = {}
    if (opts.agent) { where.push("agent_id = @agent"); params.agent = opts.agent }
    const sql = `
      SELECT agent_id, channel, duration_ms,
             substr(error, 1, 120) AS error,
             started_at
      FROM task_history
      WHERE ${where.join(" AND ")}
      ORDER BY started_at DESC
      LIMIT @limit
    `
    const rows = handle.prepare(sql).all({ ...params, limit: Number(opts.limit) })
    emit(rows, !!opts.json)
  })

// --- db tables / schema ---

db
  .command("tables")
  .description("list tables + row counts")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--json", "emit JSON")
  .action((opts) => {
    const handle = openReadOnly(resolve(opts.cwd))
    const tables = handle
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
    const rows = tables.map(t => ({
      table: t.name,
      rows: (handle.prepare(`SELECT COUNT(*) AS c FROM ${t.name}`).get() as { c: number }).c,
    }))
    emit(rows, !!opts.json)
  })

// --- db query ---

db
  .command("query <sql>")
  .description("run an arbitrary read-only SQL query (escape hatch)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--json", "emit JSON")
  .action((sql, opts) => {
    const handle = openReadOnly(resolve(opts.cwd))
    // Best-effort guard against accidental writes — read-only flag isn't on
    // (we share the daemon's open() helper). Reject the obvious DDL/DML.
    if (/^\s*(insert|update|delete|drop|alter|create|attach|vacuum|pragma)\b/i.test(sql)) {
      console.log(chalk.red("  Refusing to run a write/DDL statement via `agentx db query`."))
      console.log(chalk.dim("  Use `sqlite3 .agentx/db.sqlite` directly if you really mean it."))
      process.exit(2)
    }
    try {
      const rows = handle.prepare(sql).all()
      emit(rows, !!opts.json)
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })
