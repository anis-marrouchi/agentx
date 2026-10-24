// --- agentx onboard: the decisions, kept apart from the processes ---
//
// Which folder holds the team, which engine a no-questions install picks,
// when the wizard has written enough for the daemon to start, and what the
// closing lines say. All pure, so they are tested without spawning anything.

import { existsSync, readFileSync } from "fs"
import { delimiter, join, resolve } from "path"
import type { WizardPayload } from "@/daemon/setup-wizard"

/** Set on the dashboard child so the wizard knows onboard starts the daemon. */
export const ONBOARD_ENV = "AGENTX_ONBOARD"

/** Where the team lives. An explicit --dir wins; a folder that already holds
 *  agentx.json is an existing install, so it stays where it is; otherwise a
 *  fresh `agentx` folder in the home directory, so one command run from
 *  anywhere does not scatter files into whatever folder the terminal is in. */
export function resolveHomeDir(opts: { dir?: string; cwd: string; home: string }): { dir: string; reason: string } {
  if (opts.dir) return { dir: resolve(opts.cwd, opts.dir), reason: "from --dir" }
  if (existsSync(join(opts.cwd, "agentx.json"))) return { dir: opts.cwd, reason: "this folder already has agentx.json" }
  return { dir: join(opts.home, "agentx"), reason: "new install" }
}

export interface TeamState {
  /** agentx.json exists and parses. */
  configured: boolean
  agents: { id: string; name: string }[]
  /** host:port the daemon binds, from node.bind. */
  bind: string
  telegram: boolean
}

/** Read just enough of agentx.json to decide what to do next. The daemon
 *  does the full validation when it starts; a file it rejects shows up as a
 *  daemon that exits, with its log printed. */
export function readTeam(dir: string): TeamState {
  const empty: TeamState = { configured: false, agents: [], bind: "127.0.0.1:18800", telegram: false }
  const file = join(dir, "agentx.json")
  if (!existsSync(file)) return empty
  let cfg: any
  try { cfg = JSON.parse(readFileSync(file, "utf8")) } catch { return empty }
  const agents = Object.entries(cfg?.agents || {}).map(([id, a]: [string, any]) => ({ id, name: String(a?.name || id) }))
  return {
    configured: true,
    agents,
    bind: typeof cfg?.node?.bind === "string" && cfg.node.bind ? cfg.node.bind : empty.bind,
    telegram: Boolean(cfg?.channels?.telegram?.enabled),
  }
}

/** The loopback URL for a bind address: 0.0.0.0 answers on 127.0.0.1 too. */
export function loopbackUrl(bind: string): string {
  const [host, port] = splitBind(bind)
  const h = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  return `http://${h}:${port}`
}

export function bindPort(bind: string): number {
  return splitBind(bind)[1]
}

function splitBind(bind: string): [string, number] {
  const i = bind.lastIndexOf(":")
  if (i < 0) return [bind, 18800]
  const port = parseInt(bind.slice(i + 1), 10)
  return [bind.slice(0, i), Number.isFinite(port) ? port : 18800]
}

export type Engine = WizardPayload["agent"]["tier"]

/** The engine `--yes` picks without asking: a signed-in coding CLI on PATH
 *  first (no key to paste), then an Anthropic key in the environment. None
 *  of those means the wizard has to ask, so the answer is undefined. */
export function pickEngine(opts: { onPath: (bin: string) => boolean; env: NodeJS.ProcessEnv }): Engine | undefined {
  if (opts.onPath("claude")) return "claude-code"
  if (opts.onPath("codex")) return "codex-cli"
  if (opts.onPath("opencode")) return "opencode"
  if (opts.env.ANTHROPIC_API_KEY) return "sdk"
  return undefined
}

/** True when `bin` is an executable file in one of PATH's folders. */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PATH || "").split(delimiter).some((dir) => Boolean(dir) && existsSync(join(dir, bin)))
}

/** What `--yes` writes in place of the wizard form: the same payload the
 *  form would send, filled with defaults the person can change later. */
export function defaultPayload(nodeName: string, engine: Engine, env: NodeJS.ProcessEnv): WizardPayload {
  return {
    nodeName,
    agent: {
      id: "assistant",
      name: "Assistant",
      triggerWords: "@assistant, assistant",
      tier: engine,
    },
    ...(engine === "sdk" && env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
  }
}

/** The closing lines: what the person has now and where to find it. */
export function summaryLines(opts: {
  team: TeamState
  daemonUrl: string
  dashboardUrl: string
  dir: string
  cmd: string
  seconds: number
}): string[] {
  const first = opts.team.agents[0]
  const lines = [
    first
      ? `Your first agent, ${first.name} (@${first.id}), is answering at ${opts.daemonUrl}`
      : `Your daemon is answering at ${opts.daemonUrl}`,
  ]
  if (opts.team.agents.length > 1) lines.push(`It runs with ${opts.team.agents.length - 1} more agent${opts.team.agents.length > 2 ? "s" : ""}: ${opts.team.agents.slice(1).map((a) => "@" + a.id).join(", ")}`)
  lines.push(`Watch it work:   ${opts.dashboardUrl}/live`)
  lines.push(`Its requests:    ${opts.dashboardUrl}/approvals  (every task has one home, its request card)`)
  if (opts.team.telegram) lines.push("Telegram is on: message your bot to talk to it.")
  lines.push(`Your files:      ${opts.dir}`)
  lines.push(`Ready in ${opts.seconds}s. Next time, run \`${opts.cmd} onboard\` again from that folder, or \`${opts.cmd} daemon start --detach\` there.`)
  return lines
}
