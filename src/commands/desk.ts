import { existsSync, readFileSync } from "fs"
import { Command } from "commander"
import chalk from "chalk"
import { readApprovalSettings } from "@/approvals/settings"
import { buildDesk, DESK_COLUMNS, type DeskCard, type DeskColumn, type DeskTask } from "@/desk/card"
import { deskAct, type DeskActInput, type DeskActResult } from "@/desk/act"
import { readDeskSource } from "@/desk/read"
import { daemonCallAgent } from "@/daemon/desk-panel"
import { findConfigPath } from "@/daemon/config-mutator"
import { loadOperatorKey } from "@/requests/operator"
import { daemon } from "./call"

// --- agentx desk — the owner's desk on this computer (#959) ---
//
//   agentx desk [--column yours|agent|quiet|done] [--json]
//   agentx desk answer <key> <option> [--text "…"]
//   agentx desk write <key> "<text>"
//   agentx desk defer <key>
//   agentx desk call <key> [--agent <id>]
//
// The same cards and the same four actions as the phone app's Desk tab
// (src/desk), for the sources on this computer. The phone app joins every
// computer the dashboard reads.

const DAEMON = process.env.AGENTX_DAEMON_URL ?? "http://127.0.0.1:18800"

const COLUMN_TITLE: Record<DeskColumn, string> = {
  yours: "Your turn",
  agent: "With an agent",
  quiet: "No news",
  done: "Done (7 days)",
}

function ctx() {
  return { root: process.cwd() }
}

/** Running turns from this computer's daemon; none when it does not answer. */
async function runningTasks(): Promise<{ tasks: DeskTask[]; error?: string }> {
  try {
    const agents = await daemon("GET", "/agents") as Array<{ id: string; name?: string; runningTasks?: Array<{ id: string; messagePreview?: string; startedAt: string }> }>
    const tasks: DeskTask[] = []
    for (const a of Array.isArray(agents) ? agents : []) {
      for (const t of a.runningTasks ?? []) {
        tasks.push({ node: DAEMON, nodeName: "this computer", taskId: t.id, agentId: a.id, agentName: a.name, preview: t.messagePreview, startedAt: t.startedAt })
      }
    }
    return { tasks }
  } catch (e: any) {
    return { tasks: [], error: e?.message ?? String(e) }
  }
}

function quietHours(): number {
  try {
    const path = findConfigPath()
    const cfg = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {}
    const h = cfg?.desk?.quietHours
    return typeof h === "number" && h > 0 ? h : 3
  } catch {
    return 3
  }
}

function age(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} d`
}

function printCard(c: DeskCard): void {
  const mark = c.deferredUntil ? chalk.dim(` (later: until ${c.deferredUntil.slice(0, 16).replace("T", " ")} UTC)`) : c.attention ? chalk.yellow(" (needs you)") : ""
  console.log(`  ${chalk.cyan(c.key)}  ${chalk.dim(`${c.agent ?? "-"} · ${c.column === "yours" ? `asked ${age(c.askedAt)} ago` : `changed ${age(c.changedAt)} ago`}`)}${mark}`)
  console.log(`    ${chalk.bold(c.title)}`)
  if (c.ask) console.log(`    ${c.ask}`)
  if (c.recommend) console.log(`    ${chalk.green("Suggested:")} ${c.recommend}`)
  if (c.progress) console.log(chalk.dim(`    ${c.progress}`))
  if (c.facts) console.log(chalk.dim(`    ${c.facts}`))
  for (const o of c.options) console.log(`    ${chalk.magenta(o.id)}  ${o.label}: ${chalk.dim(o.means)}`)
  if (c.outcome) console.log(`    ${chalk.dim("outcome:")} ${c.outcome.word}${c.outcome.detail ? chalk.dim(` · ${c.outcome.detail}`) : ""}`)
  if (c.actions.length) console.log(chalk.dim(`    can: ${c.actions.join(", ")}`))
}

async function act(input: DeskActInput): Promise<void> {
  const url = DAEMON
  const r: DeskActResult = await deskAct(ctx(), input, {
    by: "operator (cli)",
    laterHours: readApprovalSettings().laterHours,
    callAgent: daemonCallAgent({ url, token: process.env.MESH_TOKEN, operatorKey: loadOperatorKey(process.cwd()) }),
  })
  if (!r.ok) {
    console.log(chalk.red(`  ${r.error}`))
    process.exit(1)
  }
  console.log(chalk.green(`  ${r.message}`))
}

export const desk = new Command("desk")
  .description("your desk: what waits for you, what agents are doing, what went quiet, what finished")

desk
  .command("list", { isDefault: true })
  .alias("ls")
  .description("every card, by who acts next, with the figures")
  .option("--column <column>", `one column only: ${DESK_COLUMNS.join(", ")}`)
  .option("--json", "machine-readable output")
  .action(async (opts: { column?: string; json?: boolean }) => {
    if (opts.column && !DESK_COLUMNS.includes(opts.column as DeskColumn)) {
      console.log(chalk.red(`  --column must be one of: ${DESK_COLUMNS.join(", ")}`))
      process.exit(1)
    }
    const { tasks, error } = await runningTasks()
    const result = buildDesk(
      [{ node: DAEMON, nodeName: "this computer", source: readDeskSource(ctx()) }],
      tasks,
      { now: Date.now(), quietHours: quietHours() },
    )
    const cards = opts.column ? result.cards.filter((c) => c.column === opts.column) : result.cards
    if (opts.json) { console.log(JSON.stringify({ ...result, cards, ...(error ? { daemon: error } : {}) }, null, 2)); return }
    const f = result.figures
    console.log(`  ${chalk.bold(String(f.yours.count))} wait for you${f.yours.oldest ? chalk.dim(` (oldest ${age(f.yours.oldest.since)})`) : ""} · ` +
      `${chalk.bold(String(f.agent.count))} with agents · ${chalk.bold(String(f.stuck.count))} stuck${f.stuck.oldest ? chalk.dim(` (oldest ${age(f.stuck.oldest.since)})`) : ""}`)
    if (error) console.log(chalk.yellow(`  the daemon did not answer (${error}): running work is judged by the quiet limit alone`))
    for (const e of result.errors) console.log(chalk.red(`  couldn't read ${e.error}`))
    for (const col of DESK_COLUMNS) {
      if (opts.column && col !== opts.column) continue
      const here = cards.filter((c) => c.column === col)
      console.log(`\n  ${chalk.bold(COLUMN_TITLE[col])} ${chalk.dim(`(${here.length})`)}`)
      if (!here.length) console.log(chalk.dim("    nothing"))
      for (const c of here) printCard(c)
    }
  })

desk
  .command("answer <key> <option>")
  .description("pick one of a card's options (yes, no, or a choice's number)")
  .option("--text <words>", "words for the agent; on a card with a suggested message, the message as you edited it")
  .action((key: string, option: string, opts: { text?: string }) => act({ key, action: "answer", option, ...(opts.text ? { text: opts.text } : {}) }))

desk
  .command("write <key> <text>")
  .description("write to the agent that has a request; it goes on with your words")
  .action((key: string, text: string) => act({ key, action: "write", text }))

desk
  .command("defer <key>")
  .description("put a card off for the approvals Later time (a day by default); it still expires on time")
  .action((key: string) => act({ key, action: "defer" }))

desk
  .command("call <key>")
  .description("the agent that owns the card calls you about it on AgentX Voice")
  .option("--agent <id>", "for a running turn (task:… keys): the agent running it")
  .action((key: string, opts: { agent?: string }) => act({ key, action: "call", ...(opts.agent ? { agent: opts.agent } : {}) }))
