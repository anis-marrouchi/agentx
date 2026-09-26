// --- Where a run came from, and how to re-enter it after a restart ---
//
// Stored as JSON on the run's journal row (task_traces.resume_origin). The
// code that started a run knows how to deliver its answer, so it records
// its own kind and registers a resumer for it (coordinator.ts):
//
//   router  — a chat message (Telegram, WhatsApp, GitLab, GitHub…). Resumed
//             through the router, so the answer lands in the original chat.
//   direct  — anything else (voice, agent-to-agent, webhooks, API). Re-run
//             with the same message and context; nothing delivers its answer,
//             so it is only resumed for channels the operator opts in.

export interface RouterOrigin {
  kind: "router"
  /** Channel adapter name. */
  adapter: string
  /** The incoming message, as the router's inflight log stores it. */
  message: Record<string, unknown>
}

export interface DirectOrigin {
  kind: "direct"
  context?: Record<string, unknown>
  model?: string
  autonomy?: string
}

export type RunOrigin = RouterOrigin | DirectOrigin

/** Bigger than this is not stored: the run is reported instead of resumed. */
export const MAX_ORIGIN_BYTES = 32_000

export function serializeOrigin(origin: RunOrigin | undefined): string | null {
  if (!origin) return null
  try {
    const json = JSON.stringify(origin)
    return json.length <= MAX_ORIGIN_BYTES ? json : null
  } catch {
    return null
  }
}

export function parseOrigin(json: string | null | undefined): RunOrigin | null {
  if (!json) return null
  try {
    const o = JSON.parse(json)
    if (o?.kind === "router" && typeof o.adapter === "string" && o.message && typeof o.message === "object") return o
    if (o?.kind === "direct") return o
  } catch { /* corrupt → not resumable */ }
  return null
}
