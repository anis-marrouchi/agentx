import { Command } from "commander"
import chalk from "chalk"
import { applyConfigMutation } from "@/daemon/config-mutator"
import { loadDaemonConfig } from "@/daemon/config"
import { openDb } from "@/storage/sqlite"
import { IMPLICIT_OWNER, splitIdentity, type Person } from "@/people/people"
import { openRequestsOf, runsOf } from "@/people/activity"

// --- agentx people: the humans who talk to your agents (#384) ---
//
// One entry per person, whatever channel they use. Edits `people` in
// agentx.json through applyConfigMutation (validated, then hot-reloaded).
// Run it from the folder that holds agentx.json.
//
//   list                                   everyone, with their identities
//   add <id> --name N [--role R] [--identity channel:id ...]
//   link <id> <channel:id>                 add an identity to a person
//   unlink <id> <channel:id>               take one away
//   remove <id>
//   show <id> [--limit N]                  what they asked for, on every channel

export const people = new Command("people")
  .description("the humans who talk to your agents: one person per human, whatever channel they use")

const ROLES = ["owner", "member", "guest"]
const collect = (v: string, prev: string[] = []): string[] => [...prev, v]

async function mutate(change: (list: any[]) => string): Promise<void> {
  let summary = ""
  const r = await applyConfigMutation((c: any) => {
    c.people = Array.isArray(c.people) ? c.people : []
    summary = change(c.people)
  })
  if (!r.success) { console.error(chalk.red(`✗ ${(r.error ?? "").replace(/^Mutator threw: /, "")}`)); process.exit(1) }
  console.log(chalk.green(`✓ ${summary}`))
  if (r.reloaded) console.log(chalk.dim("  daemon hot-reloaded"))
}

function find(list: any[], id: string): any {
  const person = list.find((p: any) => p?.id === id)
  if (!person) throw new Error(`No person "${id}". See \`agentx people list\`.`)
  person.identities = Array.isArray(person.identities) ? person.identities : []
  return person
}

/** The same identity, however it was typed ("WhatsApp:+216 20…" or a JID). */
function sameIdentity(a: string, b: string): boolean {
  const x = splitIdentity(a)
  const y = splitIdentity(b)
  return !!x && !!y && x.channel === y.channel && x.value === y.value
}

function printPerson(p: Person): void {
  console.log(`  ${chalk.bold(p.id)}  ${p.name} ${chalk.dim(`· ${p.role}`)}`)
  console.log(chalk.dim(p.identities.length ? `      ${p.identities.join(", ")}` : "      no identities yet: agentx people link " + p.id + " <channel:id>"))
}

people
  .command("list", { isDefault: true })
  .alias("ls")
  .description("everyone, with their channel identities")
  .option("--json", "machine-readable output")
  .action((opts: { json?: boolean }) => {
    const list = loadDaemonConfig().people
    if (opts.json) { console.log(JSON.stringify(list, null, 2)); return }
    console.log()
    if (list.length === 0) {
      console.log(chalk.dim(`  no people listed. What you do on this machine (voice, app, dashboard) is recorded as "${IMPLICIT_OWNER}"; senders on other channels are unknown.`))
      console.log(chalk.dim("  add yourself: agentx people add <id> --name <name> --role owner --identity <channel:id>"))
    }
    for (const p of list) printPerson(p)
    console.log()
  })

people
  .command("add <id>")
  .description("add a person")
  .requiredOption("--name <name>", "their name")
  .option("--role <role>", `${ROLES.join(" | ")}`, "member")
  .option("--identity <channel:id>", "a login, a Telegram id or a WhatsApp number (repeatable)", collect, [])
  .action(async (id: string, opts: { name: string; role: string; identity: string[] }) => {
    await mutate((list) => {
      if (list.some((p: any) => p?.id === id)) throw new Error(`"${id}" is already listed. Add an identity with \`agentx people link ${id} <channel:id>\`.`)
      list.push({ id, name: opts.name, role: opts.role, identities: opts.identity })
      return `added ${id} (${opts.role})`
    })
  })

people
  .command("link <id> <identity>")
  .description("add a channel identity to a person, written channel:id (gitlab:sara, whatsapp:21620123456)")
  .action(async (id: string, identity: string) => {
    await mutate((list) => {
      const person = find(list, id)
      if (person.identities.some((i: string) => sameIdentity(i, identity))) return `${id} already has ${identity}`
      person.identities.push(identity)
      return `${identity} is now ${id}`
    })
  })

people
  .command("unlink <id> <identity>")
  .description("take a channel identity away from a person")
  .action(async (id: string, identity: string) => {
    await mutate((list) => {
      const person = find(list, id)
      const before = person.identities.length
      person.identities = person.identities.filter((i: string) => !sameIdentity(i, identity))
      if (person.identities.length === before) throw new Error(`"${id}" has no identity ${identity}.`)
      return `${identity} is no longer ${id}`
    })
  })

people
  .command("remove <id>")
  .alias("rm")
  .description("remove a person. Their past runs keep the id; new messages from them are unknown")
  .action(async (id: string) => {
    await mutate((list) => {
      find(list, id)
      list.splice(list.findIndex((p: any) => p?.id === id), 1)
      return `removed ${id}`
    })
  })

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"
const flat = (s: string | null, n = 100) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n)

people
  .command("show <id>")
  .description("one person and what they asked for, on every channel")
  .option("--limit <n>", "how many runs to list", "20")
  .option("--json", "machine-readable output")
  .action((id: string, opts: { limit: string; json?: boolean }) => {
    const person = loadDaemonConfig().people.find((p) => p.id === id)
    const db = openDb({ quiet: true })
    const runs = db ? runsOf(db, id, Number(opts.limit) || 20) : []
    const open = db ? openRequestsOf(db, id) : []
    if (opts.json) { console.log(JSON.stringify({ person: person ?? null, openRequests: open, runs }, null, 2)); return }
    console.log()
    if (person) printPerson(person)
    else console.log(chalk.dim(`  "${id}" is not in the list${id === IMPLICIT_OWNER ? " (it is the built-in owner of this machine)" : ""}; showing what is recorded under that id`))
    if (!db) { console.log(chalk.yellow("\n  couldn't open .agentx/db.sqlite: run this from the folder that holds agentx.json\n")); return }
    if (open.length) {
      console.log(`\n  Open requests (${open.length})`)
      for (const r of open) console.log(`    ${chalk.cyan(r.id)} ${chalk.dim(`${when(r.createdAt)} · ${r.channel} · ${r.agentId} · ${r.state.replace(/_/g, " ")}`)}\n      ${flat(r.text, 200)}`)
    }
    console.log(`\n  Latest runs (${runs.length})`)
    if (runs.length === 0) console.log(chalk.dim("    nothing recorded yet"))
    for (const r of runs) {
      const mark = r.status === "ok" ? chalk.green("ok") : r.status === "in-flight" ? chalk.yellow("running") : chalk.red(r.status)
      console.log(`    ${chalk.dim(when(r.startedAt))}  ${(r.channel ?? "?").padEnd(9)} ${r.agentId}  ${mark}  ${flat(r.messagePreview)}`)
    }
    console.log()
  })
