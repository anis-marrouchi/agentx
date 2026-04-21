import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx bench: run the same request under both context strategies and
//     print a side-by-side quality + token comparison ---
//
// Intended as a lightweight, repeatable way to answer "is the planner worth
// it?" for a given agent + conversation shape. Hits the running daemon via
// POST /task so it exercises the full production path (session lookup,
// memory retrieval, Claude CLI invocation). Does NOT mock anything.

export const bench = new Command()
  .name("bench")
  .description("benchmark harnesses (context strategies, ...)")

bench
  .command("context")
  .description("run the same message under 'layered' vs 'planner' strategies and compare")
  .requiredOption("--agent <id>", "agent id to send the message to")
  .requiredOption("--message <text>", "the user message to bench")
  .option("--channel <name>", "channel label for the request context", "bench")
  .option("--chat-id <id>", "chatId for session scoping", "bench-harness")
  .option("--sender <name>", "sender label for the request context", "bench")
  .option("--runs <n>", "number of runs per strategy (averaged)", "1")
  .option("--preview <chars>", "how many response chars to print", "280")
  .option("--url <url>", "daemon URL override (default: from agentx.json)")
  .action(async (opts) => {
    const runs = Math.max(1, parseInt(opts.runs as string, 10) || 1)
    const previewChars = Math.max(0, parseInt(opts.preview as string, 10) || 280)
    const daemonUrl = (opts.url as string) || daemonUrlFromConfig()

    console.log()
    console.log(chalk.bold(`  Context-strategy benchmark`))
    console.log(chalk.dim(`  agent=${opts.agent}, channel=${opts.channel}, chatId=${opts.chatId}, runs=${runs}`))
    console.log(chalk.dim(`  daemon=${daemonUrl}`))
    console.log()

    const layered = await runStrategy(daemonUrl, "layered", opts, runs)
    const planner = await runStrategy(daemonUrl, "planner", opts, runs)

    printComparison(layered, planner, previewChars)
  })

type RunResult = {
  strategy: "layered" | "planner"
  runs: number
  errors: number
  avgDurationMs: number
  avgInput: number
  avgOutput: number
  avgCacheRead: number
  avgCacheCreate: number
  avgTotalInput: number
  avgCost: number
  lastResponse: string
  lastError?: string
}

