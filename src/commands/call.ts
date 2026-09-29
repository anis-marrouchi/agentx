import { Command } from "commander"
import chalk from "chalk"
import { mutateAgentxConfig } from "@/daemon/config-mutate"
import type { Call } from "@/calls/store"
import { callerHeaders } from "@/calls/service"

// --- `agentx call` — an agent rings the owner (#321) ---
//
//   agentx call request --reason "…" [--urgent]   (inside an agent's run)
//   agentx call list [--status missed]
//   agentx call answer|decline|hangup <id>, agentx call later <id> [min]
//   agentx call allow <agent|*>, agentx call disallow <agent|*>
//
// Everything but allow/disallow goes through the daemon's /calls routes.
// The ringing itself happens in AgentX Voice.

const DAEMON = process.env.AGENTX_DAEMON_URL ?? "http://127.0.0.1:18800"

/** One request to the daemon's mesh-gated routes; `agentx camera` shares it. */
export async function daemon(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<any> {
  const token = process.env.MESH_TOKEN
  const res = await fetch(`${DAEMON}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e) => { throw new Error(`daemon not reachable at ${DAEMON}: ${e?.message ?? e}`) })
  const data = await res.json().catch(() => ({})) as any
  if (!res.ok) throw new Error(data?.error || `daemon ${res.status}`)
  return data
}

/** Add or remove an agent in calls.allow. Returns what changed. */
export function setCaller(cfg: any, agentId: string, allowed: boolean): string {
  cfg.calls = cfg.calls ?? {}
  const list: string[] = Array.isArray(cfg.calls.allow) ? cfg.calls.allow : []
  const has = list.includes(agentId)
  if (allowed === has) return `${agentId} is ${allowed ? "already" : "not"} in calls.allow`
  cfg.calls.allow = allowed ? [...list, agentId] : list.filter((a) => a !== agentId)
  return allowed ? `${agentId} may now call you` : `${agentId} may no longer call you`
}

function line(c: Call): string {
  const when = new Date(c.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  const mark = c.status === "missed" ? chalk.yellow("missed") : c.status === "ringing" ? chalk.green("ringing") : chalk.dim(c.status)
  const note = c.note ? chalk.dim(` (${c.note})`) : ""
  return `  ${chalk.dim(c.id)}  ${when}  ${c.agentId}  ${mark}${note}\n      ${c.reason}${c.summary ? chalk.dim(`\n      summary: ${c.summary}`) : ""}`
}

async function run(fn: () => Promise<void> | void): Promise<void> {
  try { await fn() } catch (e: any) {
    console.log(chalk.red(`  ${e?.message ?? e}`))
    process.exit(1)
  }
}

const request = new Command("request")
  .description("ask the owner for a live voice call (rings AgentX Voice); runs inside an agent's turn")
  .requiredOption("--reason <text>", "why, in one line: said aloud when they answer")
  .option("--urgent", "ring even during Focus")
  .option("--json", "print the call as JSON")
  .action((opts) => run(async () => {
    const agentId = process.env.AGENTX_AGENT_ID
    if (!agentId) throw new Error("no agent: calls are placed from inside an agent's run, which sets AGENTX_AGENT_ID")
    const r = await daemon("POST", "/calls", { agentId, reason: opts.reason, urgency: opts.urgent ? "urgent" : "normal" }, callerHeaders())
    if (opts.json) { console.log(JSON.stringify(r, null, 2)); return }
    const how = r.rang === "widget" ? "ringing on AgentX Voice"
      : r.rang === "notify" ? "AgentX Voice is not running; sent a notification instead"
      : `not rung: ${r.call.note ?? "held"} — it is listed as a missed call`
    console.log(`  ${r.rang ? chalk.green("☎") : chalk.yellow("⏸")} ${r.call.id} ${how}`)
  }))

const list = new Command("list")
  .description("recent calls, newest first")
  .option("--status <list>", "only these: ringing, answered, ended, declined, missed, later (comma-separated)")
  .option("--limit <n>", "how many", "20")
  .option("--json", "print as JSON")
  .action((opts) => run(async () => {
    const q = new URLSearchParams({ limit: String(opts.limit) })
    if (opts.status) q.set("status", opts.status)
    const { calls } = await daemon("GET", `/calls?${q}`)
    if (opts.json) { console.log(JSON.stringify(calls, null, 2)); return }
    if (!calls.length) { console.log(chalk.dim("  no calls")); return }
    for (const c of calls) console.log(line(c))
  }))

function act(name: string, description: string) {
  return new Command(name)
    .description(description)
    .argument("<id>", "call id, from `agentx call list`")
    .action((id: string) => run(async () => {
      const { call } = await daemon("POST", `/calls/${encodeURIComponent(id)}/${name}`, {})
      console.log(line(call))
    }))
}

const later = new Command("later")
  .description("ring again in N minutes")
  .argument("<id>", "call id")
  .argument("[minutes]", "minutes from now", "10")
  .action((id: string, minutes: string) => run(async () => {
    const { call } = await daemon("POST", `/calls/${encodeURIComponent(id)}/later`, { minutes: Number(minutes) })
    console.log(line(call))
  }))

function allowCmd(name: string, allowed: boolean) {
  return new Command(name)
    .description(allowed ? "let an agent call you (\"*\" for every agent)" : "stop an agent calling you")
    .argument("<agent>", "agent id, or \"*\"")
    .option("-c, --config <path>", "agentx.json to edit (default: ./agentx.json)")
    .action((agentId: string, opts) => run(() => {
      const { summary } = mutateAgentxConfig((cfg) => setCaller(cfg, agentId, allowed), { configPath: opts.config })
      console.log(chalk.green(`  ${summary}`))
    }))
}

export const call = new Command("call")
  .description("agents ring you for a live voice call")
  .addCommand(request)
  .addCommand(list)
  .addCommand(act("answer", "pick up a ringing call (AgentX Voice does this for you)"))
  .addCommand(act("decline", "decline a ringing call"))
  .addCommand(later)
  .addCommand(act("hangup", "end an answered call"))
  .addCommand(allowCmd("allow", true))
  .addCommand(allowCmd("disallow", false))
