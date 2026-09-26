import { Command } from "commander"
import chalk from "chalk"
import { readFileSync } from "fs"
import { existsSync, readdirSync } from "fs"
import { resolve } from "path"
import { AgentMemory, type MemoryType } from "@/agents/agent-memory"
import { MemoryStore } from "@/agents/memory-store"

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

// --- agentx memory facts — the facts extracted after every reply ---
//
// A second, automatic memory: after each reply a small model pulls out
// facts and they are injected into later tasks by relevance. Facts from
// external sources wait here for review (see agents/memory-trust.ts), and
// credentials stored before extraction stopped keeping them can be purged.

const facts = memory
  .command("facts")
  .description("review facts extracted from conversations (held, approve, reject, scrub)")

/** Agents with an extracted-facts file, or the one asked for. */
function factAgents(agent?: string): string[] {
  if (agent) return [agent]
  const dir = resolve(process.cwd(), ".agentx/memory")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort()
}

facts
  .command("summary")
  .description("count facts per agent by source trust and review state")
  .option("--agent <id>", "one agent (default: all)")
  .action((opts: { agent?: string }) => {
    const store = new MemoryStore()
    for (const id of factAgents(opts.agent)) {
      const counts = Object.entries(store.trustSummary(id)).map(([k, n]) => `${k}: ${n}`).join(", ")
      console.log(`  ${chalk.bold(id)}  ${counts || chalk.dim("(none)")}`)
    }
  })

facts
  .command("held")
  .description("list facts waiting for review before they are used")
  .option("--agent <id>", "one agent (default: all)")
  .action((opts: { agent?: string }) => {
    const store = new MemoryStore()
    let total = 0
    for (const id of factAgents(opts.agent)) {
      for (const f of store.held(id)) {
        total++
        console.log(`  ${chalk.bold(id)} ${chalk.cyan(f.id)}  ${chalk.dim(`${f.source.channel} · ${f.source.date}`)}`)
        console.log(`    ${f.content}`)
      }
    }
    if (total === 0) console.log(chalk.dim("  nothing held"))
  })

for (const decision of ["approve", "reject"] as const) {
  facts
    .command(decision)
    .description(decision === "approve"
      ? "let a held fact be used in prompts"
      : "keep a held fact out of prompts for good")
    .requiredOption("--agent <id>", "agent id")
    .argument("<id>", "fact id (from `agentx memory facts held`)")
    .action((id: string, opts: { agent: string }) => {
      const store = new MemoryStore()
      if (!store.review(opts.agent, id, decision === "approve" ? "approved" : "rejected")) {
        console.error(chalk.red(`  no fact "${id}" for agent "${opts.agent}"`))
        process.exitCode = 1; return
      }
      console.log(chalk.green(`  ✓ ${id} ${decision === "approve" ? "approved" : "rejected"}`))
    })
}

facts
  .command("scrub")
  .description("find stored facts that contain credentials; --apply deletes them")
  .option("--agent <id>", "one agent (default: all)")
  .option("--apply", "delete them (default: count only)")
  .action((opts: { agent?: string; apply?: boolean }) => {
    const store = new MemoryStore()
    let total = 0
    for (const id of factAgents(opts.agent)) {
      const n = store.scrubSecrets(id, !!opts.apply)
      if (n) console.log(`  ${chalk.bold(id)}  ${n}`)
      total += n
    }
    console.log(opts.apply
      ? chalk.green(`  ✓ deleted ${total} fact(s) containing credentials`)
      : chalk.dim(`  ${total} fact(s) contain credentials (never injected). Run with --apply to delete them.`))
  })

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf-8")
}
