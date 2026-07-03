import { Command } from "commander"
import chalk from "chalk"
import { existsSync } from "fs"
import { resolve } from "path"
import Database from "better-sqlite3"
import { SessionStore } from "@/agents/sessions"
import { runExtraction, DEFAULT_MIN_OCCURRENCES, DEFAULT_MAX_CLUSTERS } from "@/procedures/mine"
import { applyConfigMutation, setAtPath } from "@/daemon/config-mutator"

// --- agentx procedure extract / watch ---
// extract: one mining pass (dry-run by default, like `wiki promote`).
// watch:   persist the cadence — a `crons.procedure-extract` entry that
//          shells this exact CLI, plus the `procedures.extraction` config
//          block the daemon's on-task watcher reads.

function parseSince(input: string | undefined): number | undefined {
  if (!input) return undefined
  const m = /^(\d+)\s*([smhd])$/.exec(input.trim())
  if (m) {
    const n = Number(m[1])
    const unit = m[2]
    return Date.now() - n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3600_000 : 86_400_000)
  }
  const n = Number(input)
  if (Number.isFinite(n) && n > 0) return n
  console.log(chalk.red(`  Invalid --since "${input}". Use "1h", "30m", "7d", or an ms epoch.`))
  process.exit(1)
}

function openTraceDb(path: string): Database.Database {
  const dbPath = resolve(process.cwd(), path)
  if (!existsSync(dbPath)) {
    console.log(chalk.red(`  No db at ${dbPath}`))
    process.exit(1)
  }
  return new Database(dbPath, { readonly: true })
}

export const extractCommand = new Command()
  .name("extract")
  .description("mine recurring user activity into procedure drafts (dry-run by default)")
  .option("--path <path>", "SQLite db path", ".agentx/db.sqlite")
  .option("--since <duration>", "activity window, e.g. 24h, 7d, or ms epoch", "7d")
  .option("--agent <id>", "only mine one agent's activity")
  .option("--min-occurrences <n>", "recurrences before a pattern becomes a draft", String(DEFAULT_MIN_OCCURRENCES))
  .option("--max <n>", "max clusters distilled per run", String(DEFAULT_MAX_CLUSTERS))
  .option("--via <agentId>", "route the LLM call through a running agent — uses the agent's own session")
  .option("--model <model>", "direct Anthropic API model — needs ANTHROPIC_API_KEY")
  .option("--daemon <url>", "daemon API base URL for --via", "http://127.0.0.1:18800")
  .option("--commit", "write drafts and persist recurrence counts", false)
  .action(async (opts) => {
    if (opts.commit && !opts.via && !opts.model) {
      console.log(chalk.red("  --commit needs an LLM: pass --via <agentId> or --model <model>"))
      process.exit(1)
    }
    const db = openTraceDb(opts.path)
    const report = await runExtraction(db, {
      since: parseSince(opts.since),
      agentId: opts.agent,
      sessions: new SessionStore(process.cwd()),
      minOccurrences: Number(opts.minOccurrences) || DEFAULT_MIN_OCCURRENCES,
      max: Number(opts.max) || DEFAULT_MAX_CLUSTERS,
      commit: !!opts.commit,
      llm: { viaAgent: opts.via, model: opts.model, daemonUrl: opts.daemon, chatId: "procedure-miner" },
      log: (m) => console.log(chalk.dim(`  ${m}`)),
    })

    console.log()
    console.log(`  ${report.episodes} episode(s) → ${report.clusters} cluster(s), ${report.ready.length} at threshold`)
    for (const c of report.ready) {
      console.log(`  ${chalk.cyan(c.key)}  ${chalk.bold(`×${c.count}`)}  ${chalk.dim(c.status)}`)
      if (c.sampleMessage) console.log(chalk.dim(`    "${c.sampleMessage.slice(0, 100)}"`))
    }
    if (report.nearMisses.length) {
      console.log(chalk.dim(`\n  near-misses (same intent, different activity shape — tuning signal):`))
      for (const nm of report.nearMisses.slice(0, 5)) {
        console.log(chalk.dim(`    ${nm.intent} → ${nm.keys.length} variants`))
      }
    }
    for (const d of report.drafted) {
      console.log(chalk.green(`  ✓ draft written: ${d.id}`) + chalk.dim(`  (${d.count} occurrences)`))
    }
    for (const s of report.skipped) {
      console.log(chalk.yellow(`  skipped ${s.cluster}: ${s.reason}`))
    }
    for (const w of report.warnings) console.log(chalk.yellow(`  ⚠ ${w}`))
    if (report.dryRun) {
      console.log(chalk.dim("\n  dry run only; pass --commit --via <agentId> to write drafts"))
    } else if (report.drafted.length) {
      console.log(chalk.dim("\n  review with: agentx procedure list --drafts · then promote/reject <id>"))
    }
  })

