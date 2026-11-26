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
// (GET /daemon/restart), and only after checking that this pid is an agentx
// process here. A daemon kept running by launchd or systemd would be started
// again at once, so Stop is offered only for a daemon started from a shell.
// The pid is only meaningful on this machine, so Stop is off when the
// daemon's URL is not loopback.
//
// Restart always runs `agentx daemon restart --when-idle --abort-on-timeout`:
// it waits for running tasks and never cuts them off (main.ts asks first).
// Start is off while a launchd job or systemd unit for the daemon is loaded
// (the service starts it; a second one would run next to it), and when
// AGENTX_CONFIG is not set (there is no folder to start it in).

import { execFile, execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { dirname, isAbsolute, resolve } from "path"

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
  /** The daemon's own folder and agentx.json, as it reports them. */
  cwd?: string
  configPath?: string
}

export interface DaemonTarget {
  url: string
  config?: string
  cli: string
  /** The config's folder; unset without AGENTX_CONFIG (Start is then off). */
  cwd?: string
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
    cwd: config ? dirname(config) : undefined,
  }
}

/** CLI arguments for an action; -c pins it to this daemon's config.
 *  Restart waits until no task runs, and gives up rather than cut tasks off. */
export function cliArgs(action: "start" | "restart", config?: string): string[] {
  const args = action === "start" ? ["daemon", "start", "--detach"] : ["daemon", "restart", "--when-idle", "--abort-on-timeout"]
  return config ? [...args, "-c", config] : args
}

/** Runs a command and returns its stdout, or null when it fails. */
export type RunSync = (cmd: string, args: string[]) => string | null

const runSync: RunSync = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
  } catch {
    return null
  }
}

/** A launchd label or systemd unit is the daemon's when its last part is "agentx"
 *  (tn.noqta.agentx, agentx.service), or it is AGENTX_SERVICE. */
function isDaemonService(name: string, env: Record<string, string | undefined>): boolean {
  const own = (env.AGENTX_SERVICE || "").trim()
  return (!!own && (name === own || name === `${own}.service`)) || /(^|\.)agentx$/.test(name) || name === "agentx.service"
}

/** The launchd job or systemd unit that runs the daemon, when one is loaded
 *  (even while the daemon is down: launchd may be about to start it again).
 *  E.g. "launchd tn.noqta.agentx"; null when none is loaded. */
export function managedService(platform: NodeJS.Platform = process.platform, run: RunSync = runSync, env: Record<string, string | undefined> = process.env): string | null {
  if (platform === "darwin") {
    // `launchctl list`: PID, last exit status, label; one job per line.
    for (const line of (run("launchctl", ["list"]) || "").split("\n")) {
      const label = line.trim().split(/\s+/)[2]
      if (label && isDaemonService(label, env)) return `launchd ${label}`
    }
    return null
  }
  if (platform === "linux") {
    const own = (env.AGENTX_SERVICE || "").trim()
    const units = [...new Set([own && (own.endsWith(".service") ? own : `${own}.service`), "agentx.service"].filter(Boolean))]
    for (const scope of [["--user"], []]) {
      for (const unit of units) {
        const state = run("systemctl", [...scope, "show", "-p", "LoadState", "--value", unit])
        if (state?.trim() === "loaded") return `systemd ${scope.length ? "user " : ""}${unit}`
      }
    }
  }
  return null
}

/** Why Start is off, as a short reason for the menu; null when Start is allowed.
 *  `managed` is managedService()'s answer. */
export function startRefusal(s: DaemonStatus | null, target: DaemonTarget, managed: string | null): string | null {
  if (!s) return "checking"
  if (s.running) return "already running"
  if (managed) return `kept by ${managed}`
  if (!target.config) return "set AGENTX_CONFIG"
  return null
}

/** The target Restart runs in: AGENTX_CONFIG's folder, else the folder and config the
 *  running daemon reports. The daemon's own folder (s.cwd) wins over its config's
 *  folder, and a relative config (`daemon start -c agentx.json`) is read from that
 *  folder, never from the app's own. Null when neither is known: never a guessed
 *  folder such as $HOME. */
export function restartTarget(target: DaemonTarget, s: DaemonStatus): DaemonTarget | null {
  if (target.cwd) return target
  const config = !s.configPath ? undefined
    : isAbsolute(s.configPath) ? s.configPath
    : s.cwd ? resolve(s.cwd, s.configPath) : undefined
  const cwd = s.cwd || (config ? dirname(config) : undefined)
  if (!cwd) return null
  return config ? { ...target, config, cwd } : { ...target, cwd }
}

/** Single-quote for a POSIX shell. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** True when the URL's host is this machine: 127.0.0.0/8, [::1] or localhost.
 *  0.0.0.0 is a listen address, not a loopback one: it counts as another machine,
 *  as does anything that is not a URL (a bare "::1"). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "localhost"
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
    const d = (await r.json()) as { pid?: unknown; service?: { kind?: unknown }; cwd?: unknown; configPath?: unknown }
    const kind = d?.service?.kind
    const s: DaemonStatus = {
      running: true,
      pid: typeof d?.pid === "number" ? d.pid : undefined,
      service: kind === "launchd" || kind === "systemd" || kind === "none" ? kind : undefined,
    }
    if (typeof d?.cwd === "string" && d.cwd) s.cwd = d.cwd
    if (typeof d?.configPath === "string" && d.configPath) s.configPath = d.configPath
    return s
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

/** True when the process `pid` on this machine is agentx (a port forwarded from
 *  another machine, an ssh tunnel or a container, reports a pid that is not). */
export function isAgentxProcess(pid: number, platform: NodeJS.Platform = process.platform, run: RunSync = runSync): boolean {
  if (platform === "win32") {
    // tasklist shows the image name only; the daemon runs as node.exe or agentx.exe.
    const out = run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]) || ""
    return /"(node|agentx)(\.exe)?"/i.test(out)
  }
  return /agentx/i.test(run("ps", ["-p", String(pid), "-o", "command="]) || "")
}

/** SIGTERM: the daemon finishes its running tasks, then exits. */
export function stopDaemon(
  s: DaemonStatus,
  kill: (pid: number, sig: string) => void = (pid, sig) => process.kill(pid, sig),
  isAgentx: (pid: number) => boolean = (pid) => isAgentxProcess(pid),
): void {
  const refusal = stopRefusal(s)
  if (refusal) throw new Error(refusal)
  if (!isAgentx(s.pid as number)) throw new Error(`process ${s.pid} on this machine is not agentx (is the daemon's port forwarded from another machine?); stop it where it runs`)
  kill(s.pid as number, "SIGTERM")
}

/** Runs the agentx CLI. macOS and Linux go through the login shell, since an app
 *  opened from the Dock has a bare PATH. A login shell does not read ~/.zshrc or
 *  ~/.bashrc: when agentx or its node comes from there (nvm), set AGENTX_CLI to
 *  its full path. */
export function runCli(target: DaemonTarget, args: string[], platform: NodeJS.Platform = process.platform): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, stdout: string, stderr: string) =>
      err ? reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-3).join("\n"))) : resolve(stdout)
    // --when-idle may wait up to its 30 min for running tasks, then for the new daemon.
    if (!target.cwd) return reject(new Error("the daemon's folder is not known; set AGENTX_CONFIG to its agentx.json"))
    const opts = { cwd: target.cwd, timeout: 40 * 60_000, windowsHide: true }
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
