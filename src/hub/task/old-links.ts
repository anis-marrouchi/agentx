// --- The Task page's address, and where the old addresses go (#2101 T3) ---
//
// One Task page per request (T1, T2) takes the place of the old post page
// (`#post=<id>`) and the old run page (`#page=task&task=<run>&agent=…`, which
// `/tasks/<run>?agent=` redirects to, classic-routes.ts). It now owns the
// real `#page=task`:
//
//   #page=task&id=<request>[&peer=<node>][&run=<run>]     one request
//   #page=task&task=<run>&agent=<agent>[&node=<node>]     a run: its request
//                                                         is looked up, and
//                                                         the run opens in it
//
// The old run page's own keys (`task`, `agent`, `node`) stay readable, so an
// old run address is already a Task page address. What moves:
//
//   - `#post=<id>` (and the T1/T2 review id `#page=task-preview`) go to
//     `#page=task` when React draws it for this viewer (taskRedirect);
//   - a viewer React does not draw it for (`dashboard.hub.legacyPages`,
//     `?legacy=1`, not the owner) keeps the old pages: a Task page address
//     goes back to them (taskFallback).
//
// The old Hub script (wall.client.ts) runs both on every hash it reads.
//
// Plain functions, no imports: the daemon imports this file and ships the
// functions to the old Hub script by injectFns (src/daemon/ui/inject.ts), so
// each reads its data from its own properties, not from this module.

/** The Task page's `#page=` id. */
export const TASK_PAGE = "task"
/** Its review id in T1 and T2; links to it still open the Task page. */
export const TASK_PREVIEW_PAGE = "task-preview"

/** The parts of a Task page address. */
export interface TaskHashParts {
  /** The request. */
  id?: string | null
  /** A run of it, when the request is looked up from the run. */
  task?: string | null
  /** The run's agent; the old run page needs it. */
  agent?: string | null
  /** The node that keeps the request (a peer's daemon URL), none for this one. */
  peer?: string | null
  /** The run opened in place (T2). */
  run?: string | null
}

/** `#page=task&id=…`: a request's Task page, or a run's. Empty parts left out. */
export function taskHash(o: TaskHashParts): string {
  const q = new URLSearchParams()
  q.set("page", taskHash.page)
  for (const k of taskHash.keys) {
    const v = (o as Record<string, string | null | undefined>)[k]
    if (v) q.set(k, v)
  }
  return "#" + q.toString()
}
taskHash.page = TASK_PAGE
taskHash.keys = ["id", "task", "agent", "peer", "run"]

/**
 * Where an old address goes when React draws the Task page, or null to keep
 * it. `peerOf` names the node that keeps a request, when the page knows it
 * (the old Hub's feed data); without it the request is read on this node.
 */
export function taskRedirect(hash: string, peerOf?: (id: string) => string | null | undefined): string | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""))
  const page = q.get("page")
  if (page === taskRedirect.preview) {
    q.set("page", taskRedirect.page)
    return "#" + q.toString()
  }
  const post = q.get("post")
  if (post && page !== taskRedirect.page) return taskHash({ id: post, peer: (peerOf && peerOf(post)) || null })
  return null
}
taskRedirect.page = TASK_PAGE
taskRedirect.preview = TASK_PREVIEW_PAGE

/**
 * Where a Task page address goes when React does not draw it for this
 * viewer: a request to the old post page, a run to the old run page (its
 * `peer` as the old `node`). Null to keep it: an old run address, or not a
 * Task page address.
 */
export function taskFallback(hash: string): string | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""))
  const page = q.get("page")
  if (page !== taskFallback.page && page !== taskFallback.preview) return null
  const task = q.get("task"), agent = q.get("agent"), id = q.get("id")
  if (task && agent) {
    const old = new URLSearchParams()
    old.set("page", taskFallback.page)
    old.set("task", task)
    old.set("agent", agent)
    const node = q.get("node") || q.get("peer")
    if (node) old.set("node", node)
    for (const k of taskFallback.oldKeys) { const v = q.get(k); if (v) old.set(k, v) }
    const to = "#" + old.toString()
    return to === "#" + q.toString() ? null : to
  }
  if (id) return "#" + new URLSearchParams({ status: "open", post: id }).toString()
  return null
}
taskFallback.page = TASK_PAGE
taskFallback.preview = TASK_PREVIEW_PAGE
/** The old run page's other keys (wall-task.client.ts TASK_KEYS). */
taskFallback.oldKeys = ["trace", "ch", "ask", "at", "done"]
