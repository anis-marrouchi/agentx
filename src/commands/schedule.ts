import { Command } from "commander"
import chalk from "chalk"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import prompts from "prompts"
import { applyConfigMutation, setAtPath, getAtPath, unsetAtPath } from "@/daemon/config-mutator"
import { expandEnvVars } from "@/daemon/config"
import { parseEnglishToCron, slugifyScheduleId } from "@/utils/nl-cron"
import {
  approveSchedule,
  buildScheduleJob,
  DEFAULT_SCHEDULE_TIMEZONE,
  formatFireTime,
  nextFireTime,
  parseOnError,
  rejectSchedule,
  setScheduleEnabled,
} from "@/crons/schedule-ops"

// --- agentx schedule — natural-language cron layer ---
//
// Writes the same `crons.<id>` shape the low-level `agentx cron` command
// manages, but takes English phrases and a --do prompt instead of raw cron
// syntax. Both verbs coexist; `cron` is the escape hatch.
//
// The job shape is built in src/crons/schedule-ops.ts, shared with the
// agent-facing `agentx_schedule` MCP tool. Agent requests land here as
// pending jobs that only `schedule approve|reject` resolve.

function loadRawConfig(configPath?: string): any {
  const p = configPath || resolve(process.cwd(), "agentx.json")
  if (!existsSync(p)) {
    console.log(chalk.red(`  No config at ${p}. Run: agentx init`))
    process.exit(1)
  }
  return JSON.parse(readFileSync(p, "utf-8"))
}

async function resolveNotifyTarget(
  flag: string | undefined,
  cfg: any,
): Promise<{ channel: string; chatId: string; accountId?: string } | undefined> {
  if (!flag) return undefined
  if (flag === "me") {
    const dest = cfg?.notifications?.destination
    if (dest?.channel && dest?.chatId) {
      return { channel: dest.channel, chatId: dest.chatId, accountId: dest.accountId }
    }
    console.log(chalk.yellow("  --notify me: no notifications.destination set yet."))
    const { channel, chatId, accountId } = await prompts([
      { type: "text", name: "channel", message: "Destination channel (telegram/whatsapp):" },
      { type: "text", name: "chatId", message: "Destination chatId:" },
      { type: "text", name: "accountId", message: "Account id (optional):" },
    ])
    if (!channel || !chatId) return undefined
    return { channel, chatId, accountId: accountId || undefined }
  }
  // shorthand channel:chatId[:account]
  const parts = flag.split(":")
  if (parts.length >= 2) {
    return { channel: parts[0], chatId: parts[1], accountId: parts[2] }
  }
  console.log(chalk.red(`  Unrecognized --notify value: ${flag} (use "me" or "channel:chatId[:account]")`))
  return undefined
}

export const schedule = new Command()
  .name("schedule")
  .description("schedule agents with natural-language cron: \"every morning at 9\" --agent devops --do \"Post standup\"")

// ── agentx schedule "every morning at 9" --agent X --do "..." [--notify me] ──
schedule
  .argument("[when]", 'natural-language schedule, e.g. "every morning at 9"')
  .option("--agent <id>", "agent to run")
  .option("--do <prompt>", "prompt to run at each tick (required unless --id exists)")
  .option("--id <name>", "explicit cron id (default: auto-slug of <when>-<agent>)")
  .option("--notify <target>", '"me" (use notifications.destination) or "channel:chatId[:accountId]"')
  .option("--on-error <modes>", 'comma list of "log|notify|disable" (default: log; notify implies "notify")')
  .option("--timezone <tz>", `IANA timezone (default: ${DEFAULT_SCHEDULE_TIMEZONE})`, DEFAULT_SCHEDULE_TIMEZONE)
  .option("--timeout <seconds>", "max run time", "600")
  .option("--model <model>", "override model")
  .option("--disabled", "create but leave disabled")
  .option("--dry-run", "print what would be written without writing")
  .action(async (when: string | undefined, opts) => {
    if (!when) {
      schedule.help()
      return
    }
    if (!opts.agent) {
      console.log(chalk.red('  --agent is required. Try: agentx schedule "every morning at 9" --agent devops --do "..."'))
      process.exit(1)
    }
    if (!opts.do && !opts.id) {
      console.log(chalk.red('  --do "<prompt>" is required'))
      process.exit(1)
    }

    const parsed = parseEnglishToCron(when)
    if (!parsed) {
      console.log(chalk.red(`  Couldn't parse: "${when}"`))
      console.log(chalk.dim(`  Try: "every morning at 9", "weekdays at 6pm", "every 15 minutes",`))
      console.log(chalk.dim(`       "every monday at 10am", "1st of every month at noon",`))
      console.log(chalk.dim(`       "daily at 9:30am", "every hour", "hourly"`))
      process.exit(1)
    }

    const cfg = loadRawConfig(opts.config)
    const expanded = expandEnvVars(cfg)

    // Validate agent exists
    if (!cfg.agents?.[opts.agent]) {
      console.log(chalk.red(`  Agent "${opts.agent}" not found in agentx.json`))
      console.log(chalk.dim(`  Available: ${Object.keys(cfg.agents || {}).join(", ") || "(none)"}`))
      process.exit(1)
    }

    const notify = await resolveNotifyTarget(opts.notify, expanded)
    const id: string = opts.id || slugifyScheduleId(parsed.matched, opts.agent)

    // --notify implies the "notify" error mode; buildScheduleJob adds it.
    const job = buildScheduleJob({
      parsed,
      agent: opts.agent,
      prompt: opts.do,
      timezone: opts.timezone,
      timeout: parseInt(opts.timeout, 10),
      model: opts.model,
      notify,
      onError: parseOnError(opts.onError),
      enabled: !opts.disabled,
    })
    const onErrorModes = job.onError as string[]

    const result = await applyConfigMutation(
      (c) => setAtPath(c, `crons.${id}`, job),
      { configPath: opts.config, dryRun: !!opts.dryRun },
    )

    if (!result.success) {
      console.log(chalk.red(`  ✗ ${result.error}`))
      process.exit(1)
    }

    const verb = opts.dryRun ? "would add" : "Added"
    console.log(chalk.green(`  ✓ ${verb} cron ${chalk.cyan(id)}`))
    console.log(chalk.dim(`    Schedule: ${parsed.cron}  (${parsed.human}, ${opts.timezone})`))
    console.log(chalk.dim(`    Agent: ${opts.agent}`))
    if (notify) console.log(chalk.dim(`    Notify: ${notify.channel} ${notify.chatId}`))
    if (onErrorModes.length) console.log(chalk.dim(`    On error: ${onErrorModes.join(", ")}`))
    if (!opts.dryRun && result.reloaded) console.log(chalk.dim("    Daemon hot-reloaded."))
  })

