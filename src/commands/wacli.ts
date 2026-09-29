import { Command } from "commander"
import chalk from "chalk"
import { findConfigPath } from "@/daemon/config-mutator"
import { loadDaemonConfig } from "@/daemon/config"
import { normalizeJid } from "@/wacli/rules"
import {
  parseQuietHours, readWacliConfig, removeWacliRule, saveWacliRule, updateWacliSettings, wacliSummary, type WacliSettingsPatch,
} from "@/wacli/settings"
import { wacliSignature } from "@/wacli/signature"
import { WACLI_WEBHOOK_PATH } from "@/wacli/webhook"

// --- agentx wacli — WhatsApp triage for watched chats (#328) ---
//
// Settings and watch rules live in agentx.json under `wacli`
// (src/wacli/settings.ts, shared with the dashboard). `test` posts a
// signed message to the running daemon, the way `wacli sync --webhook`
// does, to check the setup end to end.

export const wacliCmd = new Command("wacli")
  .description("WhatsApp triage: watch chosen chats, let an agent sort what arrives (nothing is sent without your yes)")

function fail(msg: string): void {
  console.error(chalk.red(`  ${msg}`))
  process.exitCode = 1
}

function saved(r: { success: boolean; error?: string; reloaded?: boolean }): boolean {
  if (!r.success) { fail(r.error ?? "not saved"); return false }
  console.log(chalk.green("  ✓ saved") + (r.reloaded ? chalk.dim(" (daemon reloaded)") : ""))
  return true
}

function daemonUrl(): string {
  if (process.env.AGENTX_DAEMON_URL) return process.env.AGENTX_DAEMON_URL
  try {
    return `http://${loadDaemonConfig(findConfigPath()).node.bind.replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`
  } catch {
    return "http://127.0.0.1:18800"
  }
}

wacliCmd
  .command("status")
  .description("show whether triage is on, the secret, and the watch rules")
  .action(() => {
    const s = wacliSummary(readWacliConfig())
    console.log(`  Triage          ${s.enabled ? chalk.green("on") : "off"}`)
    console.log(`  Secret          ${s.secretSet ? "set" : chalk.yellow(`not set (put it in ${s.secretEnv})`)}`)
    console.log(`  Batch window    ${s.batchSeconds} s`)
    console.log(`  Images, voice   ${s.media ? "read" : "not read"}`)
    console.log(`  Webhook URL     ${daemonUrl()}${WACLI_WEBHOOK_PATH}`)
    if (!s.rules.length) { console.log(chalk.dim("  No rules yet: agentx wacli rules add <id> --chat <number> --agent <agent>")); return }
    console.log("  Rules")
    for (const r of s.rules) {
      const match = [r.chat && `chat ${r.chat}`, r.sender && `sender ${r.sender}`, r.group && `group ${r.group}`].filter(Boolean).join(", ")
      const extra = [r.quietHours && `quiet ${r.quietHours.start}-${r.quietHours.end}`, r.autoAck && "autoAck", !r.enabled && "off"].filter(Boolean).join(", ")
      console.log(`    ${chalk.bold(r.id)}  ${match} → ${r.agent}${extra ? chalk.dim(`  (${extra})`) : ""}`)
    }
  })

wacliCmd
  .command("settings")
  .description("change triage settings (wacli in agentx.json)")
  .option("--enable", "turn triage on")
  .option("--disable", "turn triage off")
  .option("--batch-seconds <n>", "messages from one chat this close together become one task")
  .option("--secret-env <NAME>", "environment variable holding the webhook secret")
  .option("--media <on|off>", "download images and voice notes for the agent")
  .option("--binary <path>", "wacli binary; \"default\" to find it on PATH")
  .option("--account <name>", "wacli --account; \"default\" for the default store")
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const patch: WacliSettingsPatch = {}
    if (opts.enable) patch.enabled = true
    if (opts.disable) patch.enabled = false
    if (opts.batchSeconds !== undefined) {
      const n = Number(opts.batchSeconds)
      if (!Number.isInteger(n) || n < 0 || n > 600) return fail("--batch-seconds takes a whole number from 0 to 600")
      patch.batchSeconds = n
    }
    if (typeof opts.secretEnv === "string") patch.secretEnv = opts.secretEnv
    if (opts.media !== undefined) {
      if (opts.media !== "on" && opts.media !== "off") return fail("--media takes on or off")
      patch.media = opts.media === "on"
    }
    if (typeof opts.binary === "string") patch.binary = opts.binary === "default" ? null : opts.binary
    if (typeof opts.account === "string") patch.account = opts.account === "default" ? null : opts.account
    if (!Object.keys(patch).length) return fail("nothing to change; see agentx wacli settings --help")
    saved(await updateWacliSettings(patch))
  })

