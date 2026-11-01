import { Command } from "commander"
import chalk from "chalk"
import { mutateAgentxConfig } from "@/daemon/config-mutate"
import { loadDaemonConfig } from "@/daemon/config"
import { RELATION_TYPES, configRelationsProblem, memberKey, memberLabel, meshPeerNames, namedNodes, orgRelations, parseMember, type RelationType } from "@/business/relations"

// --- agentx business — manage the business layer config ---
//
// Closes the second-pass parity gap: business.* in agentx.json had no
// CLI surface and no dashboard UI, forcing operators to hand-edit
// JSON for org-chart / project / contact-map changes — the same data
// the activity-graph attribution and PM-gating rely on.
//
// Scope kept narrow on purpose:
//   show      — read-only summary
//   orgchart  — add / remove / list entries (agentId → { role, reportsTo, schedule })
//   relation  — add / remove / list typed links between people and agents (#1418)
//   project   — add / remove / list (id, pm?, client?)
//   contact   — add / remove / list (chatId/username → client/project)
//
// Out of scope for this round (use Advanced JSON tab in /admin or hand-
// edit): workSource, roles, schedules beyond start/end, mainChannel.

function mutate(mutator: (cfg: any) => string): void {
  const { summary, backupPath } = mutateAgentxConfig((cfg) => mutator(cfg))
  console.log(chalk.green(`\n  ✓ ${summary}`))
  if (backupPath) console.log(chalk.dim(`  Backup: ${backupPath}`))
  console.log(chalk.dim(`  Restart the daemon (or POST /reload) for the change to take effect.\n`))
}

function readBusiness(): any {
  try {
    const cfg = loadDaemonConfig()
    return (cfg as any).business || {}
  } catch {
    return {}
  }
}

function readPeople(): Array<{ id: string; name?: string }> {
  try {
    return (loadDaemonConfig() as any).people || []
  } catch {
    return []
  }
}

/** Each agent's reports-to boss for display: an agent id, or a person's name
 *  (orgChart reportsTo and business.relations both count, #1418). */
function bossLabels(b: any): Map<string, string> {
  const people = readPeople()
  const out = new Map<string, string>()
  for (const r of orgRelations(b)) {
    const from = parseMember(r.from)
    if (r.type !== "reports-to" || from.kind !== "agent" || out.has(from.id)) continue
    out.set(from.id, memberLabel(r.to, people) + (r.to.startsWith("person:") ? " (person)" : ""))
  }
  return out
}

export const business = new Command()
  .name("business")
  .description("manage the business layer in agentx.json — orgChart, projects, contactMap")

// ---- show ----------------------------------------------------------------

business
  .command("show")
  .description("print the current business config (orgChart, projects, contactMap)")
  .option("--json", "machine-readable JSON")
  .action((opts) => {
    const b = readBusiness()
    if (opts.json) { console.log(JSON.stringify(b, null, 2)); return }
    if (!b || !b.enabled) {
      console.log()
      console.log(chalk.yellow("  business block not enabled (or missing)."))
      console.log(chalk.dim("  Add a `business` key to agentx.json to opt in."))
      console.log()
      return
    }
    const orgChart = b.orgChart || {}
    const projects = b.projects || []
    const contactMap = b.contactMap || []
    console.log()
    console.log(chalk.bold("  Org chart"))
    const orgEntries = Object.entries(orgChart) as Array<[string, any]>
    const bosses = bossLabels(b)
    if (orgEntries.length === 0) console.log(chalk.dim("    (empty)"))
    else for (const [id, e] of orgEntries) {
      const reports = bosses.has(id) ? chalk.dim(` → reports to ${bosses.get(id)}`) : ""
      const sched = e.schedule ? chalk.dim(` · ${(e.schedule.days || []).join(",")} ${e.schedule.start}–${e.schedule.end}`) : ""
      console.log(`    ${chalk.cyan(id)}  ${e.role}${reports}${sched}`)
    }
    console.log()
    console.log(chalk.bold(`  Projects (${projects.length})`))
    if (projects.length === 0) console.log(chalk.dim("    (empty)"))
    else for (const p of projects) {
      const pm = p.pm ? chalk.dim(` · pm=${p.pm}`) : ""
      const client = p.client ? chalk.dim(` · client=${p.client}`) : ""
      console.log(`    ${chalk.cyan(p.id)}${pm}${client}`)
    }
    console.log()
    console.log(chalk.bold(`  Contact map (${contactMap.length})`))
    if (contactMap.length === 0) console.log(chalk.dim("    (empty)"))
    else for (const c of contactMap) {
      const key = c.chatId ? `chatId=${c.chatId}` : c.username ? `username=${c.username}` : c.senderId ? `senderId=${c.senderId}` : "?"
      const ch = c.channel ? `${c.channel}/` : ""
      console.log(`    ${chalk.cyan(ch + key)}  → ${c.client}${c.project ? `/${c.project}` : ""}${c.displayName ? chalk.dim(` (${c.displayName})`) : ""}`)
    }
    console.log()
  })

