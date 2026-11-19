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
//   agentx situation list [--agent <id>] [--phase during|ending|ended]
//       each chat's situation and phase (phase 2)
//   agentx situation end | not-this | clear <id>
//       a person's override (phase 2)
//   agentx situation sources
//       the signal sources on this node and what each answers (phase 3)
//   agentx situation closing <id> --purpose <text> --home <link> [--message <text>]
//       closing steps for a talk: a note, promises, one owner message (phase 4)
//
// Settings: `agentx config set situations.mode shadow|active|off`.

export const situationCmd = new Command()
  .name("situation")
  .description("see each chat's situation, end or reopen it, and undo what the courtesy-close gate dropped (goodbye loops)")

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

// Phase 2: see each chat's situation and override it (#1892).
common(situationCmd
  .command("list")
  .description("list each chat's situation and phase, newest change first")
  .option("-a, --agent <id>", "only chats this agent answers")
  .option("-p, --phase <phase>", "only this phase: during, ending or ended")
  .option("-n, --limit <n>", "how many rows", "50")
  .option("--json", "print JSON"))
  .action(async (opts) => {
    const q = new URLSearchParams({ limit: String(Number(opts.limit) || 50) })
    if (opts.agent) q.set("agent", String(opts.agent))
    if (opts.phase) q.set("phase", String(opts.phase))
    const data = await call(opts, "GET", `/situations?${q}`)
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
    console.log(chalk.bold(`  Courtesy gate: ${data.mode}`))
    if (!data.rows?.length) { console.log("  No conversations yet."); return }
    for (const r of data.rows) {
      const when = new Date(r.phaseChangedAt).toISOString().slice(0, 16).replace("T", " ")
      const tone = r.phase === "during" ? chalk.green : r.phase === "ending" ? chalk.yellow : chalk.dim
      const phase = tone(`${r.template} · ${r.phase}${r.phase === "ended" && r.endReason ? ` (${r.endReason})` : ""}`)
      const who = r.setBy === "person" ? chalk.cyan(" set by a person") : ""
      console.log(`  ${String(r.id).slice(0, 8)}  ${when}  ${phase}${who}  ${r.channel} ${r.chatId}${r.ownerAgent ? `  → ${r.ownerAgent}` : ""}`)
      if (r.why) console.log(chalk.dim(`            ${String(r.why).slice(0, 120)}`))
    }
  })

// Phase 3: which signal sources run on this node (#1892).
common(situationCmd
  .command("sources")
  .description("list the signal sources on this node (Focus, call and widget hold, calls, who left a group), which are not loaded and why")
  .option("--json", "print JSON"))
  .action(async (opts) => {
    const data = await call(opts, "GET", "/situations/sources")
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
    console.log(chalk.bold(`  Signal sources on this node (${data.platform})`))
    for (const s of data.loaded ?? []) {
      const answer = s.state !== undefined ? (s.state === "unknown" ? chalk.yellow("unknown") : "known") + chalk.dim(" (details only on that machine)")
        : s.value === undefined ? chalk.dim("reports when it happens")
        : s.value === "unknown" ? chalk.yellow(`unknown: ${s.reason}`) : `${String(s.value)} ${chalk.dim(`(${s.reason})`)}`
      console.log(`  ${chalk.green("●")} ${s.id.padEnd(17)} ${s.kind.padEnd(8)} ${answer}`)
    }
    for (const s of data.notLoaded ?? []) console.log(`  ${chalk.dim("○")} ${s.id.padEnd(17)} ${chalk.dim(`not loaded: ${s.reason}`)}`)
  })

const OVERRIDES: Array<[string, string, string]> = [
  ["end", "end a talk: further thanks and goodbyes in that chat are held", "ended"],
  ["not-this", "the talk is not ending: back to during, and thanks or goodbyes no longer end it", "kept open"],
  ["clear", "forget a chat's record: its next message starts a new one", "cleared"],
]
for (const [action, description, done] of OVERRIDES) {
  common(situationCmd
    .command(`${action} <id>`)
    .description(`${description} (id: from \`situation list\`, its first 8 characters are enough)`))
    .action(async (id: string, opts) => {
      await call(opts, "POST", "/situations/override", { id, action, by: "operator (CLI)" })
      console.log(chalk.green(`  Situation ${id} ${done}.`))
    })
}

// Phase 4: closing steps (#1892).
common(situationCmd
  .command("closing [id]")
  .description("give a talk closing steps: when it ends, one note at its home, each follow-up an open promise, one message to you (needs situations.closing.enabled)")
  .option("--purpose <text>", "what the talk is, e.g. \"the job interview with a candidate\"")
  .option("--home <link>", "where the note goes: a GitHub or GitLab issue, pull request or merge request link")
  .option("--agent <id>", "the agent that writes the note (default: the chat's agent)")
  .option("--agents <ids>", "other agents that may own a follow-up, comma-separated (default: none; the talk's agent keeps the rest)")
  .option("--message <text>", "a closing message to the other side; you are always asked before it is sent")
  .option("--channel <name>", "with --chat, for a talk that has no record yet: telegram, whatsapp, discord or slack")
  .option("--chat <id>", "the chat id as the channel names it (needed with --message on WhatsApp)")
  .option("--account <id>", "the channel account, when it has several")
  .option("--clear", "remove the closing steps"))
  .action(async (id: string | undefined, opts) => {
    if (!id && !(opts.channel && opts.chat)) {
      console.log(chalk.red("  Give a situation id (from `situation list`), or --channel and --chat."))
      process.exit(1)
    }
    const body: Record<string, unknown> = opts.clear ? { clear: true } : {
      purpose: opts.purpose, home: opts.home,
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.agents ? { agents: String(opts.agents) } : {}),
      ...(opts.message ? { message: opts.message } : {}),
    }
    if (id) body.id = id
    if (opts.channel) body.channel = opts.channel
    if (opts.chat) body.chatId = opts.chat
    if (opts.account) body.account = opts.account
    const data = await call(opts, "POST", "/situations/closing", body)
    const r = data.row
    if (opts.clear) { console.log(chalk.green(`  Closing steps removed from ${String(r?.id ?? id).slice(0, 8)}.`)); return }
    console.log(chalk.green(`  Closing steps set on ${String(r?.id ?? "").slice(0, 8)} (${r?.channel} ${r?.chatId}): note at ${r?.closing?.home}.`))
  })

common(situationCmd
  .command("release <id>")
  .description("re-deliver a dropped message to the agent, once, and reopen the talk"))
  .action(async (id: string, opts) => {
    const data = await call(opts, "POST", "/situations/release", { id: Number(id) })
    console.log(chalk.green(`  Released row #${data.id}: message ${data.messageId ?? "?"} goes to the agent again.`))
  })
