import { Command } from "commander"
import chalk from "chalk"
import { mutateAgentxConfig } from "@/daemon/config-mutate"
import { loadDaemonConfig } from "@/daemon/config"

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
    if (orgEntries.length === 0) console.log(chalk.dim("    (empty)"))
    else for (const [id, e] of orgEntries) {
      const reports = e.reportsTo ? chalk.dim(` → reports to ${e.reportsTo}`) : ""
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
    for (const [id, e] of entries) {
      console.log(`  ${chalk.cyan(id)}  ${e.role}${e.reportsTo ? chalk.dim(` → ${e.reportsTo}`) : ""}`)
    }
  })

orgchart
  .command("add <agentId>")
  .description("add or update an orgChart entry for an agent")
  .requiredOption("--role <role>", "role title (e.g. 'PM', 'Coder', 'DevOps')")
  .option("--reports-to <agentId>", "manager's agentId")
  .option("--start <hh:mm>", "schedule start", "09:00")
  .option("--end <hh:mm>", "schedule end", "17:00")
  .option("--days <csv>", "working days (mon,tue,wed,thu,fri)", "mon,tue,wed,thu,fri")
  .option("--utilization <0..1>", "target utilization", "0.8")
  .action((agentId: string, opts) => {
    const days = String(opts.days).split(",").map((s) => s.trim()).filter(Boolean) as Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">
    mutate((cfg) => {
      cfg.business = cfg.business || {}
      cfg.business.orgChart = cfg.business.orgChart || {}
      cfg.business.orgChart[agentId] = {
        role: opts.role,
        ...(opts.reportsTo ? { reportsTo: opts.reportsTo } : {}),
        schedule: { days, start: opts.start, end: opts.end },
        utilizationTarget: parseFloat(opts.utilization) || 0.8,
      }
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
