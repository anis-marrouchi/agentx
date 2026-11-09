import { Command } from "commander"
import { existsSync } from "fs"
import chalk from "chalk"
import { openDb } from "@/storage/sqlite"
import { findConfigPath } from "@/daemon/config-mutator"
import { NumberStore, type NumberRecord } from "@/numbers/store"
import { describePeriod, describeTarget, formatValue, lastPeriod, parsePeriod, parseTags, statusOf, STATUS_WORDS, type NumberStatus } from "@/numbers/model"
import { parseNumberInput } from "@/numbers/input"
import { describeSource } from "@/numbers/sources"

// --- agentx numbers — tracked numbers and their readings (#1826) ---
//
// Reads and writes numbers in .agentx/db.sqlite, the same file the daemon
// writes. Run it from the folder that holds agentx.json. Numbers set up in
// agentx.json (`numbers.items`) are changed there; the daemon writes them
// to the store at its next check. A command source is only set there.

const STATUS_COLOUR: Record<NumberStatus, (s: string) => string> = {
  on_target: chalk.green, missed: chalk.yellow, missed_twice: chalk.red, no_reading: chalk.dim, no_target: chalk.cyan,
}

function store(): NumberStore | null {
  // openDb creates the file: never do that in a folder that is not a node's.
  if (!existsSync(findConfigPath())) { console.error(chalk.red("  no agentx.json here: run this from the install folder, the one that holds agentx.json")); process.exitCode = 1; return null }
  const db = openDb()
  if (!db) { process.exitCode = 1; return null }
  return new NumberStore(db)
}

const fail = (msg: string) => { console.error(chalk.red(`  ${msg}`)); process.exitCode = 1 }

function printNumber(st: NumberStore, n: NumberRecord, now: number): void {
  const recent = st.readings(n.id, 2)
  const status = statusOf(n, recent, now)
  const latest = recent[0]
  const reading = latest
    ? `${formatValue(latest.value, n.unit)} ${chalk.dim(`for ${describePeriod({ start: latest.periodStart, end: latest.periodEnd })}`)}`
    : chalk.dim("no reading yet")
  console.log(`  ${chalk.cyan(n.id)}  ${n.name} ${STATUS_COLOUR[status](`[${STATUS_WORDS[status]}]`)}  ${reading}${n.archivedAt ? chalk.dim(" (archived)") : ""}`)
  const facts = [
    n.ownerAgent ? `owner ${n.ownerAgent}` : null, n.rhythm,
    n.target ? `target ${describeTarget(n.target, n.unit)}` : null,
    n.tags.length ? n.tags.join(" ") : null,
    describeSource(n.source), n.origin === "config" ? "agentx.json" : null,
  ].filter(Boolean)
  console.log(chalk.dim(`    ${facts.join(" · ")}`))
  if (latest && latest.value === null && latest.error) console.log(chalk.red(`    ${latest.error}`))
}

export const numbers = new Command("numbers")
  .description("tracked numbers: each with an owner, a target, tags and a history of readings")
  .option("--tag <tags>", "only numbers with every tag (comma-separated, e.g. channel:youtube,product:shop)")
  .option("--archived", "numbers no longer tracked too")
  .action((opts: { tag?: string; archived?: boolean }) => {
    const st = store()
    if (!st) return
    const tags = parseTags(opts.tag ?? "")
    if (!Array.isArray(tags)) return fail(tags.error)
    const list = st.list({ archived: !!opts.archived, tags })
    if (!list.length) { console.log(chalk.dim(tags.length ? "  no number has those tags" : "  no numbers yet: add one with agentx numbers add <id> --name \"…\"")); return }
    const now = Date.now()
    for (const n of list) printNumber(st, n, now)
  })

