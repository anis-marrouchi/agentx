// Fleet Map as a transit map — pure snapshot → lines/trains model, no React.
// Lines are projects, stations are agents, trains are units of work (one
// issue/MR, one hand-off naming a set of MRs, one cron job, or one chat).
// Line status and its reason come from real state: forge pipelines and
// draft MRs (snapshot.forge) plus run outcomes — nothing is hardcoded.

import type { FleetDispatch, FleetSnapshot } from "./api"
import { refKey, refsOf, type ForgeRef } from "../../daemon/activity-graph-attribution"
import type { ForgeItem } from "../../daemon/activity-graph-forge"
import { askOf, chainOf, delegatorOf, hopsOf, originOf, returnHop, trainRoute, type Hop } from "./hops"

import { agentLineOf, isAgentLine, lineOf } from "./transit-lines"

export { delegatorOf, type Hop } from "./hops"
export { agentLineOf, lineOf } from "./transit-lines"

export type TrainState = "delayed" | "running" | "held" | "review" | "delivered" | "done"
export type LineState = "delays" | "good" | "quiet"
export type Tone = "bad" | "warn" | "good" | "live" | "held" | "muted"

export interface TrainItem {
  key: string
  ref: string | null
  title: string
  status: { label: string; tone: Tone }
  url: string | null
  dispatchId: string
}
export interface Train {
  id: string
  lineId: string
  title: string
  /** Pill text on the map: a tag ("!445–!448", "cron") and a short label. */
  tag: string
  label: string
  state: TrainState
  reason: string | null
  /** Channel the work really came from (the root of its hop chain). */
  channel: string
  /** Agent that handed it to `agentId`, if any (route[route.length - 2]). */
  delegator: string | null
  agentId: string
  /** Agents from the origin to `agentId`, in hand-off order. */
  route: string[]
  /** Every hop behind this train's runs, oldest first; answers coming back
   *  from a delegation are `return` hops. */
  hops: Hop[]
  /** The run the work started with, when it is in the window. */
  originId: string | null
  startedBy: string
  startedAt: number
  lastAt: number
  items: TrainItem[]
  dispatchIds: string[]
  failedPipelines: string[]
  link: string | null
}
export interface Line {
  id: string
  name: string
  code: string
  color: string
  project: string | null
  trains: Train[]
  state: LineState
  reason: string
  counts: Record<TrainState, number>
}
export interface Transit { lines: Line[]; trains: Train[] }

/** The channels an operator expects on the left, in board order. */
export const CHANNELS: Array<{ id: string; label: string }> = [
  { id: "voice", label: "Voice" },
  { id: "app", label: "Phone app" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "telegram", label: "Telegram" },
  { id: "desktop", label: "Desktop" },
  { id: "api", label: "Web API" },
  { id: "cron", label: "Cron" },
  { id: "gitlab", label: "GitLab" },
  { id: "github", label: "GitHub" },
  { id: "mesh", label: "Mesh (A2A)" },
]
const MESH_CHANNELS = new Set(["mesh", "a2a", "mcp"])
export function mapChannelId(channelId: string): string {
  return MESH_CHANNELS.has(channelId) ? "mesh" : channelId === "workflow" ? "cron" : channelId
}
export function channelLabel(id: string): string {
  return CHANNELS.find((c) => c.id === id)?.label ?? id
}

const PALETTE = ["#2979FF", "#FFB300", "#22B573", "#F23A3A", "#8E5CF7", "#00A3A3", "#E8710A", "#D63384"]

const refLabel = (r: ForgeRef) => `${r.kind === "mr" ? "!" : "#"}${r.n}`

function refsTag(refs: ForgeRef[]): string {
  if (refs.length === 1) return refLabel(refs[0])
  const ns = refs.map((r) => r.n).sort((a, b) => a - b)
  const run = ns.every((n, i) => i === 0 || n === ns[i - 1] + 1)
  return run ? `!${ns[0]}–!${ns[ns.length - 1]}` : ns.slice(0, 3).map((n) => `!${n}`).join(", ") + (ns.length > 3 ? "…" : "")
}

