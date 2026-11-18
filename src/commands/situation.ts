import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx situation — the courtesy-close gate (#1892) ---
//
//   agentx situation log [--limit 50] [--dropped | --would-drop]
//       what the gate dropped (active mode) or would have dropped (shadow)
//   agentx situation release <id>
//       re-deliver a dropped message: the talk goes back to "during" and
//       the message reaches the agent once, past the gate
//
// Settings: `agentx config set situations.mode shadow|active|off`.

export const situationCmd = new Command()
  .name("situation")
  .description("see and undo what the courtesy-close gate dropped (goodbye loops)")

interface Opts { node?: string; token?: string; config?: string }

function resolveDaemon(opts: Opts): { baseUrl: string; token: string } {
  let baseUrl = typeof opts.node === "string" ? opts.node : ""
  let token = typeof opts.token === "string" ? opts.token : ""
  if (!baseUrl || !token) {
    try {
      const cfg = loadDaemonConfig(opts.config)
      if (!baseUrl) baseUrl = cfg.dashboard?.daemonUrl || ""
      if (!token) token = cfg.dashboard?.token || ""
    } catch { /* fall back to defaults */ }
  }
  if (!baseUrl) baseUrl = "http://localhost:18800"
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token }
}

async function call(opts: Opts, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<any> {
  const { baseUrl, token } = resolveDaemon(opts)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  } catch (e: any) {
    console.log(chalk.red(`  could not reach daemon at ${baseUrl}: ${e.message || e}`))
    process.exit(1)
  }
  const data = await res.json().catch(() => ({})) as any
  if (!res.ok) {
    console.log(chalk.red(`  HTTP ${res.status}${data.error ? ` — ${data.error}` : ""}`))
    process.exit(1)
  }
  return data
}

const common = (c: Command) => c
  .option("-c, --config <path>", "daemon config file")
  .option("--node <url>", "daemon URL (defaults to dashboard.daemonUrl)")
  .option("--token <token>", "bearer token (defaults to dashboard.token)")

common(situationCmd
  .command("log")
  .description("list messages the gate dropped, or in shadow mode would have dropped")
  .option("-n, --limit <n>", "how many rows, newest first", "50")
  .option("--dropped", "only messages really dropped (active mode)")
  .option("--would-drop", "only messages shadow mode let through")
  .option("--json", "print JSON"))
  .action(async (opts) => {
    const q = new URLSearchParams({ limit: String(Number(opts.limit) || 50) })
    if (opts.dropped) q.set("outcome", "drop")
    else if (opts.wouldDrop) q.set("outcome", "would-drop")
    const data = await call(opts, "GET", `/situations/gate-log?${q}`)
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
    console.log(chalk.bold(`  Courtesy gate: ${data.mode}`))
    if (!data.rows?.length) { console.log("  Nothing dropped yet."); return }
    for (const r of data.rows) {
      const when = new Date(r.at).toISOString().slice(0, 16).replace("T", " ")
      const tag = r.outcome === "drop" ? chalk.red("dropped") : chalk.yellow("would drop")
      const done = r.releasedAt ? chalk.green(" (released)") : ""
      console.log(`  #${r.id}  ${when}  ${tag}${done}  ${r.channel} ${r.chatId}  ${r.senderKind} ${r.senderName || r.senderId}`)
      console.log(chalk.dim(`        "${String(r.text).slice(0, 100)}"  — ${r.reason}`))
    }
  })

common(situationCmd
  .command("release <id>")
  .description("re-deliver a dropped message to the agent, once, and reopen the talk"))
  .action(async (id: string, opts) => {
    const data = await call(opts, "POST", "/situations/release", { id: Number(id) })
    console.log(chalk.green(`  Released row #${data.id}: message ${data.messageId ?? "?"} goes to the agent again.`))
  })
