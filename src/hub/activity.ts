// --- Activity in the simple shell (#2457) ---
//
// The data side of the Activity pane. The same reads as the old Hub's
// Activity (wall-activity.client.ts, #1429) and the classic /activity page:
// /api/monitor?nodes=1 for the machines, /api/monitor/activity per machine.
// Feed: every run newest first, with its outcome, what started it, time
// and cost, filtered by outcome, agent, project and source. Timeline: the
// lanes a run hangs from in each perspective, laid out by the classic
// page's own buildTimeline. Nothing here writes.
import { apiGet } from "./api"
import { buildHash } from "./router"
import { buildTimeline, type Timeline, type TimelineMark } from "../daemon/activity-timeline"

export type ActivityView = "feed" | "timeline" | "map"
export type ActivityPerspective = "agent" | "client" | "project" | "channel" | "person" | "node"

/** The Feed's periods, as the old Hub's Activity has them. */
export const FEED_HOURS: readonly { value: number; label: string }[] = [
  { value: 24, label: "24 h" }, { value: 168, label: "7 d" }, { value: 720, label: "30 d" },
]

/** The Timeline's and Map's windows, as the classic /activity page has them. */
export const ACTIVITY_HOURS: readonly { value: number; label: string }[] = [
  { value: 6, label: "6h" }, { value: 24, label: "24h" }, { value: 72, label: "3d" }, { value: 168, label: "7d" },
]

export const ACTIVITY_PERSPECTIVES: readonly { value: ActivityPerspective; label: string; icon: string }[] = [
  { value: "agent", label: "Agent", icon: "bot" },
  { value: "client", label: "Client", icon: "user-round" },
  { value: "project", label: "Project", icon: "folder" },
  { value: "channel", label: "Channel", icon: "radio" },
  { value: "person", label: "Person", icon: "user" },
  { value: "node", label: "Node", icon: "server" },
]

export const MARK_WORDS: Readonly<Record<TimelineMark["kind"], string>> = {
  decision: "Decision taken for you", warning: "Warning", recommendation: "Avoidable round trip", later: "For later",
}

/** One run as /api/monitor/activity answers it, with the machine it ran on. */
export interface ActivityRun {
  id: string
  agentId: string
  channel?: string
  chatId?: string
  clientId?: string
  project?: string
  person?: string
  personName?: string
  node?: string
  nodeUrl?: string
  startedAt: number
  durationMs?: number
  costUsd?: number
  status: string
  preview?: string
}

/** The runs of every machine that answered, newest first, and what is
 *  missing from them, in words. */
export interface ActivityData { runs: ActivityRun[]; marks: TimelineMark[]; errors: string[] }

interface MonitorReply { nodes?: { name: string; url: string; ok: boolean }[] }
interface NodeActivity { node?: string; since?: number; runs?: Omit<ActivityRun, "node" | "nodeUrl">[]; marks?: TimelineMark[] }

/** The most runs one machine sends for a window (session-monitor.ts). */
export const ACTIVITY_CAP = 400

export const activityHref = () => buildHash({ page: "home", pane: "activity" })

/** Every machine's runs in the window. A machine that does not answer, sent
 *  only its newest runs or a shorter window is named in `errors`; the
 *  others still show. */
export async function loadActivity(hours: number, get: <T>(path: string) => Promise<T> = apiGet, now = Date.now()): Promise<ActivityData> {
  const mon = await get<MonitorReply>("/api/monitor?nodes=1")
  const all = mon.nodes ?? []
  const nodes = all.filter((n) => n.ok)
  const down = all.filter((n) => !n.ok).map((n) => n.name)
  const out: ActivityData = { runs: [], marks: [], errors: [] }
  const from = now - hours * 3_600_000
  const replies = await Promise.allSettled(nodes.map((n) =>
    get<NodeActivity>("/api/monitor/activity?node=" + encodeURIComponent(n.url) + "&hours=" + hours)))
  replies.forEach((r, i) => {
    if (r.status === "rejected") { down.push(nodes[i].name); return }
    const name = r.value.node || nodes[i].name
    const runs = r.value.runs ?? []
    for (const run of runs) out.runs.push({ ...run, node: name, nodeUrl: nodes[i].url })
    for (const m of r.value.marks ?? []) out.marks.push(m)
    if (runs.length >= ACTIVITY_CAP) out.errors.push(`${name} sent only its newest ${ACTIVITY_CAP} runs of this period.`)
    // A machine older than #1429 keeps its window to seven days.
    if (r.value.since && r.value.since - from > 3_600_000) out.errors.push(`${name} sent only its runs since ${new Date(r.value.since).toLocaleString()}.`)
  })
  if (down.length) out.errors.unshift(down.join(", ") + (down.length === 1 ? " does" : " do") + " not answer: its runs are missing.")
  out.runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return out
}

// --- Feed ---

export type RunResult = "done" | "failed" | "running" | "stopped"
export type RunSource = "jobs" | "workflows" | "wall" | "messages"

export const RESULT_WORDS: Readonly<Record<RunResult, string>> = { done: "Done", failed: "Failed", running: "Running", stopped: "Stopped" }
export const SOURCE_WORDS: readonly { value: RunSource; label: string; from: string }[] = [
  { value: "jobs", label: "Jobs", from: "a job" },
  { value: "workflows", label: "Workflows", from: "a workflow" },
  { value: "wall", label: "Hub posts", from: "a post on the Hub" },
  { value: "messages", label: "Messages", from: "a message" },
]

/** A trace's status as an outcome: ok, error or timeout, stopped, in flight. */
export function runResult(status: string): RunResult {
  if (status === "ok" || status === "success") return "done"
  if (status === "error" || status === "timeout" || status === "failed") return "failed"
  if (status === "stopped" || status === "canceled") return "stopped"
  return "running"
}