// ---- orgchart ------------------------------------------------------------

const orgchart = business
  .command("orgchart")
  .description("manage business.orgChart — agentId → { role, reportsTo, schedule }")

orgchart
  .command("list")
  .description("list orgChart entries")
  .option("--json", "JSON output")
  .action((opts) => {
    const b = readBusiness()
    const entries = Object.entries(b.orgChart || {}) as Array<[string, any]>
    if (opts.json) { console.log(JSON.stringify(Object.fromEntries(entries), null, 2)); return }
    if (entries.length === 0) { console.log(chalk.dim("  no entries")); return }
    const bosses = bossLabels(b)
    for (const [id, e] of entries) {
      console.log(`  ${chalk.cyan(id)}  ${e.role}${bosses.has(id) ? chalk.dim(` → ${bosses.get(id)}`) : ""}`)
    }
  })

orgchart
  .command("add <agentId>")
  .description("add or update an orgChart entry for an agent")
  .requiredOption("--role <role>", "role title (e.g. 'PM', 'Coder', 'DevOps')")
  .option("--reports-to <member>", "manager: an agentId, or person:<id> from people")
  .option("--start <hh:mm>", "schedule start", "09:00")
  .option("--end <hh:mm>", "schedule end", "17:00")
  .option("--days <csv>", "working days (mon,tue,wed,thu,fri)", "mon,tue,wed,thu,fri")
  .option("--utilization <0..1>", "target utilization", "0.8")
  .action((agentId: string, opts) => {
    const days = String(opts.days).split(",").map((s) => s.trim()).filter(Boolean) as Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">
    mutate((cfg) => {
      const had = namedNodes(cfg.business)
      cfg.business = cfg.business || {}
      cfg.business.orgChart = cfg.business.orgChart || {}
      cfg.business.orgChart[agentId] = {
        role: opts.role,
        ...(opts.reportsTo ? { reportsTo: opts.reportsTo } : {}),
        schedule: { days, start: opts.start, end: opts.end },
        utilizationTarget: parseFloat(opts.utilization) || 0.8,
      }
      const problem = configRelationsProblem(cfg, had)
      if (problem) throw new Error(problem)
      return `orgChart entry "${agentId}" upserted (role=${opts.role}${opts.reportsTo ? `, reports to ${opts.reportsTo}` : ""})`
    })
  })

orgchart
  .command("remove <agentId>")
  .alias("rm")
  .description("remove an orgChart entry")
  .action((agentId: string) => {
    mutate((cfg) => {
      if (!cfg.business?.orgChart || !(agentId in cfg.business.orgChart)) {
        throw new Error(`no orgChart entry for "${agentId}"`)
      }
      delete cfg.business.orgChart[agentId]
      return `orgChart entry "${agentId}" removed`
    })
  })

// ---- relation ------------------------------------------------------------

const relation = business
  .command("relation")
  .description(`manage business.relations — typed links between people and agents (${RELATION_TYPES.join(", ")})`)

