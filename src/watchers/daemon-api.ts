import type { WatchCheckpoint } from "./checkpoint"
import type { WatcherState, WatcherStore } from "./store"

// --- The daemon's /watchers endpoints (#1030) ---
//
// Gated like /requests: loopback, or a mesh token.
//   GET  /watchers            newest first; ?state=open|alerted|escalated|done
//   GET  /watchers/:id        one watcher
//   POST /watchers/:id/done   the task is done; body { evidence? }

export interface WatchersApiDeps {
  store: WatcherStore
  checkpoint: WatchCheckpoint
}

const STATES: readonly WatcherState[] = ["open", "alerted", "escalated", "done"]

export function handleWatchersApi(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | undefined,
  deps: WatchersApiDeps,
): { status: number; body: unknown } {
  const parts = path.split("/").filter(Boolean)
  if (method === "GET" && parts.length === 1) {
    const state = query.get("state") ?? undefined
    if (state && !(STATES as readonly string[]).includes(state)) {
      return { status: 400, body: { error: `state must be one of ${STATES.join(", ")}` } }
    }
    const limit = Number(query.get("limit") ?? 100)
    return { status: 200, body: { watchers: deps.store.list({ state: state as WatcherState | undefined, limit: Number.isFinite(limit) ? limit : 100 }) } }
  }
  const id = parts[1] ? decodeURIComponent(parts[1]) : ""
  const watcher = id ? deps.store.get(id) : null
  if (!watcher) return { status: 404, body: { error: `no watcher ${id}` } }
  if (method === "GET" && parts.length === 2) return { status: 200, body: { watcher } }
  if (method === "POST" && parts.length === 3 && parts[2] === "done") {
    const evidence = typeof body?.evidence === "string" && body.evidence.trim() ? body.evidence.trim().slice(0, 500) : "marked done"
    const changed = deps.checkpoint.markDone(watcher.id, evidence)
    return { status: 200, body: { watcher: deps.store.get(watcher.id), changed } }
  }
  return { status: 404, body: { error: "unknown watchers route" } }
}
