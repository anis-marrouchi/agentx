import { spawnSync } from "child_process"
import { existsSync, readdirSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { parseLaunchctlPrint } from "../../daemon/restart"
import { bootstrapWithRetry, plistNamesDir } from "../../daemon/upgrade"

// --- Reloading a launchd job without leaving it down ---
//
// `launchctl bootout` returns before the job's process has exited (AgentX
// drains running tasks first), and `launchctl bootstrap` fails while the job
// is still being torn down. So: bootout, wait for the process to exit, wait
// for the job to unload, then bootstrap with retries until it is loaded.

/** Whether this machine runs services through launchd (macOS). */
export function hasLaunchd(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin"
}

export interface LaunchdJob { label: string; domain: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function launchctl(args: string[]): { code: number; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf-8", timeout: 30_000 })
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

export function jobLoaded(j: LaunchdJob): boolean {
  return launchctl(["print", `${j.domain}/${j.label}`]).code === 0
}

export function jobPid(j: LaunchdJob): number | null {
  const r = launchctl(["print", `${j.domain}/${j.label}`])
  return r.code === 0 ? parseLaunchctlPrint(r.out).pid ?? null : null
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Load a job from its settings file, retrying while launchd is busy. */
export function bootstrapJob(j: LaunchdJob, plist: string, log: (s: string) => void = () => {}): Promise<boolean> {
  return bootstrapWithRetry({
    bootstrap: () => {
      const r = launchctl(["bootstrap", j.domain, plist])
      if (r.code !== 0) log(`bootstrap ${j.label}: exit ${r.code} ${r.out.trim().split("\n")[0] ?? ""}`)
      return r.code
    },
    loaded: () => jobLoaded(j),
    sleep,
  })
}

/** Stop a job (its process gets up to `drainLimitMs` to finish) and load it
 *  again from `plist`. True when it is loaded and running afterwards. */
export async function reloadJob(
  j: LaunchdJob, plist: string, o: { drainLimitMs: number; log: (s: string) => void },
): Promise<boolean> {
  const pid = jobPid(j)
  if (jobLoaded(j)) {
    const r = launchctl(["bootout", `${j.domain}/${j.label}`])
    o.log(`bootout ${j.label}${pid ? ` (PID ${pid})` : ""}: exit ${r.code}`)
  }
  if (pid) {
    const t0 = Date.now()
    while (alive(pid) && Date.now() - t0 < o.drainLimitMs) await sleep(500)
    if (alive(pid)) o.log(`PID ${pid} still alive after ${Math.round(o.drainLimitMs / 1000)}s; loading anyway`)
  }
  const t1 = Date.now()
  while (jobLoaded(j) && Date.now() - t1 < 60_000) await sleep(500)
  if (!(await bootstrapJob(j, plist, o.log))) {
    o.log(`${j.label} could not be loaded from ${plist}`)
    return false
  }
  // RunAtLoad / KeepAlive normally start it; make sure.
  if (!jobPid(j)) launchctl(["kickstart", `${j.domain}/${j.label}`])
  o.log(`${j.label} loaded${jobPid(j) ? ` (PID ${jobPid(j)})` : ""}`)
  return true
}

/** Settings file of every loaded job in ~/Library/LaunchAgents that names
 *  the release folder `dir`. */
export function loadedJobsNaming(dir: string, domain: string, laDir = join(homedir(), "Library", "LaunchAgents")): Array<LaunchdJob & { plist: string }> {
  if (!existsSync(laDir)) return []
  const found: Array<LaunchdJob & { plist: string }> = []
  for (const f of readdirSync(laDir)) {
    if (!f.endsWith(".plist")) continue
    const plist = join(laDir, f)
    let text: string
    try { text = readFileSync(plist, "utf-8") } catch { continue }
    if (!plistNamesDir(text, dir)) continue
    const label = spawnSync("plutil", ["-extract", "Label", "raw", plist], { encoding: "utf-8" }).stdout?.trim()
    if (label && jobLoaded({ label, domain })) found.push({ label, domain, plist })
  }
  return found
}

/** A settings file as JSON (plutil reads XML and binary). */
export function readPlistJson(plist: string): any | null {
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf-8" })
  try { return r.status === 0 ? JSON.parse(r.stdout) : null } catch { return null }
}

export function plistValid(plist: string): boolean {
  return spawnSync("plutil", ["-lint", "-s", plist]).status === 0
}