async function runStrategy(
  daemonUrl: string,
  strategy: "layered" | "planner",
  opts: Record<string, unknown>,
  runs: number,
): Promise<RunResult> {
  let totalDuration = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheCreate = 0
  let totalCost = 0
  let errors = 0
  let lastResponse = ""
  let lastError: string | undefined

  for (let i = 0; i < runs; i++) {
    const started = Date.now()
    try {
      const r = await fetch(`${daemonUrl}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: opts.agent,
          message: opts.message,
          contextStrategy: strategy,
          context: {
            channel: opts.channel,
            chatId: opts.chatId,
            sender: opts.sender,
          },
        }),
        // Agents can legitimately take minutes for heavy tasks; keep the
        // timeout loose so the bench doesn't misreport a slow-but-cheap run.
        signal: AbortSignal.timeout(10 * 60_000),
      })
      const data = (await r.json()) as {
        content?: string
        error?: string
        duration?: number
        usage?: {
          inputTokens?: number
          outputTokens?: number
          cacheReadTokens?: number
          cacheCreateTokens?: number
        }
      }
      if (data.error) {
        errors++
        lastError = data.error
        continue
      }
      totalDuration += data.duration ?? Date.now() - started
      totalInput += data.usage?.inputTokens ?? 0
      totalOutput += data.usage?.outputTokens ?? 0
      totalCacheRead += data.usage?.cacheReadTokens ?? 0
      totalCacheCreate += data.usage?.cacheCreateTokens ?? 0
      totalCost += estimateCost(data.usage)
      lastResponse = data.content ?? ""
    } catch (err: any) {
      errors++
      lastError = err.message ?? String(err)
    }
  }

  const n = runs - errors || 1
  return {
    strategy,
    runs,
    errors,
    avgDurationMs: Math.round(totalDuration / n),
    avgInput: Math.round(totalInput / n),
    avgOutput: Math.round(totalOutput / n),
    avgCacheRead: Math.round(totalCacheRead / n),
    avgCacheCreate: Math.round(totalCacheCreate / n),
    avgTotalInput: Math.round((totalInput + totalCacheRead + totalCacheCreate) / n),
    avgCost: totalCost / n,
    lastResponse,
    lastError,
  }
}

/** Rough cost estimator — Sonnet 4.6 rates. Bench output is directional;
 *  for exact costs use the daemon's per-day usage JSON (which is what the
 *  token tracker writes) where per-model pricing is honored. */
function estimateCost(usage: RunResult["avgInput"] extends number ? any : never): number {
  if (!usage) return 0
  const inputRate = 3 / 1_000_000
  const outputRate = 15 / 1_000_000
  const cacheReadRate = 0.3 / 1_000_000
  const cacheCreateRate = 3.75 / 1_000_000
  return (
    (usage.inputTokens ?? 0) * inputRate +
    (usage.outputTokens ?? 0) * outputRate +
    (usage.cacheReadTokens ?? 0) * cacheReadRate +
    (usage.cacheCreateTokens ?? 0) * cacheCreateRate
  )
}

function printComparison(a: RunResult, b: RunResult, previewChars: number): void {
  const pad = (s: string, w: number) => s.length >= w ? s : s + " ".repeat(w - s.length)
  const fmt = (n: number) => n.toLocaleString()

  console.log(chalk.bold("  " + pad("metric", 22) + pad("layered", 18) + pad("planner", 18) + "delta"))
  console.log(chalk.dim("  " + "-".repeat(74)))

  const rows: Array<[string, number, number, (n: number) => string]> = [
    ["input tokens", a.avgInput, b.avgInput, fmt],
    ["output tokens", a.avgOutput, b.avgOutput, fmt],
    ["cache read", a.avgCacheRead, b.avgCacheRead, fmt],
    ["cache create", a.avgCacheCreate, b.avgCacheCreate, fmt],
    ["total input", a.avgTotalInput, b.avgTotalInput, fmt],
    ["est. cost ($)", a.avgCost, b.avgCost, (n) => n.toFixed(4)],
    ["duration (ms)", a.avgDurationMs, b.avgDurationMs, fmt],
  ]
  for (const [label, av, bv, fmtFn] of rows) {
    const delta = bv - av
    const deltaPct = av === 0 ? 0 : (delta / av) * 100
    const deltaStr =
      delta === 0
        ? chalk.dim("±0")
        : delta < 0
        ? chalk.green(`${fmtFn(delta)}  (${deltaPct.toFixed(0)}%)`)
        : chalk.red(`+${fmtFn(delta)}  (+${deltaPct.toFixed(0)}%)`)
    console.log("  " + pad(label, 22) + pad(fmtFn(av), 18) + pad(fmtFn(bv), 18) + deltaStr)
  }
  console.log(chalk.dim("  " + "-".repeat(74)))
  if (a.errors > 0 || b.errors > 0) {
    console.log(chalk.yellow(`  errors: layered=${a.errors} (${a.lastError ?? ""}), planner=${b.errors} (${b.lastError ?? ""})`))
  }
  console.log()

  if (previewChars > 0) {
    console.log(chalk.bold("  Response preview (last run of each):"))
    console.log(chalk.dim("  layered:"))
    console.log("    " + clip(a.lastResponse, previewChars).split("\n").join("\n    "))
    console.log(chalk.dim("  planner:"))
    console.log("    " + clip(b.lastResponse, previewChars).split("\n").join("\n    "))
    console.log()
  }

  const tokenDelta = b.avgTotalInput - a.avgTotalInput
  if (tokenDelta < 0) {
    const pct = a.avgTotalInput === 0 ? 0 : Math.abs(tokenDelta / a.avgTotalInput) * 100
    console.log(chalk.green(`  Planner saved ${fmt(Math.abs(tokenDelta))} input tokens/run (${pct.toFixed(0)}% less).`))
  } else if (tokenDelta > 0) {
    console.log(chalk.yellow(`  Planner used ${fmt(tokenDelta)} MORE input tokens — investigate before enabling.`))
  }
  console.log()
}

function clip(s: string, n: number): string {
  if (!s) return "(empty)"
  return s.length > n ? s.slice(0, n) + "…" : s
}

function daemonUrlFromConfig(): string {
  try {
    const config = loadDaemonConfig()
    const [host, port] = config.node.bind.split(":")
    return `http://${host || "127.0.0.1"}:${port || "19900"}`
  } catch {
    return "http://127.0.0.1:19900"
  }
}
