import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

export const usage = new Command()
  .name("usage")
  .description("token usage analysis and reporting")

// agentx usage — quick today summary
usage
  .command("today", { isDefault: true })
  .description("show today's token usage")
  .action(async () => {
    try {
      const config = loadDaemonConfig()
      const [host, port] = config.node.bind.split(":")
      const res = await fetch(`http://${host || "127.0.0.1"}:${port}/usage`, { signal: AbortSignal.timeout(3000) })
      const data = await res.json() as any

      console.log()
      console.log(chalk.bold(`  Token Usage (last 7 days)`))
      console.log()

      if (data.totalTasks === 0) {
        console.log(chalk.dim("  No tasks recorded yet"))
        console.log()
        return
      }

      const fmt = (n: number) => n.toLocaleString()

      console.log(`  Total: ${chalk.bold(fmt(data.totalTokens))} tokens across ${data.totalTasks} tasks`)
      console.log(`    Input:        ${fmt(data.totalInput)}`)
      console.log(`    Output:       ${fmt(data.totalOutput)}`)
      console.log(`    Cache read:   ${fmt(data.totalCacheRead)}`)
      console.log(`    Cache create: ${fmt(data.totalCacheCreate)}`)
      if (data.cacheHitRatio > 0) {
        console.log(`    Cache hit:    ${(data.cacheHitRatio * 100).toFixed(1)}%`)
      }
      if (data.totalErrors > 0) {
        console.log(`    Errors:       ${chalk.red(String(data.totalErrors))}`)
      }

      console.log()
      console.log(chalk.bold("  By Agent:"))
      const agents = Object.entries(data.byAgent || {}) as Array<[string, any]>
      agents.sort((a, b) => b[1].total - a[1].total)

      for (const [id, ag] of agents) {
        const total = fmt(ag.total || (ag.input + ag.output + ag.cacheRead + ag.cacheCreate))
        const avgMs = ag.avgDuration ? `${(ag.avgDuration / 1000).toFixed(1)}s avg` : ""
        console.log(`    ${chalk.cyan(id)}: ${total} tokens (${ag.tasks} tasks) ${chalk.dim(avgMs)}`)
      }
      console.log()
    } catch (e: any) {
      if (e.cause?.code === "ECONNREFUSED") {
        console.log(chalk.red("  Daemon not running. Start with: agentx daemon start"))
      } else {
        console.log(chalk.red(`  ${e.message}`))
      }
    }
  })

