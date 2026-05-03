import { Command } from "commander"
import chalk from "chalk"
import { DayPlanStore, parsePriorities, type PlanTier } from "@/business/day-plan"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx plan: human-driven daily / weekly / monthly priorities ---
//
// Replaces the old mechanical standup-tick. The day-cycle reads
// .agentx/plans/<date>.md (day → week → month fallback) every morning;
// without a plan, the cycle posts a notification and dispatches no agent.
// This CLI is the fast path for operators who'd rather type than open the
// admin form. Markdown files are also editable directly on disk and via
// the admin Plans tab — three surfaces, one source of truth.

const TIER_ALIAS: Record<string, PlanTier> = {
  today: "day", day: "day",
  week: "week", "this-week": "week",
  month: "month", "this-month": "month",
}

function resolveTier(label: string): PlanTier {
  const t = TIER_ALIAS[label.toLowerCase()]
  if (!t) throw new Error(`Unknown plan tier "${label}". Use: today | week | month.`)
  return t
}

function resolveStore(): DayPlanStore {
  const cfg = loadDaemonConfig()
  const dir = cfg.business?.standup?.plansDir || ".agentx/plans"
  return new DayPlanStore(dir)
}

export const plan = new Command()
  .name("plan")
  .description("set / read / list day-week-month plans that drive the standup-tick")

plan
  .command("set <tier>")
  .description("write a plan for today | week | month (priorities-as-bullets)")
  .option("-p, --priority <text...>", "bullet line — repeat for multiple priorities")
  .option("-m, --markdown <md>", "raw markdown body (overrides --priority)")
  .option("-f, --file <path>", "read markdown from a file")
  .action(async (tier: string, opts) => {
    const t = resolveTier(tier)
    const store = resolveStore()
    let body: string
    if (opts.file) {
      const { readFileSync } = await import("fs")
      body = readFileSync(opts.file, "utf-8")
    } else if (opts.markdown) {
      body = opts.markdown
    } else if (opts.priority?.length) {
      body = (opts.priority as string[]).map((p) => `- ${p}`).join("\n")
    } else {
      console.error(chalk.red("  Provide --priority, --markdown, or --file."))
      process.exit(1)
    }
    const result = store.write(t, body)
    console.log(chalk.green(`  ✓ ${t} plan saved → ${result.path}`))
    const items = parsePriorities(body)
    if (items.length) {
      console.log(chalk.dim(`  ${items.length} bullet${items.length === 1 ? "" : "s"}:`))
      for (const it of items) console.log(chalk.dim(`    • ${it}`))
    }
  })

plan
  .command("show [tier]")
  .description("print the plan that the next standup will use (default: resolve day→week→month)")
  .action(async (tier: string | undefined) => {
    const store = resolveStore()
    if (tier) {
      const t = resolveTier(tier)
      const r = store.read(t)
      if (!r) { console.log(chalk.dim(`  No ${t} plan set.`)); return }
      printPlan(r.tier, r.date, r.content)
      return
    }
    const r = store.resolve()
    if (!r) {
      console.log(chalk.yellow("  No plan set at any tier."))
      console.log(chalk.dim("  The next standup-tick will post a 'no plan today' notice and dispatch no agent."))
      console.log(chalk.dim("  Set one with: agentx plan set today --priority \"…\""))
      return
    }
    printPlan(r.tier, r.date, r.content)
  })

plan
  .command("list")
  .description("recent plans across all tiers")
  .option("-n, --limit <n>", "max rows", "20")
  .action(async (opts) => {
    const store = resolveStore()
    const rows = store.list(parseInt(opts.limit, 10) || 20)
    if (!rows.length) { console.log(chalk.dim("  No plans yet.")); return }
    for (const r of rows) {
      console.log(`  ${chalk.cyan(r.tier.padEnd(5))} ${chalk.bold(r.date.padEnd(11))} ${chalk.dim(r.path)}`)
    }
  })

plan
  .command("clear <tier>")
  .description("remove the plan for today | week | month")
  .action(async (tier: string) => {
    const t = resolveTier(tier)
    const store = resolveStore()
    const existing = store.read(t)
    if (!existing) { console.log(chalk.dim(`  No ${t} plan to clear.`)); return }
    const { unlinkSync } = await import("fs")
    unlinkSync(existing.path)
    console.log(chalk.green(`  ✓ ${t} plan cleared (${existing.path})`))
  })

function printPlan(tier: PlanTier, date: string, content: string): void {
  console.log(chalk.cyan(`  ${tier} plan — ${date}`))
  console.log()
  for (const line of content.split("\n")) console.log(`    ${line}`)
  console.log()
  const items = parsePriorities(content)
  if (items.length) console.log(chalk.dim(`  ${items.length} bullet${items.length === 1 ? "" : "s"} extracted as priorities.`))
}