/** First meaningful line of a dispatch: the webhook header is dropped. */
export function gist(d: FleetDispatch): string {
  const text = d.inputPreview.replace(/^\s*\[[^\]]*\]:?\s*/, "").split("\n").find((l) => l.trim()) ?? ""
  const s = (text.trim() || d.subject).replace(/\s+/g, " ")
  return s.length > 72 ? s.slice(0, 71) + "…" : s
}

function trainKey(d: FleetDispatch, lineId: string, refs: ForgeRef[]): string {
  if (refs.length) return `${lineId}|${refs.map((r) => refKey(d.projectId, r)).sort().join(",")}`
  if (d.channelId === "cron" || d.initiatorKind === "cron") return `${lineId}|cron|${d.subject}`
  return `${lineId}|${d.agentId}|${delegatorOf(d) ?? mapChannelId(d.channelId)}|${d.initiatorId}`
}

function itemStatus(f: ForgeItem | undefined): { label: string; tone: Tone } {
  if (!f) return { label: "No status", tone: "muted" }
  if (f.kind === "issue") return f.state === "closed" ? { label: "Closed", tone: "good" } : { label: "Open", tone: "muted" }
  if (f.state === "merged") return { label: "Merged", tone: "good" }
  if (f.state === "closed") return { label: "Closed", tone: "muted" }
  if (f.pipeline?.status === "failed") return { label: "Build failed", tone: "bad" }
  if (f.draft) return { label: "Held · draft", tone: "held" }
  const p = f.pipeline?.status
  if (p === "running") return { label: "Building", tone: "live" }
  if (p === "pending" || p === "created" || p === "waiting_for_resource" || p === "preparing") return { label: "Build queued", tone: "muted" }
  if (p === "success") return { label: "Build passed", tone: "good" }
  return { label: "In review", tone: "muted" }
}

