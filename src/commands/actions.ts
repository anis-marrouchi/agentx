import { Command } from "commander"
import chalk from "chalk"
import { ActionStore } from "@/actions/store"
import { runAction } from "@/actions/runner"
import { actionSchema, type Action } from "@/actions/types"

// --- agentx actions — manage the action registry ---
//
// Closes the last outstanding parity audit gap: a registry of named,
// parameterized invocations that workflows / CLI / dashboard can call
// instead of hardcoding shell/http calls per use site.
//
// Two action kinds in v1:
//   shell  — exec a command (cwd-aware, env-merge, template inputs)
//   http   — fetch a URL with method/headers/body
//
// Storage: .agentx/actions/<id>.json (one file per action).

export const actions = new Command()
  .name("actions")
  .description("manage the action registry — reusable shell/http invocations")

actions
  .command("list")
  .description("list registered actions")
  .option("--json", "JSON output")
  .action((opts) => {
    const store = new ActionStore()
    const list = store.list()
    if (opts.json) { console.log(JSON.stringify(list, null, 2)); return }
    if (list.length === 0) {
      console.log()
      console.log(chalk.dim("  No actions yet. Add one with `agentx actions add` or `agentx actions create`."))
      console.log()
      return
    }
    console.log()
    for (const a of list) {
      const inputs = a.inputs?.length ? chalk.dim(` (${a.inputs.length} input${a.inputs.length === 1 ? "" : "s"})`) : ""
      const target = a.kind === "shell" ? `shell: ${a.command.slice(0, 50)}` : `${a.method} ${a.url.slice(0, 50)}`
      console.log(`  ${chalk.cyan(a.id.padEnd(24))} ${a.title}${inputs}`)
      console.log(`  ${" ".repeat(24)} ${chalk.dim(target)}`)
    }
    console.log()
  })

actions
  .command("show <id>")
  .description("show an action's full definition")
  .option("--json", "JSON output")
  .action((id: string, opts) => {
    const store = new ActionStore()
    const a = store.get(id)
    if (!a) { console.log(chalk.red(`  no action "${id}"`)); process.exit(1) }
    if (opts.json) { console.log(JSON.stringify(a, null, 2)); return }
    console.log()
    console.log(chalk.bold(`  ${a.title}`))
    if (a.description) console.log(chalk.dim(`  ${a.description}`))
    console.log()
    console.log(`  id        ${a.id}`)
    console.log(`  kind      ${a.kind}`)
    console.log(`  timeout   ${a.timeoutMs}ms`)
    if (a.kind === "shell") {
      console.log(`  command   ${a.command}`)
      if (a.cwd) console.log(`  cwd       ${a.cwd}`)
      if (a.env) console.log(`  env       ${JSON.stringify(a.env)}`)
    } else {
      console.log(`  ${a.method.padEnd(9)} ${a.url}`)
      if (a.headers) console.log(`  headers   ${JSON.stringify(a.headers)}`)
      if (a.body) console.log(`  body      ${a.body.slice(0, 200)}`)
    }
    if (a.inputs.length) {
      console.log()
      console.log(chalk.bold("  Inputs:"))
      for (const inp of a.inputs) {
        const req = inp.required ? chalk.red("*") : " "
        const def = inp.defaultValue !== undefined ? chalk.dim(` default=${JSON.stringify(inp.defaultValue)}`) : ""
        const desc = inp.description ? chalk.dim(` — ${inp.description}`) : ""
        console.log(`   ${req} ${chalk.cyan(inp.name)} (${inp.type})${def}${desc}`)
      }
    }
    console.log()
  })

