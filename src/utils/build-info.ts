import { realpathSync, statSync } from "fs"
import { getPackageInfo } from "./get-package-info"

// Replaced by tsup `define` at build time (tsup.config.ts). Absent when
// running from source (tsx, vitest), where the fallbacks below apply.
declare const __AGENTX_VERSION__: string | undefined
declare const __AGENTX_COMMIT__: string | null | undefined

/**
 * What this process is running, fixed when it loaded. A rebuild or an
 * in-place upgrade on disk does not change it until the daemon restarts.
 */
export const buildInfo: { version: string | null; commit: string | null; startedAt: string } = {
  version: typeof __AGENTX_VERSION__ !== "undefined" ? __AGENTX_VERSION__ : (getPackageInfo().version ?? null),
  commit: typeof __AGENTX_COMMIT__ !== "undefined" ? __AGENTX_COMMIT__ : null,
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
}

export interface DiskBuild {
  /** The code on disk is not what this process loaded: a restart is due. */
  newer: boolean
  /** When the entry file on disk was last written. */
  changedAt: string | null
  version: string | null
}

/** Compare what a process loaded with what is on disk now. A rebuild shows
 *  as a newer entry file; an npm upgrade keeps the package's file dates, so
 *  it shows as another version. */
export function compareDiskBuild(
  running: { version: string | null; startedAt: string },
  disk: { mtimeMs: number | null; version: string | null },
): DiskBuild {
  const rebuilt = disk.mtimeMs !== null && disk.mtimeMs > Date.parse(running.startedAt)
  const otherVersion = !!disk.version && !!running.version && disk.version !== running.version
  return {
    newer: rebuilt || otherVersion,
    changedAt: disk.mtimeMs === null ? null : new Date(disk.mtimeMs).toISOString(),
    version: disk.version,
  }
}

/** The build on disk next to this process, read now. */
export function diskBuild(): DiskBuild {
  let mtimeMs: number | null = null
  try { mtimeMs = statSync(realpathSync(process.argv[1])).mtimeMs } catch { /* no entry file to look at */ }
  const version = getPackageInfo().version
  // "0.0.0" is getPackageInfo's "found nothing", not a version.
  return compareDiskBuild(buildInfo, { mtimeMs, version: version && version !== "0.0.0" ? version : null })
}
