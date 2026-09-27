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
  .action(async (opts) => {
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
    if (!baseUrl) baseUrl = "http://localhost:18800"

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
