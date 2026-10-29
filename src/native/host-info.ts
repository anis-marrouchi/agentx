// --- What machine this is: OS, distro, CPU (#1531) ---
//
// Read once at boot; none of it changes while the daemon runs. Every
// platform goes through the same path, plus one extra source for the
// distro name and version where the OS keeps one:
//
//   macOS    sw_vers                    ProductName / ProductVersion / BuildVersion
//   Linux    /etc/os-release            NAME / VERSION_ID / PRETTY_NAME / ID
//   Windows  os.version()               e.g. "Windows 11 Pro"
//
// Anything it cannot read stays null; it never throws.

import { execFile } from "child_process"
import { readFile } from "fs/promises"
import { arch, cpus, hostname, platform, release, totalmem, version as osVersion } from "os"

export interface HostInfo {
  /** When this was read (boot, or the last refresh). */
  checkedAt: string
  /** Node's platform name: "darwin", "linux", "win32", … */
  platform: string
  arch: string
  hostname: string
  os: {
    /** Plain name: "macOS", "Ubuntu", "Debian GNU/Linux", "Windows 11 Pro". */
    name: string
    /** Release number: "15.1", "24.04", … null when unknown. */
    version: string | null
    /** Distro id on Linux ("ubuntu", "debian"); null elsewhere. */
    distro: string | null
    /** Build number where the OS reports one (macOS). */
    build: string | null
    /** One line for people: "Ubuntu 24.04.1 LTS". */
    pretty: string
    kernel: string
  }
  cpu: { model: string; count: number }
  memTotalMB: number
}

/** KEY=value lines of /etc/os-release, quotes removed. */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const m = raw.trim().match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2")
  }
  return out
}

/** "ProductName:  macOS" lines of sw_vers. */
export function parseSwVers(text: string): { name?: string; version?: string; build?: string } {
  const get = (key: string) => text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim()
  return { name: get("ProductName"), version: get("ProductVersion"), build: get("BuildVersion") }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => res(err ? "" : String(stdout)))
  })
}

export interface HostSources {
  platform: () => string
  readOsRelease: () => Promise<string>
  swVers: () => Promise<string>
  osVersion: () => string
}

const SOURCES: HostSources = {
  platform,
  readOsRelease: () => readFile("/etc/os-release", "utf-8").catch(() => readFile("/usr/lib/os-release", "utf-8")).catch(() => ""),
  swVers: () => run("sw_vers", []),
  osVersion: () => { try { return osVersion() } catch { return "" } },
}

/** The OS part of HostInfo, from the platform's own source. */
export async function detectOs(src: HostSources = SOURCES): Promise<HostInfo["os"]> {
  const p = src.platform()
  const kernel = release()
  if (p === "darwin") {
    const v = parseSwVers(await src.swVers())
    const name = v.name || "macOS"
    const version = v.version ?? null
    return { name, version, distro: null, build: v.build ?? null, pretty: [name, version].filter(Boolean).join(" "), kernel }
  }
  if (p === "linux") {
    const r = parseOsRelease(await src.readOsRelease())
    const name = r.NAME || "Linux"
    const version = r.VERSION_ID || null
    return { name, version, distro: r.ID || null, build: null, pretty: r.PRETTY_NAME || [name, version].filter(Boolean).join(" "), kernel }
  }
  if (p === "win32") {
    const name = src.osVersion() || "Windows"
    return { name, version: kernel || null, distro: null, build: null, pretty: name, kernel }
  }
  const name = src.osVersion() || p
  return { name, version: kernel || null, distro: null, build: null, pretty: name, kernel }
}

export async function detectHost(now = Date.now(), src: HostSources = SOURCES): Promise<HostInfo> {
  const list = cpus()
  return {
    checkedAt: new Date(now).toISOString(),
    platform: src.platform(),
    arch: arch(),
    hostname: hostname(),
    os: await detectOs(src),
    cpu: { model: list[0]?.model?.trim() || "unknown", count: Math.max(1, list.length) },
    memTotalMB: Math.round(totalmem() / (1024 * 1024)),
  }
}