// agentx usage plan — the Claude plan windows the dispatch gate acts on
usage
  .command("plan")
  .description("show the Claude plan windows as Claude Code last reported them, and any hold on fresh sessions")
  .option("--lift", "lift the hold on fresh sessions now, without waiting for the reset time")
  .option("--json", "raw JSON output")
  .action(async (opts) => {
    try {
      const config = loadDaemonConfig()
      const [host, port] = config.node.bind.split(":")
      const base = `http://${host || "127.0.0.1"}:${port}`
      const res = opts.lift
        ? await fetch(`${base}/usage/plan/lift`, { method: "POST", signal: AbortSignal.timeout(3000) })
        : await fetch(`${base}/usage/plan`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(`Daemon answered ${res.status}. It may be older than this command; restart it.`)
      const data = await res.json() as any
      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
      const label = (w: string) => w.replace(/_/g, " ")

      console.log()
      if (opts.lift) {
        const names = (data.lifted as Array<{ window: string }>).map((s) => label(s.window))
        console.log(names.length
          ? `  Lifted the hold on: ${names.join(", ")}. The next fresh session asks Claude again.`
          : chalk.dim("  No hold to lift."))
        console.log()
        return
      }

      const now: number = data.now
      const held = new Set((data.holds as Array<{ window: string }>).map((s) => s.window))
      console.log(chalk.bold("  Claude plan (as Claude Code last reported it)"))
      console.log()
      if (data.provider.length === 0) {
        console.log(chalk.dim("  No report yet. Claude Code reports on each turn; the list is empty after a daemon restart."))
      }
      for (const s of data.provider as Array<any>) {
        const status = s.usingOverage ? "extra usage" : s.status === "allowed_warning" ? "nearly full" : s.status
        const used = typeof s.utilization === "number" ? `${Math.round(s.utilization * 100)}% used` : ""
        const mins = Math.max(1, Math.round((s.resetsAt - now) / 60_000))
        const reset = !(s.resetsAt > now) ? ""
          : mins < 60 ? `resets in ${mins} min`
          : mins < 48 * 60 ? `resets in ${Math.round(mins / 60)} h`
          : `resets in ${Math.round(mins / 1440)} days`
        const hold = held.has(s.window) ? chalk.red("holding fresh sessions") : ""
        console.log(`  ${label(s.window).padEnd(18)} ${status.padEnd(12)} ${[used, reset, hold].filter(Boolean).join(", ")}`)
      }
      console.log()
      const cap = (n?: number) => (n ? ` of ${n}` : "")
      console.log(`  Fresh sessions started: ${data.lastHour}${cap(data.maxPerHour)} in the last hour, ${data.last5h}${cap(data.maxPer5h)} in the last 5 hours`)
      if (held.size) console.log(chalk.dim("  To try again now: agentx usage plan --lift"))
      console.log()
    } catch (e: any) {
      if (e.cause?.code === "ECONNREFUSED") {
        console.log(chalk.red("  Daemon not running. Start with: agentx daemon start"))
      } else {
        console.log(chalk.red(`  ${e.message}`))
      }
    }
  })

// `agentx usage serve` was removed — the same data now lives at
// /admin/cost on the dashboard, so there's no second port to keep
// running. Anyone with a stale `usage serve` bookmark gets a redirect
// from the dashboard root pointing to /admin/cost.

// agentx usage report — run Python analyzer
usage
  .command("report")
  .description("run full session analysis (parses Claude Code JSONL files)")
  .option("--days <n>", "analyze last N days", "7")
  .action(async (opts) => {
    const { execSync } = await import("child_process")
    const { existsSync } = await import("fs")
    const { resolve } = await import("path")

    const scriptPath = resolve(process.cwd(), "scripts/token-report.py")
    if (!existsSync(scriptPath)) {
      console.log(chalk.red(`  Script not found: ${scriptPath}`))
      console.log(chalk.dim("  The token analyzer script should be at scripts/token-report.py"))
      return
    }

    console.log(chalk.dim("  Analyzing Claude Code sessions..."))
    try {
      execSync(`SINCE_DAYS=${opts.days} python3 "${scriptPath}"`, { stdio: "inherit" })
    } catch {
      console.log(chalk.red("  Analysis failed. Is Python 3 installed?"))
    }
  })

// agentx usage channels — cost per channel over fixed days, with a saved
// baseline to compare against. Reads the daily usage files; no daemon needed.
usage
  .command("channels")
  .description("cost per channel over a fixed range of days, next to a saved baseline")
  .requiredOption("--from <date>", "first day, YYYY-MM-DD")
  .requiredOption("--to <date>", "last day, YYYY-MM-DD")
  .option("--save <file>", "write this range's figures to a JSON file")
  .option("--baseline <file>", "a file written by --save, shown beside this range")
  .option("--json", "raw JSON output")
  .action(async (opts) => {
    const { readFileSync, writeFileSync } = await import("fs")
    const { TokenTracker } = await import("@/daemon/token-tracker")
    const { channelCosts, costPerTask } = await import("@/daemon/usage-channels")

    const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d))
    if (!isDay(opts.from) || !isDay(opts.to) || opts.from > opts.to) {
      console.log(chalk.red("  --from and --to must be YYYY-MM-DD, with --from not after --to"))
      process.exitCode = 1
      return
    }

    const report = channelCosts(new TokenTracker(), opts.from, opts.to)
    if (opts.save) writeFileSync(opts.save, JSON.stringify(report, null, 2))
    let baseline: typeof report | null = null
    if (opts.baseline) {
      try {
        baseline = JSON.parse(readFileSync(opts.baseline, "utf-8"))
      } catch (e: any) {
        console.log(chalk.red(`  Cannot read baseline ${opts.baseline}: ${e.message}`))
        process.exitCode = 1
        return
      }
    }
    if (opts.json) {
      console.log(JSON.stringify(baseline ? { baseline, current: report } : report, null, 2))
      return
    }

    const usd = (n: number | null) => (n === null ? "-" : `$${n.toFixed(n < 10 ? 3 : 2)}`)
    const mtok = (n: number) => `${(n / 1_000_000).toFixed(1)}M`
    console.log()
    console.log(chalk.bold(`  Cost per channel, ${report.from} to ${report.to} (${report.days} day(s) with data)`))
    if (baseline) console.log(chalk.dim(`  Baseline: ${baseline.from} to ${baseline.to} (${baseline.days} day(s) with data)`))
    console.log()
    const head = `  ${"channel".padEnd(14)} ${"tasks".padStart(6)} ${"cache read".padStart(11)} ${"cache write".padStart(11)} ${"output".padStart(8)} ${"cost".padStart(10)} ${"per task".padStart(9)}`
    console.log(chalk.dim(baseline ? `${head} ${"baseline".padStart(9)} ${"change".padStart(7)}` : head))
    const names = new Set([...Object.keys(report.channels), ...Object.keys(baseline?.channels || {})])
    const rows: Array<[string, typeof report.total | undefined, typeof report.total | undefined]> = [...names]
      .map((n): [string, typeof report.total | undefined, typeof report.total | undefined] => [n, report.channels[n], baseline?.channels[n]])
      .sort((a, b) => (b[1]?.cost || 0) - (a[1]?.cost || 0))
    rows.push(["TOTAL", report.total, baseline?.total])
    for (const [name, now, was] of rows) {
      const per = costPerTask(now)
      let line = `  ${name.padEnd(14)} ${String(now?.tasks || 0).padStart(6)} ${mtok(now?.cacheRead || 0).padStart(11)} ${mtok(now?.cacheCreate || 0).padStart(11)} ${mtok(now?.output || 0).padStart(8)} ${usd(now?.cost || 0).padStart(10)} ${usd(per).padStart(9)}`
      if (baseline) {
        const perWas = costPerTask(was)
        const change = per !== null && perWas ? `${(((per - perWas) / perWas) * 100).toFixed(0)}%` : "-"
        line += ` ${usd(perWas).padStart(9)} ${change.padStart(7)}`
      }
      console.log(line)
    }
    console.log()
    if (baseline) console.log(chalk.dim("  change = cost per task against the baseline; the two ranges do not have the same tasks."))
    if (opts.save) console.log(chalk.dim(`  Saved ${opts.save}`))
    console.log()
  })

