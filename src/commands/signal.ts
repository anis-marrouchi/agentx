import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx signal — stop a running task with a resume plan, resume it (#857) ---
//
//   agentx signal stop <taskId> [--reason …]            stop one running task
//   agentx signal stop --agent a --channel c --chat x   …or the agent's only task on a chat
//   agentx signal stop --all [--mesh] [--no-wait]     stop every task, before a restart (#1271)
//   agentx signal list [--all]                          stopped tasks and their plans
//   agentx signal show <id>                             one stopped task, whole plan
//   agentx signal resume <id> [--reason …]              run it again from its plan
//   agentx signal drop <id>                             forget a stopped task and its plan
//
// `--peer <name>` sends the signal to a mesh node, which accepts it only
// when its signals.allowPeers names this node. Settings: `agentx config
// set signals.<key> <value>` (windDownSeconds, allowAgents, allowPeers,
// maxPerRoot, enabled).

export const signalCmd = new Command()
  .name("signal")
  .description("stop a running agent task with a resume plan, and resume it later")

interface Opts { node?: string; token?: string; config?: string; peer?: string }

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
  .option("--peer <name>", "send to this mesh node instead")

common(signalCmd
  .command("stop [taskId]")
  .description("stop a running task; the agent writes a resume plan")
  .option("--agent <id>", "with --channel and --chat: the agent's only task on that chat")
  .option("--channel <channel>", "the task's channel")
  .option("--chat <chatId>", "the task's chat id")
  .option("--all", "stop every running task on this node; each resumes from its plan after the next restart")
  .option("--mesh", "with --all: on every healthy mesh node too")
  .option("--no-wait", "with --all: answer at once, without waiting for the plans")
  .option("-r, --reason <reason>", "why: shown to the agent and on the live page"))
  .action(async (taskId: string | undefined, opts) => {
    if (opts.all) {
      if (taskId || opts.agent) {
        console.log(chalk.red("  --all stops every task: give no task id or --agent"))
        process.exit(1)
      }
      await stopAll(opts)
      return
    }
    if (!taskId && !(opts.agent && opts.channel && opts.chat)) {
      console.log(chalk.red("  give a task id, or --agent, --channel and --chat"))
      process.exit(1)
    }
    const data = await call(opts, "POST", "/api/signals/stop", {
      taskId, agentId: opts.agent, channel: opts.channel, chatId: opts.chat, reason: opts.reason, node: opts.peer,
    })
    console.log(chalk.green(`  stopped ${data.agentId} task ${data.id}`) + chalk.dim(" — writing its resume plan"))
    console.log(chalk.dim(`  see it: agentx signal show ${data.id}${opts.peer ? ` --peer ${opts.peer}` : ""}`))
  })

function printStopAllTasks(tasks: any[], indent: string): void {
  if (!tasks.length) { console.log(chalk.dim(`${indent}no running tasks`)); return }
  for (const t of tasks) {
    const plan = t.plan === "agent" ? chalk.green("plan by the agent") : t.plan === "machine" ? chalk.yellow("plan by AgentX") : ""
    const state = t.state === "refused" ? chalk.red(`not stopped: ${t.error}`) : t.state === "winding-down" ? chalk.cyan("writing its plan") : plan || t.state
    const b = t.builders
    const builders = b
      ? chalk.dim(` · ${b.count} builder(s) stopped${b.saved ? `, ${b.saved} folder(s) saved on a WIP branch` : ""}`) + (b.notSaved ? chalk.red(`, ${b.notSaved} folder(s) not saved`) : "")
      : ""
    console.log(`${indent}${chalk.bold(t.agentId)} ${chalk.dim(t.id)} ${state}${builders}`)
  }
}

async function stopAll(opts: any): Promise<void> {
  const wait = opts.wait !== false
  if (wait) console.log(chalk.dim("  stopping every task and waiting for the resume plans…"))
  const body: Record<string, unknown> = { reason: opts.reason, mesh: Boolean(opts.mesh), wait }
  // --peer: the order is given to that node, as its own owner would.
  const data = opts.peer
    ? await call(opts, "POST", "/api/signals/stop-all", { ...body, mesh: false, node: opts.peer })
    : await call(opts, "POST", "/api/signals/stop-all", body)
  console.log(`  ${chalk.bold(data.node)} ${chalk.dim(data.orderId)}`)
  printStopAllTasks(data.tasks || [], "    ")
  for (const p of data.peers || []) {
    console.log(`  ${chalk.bold(p.node)}${p.ok ? "" : ` ${chalk.red(p.error)}`}`)
    if (p.ok) printStopAllTasks(p.tasks || [], "    ")
  }
  if (!wait) {
    console.log(chalk.dim("  see the plans: agentx signal list"))
  } else if (data.safeToRestart) {
    console.log(chalk.green("  safe to restart: every task resumes from its plan when AgentX starts again"))
  } else if ([data, ...(data.peers || [])].some((n: any) => (n.tasks || []).some((t: any) => t.state === "refused"))) {
    console.log(chalk.yellow("  not safe to restart: a task marked \"not stopped\" is still running, and a restart would cut it off"))
  } else {
    console.log(chalk.yellow("  not every plan is confirmed saved; check the lines above before you restart"))
  }
}

common(signalCmd
  .command("list")
  .description("stopped tasks and their resume plans")
  .option("--all", "include tasks already resumed")
  .option("--agent <id>", "only this agent's"))
  .action(async (opts) => {
    const qs = new URLSearchParams({ limit: "50" })
    if (opts.agent) qs.set("agent", opts.agent)
    if (opts.peer) qs.set("node", opts.peer)
    const data = await call(opts, "GET", `/api/signals/stopped?${qs}`)
    const tasks: any[] = (data.tasks || []).filter((t: any) => opts.all || t.state !== "resumed")
    if (!tasks.length) { console.log(chalk.dim("  no stopped tasks")); return }
    for (const t of tasks) {
      const state = t.state === "stopped" ? chalk.yellow(t.state) : t.state === "resumed" ? chalk.green(t.state) : chalk.cyan(t.state)
      console.log(`  ${state} ${chalk.bold(t.id)} ${t.agentId}${chalk.dim(`:${t.channel}:${t.chatId}`)} ${chalk.dim(`by ${t.stoppedBy} ${t.stoppedAt}`)}`)
      if (t.workflow) console.log(`    ${chalk.dim("workflow run:")} ${t.workflow.runId} (${t.workflow.workflowId}) paused at step ${t.workflow.nodeId}`)
      console.log(`    ${chalk.dim("asked:")} ${t.request}`)
      if (t.plan) console.log(`    ${chalk.dim(`plan (${t.plan.author}):`)} ${String(t.plan.text).split("\n")[0]}`)
      if (t.builders) console.log(`    ${chalk.dim("builders:")} ${t.builders.helpers} stopped${t.builders.folders.length ? `; ${t.builders.folders.map((f: any) => f.wipBranch ? `${f.path} → ${f.wipBranch}` : f.error ? `${f.path} not saved` : f.path).join(", ")}` : ""}`)
    }
  })

common(signalCmd
  .command("show <id>")
  .description("one stopped task with its whole resume plan"))
  .action(async (id: string, opts) => {
    const qs = opts.peer ? `?node=${encodeURIComponent(opts.peer)}` : ""
    const { task: t } = await call(opts, "GET", `/api/signals/stopped/${encodeURIComponent(id)}${qs}`)
    console.log(`  ${chalk.bold(t.id)} ${t.agentId}${chalk.dim(`:${t.channel}:${t.chatId}`)} — ${t.state}`)
    console.log(`  stopped by ${t.stoppedBy} at ${t.stoppedAt}${t.reason ? ` (${t.reason})` : ""}`)
    if (t.workflow) console.log(`  step ${t.workflow.nodeId} of workflow run ${t.workflow.runId} (${t.workflow.workflowId})`)
    if (t.resumedAt) console.log(`  resumed by ${t.resumedBy} at ${t.resumedAt}`)
    console.log(chalk.dim("\n  Request:"))
    console.log(`  ${t.originalMessage}`)
    console.log(chalk.dim(`\n  Resume plan${t.plan ? ` (${t.plan.author === "agent" ? "written by the agent" : `written by AgentX: ${t.plan.note}`})` : ""}:`))
    console.log(t.plan ? t.plan.text.split("\n").map((l: string) => `  ${l}`).join("\n") : "  not written yet")
    if (t.builders) {
      console.log(chalk.dim(`\n  Background builders it had started (${t.builders.helpers.length}), stopped with it:`))
      t.builders.helpers.forEach((h: string, i: number) => console.log(`  ${i + 1}. ${h}`))
      for (const f of t.builders.folders) {
        const where = f.wipBranch ? chalk.green(`saved on ${f.wipBranch} (${String(f.wipCommit).slice(0, 12)})`) : f.error ? chalk.red(`not saved: ${f.error}`) : chalk.dim("nothing to save: its commits are in the clone")
        console.log(`  - ${f.path} (${f.branch ?? "no branch"}): ${where}`)
      }
    }
  })

common(signalCmd
  .command("resume <id>")
  .description("resume a stopped task from its plan, in the same chat")
  .option("-r, --reason <reason>", "why: recorded on the resume event"))
  .action(async (id: string, opts) => {
    const data = await call(opts, "POST", "/api/signals/resume", { id, reason: opts.reason, node: opts.peer })
    console.log(chalk.green(`  resumed ${data.agentId} task ${data.id}`))
    if (data.delivery) console.log(chalk.dim(`  its answer goes to ${data.delivery}`))
  })

common(signalCmd
  .command("drop <id>")
  .description("forget a stopped task and its resume plan, when it won't be resumed"))
  .action(async (id: string, opts) => {
    const data = await call(opts, "POST", "/api/signals/drop", { id, node: opts.peer })
    console.log(chalk.green(`  dropped ${data.agentId} task ${data.id}`))
  })
