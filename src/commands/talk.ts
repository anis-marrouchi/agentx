import { Command } from "commander"
import chalk from "chalk"
import { createInterface } from "readline"
import { loadDaemonConfig } from "@/daemon/config"
import { talkSpeaker } from "@/daemon/voice-talk-api"
import { Talk, type TalkEvent, type TalkSpeaker } from "@/voice/talk"
import { SpeechOut } from "@/voice/speaker"
import { createLineModel } from "@/voice/talk-model"

// `agentx talk a b "topic"`: two agents talk it through out loud on the
// daemon's host. Type a line to cut in (the door); "stop" ends the talk.
// --local runs the talk in this process instead of the daemon.

const base = () => (process.env.AGENTX_DAEMON_URL || "http://127.0.0.1:18800").replace(/\/+$/, "")

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (process.env.MESH_TOKEN) headers.Authorization = `Bearer ${process.env.MESH_TOKEN}`
  const res = await fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

function printEvent(e: TalkEvent): void {
  if (e.type === "line") console.log(`${chalk.bold(e.name)}: ${e.text}`)
  else if (e.type === "gap") console.log(chalk.dim(`  · ${e.ms} ms between speakers`))
  else if (e.type === "door") console.log(chalk.cyan(`  you: ${e.text}`))
  else if (e.type === "answered") console.log(chalk.dim(`  · answered ${e.ms} ms after you spoke`))
  else if (e.type === "hush") console.log(chalk.dim("  · hushed"))
  else if (e.type === "error") console.log(chalk.red(`  error: ${e.error}`))
  else if (e.type === "end") console.log(chalk.dim(`  · ended (${e.reason})`))
}

function gapSummary(gaps: number[]): string {
  if (!gaps.length) return "no hand-overs measured"
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return `gap between speakers: median ${median} ms, max ${sorted.at(-1)} ms over ${gaps.length} hand-overs`
}

async function runLocal(ids: string[], topic: string, opts: { context?: string; turns?: string; config?: string }) {
  const agents = loadDaemonConfig(opts.config).agents
  const missing = ids.filter((id) => !agents[id])
  if (missing.length) throw new Error(`Unknown agent: ${missing.join(", ")}`)
  const t0 = Date.now()
  const talk = new Talk({
    topic, context: opts.context, maxTurns: Number(opts.turns) || 10,
    speakers: ids.map((id) => talkSpeaker(id, agents, true)) as [TalkSpeaker, TalkSpeaker],
    speech: new SpeechOut(),
    model: (_s, system) => createLineModel({ system }),
  })
  talk.on(printEvent)
  talk.on((e) => { if (e.type === "line" && e.turn === 0) console.log(chalk.dim(`  · first line written ${Date.now() - t0} ms after start`)) })
  const rl = createInterface({ input: process.stdin })
  rl.on("line", (l) => { if (l.trim()) talk.door(l) })
  process.once("SIGINT", () => talk.stop("interrupted"))
  await talk.run()
  rl.close()
  console.log(chalk.dim(`  ${gapSummary(talk.gaps)}`))
}

async function runOnDaemon(ids: string[], topic: string, opts: { context?: string; turns?: string }) {
  const started = await call("POST", "/talk", { agents: ids, topic, context: opts.context, maxTurns: Number(opts.turns) || undefined })
  if (started.status >= 300) throw new Error(started.data.error || `HTTP ${started.status}`)
  const rl = createInterface({ input: process.stdin })
  rl.on("line", (l) => { if (l.trim()) void call("POST", "/talk/door", { text: l }) })
  process.once("SIGINT", () => void call("POST", "/talk/stop"))
  let shown = 0
  let gaps: number[] = []
  for (;;) {
    const { data } = await call("GET", "/talk")
    const lines: Array<{ name: string; text: string }> = data.transcript ?? []
    for (; shown < lines.length; shown++) console.log(`${chalk.bold(lines[shown].name)}: ${lines[shown].text}`)
    gaps = data.gaps ?? gaps
    if (!data.active) break
    await new Promise((r) => setTimeout(r, 400))
  }
  rl.close()
  console.log(chalk.dim(`  ${gapSummary(gaps)}`))
}

export const talk = new Command()
  .name("talk")
  .description("two agents talk a topic through out loud; type to cut in, \"stop\" to end")
  .argument("<agentA>")
  .argument("<agentB>")
  .argument("<topic...>")
  .option("--context <text>", "a few lines of context both agents should know")
  .option("--turns <n>", "most lines before they wrap up (default 10)")
  .option("--local", "run the talk in this process instead of the daemon")
  .option("-c, --config <path>", "agentx.json for --local (default: the usual lookup)")
  .action(async (a: string, b: string, topicWords: string[], opts) => {
    const topic = topicWords.join(" ")
    try {
      await (opts.local ? runLocal : runOnDaemon)([a, b], topic, opts)
      process.exit(0)
    } catch (e: any) {
      console.error(chalk.red(`  ${e?.message ?? e}`))
      process.exit(1)
    }
  })

export const narrate = new Command()
  .name("narrate")
  .description("switch spoken task narration on or off for an agent or one task")
  .argument("<target>", "agent id, or task id with --task")
  .argument("<state>", "on | off | default")
  .option("--task", "the target is a task id")
  .action(async (target: string, state: string, opts) => {
    const on = state === "on" ? true : state === "off" ? false : state === "default" ? null : undefined
    if (on === undefined) { console.error(chalk.red("  state must be on, off or default")); process.exit(1) }
    const { status, data } = await call("POST", "/narration", { [opts.task ? "taskId" : "agentId"]: target, on })
    if (status >= 300) { console.error(chalk.red(`  ${data.error || `HTTP ${status}`}`)); process.exit(1) }
    console.log(JSON.stringify(data))
  })
