import { mkdirSync, openSync } from "fs"
import { resolve } from "path"
import { spawn } from "child_process"
import { existingConfigPath, pickAgent } from "@/commands/start-plan"
import { findBinary } from "@/voice/transcribe"
import { cliLoggedIn } from "@/utils/cli-login"
import { readRawConfig } from "./setup-flow"
import type { DaemonState, SetupApiDeps } from "./setup-flow-api"

// --- The guided first run's production wiring (#2143) ---
//
// This folder, the daemon it talks to and the real CLIs, for
// setup-flow-api.ts. Starting and restarting go through the same `agentx
// daemon start|restart` commands a person would type, detached, with the
// log in .agentx/daemon.log, so the wizard never runs a daemon of its own.

const WAIT_MS = 45_000

async function health(base: string): Promise<{ ok: boolean; body: any } | null> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
    return { ok: r.ok, body: await r.json().catch(() => null) }
  } catch { return null }
}

async function until(check: () => Promise<boolean>): Promise<boolean> {
  const end = Date.now() + WAIT_MS
  while (Date.now() < end) {
    await new Promise((ok) => setTimeout(ok, 500))
    if (await check()) return true
  }
  return false
}

/** Run `agentx daemon <args> -c <config>` in the background; false when
 *  there is no CLI entry or config to run it with. */
function runCli(dir: string, args: string[]): boolean {
  const cli = process.argv[1]
  const configPath = existingConfigPath(dir)
  if (!cli || !configPath) return false
  mkdirSync(resolve(dir, ".agentx"), { recursive: true })
  const fd = openSync(resolve(dir, ".agentx", "daemon.log"), "a")
  spawn(process.execPath, [cli, "daemon", ...args, "-c", configPath], { cwd: dir, detached: true, stdio: ["ignore", fd, fd] }).unref()
  return true
}

/** Whether the daemon that answered is this folder's, strictly: both name
 *  the same node id. Stricter than start's isSameInstall on purpose, as the
 *  wizard reloads and restarts it: a folder with no config yet, or another
 *  AgentX already running on the port, must never be taken for ours. */
export function sameNode(health: any, cfg: any): boolean {
  const theirs = health?.node?.id
  return Boolean(theirs) && theirs === cfg?.node?.id
}

/** Only a daemon on this machine is started or restarted from here: one
 *  in another container or on another host (Docker's http://daemon:18800)
 *  is said as such by the caller instead of getting a second daemon here. */
export function isLocalDaemon(url: string): boolean {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) } catch { return false }
}

export function setupFlowDeps(dir: string, node: { url: string; token?: string }, readBody: SetupApiDeps["readBody"]): SetupApiDeps {
  const base = node.url.replace(/\/+$/, "")
  const auth: Record<string, string> = node.token ? { Authorization: `Bearer ${node.token}` } : {}
  const probe = async (): Promise<DaemonState> => {
    const h = await health(base)
    if (!h) return "down"
    if (!h.ok || !h.body || typeof h.body !== "object" || !("node" in h.body)) return "other"
    return sameNode(h.body, readRawConfig(dir)) ? "ours" : "other-agentx"
  }
  const hasAgent = async (id: string): Promise<boolean> => {
    const agents = (await health(base))?.body?.agents
    return Array.isArray(agents) && agents.some((a: any) => a?.id === id)
  }
  return {
    dir, env: process.env, readBody,
    hasBinary: (bin) => Boolean(findBinary(bin)),
    cliLoggedIn,
    daemon: {
      url: base,
      probe,
      hasAgent,
      reload: async () => {
        const r = await fetch(`${base}/reload`, { method: "POST", headers: auth, signal: AbortSignal.timeout(10_000) })
        const body: any = await r.json().catch(() => ({}))
        if (!r.ok || body.ok === false) throw new Error(body.error || `HTTP ${r.status}`)
        return { restartRequired: Array.isArray(body.restartRequired) ? body.restartRequired : [] }
      },
      start: async () => isLocalDaemon(base) && runCli(dir, ["start"]) && until(async () => (await probe()) === "ours"),
      restart: async () => {
        const id = pickAgent(readRawConfig(dir))
        return isLocalDaemon(base) && runCli(dir, ["restart"]) && until(async () => (await probe()) === "ours" && (!id || await hasAgent(id)))
      },
    },
    assistant: async (method, path, body) => {
      const r = await fetch(base + path, {
        method, headers: { "Content-Type": "application/json", ...auth },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(15_000),
      })
      return { status: r.status, body: await r.json().catch(() => ({})) }
    },
  }
}