// ── agentx schedule list ──
schedule
  .command("list")
  .alias("ls")
  .description("list all scheduled jobs with human-readable descriptions")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (opts) => {
    const cfg = loadRawConfig(opts.config)
    const crons = cfg.crons || {}
    const entries = Object.entries(crons)
    if (!entries.length) {
      console.log(chalk.dim("  No scheduled jobs"))
      return
    }
    console.log()
    for (const [id, def] of entries as any) {
      const tag = def.approval ? chalk.yellow("◐") : def.enabled ? chalk.green("●") : chalk.dim("○")
      let human = def.schedule
      try {
        const cronstrue = (await import("cronstrue")).default
        human = cronstrue.toString(def.schedule, { use24HourTimeFormat: false })
      } catch { /* keep raw */ }
      console.log(`  ${tag} ${chalk.cyan(id.padEnd(32))} ${chalk.dim(def.schedule.padEnd(14))} ${chalk.dim("→")} ${def.agent}`)
      console.log(chalk.dim(`      ${human} (${def.timezone || "UTC"})`))
      if (def.notify) {
        console.log(chalk.dim(`      notify: ${def.notify.channel} ${def.notify.chatId}`))
      }
      if (def.createdBy) console.log(chalk.dim(`      created by agent: ${def.createdBy}`))
      if (def.approval) {
        const tz = def.timezone || "UTC"
        const next = formatFireTime(nextFireTime(def.schedule, tz), tz)
        console.log(chalk.yellow(`      pending ${def.approval.action} approval (requested by ${def.approval.requestedBy}); next fire: ${next}`))
        console.log(chalk.dim(`      agentx schedule approve ${id}  |  agentx schedule reject ${id}`))
      }
    }
    console.log()
  })

// ── agentx schedule on/off <id> ──
for (const [verb, enabled] of [["on", true], ["off", false]] as const) {
  schedule
    .command(`${verb} <id>`)
    .description(`${enabled ? "enable" : "disable"} a scheduled job`)
    .action(async (id: string) => {
      const result = await setScheduleEnabled(id, enabled)
      if (!result.success) {
        console.log(chalk.red(`  ✗ ${result.error}`))
        process.exit(1)
      }
      console.log(chalk.green(`  ✓ ${id} ${enabled ? "enabled" : "disabled"}`))
      if (result.reloaded) console.log(chalk.dim("    Daemon hot-reloaded."))
    })
}

// ── agentx schedule remove <id> ──
schedule
  .command("remove <id>")
  .alias("rm")
  .description("remove a scheduled job")
  .action(async (id: string) => {
    const result = await applyConfigMutation((cfg) => {
      if (!getAtPath(cfg, `crons.${id}`)) {
        throw new Error(`cron "${id}" not found`)
      }
      unsetAtPath(cfg, `crons.${id}`)
    })
    if (!result.success) {
      console.log(chalk.red(`  ✗ ${result.error}`))
      process.exit(1)
    }
    console.log(chalk.green(`  ✓ ${id} removed`))
    if (result.reloaded) console.log(chalk.dim("    Daemon hot-reloaded."))
  })

// ── agentx schedule approve|reject <id> — operator decision on an agent request ──
for (const [verb, fn, desc] of [
  ["approve", approveSchedule, "approve an agent's pending create/delete request (enables or removes the job)"],
  ["reject", rejectSchedule, "reject an agent's pending create/delete request (drops the request)"],
] as const) {
  schedule
    .command(`${verb} <id>`)
    .description(desc)
    .option("-c, --config <path>", "path to agentx.json")
    .action(async (id: string, opts) => {
      const outcome = await fn(id, { configPath: opts.config })
      if (!outcome.success) {
        console.log(chalk.red(`  ✗ ${outcome.message}`))
        process.exit(1)
      }
      console.log(chalk.green(`  ✓ ${outcome.message}`))
      if (outcome.result?.reloaded) console.log(chalk.dim("    Daemon hot-reloaded."))
    })
}

// ── agentx schedule parse "<english>" — preview a parse without writing ──
schedule
  .command("parse <when...>")
  .description("preview a natural-language parse without writing anything")
  .action((words: string[]) => {
    const when = words.join(" ")
    const r = parseEnglishToCron(when)
    if (!r) {
      console.log(chalk.red(`  ✗ could not parse: "${when}"`))
      process.exit(1)
    }
    console.log(chalk.green(`  "${when}"`))
    console.log(chalk.dim(`    → ${r.cron}`))
    console.log(chalk.dim(`    → ${r.human}`))
  })
