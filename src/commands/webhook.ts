import { Command } from "commander"
import chalk from "chalk"
import prompts from "prompts"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { applyConfigMutation } from "@/daemon/config-mutator"

// --- agentx webhook — manage webhook entries from the CLI ---
//
// CLI parity with the dashboard's /admin → Webhooks tab. Mutates agentx.json
// directly through applyConfigMutation, which validates with Zod and signals
// the running daemon to hot-reload (no restart required).
//
// Subcommands:
//   list                                  — print all webhook entries
//   add [id]                              — interactive add (or use flags)
//   remove <id>                           — delete a webhook entry
//   enable <id>                           — enable a webhook
//   disable <id>                          — disable a webhook
//   triggers set <id> <event> <workflow>  — map event-type to workflow id
//   triggers remove <id> <event>          — remove a trigger map entry
//   triggers default <id> <workflow>      — set default workflow (no event match)

const VALID_SOURCES = ["gitlab", "github", "sentry", "stripe", "vercel", "odoo", "hubspot", "discord", "slack", "custom"] as const
type WebhookSource = (typeof VALID_SOURCES)[number]

const WIRED_SOURCES = new Set<WebhookSource>(["gitlab", "github", "sentry", "stripe", "vercel", "odoo", "hubspot"])

const SOURCE_HINTS: Record<WebhookSource, string> = {
  gitlab: "GitLab → Settings → Webhooks (tick Push/Issue/Pipeline events)",
  github: "GitHub → Repo Settings → Webhooks",
  sentry: "Sentry → Project Settings → Alerts → Webhooks",
  stripe: "Stripe Dashboard → Developers → Webhooks",
  vercel: "Vercel → Project Settings → Webhooks",
  odoo: "Odoo → Settings → Technical → Automation → Webhooks (or your installed `webhook` module)",
  hubspot: "HubSpot → Settings → Integrations → Private Apps → Webhooks subscription",
  discord: "Discord channel → Integrations → Webhooks (inbound-only, no on:* events)",
  slack: "Slack Outgoing Webhooks / Events API (inbound-only, no on:* events)",
  custom: "Any service that POSTs JSON — Linear, Calendly, Notion, etc. (inbound-only)",
}

function loadConfig(): any {
  const p = resolve(process.cwd(), "agentx.json")
  if (!existsSync(p)) throw new Error("No agentx.json found. Run: agentx init")
  return JSON.parse(readFileSync(p, "utf-8"))
}

function statusBadge(w: any): string {
  if (!w.enabled) return chalk.dim("disabled")
  const missingSecret = w.source !== "custom" && !w.secretEnv
  if (missingSecret) return chalk.yellow("⚠ no signing secret")
  return chalk.green("✓ active")
}

function printOneJson(w: any): void {
  console.log(JSON.stringify(w, null, 2))
}

function printOneHuman(w: any, daemonUrl?: string): void {
  const url = daemonUrl
    ? `${daemonUrl.replace(/\/+$/, "")}/webhook/${encodeURIComponent(w.agentId)}/${encodeURIComponent(w.source)}`
    : `/webhook/${encodeURIComponent(w.agentId)}/${encodeURIComponent(w.source)}`
  const wired = WIRED_SOURCES.has(w.source) ? chalk.dim(" · emits on:" + w.source + "-* hook events") : ""
  console.log(`  ${chalk.cyan(w.id)}  ${statusBadge(w)}`)
  console.log(`    ${chalk.dim(w.source)} → ${chalk.bold(w.agentId)}${wired}`)
  console.log(`    POST ${chalk.dim(url)}`)
  if (w.secretEnv) console.log(`    secret: ${chalk.dim("$" + w.secretEnv)}`)
  if (w.description) console.log(`    ${chalk.dim(w.description)}`)
  const triggers = w.triggers && typeof w.triggers === "object" ? w.triggers : {}
  const triggerKeys = Object.keys(triggers)
  if (triggerKeys.length) {
    console.log(`    ${chalk.dim("triggers:")}`)
    for (const k of triggerKeys) console.log(`      ${k} → ${triggers[k]}`)
  }
  if (w.defaultWorkflow) {
    console.log(`    ${chalk.dim("default workflow:")} ${w.defaultWorkflow}`)
  }
  console.log()
}

export const webhook = new Command()
  .name("webhook")
  .description("manage webhook entries (gitlab, github, sentry, stripe, vercel, custom)")

