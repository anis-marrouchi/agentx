import { Command } from "commander"
import { existsSync } from "fs"
import chalk from "chalk"
import { openDb } from "@/storage/sqlite"
import { findConfigPath } from "@/daemon/config-mutator"
import { SprintStore, type ItemRecord, type SprintRecord } from "@/requests/sprint-store"
import { cancelSprint, laneAction, type LaneAction } from "@/requests/sprints"

// --- agentx requests sprints — the sprint lanes the daemon follows (#1241) ---
//
// Reads and moves sprints in .agentx/db.sqlite, the same file the daemon
// writes. The daemon picks a change up at its next check (within a
// minute). This is an owner surface: it moves any lane of any sprint.

const STATE_COLOUR: Record<string, (s: string) => string> = {
  done: chalk.green, skipped: chalk.dim, failed: chalk.red, blocked: chalk.red, running: chalk.cyan,
  active: chalk.cyan, held: chalk.yellow, pending: chalk.dim, cancelled: chalk.dim,
}
const colour = (state: string) => (STATE_COLOUR[state] ?? chalk.dim)(`[${state}]`)
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"

function store(): SprintStore | null {
  // openDb creates the file: never do that in a folder that is not a node's.
  if (!existsSync(findConfigPath())) { console.error(chalk.red("  no agentx.json here: run this from the install folder, the one that holds agentx.json")); process.exitCode = 1; return null }
  const db = openDb()
  if (!db) { process.exitCode = 1; return null }
  return new SprintStore(db)
}

function printItem(it: ItemRecord): void {
  const note = it.note && it.state !== "done" ? chalk.dim(` ${it.note}`) : ""
  console.log(`      ${it.idx}. ${it.ref}${it.title ? chalk.dim(` (${it.title})`) : ""} ${colour(it.state)}${note}`)
}

function printSprint(st: SprintStore, s: SprintRecord, full: boolean): void {
  console.log(`  ${chalk.cyan(s.id)}  ${s.title} ${colour(s.state)} ${chalk.dim(`${when(s.createdAt)} · lead ${s.createdBy}`)}`)
  if (s.ref) console.log(chalk.dim(`    plan: ${s.ref}`))
  for (const l of st.lanes(s.id)) {
    const items = st.items(s.id, l.lane)
    const done = items.filter((i) => i.state === "done").length
    console.log(`    lane ${chalk.bold(l.lane)} ${chalk.dim(`(${l.agentId})`)} ${colour(l.state)} ${chalk.dim(`${done}/${items.length} done`)}${l.note ? chalk.red(` ${l.note}`) : ""}`)
    if (full) items.forEach(printItem)
  }
}

/** "A" or "A:3": a lane and, optionally, an item number. */
function parseTarget(v: string): { lane: string; item?: number } | string {
  const m = /^([^:]+)(?::(\d+))?$/.exec(v.trim())
  if (!m) return `"${v}" is not a lane: give its name, or name:item (A, or A:3)`
  return { lane: m[1], ...(m[2] ? { item: Number(m[2]) } : {}) }
}

const ACTIONS: LaneAction[] = ["retry", "skip", "hold", "release", "block"]

export const sprints = new Command("sprints")
  .description("sprint lanes the daemon hands out item by item: list them, or move a lane on")
  .argument("[id]", "one sprint, item by item")
  .option("--all", "finished and cancelled sprints too")
  .option("--retry <lane[:item]>", "hand a failed (or stuck) item out again")
  .option("--skip <lane[:item]>", "skip the lane's current item, or the one named")
  .option("--hold <lane:item>", "hold a pending item: the lane passes over it")
  .option("--release <lane[:item]>", "release a held item back into the queue")
  .option("--block <lane>", "stop a lane (give --note)")
  .option("--note <text>", "why, for the sprint's log")
  .option("--cancel", "stop the sprint: no more items are handed out")
  .action((id: string | undefined, opts: Record<string, string | boolean | undefined>) => {
    const st = store()
    if (!st) return
    const chosen = ACTIONS.filter((a) => typeof opts[a] === "string")
    if (chosen.length || opts.cancel) {
      if (!id) { console.error(chalk.red("  name the sprint: agentx requests sprints <id> --retry A")); process.exitCode = 1; return }
      if (chosen.length + (opts.cancel ? 1 : 0) > 1) { console.error(chalk.red("  one action at a time")); process.exitCode = 1; return }
      const now = Date.now()
      let err: string | null
      if (opts.cancel) {
        err = cancelSprint(st, id, "owner", now)
      } else {
        const target = parseTarget(String(opts[chosen[0]]))
        if (typeof target === "string") { console.error(chalk.red(`  ${target}`)); process.exitCode = 1; return }
        err = laneAction(st, { sprintId: id, ...target, action: chosen[0], note: typeof opts.note === "string" ? opts.note : undefined, by: "owner" }, now)
      }
      if (err) { console.error(chalk.red(`  ${err}`)); process.exitCode = 1; return }
      console.log(chalk.green(`  done; the daemon picks it up within a minute`))
    }
    if (id) {
      const s = st.get(id)
      if (!s) { console.error(chalk.red(`  no sprint "${id}"`)); process.exitCode = 1; return }
      printSprint(st, s, true)
      return
    }
    const list = opts.all ? st.list({ limit: 50 }) : st.listActive()
    if (!list.length) { console.log(chalk.dim(opts.all ? "  no sprints" : "  no active sprints (--all for finished ones)")); return }
    for (const s of list) printSprint(st, s, false)
  })
