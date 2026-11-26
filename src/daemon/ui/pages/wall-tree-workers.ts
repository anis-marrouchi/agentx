// --- Workers under each agent run in the live tree (#2145) ---
//
// New-user feedback (2026-11-23): "I can see the workers that are launched
// by them". Under an agent's run row, the work that run set going:
//
//   - hand-offs (send_agent, /task from the turn), on this machine or a
//     peer: runningTasks[].workers, kind "handoff", from GET /agents
//   - workflows it started, or sub-runs of the workflow run it works in:
//     runningTasks[].workers, kind "workflow"
//   - runs that name it as their parent (agent.call, mesh.delegate, a
//     hand-off's run on another machine): runningTasks[].parent, matched
//     across every machine of the snapshot
//
// Each worker shows its state (working, done, failed, waiting), how long
// ago it started or ended, its title, and links to its chat (its run's
// Task page) when its run is known, else to its workflow or its agent.
//
// Shipped to the browser through injectFns with wall-tree.ts: each
// function is self-contained and calls only other functions of this file.
// What it needs from wall-tree.ts (ltTitle, ltEsc, ltAge) is passed in as
// an argument, never imported: an import would not be bound in the browser
// (../inject.ts). Every piece of fleet text goes through that ltEsc.

import type { LtMachine, LtNode, LtTask } from "./wall-tree"

/** A worker as GET /agents sends it on its parent run (run-workers.ts). */
export interface LtWorkerIn {
  kind: "handoff" | "workflow"
  id: string
  title?: string
  status?: string
  startedAt?: string
  endedAt?: string
  agentId?: string
  peer?: string
  taskId?: string
  workflowId?: string
}

export interface LtWorker {
  key: string
  kind: "handoff" | "workflow" | "run"
  title: string
  agentId: string
  agentName: string
  /** The machine it runs on, when not its parent's ("" on the same one). */
  where: string
  state: "working" | "done" | "failed" | "waiting"
  /** ms since it started (working, waiting) or ended (done, failed). */
  ageMs: number
  /** Its own run, for a link to its Task page; null when not known. */
  task: LtTask | null
  /** The URL of the machine `task` runs on. */
  nodeUrl: string
  workflowId: string
}

/** One running task anywhere in the snapshot, with where it runs. */
export interface LtRunRef {
  task: LtTask
  agentId: string
  agentName: string
  nodeKey: string
  nodeName: string
  nodeUrl: string
}

/** Every running task of the machines that answer, for the parent links. */
export function ltRunIndex(nodes: LtNode[]): LtRunRef[] {
  const out: LtRunRef[] = []
  for (const n of nodes || []) {
    if (!n || !n.reachable || n.error) continue
    const nodeKey = String(n.id || n.url || n.name)
    for (const a of n.agents || []) {
      for (const t of a.runningTasks || []) {
        out.push({ task: t, agentId: a.id, agentName: String(a.name || a.id), nodeKey, nodeName: String(n.name || n.url || ""), nodeUrl: String(n.url || "") })
      }
    }
  }
  return out
}

/** A worker status in the sidebar's four words; anything else is working. */
export function ltWorkerState(status: unknown): "working" | "done" | "failed" | "waiting" {
  const s = String(status || "")
  if (s === "done" || s === "completed") return "done"
  if (s === "waiting" || s === "paused") return "waiting"
  if (s === "failed" || s === "error" || s === "timeout" || s === "lost" || s === "canceled") return "failed"
  return "working"
}

/** The workers of run `t` of agent `agentId` on machine `nodeKey`: the
 *  ones its machine listed on it, then runs anywhere that name it as
 *  their parent. Newest first. */