numbers.command("show")
  .description("one number and its readings, newest first")
  .argument("<id>")
  .option("--limit <n>", "readings shown", "20")
  .action((id: string, opts: { limit: string }) => {
    const st = store()
    if (!st) return
    const n = st.get(id)
    if (!n) return fail(`no number "${id}"`)
    printNumber(st, n, Date.now())
    const readings = st.readings(id, Math.max(1, Number(opts.limit) || 20))
    if (!readings.length) return
    console.log("")
    for (const r of readings) {
      const value = r.value === null ? chalk.dim("no reading") : formatValue(r.value, n.unit)
      console.log(`    ${describePeriod({ start: r.periodStart, end: r.periodEnd }).padEnd(22)} ${value}${chalk.dim(`  by ${r.by}`)}${r.error ? chalk.red(`  ${r.error}`) : ""}${r.note ? chalk.dim(`  ${r.note}`) : ""}`)
    }
  })

numbers.command("add")
  .description("make a number, or change one (the options given replace the old ones)")
  .argument("<id>", "a short id: letters, digits, dashes, dots or colons")
  .option("--name <name>", "what it counts, in a few plain words")
  .option("--owner <agent>", "the agent that owns it")
  .option("--unit <unit>", "views, clients, %, h…")
  .option("--target <n>", "the value it should reach")
  .option("--direction <up|down>", "up: higher is better (default); down: lower is better")
  .option("--rhythm <rhythm>", "daily, weekly (default) or monthly")
  .option("--tags <tags>", "comma-separated, e.g. channel:youtube,product:shop")
  .option("--source <json>", "where readings come from, as JSON: {\"kind\":\"count\",…} or {\"kind\":\"http-json\",\"url\":…,\"path\":…}. Default: recorded by hand")
  .action((id: string, opts: Record<string, string | undefined>) => {
    const st = store()
    if (!st) return
    const had = st.get(id)
    if (had?.origin === "config") return fail(`"${id}" is set up in agentx.json (numbers.items): change it there`)
    let source: unknown
    if (opts.source !== undefined) {
      try { source = JSON.parse(opts.source) } catch { return fail("--source must be JSON") }
    }
    const raw: Record<string, unknown> = { id }
    for (const k of ["name", "owner", "unit", "target", "direction", "rhythm", "tags"] as const) if (opts[k] !== undefined) raw[k] = opts[k]
    if (source !== undefined) raw.source = source
    const input = parseNumberInput(raw, "cli")
    if ("error" in input) return fail(input.error)
    if (!had && !input.name) return fail("a new number needs --name: what it counts, in a few plain words")
    const n = st.upsert(input, Date.now())
    console.log(chalk.green(`  ${had ? "changed" : "made"} ${n.id}`))
    printNumber(st, n, Date.now())
  })

numbers.command("record")
  .description("keep a reading for a window (default: the last whole period of the number's rhythm)")
  .argument("<id>")
  .argument("<value>", "the value read")
  .option("--from <day>", "first day of the window (YYYY-MM-DD)")
  .option("--to <day>", "last day of the window, included (YYYY-MM-DD; default: --from)")
  .option("--note <text>", "where the value was read")
  .action((id: string, value: string, opts: { from?: string; to?: string; note?: string }) => {
    const st = store()
    if (!st) return
    const n = st.get(id)
    if (!n) return fail(`no number "${id}"`)
    const v = Number(value.replace(/,/g, ""))
    if (!value.trim() || !Number.isFinite(v)) return fail("the value must be a number")
    const now = Date.now()
    const period = opts.from ? parsePeriod(opts.from, opts.to) : lastPeriod(n.rhythm, now)
    if ("error" in period) return fail(period.error)
    st.record({ numberId: id, value: v, readAt: now, periodStart: period.start, periodEnd: period.end, by: "owner", note: opts.note ?? null })
    console.log(chalk.green(`  kept ${formatValue(v, n.unit)} for ${describePeriod(period)}`))
  })

numbers.command("archive")
  .description("stop tracking a number; its readings stay")
  .argument("<id>")
  .action((id: string) => {
    const st = store()
    if (!st) return
    const n = st.get(id)
    if (!n) return fail(`no number "${id}"`)
    if (n.origin === "config") return fail(`"${id}" is set up in agentx.json (numbers.items): take it out there`)
    if (!st.archive(id, Date.now())) return fail(`"${id}" is already archived`)
    console.log(chalk.green(`  ${id} is no longer tracked`))
  })
