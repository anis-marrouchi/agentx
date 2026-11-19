// --- Request status is deprecated (#1861, owner decision 2026-11-19) ---
//
// The Jobs page (Hub › Jobs, /hub#page=jobledger) shows every piece of
// assigned work and what it is doing now, which covers what request status
// (#383) was for. The command, the `requestStatus` setting and its tables
// stay for now and are removed in a later release. Until then each use says
// so once: the CLI on stderr, the daemon in its start log.

export const REQUEST_STATUS_DEPRECATION =
  "request status is deprecated and will be removed in a later release; use the Jobs page in the dashboard (Hub › Jobs, /hub#page=jobledger) instead."

/** The daemon's start-log line, or null when no channel has it on. */
export function requestStatusDeprecationLog(channels: readonly string[]): string | null {
  return channels.length ? `  Request status (${channels.join(", ")}): ${REQUEST_STATUS_DEPRECATION}` : null
}