// agentx webhook list
webhook
  .command("list")
  .alias("ls")
  .description("list webhook entries")
  .option("--json", "emit JSON")
  .action((opts) => {
    const cfg = loadConfig()
    const entries = Array.isArray(cfg.webhooks) ? cfg.webhooks : []
    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2))
      return
    }
    if (!entries.length) {
      console.log(chalk.dim("\n  No webhooks registered. Add one with: agentx webhook add\n"))
      return
    }
    console.log()
    for (const w of entries) printOneHuman(w)
  })

// agentx webhook add [id]
webhook
  .command("add [id]")
  .description("register a new webhook entry")
  .option("--source <source>", `one of: ${VALID_SOURCES.join(", ")}`)
  .option("--agent <agentId>", "agent that receives the webhook")
  .option("--secret-env <name>", "env var holding the signing secret (recommended)")
  .option("--description <text>", "free-text description")
  .option("--no-prompt", "fail instead of prompting for missing values")
  .action(async (idArg, opts) => {
    const cfg = loadConfig()
    const knownAgents = Object.keys(cfg.agents || {})
    if (!knownAgents.length) throw new Error("No agents configured. Add one with: agentx agent add")

    let id = (idArg || "").trim()
    let source = String(opts.source || "").trim() as WebhookSource
    let agentId = String(opts.agent || "").trim()
    let secretEnv = String(opts.secretEnv || "").trim()
    let description = String(opts.description || "").trim()

    const interactive = opts.prompt !== false

    if (!id && interactive) {
      const r = await prompts({
        type: "text",
        name: "id",
        message: "Webhook id (lowercase, e.g. mtgl-gitlab)",
        validate: (v: string) => /^[a-z0-9][a-z0-9_-]*$/.test(v) || "Use lowercase letters, digits, -, _",
      })
      id = (r.id || "").trim()
    }
    if (!id) throw new Error("Webhook id is required.")
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("Webhook id must be lowercase (letters, digits, -, _).")

    if (!source && interactive) {
      const r = await prompts({
        type: "select",
        name: "source",
        message: "Source",
        choices: VALID_SOURCES.map((s) => ({
          title: `${s}${WIRED_SOURCES.has(s) ? "  ✓ wired" : ""}`,
          value: s,
          description: SOURCE_HINTS[s],
        })),
      })
      source = r.source
    }
    if (!VALID_SOURCES.includes(source)) {
      throw new Error(`Source must be one of: ${VALID_SOURCES.join(", ")}`)
    }

    if (!agentId && interactive) {
      const r = await prompts({
        type: "select",
        name: "agentId",
        message: "Agent",
        choices: knownAgents.map((a) => ({ title: a, value: a })),
      })
      agentId = r.agentId
    }
    if (!agentId) throw new Error("Agent is required.")
    if (!cfg.agents?.[agentId]) throw new Error(`Unknown agent "${agentId}".`)

    if (!secretEnv && interactive && source !== "custom") {
      const r = await prompts({
        type: "text",
        name: "secretEnv",
        message: `Signing secret env-var (recommended for ${source})`,
        initial: `${source.toUpperCase()}_WEBHOOK_SECRET`,
      })
      secretEnv = (r.secretEnv || "").trim()
    }

    if (!description && interactive) {
      const r = await prompts({ type: "text", name: "description", message: "Description (optional)" })
      description = (r.description || "").trim()
    }

    const result = await applyConfigMutation((c: any) => {
      c.webhooks = Array.isArray(c.webhooks) ? c.webhooks : []
      if (c.webhooks.find((w: any) => w.id === id)) {
        throw new Error(`Webhook "${id}" already exists.`)
      }
      const entry: any = { id, source, agentId, enabled: true }
      if (secretEnv) entry.secretEnv = secretEnv
      if (description) entry.description = description
      c.webhooks.push(entry)
    })
    if (!result.success) throw new Error(result.error)

    console.log(chalk.green(`✓ added webhook "${id}" (${source} → ${agentId})`))
    if (result.reloaded) console.log(chalk.dim("  daemon hot-reloaded"))
    if (!secretEnv && source !== "custom") {
      console.log(chalk.yellow(`  ⚠ no signing secret set — payloads will be accepted unsigned. Add one with --secret-env`))
    }
  })

