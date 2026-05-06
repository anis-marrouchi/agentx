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

// --- agentx trace replay <taskId> [--diff] ----------------------------------
//
// Handoff item #11. Loads a recorded task by id, re-fires it via the daemon's
// POST /task with the same agent + a fresh session, and prints the new run's
// reply. With --diff, shows a side-by-side comparison of original input,
// original output (if captured), and the new output — directly answers
// "did my prompt change fix it?" without rerunning by hand.
//
// Replay reads the trace from a local SQLite db (or one rsync'd from a
// remote daemon via --path). Old rows pre-migration-v8 fall back to
// messagePreview (capped 200 chars), with a warning that the input
// may be truncated relative to the original.

trace
  .command("replay <taskId>")
  .description("re-run a recorded task against the current agent config (handoff item #11)")
  .option("--cwd <dir>", "project root", process.cwd())
  .option("--path <p>", "sqlite db path (relative to --cwd)", ".agentx/db.sqlite")
  .option("--daemon <url>", "daemon API base URL", "http://127.0.0.1:18800")
  .option("--diff", "show original input + output vs new output side-by-side")
  .option("--no-fresh", "do NOT freshSession (default is fresh — required for clean replay)")
  .action(async (taskId: string, opts) => {
    const db = openReadOnly(opts)
    const trace = getTrace(db, taskId)
    if (!trace) {
      console.log(chalk.red(`  task not found: ${taskId}`))
      console.log(chalk.dim(`  agentx trace list   — see what's available`))
      process.exit(1)
    }
    const t = trace.task
    const message = t.originalMessage ?? t.messagePreview
    if (!message) {
      console.log(chalk.red(`  task ${taskId} has no recorded input message — cannot replay`))
      process.exit(1)
    }
    const truncated = !t.originalMessage && t.messagePreview != null
    if (truncated) {
      console.log(chalk.yellow(`  ⚠ pre-migration-v8 row: input message was capped at 200 chars; replay uses the preview`))
    }

    console.log()
    console.log(chalk.bold(`  replay ${chalk.cyan(taskId)}`))
    console.log(chalk.dim(`  agent=${t.agentId} channel=${t.channel ?? "—"} chatId=${t.chatId ?? "—"}`))
    console.log(chalk.dim(`  original status=${t.status} duration=${t.durationMs ?? "?"}ms tokens=in:${t.inputTokens ?? 0}/out:${t.outputTokens ?? 0}`))
    console.log()

    const base = String(opts.daemon).replace(/\/+$/, "")
    const body = {
      agent: t.agentId,
      message,
      freshSession: opts.fresh !== false,
      context: {
        channel: t.channel ?? "api",
        // Per-replay chatId so the new run doesn't pollute (or get polluted by)
        // the original conversation's session. Operators can pin to the original
        // chatId via --no-fresh + a different invocation if they want continuity.
        chatId: `replay-${taskId.toLowerCase().slice(-8)}-${Date.now().toString(36)}`,
      },
    }
    const startedAt = Date.now()
    let res: Response
    try {
      res = await fetch(`${base}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (e: any) {
      console.log(chalk.red(`  daemon unreachable at ${base}: ${e.message || e}`))
      process.exit(1)
    }
    const reply = await res.json().catch(() => ({})) as {
      content?: string
      error?: string
      duration?: number
      usage?: { inputTokens?: number; outputTokens?: number }
    }
    const durationMs = Date.now() - startedAt

    if (!res.ok) {
      console.log(chalk.red(`  replay failed (${res.status}): ${reply.error || "unknown error"}`))
      process.exit(1)
    }

    if (opts.diff) {
      console.log(chalk.bold("  INPUT (replayed verbatim)"))
      console.log()
      printBlock(message)
      console.log()
      console.log(chalk.bold(`  ORIGINAL OUTPUT  ${chalk.dim(`status=${t.status} ${t.durationMs ?? "?"}ms`)}`))
      console.log()
      if (t.finalResponse) {
        printBlock(t.finalResponse)
      } else {
        console.log(chalk.yellow(`  (not captured — pre-migration-v8 row, or response was empty)`))
      }
      console.log()
      console.log(chalk.bold(`  CURRENT OUTPUT  ${chalk.dim(`status=${reply.error ? "error" : "ok"} ${durationMs}ms tokens=in:${reply.usage?.inputTokens ?? 0}/out:${reply.usage?.outputTokens ?? 0}`)}`))
      console.log()
      printBlock(reply.content ?? "(empty reply)")
      if (reply.error) console.log(chalk.red(`  error: ${reply.error}`))
      console.log()
      // Quick literal-diff signal — true when the two strings differ.
      // This is intentionally simple (no character-level diff) — operators
      // skim for "did anything change?" before deep-reading both blocks.
      const same = (t.finalResponse ?? "").trim() === (reply.content ?? "").trim()
      if (t.finalResponse) {
        console.log(same
          ? chalk.dim("  outputs are identical")
          : chalk.yellow("  outputs differ — read both blocks to see what changed"))
        console.log()
      }
    } else {
      console.log(chalk.green(`  ✓ replayed in ${durationMs}ms`))
      console.log()
      printBlock(reply.content ?? "(empty reply)")
      if (reply.error) console.log(chalk.red(`\n  error: ${reply.error}`))
      console.log()
      console.log(chalk.dim(`  agentx trace replay ${taskId} --diff   to compare against the original output`))
      console.log()
    }
  })

/** Print a multi-line block with consistent indent + a left bar so the block
 *  visually separates from surrounding chrome. Caps very long blocks at 60
 *  lines with a "…+N more" footer; the full content is still in the trace
 *  store for those who need it. */
function printBlock(text: string): void {
  const lines = text.split("\n")
  const max = 60
  const shown = lines.slice(0, max)
  for (const l of shown) console.log(`  ${chalk.dim("│")} ${l}`)
  if (lines.length > max) {
    console.log(`  ${chalk.dim("│")} ${chalk.dim(`…+${lines.length - max} more lines`)}`)
  }
}
