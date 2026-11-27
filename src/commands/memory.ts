import { Command } from "commander"
import chalk from "chalk"
import { readFileSync } from "fs"
import { existsSync, readdirSync } from "fs"
import { resolve } from "path"
import { AgentMemory, isReservedRuleName, RULE_PREFIX, type MemoryType } from "@/agents/agent-memory"
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
    if (isReservedRuleName(opts.name)) {
      console.error(chalk.red(`  --name may not start with ${RULE_PREFIX}: those names are kept for the fix rules the nightly pass writes (see agentx improve rules)`))
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

// --- agentx memory check — which notes carry a source and a check date ---
//
// Read only (#850). Reads the agent's notes from the AgentX store, or from
// another notes folder with --dir (such as the one a claude-code agent
// keeps), and lists each note with the `source` and `checked` fields it
// has or lacks.

memory
  .command("check")
  .description("list an agent's notes and whether each has a source and a check date")
  .requiredOption("--agent <id>", "agent id")
  .option("--dir <path>", "read notes from this folder instead of the AgentX store")
  .option("--missing", "list only notes missing a source or a check date")
  .option("--json", "print the result as JSON")
  .action(async (opts: { agent: string; dir?: string; missing?: boolean; json?: boolean }) => {
    const { readNotes } = await import("@/wiki/note-reader")
    const dir = opts.dir ? resolve(opts.dir) : new AgentMemory().dirOf(opts.agent)
    const read = readNotes(dir)
    const complete = read.notes.filter((n) => n.missing.length === 0)
    const shown = opts.missing ? read.notes.filter((n) => n.missing.length > 0) : read.notes
    if (opts.json) {
      console.log(JSON.stringify({ agent: opts.agent, ...read, notes: shown, complete: complete.length, total: read.notes.length }, null, 2))
      return
    }
    console.log()
    console.log(chalk.dim(`  ${dir}`))
    if (read.notes.length === 0) {
      console.log(chalk.dim(`  no notes for agent "${opts.agent}" in this folder`))
      console.log()
      return
    }
    for (const n of shown) {
      const mark = n.missing.length ? chalk.yellow("✗") : chalk.green("✓")
      const what = n.missing.length
        ? chalk.yellow(`no ${n.missing.join(", no ")}`)
        : chalk.dim(`${n.source} · checked ${n.checked}`)
      console.log(`  ${mark} ${chalk.cyan(n.name.padEnd(28))} ${what}`)
      for (const p of n.problems) console.log(chalk.dim(`      ${p}`))
    }
    for (const s of read.skipped) console.log(chalk.dim(`  - ${s.file}: ${s.reason}`))
    console.log()
    console.log(`  ${complete.length} of ${read.notes.length} note(s) have both a source and a check date.`)
    console.log()
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

facts
  .command("flag-unsourced")
  .description("mark facts about billing, accounts, outages or deploys that name no source as unverified; --apply writes (with a backup)")
  .option("--agent <id>", "one agent (default: all)")
  .option("--apply", "flag them (default: list only)")
  .action(async (opts: { agent?: string; apply?: boolean }) => {
    const { flagUnsourced } = await import("@/agents/memory-migrate")
    const store = new MemoryStore()
    let total = 0
    for (const id of factAgents(opts.agent)) {
      const r = flagUnsourced(store, id, { apply: !!opts.apply })
      if (r.flagged.length === 0) continue
      total += r.flagged.length
      console.log(`  ${chalk.bold(id)}  ${r.flagged.length}${r.backup ? chalk.dim(`  (backup: ${r.backup})`) : ""}`)
      for (const f of r.flagged.slice(0, 10)) console.log(chalk.dim(`    ${f.id} [${f.volatility}] ${f.content.slice(0, 100)}`))
    }
    console.log(opts.apply
      ? chalk.green(`  ✓ flagged ${total} fact(s) as unverified`)
      : chalk.dim(`  ${total} fact(s) state billing, account, outage or deploy state with no source. Run with --apply to flag them.`))
  })

// --- agentx memory tidy (#2117) ---
//
// `tidy`: what the nightly tidy would change (preview), or with --commit
// change it now. `tidy show <runId>`: one run's changes. `tidy undo
// <runId>`: put them back. `tidy list`: the latest runs.

memory
  .command("tidy")
  .description("merge duplicate facts and notes, drop expired and stale facts (preview unless --commit); also: tidy list | show <run> | undo <run>")
  .argument("[action]", "list, show or undo (default: run the tidy)")
  .argument("[run]", "run id, for show and undo")
  .option("--agent <id>", "one agent (default: all)")
  .option("--commit", "make the changes (default: list what would change)")
  .option("--change <n>", "undo only this change of the run")
  .option("--force", "undo even a change whose kept fact or note changed since, or an over-cap drop")
  .action(async (action: string | undefined, runId: string | undefined, opts: { agent?: string; commit?: boolean; change?: string; force?: boolean }) => {
    const { listRuns, showRun, undoRun, changeNote } = await import("@/improve/tidy")
    const store = new MemoryStore()
    const notes = new AgentMemory()
    if (action === "list") {
      const runs = listRuns(store, opts.agent).slice(0, 20)
      if (runs.length === 0) console.log(chalk.dim("  no tidy runs"))
      for (const r of runs) {
        const undone = r.changes.filter((c) => c.undoneAt).length
        console.log(`  ${chalk.cyan(r.runId)}  ${r.by}  ${r.changes.length} change(s)${undone ? chalk.dim(`, ${undone} undone`) : ""}`)
      }
      return
    }
    if (action === "show" || action === "undo") {
      if (!runId) { console.error(chalk.red(`  tidy ${action} needs a run id (see \`agentx memory tidy list\`)`)); process.exitCode = 1; return }
      if (action === "show") {
        const run = showRun(store, runId)
        if (!run) { console.error(chalk.red(`  no tidy run ${runId}`)); process.exitCode = 1; return }
        console.log(`  ${chalk.bold(run.agent)}  ${run.by} at ${run.at}${run.backup ? chalk.dim(`  (backup: ${run.backup})`) : ""}`)
        for (const c of run.changes) {
          const what = c.store === "fact"
            ? c.before.map((f) => f.content.slice(0, 100)).join(" | ")
            : c.before.map((n) => n.name).join(" + ")
          const note = changeNote(c)
          console.log(`  ${c.n}. ${c.store} ${c.action}${c.reason ? ` (${c.reason})` : ""}: ${what}${c.undoneAt ? chalk.dim(`  undone ${c.undoneAt}`) : ""}`)
          if (note) console.log(chalk.dim(`     ${note}`))
        }
        return
      }
      const change = opts.change === undefined ? undefined : Number(opts.change)
      if (change !== undefined && (!Number.isInteger(change) || change < 1)) {
        console.error(chalk.red(`  --change must be a change number, 1 or more`)); process.exitCode = 1; return
      }
      try {
        const r = undoRun(store, runId, { change, force: !!opts.force, notes })
        if (r.restored.length) console.log(chalk.green(`  ✓ put back change(s) ${r.restored.join(", ")}`))
        for (const s of r.skipped) console.log(chalk.yellow(`  skipped ${s.n}: ${s.why}`))
      } catch (e: any) {
        console.error(chalk.red(`  ${e?.message ?? e}`)); process.exitCode = 1
      }
      return
    }
    if (action !== undefined) { console.error(chalk.red(`  unknown tidy action "${action}": use list, show or undo`)); process.exitCode = 1; return }

    const [{ tidyStage }, { readImproveSettings }, { printTidy }] = await Promise.all([
      import("@/improve/tidy-stage"), import("@/improve/budget"), import("@/commands/improve"),
    ])
    const settings = readImproveSettings()
    // Note merges are model calls: by hand too, only with improve.enabled,
    // and booked in the same daily budget.
    const dbPath = resolve(process.cwd(), ".agentx/db.sqlite")
    const db = opts.commit && settings.enabled && existsSync(dbPath) ? new (await import("better-sqlite3")).default(dbPath) : undefined
    try {
      const { reviewWithClaudeCost } = await import("@/daemon/session-monitor")
      printTidy(await tidyStage({
        store, notes, settings, db, commit: !!opts.commit, agent: opts.agent, byHand: true,
        call: db ? (input, model, prompt) => reviewWithClaudeCost(input, model, undefined, prompt) : undefined,
      }))
    } finally {
      db?.close()
    }
    if (!opts.commit) console.log(chalk.dim("\n  Preview: nothing changed. Add --commit to make the changes."))
  })

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf-8")
}
