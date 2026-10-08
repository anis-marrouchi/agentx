import type { Command } from "commander"
import chalk from "chalk"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

// --- agentx wiki notes: notes agents leave for the wiki observe/sweep run (#825) ---
//
// `add` is how an agent tells the run something only it knows. It goes
// through this node's daemon, which keeps the note if the inbox agent is
// here and forwards it over the mesh otherwise. `list` and `handle` work
// on the inbox node's files; `handle` is what the run calls once it has
// used a note. `config` sets which agent owns the inbox and which
// schedules read it.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")

/** This node's daemon: --daemon, then AGENTX_DAEMON_URL, then node.bind. */
export function daemonBase(flag?: string): string {
  if (flag) return flag.replace(/\/+$/, "")
  if (process.env.AGENTX_DAEMON_URL) return process.env.AGENTX_DAEMON_URL.replace(/\/+$/, "")
  try {
    const file = resolve(process.cwd(), "agentx.json")
    if (existsSync(file)) {
      const bind = JSON.parse(readFileSync(file, "utf-8"))?.node?.bind
      if (typeof bind === "string" && bind.includes(":")) {
        const [host, port] = bind.split(":")
        return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`
      }
    }
  } catch { /* fall through to the default */ }
  return "http://127.0.0.1:18800"
}

function fail(msg: string): void {
  console.error(chalk.red(`  ${msg}`))
  process.exitCode = 1
}

function safe<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try { await fn(...args) } catch (e: any) { fail(e?.message ?? String(e)) }
  }
}

export function registerWikiNotes(wiki: Command): void {
  const notes = wiki
    .command("notes")
    .description("notes agents leave for the wiki observe/sweep run: add, list, handle, config")

  notes
    .command("add")
    .description("leave a note for the wiki observe/sweep run: what changed, the source, the date")
    .requiredOption("--change <text>", "what changed, in a sentence or two")
    .requiredOption("--source <text>", "where you saw it: a system, URL, command, or \"owner said\"")
    .option("--date <YYYY-MM-DD>", "when it changed or when you saw it (default: today)")
    .option("--from <agent>", "your agent id", process.env.AGENTX_AGENT_ID)
    .option("--daemon <url>", "this node's daemon (default: AGENTX_DAEMON_URL, else node.bind in agentx.json)")
    .option("--dir <path>", "write straight into this wiki directory instead of going through the daemon (needs --to)")
    .option("--to <agent>", "inbox agent, with --dir")
    .option("--json")
    .action(safe(async (opts) => {
      if (!opts.from) { fail("say who you are with --from <agent id>"); return }
      const fields = { from: opts.from, change: opts.change, source: opts.source, date: opts.date }

      let answer: any
      if (opts.dir) {
        if (!opts.to) { fail("--dir needs --to <inbox agent>"); return }
        const { NoteStore, validateNote } = await import("@/wiki/notes")
        const checked = validateNote({ ...fields, to: opts.to })
        if ("error" in checked) { fail(checked.error); return }
        answer = { ok: true, ...new NoteStore(wikiDir(opts.dir)).add(checked.note) }
      } else {
        const base = daemonBase(opts.daemon)
        let r: Response
        try {
          r = await fetch(`${base}/wiki/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fields),
            signal: AbortSignal.timeout(20_000),
          })
        } catch (e: any) {
          fail(`could not reach the daemon at ${base}: ${e?.message ?? e}`); return
        }
        answer = await r.json().catch(() => ({}))
        if (!r.ok) { fail(answer?.error || `daemon answered ${r.status}`); return }
      }

      if (opts.json) { console.log(JSON.stringify(answer, null, 2)); return }
      const n = answer.note
      const where = answer.peer ? ` on ${answer.peer}` : ""
      console.log(answer.added === false
        ? chalk.dim(`  already in the inbox${where}: ${n?.id} (${n?.status})`)
        : chalk.green(`  note ${n?.id} left for ${n?.to}${where}; the next observe/sweep run reads it`))
    }))

  notes
    .command("list")
    .description("notes in this node's inbox (waiting ones by default)")
    .option("--status <status>", "waiting | open | patched | rejected | deferred | expired | all", "waiting")
    .option("--dir <path>", "wiki directory")
    .option("--json")
    .action(safe(async (opts) => {
      const { NoteStore } = await import("@/wiki/notes")
      const valid = ["waiting", "open", "patched", "rejected", "deferred", "expired", "all"]
      if (!valid.includes(opts.status)) { fail(`--status must be one of ${valid.join(", ")}`); return }
      const store = new NoteStore(wikiDir(opts.dir))
      const file = store.load()
      if (file.unreadable) { fail(`${store.path} is unreadable (${file.unreadable}); repair or move it aside`); return }
      const list = store.list(opts.status === "all" ? undefined : opts.status)
      if (opts.json) { console.log(JSON.stringify(list, null, 2)); return }
      if (list.length === 0) { console.log(chalk.dim(`  no ${opts.status === "all" ? "" : `${opts.status} `}notes`)); return }
      for (const n of list) {
        const status = n.status === "open" ? chalk.yellow("open") : n.status === "deferred" ? chalk.yellow("deferred") : chalk.dim(n.status)
        console.log(`  ${chalk.cyan(n.id)} ${status} · from ${n.from}${n.fromNode ? ` on ${n.fromNode}` : ""} · ${n.date}`)
        console.log(`    ${n.change}`)
        console.log(chalk.dim(`    source: ${n.source}`))
        if (n.listedIn?.length) console.log(chalk.dim(`    given to: ${n.listedIn.at(-1)}${n.listedIn.length > 1 ? ` (+${n.listedIn.length - 1} earlier)` : ""}`))
        if (n.handled) console.log(chalk.dim(`    ${n.handled.outcome}${n.deferrals ? ` (deferred ${n.deferrals}x)` : ""} by ${n.handled.by} ${n.handled.at.slice(0, 10)}: ${n.handled.reason}`))
        if (n.expired) console.log(chalk.dim(`    expired ${n.expired.at.slice(0, 10)} after ${n.expired.after} deferrals; no longer offered to the run`))
      }
    }))

  notes
    .command("handle <id>")
    .description("record what the run did with a note: patched, rejected or deferred, with a reason")
    .requiredOption("--outcome <outcome>", "patched | rejected | deferred")
    .requiredOption("--reason <text>", "what you patched, why you rejected it, or why it waits")
    .option("--run <id>", "the run that used it")
    .option("--by <agent>", "who handled it", process.env.AGENTX_AGENT_ID || "operator")
    .option("--dir <path>", "wiki directory")
    .action(safe(async (id, opts) => {
      const { NoteStore } = await import("@/wiki/notes")
      const n = new NoteStore(wikiDir(opts.dir)).handle(id, opts.outcome, opts.reason, opts.by, opts.run)
      console.log(chalk.green(`  note ${n.id}: ${n.status}`))
    }))

  notes
    .command("config")
    .description("show or set the inbox agent and the schedules that read it")
    .option("--inbox <agent>", "agent that runs the wiki observe/sweep schedule (\"\" clears it)")
    .option("--cron <ids>", "comma-separated schedule ids that read the inbox (\"\" for none)")
    .option("--max <n>", "most notes one run is given (1-100)")
    .option("--max-deferrals <n>", "times a note may be deferred before it expires (1-20)")
    .option("--enable", "turn wiki notes on")
    .option("--disable", "turn wiki notes off")
    .option("--json")
    .action(safe(async (opts) => {
      const { patchWikiNotes, wikiNotesSettings } = await import("@/wiki/notes-settings")
      const patch: Record<string, unknown> = {}
      if (opts.inbox !== undefined) patch.inbox = opts.inbox
      if (opts.cron !== undefined) patch.crons = String(opts.cron).split(",")
      if (opts.max !== undefined) patch.maxNotesPerRun = Number(opts.max)
      if (opts.maxDeferrals !== undefined) patch.maxDeferrals = Number(opts.maxDeferrals)
      if (opts.enable && opts.disable) { fail("pick one of --enable and --disable"); return }
      if (opts.enable) patch.enabled = true
      if (opts.disable) patch.enabled = false

      if (Object.keys(patch).length > 0) {
        const { mutateAgentxConfig } = await import("@/daemon/config-mutate")
        const { summary } = mutateAgentxConfig((cfg) => patchWikiNotes(cfg, patch))
        console.log(chalk.green(`  ${summary}`))
      }
      const file = resolve(process.cwd(), "agentx.json")
      if (!existsSync(file)) { fail(`agentx.json not found at ${file}`); return }
      const view = wikiNotesSettings(JSON.parse(readFileSync(file, "utf-8"))?.wikiNotes)
      if (opts.json) { console.log(JSON.stringify(view, null, 2)); return }
      console.log(`  wiki notes: ${view.enabled ? chalk.green("on") : chalk.dim("off")}`)
      console.log(`  inbox agent: ${view.inbox || chalk.dim("not set")}`)
      console.log(`  schedules that read it: ${view.crons.length ? view.crons.join(", ") : chalk.dim("none on this node")}`)
      console.log(`  most notes per run: ${view.maxNotesPerRun}`)
      console.log(`  deferrals before a note expires: ${view.maxDeferrals}`)
    }))
}
