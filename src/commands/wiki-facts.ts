import type { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"
import { FACT_CLASSES, isFactClass } from "@/agents/fact-freshness"

// --- agentx wiki facts: the fact ledger, its proposals and checks (#273) ---
//
// `set` is how an agent (or a person) records a fact it has just checked.
// `proposals` holds claims from session summaries until a person approves
// or rejects them. A contradicting write lands on `agentx wiki questions`.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")

async function ledgerFor(dir?: string) {
  const { FactLedger } = await import("@/wiki/facts/ledger")
  return new FactLedger(wikiDir(dir))
}

/** A damaged ledger or a busy lock is a message for a person, not a stack trace. */
function safe<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (e: any) {
      if (e?.name !== "LedgerCorruptError") console.error(chalk.red(`  ${e?.message ?? e}`))
      process.exitCode = 1
    }
  }
}

export function registerWikiFacts(wiki: Command): void {
  const facts = wiki
    .command("facts")
    .description("facts with a source and a check date: list, show, set, proposals")

  facts
    .command("list")
    .description("every recorded fact, with where and when it was checked")
    .option("--dir <path>", "wiki directory")
    .option("--stale", "only facts past their time limit, or never checked")
    .option("--json")
    .action(safe(async (opts) => {
      const { isStaleFact } = await import("@/wiki/facts/ledger")
      const all = (await ledgerFor(opts.dir)).list().filter((f) => !opts.stale || isStaleFact(f))
      if (opts.json) { console.log(JSON.stringify(all, null, 2)); return }
      if (all.length === 0) { console.log(chalk.dim("  no facts recorded")); return }
      for (const f of all) {
        const stale = f.undated ? chalk.yellow(" UNCHECKED") : isStaleFact(f) ? chalk.yellow(" STALE") : ""
        console.log(`  ${chalk.cyan(f.id)} ${chalk.bold(f.subject)} · ${f.attribute}: ${f.value}${stale}`)
        console.log(chalk.dim(`    ${f.volatility} · ${f.source} · checked ${f.verifiedAt.slice(0, 10)} by ${f.verifiedBy}`))
      }
    }))

  facts
    .command("show <id>")
    .description("one fact, with its earlier values")
    .option("--dir <path>", "wiki directory")
    .action(safe(async (id, opts) => {
      const f = (await ledgerFor(opts.dir)).get(id)
      if (!f) { console.error(chalk.red(`  no fact "${id}"`)); process.exitCode = 1; return }
      console.log(JSON.stringify(f, null, 2))
    }))

  facts
    .command("set")
    .description("record a fact you checked; a different value needs a newer --checked-at, or --confirm by a person")
    .requiredOption("--subject <text>", "what the fact is about, e.g. \"vendor account\"")
    .requiredOption("--attribute <text>", "which property, e.g. \"billing status\"")
    .requiredOption("--value <text>", "the value you found")
    .requiredOption("--source <text>", "where you checked: a system, URL, command, or \"owner said\"")
    .option("--by <id>", "who checked it (agent id or person)", process.env.AGENTX_AGENT_ID || "operator")
    .option("--checked-at <iso>", "when you checked it: an ISO date, or \"now\". Without it the value can't replace a different one already recorded")
    .option("--class <class>", `volatility class: ${FACT_CLASSES.join(" | ")}`)
    .option("--ttl-days <n>", "days it stays trusted, overriding the class")
    .option("--confirm", "a person confirms this value: replace a newer-dated one")
    .option("--dir <path>", "wiki directory")
    .action(safe(async (opts) => {
      if (opts.class && !isFactClass(opts.class)) {
        console.error(chalk.red(`  --class must be one of ${FACT_CLASSES.join(", ")}`)); process.exitCode = 1; return
      }
      const ledger = await ledgerFor(opts.dir)
      const r = ledger.write({
        subject: opts.subject, attribute: opts.attribute, value: opts.value, source: opts.source,
        verifiedBy: opts.by, verifiedAt: opts.checkedAt, volatility: opts.class,
        ttlDays: opts.ttlDays !== undefined ? Number(opts.ttlDays) : undefined,
      }, opts.confirm ? { confirmedBy: opts.by } : {})
      if (r.status === "contradiction") {
        const why = r.fact.confirmedBy
          ? `${r.fact.confirmedBy} confirmed it, so only a person can change it`
          : opts.checkedAt ? "and this check is not newer" : "and this value has no --checked-at"
        console.log(chalk.yellow(`  not replaced: the wiki says "${r.fact.value}" (checked ${r.fact.verifiedAt.slice(0, 10)}), ${why}.`))
        console.log(r.questionId
          ? chalk.dim(`  Queued question ${r.questionId}: agentx wiki questions  ·  agentx wiki answer ${r.questionId} "<true value>"`)
          : chalk.red("  No question could be queued: the questions file is unreadable. Repair .agentx/wiki/_questions.json."))
        process.exitCode = 2
        return
      }
      console.log(chalk.green(`  ${r.status}: ${r.fact.id} ${r.fact.subject} · ${r.fact.attribute}: ${r.fact.value}`))
    }))

  const proposals = facts
    .command("proposals")
    .description("claims from session summaries, waiting for a check (list, approve, reject)")

  proposals
    .command("list")
    .description("claims waiting for a check (pending by default)")
    .option("--dir <path>", "wiki directory")
    .option("--all", "include approved and rejected")
    .option("--json")
    .action(safe(async (opts) => {
      const { listFactProposals } = await import("@/wiki/facts/fact-proposals")
      const list = listFactProposals(await ledgerFor(opts.dir), opts.all ? undefined : "pending")
      if (opts.json) { console.log(JSON.stringify(list, null, 2)); return }
      if (list.length === 0) { console.log(chalk.dim("  no fact proposals waiting")); return }
      for (const p of list) {
        console.log(`  ${chalk.cyan(p.id)} ${p.status === "pending" ? "" : chalk.dim(`[${p.status}] `)}${p.claim}`)
        console.log(chalk.dim(`    ${p.agentId} · ${p.origin} · ${p.source} · ${p.verifiedAt.slice(0, 10)}`))
      }
      console.log(chalk.dim("\n  Check each claim at its source, then: agentx wiki facts proposals approve <id>  ·  reject <id>"))
    }))

  proposals
    .command("approve <id>")
    .description("confirm a claim and record it as a fact")
    .option("--subject <text>", "correct the subject read from the claim")
    .option("--attribute <text>", "correct the attribute")
    .option("--value <text>", "correct the value")
    .option("--source <text>", "where you checked it")
    .option("--by <id>", "who confirms it", "operator")
    .option("--dir <path>", "wiki directory")
    .action(safe(async (id, opts) => {
      const { approveFactProposal } = await import("@/wiki/facts/fact-proposals")
      const { write } = approveFactProposal(await ledgerFor(opts.dir), id, opts.by, {
        subject: opts.subject, attribute: opts.attribute, value: opts.value, source: opts.source,
      })
      console.log(chalk.green(`  ${write.status}: ${write.fact.id} ${write.fact.subject} · ${write.fact.attribute}: ${write.fact.value}`))
    }))

  proposals
    .command("reject <id>")
    .description("drop a claim; it is not recorded")
    .option("--reason <text>", "why, kept with the decision")
    .option("--by <id>", "who rejects it", "operator")
    .option("--dir <path>", "wiki directory")
    .action(safe(async (id, opts) => {
      const { rejectFactProposal } = await import("@/wiki/facts/fact-proposals")
      const p = rejectFactProposal(await ledgerFor(opts.dir), id, opts.by, opts.reason)
      console.log(chalk.dim(`  rejected: ${p.claim}`))
    }))
}
