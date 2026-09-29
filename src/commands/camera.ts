import { Command } from "commander"
import chalk from "chalk"
import type { Call } from "@/calls/store"
import { callerHeaders } from "@/calls/service"
import { daemon } from "./call"

// --- `agentx camera` — an agent asks to see through the phone camera (#325) ---
//
//   agentx camera ask --reason "…" [--urgent]   (inside an agent's run)
//   agentx camera look [--json]                 (inside an agent's run, while the owner shares)
//   agentx camera list [--status ringing]
//   agentx camera watching
//   agentx camera decline <id>, agentx camera stop <id>
//
// An ask is a call of kind "camera" (src/calls): the same allowlist as
// `agentx call allow`, the same hourly limit. The owner accepts on the phone.

/** One line per ask, for `list`. */
function line(c: Call): string {
  const when = new Date(c.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  const mark = c.status === "missed" ? chalk.yellow("missed") : c.status === "ringing" ? chalk.green("asking") : c.status === "answered" ? chalk.green("showing") : chalk.dim(c.status)
  const note = c.note ? chalk.dim(` (${c.note})`) : ""
  return `  ${chalk.dim(c.id)}  ${when}  ${c.agentId}  ${mark}${note}\n      ${c.reason}`
}

async function run(fn: () => Promise<void> | void): Promise<void> {
  try { await fn() } catch (e: any) {
    console.log(chalk.red(`  ${e?.message ?? e}`))
    process.exit(1)
  }
}

function agentOrThrow(what: string): string {
  const agentId = process.env.AGENTX_AGENT_ID
  if (!agentId) throw new Error(`no agent: ${what} happens from inside an agent's run, which sets AGENTX_AGENT_ID`)
  return agentId
}

const ask = new Command("ask")
  .description("ask the owner to show you their phone camera; runs inside an agent's turn")
  .requiredOption("--reason <text>", "what you want to see, in one line: shown on the phone")
  .option("--urgent", "ask even during Focus")
  .option("--json", "print the ask as JSON")
  .action((opts) => run(async () => {
    const agentId = agentOrThrow("a camera ask")
    const r = await daemon("POST", "/calls", { agentId, reason: opts.reason, urgency: opts.urgent ? "urgent" : "normal", kind: "camera" }, callerHeaders())
    if (opts.json) { console.log(JSON.stringify(r, null, 2)); return }
    const how = r.rang ? "the owner's phone was told; when they tap Show, use `agentx camera look` for the newest picture"
      : `not asked now: ${r.call.note ?? "held"} — it is listed as missed`
    console.log(`  ${r.rang ? chalk.green("📷") : chalk.yellow("⏸")} ${r.call.id} ${how}`)
  }))

const look = new Command("look")
  .description("the newest picture from the owner's camera, as a PNG path to open; runs inside an agent's turn")
  .option("--json", "print the frame as JSON")
  .action((opts) => run(async () => {
    const agentId = agentOrThrow("a look")
    const r = await daemon("POST", "/webrtc/camera/look", { agentId }, callerHeaders())
    if (opts.json) { console.log(JSON.stringify(r, null, 2)); return }
    console.log(`  ${r.frame.path}`)
    console.log(chalk.dim(`  ${r.frame.width}x${r.frame.height}, taken ${new Date(r.frame.takenAt).toLocaleTimeString()} (share ${r.callId})`))
  }))

const list = new Command("list")
  .description("recent camera asks, newest first")
  .option("--status <list>", "only these: ringing, answered, ended, declined, missed (comma-separated)")
  .option("--limit <n>", "how many", "20")
  .option("--json", "print as JSON")
  .action((opts) => run(async () => {
    const q = new URLSearchParams({ limit: String(opts.limit), kind: "camera" })
    if (opts.status) q.set("status", opts.status)
    const { calls } = await daemon("GET", `/calls?${q}`)
    if (opts.json) { console.log(JSON.stringify(calls, null, 2)); return }
    if (!calls.length) { console.log(chalk.dim("  no camera asks")); return }
    for (const c of calls) console.log(line(c))
  }))

const watching = new Command("watching")
  .description("agents watching a phone camera right now")
  .option("--json", "print as JSON")
  .action((opts) => run(async () => {
    const { active } = await daemon("GET", "/webrtc/camera/watch")
    if (opts.json) { console.log(JSON.stringify(active, null, 2)); return }
    if (!active.length) { console.log(chalk.dim("  no agent is watching a camera")); return }
    for (const w of active) {
      const left = Math.max(0, Math.round((w.until - Date.now()) / 60_000))
      console.log(`  ${chalk.dim(w.callId)}  ${w.agentId}  ${w.frames} frames, ${w.looks} looks, ${left} min left`)
    }
  }))

const decline = new Command("decline")
  .description("turn down a camera ask")
  .argument("<id>", "ask id, from `agentx camera list`")
  .action((id: string) => run(async () => {
    const { call } = await daemon("POST", `/calls/${encodeURIComponent(id)}/decline`, {})
    console.log(line(call))
  }))

const stop = new Command("stop")
  .description("end a live watch (the share id from `agentx camera watching`)")
  .argument("<id>", "share id")
  .action((id: string) => run(async () => {
    await daemon("POST", `/webrtc/camera/watch/${encodeURIComponent(id)}/stop`, {})
    console.log(chalk.green(`  ${id} stopped`))
  }))

export const camera = new Command("camera")
  .description("agents ask to see through your phone camera")
  .addCommand(ask)
  .addCommand(look)
  .addCommand(list)
  .addCommand(watching)
  .addCommand(decline)
  .addCommand(stop)
