import { Command } from "commander"
import chalk from "chalk"
import { readFileSync } from "fs"
import { AgentMemory, type MemoryType } from "@/agents/agent-memory"

// --- agentx memory — audit + edit an agent's structured memory ---
//
// Structured memory is Claude-Code-style:
//   user:      who the user is, their role, preferences
//   feedback:  rules the user gave me; what to do / avoid
//   project:   facts about current work the code can't reveal
//   reference: pointers to external systems (linear, grafana, …)
//
// Each entry is a small markdown file with frontmatter. MEMORY.md is
// auto-generated as the index and inlined into every task's system
// prompt, so agents see everything they've learned on every turn.

const VALID_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"]

export const memory = new Command()
  .name("memory")
  .description("audit + edit agent-memory (per-agent experiential notes)")

memory
  .command("add")
  .description("add a memory for an agent")
  .requiredOption("--agent <id>", "agent id")
  .requiredOption("--type <type>", "one of: user, feedback, project, reference")
  .requiredOption("--name <slug>", "short slug, unique per agent (e.g. deep-backend)")
  .requiredOption("--description <line>", "one-line hook shown in MEMORY.md")
  .option("--body <text>", "memory body (markdown); repeat --body or use --file")
  .option("--file <path>", "read body from a file (use '-' for stdin)")
  .action(async (opts: { agent: string; type: string; name: string; description: string; body?: string; file?: string }) => {
    if (!VALID_TYPES.includes(opts.type as MemoryType)) {
      console.error(chalk.red(`  --type must be one of: ${VALID_TYPES.join(", ")}`))
      process.exitCode = 1; return
    }
    let body = opts.body ?? ""
    if (opts.file) {
      if (opts.file === "-") {
        body = await readStdin()
      } else {
        try { body = readFileSync(opts.file, "utf-8") }
        catch (e: any) { console.error(chalk.red(`  could not read --file: ${e.message}`)); process.exitCode = 1; return }
      }
    }
    if (!body.trim()) {
      console.error(chalk.red("  memory body is required (use --body or --file)"))
      process.exitCode = 1; return
    }
    const store = new AgentMemory()
    const rec = store.save({
      agentId: opts.agent,
      type: opts.type as MemoryType,
      name: opts.name,
      description: opts.description,
      body,
    })
    console.log(chalk.green(`  ✓ memory "${rec.name}" saved (${rec.type}) for agent ${opts.agent}`))
  })

memory
  .command("list")
  .description("list memories for an agent")
  .requiredOption("--agent <id>", "agent id")
  .option("--type <type>", "filter by memory type")
  .action((opts: { agent: string; type?: string }) => {
    const store = new AgentMemory()
    let records = store.list(opts.agent)
    if (opts.type) {
      if (!VALID_TYPES.includes(opts.type as MemoryType)) {
        console.error(chalk.red(`  --type must be one of: ${VALID_TYPES.join(", ")}`))
        process.exitCode = 1; return
      }
      records = records.filter((r) => r.type === opts.type)
    }
    if (!records.length) {
      console.log(chalk.dim(`  no memories for agent "${opts.agent}"${opts.type ? ` of type "${opts.type}"` : ""}`))
      return
    }
    console.log()
    let currentType: string | null = null
    for (const r of records) {
      if (r.type !== currentType) {
        console.log(chalk.bold(`  ${r.type}`))
        currentType = r.type
      }
      console.log(`    ${chalk.cyan(r.name.padEnd(28))}  ${r.description}`)
    }
    console.log()
    console.log(chalk.dim(`  ${records.length} memor${records.length === 1 ? "y" : "ies"} for ${opts.agent}`))
  })

memory
  .command("show")
  .description("print the full body of a memory")
  .requiredOption("--agent <id>", "agent id")
  .argument("<name>", "memory name (slug)")
  .action((name: string, opts: { agent: string }) => {
    const store = new AgentMemory()
    const rec = store.get(opts.agent, name)
    if (!rec) {
      console.error(chalk.red(`  no memory "${name}" for agent "${opts.agent}"`))
      process.exitCode = 1; return
    }
    console.log(chalk.bold(`${rec.type}/${rec.name}`) + chalk.dim(`  (${rec.description})`))
    console.log(chalk.dim(`  updated ${rec.updatedAt}`))
    console.log()
    console.log(rec.body)
  })

memory
  .command("remove")
  .alias("rm")
  .description("remove a memory")
  .requiredOption("--agent <id>", "agent id")
  .argument("<name>", "memory name (slug)")
  .action((name: string, opts: { agent: string }) => {
    const store = new AgentMemory()
    if (!store.remove(opts.agent, name)) {
      console.error(chalk.red(`  no memory "${name}" for agent "${opts.agent}"`))
      process.exitCode = 1; return
    }
    console.log(chalk.green(`  ✓ memory "${name}" removed`))
  })

memory
  .command("index")
  .description("print the MEMORY.md index content an agent sees in its prompt")
  .requiredOption("--agent <id>", "agent id")
  .action((opts: { agent: string }) => {
    const store = new AgentMemory()
    const md = store.indexMarkdown(opts.agent)
    if (!md) {
      console.log(chalk.dim(`  (no memories — MEMORY.md is empty for agent "${opts.agent}")`))
      return
    }
    console.log(md)
  })

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf-8")
}
