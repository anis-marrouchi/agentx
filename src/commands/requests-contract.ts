import { Command } from "commander"
import { existsSync } from "fs"
import chalk from "chalk"
import { openDb } from "@/storage/sqlite"
import { findConfigPath } from "@/daemon/config-mutator"
import { loadDaemonConfig } from "@/daemon/config"
import { measureContract, parseSpan, pct, type ContractReport } from "@/requests/contract"

// --- agentx requests contract — the hand-back contract, measured (#1509) ---
//
// Prints the five numbers of what agents owe the owner when they deliver
// or go quiet, per agent and for this node, and with --dry-run what the
// next steps would have written. Read only: it tells nobody and writes
// nothing.

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"

function num(raw: string, name: string, min: number, max: number): number | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(chalk.red(`  ${name} must be a number from ${min} to ${max}`))
    process.exitCode = 1
    return null
  }
  return n
}

function print(r: ContractReport, dryRun: boolean): void {
  console.log(chalk.bold(`\n  Hand-back contract · ${when(r.since)} to ${when(r.until)}`))
  const channels = Object.entries(r.turnsByChannel).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")
  console.log(chalk.dim(`  Turns by channel: ${channels || "none"}`))

  console.log(chalk.bold("\n  Five numbers"))
  const row = (name: string, value: string, target: string, note = "") => console.log(`  ${name.padEnd(16)} ${value.padEnd(24)} ${chalk.dim(`target ${target}${note ? ` · ${note}` : ""}`)}`)
  row("Chain coverage", `${pct(r.chain.turns)} (${r.chain.turns.n}/${r.chain.turns.of} turns)`, "≥ 95 %",
    `${pct(r.chain.chats)} of chats; with inherited requests ${pct(r.chain.inherited.turns)} of turns`)
  row("Delivery reach", `${pct(r.delivery.reached)} (${r.delivery.reached.n}/${r.delivery.reached.of})`, "≥ 90 %",
    `told with a link within ${r.settings.deliverWithinMinutes} min`)
  const proofOf = r.proof.link + r.proof.path + r.proof.none
  row("Openable proof", `${pct({ n: r.proof.link, of: proofOf })} (${r.proof.link}/${proofOf})`, "≥ 90 %",
    `link ${r.proof.link}, path ${r.proof.path}, none ${r.proof.none}, other ${r.proof.other}`)
  row("Quiet breaches", String(r.quiet.breaches), "0", `of ${r.quiet.open} open, past ${r.settings.rhythmHours} h with no change`)
  const peak = Math.max(0, ...Object.values(r.pulls.byDay))
  row("Status pulls", String(r.pulls.pulls), "trending to 0", `of ${r.pulls.ownerTurns} owner turns, peak ${peak} a day`)

  console.log(chalk.bold("\n  Around them"))
  console.log(`  Outputs that name a link or a path: ${r.delivery.outputs}; a path and no link: ${chalk.yellow(String(r.delivery.pathOnly))}; in a request's chain: ${r.delivery.inChain}`)
  console.log(`  Closed: ${r.proof.toldAtClose.of}; owner told at or after close: ${r.proof.toldAtClose.n} (${pct(r.proof.toldAtClose)}); dropped: ${r.proof.dropped}`)
  const outcomes = Object.entries(r.told.outcomes).map(([o, n]) => `${o} ${n}`).join(", ")
  console.log(`  Owner told: ${r.told.rows} row(s), seen ${r.told.seen}${outcomes ? ` · ${outcomes}` : ""}`)

  const agents = r.agents.filter((a) => a.a2aTurns || a.outputs || a.told)
  if (agents.length) {
    console.log(chalk.bold("\n  Per agent") + chalk.dim("  (a2a turns · linked · would inherit · outputs · path only · told)"))
    for (const a of agents) {
      const silent = a.a2aTurns >= 20 && a.told === 0
      const line = `  ${a.agent.padEnd(24)} ${String(a.a2aTurns).padStart(5)} ${String(a.linkedTurns).padStart(6)} ${String(a.chainTurns).padStart(6)} ${String(a.outputs).padStart(6)} ${String(a.pathOnlyOutputs).padStart(6)} ${String(a.told).padStart(5)}`
      console.log(silent ? chalk.yellow(line + "  ← never tells the owner") : line)
    }
  }

  if (dryRun) {
    console.log(chalk.bold("\n  Step 1 would link these hops to a request"))
    if (!r.dryRun.hops.length) console.log(chalk.dim("  none"))
    for (const h of r.dryRun.hops) console.log(`  ${h.chat} ${chalk.dim(`(${h.agent}, from ${h.via})`)} → ${chalk.cyan(h.requestId)}`)
    console.log(chalk.bold("\n  Step 2 would put these outputs on their request"))
    if (!r.dryRun.outputs.length) console.log(chalk.dim("  none"))
    for (const o of r.dryRun.outputs) {
      const kind = o.kind === "path" ? chalk.yellow("path → served link") : "link"
      console.log(`  ${chalk.cyan(o.requestId)} ${chalk.dim(`${when(o.at)} · ${o.agent} · ${o.reached ? "told" : "not told"}`)} ${kind} ${o.output}`)
    }
    console.log(chalk.bold("\n  Step 3 would write these status lines"))
    if (!r.dryRun.quiet.length) console.log(chalk.dim("  none"))
    for (const q of r.dryRun.quiet) {
      console.log(`  ${chalk.cyan(q.requestId)} ${chalk.dim(`${q.state} · quiet ${q.quietHours} h${q.push ? " · would push" : ""}`)}`)
      console.log(`    ${q.line}`)
    }
  }
  console.log(chalk.dim("\n  Read only: nothing was told or written."))
}

