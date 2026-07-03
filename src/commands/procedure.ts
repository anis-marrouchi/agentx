import { Command } from "commander"
import chalk from "chalk"
import { ProcedureStore } from "@/procedures"
import { matchProcedures } from "@/procedures/match"
import { extractCommand, watchCommand } from "./procedure-extract"

// --- agentx procedure — user-perspective SOPs, the front door to automation ---
//
// A procedure describes a recurring activity from the USER's point of view
// (trigger, inputs, steps, expected outcome) — the system executing it is a
// black box. Drafts come from `extract` (mined from real activity) or `add`
// (hand-written); review with promote/reject; agents consume matches as
// guidance. Executable DAG workflows are an optional later promotion.

export const procedure = new Command()
  .name("procedure")
  .description("procedures (SOPs) — extract from activity, review drafts, match, schedule")

procedure.addCommand(extractCommand)
procedure.addCommand(watchCommand)

procedure
  .command("list")
  .description("list procedures with their trigger line")
  .option("--drafts", "list unreviewed drafts instead", false)
  .option("--all", "list active procedures and drafts", false)
  .action((opts) => {
    const store = new ProcedureStore()
    const items = [
      ...(opts.drafts ? [] : store.list()),
      ...(opts.drafts || opts.all ? store.listDrafts() : []),
    ]
    if (!items.length) {
      console.log(chalk.dim(
        opts.drafts
          ? "  no procedure drafts. Mine some with: agentx procedure extract"
          : "  no procedures yet. Try: agentx procedure extract · or: agentx procedure add",
      ))
      return
    }
    console.log()
    for (const p of items) {
      const status = p.meta.status === "active" ? chalk.green(p.meta.status) : p.meta.status === "draft" ? chalk.yellow(p.meta.status) : chalk.dim(p.meta.status)
      console.log(`  ${chalk.cyan(p.meta.id)}  ${chalk.bold(p.meta.title)}  ${status}`)
      console.log(`    ${chalk.dim("trigger:")} ${p.meta.trigger}`)
      if (p.meta.source) console.log(`    ${chalk.dim("source:")} ${chalk.dim(p.meta.source)}`)
      if (p.meta.kpis?.length) console.log(`    ${chalk.dim("kpis:")} ${p.meta.kpis.join(", ")}`)
    }
    console.log()
    console.log(chalk.dim(`  ${items.length} procedure${items.length === 1 ? "" : "s"}.`))
  })

procedure
  .command("add")
  .description("add a new procedure (non-interactive; pass all fields as flags)")
  .requiredOption("--id <id>", "procedure id (lower-kebab, e.g. deploy-clawd)")
  .requiredOption("--title <t>", "human-readable title")
  .requiredOption("--trigger <t>", "when this procedure applies (one sentence)")
  .option("--input <i...>", "required input (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
  .option("--expected <t>", "expected output / success criterion")
  .option("--kpi <k...>", "KPI (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
  .option("--owner <id>", "owning agent or person")
  .option("--tag <t...>", "tag (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
  .option("--related <r...>", "related procedure id or wiki article title (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
  .option("--steps <md>", "markdown body — usually numbered steps")
  .action((opts) => {
    const store = new ProcedureStore()
    const body = opts.steps
      ? String(opts.steps)
      : `## Steps\n\n1. (fill in)\n\n## Notes\n\n`
    try {
      const p = store.add({
        id: opts.id,
        title: opts.title,
        trigger: opts.trigger,
        inputs: opts.input || [],
        expected: opts.expected,
        kpis: opts.kpi || [],
        owner: opts.owner,
        tags: opts.tag || [],
        related: opts.related || [],
      } as any, body)
      console.log(chalk.green(`  ✓ procedure added: ${p.meta.id}`))
      console.log(chalk.dim(`    ${store.baseDir}/${p.path}`))
    } catch (e: any) {
      console.log(chalk.red(`  add failed: ${e.message}`))
      process.exit(1)
    }
  })

procedure
  .command("show <id>")
  .description("show a single procedure (active or draft)")
  .action((id: string) => {
    const store = new ProcedureStore()
    const p = store.get(id) ?? store.getDraft(id)
    if (!p) {
      console.log(chalk.yellow(`  no procedure matches "${id}". Try: agentx procedure list --all`))
      process.exit(1)
    }
    console.log()
    console.log(chalk.bold(`  ${p!.meta.title}`) + chalk.dim(`  (${p!.meta.id}, ${p!.meta.status})`))
    console.log(chalk.dim(`  trigger:  ${p!.meta.trigger}`))
    if (p!.meta.inputs?.length) console.log(chalk.dim(`  inputs:   ${p!.meta.inputs.join(", ")}`))
    if (p!.meta.expected) console.log(chalk.dim(`  expected: ${p!.meta.expected}`))
    if (p!.meta.kpis?.length) console.log(chalk.dim(`  kpis:     ${p!.meta.kpis.join(", ")}`))
    if (p!.meta.owner) console.log(chalk.dim(`  owner:    ${p!.meta.owner}`))
    if (p!.meta.source) console.log(chalk.dim(`  source:   ${p!.meta.source}`))
    if (p!.meta.related?.length) console.log(chalk.dim(`  related:  ${p!.meta.related.join(", ")}`))
    console.log()
    console.log(p!.body)
    console.log()
  })

procedure
  .command("promote <id>")
  .description("promote a draft into the active procedure set")
  .action((id: string) => {
    const store = new ProcedureStore()
    try {
      const p = store.promoteDraft(id)
      console.log(chalk.green(`  ✓ promoted: ${p.meta.id}`))
      console.log(chalk.dim(`    agents will now follow it when a task matches: "${p.meta.trigger}"`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

procedure
  .command("reject <id>")
  .description("reject a draft (kept under _drafts/_rejected/ so it is never re-mined)")
  .action((id: string) => {
    const store = new ProcedureStore()
    try {
      store.rejectDraft(id)
      console.log(chalk.green(`  ✓ rejected: ${id}`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

procedure
  .command("deprecate <id>")
  .description("retire an active procedure (kept, but never surfaced to agents)")
  .action((id: string) => {
    const store = new ProcedureStore()
    try {
      store.deprecate(id)
      console.log(chalk.green(`  ✓ deprecated: ${id}`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

procedure
  .command("match <text>")
  .description("find active procedures matching a task description")
  .option("--limit <n>", "max matches", "3")
  .option("--min-score <s>", "minimum score 0..1", "0.2")
  .action((text: string, opts) => {
    const store = new ProcedureStore()
    const matches = matchProcedures(text, store.list(), {
      limit: Number(opts.limit) || 3,
      minScore: Number(opts.minScore) || 0.2,
    })
    if (!matches.length) {
      console.log(chalk.dim("  no matching procedures"))
      return
    }
    for (const m of matches) {
      console.log(`  ${chalk.cyan(m.procedure.meta.id)}  ${chalk.bold(m.score.toFixed(2))}  ${chalk.dim(m.reasons.join(", "))}`)
      console.log(chalk.dim(`    ${m.procedure.meta.trigger}`))
    }
  })
