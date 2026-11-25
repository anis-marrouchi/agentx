// --- Moving a launchd node to another release folder (`agentx daemon upgrade`) ---
//
// A release folder is a built copy of AgentX (<dir>/dist/cli.js). The daemon's
// launchd settings file names one; upgrading points it, and every other loaded
// job that names the same folder (the dashboard), at a new one.
//
// Everything here is pure and unit tested. Running launchctl lives in
// native/macos/launchd.ts, the command in commands/daemon-upgrade.ts.

import { dirname } from "path"

/** The release folder a job runs: the folder holding dist/cli.js in its
 *  program arguments. Null when no argument is a release CLI. */
export function releaseDirFromArgs(args: unknown): string | null {
  if (!Array.isArray(args)) return null
  for (const a of args) {
    if (typeof a === "string" && /\/dist\/cli\.js$/.test(a)) return dirname(dirname(a))
  }
  return null
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whether a settings file names the release folder (as a path, not as the
 *  prefix of a longer folder name). */
export function plistNamesDir(text: string, dir: string): boolean {
  return new RegExp(`${escapeRe(dir)}(?=[/<"])`).test(text)
}

/** The settings file with every path inside `oldDir` moved to `newDir`. */
export function retargetPlist(text: string, oldDir: string, newDir: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(new RegExp(`${escapeRe(oldDir)}(?=[/<"])`, "g"), () => {
    count++
    return newDir
  })
  return { text: out, count }
}

/** Label of the one-shot job that runs an upgrade for a daemon job. */
export function upgradeJobLabel(daemonLabel: string): string {
  return `${daemonLabel}.upgrade`
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export interface OneShotJob {
  label: string
  programArguments: string[]
  workingDirectory: string
  logPath: string
  environment: Record<string, string>
}

/** Settings file for a job that runs once and is never started again: no
 *  KeepAlive, LaunchOnlyOnce, and its own process group so stopping the
 *  daemon's job does not stop it. It must be stored outside
 *  ~/Library/LaunchAgents so it never runs at login. */
export function oneShotPlist(j: OneShotJob): string {
  const str = (s: string) => `<string>${xml(s)}</string>`
  const env = Object.entries(j.environment)
    .map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(j.label)}
  <key>ProgramArguments</key>
  <array>
${j.programArguments.map((a) => `    ${str(a)}`).join("\n")}
  </array>
  <key>WorkingDirectory</key>${str(j.workingDirectory)}
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>StandardOutPath</key>${str(j.logPath)}
  <key>StandardErrorPath</key>${str(j.logPath)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>LaunchOnlyOnce</key><true/>
  <key>AbandonProcessGroup</key><true/>
</dict>
</plist>
`
}

/** Whether /health comes from a new daemon process on the expected version. */
export function healthIsUpgraded(h: any, o: { version: string; oldPid: number | null }): boolean {
  if (!h || h.version !== o.version) return false
  if (typeof h.pid === "number" && o.oldPid !== null) return h.pid !== o.oldPid
  return true
}

export interface BootstrapDeps {
  /** Run `launchctl bootstrap`; returns its exit code. */
  bootstrap: () => number
  /** Whether the job is loaded now. */
  loaded: () => boolean
  sleep: (ms: number) => Promise<void>
}

/** `launchctl bootstrap`, retried. It fails with "5: Input/output error"
 *  while the previous instance is still being torn down, which used to
 *  leave AgentX down. Success means the job ends up loaded. */
export async function bootstrapWithRetry(d: BootstrapDeps, attempts = 10, delayMs = 3000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const code = d.bootstrap()
    if (code === 0 || d.loaded()) return true
    if (i < attempts - 1) await d.sleep(delayMs)
  }
  return d.loaded()
}

/** Channels that carry the fleet's own work: agents asking agents, schedules,
 *  workflow steps, code-host events. Nobody is waiting on a reply there, so
 *  with `--people-only` such a run does not hold an upgrade back. It gets the
 *  usual drain time and, if still going, is cut. Every other channel, known
 *  or not, counts as a person waiting. */
export const OWN_WORK_CHANNELS: ReadonlySet<string> = new Set([
  "a2a", "cron", "workflow", "reminder", "github", "gitlab", "subagent",
  "events", "sensor", "selftest", "mcp", "none", "signals",
])

/** A run as GET /daemon/restart lists it. */
export interface RunningRun {
  agentId?: string
  taskId?: string
  channel?: string | null
  chatId?: string
}

/** Whether a run holds a `--people-only` upgrade back: a person is waiting
 *  on it. A run with no channel, or one we don't know, holds it. */
export function holdsUpgrade(run: { channel?: string | null }): boolean {
  const ch = (run.channel ?? "").toLowerCase().split("@")[0].trim()
  return !ch || !OWN_WORK_CHANNELS.has(ch)
}

/** How many of these runs hold a `--people-only` upgrade back. */
export function countHolding(running: ReadonlyArray<{ channel?: string | null }>): number {
  return running.filter(holdsUpgrade).length
}

/** A run the upgrade did not wait for, as written to last.json. */
export interface CutRun {
  agentId: string
  channel: string
  taskId: string
}

/** The runs a `--people-only` upgrade goes ahead over. */
export function runsToCut(running: ReadonlyArray<RunningRun>): CutRun[] {
  return running.filter((r) => !holdsUpgrade(r)).map((r) => ({
    agentId: r.agentId ?? "?", channel: r.channel ?? "?", taskId: r.taskId ?? "?",
  }))
}

/** What `agentx daemon upgrade` writes to .agentx/upgrade/last.json. */
export interface UpgradeOutcome {
  result: "ok" | "rolled-back" | "down" | "refused"
  from: { dir: string; version: string | null }
  to: { dir: string; version: string }
  jobs: string[]
  /** With `--people-only`: the fleet's own runs still going at the switch.
   *  They got the drain time; any that outlasted it were cut. */
  cut?: CutRun[]
  reason?: string
  startedAt: string
  endedAt: string
}
