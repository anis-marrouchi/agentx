import { Command } from "commander"
import chalk from "chalk"
import { applyConfigMutation } from "@/daemon/config-mutator"
import { loadDaemonConfig } from "@/daemon/config"
import { openDb } from "@/storage/sqlite"
import { IMPLICIT_OWNER, PERSON_ROLES, splitIdentity, type Person } from "@/people/people"
import { openRequestsOf, runsOf } from "@/people/activity"
import { TokenStore } from "@/daemon/token-store"
import { PairCodeStore, formatCode } from "@/daemon/pair-codes"
import { MemberStore } from "@/members/store"
import { CODE_MINUTES, inviteMember, inviteMessage, pageFor, removeDevice, removePersonDevices, MEMBER_KEY_DAYS } from "@/members/pairing"
import { dashboardPort, exposedDashboardMounts, tailscaleOrigin, tailscaleServeStatus } from "./app"

// --- agentx people: the humans who talk to your agents (#384) ---
//
// One entry per person, whatever channel they use. Edits `people` in
// agentx.json through applyConfigMutation (validated, then hot-reloaded).
// Run it from the folder that holds agentx.json.
//
//   list                                   everyone, with their identities
//   add <id> --name N [--role R] [--identity channel:id ...]
//   allow <id> <agents...>                 limit a person to named agents (#379)
//   deny <id> <tools|skills> <names...>    deny named tools or skills on their turns (#379)
//   link <id> <channel:id>                 add an identity to a person
//   unlink <id> <channel:id>               take one away
//   say <id> [spoken]                      how their name is said aloud (#433); "none" clears it
//   remove <id>                            also ends every machine of theirs
//   show <id> [--limit N]                  what they asked for, on every channel
//   invite <id> [--url origin]             a one-time code for their own page (#385): My work
//                                          for a teammate, Your project for a client (#453),
//                                          and a message to forward to them as it is (#659)
//   devices [id]                           their machines: state, first and last use
//   revoke-device <tokenId>                end one machine at once

export const people = new Command("people")
  .description("the humans who talk to your agents: one person per human, whatever channel they use")

const ROLES = PERSON_ROLES
/** The line above and below the message to forward. */
const MESSAGE_RULE = "-".repeat(64)

/** The member store with this install's log retention. */
function memberStore(): MemberStore {
  let days = 90
  try { days = loadDaemonConfig().members.logRetentionDays } catch { /* default */ }
  return new MemberStore(process.cwd(), Date.now, days)
}
const collect = (v: string, prev: string[] = []): string[] => [...prev, v]

/** A typed agent id that is not an agent of this machine: a typo leaves the
 *  person able to reach nothing. An agent on another node is a valid entry,
 *  and not known here, so this warns instead of refusing. */
function warnUnknownAgents(ids: string[]): void {
  let known: string[] = []
  try { known = Object.keys(loadDaemonConfig().agents) } catch { return }
  const unknown = ids.filter((id) => !known.includes(id))
  if (!unknown.length) return
  console.log(chalk.yellow(`  ! not an agent on this machine: ${unknown.join(", ")}. Agents here: ${known.join(", ") || "none"}.`))
  console.log(chalk.yellow("    Keep it only if it runs on another node; a mistyped id reaches nothing."))
}

const NO_OWNER_LIMIT = "An owner reaches every agent and cannot be limited. Change the role first if that is what you want."
const NO_OWNER_DENY = "An owner is never limited. Change the role first if that is what you want."
/** The levels `deny` takes. A further level is a new entry here and in personSchema.deny. */
const DENY_LEVELS = ["tools", "skills"] as const
type DenyLevel = (typeof DENY_LEVELS)[number]

