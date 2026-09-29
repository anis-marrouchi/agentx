import { Command } from "commander"
import chalk from "chalk"
import { applyConfigMutation } from "@/daemon/config-mutator"
import { loadDaemonConfig } from "@/daemon/config"
import { openDb } from "@/storage/sqlite"
import { TriageStore } from "@/whatsapp-triage/store"

// --- agentx whatsapp triage: watched WhatsApp chats (#328) ---
//
// CLI parity with the dashboard's Webhooks tab → WhatsApp triage. Edits
// agentx.json through applyConfigMutation (validated, then hot-reloaded).
// Run it from the folder that holds agentx.json.
//
//   status                     settings, rules, whether the secret is set
//   on | off                   turn triage on or off
//   log [--limit N]            the latest triage results
//   rule add <id> --agent A --chat JID [--sender JID] [--prompt T] [--quiet HH:MM-HH:MM] [--auto-ack]
//   rule remove|enable|disable <id>

export const triage = new Command("triage")
  .description("route messages from watched WhatsApp chats to an agent (needs `wacli sync --webhook`)")

async function mutate(change: (t: any, cfg: any) => string): Promise<void> {
  let summary = ""
  const r = await applyConfigMutation((c: any) => {
    c.whatsappTriage = c.whatsappTriage && typeof c.whatsappTriage === "object" ? c.whatsappTriage : {}
    c.whatsappTriage.rules = Array.isArray(c.whatsappTriage.rules) ? c.whatsappTriage.rules : []
    summary = change(c.whatsappTriage, c)
  })
  if (!r.success) { console.error(chalk.red(`✗ ${r.error}`)); process.exit(1) }
  console.log(chalk.green(`✓ ${summary}`))
  if (r.reloaded) console.log(chalk.dim("  daemon hot-reloaded"))
}

function findRule(t: any, id: string): any {
  const rule = t.rules.find((r: any) => r.id === id)
  if (!rule) throw new Error(`No watch rule "${id}". See \`agentx whatsapp triage status\`.`)
  return rule
}

const collect = (v: string, prev: string[] = []): string[] => [...prev, v]

triage
  .command("status")
  .description("show triage settings and watch rules")
  .action(() => {
    const t = loadDaemonConfig().whatsappTriage
    const secret = !!process.env[t.secretEnv]
    console.log()
    console.log(`  WhatsApp triage: ${t.enabled ? chalk.green("on") : chalk.yellow("off")}`)
    console.log(`  Webhook secret (${t.secretEnv}): ${secret ? chalk.green("set in this shell") : chalk.yellow("not set in this shell; the daemon needs it too")}`)
    console.log(`  Batch: ${t.batchSeconds} s · auto-acknowledge allowed: ${t.allowAutoAck ? "yes" : "no"}`)
    console.log()
    if (t.rules.length === 0) console.log(chalk.dim("  no watch rules yet: agentx whatsapp triage rule add <id> --agent <agent> --chat <number or JID>"))
    for (const r of t.rules) {
      const quiet = r.quietHours ? ` · quiet ${r.quietHours.start}–${r.quietHours.end}` : ""
      console.log(`  ${r.enabled ? chalk.green("●") : chalk.dim("○")} ${chalk.bold(r.id)} → ${r.agent}${quiet}${r.autoAck ? " · autoAck" : ""}`)
      if (r.chats.length) console.log(chalk.dim(`      chats: ${r.chats.join(", ")}`))
      if (r.senders.length) console.log(chalk.dim(`      senders: ${r.senders.join(", ")}`))
    }
    console.log()
  })

triage.command("on").description("turn triage on").action(() => mutate((t) => { t.enabled = true; return "WhatsApp triage is on" }))
triage.command("off").description("turn triage off").action(() => mutate((t) => { t.enabled = false; return "WhatsApp triage is off" }))

triage
  .command("log")
  .description("the latest triage results")
  .option("--limit <n>", "how many", "20")
  .action((opts) => {
    const db = openDb()
    if (!db) { console.error(chalk.red("✗ can't open .agentx/db.sqlite here; run this from the AgentX folder")); process.exit(1) }
    const rows = new TriageStore(db).recent(Math.max(1, Number(opts.limit) || 20))
    if (rows.length === 0) { console.log(chalk.dim("  nothing triaged yet")); return }
    for (const r of rows) {
      const when = new Date(r.at).toISOString().slice(0, 16).replace("T", " ")
      const what = r.error ? chalk.red(r.error) : `${chalk.cyan(r.triage ?? "?")} ${r.summary}`
      console.log(`  ${chalk.dim(when)}  ${r.ruleId}  ${r.chatName ?? r.chat}  (${r.messages})  ${what}${r.draftId ? chalk.dim(`  draft whatsapp:${r.draftId}`) : ""}`)
    }
  })

const rule = triage.command("rule").description("add, remove, enable or disable a watch rule")

rule
  .command("add <id>")
  .description("watch a chat (or people) and send its messages to an agent")
  .requiredOption("--agent <agent>", "the agent that triages")
  .option("--chat <jid>", "a chat to watch: phone number, contact JID or group JID (repeatable)", collect)
  .option("--sender <jid>", "only messages from this person (repeatable)", collect)
  .option("--prompt <text>", "extra instructions for the agent")
  .option("--quiet <range>", "no notifications in this window, e.g. 22:00-07:00")
  .option("--auto-ack", "send short acknowledgements without asking (also needs allowAutoAck)")
  .action((id: string, opts) => mutate((t, cfg) => {
    if (!cfg.agents?.[opts.agent]) throw new Error(`No agent "${opts.agent}" on this computer.`)
    if (t.rules.some((r: any) => r.id === id)) throw new Error(`Watch rule "${id}" already exists.`)
    const entry: any = { id, agent: opts.agent, chats: opts.chat ?? [], senders: opts.sender ?? [] }
    if (opts.prompt) entry.prompt = opts.prompt
    if (opts.quiet) {
      const m = String(opts.quiet).match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/)
      if (!m) throw new Error("--quiet looks like 22:00-07:00")
      entry.quietHours = { start: m[1], end: m[2] }
    }
    if (opts.autoAck) entry.autoAck = true
    t.rules.push(entry)
    return `added watch rule "${id}" → ${opts.agent}`
  }))

rule.command("remove <id>").description("delete a watch rule").action((id: string) => mutate((t) => {
  findRule(t, id)
  t.rules = t.rules.filter((r: any) => r.id !== id)
  return `removed watch rule "${id}"`
}))

for (const [name, on] of [["enable", true], ["disable", false]] as const) {
  rule.command(`${name} <id>`).description(`${name} a watch rule`).action((id: string) => mutate((t) => {
    findRule(t, id).enabled = on
    return `watch rule "${id}" ${on ? "enabled" : "disabled"}`
  }))
}