export function runStatus(d: FleetDispatch): { label: string; tone: Tone } {
  if (d.active) return { label: "Running", tone: "live" }
  if (d.outcome === "error") return { label: "Errored", tone: "bad" }
  return { label: "Done", tone: "good" }
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`

/** Chains resolve against every run in the window, so a filter (active
 *  only, search) never cuts a train off from where it came from. */
interface Ctx { pool: FleetDispatch[]; asks: Map<string, FleetDispatch> }

function buildTrain(id: string, lineId: string, ds: FleetDispatch[], snap: FleetSnapshot, ctx: Ctx): Train {
  const byTime = [...ds].sort((a, b) => a.startedAt - b.startedAt)
  const first = byTime[0], last = byTime[byTime.length - 1]
  // A callback turn is the answer coming home: it draws a return hop and
  // leaves the route to the runs that asked.
  const returns = byTime.filter((d) => ctx.asks.has(d.id))
  const asked = byTime.filter((d) => !ctx.asks.has(d.id))
  const chains = (asked.length ? asked : returns.map((d) => ctx.asks.get(d.id)!)).map((d) => chainOf(d, ctx.pool))
  const from = originOf(chains[0])
  const route = trainRoute(chains)
  const hops = [...new Map([...chains.flatMap(hopsOf), ...returns.map(returnHop)].map((h) => [h.dispatchId ?? `root:${h.to}`, h])).values()]
    .sort((a, b) => a.at - b.at)
  const origin = from.dispatch ?? first
  const refs = refsOf(last).length ? refsOf(last) : refsOf(first)
  const forge = snap.forge ?? {}
  const initiator = from.dispatch ? snap.initiators.find((i) => i.id === origin.initiatorId) : undefined
  const isCron = !refs.length && (first.channelId === "cron" || first.initiatorKind === "cron")

  let items: TrainItem[]
  if (refs.length) {
    items = refs.map((r) => {
      const key = refKey(last.projectId, r)
      const f = forge[key]
      return { key, ref: refLabel(r), title: f?.title || gist(last), status: itemStatus(f), url: f?.url || null, dispatchId: last.id }
    })
  } else {
    items = [...byTime].reverse().slice(0, 8).map((d) => ({
      key: d.id, ref: null, title: gist(d), status: runStatus(d), url: null, dispatchId: d.id,
    }))
  }

  const known = refs.map((r) => forge[refKey(last.projectId, r)]).filter((f): f is ForgeItem => !!f)
  const openMrs = known.filter((f) => f.kind === "mr" && f.state === "opened")
  const failedPipelines = openMrs.filter((f) => f.pipeline?.status === "failed").map((f) => f.pipeline!.url || f.url)
  const errored = last.outcome === "error" && !last.active
  const running = ds.some((d) => d.active)

  let state: TrainState
  let reason: string | null = null
  if (failedPipelines.length) {
    state = "delayed"
    reason = `${plural(failedPipelines.length, "pipeline")} failed`
  } else if (errored) {
    state = "delayed"
    reason = "Last run errored"
  } else if (running) state = "running"
  else if (openMrs.length && openMrs.every((f) => f.draft)) {
    state = "held"
    reason = "Draft MR — parked until marked ready"
  } else if (openMrs.length) state = "review"
  else if (known.length && known.length === refs.length && known.every((f) => f.state !== "opened")) state = "delivered"
  else state = "done"

  const tag = refs.length ? refsTag(refs) : isCron ? "cron" : channelLabel(mapChannelId(first.channelId))
  const oneTitle = refs.length === 1 ? known[0]?.title || gist(last) : null
  const cronName = first.subject.replace(/^cron:/, "")
  const who = initiator?.name || from.sender || origin.initiatorId
  const chat = /^(chat:|dm:)/.test(gist(last)) ? `Chat with ${who}` : gist(last)
  const title = refs.length > 1 ? `MRs ${tag}` : refs.length ? `${tag} ${oneTitle}` : isCron ? cronName : chat
  const label = refs.length > 1 ? plural(refs.length, "MR") : refs.length ? oneTitle! : isCron ? cronName : chat
  const link = items.length === 1 ? items[0].url : null

  return {
    id, lineId, title, tag, label: label.length > 26 ? label.slice(0, 25) + "…" : label, state, reason,
    channel: mapChannelId(from.channel), delegator: route.length > 1 ? route[route.length - 2] : null,
    agentId: route[route.length - 1], route, hops, originId: from.dispatch?.id ?? null,
    startedBy: who, startedAt: first.startedAt,
    lastAt: Math.max(...ds.map((d) => d.resolvedAt ?? d.startedAt)),
    items, dispatchIds: ds.map((d) => d.id), failedPipelines, link,
  }
}

export const STATE_ORDER: TrainState[] = ["delayed", "running", "held", "review", "delivered", "done"]
const byState = (a: Train, b: Train) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.lastAt - a.lastAt

function lineReason(state: LineState, trains: Train[], c: Record<TrainState, number>): string {
  if (state === "quiet") return ""
  const failed = trains.reduce((n, t) => n + t.failedPipelines.length, 0)
  const errored = trains.filter((t) => t.state === "delayed" && !t.failedPipelines.length).length
  const parts: string[] = []
  if (failed) parts.push(`${plural(failed, "pipeline")} failed`)
  if (errored) parts.push(`${plural(errored, "run")} errored`)
  if (state === "good") {
    if (c.running) parts.push(`${c.running} running`)
    if (c.review) parts.push(`${c.review} in review`)
    if (c.delivered) parts.push(`${c.delivered} delivered`)
    if (!parts.length && c.done) parts.push(`${c.done} done`)
  }
  if (c.held) parts.push(`${c.held} held`)
  return parts.slice(0, 3).join(" · ")
}

export function buildTransit(snap: FleetSnapshot, dispatches: FleetDispatch[]): Transit {
  const groups = new Map<string, { lineId: string; ds: FleetDispatch[] }>()
  const meta = new Map<string, ReturnType<typeof lineOf>>()
  const agentById = new Map(snap.agents.map((a) => [a.id, a]))
  const pool = snap.dispatches.length ? snap.dispatches : dispatches
  const asks = new Map<string, FleetDispatch>()
  for (const d of dispatches) {
    const ask = d.callback ? askOf(d, pool) : undefined
    if (ask) asks.set(d.id, ask)
  }
  const lineFor = (d: FleetDispatch) => {
    const line = lineOf(d.projectId)
    return line.id === "unmapped" ? agentLineOf(agentById.get(d.agentId), d.agentId) : line
  }
  for (const d of dispatches) {
    // An answer rides on the train of the run it answers.
    const home = asks.get(d.id) ?? d
    const line = lineFor(home)
    meta.set(line.id, line)
    const key = trainKey(home, line.id, refsOf(home))
    const g = groups.get(key) ?? { lineId: line.id, ds: [] }
    g.ds.push(d)
    groups.set(key, g)
  }
  // Known projects with nothing in the window still show, as quiet lines.
  for (const c of snap.clients) for (const p of c.projects) {
    const line = lineOf(p)
    if (line.id !== "unmapped" && !meta.has(line.id)) meta.set(line.id, line)
  }

  const built = [...groups.entries()].map(([key, g]) => buildTrain(key, g.lineId, g.ds, snap, { pool, asks }))
  // The chat that started a hand-off, and the middle hops of a chain, are
  // already on the route of the train they led to ("Voice › Secretary › …").
  // Don't run them again as trains of their own, unless they carry an issue
  // or MR of their own.
  const upstream = new Set(built.flatMap((t) => {
    const mine = new Set(t.dispatchIds)
    return t.hops.flatMap((h) => (h.dispatchId && h.kind === "ask" && !mine.has(h.dispatchId) ? [h.dispatchId] : []))
  }))
  const folded = (t: Train) => t.dispatchIds.every((id) => upstream.has(id)) && (isAgentLine(t.lineId) || !t.items.some((i) => i.ref))
  const trains = built.filter((t) => !folded(t)).sort(byState)
  // Projects take the first colours; agent lines follow.
  const ids = [...meta.keys()].sort((a, b) => Number(isAgentLine(a)) - Number(isAgentLine(b)) || a.localeCompare(b))
  const lines: Line[] = [...meta.values()].map((m) => {
    const own = trains.filter((t) => t.lineId === m.id)
    const counts = Object.fromEntries(STATE_ORDER.map((s) => [s, own.filter((t) => t.state === s).length])) as Record<TrainState, number>
    const state: LineState = !own.length ? "quiet" : counts.delayed ? "delays" : "good"
    const color = PALETTE[ids.indexOf(m.id) % PALETTE.length]
    return { ...m, color, trains: own, state, reason: lineReason(state, own, counts), counts }
  })
  const shown = lines.filter((l) => !isAgentLine(l.id) || l.trains.length)
  const rank = (l: Line) => (l.state === "delays" ? 0 : l.state === "good" ? (isAgentLine(l.id) ? 2 : 1) : 3)
  shown.sort((a, b) => rank(a) - rank(b) || b.trains.length - a.trains.length || a.name.localeCompare(b.name))
  return { lines: shown, trains }
}

/** Board headline: "One line delayed", "Good service on all lines", … */
export function headline(lines: Line[]): string {
  const delayed = lines.filter((l) => l.state === "delays").length
  const running = lines.filter((l) => l.state === "good").length
  if (delayed) return delayed === 1 ? "One line delayed" : `${delayed} lines delayed`
  return running ? "Good service on all lines" : "All lines quiet"
}

/** Route chips for a train: channel › every hop agent › line code. */
export function routeOf(t: Train, line: Line | undefined, agentName: (id: string) => string): string[] {
  return [channelLabel(t.channel), ...t.route.map(agentName), line?.code ?? t.lineId]
}

