import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import {
  launchdRespawn, parseLaunchctlList, parseLaunchctlPrint, parseSystemdCgroup, systemctlArgs, systemdRespawn,
  type Respawn, type ServiceInfo,
} from "./restart"

// --- Asking the host what runs a process (see restart.ts for the rules) ---
//
// Every call is read-only: `launchctl list`, `launchctl print`, `plutil`,
// `systemctl show` and /proc. Nothing here starts or stops anything.

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return null
  }
}

export function launchdDomain(uid = process.getuid?.() ?? 0): string {
  return uid === 0 ? "system" : `gui/${uid}`
}

/** What runs process `pid`: a launchd job, a systemd unit, or neither. */
export function detectService(pid: number, platform: NodeJS.Platform = process.platform): ServiceInfo {
  if (platform === "darwin") {
    const list = run("launchctl", ["list"])
    const label = list ? parseLaunchctlList(list, pid) : null
    // Terminal apps register their own children as "application.*" jobs.
    if (label && !label.startsWith("application.")) return { kind: "launchd", label, domain: launchdDomain() }
    return { kind: "none" }
  }
  if (platform === "linux") {
    const path = `/proc/${pid}/cgroup`
    if (!existsSync(path)) return { kind: "none" }
    try {
      const unit = parseSystemdCgroup(readFileSync(path, "utf-8"))
      if (unit) return { kind: "systemd", ...unit }
    } catch { /* unreadable → treat as not a service */ }
  }
  return { kind: "none" }
}

/** The launchd job's settings file, from `launchctl print`. */
export function launchdPlistPath(service: { label: string; domain: string }): string | null {
  const out = run("launchctl", ["print", `${service.domain}/${service.label}`])
  return out ? parseLaunchctlPrint(out).path ?? null : null
}

/** Whether a job is currently loaded in launchd. */
export function launchdLoaded(service: { label: string; domain: string }): boolean {
  return run("launchctl", ["print", `${service.domain}/${service.label}`]) !== null
}

/** Whether the service manager starts the daemon again after it exits.
 *  Null when the setting can't be read. */
export function readRespawn(service: ServiceInfo): Respawn | null {
  if (service.kind === "launchd") {
    const plist = launchdPlistPath(service)
    if (!plist) return null
    const json = run("plutil", ["-convert", "json", "-o", "-", plist])
    if (!json) return null
    try {
      return launchdRespawn(JSON.parse(json)?.KeepAlive)
    } catch {
      return null
    }
  }
  if (service.kind === "systemd") {
    const out = run("systemctl", [...systemctlArgs(service, "show").slice(0, -1), "-p", "Restart", "--value", service.unit])
    return out === null ? null : systemdRespawn(out)
  }
  return null
}

/** PID of the process listening on a TCP port, when lsof can tell. */
export function pidListeningOn(port: number): number | null {
  const out = run("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"])
  const pid = out ? parseInt(out.trim().split("\n")[0], 10) : NaN
  return Number.isFinite(pid) ? pid : null
}
