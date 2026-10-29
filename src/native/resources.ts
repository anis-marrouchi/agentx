// --- Node resources, as the admission gate reads them (#1521) ---
//
// Free memory as the OS reports it (os.freemem) is near zero on a healthy
// macOS box: the kernel keeps file cache in "inactive" pages it can hand
// back at once. So "available" here is what a new process could get
// without swapping: free + inactive + speculative + purgeable pages on
// macOS (vm_stat), MemAvailable on Linux. Anything else falls back to
// os.freemem.
//
// Sampling shells out on macOS (vm_stat, sysctl), so it is cached and
// never run more than once per `ttlMs`.

import { execFile } from "child_process"
import { readFile, statfs } from "fs/promises"
import { cpus, freemem, loadavg, platform, totalmem } from "os"

export interface ResourceSample {
  at: number
  memTotalMB: number
  memAvailableMB: number
  /** 0 when the node has no swap configured. */
  swapTotalMB: number
  swapUsedMB: number
  /** The OS grows swap as it is used (macOS swap files), so the total is
   *  not a fixed size and used/total is always high. */
  swapGrows: boolean
  /** Free space for this user on the disk holding the daemon's folder;
   *  null when it could not be read. */
  diskFreeMB: number | null
  load1: number
  cpuCount: number
}

const MB = 1024 * 1024

/** Available memory in MB from `vm_stat` output, or null when unreadable. */
export function parseVmStat(out: string): number | null {
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1])
  if (!pageSize) return null
  const pages = (label: string): number => {
    const m = out.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"))
    return m ? Number(m[1]) : 0
  }
  const avail = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")
  return Math.round((avail * pageSize) / MB)
}

/** Swap from `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1024.50M  free = …". */
export function parseSwapUsage(out: string): { totalMB: number; usedMB: number } | null {
  const num = (key: string): number | null => {
    const m = out.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT]?)`))
    if (!m) return null
    const scale: Record<string, number> = { "": 1 / MB, K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }
    return Number(m[1]) * (scale[m[2]] ?? 1)
  }
  const total = num("total"), used = num("used")
  if (total === null || used === null) return null
  return { totalMB: Math.round(total), usedMB: Math.round(used) }
}

/** Memory and swap from /proc/meminfo (values in kB). */
export function parseMeminfo(out: string): { availableMB: number; swapTotalMB: number; swapUsedMB: number } | null {
  const kb = (key: string): number | null => {
    const m = out.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))
    return m ? Number(m[1]) : null
  }
  const avail = kb("MemAvailable")
  if (avail === null) return null
  const swapTotal = kb("SwapTotal") ?? 0
  const swapFree = kb("SwapFree") ?? swapTotal
  return {
    availableMB: Math.round(avail / 1024),
    swapTotalMB: Math.round(swapTotal / 1024),
    swapUsedMB: Math.round(Math.max(0, swapTotal - swapFree) / 1024),
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => res(err ? "" : String(stdout)))
  })
}

/** One fresh reading of the node. Never throws: a part it cannot read
 *  falls back (memory) or is left null (disk). */
export async function sampleResources(diskPath: string): Promise<ResourceSample> {
  const memTotalMB = Math.round(totalmem() / MB)
  let memAvailableMB = Math.round(freemem() / MB)
  let swapTotalMB = 0, swapUsedMB = 0
  const os = platform()
  const swapGrows = os === "darwin"
  if (os === "darwin") {
    const [vm, swap] = await Promise.all([run("vm_stat", []), run("sysctl", ["-n", "vm.swapusage"])])
    memAvailableMB = parseVmStat(vm) ?? memAvailableMB
    const s = parseSwapUsage(swap)
    if (s) { swapTotalMB = s.totalMB; swapUsedMB = s.usedMB }
  } else if (os === "linux") {
    const info = parseMeminfo(await readFile("/proc/meminfo", "utf-8").catch(() => ""))
    if (info) {
      memAvailableMB = info.availableMB
      swapTotalMB = info.swapTotalMB
      swapUsedMB = info.swapUsedMB
    }
  }
  let diskFreeMB: number | null = null
  try {
    const st = await statfs(diskPath)
    diskFreeMB = Math.round((Number(st.bavail) * Number(st.bsize)) / MB)
  } catch { /* left null: the disk check is skipped */ }
  return {
    at: Date.now(),
    memTotalMB, memAvailableMB, swapTotalMB, swapUsedMB, swapGrows, diskFreeMB,
    load1: Math.round(loadavg()[0] * 100) / 100,
    cpuCount: Math.max(1, cpus().length),
  }
}

/** Caches samples for `ttlMs`; concurrent callers share one reading. */
export class ResourceSampler {
  private last: ResourceSample | null = null
  private pending: Promise<ResourceSample> | null = null

  constructor(
    private readonly diskPath: string,
    private readonly ttlMs = 3000,
    private readonly sample: (diskPath: string) => Promise<ResourceSample> = sampleResources,
  ) {}

  latest(): ResourceSample | null {
    return this.last
  }

  async read(now = Date.now()): Promise<ResourceSample> {
    if (this.last && now - this.last.at < this.ttlMs) return this.last
    if (!this.pending) {
      this.pending = this.sample(this.diskPath)
        .then((s) => { this.last = s; return s })
        .finally(() => { this.pending = null })
    }
    return this.pending
  }
}