export const contract = new Command("contract")
  .description("measure what agents owe you when they deliver or go quiet: five numbers per agent and for this node (read only)")
  .option("--since <span>", "how far back, as 90m, 36h or 7d", "7d")
  .option("--agent <id>", "only this agent's turns and requests")
  .option("--deliver-within <minutes>", "an output counts as delivered when you were told within this", "10")
  .option("--rhythm <hours>", "an open request with no change you can see for this long is quiet", "2")
  .option("--push-after <hours>", "past this, a quiet request's status line would also be pushed", "6")
  .option("--dry-run", "also list what the next steps would have written: inherited hops, outputs, status lines")
  .option("--limit <n>", "rows in each dry-run list", "20")
  .option("--json", "machine-readable output")
  .action((opts: { since: string; agent?: string; deliverWithin: string; rhythm: string; pushAfter: string; dryRun?: boolean; limit: string; json?: boolean }) => {
    const span = parseSpan(opts.since)
    if (span === null || span > 90 * 86_400_000) { console.error(chalk.red("  --since takes a span such as 90m, 36h or 7d, up to 90d")); process.exitCode = 1; return }
    const deliverWithinMinutes = num(opts.deliverWithin, "--deliver-within", 1, 1440)
    const rhythmHours = num(opts.rhythm, "--rhythm", 0.25, 720)
    const pushAfterHours = num(opts.pushAfter, "--push-after", 0.25, 720)
    const sample = num(opts.limit, "--limit", 1, 500)
    if (deliverWithinMinutes === null || rhythmHours === null || pushAfterHours === null || sample === null) return
    // openDb creates the file: never in a folder that is not a node's.
    if (!existsSync(findConfigPath())) { console.error(chalk.red("  no agentx.json here: run this from the install folder, the one that holds agentx.json")); process.exitCode = 1; return }
    const db = openDb({ quiet: true })
    if (!db) { process.exitCode = 1; return }
    let ownerIds: string[] = []
    try { ownerIds = (loadDaemonConfig().people ?? []).filter((p) => p.role === "owner").map((p) => p.id) } catch { /* no people: the implicit owner only */ }
    const until = Date.now()
    const report = measureContract(db, {
      since: until - span, until, deliverWithinMinutes, rhythmHours, pushAfterHours, ownerIds, agent: opts.agent, sample: Math.floor(sample),
    })
    if (opts.json) { console.log(JSON.stringify(opts.dryRun ? report : { ...report, dryRun: undefined }, null, 2)); return }
    print(report, !!opts.dryRun)
  })