// agentx webhook remove <id>
webhook
  .command("remove <id>")
  .alias("rm")
  .description("delete a webhook entry")
  .option("--yes", "skip confirmation")
  .action(async (id, opts) => {
    if (!opts.yes) {
      const r = await prompts({ type: "confirm", name: "ok", message: `Delete webhook "${id}"?`, initial: false })
      if (!r.ok) return
    }
    const result = await applyConfigMutation((c: any) => {
      const before = (c.webhooks || []).length
      c.webhooks = (c.webhooks || []).filter((w: any) => w.id !== id)
      if (c.webhooks.length === before) throw new Error(`Webhook "${id}" not found.`)
    })
    if (!result.success) throw new Error(result.error)
    console.log(chalk.green(`✓ removed webhook "${id}"`))
  })

// agentx webhook enable <id> / disable <id>
function toggleEnabled(enabled: boolean) {
  return async (id: string) => {
    const result = await applyConfigMutation((c: any) => {
      const w = (c.webhooks || []).find((x: any) => x.id === id)
      if (!w) throw new Error(`Webhook "${id}" not found.`)
      w.enabled = enabled
    })
    if (!result.success) throw new Error(result.error)
    console.log(chalk.green(`✓ ${enabled ? "enabled" : "disabled"} webhook "${id}"`))
  }
}

webhook.command("enable <id>").description("enable a webhook entry").action(toggleEnabled(true))
webhook.command("disable <id>").description("disable a webhook entry").action(toggleEnabled(false))

// agentx webhook triggers ...
const triggers = new Command()
  .name("triggers")
  .description("manage event-type → workflow mappings on a webhook")

triggers
  .command("set <id> <eventType> <workflowId>")
  .description("map an event-type to a workflow id")
  .action(async (id: string, eventType: string, workflowId: string) => {
    const result = await applyConfigMutation((c: any) => {
      const w = (c.webhooks || []).find((x: any) => x.id === id)
      if (!w) throw new Error(`Webhook "${id}" not found.`)
      w.triggers = w.triggers && typeof w.triggers === "object" ? w.triggers : {}
      w.triggers[eventType] = workflowId
    })
    if (!result.success) throw new Error(result.error)
    console.log(chalk.green(`✓ ${id}: ${eventType} → ${workflowId}`))
  })

triggers
  .command("remove <id> <eventType>")
  .alias("rm")
  .description("remove an event-type → workflow mapping")
  .action(async (id: string, eventType: string) => {
    const result = await applyConfigMutation((c: any) => {
      const w = (c.webhooks || []).find((x: any) => x.id === id)
      if (!w) throw new Error(`Webhook "${id}" not found.`)
      if (w.triggers && typeof w.triggers === "object") delete w.triggers[eventType]
    })
    if (!result.success) throw new Error(result.error)
    console.log(chalk.green(`✓ removed trigger ${eventType} from "${id}"`))
  })

triggers
  .command("default <id> <workflowId>")
  .description("set the default workflow when no event-type matches (use '-' to clear)")
  .action(async (id: string, workflowId: string) => {
    const clear = workflowId === "-" || workflowId === ""
    const result = await applyConfigMutation((c: any) => {
      const w = (c.webhooks || []).find((x: any) => x.id === id)
      if (!w) throw new Error(`Webhook "${id}" not found.`)
      if (clear) delete w.defaultWorkflow
      else w.defaultWorkflow = workflowId
    })
    if (!result.success) throw new Error(result.error)
    console.log(chalk.green(`✓ ${id}: defaultWorkflow ${clear ? "cleared" : `→ ${workflowId}`}`))
  })

webhook.addCommand(triggers)

// agentx webhook sources — list known sources with hints
webhook
  .command("sources")
  .description("list known webhook source types")
  .option("--json", "emit JSON")
  .action((opts) => {
    const list = VALID_SOURCES.map((s) => ({
      source: s,
      wired: WIRED_SOURCES.has(s),
      hint: SOURCE_HINTS[s],
    }))
    if (opts.json) {
      console.log(JSON.stringify(list, null, 2))
      return
    }
    console.log()
    for (const item of list) {
      const tag = item.wired ? chalk.green("✓ wired") : chalk.dim("inbound-only")
      console.log(`  ${chalk.cyan(item.source.padEnd(8))}  ${tag}  ${chalk.dim(item.hint)}`)
    }
    console.log()
    console.log(chalk.dim("  Wired sources emit on:<source>-* hook events that workflows can subscribe to via trigger.hook."))
    console.log(chalk.dim("  Use 'custom' for any service not in the list (Odoo, HubSpot, Linear, Calendly, etc.)."))
    console.log()
  })