export function ltWorkersOf(t: LtTask, nodeKey: string, index: LtRunRef[], now: number, titleOf: (t: LtTask) => string): LtWorker[] {
  const out: LtWorker[] = []
  const seen: Record<string, boolean> = {}
  const nameOf = (id: string): string => {
    const r = index.find((x) => x.agentId === id)
    return r ? r.agentName : id
  }
  const age = (iso: unknown): number => {
    const ms = Date.parse(String(iso || ""))
    return Number.isFinite(ms) ? Math.max(0, now - ms) : 0
  }
  const sameParent = (r: LtRunRef): boolean => {
    const p = r.task.parent
    return !!p && p.taskId === t.id && (p.node ? p.node === nodeKey : r.nodeKey === nodeKey)
  }
  for (const w of t.workers || []) {
    if (!w || !w.id) continue
    const state = ltWorkerState(w.status)
    const agentId = String(w.agentId || "")
    // Its run: on this machine by id, or on a peer by its parent link.
    const own = (w.taskId && index.find((r) => r.nodeKey === nodeKey && r.task.id === w.taskId))
      || (w.kind === "handoff" && w.peer && state === "working" && index.find((r) => r.nodeKey !== nodeKey && r.agentId === agentId && sameParent(r) && !seen["t:" + r.nodeKey + "|" + r.task.id]))
      || null
    if (own) seen["t:" + own.nodeKey + "|" + own.task.id] = true
    out.push({
      key: w.kind + ":" + w.id, kind: w.kind === "workflow" ? "workflow" : "handoff",
      title: String(w.title || (w.kind === "workflow" ? w.workflowId : "Work for " + agentId) || "A worker").split("\n")[0].slice(0, 120),
      agentId, agentName: agentId ? nameOf(agentId) : "", where: own && own.nodeKey !== nodeKey ? own.nodeName : String(w.peer || ""),
      state, ageMs: state === "done" || state === "failed" ? age(w.endedAt || w.startedAt) : age(w.startedAt),
      task: own ? own.task : w.taskId && state !== "working" ? { id: w.taskId } : null,
      nodeUrl: own ? own.nodeUrl : "", workflowId: String(w.workflowId || ""),
    })
  }
  for (const r of index) {
    if (!sameParent(r) || seen["t:" + r.nodeKey + "|" + r.task.id]) continue
    seen["t:" + r.nodeKey + "|" + r.task.id] = true
    out.push({
      key: "run:" + r.nodeKey + "|" + r.task.id, kind: "run", title: titleOf(r.task),
      agentId: r.agentId, agentName: r.agentName, where: r.nodeKey !== nodeKey ? r.nodeName : "",
      state: "working", ageMs: age(r.task.startedAt), task: r.task, nodeUrl: r.nodeUrl, workflowId: "",
    })
  }
  // Going first, then the newest.
  const rank = (w: LtWorker) => (w.state === "working" ? 0 : w.state === "waiting" ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b) || a.ageMs - b.ageMs)
}

/** Each working row's workers, from the snapshot the tree was built from
 *  (`row.workers`; done rows have none). Returns the same machines. */
export function ltAddWorkers(machines: LtMachine[], nodes: LtNode[], now: number, titleOf: (t: LtTask) => string): LtMachine[] {
  const index = ltRunIndex(nodes)
  for (const m of machines || []) {
    for (const p of m.projects || []) {
      for (const i of p.items) for (const r of i.rows) if (r.task) r.workers = ltWorkersOf(r.task, m.id, index, now, titleOf)
    }
  }
  return machines
}

/** One worker row, nested under its parent's row. `href` opens its chat;
 *  `esc` and `age` are wall-tree.ts's ltEsc and ltAge. */
export function ltWorkerHtml(w: LtWorker, href: string, esc: (s: unknown) => string, age: (ms: number) => string): string {
  const word = w.state === "done" || w.state === "failed" || w.state === "waiting" ? w.state : "working"
  const state = '<span class="ax-af-state" data-state="' + (w.state === "working" ? "running" : w.state === "failed" ? "error" : w.state) + '">' + word + "</span>"
  const who = (w.agentName ? '<span class="lt__who">' + esc(w.agentName) + "</span>" : "") +
    (w.where ? (w.agentName ? " " : "") + "on " + esc(w.where) : "")
  const sub = (who ? who + " · " : "") + state + " · <time>" + age(w.ageMs) + "</time>"
  const inner = '<span class="lt__txt"><span class="lt__title">' + esc(w.title) + '</span><span class="lt__sub">' + sub + "</span></span>"
  const label = esc((w.agentName ? w.agentName + ", " : "") + word + ": " + w.title)
  return href ? '<a class="lt__wk is-' + word + '" href="' + esc(href) + '" title="' + label + '">' + inner + "</a>"
    : '<div class="lt__wk is-' + word + '" title="' + label + '">' + inner + "</div>"
}

/** The workers of one row, as a list under it; "" with none. */
export function ltWorkersHtml(workers: LtWorker[] | undefined, hrefOf: (w: LtWorker) => string, esc: (s: unknown) => string, age: (ms: number) => string): string {
  if (!workers || !workers.length) return ""
  return '<div class="lt__ws" role="group" aria-label="Workers it started">' + workers.map((w) => ltWorkerHtml(w, hrefOf(w), esc, age)).join("") + "</div>"
}