/** What started a run, from its channel. */
export function runSource(r: Pick<ActivityRun, "channel" | "agentId">): RunSource {
  const ch = r.channel || ""
  if (ch === "cron") return "jobs"
  if (ch.startsWith("workflow") || r.agentId.startsWith("workflow:")) return "workflows"
  if (ch === "wall") return "wall"
  return "messages"
}

/** "from a job", "from a message on telegram, by Dana". */
export function runFrom(r: ActivityRun): string {
  const s = runSource(r)
  const on = s === "messages" && r.channel ? " on " + r.channel : ""
  return "from " + SOURCE_WORDS.find((k) => k.value === s)!.from + on + (r.person ? ", by " + (r.personName || r.person) : "")
}

/** How long a run took; still running, how long so far. */
export function runTook(r: ActivityRun, now = Date.now()): string {
  if (r.durationMs != null) return fmtDur(r.durationMs)
  return runResult(r.status) === "running" && r.startedAt ? fmtDur(now - r.startedAt) + " so far" : "–"
}

export const fmtCost = (usd?: number) => (typeof usd === "number" ? "$" + usd.toFixed(usd < 1 ? 3 : 2) : "–")

/** The run's Task page, as the old Hub's Activity opens it. */
export function runHref(r: ActivityRun): string {
  return buildHash({
    page: "task", task: r.id, agent: r.agentId, node: r.nodeUrl, ch: r.channel,
    ask: (r.preview || "").slice(0, 400), at: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    done: runResult(r.status) === "running" ? null : "1",
  })
}

/** The Feed's filters. `project` "-" is "no project". */
export interface FeedFilter { result: RunResult | ""; agent: string; project: string; source: RunSource | "" }
export const NO_PROJECT = "-"
export const EMPTY_FILTER: FeedFilter = { result: "", agent: "", project: "", source: "" }

/** Does a run pass the filters? `skip` leaves one out (for the tab counts). */
export function feedMatch(r: ActivityRun, f: FeedFilter, skip?: keyof FeedFilter): boolean {
  if (f.agent && r.agentId !== f.agent) return false
  if (f.project && (f.project === NO_PROJECT ? !!r.project : r.project !== f.project)) return false
  if (f.source && runSource(r) !== f.source) return false
  if (skip !== "result" && f.result && runResult(r.status) !== f.result) return false
  return true
}

/** The choices the filters offer, from the runs read. */
export function feedChoices(runs: ActivityRun[]): { agents: string[]; projects: string[] } {
  const agents = [...new Set(runs.map((r) => r.agentId))].sort()
  const projects = [...new Set(runs.map((r) => r.project).filter((p): p is string => !!p))].sort()
  if (runs.some((r) => !r.project)) projects.push(NO_PROJECT)
  return { agents, projects }
}

/** The line above the list: how many, how many failed, agent time, cost. */
export function feedSummary(shown: ActivityRun[], total: number, period: string): string {
  const failed = shown.filter((r) => runResult(r.status) === "failed").length
  const time = shown.reduce((a, r) => a + (r.durationMs || 0), 0)
  const priced = shown.filter((r) => typeof r.costUsd === "number")
  const cost = priced.reduce((a, r) => a + (r.costUsd as number), 0)
  return shown.length + (shown.length === 1 ? " run" : " runs") + (failed ? ", " + failed + " failed" : "") +
    " in the last " + period + (shown.length !== total ? " (of " + total + ")" : "") + " · " + fmtDur(time) + " of agent time" +
    (priced.length ? " · " + fmtCost(cost) + (priced.length < shown.length ? " (" + (shown.length - priced.length) + " unpriced)" : "") : "")
}

/** The lane a run hangs from. Only this changes between perspectives: the
 *  runs are already loaded, so switching never reads again. */
export function laneOf(r: ActivityRun, p: ActivityPerspective): { key: string; label: string; sub: string } {
  switch (p) {
    case "agent": return { key: r.agentId + "|" + (r.channel || ""), label: r.agentId, sub: r.channel || "" }
    case "client": return { key: r.clientId || "unmapped", label: r.clientId || "unmapped", sub: "" }
    case "project": return { key: r.project || "(" + (r.channel || "none") + ")", label: r.project || "no project", sub: r.channel || "" }
    case "channel": return { key: r.channel || "none", label: r.channel || "none", sub: "" }
    case "person": return r.person ? { key: "p:" + r.person, label: r.personName || r.person, sub: "" } : { key: "-", label: "no known person", sub: "" }
    default: return { key: r.node || "this node", label: r.node || "this node", sub: "" }
  }
}

export function activityTimeline(data: ActivityData, p: ActivityPerspective): Timeline {
  return buildTimeline(data.runs.map((r) => {
    const l = laneOf(r, p)
    return { id: r.id, laneKey: l.key, laneLabel: l.label, laneSub: l.sub, startedAt: r.startedAt, durationMs: r.durationMs || 0, status: r.status, label: r.preview || "" }
  }), data.marks)
}

export function fmtDur(ms: number): string {
  if (!ms) return "0s"
  if (ms < 1000) return ms + "ms"
  const s = Math.round(ms / 1000)
  if (s < 60) return s + "s"
  return Math.floor(s / 60) + "m " + (s % 60) + "s"
}

export function fmtGap(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return m + "m"
  return Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "")
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** The run's bar look: failed, canceled, running or done. */
export function runTone(status: string): "failed" | "canceled" | "running" | "done" {
  return status === "failed" ? "failed" : status === "canceled" ? "canceled" : status === "running" || status === "in-flight" ? "running" : "done"
}
