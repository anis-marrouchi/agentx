// --- The shell's Workflows, as data (#2457) ---
//
// The old Hub's Workflows page (#page=workflows, wall-workflows.client.ts)
// for the React shell: one row per workflow with what starts it in words,
// its agents, project, state and last seven runs; tabs All, Running,
// Failed and Off; a filter box and a project filter. Same reads and writes
// as the old page, nothing new on the server:
//   GET  /api/workflows                      this node's definitions
//   GET  /api/workflows/runs?summary=1       every machine's runs, slim, pages of 100
//   GET  /api/workflows/runs/<id>            one run in full, for its steps
//   GET+PUT /api/workflows/<id>              the on/off switch (state flipped)
//   POST /workflows/<id>/run                 Run… and Run again
//
// Plain data and pure functions, so the tests check them without a browser.

export const WORKFLOWS_URL = "/api/workflows"
export const RUNS_URL = "/api/workflows/runs?summary=1"
/** Read in pages of this many, newest first; at most RUNS_MAX in all. */
export const RUNS_PAGE = 100
export const RUNS_MAX = 500
/** Off this long with no run: "looks stale", as the old page and Jobs. */
export const STALE_DAYS = 30
const DAY = 86_400_000

export interface WfNode { id: string; type: string; config?: Record<string, any> }
export interface Workflow {
  id: string
  title?: string
  description?: string
  project?: string
  state?: "active" | "disabled" | "quarantined" | string
  approval?: unknown
  nodes?: WfNode[]
}
export interface WfHistory { nodeId: string; status: string; note?: string; durationMs?: number }
export interface WfRun {
  id: string
  workflowId: string
  status: "running" | "paused" | "completed" | "failed" | "canceled" | string
  createdAt: string
  updatedAt: string
  homeNode?: string
  entityRef?: { backend?: string }
  history?: WfHistory[]
  pending?: string[]
  context?: Record<string, any>
}

export type WfState = "off" | "held" | "running" | "waiting" | "failed" | "done" | "stopped" | "never"
export type WfTab = "" | "running" | "failed" | "off"
export const WF_TABS: readonly { value: WfTab; label: string }[] = [
  { value: "", label: "All" }, { value: "running", label: "Running" }, { value: "failed", label: "Failed" }, { value: "off", label: "Off" },
]
/** Each state's word and its tone (the shared state set, recipes §9). */
export const WF_STATE: Record<WfState, { word: string; tone: "ok" | "work" | "warn" | "err" | "idle" }> = {
  off: { word: "Off", tone: "idle" }, held: { word: "Held", tone: "warn" }, running: { word: "Running", tone: "work" },
  waiting: { word: "Waiting", tone: "warn" }, failed: { word: "Last run failed", tone: "err" }, done: { word: "Done", tone: "ok" },
  stopped: { word: "Stopped", tone: "idle" }, never: { word: "Never run", tone: "idle" },
}

// --- What starts it, in words ---

const HOOK: Record<string, string> = {
  "on:gitlab-issue": "When a GitLab issue changes", "on:gitlab-mr": "When a GitLab merge request changes",
  "on:gitlab-note": "When someone comments on GitLab", "on:gitlab-pipeline": "When a GitLab pipeline ends",
}
const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
const p2 = (n: number) => String(n).padStart(2, "0")

export function wfTrigger(wf: Workflow): WfNode | null {
  return (wf.nodes ?? []).find((n) => n && /^trigger\./.test(n.type)) ?? null
}
export const wfIsManual = (wf: Workflow) => wfTrigger(wf)?.type === "trigger.manual"

/** A cron spec in words when it is a common one, else the spec itself. */
export function cronWords(spec: unknown): string {
  const f = String(spec ?? "").trim().split(/\s+/)
  if (f.length !== 5) return "On a schedule"
  const every = /^\*\/(\d+)$/.exec(f[0])
  if (every && f.slice(1).join(" ") === "* * * *") return `Every ${every[1]} min`
  if (/^\d+$/.test(f[0]) && f[1] === "*" && f.slice(2).join(" ") === "* * *") return "Every hour"
  if (!/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1]) || f[2] !== "*" || f[3] !== "*") return `On a schedule (${f.join(" ")})`
  const at = ` at ${p2(+f[1])}:${p2(+f[0])}`
  if (f[4] === "*") return "Every day" + at
  if (f[4] === "1-5") return "Weekdays" + at
  if (/^[0-7]$/.test(f[4])) return DAYS[+f[4] % 7] + at
  return `On a schedule (${f.join(" ")})`
}

export function wfStarts(wf: Workflow): string {
  const t = wfTrigger(wf)
  const c = t?.config ?? {}
  if (!t) return "Nothing starts it"
  if (t.type === "trigger.manual") return "Started by hand"
  if (t.type === "trigger.cron") return cronWords(c.spec)
  if (t.type === "trigger.hook") return HOOK[c.event] ?? `When ${String(c.event || "something").replace(/^on:/, "").replace(/-/g, " ")} happens`
  if (t.type === "trigger.form") return "From a form"
  if (t.type === "trigger.poll") return "When something new turns up"
  return "When a message arrives" + (c.source ? " by " + c.source : "")
}

