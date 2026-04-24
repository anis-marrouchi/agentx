import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx watch — one live operator console for the daemon ---
//
// Opens an SSE connection to the daemon's /events endpoint with optional
// filters and prints one-line formatted entries. Meant for
//     agentx watch                 # everything
//     agentx watch --type run,task # just workflow runs + user tasks
//     agentx watch --workflow X    # runs of a specific workflow
//     agentx watch --actor actor:alice
//
// Multi-daemon: pass --node <url> to point at a peer; otherwise uses the
// local daemon URL from dashboard.daemonUrl or -c config.

export const watch = new Command()
  .name("watch")
  .description("stream live daemon events — workflow runs, user tasks, signals, mesh health")
  .option("-c, --config <path>", "daemon config file")
  .option("-t, --type <kinds>", "comma-separated event kinds (run,task,signal,mesh,channel,status)")
  .option("-w, --workflow <id>", "only events for this workflow id")
  .option("-a, --actor <id>", "only task events involving this actor id")
  .option("-r, --run <id>", "only events for this run id")
  .option("--channel <name>", "only channel events on this channel (telegram/whatsapp/…)")
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

    const qs: string[] = []
    if (typeof opts.type === "string") qs.push(`type=${encodeURIComponent(opts.type)}`)
    if (typeof opts.workflow === "string") qs.push(`workflow=${encodeURIComponent(opts.workflow)}`)
    if (typeof opts.actor === "string") qs.push(`actor=${encodeURIComponent(opts.actor)}`)
    if (typeof opts.run === "string") qs.push(`run=${encodeURIComponent(opts.run)}`)
    if (typeof opts.channel === "string") qs.push(`channel=${encodeURIComponent(opts.channel)}`)
    const url = `${baseUrl.replace(/\/+$/, "")}/events${qs.length ? `?${qs.join("&")}` : ""}`

    console.log(chalk.dim(`  connecting to ${url}`))

    const headers: Record<string, string> = { Accept: "text/event-stream" }
    if (token) headers["Authorization"] = `Bearer ${token}`

    try {
      const res = await fetch(url, { headers })
      if (!res.ok || !res.body) {
        console.error(chalk.red(`  connect failed: HTTP ${res.status}`))
        process.exit(1)
      }
      console.log(chalk.green(`  connected — Ctrl-C to stop`))
      console.log("")

      // Parse SSE frames: `event: <kind>\ndata: <payload>\n\n`.
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          printFrame(frame)
        }
      }
    } catch (e: any) {
      console.error(chalk.red(`  disconnected: ${e.message || e}`))
      process.exit(1)
    }
  })

function printFrame(frame: string): void {
  let event = "message"
  let data = ""
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7)
    else if (line.startsWith("data: ")) data = line.slice(6)
  }
  if (!data) return
  let payload: any = {}
  try { payload = JSON.parse(data) } catch { /* print raw */ console.log(`${event}: ${data}`); return }

  const ts = payload.at ? chalk.dim(new Date(payload.at).toLocaleTimeString()) : ""
  switch (event) {
    case "run": {
      const tag = chalk.cyan(payload.phase?.padEnd(9) ?? "run")
      const wf = chalk.bold(payload.workflowId ?? "")
      const runShort = chalk.dim((payload.runId ?? "").slice(0, 8))
      const node = payload.nodeId ? chalk.yellow(payload.nodeId) : ""
      const note = payload.note ? chalk.dim(`— ${payload.note}`) : ""
      console.log(`${ts}  ${tag}  ${wf}  ${runShort}  ${node}  ${note}`)
      break
    }
    case "task": {
      const tag = chalk.magenta(`task.${payload.phase}`.padEnd(14))
      const wf = chalk.bold(payload.workflowId ?? "")
      const actors = Array.isArray(payload.assignedTo) ? payload.assignedTo.join(",") : ""
      const title = payload.title ? chalk.dim(`"${payload.title}"`) : ""
      console.log(`${ts}  ${tag}  ${wf}  ${chalk.cyan(actors)}  ${title}`)
      break
    }
    case "signal": {
      const tag = chalk.green("signal".padEnd(9))
      const name = chalk.bold(payload.name)
      const scope = chalk.dim(`(${payload.scope})`)
      const wf = payload.workflowId ? chalk.dim(payload.workflowId) : ""
      console.log(`${ts}  ${tag}  ${name} ${scope}  ${wf}`)
      break
    }
    case "mesh": {
      const tag = chalk.blue("mesh".padEnd(9))
      const peer = chalk.bold(payload.peer)
      const health = payload.healthy ? chalk.green("✓ healthy") : chalk.red("✗ lost")
      console.log(`${ts}  ${tag}  ${peer}  ${health}  ${chalk.dim(payload.delta ?? "")}`)
      break
    }
    case "channel": {
      const tag = chalk.yellow("channel".padEnd(9))
      const dir = payload.direction === "in" ? chalk.cyan("←") : chalk.magenta("→")
      const label = chalk.bold(`${payload.channel}:${payload.chatId ?? ""}`)
      const preview = payload.textPreview ? chalk.dim(payload.textPreview) : ""
      console.log(`${ts}  ${tag}  ${dir} ${label}  ${preview}`)
      break
    }
    case "status": {
      console.log(chalk.dim(`${ts}  status    ${payload.node ?? ""}  agents=${payload.agents ?? 0}  active=${(payload.active ?? []).length}  peers=${(payload.mesh ?? []).length}`))
      break
    }
    default:
      console.log(`${ts}  ${event}  ${JSON.stringify(payload)}`)
  }
}
