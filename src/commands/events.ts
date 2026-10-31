import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"
import { formatEventLine } from "@/events/subscriptions"
import type { EventEnvelope } from "@/events/envelope"

// --- agentx events — catch up on recent events ---
//
//     agentx events                          # the node's recent events
//     agentx events --agent helper           # what helper's subscriptions matched
//     agentx events --agent helper --since <id|iso>
//     agentx events emit render:ready --summary "batch 3 done"   # #1284
//
// Reads the daemon's in-memory ring: /agents/:id/events for one agent's
// subscriptions (the same answer the agentx_events MCP tool gives), or
// /events/recent for everything. Summaries only, bounded count.

/** URL to read, for the given options. Exported for tests. */
export function eventsUrl(baseUrl: string, opts: { agent?: string; since?: string; limit?: string; kind?: string }): string {
  const base = baseUrl.replace(/\/+$/, "")
  const qs = new URLSearchParams()
  if (opts.since) qs.set("since", opts.since)
  if (opts.limit) qs.set("limit", opts.limit)
  if (opts.agent) {
    const q = qs.toString()
    return `${base}/agents/${encodeURIComponent(opts.agent)}/events${q ? `?${q}` : ""}`
  }
  if (opts.kind) qs.set("kind", opts.kind)
  if (!opts.limit) qs.set("limit", "50")
  return `${base}/events/recent?${qs}`
}

/** Body of POST /events for `agentx events emit`. Run inside an agent's
 *  turn (a Bash step), the turn's ids ride along so the daemon credits the
 *  agent and keeps the turn's root. Exported for tests. */
export function emitBody(
  name: string,
  opts: { summary?: string; ref?: string; by?: string; expiresIn?: string },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const body: Record<string, string> = { name }
  if (opts.summary) body.summary = opts.summary
  if (opts.ref) body.ref = opts.ref
  if (opts.expiresIn) body.expiresIn = opts.expiresIn
  const by = opts.by || env.AGENTX_AGENT_ID
  if (by) body.by = by
  if (env.AGENTX_AGENT_ID) body.senderAgentId = env.AGENTX_AGENT_ID
  if (env.AGENTX_TASK_ID) body.callerTaskId = env.AGENTX_TASK_ID
  if (env.AGENTX_CHANNEL) body.callerChannel = env.AGENTX_CHANNEL
  if (env.AGENTX_CHAT_ID) body.callerChatId = env.AGENTX_CHAT_ID
  return body
}

function daemonTarget(opts: { config?: string; node?: string; token?: string }): { baseUrl: string; token: string } {
  let baseUrl = typeof opts.node === "string" ? opts.node : ""
  let token = typeof opts.token === "string" ? opts.token : ""
  if (!baseUrl || !token) {
    try {
      const cfg = loadDaemonConfig(opts.config)
      if (!baseUrl) baseUrl = cfg.dashboard?.daemonUrl || ""
      if (!token) token = cfg.dashboard?.token || ""
    } catch {
      // No config — fall back to localhost:18800 and no auth.
    }
  }
  return { baseUrl: (baseUrl || "http://localhost:18800").replace(/\/+$/, ""), token }
}

const emitCmd = new Command()
  .name("emit")
  .description("publish a named event (for example render:ready) that wakes the agents subscribed to it")
  .argument("<name>", "event name: letters, digits and : . _ -")
  .option("--summary <text>", "one short line on what happened")
  .option("--ref <ref>", "pointer to the details: an issue, a path, a run id")
  .option("--by <name>", "who emitted it (an agent id or a person's name; default: the running agent)")
  .option("--expires-in <duration>", "drop wakes not started within this time, for example 90s, 5m or 2h")
  .action(async (name: string, _opts, cmd: Command) => {
    const opts = cmd.optsWithGlobals() as { summary?: string; ref?: string; by?: string; expiresIn?: string; config?: string; node?: string; token?: string; json?: boolean }
    const { baseUrl, token } = daemonTarget(opts)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (token) headers["Authorization"] = `Bearer ${token}`
    try {
      const res = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(emitBody(name, opts)),
        signal: AbortSignal.timeout(10_000),
      })
      const data = await res.json().catch(() => ({})) as { error?: string; event?: EventEnvelope }
      if (!res.ok) {
        console.error(chalk.red(`  Event refused (${res.status}): ${data.error || "unknown error"}`))
        process.exitCode = 1
        return
      }
      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
      console.log(chalk.green(`  ✓ Emitted ${data.event?.type ?? name} on ${data.event?.node ?? "this machine"}`) + chalk.dim(` (event ${data.event?.id ?? "?"})`))
    } catch (e: any) {
      console.error(chalk.red(`  daemon unreachable at ${baseUrl}: ${e?.message || e}`))
      process.exitCode = 1
    }
  })

export const eventsCmd = new Command()
  .name("events")
  .description("recent events on this node, or those matching one agent's subscriptions")
  .option("-c, --config <path>", "daemon config file")
  .option("-a, --agent <id>", "only events matching this agent's subscriptions")
  .option("-s, --since <id|iso>", "only events after this event id or ISO time")
  .option("-k, --kind <kind>", "only this event kind (without --agent)")
  .option("-n, --limit <n>", "most events to show (with --agent: default 20, max 50)")
  .option("--json", "machine-readable output")
  .option("--node <url>", "daemon URL (defaults to dashboard.daemonUrl from config)")
  .option("--token <token>", "bearer token (defaults to dashboard.token from config)")
  .addCommand(emitCmd)
  .action(async (opts) => {
    const { baseUrl, token } = daemonTarget(opts)

    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    let data: { events?: EventEnvelope[]; next?: string; subscriptions?: number; error?: string }
    try {
      const res = await fetch(eventsUrl(baseUrl, opts), { headers, signal: AbortSignal.timeout(10_000) })
      data = await res.json().catch(() => ({})) as typeof data
      if (!res.ok) {
        console.error(chalk.red(`  ${data.error || `HTTP ${res.status}`}`))
        process.exitCode = 1
        return
      }
    } catch (e: any) {
      console.error(chalk.red(`  daemon unreachable at ${baseUrl}: ${e?.message || e}`))
      process.exitCode = 1
      return
    }

    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
    const events = data.events ?? []
    if (opts.agent && !data.subscriptions) {
      console.log(chalk.dim(`  ${opts.agent} has no subscriptions (agents.${opts.agent}.subscriptions in agentx.json)`))
      return
    }
    if (events.length === 0) { console.log(chalk.dim("  no events")); return }
    for (const e of events) console.log(`  ${formatEventLine(e)}  ${chalk.dim(e.id)}`)
    const next = data.next ?? events[events.length - 1].id
    console.log(chalk.dim(`\n  ${events.length} event(s). Newer ones: agentx events${opts.agent ? ` --agent ${opts.agent}` : ""} --since ${next}`))
  })