export function wfAgents(wf: Workflow): string[] {
  return [...new Set((wf.nodes ?? []).filter((n) => n?.type === "agent" && n.config?.agentId).map((n) => String(n.config!.agentId)))]
}

/** A step's name from its title or id: read_ticket reads "Read ticket". */
export function stepName(node: WfNode | undefined, id: string): string {
  const s = String(node?.config?.title || node?.config?.label || id || "step").replace(/[_-]+/g, " ").trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function duration(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min` + (s % 60 ? ` ${s % 60} s` : "")
  return `${Math.floor(m / 60)} h` + (m % 60 ? ` ${m % 60} min` : "")
}

// --- Runs and state ---

/** Each workflow's runs, newest first. */
export function runsById(runs: WfRun[]): Map<string, WfRun[]> {
  const out = new Map<string, WfRun[]>()
  for (const r of [...runs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    const list = out.get(r.workflowId)
    if (list) list.push(r)
    else out.set(r.workflowId, [r])
  }
  return out
}

export function wfState(wf: Workflow, runs: WfRun[]): WfState {
  if (wf.state === "disabled") return "off"
  if (wf.state === "quarantined") return "held"
  if (runs.some((r) => r.status === "running")) return "running"
  if (runs.some((r) => r.status === "paused")) return "waiting"
  const last = runs[0]
  if (!last) return "never"
  return last.status === "failed" ? "failed" : last.status === "canceled" ? "stopped" : "done"
}

export function tabOf(st: WfState): WfTab {
  return st === "running" || st === "waiting" ? "running" : st === "failed" ? "failed" : st === "off" || st === "held" ? "off" : ""
}

/** Off and quiet for 30 days. Unknown (null) when the runs read was cut short. */
export function staleWords(wf: Workflow, runs: WfRun[], capped: boolean, now = Date.now()): string | null {
  if (wf.state !== "disabled") return null
  const last = runs[0] ? Date.parse(runs[0].updatedAt) : 0
  if (last && now - last < STALE_DAYS * DAY) return null
  if (!last && capped) return null
  return last ? `no run for ${Math.floor((now - last) / DAY)} days` : "never run"
}

/** A run's state, in the same words as a workflow's. */
export function runState(r: WfRun): WfState {
  return r.status === "running" ? "running" : r.status === "paused" ? "waiting" : r.status === "failed" ? "failed" : r.status === "canceled" ? "stopped" : "done"
}

const failedStep = (h: WfHistory) => h.status === "failed" || h.status === "timeout"
const why = (h: WfHistory, max: number) => (h.note ? String(h.note).replace(/\s+/g, " ").slice(0, max) : h.status === "timeout" ? "it ran out of time" : "it failed")

/** Where a failed run stopped, one line: `stopped at "Write the draft": it ran out of time`. */
export function stopLine(wf: Workflow, run: WfRun | undefined): string {
  const h = [...(run?.history ?? [])].reverse().find(failedStep)
  if (!h) return ""
  const node = wf.nodes?.find((n) => n.id === h.nodeId)
  return `Stopped at "${stepName(node, h.nodeId)}": ${why(h, 140)}`
}

export interface WfStepRow { name: string; who: string; meta: string; state: WfState | "skipped" | "todo" }

/** A run step by step: who did each step, how long it took, where it
 *  stopped; then the steps it is on now or did not reach. */
export function runSteps(wf: Workflow, run: WfRun): WfStepRow[] {
  const nodes = new Map((wf.nodes ?? []).map((n) => [n.id, n]))
  const skip = (t: string) => /^trigger\./.test(t) || t === "end"
  const seen = new Set<string>()
  const rows: WfStepRow[] = (run.history ?? [])
    .filter((h) => !skip(nodes.get(h.nodeId)?.type ?? "") && h.status !== "resumed")
    .map((h) => {
      seen.add(h.nodeId)
      const n = nodes.get(h.nodeId)
      const who = n?.type === "agent" && n.config?.agentId ? String(n.config.agentId) : ""
      if (failedStep(h)) return { name: stepName(n, h.nodeId), who, meta: why(h, 200), state: "failed" }
      if (h.status === "paused") return { name: stepName(n, h.nodeId), who, meta: h.note ? String(h.note).slice(0, 120) : "", state: "waiting" }
      if (h.status === "skipped") return { name: stepName(n, h.nodeId), who, meta: "", state: "skipped" }
      return { name: stepName(n, h.nodeId), who, meta: typeof h.durationMs === "number" ? duration(h.durationMs) : "", state: "done" }
    })
  for (const n of wf.nodes ?? []) {
    if (seen.has(n.id) || skip(n.type)) continue
    const now = run.status === "running" && (run.pending ?? []).includes(n.id)
    rows.push({ name: stepName(n, n.id), who: "", meta: "", state: now ? "running" : "todo" })
  }
  return rows
}

/** How many steps a workflow has (no trigger, no end). */
export const stepCount = (wf: Workflow) => (wf.nodes ?? []).filter((n) => !/^trigger\./.test(n.type) && n.type !== "end").length

// --- Filters, order and the summary line ---

export interface WfFilter { tab: WfTab; q: string; project: string }
/** The "No project" choice of the project filter. */
export const NO_PROJECT = "\u0000none"

export function matches(wf: Workflow, f: WfFilter, st: WfState, skipTab = false): boolean {
  if (f.project && (f.project === NO_PROJECT ? !!wf.project : wf.project !== f.project)) return false
  if (f.q) {
    const hay = [wf.id, wf.title, wf.description, wf.project, wfStarts(wf), ...wfAgents(wf)].join(" ").toLowerCase()
    if (!hay.includes(f.q.toLowerCase())) return false
  }
  return skipTab || !f.tab || tabOf(st) === f.tab
}

/** Failing and running first, then by name: the one to look at leads. */
const RANK: Record<WfState, number> = { failed: 0, held: 1, running: 2, waiting: 2, done: 3, stopped: 3, never: 4, off: 5 }
export function sortRows<T extends { wf: Workflow; state: WfState }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => RANK[a.state] - RANK[b.state] || String(a.wf.title || a.wf.id).localeCompare(String(b.wf.title || b.wf.id)))
}

export function projectsOf(defs: Workflow[]): string[] {
  const list = [...new Set(defs.map((d) => d.project).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b))
  if (list.length && defs.some((d) => !d.project)) list.push(NO_PROJECT)
  return list
}

/** "4 workflows, 3 on · 12 runs this week, 1 failed". */
export function summaryLine(defs: Workflow[], runs: WfRun[], now = Date.now()): string {
  const on = defs.filter((d) => d.state === "active").length
  const week = runs.filter((r) => Date.parse(r.createdAt) >= now - 7 * DAY)
  const failed = week.filter((r) => r.status === "failed").length
  return `${defs.length} ${defs.length === 1 ? "workflow" : "workflows"}, ${on} on · ${week.length} ${week.length === 1 ? "run" : "runs"} this week` + (failed ? `, ${failed} failed` : "")
}

// --- Run… : the trigger's inputs as a form ---

export interface WfField { key: string; label: string; required: boolean; hint?: string; kind: "text" | "number" | "boolean" | "enum"; options?: string[]; initial: string | boolean }

export function runFields(wf: Workflow): WfField[] {
  const sc = wfTrigger(wf)?.config?.inputSchema
  const props: Record<string, any> = sc?.properties ?? {}
  const req: string[] = sc?.required ?? []
  return Object.entries(props).map(([key, p]) => {
    const kind: WfField["kind"] = Array.isArray(p.enum) ? "enum" : p.type === "boolean" ? "boolean" : p.type === "number" || p.type === "integer" ? "number" : "text"
    const d = p.default
    const initial = kind === "boolean" ? d === true || d === "true" : d == null ? "" : typeof d === "object" ? JSON.stringify(d) : String(d)
    return { key, label: p.title || stepName(undefined, key), required: req.includes(key), hint: p.description, kind, options: kind === "enum" ? p.enum.map(String) : undefined, initial }
  })
}

/** The payload from the form and the folded JSON; an error in words when it cannot start. */
export function runPayload(fields: WfField[], values: Record<string, string | boolean>, json: string): { payload: Record<string, unknown> } | { error: string } {
  const payload: Record<string, unknown> = {}
  for (const f of fields) {
    const v = values[f.key] ?? f.initial
    if (v === "" || v == null) continue
    payload[f.key] = f.kind === "number" ? Number(v) : f.kind === "boolean" ? v === true || v === "true" : v
  }
  let extra: unknown
  try { extra = JSON.parse(json.trim() || "{}") } catch (e) { return { error: `The JSON is not valid: ${(e as Error).message}.` } }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return { error: "The JSON is not valid: it must be an object, in { }." }
  Object.assign(payload, extra)
  const missing = fields.filter((f) => f.required && (payload[f.key] === undefined || payload[f.key] === "")).map((f) => f.label)
  return missing.length ? { error: `Fill in ${missing.join(", ")}.` } : { payload }
}

/** One line on what Start the run will do. */
export function runWhat(wf: Workflow): string {
  const agents = wfAgents(wf)
  const who = agents.length ? `${agents.join(", ")} ${agents.length === 1 ? "does" : "do"} the steps` : "The steps run in order"
  const how = wfIsManual(wf) ? "." : `. It normally starts this way: ${wfStarts(wf).toLowerCase()}; this run stands in for that.`
  return who + how + (wf.approval ? " A message to a person waits for your yes in Waiting on you." : "")
}

/** Run again: the last run's input, read from its trigger step. */
export function lastInput(wf: Workflow, run: WfRun | undefined): Record<string, unknown> {
  const t = wfTrigger(wf)
  const out = (t && run?.context?.[t.id]) || run?.context?.trigger
  if (!out || typeof out !== "object") return {}
  return out.event?.payload ?? out
}