const CADENCE = {
  hourly: "0 * * * *",
  // 03:00 — after workflow-absorb (02:00) and memory-promote (02:30).
  daily: "0 3 * * *",
} as const

export const watchCommand = new Command()
  .name("watch")
  .description("set the extraction cadence: registers the cron + config the daemon runs on")
  .option("--hourly", "extract every hour")
  .option("--daily", "extract daily at 03:00")
  .option("--cron <expr>", "custom 5-field cron expression")
  .option("--on-task", "also count patterns live after each completed task")
  .option("--off", "disable scheduled extraction")
  .option("--via <agentId>", "agent that runs the extraction (LLM distillation goes through its session)")
  .option("--min-occurrences <n>", "recurrences before a pattern becomes a draft", String(DEFAULT_MIN_OCCURRENCES))
  .option("--timezone <tz>", "IANA timezone", "Africa/Tunis")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--dry-run", "print what would be written without writing")
  .action(async (opts) => {
    const schedule: string | undefined = opts.off
      ? undefined
      : opts.cron ?? (opts.hourly ? CADENCE.hourly : opts.daily ? CADENCE.daily : undefined)
    if (!opts.off && !schedule && !opts.onTask) {
      console.log(chalk.red("  pick a cadence: --hourly, --daily, --cron <expr>, and/or --on-task (or --off)"))
      process.exit(1)
    }
    if (!opts.off && !opts.via) {
      console.log(chalk.red("  --via <agentId> is required: drafts are distilled through that agent's session"))
      process.exit(1)
    }

    const minOccurrences = Number(opts.minOccurrences) || DEFAULT_MIN_OCCURRENCES
    const extraction = {
      enabled: !opts.off,
      onTaskCompletion: !opts.off && !!opts.onTask,
      minOccurrences,
      via: opts.off ? undefined : opts.via,
    }
    const prompt = [
      "Run this shell command EXACTLY as written. Do NOT substitute, rewrite, shorten, or fall back to alternative commands. If it exits non-zero, report the verbatim exit code and stderr and STOP.",
      "",
      `1) cd ${process.cwd()} && node dist/cli.js procedure extract --since 7d --max ${DEFAULT_MAX_CLUSTERS} --min-occurrences ${minOccurrences} --via ${opts.via} --commit`,
      "",
      "Report a one-line summary of drafted/skipped counts.",
    ].join("\n")

    const result = await applyConfigMutation(
      (c) => {
        setAtPath(c, "procedures.extraction", extraction)
        if (opts.off) {
          if ((c as any).crons?.["procedure-extract"]) {
            setAtPath(c, "crons.procedure-extract.enabled", false)
          }
        } else if (schedule) {
          setAtPath(c, "crons.procedure-extract", {
            enabled: true,
            schedule,
            timezone: opts.timezone,
            agent: opts.via,
            prompt,
            timeout: 900,
            onError: "log",
          })
        }
      },
      { configPath: opts.config, dryRun: !!opts.dryRun },
    )
    if (!result.success) {
      console.log(chalk.red(`  ✗ ${result.error}`))
      process.exit(1)
    }

    const verb = opts.dryRun ? "would set" : "Set"
    if (opts.off) {
      console.log(chalk.green(`  ✓ ${verb} procedure extraction: off`))
    } else {
      console.log(chalk.green(`  ✓ ${verb} procedure extraction cadence`))
      if (schedule) console.log(chalk.dim(`    cron: ${schedule} (${opts.timezone}) via ${opts.via}`))
      if (opts.onTask) console.log(chalk.dim(`    on-task counting: enabled`))
      console.log(chalk.dim(`    threshold: ${minOccurrences} occurrences`))
    }
    console.log(chalk.yellow("  ⚠ restart the daemon to activate — hot-reload does not pick up new config blocks"))
  })