relation
  .command("list")
  .description("list every relation, orgChart reportsTo included, and any problem with them")
  .option("--json", "JSON output")
  .action((opts) => {
    let cfg: any
    try { cfg = loadDaemonConfig() } catch (e: any) {
      console.error(chalk.red(`  could not read agentx.json: ${e.message}`))
      process.exitCode = 1
      return
    }
    const relations = orgRelations(cfg.business)
    // A node not in mesh.peers is not a problem (#1702): the daemon loads the
    // org and shows that agent as not a peer. It is listed apart.
    const peers = meshPeerNames(cfg)
    const notPeers = [...namedNodes(cfg.business)].filter((n) => !peers.has(n)).sort()
    const problem = configRelationsProblem(cfg, notPeers)
    if (opts.json) { console.log(JSON.stringify({ relations, ...(notPeers.length ? { notPeers } : {}), ...(problem ? { problem } : {}) }, null, 2)); return }
    if (relations.length === 0) console.log(chalk.dim("  no relations"))
    for (const r of relations) console.log(`  ${chalk.cyan(r.from)}  ${r.type}  ${chalk.cyan(r.to)}`)
    if (notPeers.length) console.log(chalk.dim(`  not a peer in mesh.peers (shown, never sent work): ${notPeers.join(", ")}`))
    if (problem) console.log(chalk.yellow(`  ! ${problem}`))
  })

relation
  .command("add <from> <type> <to>")
  .description("link two members, e.g. agent:pm reports-to person:sam")
  .action((from: string, type: string, to: string) => {
    if (!(RELATION_TYPES as readonly string[]).includes(type)) {
      console.error(chalk.red(`  unknown relation type "${type}"; use one of: ${RELATION_TYPES.join(", ")}`))
      process.exitCode = 1
      return
    }
    mutate((cfg) => {
      cfg.business = cfg.business || {}
      const r = { from: memberKey(from), to: memberKey(to), type: type as RelationType }
      const relations = [...(cfg.business.relations || []), r]
      const problem = configRelationsProblem({ ...cfg, business: { ...cfg.business, relations } }, namedNodes(cfg.business))
      if (problem) throw new Error(problem)
      cfg.business.relations = relations
      return `relation added: ${r.from} ${r.type} ${r.to}`
    })
  })

relation
  .command("remove <from> <type> <to>")
  .alias("rm")
  .description("remove one relation from business.relations")
  .action((from: string, type: string, to: string) => {
    mutate((cfg) => {
      const relations: any[] = cfg.business?.relations || []
      const f = memberKey(from), t = memberKey(to)
      const kept = relations.filter((r) => !(memberKey(r.from) === f && r.type === type && memberKey(r.to) === t))
      if (kept.length === relations.length) {
        throw new Error(`no relation "${f} ${type} ${t}" in business.relations (a reportsTo in orgChart is changed with: agentx business orgchart add)`)
      }
      cfg.business.relations = kept
      return `relation removed: ${f} ${type} ${t}`
    })
  })

// ---- project -------------------------------------------------------------

const project = business
  .command("project")
  .description("manage business.projects — id, pm, client")

project
  .command("list")
  .description("list projects")
  .option("--json", "JSON output")
  .action((opts) => {
    const b = readBusiness()
    const projects = b.projects || []
    if (opts.json) { console.log(JSON.stringify(projects, null, 2)); return }
    if (projects.length === 0) { console.log(chalk.dim("  no projects")); return }
    for (const p of projects) {
      console.log(`  ${chalk.cyan(p.id)}  ${p.pm ? `pm=${p.pm}` : ""} ${p.client ? `client=${p.client}` : ""}`.trimEnd())
    }
  })

project
  .command("add <id>")
  .description("add or update a project entry")
  .option("--pm <agentId>", "PM responsible for this project (drives PM gate)")
  .option("--client <name>", "client this project belongs to (drives activity-graph attribution)")
  .action((id: string, opts) => {
    mutate((cfg) => {
      cfg.business = cfg.business || {}
      cfg.business.projects = cfg.business.projects || []
      const idx = cfg.business.projects.findIndex((p: any) => p.id === id)
      const next = { id, ...(opts.pm ? { pm: opts.pm } : {}), ...(opts.client ? { client: opts.client } : {}) }
      if (idx >= 0) cfg.business.projects[idx] = { ...cfg.business.projects[idx], ...next }
      else cfg.business.projects.push(next)
      return idx >= 0 ? `project "${id}" updated` : `project "${id}" added`
    })
  })