actions
  .command("add <id>")
  .description("add (or replace) an action non-interactively")
  .requiredOption("--title <text>")
  .requiredOption("--kind <kind>", "shell | http")
  .option("--description <text>")
  .option("--command <text>", "[shell] templated shell command")
  .option("--cwd <path>", "[shell] working directory")
  .option("--url <url>", "[http] URL")
  .option("--method <m>", "[http] GET|POST|PUT|PATCH|DELETE", "POST")
  .option("--headers <json>", "[http] headers as JSON object")
  .option("--body <text>", "[http] body template")
  .option("--inputs <csv>", "comma-separated list of name:type[!] (e.g. amount:number!,note:string)")
  .option("--timeout <ms>", "timeout in ms (default 30000)", "30000")
  .action((id: string, opts) => {
    const inputs = parseInputsCsv(opts.inputs)
    const base: any = {
      id, title: opts.title, description: opts.description, inputs,
      timeoutMs: parseInt(opts.timeout, 10) || 30_000,
      kind: opts.kind,
    }
    if (opts.kind === "shell") {
      if (!opts.command) { console.log(chalk.red("  --command required for kind=shell")); process.exit(1) }
      base.command = opts.command
      if (opts.cwd) base.cwd = opts.cwd
    } else if (opts.kind === "http") {
      if (!opts.url) { console.log(chalk.red("  --url required for kind=http")); process.exit(1) }
      base.url = opts.url
      base.method = opts.method
      if (opts.headers) {
        try { base.headers = JSON.parse(opts.headers) }
        catch { console.log(chalk.red("  --headers must be valid JSON")); process.exit(1) }
      }
      if (opts.body) base.body = opts.body
    } else {
      console.log(chalk.red("  --kind must be shell|http"))
      process.exit(1)
    }
    const parsed = actionSchema.safeParse(base)
    if (!parsed.success) {
      console.log(chalk.red("  validation failed:"))
      for (const issue of parsed.error.issues) console.log(chalk.red(`    ${issue.path.join(".")}: ${issue.message}`))
      process.exit(1)
    }
    const store = new ActionStore()
    const saved = store.save(parsed.data)
    console.log(chalk.green(`\n  ✓ action "${saved.id}" saved (${saved.kind}).`))
    console.log(chalk.dim(`  Test: agentx actions run ${saved.id}\n`))
  })

actions
  .command("remove <id>")
  .alias("rm")
  .description("delete an action")
  .action((id: string) => {
    const store = new ActionStore()
    if (!store.delete(id)) { console.log(chalk.red(`  no action "${id}"`)); process.exit(1) }
    console.log(chalk.green(`  ✓ action "${id}" removed`))
  })

actions
  .command("run <id>")
  .description("invoke an action and print its output")
  .option("--input <kv...>", "input as key=value (repeat for each)")
  .option("--json", "JSON output (full ActionRunResult)")
  .action(async (id: string, opts) => {
    const store = new ActionStore()
    const action = store.get(id)
    if (!action) { console.log(chalk.red(`  no action "${id}"`)); process.exit(1) }
    const inputs: Record<string, string> = {}
    for (const kv of (opts.input || []) as string[]) {
      const eq = kv.indexOf("=")
      if (eq < 0) { console.log(chalk.red(`  --input "${kv}" must be key=value`)); process.exit(1) }
      inputs[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
    try {
      const result = await runAction(action as Action, inputs)
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log()
      console.log(`  ${result.ok ? chalk.green("✓ ok") : chalk.red("✗ failed")}  status=${result.status}  ${result.durationMs}ms`)
      console.log()
      if (result.output) {
        console.log(chalk.dim("  --- output ---"))
        console.log(result.output)
      }
      if (result.errors) {
        console.log(chalk.dim("  --- errors ---"))
        console.log(chalk.red(result.errors))
      }
      console.log()
      if (!result.ok) process.exit(1)
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

/** Parse the --inputs CSV: name:type[!],name:type. `!` marks required. */
function parseInputsCsv(csv: string | undefined): Action["inputs"] {
  if (!csv) return []
  const out: Action["inputs"] = []
  for (const part of csv.split(",").map((s) => s.trim()).filter(Boolean)) {
    const required = part.endsWith("!")
    const clean = required ? part.slice(0, -1) : part
    const colon = clean.indexOf(":")
    const name = colon >= 0 ? clean.slice(0, colon) : clean
    const type = (colon >= 0 ? clean.slice(colon + 1) : "string") as "string" | "number" | "boolean"
    out.push({ name, type, required })
  }
  return out
}