const rules = wacliCmd.command("rules").description("the chats triage watches")

rules
  .command("list")
  .description("list watch rules")
  .action(() => {
    for (const r of readWacliConfig().rules) console.log(`  ${r.id}\t${r.chat ?? ""}\t${r.sender ?? ""}\t${r.group ?? ""}\t→ ${r.agent}`)
  })

rules
  .command("add <id>")
  .description("watch a chat, sender or group (replaces a rule with the same id)")
  .requiredOption("--agent <id>", "the agent that triages these messages")
  .option("--chat <number-or-jid>", "a chat: phone number or JID")
  .option("--sender <number-or-jid>", "who wrote it, in any chat")
  .option("--group <name-or-jid>", "a group, by exact name or JID")
  .option("--prompt <text>", "instructions for this chat, e.g. where the tracker is")
  .option("--quiet <HH:MM-HH:MM>", "no notifications and no auto-acknowledgement in this window")
  .option("--timezone <zone>", "IANA timezone for --quiet; default this machine's")
  .option("--auto-ack", "send acknowledgement drafts without asking (off unless given)")
  .option("--off", "save the rule turned off")
  .action(async (id: string, opts: Record<string, string | boolean | undefined>) => {
    const rule: Record<string, unknown> = { id, agent: opts.agent }
    for (const k of ["chat", "sender"] as const) if (typeof opts[k] === "string") rule[k] = normalizeJid(opts[k] as string)
    if (typeof opts.group === "string") rule.group = opts.group
    if (typeof opts.prompt === "string") rule.prompt = opts.prompt
    if (typeof opts.quiet === "string") {
      const q = parseQuietHours(opts.quiet)
      if (!q) return fail("--quiet takes HH:MM-HH:MM, for example 22:00-07:00")
      rule.quietHours = typeof opts.timezone === "string" ? { ...q, timezone: opts.timezone } : q
    }
    if (opts.autoAck) rule.autoAck = true
    if (opts.off) rule.enabled = false
    saved(await saveWacliRule(rule))
  })

rules
  .command("remove <id>")
  .description("stop watching")
  .action(async (id: string) => { saved(await removeWacliRule(id)) })

wacliCmd
  .command("test")
  .description("post a signed test message to the running daemon, as wacli would")
  .requiredOption("--chat <number-or-jid>", "the chat it seems to come from (a watched one)")
  .option("--text <text>", "the message", "Test message from agentx wacli test: please reply 'received'.")
  .option("--name <name>", "the chat's name", "Test contact")
  .action(async (opts: { chat: string; text: string; name: string }) => {
    const s = readWacliConfig()
    const secret = s.secret || process.env[s.secretEnv]
    if (!secret) return fail(`no secret: set ${s.secretEnv} in this shell (the same value the daemon has)`)
    const chat = normalizeJid(opts.chat)
    const body = JSON.stringify({
      Chat: chat, ID: `AGENTX-TEST-${Date.now()}`, SenderJID: chat, Timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      FromMe: false, Text: opts.text, PushName: opts.name, ChatName: opts.name, Media: null,
    })
    const url = `${daemonUrl()}${WACLI_WEBHOOK_PATH}`
    let res: Response
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-wacli-signature": wacliSignature(secret, body) }, body })
    } catch (e: any) {
      return fail(`the daemon didn't answer at ${url}: ${e?.cause?.code ?? e?.message ?? e}`)
    }
    const reply = await res.json().catch(() => ({})) as { result?: string; error?: string }
    if (res.status !== 202) return fail(`${res.status}: ${reply.error ?? "refused"}`)
    if (reply.result === "unwatched") return fail(`accepted, but no rule watches ${chat}: nothing was kept`)
    console.log(chalk.green(`  ✓ ${reply.result}`) + chalk.dim(` — the agent triages it after ${s.batchSeconds} s; a drafted reply appears in Approvals`))
  })
