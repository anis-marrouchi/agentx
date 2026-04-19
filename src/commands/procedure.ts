import { Command } from "commander"
import chalk from "chalk"
import { ProcedureStore } from "@/procedures"

// --- agentx procedure — SOP definitions (foundation) ---
//
// v1: list / add / show. Delta extraction (per-run one-liner deltas against
// the SOP, cheap O(runs)) is deferred. The data model lives here so those
// later features have a stable shape to write against.

export const procedure = new Command()
  .name("procedure")
  .description("procedures (SOPs) — list, add, show · delta extraction coming later")

procedure
  .command("list")
  .description("list all procedures with their trigger line")
  .action(() => {
    const store = new ProcedureStore()
    const items = store.list()
    if (!items.length) {
      console.log(chalk.dim("  no procedures yet. Add one with: agentx procedure add"))
      return
    }
    console.log()
    for (const p of items) {
      console.log(`  ${chalk.cyan(p.meta.id)}  ${chalk.bold(p.meta.title)}`)
      console.log(`    ${chalk.dim("trigger:")} ${p.meta.trigger}`)
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
  .description("show a single procedure")
  .action((id: string) => {
    const store = new ProcedureStore()
    const p = store.get(id)
    if (!p) {
      console.log(chalk.yellow(`  no procedure matches "${id}". Try: agentx procedure list`))
      process.exit(1)
    }
    console.log()
    console.log(chalk.bold(`  ${p!.meta.title}`) + chalk.dim(`  (${p!.meta.id})`))
    console.log(chalk.dim(`  trigger:  ${p!.meta.trigger}`))
    if (p!.meta.inputs?.length) console.log(chalk.dim(`  inputs:   ${p!.meta.inputs.join(", ")}`))
    if (p!.meta.expected) console.log(chalk.dim(`  expected: ${p!.meta.expected}`))
    if (p!.meta.kpis?.length) console.log(chalk.dim(`  kpis:     ${p!.meta.kpis.join(", ")}`))
    if (p!.meta.owner) console.log(chalk.dim(`  owner:    ${p!.meta.owner}`))
    if (p!.meta.related?.length) console.log(chalk.dim(`  related:  ${p!.meta.related.join(", ")}`))
    console.log()
    console.log(p!.body)
    console.log()
  })