/** "tool" or "Tools" → "tools"; null when it is not a level. */
export function denyLevel(word: string): DenyLevel | null {
  const w = word.toLowerCase().replace(/^(tool|skill)$/, "$1s")
  return (DENY_LEVELS as readonly string[]).includes(w) ? (w as DenyLevel) : null
}

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
  const denied = DENY_LEVELS.filter((l) => p.deny?.[l]?.length).map((l) => ` · no ${l}: ${p.deny![l]!.join(", ")}`).join("")
  console.log(`  ${chalk.bold(p.id)}  ${p.name}${p.say ? chalk.dim(` (said "${p.say}")`) : ""} ${chalk.dim(`· ${p.role}`)}${p.agents?.length ? chalk.dim(` · agents: ${p.agents.join(", ")}`) : ""}${chalk.dim(denied)}`)
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
  .option("--role <role>", `${ROLES.join(" | ")}. A client is someone you do work for; their page is "Your project"`, "member")
  .option("--identity <channel:id>", "a login, a Telegram id or a WhatsApp number (repeatable)", collect, [])
  .option("--agent <id>", "an agent this person may reach; repeat for several. None: every agent", collect, [])
  .action(async (id: string, opts: { name: string; role: string; identity: string[]; agent: string[] }) => {
    await mutate((list) => {
      if (list.some((p: any) => p?.id === id)) throw new Error(`"${id}" is already listed. Add an identity with \`agentx people link ${id} <channel:id>\`.`)
      if (!(ROLES as readonly string[]).includes(opts.role)) throw new Error(`--role must be one of: ${ROLES.join(", ")}`)
      if (opts.role === "owner" && opts.agent.length) throw new Error(NO_OWNER_LIMIT)
      list.push({ id, name: opts.name, role: opts.role, identities: opts.identity, agents: opts.agent })
      return `added ${id} (${opts.role})${opts.agent.length ? `, may reach ${opts.agent.join(", ")}` : ""}`
    })
    warnUnknownAgents(opts.agent)
  })

people
  .command("allow <id> <agents...>")
  .description("limit a person to these agents (ids, space-separated). \"all\" lifts the limit")
  .action(async (id: string, agents: string[]) => {
    const lift = agents.length === 1 && agents[0].toLowerCase() === "all"
    await mutate((list) => {
      const person = find(list, id)
      if (!lift && person.role === "owner") throw new Error(NO_OWNER_LIMIT)
      person.agents = lift ? [] : [...new Set(agents)]
      return lift ? `${id} may reach every agent` : `${id} may reach ${person.agents.join(", ")} and no other agent`
    })
    if (!lift) warnUnknownAgents(agents)
  })

