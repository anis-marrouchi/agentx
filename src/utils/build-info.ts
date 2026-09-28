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
