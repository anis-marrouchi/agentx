// The daemon behind the Hub: is it running, and Start / Stop / Restart from
// the tray. Kept free of Electron so it can be tested with plain Node
// (test/daemon.test.mjs).
//
// Which daemon:
//   AGENTX_DAEMON_URL  its address (default: node.bind of AGENTX_CONFIG, else 127.0.0.1:18800)
//   AGENTX_CONFIG      its agentx.json; the CLI runs with -c and in that folder
//   AGENTX_CLI         the agentx command (default "agentx", found through the login shell)
//
// Stop only ever signals the one process this daemon reports for itself
// (GET /daemon/restart). A daemon kept running by launchd or systemd would
// be started again at once, so Stop is offered only for a daemon started
// from a shell; Restart works for both. The pid is only meaningful on this
// machine, so Stop is off when the daemon's URL is not loopback.

import { execFile } from "child_process"
import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { dirname } from "path"

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:18800"

export type ServiceKind = "launchd" | "systemd" | "none"

export interface DaemonStatus {
  running: boolean
  /** The process id the daemon reports, when it answers. */
  pid?: number
  /** What keeps it running; "none" = started from a shell. */
  service?: ServiceKind
  /** Set when the daemon's URL is not on this machine: its pid is not ours to signal. */
  remote?: true
}

export interface DaemonTarget {
  url: string
  config?: string
  cli: string
  cwd: string
}

function bindToUrl(bind: unknown): string | null {
  if (typeof bind !== "string" || !bind.includes(":")) return null
  const [host, port] = bind.split(":")
  if (!/^\d+$/.test(port)) return null
  return `http://${!host || host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`
}

/** Which daemon the tray controls, from the environment. */
export function daemonTarget(env: Record<string, string | undefined> = process.env): DaemonTarget {
  const config = (env.AGENTX_CONFIG || "").trim() || undefined
  let url = (env.AGENTX_DAEMON_URL || "").trim().replace(/\/+$/, "")
  if (!url && config) {
    try {
      if (existsSync(config)) url = bindToUrl(JSON.parse(readFileSync(config, "utf8"))?.node?.bind) || ""
    } catch {
      url = ""
    }
  }
  return {
    url: url || DEFAULT_DAEMON_URL,
    config,
    cli: (env.AGENTX_CLI || "").trim() || "agentx",
    cwd: config ? dirname(config) : homedir(),
  }
}

/** CLI arguments for an action; -c pins it to this daemon's config. */
export function cliArgs(action: "start" | "restart", config?: string): string[] {
  const args = action === "start" ? ["daemon", "start", "--detach"] : ["daemon", "restart"]
  return config ? [...args, "-c", config] : args
}

/** Single-quote for a POSIX shell. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** True when the URL's host is this machine (127.0.0.1, ::1 or localhost). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "localhost"
  } catch {
    return false
  }
}

type Fetch = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

/** Running when /health answers; pid and service from /daemon/restart (best effort). */
export async function readStatus(target: DaemonTarget, fetchFn: Fetch = fetch as unknown as Fetch): Promise<DaemonStatus> {
  const s = await probe(target, fetchFn)
  return s.running && !isLoopbackUrl(target.url) ? { ...s, remote: true } : s
}

async function probe(target: DaemonTarget, fetchFn: Fetch): Promise<DaemonStatus> {
  try {
    const h = await fetchFn(`${target.url}/health`, { signal: AbortSignal.timeout(2000) })
    if (!h.ok) return { running: false }
  } catch {
    return { running: false }
  }
  try {
    const r = await fetchFn(`${target.url}/daemon/restart`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return { running: true }
    const d = (await r.json()) as { pid?: unknown; service?: { kind?: unknown } }
    const kind = d?.service?.kind
    return {
      running: true,
      pid: typeof d?.pid === "number" ? d.pid : undefined,
      service: kind === "launchd" || kind === "systemd" || kind === "none" ? kind : undefined,
    }
  } catch {
    return { running: true }
  }
}

/** Stop is safe only for a shell-started daemon on this machine whose own pid we know. */
export function canStop(s: DaemonStatus): boolean {
  return s.running && !s.remote && s.service === "none" && typeof s.pid === "number"
}

/** Why Stop is off, for the error dialog; null when Stop is allowed. */
export function stopRefusal(s: DaemonStatus): string | null {
  if (canStop(s)) return null
  if (!s.running) return "the daemon is not running"
  if (s.remote) return "the daemon is on another machine; stop it there"
  if (s.service && s.service !== "none") return `the daemon is kept running by ${s.service}; use Restart`
  return "the daemon's process is not known"
}

/** SIGTERM: the daemon finishes its running tasks, then exits. */
export function stopDaemon(s: DaemonStatus, kill: (pid: number, sig: string) => void = (pid, sig) => process.kill(pid, sig)): void {
  const refusal = stopRefusal(s)
  if (refusal) throw new Error(refusal)
  kill(s.pid as number, "SIGTERM")
}

/** Runs the agentx CLI. macOS and Linux go through the login shell, since an app opened from the Dock has a bare PATH. */
export function runCli(target: DaemonTarget, args: string[], platform: NodeJS.Platform = process.platform): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, stdout: string, stderr: string) =>
      err ? reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-3).join("\n"))) : resolve(stdout)
    const opts = { cwd: target.cwd, timeout: 10 * 60_000, windowsHide: true }
    if (platform === "win32") {
      // cmd.exe splits on spaces: quote paths such as C:\Users\Jane Doe\agentx.json.
      const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s)
      execFile(q(target.cli), args.map(q), { ...opts, shell: true }, done)
    } else {
      const shell = process.env.SHELL || "/bin/sh"
      execFile(shell, ["-lc", [target.cli, ...args].map(shellQuote).join(" ")], opts, done)
    }
  })
}
