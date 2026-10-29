import { execFile } from "child_process"
import { existsSync, readFileSync, statfsSync } from "fs"
import { cpus, freemem, homedir, loadavg, totalmem } from "os"
import { join } from "path"

// --- What the machine has left (#1521) ---
//
// The admission gate reads this before it lets a new agent session start.
// Plain reads of what the kernel already reports: /proc/meminfo on Linux,
// vm_stat and sysctl on macOS, the load average and the free space of the
// AgentX folder. A sample is cached and refreshed in the background so the
// gate never waits on it, and a read that fails leaves its field null
// (unknown), which never closes the gate.

export interface ResourceSample {
  at: number
  /** Memory a new process can get without swapping, MB. */
  memAvailableMB: number | null
  memTotalMB: number
  swapTotalMB: number | null
  swapUsedMB: number | null
  /** 1-minute load average, and divided by the CPU count. */
  load1: number
  loadPerCpu: number
  cpus: number
  /** Free space where AgentX keeps its data, MB. */
  diskFreeMB: number | null
  diskPath: string
}

const MB = 1024 * 1024

/** MemAvailable and swap from /proc/meminfo text (values in kB). */
export function parseMeminfo(text: string): { availableMB: number | null; swapTotalMB: number | null; swapFreeMB: number | null } {
  const kb = (name: string): number | null => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))
    return m ? Number(m[1]) / 1024 : null
  }
  return { availableMB: kb("MemAvailable"), swapTotalMB: kb("SwapTotal"), swapFreeMB: kb("SwapFree") }
}

/** Free + inactive + speculative + purgeable pages from `vm_stat`: what
 *  macOS hands a new process without paging out. os.freemem() counts only
 *  the free pages and reads near zero on a healthy Mac. */
export function parseVmStat(text: string): number | null {
  const size = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 4096)
  const pages = (name: string) => Number(text.match(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m"))?.[1] ?? 0)
  const total = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")
  return total > 0 ? (total * size) / MB : null
}

/** `sysctl vm.swapusage`: "total = 2048.00M  used = 1024.00M  free = …". */
export function parseSwapUsage(text: string): { totalMB: number; usedMB: number } | null {
  const num = (name: string) => {
    const m = text.match(new RegExp(`${name} = ([\\d.]+)([MG])`))
    return m ? Number(m[1]) * (m[2] === "G" ? 1024 : 1) : null
  }
  const total = num("total"), used = num("used")
  return total === null || used === null ? null : { totalMB: total, usedMB: used }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout)))
  })
}

export function defaultDiskPath(): string {
  const home = join(homedir(), ".agentx")
  return existsSync(home) ? home : homedir()
}

/** One fresh reading. Never throws. */
export async function sampleResources(diskPath = defaultDiskPath()): Promise<ResourceSample> {
  const memTotalMB = totalmem() / MB
  let memAvailableMB: number | null = null
  let swapTotalMB: number | null = null
  let swapUsedMB: number | null = null
  if (process.platform === "linux") {
    try {
      const info = parseMeminfo(readFileSync("/proc/meminfo", "utf-8"))
      memAvailableMB = info.availableMB
      swapTotalMB = info.swapTotalMB
      swapUsedMB = info.swapTotalMB !== null && info.swapFreeMB !== null ? info.swapTotalMB - info.swapFreeMB : null
    } catch { /* unknown */ }
  } else if (process.platform === "darwin") {
    const [vm, swap] = await Promise.all([run("vm_stat", []), run("sysctl", ["vm.swapusage"])])
    memAvailableMB = parseVmStat(vm)
    const s = parseSwapUsage(swap)
    if (s) { swapTotalMB = s.totalMB; swapUsedMB = s.usedMB }
  }
  if (memAvailableMB === null && process.platform !== "darwin") memAvailableMB = freemem() / MB
  let diskFreeMB: number | null = null
  try {
    const st = statfsSync(diskPath)
    diskFreeMB = (Number(st.bavail) * Number(st.bsize)) / MB
  } catch { /* unknown */ }
  const n = Math.max(1, cpus().length)
  const load1 = loadavg()[0] ?? 0
  return {
    at: Date.now(),
    memAvailableMB, memTotalMB, swapTotalMB, swapUsedMB,
    load1, loadPerCpu: load1 / n, cpus: n,
    diskFreeMB, diskPath,
  }
}

/** Keeps the last sample and refreshes it no more often than `maxAgeMs`. */
export class ResourceMonitor {
  private last: ResourceSample | null = null
  private inflight: Promise<ResourceSample> | null = null

  constructor(
    private readonly read: () => Promise<ResourceSample> = () => sampleResources(),
    private readonly maxAgeMs = 2000,
  ) {}

  /** The cached sample, or null before the first read. */
  current(): ResourceSample | null {
    return this.last
  }

  /** A sample no older than maxAgeMs. */
  async fresh(now = Date.now()): Promise<ResourceSample> {
    if (this.last && now - this.last.at < this.maxAgeMs) return this.last
    if (!this.inflight) {
      this.inflight = this.read()
        .then((s) => { this.last = s; return s })
        .finally(() => { this.inflight = null })
    }
    return this.inflight
  }
}
