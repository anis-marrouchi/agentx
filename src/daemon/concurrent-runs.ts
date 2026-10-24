import { basename, resolve } from "path"

// --- Concurrent sessions (#1187, #1180 item 21) ---
//
// Two runs that were going at the same time on one chat, or in one
// worktree (the agent's workspace folder), are flagged. That is a task
// sent to two agents at once, or two runs of one agent racing on the same
// files. Read-only: the spans come from task traces and /api/live.
//
// Runs only overlap when one starts before the other ends; a run that
// starts the moment another ends (back to back) is not flagged.

export interface RunSpan {
  runId: string
  agentId: string
  /** channel:chatId, or null when the run has no chat. */
  chat: string | null
  /** The workspace folder the run works in, or null when unknown. */
  worktree: string | null
  startedAt: number
  /** Null: still running. */
  endedAt: number | null
}

export interface RunOverlap {
  /** What the two runs share. */
  on: Array<"chat" | "worktree">
  /** The chat key, and the worktree folder's name (never its full path). */
  chat: string | null
  worktree: string | null
  runs: [string, string]
  agents: [string, string]
  /** When both were running. `to` null: both still are. */
  from: number
  to: number | null
}

/** A comparable key for a workspace path; null when there is none. */
export function worktreeKey(workspace: string | null | undefined): string | null {
  return workspace ? resolve(workspace).replace(/\/+$/, "") : null
}

export function chatKey(channel: string | null | undefined, chatId: string | null | undefined): string | null {
  return chatId ? `${channel || "?"}:${chatId}` : null
}

/** Every pair of runs that overlapped in time on one chat or one worktree,
 *  earliest first. `now` stands in for the end of a run still going. */
export function findOverlaps(spans: RunSpan[], now: number): RunOverlap[] {
  const seen = new Set<string>()
  const list = spans.filter((s) => {
    if (seen.has(s.runId)) return false
    seen.add(s.runId)
    return true
  }).sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
  const end = (s: RunSpan) => s.endedAt ?? now
  const out: RunOverlap[] = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]
      if (b.startedAt >= end(a)) continue
      if (a.startedAt >= end(b)) continue
      const on: RunOverlap["on"] = []
      if (a.chat && a.chat === b.chat) on.push("chat")
      if (a.worktree && a.worktree === b.worktree) on.push("worktree")
      if (!on.length) continue
      const stillA = a.endedAt === null, stillB = b.endedAt === null
      out.push({
        on,
        chat: on.includes("chat") ? a.chat : null,
        worktree: on.includes("worktree") ? basename(a.worktree!) : null,
        runs: [a.runId, b.runId],
        agents: [a.agentId, b.agentId],
        from: b.startedAt,
        to: stillA && stillB ? null : Math.min(end(a), end(b)),
      })
    }
  }
  return out
}