project
  .command("remove <id>")
  .alias("rm")
  .description("remove a project entry")
  .action((id: string) => {
    mutate((cfg) => {
      const list = cfg.business?.projects || []
      const before = list.length
      cfg.business.projects = list.filter((p: any) => p.id !== id)
      if (cfg.business.projects.length === before) throw new Error(`no project "${id}"`)
      return `project "${id}" removed`
    })
  })

// ---- contact -------------------------------------------------------------

const contact = business
  .command("contact")
  .description("manage business.contactMap — chatId/username/senderId → client/project")

contact
  .command("list")
  .description("list contact map entries")
  .option("--json", "JSON output")
  .action((opts) => {
    const b = readBusiness()
    const list = b.contactMap || []
    if (opts.json) { console.log(JSON.stringify(list, null, 2)); return }
    if (list.length === 0) { console.log(chalk.dim("  no entries")); return }
    for (const c of list) {
      const key = c.chatId ? `chatId=${c.chatId}` : c.username ? `username=${c.username}` : c.senderId ? `senderId=${c.senderId}` : "?"
      console.log(`  ${c.channel ? c.channel + "/" : ""}${chalk.cyan(key)}  → ${c.client}${c.project ? "/" + c.project : ""}`)
    }
  })

contact
  .command("add")
  .description("add a contactMap entry")
  .requiredOption("--client <name>", "client this contact belongs to")
  .option("--channel <name>", "telegram | whatsapp | slack | discord")
  .option("--chat-id <id>", "native chat id (e.g. -100…, JID)")
  .option("--username <handle>", "sender username/handle")
  .option("--sender-id <id>", "numeric sender id (when username is unstable)")
  .option("--project <id>", "project this traffic should attribute to")
  .option("--display-name <name>", "display-name override for the initiator pill")
  .action((opts) => {
    if (!opts.chatId && !opts.username && !opts.senderId) {
      console.log(chalk.red("  one of --chat-id / --username / --sender-id is required"))
      process.exit(1)
    }
    mutate((cfg) => {
      cfg.business = cfg.business || {}
      cfg.business.contactMap = cfg.business.contactMap || []
      const entry: any = { client: opts.client }
      if (opts.channel) entry.channel = opts.channel
      if (opts.chatId) entry.chatId = opts.chatId
      if (opts.username) entry.username = opts.username
      if (opts.senderId) entry.senderId = opts.senderId
      if (opts.project) entry.project = opts.project
      if (opts.displayName) entry.displayName = opts.displayName
      cfg.business.contactMap.push(entry)
      const key = opts.chatId || opts.username || opts.senderId
      return `contact ${opts.channel ? opts.channel + "/" : ""}${key} → ${opts.client}${opts.project ? "/" + opts.project : ""} added`
    })
  })

contact
  .command("remove")
  .alias("rm")
  .description("remove a contactMap entry by matching field(s)")
  .option("--channel <name>")
  .option("--chat-id <id>")
  .option("--username <handle>")
  .option("--sender-id <id>")
  .action((opts) => {
    mutate((cfg) => {
      const list = cfg.business?.contactMap || []
      const before = list.length
      cfg.business.contactMap = list.filter((c: any) => {
        if (opts.channel && c.channel !== opts.channel) return true
        if (opts.chatId && c.chatId !== opts.chatId) return true
        if (opts.username && c.username !== opts.username) return true
        if (opts.senderId && c.senderId !== opts.senderId) return true
        return false  // matched all provided filters → drop
      })
      if (cfg.business.contactMap.length === before) throw new Error("no matching contact entry")
      return `${before - cfg.business.contactMap.length} contact entry/entries removed`
    })
  })