people
  .command("deny <id> <level> <names...>")
  .description("stop a person's turns using these tools or skills. Level: tools | skills. Names match without case; * is a wildcard. \"none\" lifts the limit")
  .action(async (id: string, level: string, names: string[]) => {
    const lvl = denyLevel(level)
    if (!lvl) { console.error(chalk.red(`✗ level must be one of: ${DENY_LEVELS.join(", ")}`)); process.exit(1) }
    const lift = names.length === 1 && names[0].toLowerCase() === "none"
    await mutate((list) => {
      const person = find(list, id)
      if (!lift && person.role === "owner") throw new Error(NO_OWNER_DENY)
      person.deny = { ...(person.deny ?? {}), [lvl]: lift ? [] : [...new Set(names)] }
      return lift ? `${id} may use every ${lvl.slice(0, -1)}` : `${id} may not use these ${lvl}: ${person.deny[lvl].join(", ")}`
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
  .command("say <id> [spoken...]")
  .description("how the person's name is said aloud, e.g. \"A-neess Ma-roo-shee\"; the written name stays. \"none\" clears it")
  .action(async (id: string, spoken: string[] = []) => {
    const said = spoken.join(" ").trim()
    if (!said) {
      const person = loadDaemonConfig().people.find((p) => p.id === id)
      if (!person) { console.error(chalk.red(`✗ No person "${id}". See \`agentx people list\`.`)); process.exit(1) }
      console.log(person.say ? `  ${person.name} is said "${person.say}"` : `  ${person.name} is said as written`)
      return
    }
    await mutate((list) => {
      const person = find(list, id)
      if (said.toLowerCase() === "none") { delete person.say; return `${person.name} is said as written` }
      if (said.length > 120) throw new Error("The spoken form is at most 120 characters")
      person.say = said
      return `${person.name} is now said "${said}"; written, it stays ${person.name}`
    })
  })

people
  .command("remove <id>")
  .alias("rm")
  .description("remove a person. Their past runs keep the id; new messages from them are unknown; every machine of theirs stops at once")
  .action(async (id: string) => {
    await mutate((list) => {
      find(list, id)
      list.splice(list.findIndex((p: any) => p?.id === id), 1)
      return `removed ${id}`
    })
    const ended = removePersonDevices({ tokens: new TokenStore(), members: memberStore() }, id)
    if (ended.length) console.log(chalk.green(`✓ ended ${ended.length} machine(s) of ${id}: ${ended.map((d) => d.name).join(", ")}`))
    console.log(chalk.dim("  If you shared this computer with them on the private network, remove that share too."))
  })

people
  .command("invite <id>")
  .description("a one-time code that pairs one of this person's machines with their own page (/member): My work for a teammate, Your project for a client. Ends with a message to forward to them as it is")
  .option("--url <origin>", "address the person opens, e.g. https://my-mac.tailnet-name.ts.net (default: this computer's Tailscale name)")
  .action((id: string, opts: { url?: string }) => {
    try {
      const port = dashboardPort()
      const exposed = exposedDashboardMounts(tailscaleServeStatus(), port)
      if (exposed.length > 0) {
        throw new Error([
          `tailscale serve publishes the whole dashboard, not only the member page: ${exposed.join(", ")}`,
          `  Anyone you share this computer with could open it. Serve only the member paths instead:`,
          `    tailscale serve reset   (removes every served path; add the phone app's /app lines back if you use it)`,
          `    tailscale serve --bg --set-path /member http://127.0.0.1:${port}/member`,
          `    tailscale serve --bg --set-path /api/member http://127.0.0.1:${port}/api/member`,
        ].join("\n"))
      }
      const origin = (opts.url ? String(opts.url) : tailscaleOrigin()).replace(/\/+$/, "")
      if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error(`--url must be an origin like https://host.example.ts.net, got: ${origin}`)
      const people = loadDaemonConfig().people
      const r = inviteMember({ tokens: new TokenStore(), codes: new PairCodeStore(), members: memberStore(), people: () => people }, id)
      if (!r.ok) throw new Error(r.error)
      console.log()
      console.log(`  Invite for ${chalk.bold(r.person.name)} (${r.person.id}, ${r.person.role}). Their page is ${chalk.bold(pageFor(r.person.role))}.`)
      console.log()
      console.log(`  1. Share this computer with them on your private network, if you have not yet:`)
      console.log(chalk.dim(`     Tailscale admin console → Machines → this computer → Share → send them the link.`))
      console.log(chalk.dim(`     Limit what shared users can reach to port 443 in your access rules (see the docs page "Invite a teammate").`))
      console.log(`  2. Send them the message below, or this address and code. The code works once, for ${CODE_MINUTES} minutes:`)
      console.log()
      console.log(`     ${chalk.cyan(`${origin}/member`)}`)
      console.log(`     ${chalk.bold(formatCode(r.code))}`)
      console.log()
      console.log(`  3. When they pair, a card "New machine for ${r.person.name}" asks you to approve that machine. Then ${pageFor(r.person.role)} opens for them.`)
      console.log(chalk.dim(`     Their key stops after ${MEMBER_KEY_DAYS} days; invite again then. Machine id: ${r.tokenId}`))
      console.log()
      // The message sits flush left, with no colour, so a copy carries no
      // indent and no escape code into WhatsApp, Telegram or mail.
      console.log(`  ${chalk.bold("Message to forward")} ${chalk.dim("(copy everything between the two lines; the rest of this output is for you)")}`)
      console.log(chalk.dim(MESSAGE_RULE))
      console.log(inviteMessage({ person: r.person, origin, code: r.code }))
      console.log(chalk.dim(MESSAGE_RULE))
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

people
  .command("devices [id]")
  .description("the machines paired to people's own pages (My work, Your project): state, where from, first and last use")
  .option("--json", "machine-readable output")
  .action((id: string | undefined, opts: { json?: boolean }) => {
    const devices = memberStore().devices(id)
    if (opts.json) { console.log(JSON.stringify(devices, null, 2)); return }
    if (devices.length === 0) { console.log(chalk.dim(`\n  No machines${id ? ` for ${id}` : ""}. Run \`agentx people invite <id>\`.\n`)); return }
    console.log()
    for (const d of devices) {
      const state = d.state === "active" ? chalk.green("active") : d.state === "pending" ? chalk.yellow("waiting for your approval") : chalk.red(`removed${d.removedReason ? `: ${d.removedReason}` : ""}`)
      console.log(`  ${chalk.cyan(d.tokenId)}  ${chalk.bold(d.personId)}  ${d.name}  ${state}`)
      console.log(chalk.dim(`    paired: ${d.createdAt} from ${d.address ?? "?"}${d.network ? ` as ${d.network}` : ""}${d.lastSeenAt ? `  last used: ${d.lastSeenAt} from ${d.lastAddress ?? "?"}` : ""}`))
    }
    console.log()
  })

people
  .command("revoke-device <tokenId>")
  .description("end one machine's access at once")
  .action((tokenId: string) => {
    const d = removeDevice({ tokens: new TokenStore(), members: memberStore() }, tokenId)
    if (!d) { console.log(chalk.red(`  No machine with id ${tokenId}. See \`agentx people devices\`.`)); process.exit(1) }
    console.log(chalk.green(`\n  ✓ Ended ${tokenId} (${d.name}, ${d.personId})\n`))
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
