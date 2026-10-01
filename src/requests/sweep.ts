import type { RequestRecord, RequestStore } from "./store"
import type { RequestSettings } from "./tracker"

// --- The daemon's requests check, once a minute (#356) ---
//
//   1. Quiet: an open request nothing has touched for `staleAfterHours`
//      needs attention. So does a candidate that old: its turn never
//      reported an end. A request waiting on the owner is left alone; its
//      question is what reminds them.
//   2. Tell once: every request that needs attention is sent to the owner
//      one time. After that it is only listed. A notice that could not be
//      sent at all is tried again at the next check.
//   3. Retention: closed requests older than `retentionDays` are deleted.
//      Open requests never age out.
//
// Every step is isolated: a failure is logged and the next step runs.

export interface RequestSweepDeps {
  store: RequestStore
  settings: RequestSettings
  /** Tell the owner, through the daemon's notify path. */
  notify?: (title: string, message: string, request: RequestRecord) => Promise<void>
  log: (msg: string) => void
  now?: number
}

export interface RequestSweepResult {
  quiet: number
  notified: number
  pruned: number
}

const HOUR = 3_600_000

export function attentionText(r: RequestRecord): string {
  const words = r.text.replace(/\s+/g, " ").trim()
  return [
    `A request you gave ${r.agentId} on ${r.channel} is not finished.`,
    `You asked: ${words.length > 240 ? `${words.slice(0, 239)}…` : words}`,
    `What happened: ${r.attentionReason ?? "unknown"}`,
    "Nothing is retrying it. Ask again, or drop it.",
  ].join("\n")
}

export async function runRequestsSweep(deps: RequestSweepDeps): Promise<RequestSweepResult> {
  const { store, settings, log } = deps
  const now = deps.now ?? Date.now()
  const result: RequestSweepResult = { quiet: 0, notified: 0, pruned: 0 }
  if (!settings.enabled) return result

  try {
    const hours = settings.staleAfterHours
    for (const r of store.quietSince(["candidate", "in_progress", "waiting_other"], now - hours * HOUR)) {
      const reason = r.state === "candidate"
        ? `The turn that received it never reported an end (${hours} h ago or more)`
        : `No activity for ${hours} h`
      if (store.needsAttention(r.id, reason, now)) result.quiet++
    }
  } catch (e: any) {
    log(`[requests] quiet check failed: ${e?.message ?? e}`)
  }

  try {
    for (const r of store.awaitingNotice()) {
      // Marked first: a notice that hangs must not be sent twice.
      store.markNotified(r.id, now)
      if (!deps.notify) continue
      try {
        await deps.notify("Request not finished", attentionText(r), r)
        result.notified++
      } catch (e: any) {
        // Nothing reached the owner: try again at the next check.
        store.markNotified(r.id, null)
        log(`[requests] couldn't tell the owner about ${r.id}, will try again: ${e?.message ?? e}`)
      }
    }
  } catch (e: any) {
    log(`[requests] notices failed: ${e?.message ?? e}`)
  }

  try {
    result.pruned = store.pruneClosed(now - settings.retentionDays * 24 * HOUR)
  } catch (e: any) {
    log(`[requests] retention failed: ${e?.message ?? e}`)
  }
  return result
}
