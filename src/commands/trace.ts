import { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"
import { existsSync } from "fs"
import Database from "better-sqlite3"
import { getTrace, listTraces, type TraceRecord, type TraceStepRecord } from "@/storage/traces"

// --- agentx trace ---
//
// Read-only triage CLI for the per-task execution traces persisted at
// .agentx/db.sqlite (improvement plan #2). Pairs with the
// HTTP endpoints (GET /traces, GET /traces/:taskId) — same store, two
// access surfaces. Operators in a hurry tail this; dashboard consumers
// hit the HTTP routes.
//
// Use `--path` to point at an alternate db (e.g., one rsync'd from
// a remote daemon). Default is .agentx/db.sqlite in the cwd.

export const trace = new Command()
  .name("trace")
  .description("inspect per-task execution traces (.agentx/db.sqlite)")

interface OpenOpts {
  cwd?: string
  path?: string
}

function openReadOnly(opts: OpenOpts) {
  const root = resolve(opts.cwd ?? process.cwd())
  const path = resolve(root, opts.path ?? ".agentx/db.sqlite")
  if (!existsSync(path)) {
    console.log(chalk.red(`  No db at ${path}`))
    console.log(chalk.dim(`  The file is created on first SQLite write — start the daemon and run a task.`))
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
    const n = Number(input)
    if (Number.isFinite(n) && n > 0) return n
    console.log(chalk.red(`  Invalid --since "${input}". Use "1h", "30m", "7d", or an ms epoch.`))
    process.exit(1)
  }
  return Date.now() - ms!
}

function fmtAge(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function statusColor(s: string): (text: string) => string {
  if (s === "ok") return chalk.green
  if (s === "error" || s === "timeout") return chalk.red
  if (s === "in-flight") return chalk.yellow
  return chalk.dim
}

// ---------------------------------------------------------------------------
// agentx trace list
// ---------------------------------------------------------------------------

trace
  .command("list")
  .description("list recent traces (newest first)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--path <path>", "db path relative to cwd", ".agentx/db.sqlite")
  .option("--agent <id>", "filter by agentId")
  .option("--channel <name>", "filter by channel (telegram|whatsapp|gitlab|...)")
  .option("--chat <id>", "filter by chatId")
  .option("--workflow <runId>", "filter by workflowRunId")
  .option("--status <s>", "filter by status (in-flight|ok|error|timeout)")
  .option("--since <duration>", "limit to traces newer than (e.g. 1h, 24h, 7d)")
  .option("--limit <n>", "max rows", "50")
  .option("--json", "emit JSON")
  .action((opts) => {
    const db = openReadOnly(opts)
    const traces = listTraces(db, {
      agentId: opts.agent,
      channel: opts.channel,
      chatId: opts.chat,
      workflowRunId: opts.workflow,
      status: opts.status,
      since: parseSince(opts.since),
      limit: parseInt(opts.limit, 10) || 50,
    })

    if (opts.json) {
      console.log(JSON.stringify(traces, null, 2))
      return
    }
    if (traces.length === 0) {
      console.log(chalk.dim("  (no traces)"))
      return
    }

    for (const t of traces) {
      const status = statusColor(t.status)(t.status.padEnd(9))
      const dur = t.durationMs != null ? `${(t.durationMs / 1000).toFixed(2)}s` : "—"
      const wf = t.workflowRunId ? chalk.cyan(` wf=${t.workflowRunId}`) : ""
      const tokens = t.inputTokens != null
        ? chalk.dim(` ${t.inputTokens}/${t.outputTokens ?? 0} tok`)
        : ""
      console.log(
        `${chalk.dim(t.taskId)} ${status} ${chalk.bold(t.agentId)}` +
        `${chalk.dim(` ${t.channel ?? "—"}:${t.chatId ?? "—"}`)}${wf}` +
        ` ${chalk.dim("·")} ${dur}${tokens} ${chalk.dim(fmtAge(t.startedAt))}`,
      )
      if (t.error) console.log(`    ${chalk.red("error:")} ${t.error}`)
    }
  })

// ---------------------------------------------------------------------------
// agentx trace show <taskId>
// ---------------------------------------------------------------------------

trace
  .command("show <taskId>")
  .description("show one trace with its full ordered step log")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--path <path>", "db path relative to cwd", ".agentx/db.sqlite")
  .option("--json", "emit JSON")
  .action((taskId: string, opts) => {
    const db = openReadOnly(opts)
    const rec = getTrace(db, taskId)
    if (!rec) {
      console.log(chalk.red(`  No trace at ${taskId}`))
      process.exit(1)
    }
    if (opts.json) {
      console.log(JSON.stringify(rec, null, 2))
      return
    }
    printTrace(rec.task, rec.steps)
  })

function printTrace(t: TraceRecord, steps: TraceStepRecord[]): void {
  const status = statusColor(t.status)(t.status)
  console.log(chalk.bold(`Trace ${t.taskId}`))
  console.log(`  ${chalk.dim("agent")}    ${t.agentId}`)
  console.log(`  ${chalk.dim("channel")}  ${t.channel ?? "—"}:${t.chatId ?? "—"}`)
  if (t.workflowRunId) {
    const wfPart = [t.workflowId, t.workflowNodeId].filter(Boolean).join("/")
    console.log(`  ${chalk.dim("workflow")} ${chalk.cyan(t.workflowRunId)}${wfPart ? chalk.dim(` (${wfPart})`) : ""}`)
  }
  if (t.intentEventId) {
    console.log(`  ${chalk.dim("intent")}   ${t.intentEventId} ${chalk.dim(`(${t.intentDecidedBy ?? "?"})`)}`)
  }
  if (t.model) console.log(`  ${chalk.dim("model")}    ${t.model}`)
  if (t.resumeSessionId) console.log(`  ${chalk.dim("resume")}   ${t.resumeSessionId.slice(0, 12)}…`)
  if (t.finalSessionId) console.log(`  ${chalk.dim("final")}    ${t.finalSessionId.slice(0, 12)}…`)
  console.log(`  ${chalk.dim("status")}   ${status}`)
  if (t.durationMs != null) {
    console.log(`  ${chalk.dim("duration")} ${(t.durationMs / 1000).toFixed(2)}s`)
  }
  if (t.inputTokens != null || t.outputTokens != null) {
    console.log(`  ${chalk.dim("tokens")}   in=${t.inputTokens ?? 0} out=${t.outputTokens ?? 0} ` +
      `cache_read=${t.cacheReadTokens ?? 0} cache_create=${t.cacheCreateTokens ?? 0}`)
  }
  if (t.error) console.log(`  ${chalk.red("error")}    ${t.error}`)
  if (t.messagePreview) console.log(`  ${chalk.dim("message")}  ${t.messagePreview}`)
  console.log()

  if (steps.length === 0) {
    console.log(chalk.dim(`  (no recorded steps — task may have been on a non-streaming tier or completed before any tool call)`))
    return
  }
  console.log(chalk.bold(`Steps (${steps.length}):`))
  for (const s of steps) {
    const stepStatus = s.status ? statusColor(s.status)(s.status) : chalk.dim("—")
    const action = s.action ? chalk.cyan(s.action) : ""
    console.log(`  ${chalk.dim(`#${s.seq}`)} ${chalk.bold(s.name)}${action ? " " + action : ""} ${stepStatus}` +
      `${s.ms != null ? chalk.dim(` ${s.ms}ms`) : ""}`)
    if (s.inputSummary) {
      const lines = s.inputSummary.split("\n").slice(0, 8)
      console.log(lines.map((l) => `      ${chalk.dim("→")} ${l}`).join("\n"))
      if (s.inputSummary.split("\n").length > 8) console.log(`      ${chalk.dim("…")}`)
    }
    if (s.outputSummary) {
      const lines = s.outputSummary.split("\n").slice(0, 8)
      console.log(lines.map((l) => `      ${chalk.dim("←")} ${l}`).join("\n"))
      if (s.outputSummary.split("\n").length > 8) console.log(`      ${chalk.dim("…")}`)
    }
    if (s.error) console.log(`      ${chalk.red("error:")} ${s.error}`)
  }
}