// ---------------------------------------------------------------------------
// agentx usage surfaces — which CLI commands and dashboard pages get used
// ---------------------------------------------------------------------------
//
// The evidence side of the surface-reduction work. `usage today` answers
// "what did the agents cost"; this answers "which of the 46 commands and 16
// pages does anyone actually open". Reads straight from SQLite — no daemon
// needed, and it works on a node whose daemon is stopped.
//
// See docs/architecture/surface-reduction.md for the bar a surface must clear.
usage
  .command("surfaces")
  .description("which CLI commands and dashboard pages are actually used")
  .option("--days <n>", "window in days", "30")
  .option("--kind <kind>", "cli | page (default: both)")
  .option("--unused", "list registered surfaces with ZERO recorded use instead")
  .option("--json", "raw JSON output")
  .action(async (opts) => {
    const { listSurfaceUse } = await import("@/observability/surface-usage")
    const kind = opts.kind === "cli" || opts.kind === "page" ? opts.kind : undefined
    const rows = listSurfaceUse({ kind, sinceDays: Number(opts.days) || 30 })

    if (opts.unused) {
      const { buildProgram } = await import("@/program")
      const program = await buildProgram()
      const seen = new Set(rows.filter((r) => r.kind === "cli").map((r) => r.name))
      const registered: string[] = []
      const walk = (cmd: any, prefix: string) => {
        for (const sub of cmd.commands ?? []) {
          const name = prefix ? `${prefix} ${sub.name()}` : sub.name()
          registered.push(name)
          walk(sub, name)
        }
      }
      walk(program, "")
      const unused = registered.filter((c) => !seen.has(c)).sort()

      if (opts.json) {
        console.log(JSON.stringify({ windowDays: Number(opts.days) || 30, unused }, null, 2))
        return
      }
      console.log()
      console.log(chalk.bold(`  Never used in the last ${opts.days} days  (${unused.length}/${registered.length})`))
      console.log()
      for (const c of unused) console.log(`  ${chalk.dim("·")} ${c}`)
      console.log()
      console.log(chalk.dim("  Zero use is necessary but not sufficient to remove a surface —"))
      console.log(chalk.dim("  it must also fail the impact test. See docs/architecture/surface-reduction.md"))
      console.log()
      return
    }

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }

    if (rows.length === 0) {
      console.log()
      console.log(chalk.dim(`  No surface usage recorded in the last ${opts.days} days.`))
      console.log(chalk.dim("  Counting starts once this build has been running for a while."))
      console.log()
      return
    }

    console.log()
    console.log(chalk.bold(`  Surface usage — last ${opts.days} days`))
    console.log()
    let lastKind = ""
    for (const r of rows) {
      if (r.kind !== lastKind) {
        console.log(chalk.dim(`  ${r.kind === "cli" ? "CLI commands" : "Dashboard pages"}`))
        lastKind = r.kind
      }
      const count = String(r.count).padStart(6)
      const days = chalk.dim(`${r.days}d`)
      console.log(`  ${chalk.cyan(count)}  ${r.name.padEnd(28)} ${days}`)
    }
    console.log()
    console.log(chalk.dim(`  ${rows.length} surface(s) with recorded use. See --unused for the rest.`))
    console.log()
  })
