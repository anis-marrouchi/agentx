// --- The Task page's read, started by the /hub document (req-01M8CTCW) ---
//
// On one HTTP/1.1 host a browser keeps six requests in flight. The old Hub
// script starts its own reads first (usage, feed, monitor, agents, the live
// stream...), and on a busy daemon each takes seconds, so a Task page opened
// from its address waited 10 to 45 s with only grey blocks while its own
// read answered in under a second once sent. The daemon now writes a small
// script before the old Hub script (src/daemon/ui/pages/wall.ts) that sends
// the page's read at once; the React page takes that answer (main.tsx).
//
// Plain functions, no imports: the daemon ships taskEarlyStart() to the page
// by injectFns (src/daemon/ui/inject.ts), so it reads nothing from this
// module's scope.

/** The read the Task page needs for a /hub address, or null when the
 *  address is not a Task page React draws. The path and peer are the
 *  page's query key (taskThreadQuery in task-data.ts). An old `#post=`
 *  address counts: it goes to the Task page (taskRedirect, old-links.ts). */
export function taskEarlyRead(hash: string, reactPages: readonly string[]): { path: string; peer: string | null } | null {
  if (reactPages.indexOf("task") < 0) return null
  const q = new URLSearchParams(String(hash || "").replace(/^#/, ""))
  const page = q.get("page")
  let id = q.get("id"), task = q.get("task")
  const peer = q.get("peer") || q.get("node") || null
  if (page !== "task" && page !== "task-preview") {
    if (!q.get("post")) return null
    id = q.get("post"); task = null
  }
  if (id) return { path: "/api/admin/wall/thread?id=" + encodeURIComponent(id), peer }
  if (task) return { path: "/api/admin/wall/thread?task=" + encodeURIComponent(task), peer }
  return null
}

/** The early read as the page finds it: its key, and the reply or null. */
export interface TaskEarly { path: string; peer: string | null; reply: Promise<{ ok: boolean; body: unknown } | null> }

/** Sends the Task page's read now, when /hub opens on one, and leaves it on
 *  `window.AX_TASK_EARLY`. Run in the page before the old Hub script. */
export function taskEarlyStart(w: Window & { AX_HUB?: { pages?: string[] }; AX_LOCAL_TOKEN?: string; AX_TASK_EARLY?: TaskEarly }): void {
  try {
    const read = taskEarlyRead(w.location.hash, (w.AX_HUB && w.AX_HUB.pages) || [])
    if (!read) return
    const h: Record<string, string> = { "X-Requested-With": "agentx-board" }
    if (w.AX_LOCAL_TOKEN) h.Authorization = "Bearer " + w.AX_LOCAL_TOKEN
    if (read.peer) h["X-Agentx-Peer"] = read.peer
    const reply = w.fetch(read.path, { credentials: "same-origin", headers: h })
      .then((r) => r.ok ? r.json().then((body) => ({ ok: true, body })) : { ok: false, body: null })
      .catch(() => null)
    w.AX_TASK_EARLY = { path: read.path, peer: read.peer, reply }
  } catch { /* the page reads it itself */ }
}
