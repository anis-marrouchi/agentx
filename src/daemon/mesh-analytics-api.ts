import type { ServerResponse } from "http"
import type { MeshAnalytics, CauseId } from "@/storage/mesh-analytics"
import type { DayActivity, DayConversation } from "@/storage/mesh-drill"

// --- Mesh-wide analytics fan-out + merge ------------------------------
//
// Each node answers GET /analytics/mesh for its OWN SQLite. This module
// asks every reachable node in parallel and folds the answers into one
// fleet view. Two rules keep the merge honest:
//
//   1. Aggregates that are genuinely fleet-wide (day columns, failure
//      causes, origin reliability, rotations) are summed.
//   2. Anything an operator would act on — a job, a thread — stays
//      attributed to the node that owns it, because "disable this cron"
//      is a per-node action. Merging those would invent a fleet object
//      that nobody can actually operate.
//
// A node that fails to answer is reported, never silently dropped: a
// partial fleet must look partial (CLAUDE.md — "support unreachable
// nodes and partial fleet failures").

export interface NodeTarget { name: string; url: string; token?: string }

export interface MergedAnalytics {
  generatedAt: number
  windowDays: number
  nodes: Array<{ name: string; url: string; ok: boolean; error?: string; runs: number }>
  totals: MeshAnalytics["totals"]
  days: MeshAnalytics["days"]
  origins: MeshAnalytics["origins"]
  causes: MeshAnalytics["causes"]
  jobs: Array<MeshAnalytics["jobs"][number] & { node: string; nodeUrl: string }>
  threads: Array<MeshAnalytics["threads"][number] & { node: string; nodeUrl: string }>
  rotations: MeshAnalytics["rotations"]
  retention: MeshAnalytics["retention"]
}

export interface AnalyticsQuery { days: number; tzOffsetMinutes: number; limit: number }

export async function fetchMeshAnalytics(
  nodes: NodeTarget[],
  q: AnalyticsQuery,
  timeoutMs = 6000,
): Promise<MergedAnalytics> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const qs = `?days=${q.days}&tzOffset=${q.tzOffsetMinutes}&limit=${q.limit}`
  let results: Array<{ node: NodeTarget; data?: MeshAnalytics; error?: string }>
  try {
    results = await Promise.all(nodes.map(async (node) => {
      const headers: Record<string, string> = { Accept: "application/json" }
      if (node.token) headers["Authorization"] = `Bearer ${node.token}`
      try {
        const r = await fetch(node.url + "/analytics/mesh" + qs, { headers, signal: ac.signal })
        if (!r.ok) return { node, error: `HTTP ${r.status}` }
        return { node, data: (await r.json()) as MeshAnalytics }
      } catch (e: any) {
        return { node, error: e?.name === "AbortError" ? "timeout" : (e?.message || "unreachable") }
      }
    }))
  } finally { clearTimeout(timer) }
  return mergeMeshAnalytics(results, q.days)
}

export function mergeMeshAnalytics(
  results: Array<{ node: NodeTarget; data?: MeshAnalytics; error?: string }>,
  windowDays: number,
): MergedAnalytics {
  const totals = { runs: 0, errors: 0, hours: 0, agents: 0, threads: 0 }
  const days = new Map<string, MeshAnalytics["days"][number]>()
  const origins = new Map<string, { channel: string; runs: number; errors: number; hours: number }>()
  const causes = new Map<CauseId, { cause: CauseId; count: number; agents: string[]; example: string }>()
  const rotReasons = new Map<string, number>()
  const jobs: MergedAnalytics["jobs"] = []
  const threads: MergedAnalytics["threads"] = []
  let rotTotal = 0, rotTokSum = 0, rotTokN = 0, rotMax = 0
  let traces = 0, withSteps = 0

  for (const { node, data } of results) {
    if (!data) continue
    totals.runs += data.totals.runs
    totals.errors += data.totals.errors
    totals.hours += data.totals.hours
    totals.agents += data.totals.agents
    totals.threads += data.totals.threads

    for (const d of data.days) {
      const cur = days.get(d.day) || { day: d.day, cron: [0, 0], workflow: [0, 0], direct: [0, 0] }
      for (const k of ["cron", "workflow", "direct"] as const) {
        cur[k][0] += d[k]?.[0] || 0
        cur[k][1] += d[k]?.[1] || 0
      }
      days.set(d.day, cur)
    }
    for (const o of data.origins) {
      const cur = origins.get(o.channel) || { channel: o.channel, runs: 0, errors: 0, hours: 0 }
      cur.runs += o.runs; cur.errors += o.errors; cur.hours += o.hours
      origins.set(o.channel, cur)
    }
    for (const c of data.causes) {
      const cur = causes.get(c.cause) || { cause: c.cause, count: 0, agents: [], example: "" }
      cur.count += c.count
      for (const a of c.agents) if (!cur.agents.includes(a)) cur.agents.push(a)
      if (!cur.example) cur.example = c.example
      causes.set(c.cause, cur)
    }
    for (const r of data.rotations.byReason) rotReasons.set(r.reason, (rotReasons.get(r.reason) || 0) + r.count)
    rotTotal += data.rotations.total
    rotTokSum += data.rotations.tokenSum || 0
    rotTokN += data.rotations.tokenSamples || 0
    rotMax = Math.max(rotMax, data.rotations.maxTokens)
    traces += data.retention.traces
    withSteps += data.retention.tracesWithSteps

    for (const j of data.jobs) jobs.push({ ...j, node: node.name, nodeUrl: node.url })
    for (const t of data.threads) threads.push({ ...t, node: node.name, nodeUrl: node.url })
  }

  return {
    generatedAt: Date.now(),
    windowDays,
    nodes: results.map((r) => ({
      name: r.node.name, url: r.node.url, ok: !!r.data,
      error: r.error, runs: r.data?.totals.runs || 0,
    })),
    totals: { ...totals, hours: Math.round(totals.hours * 100) / 100 },
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    origins: [...origins.values()]
      .map((o) => ({ ...o, hours: Math.round(o.hours * 100) / 100 }))
      .sort((a, b) => b.runs - a.runs),
    causes: [...causes.values()].sort((a, b) => b.count - a.count),
    jobs: jobs.sort((a, b) => b.hours - a.hours),
    // Same ordering the node applies: longest-lived first. Sorting the
    // merged list by runs instead would re-rank a fleet view differently
    // from every node view that feeds it.
    threads: threads.sort((a, b) =>
      (b.lastAt - b.firstAt) - (a.lastAt - a.firstAt) || b.runs - a.runs),
    rotations: {
      total: rotTotal,
      byReason: [...rotReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      tokenSum: rotTokSum, tokenSamples: rotTokN, maxTokens: rotMax,
    },
    retention: { traces, tracesWithSteps: withSteps },
  }
}

/** Forward one drill-down read to the node that owns the record. The
 *  dashboard never guesses which node holds a task — the caller passes the
 *  node URL it got from the merged payload, and we check it against the
 *  same allowlist the task proxies use. */
export async function proxyNodeAnalytics(
  res: ServerResponse,
  nodes: NodeTarget[],
  targetUrl: string,
  upstreamPath: string,
): Promise<void> {
  const target = targetUrl.replace(/\/+$/, "")
  const node = nodes.find((n) => n.url.replace(/\/+$/, "") === target)
  if (!node) {
    res.writeHead(403, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "node not in dashboard allowlist", target }))
    return
  }
  const headers: Record<string, string> = { Accept: "application/json" }
  if (node.token) headers["Authorization"] = `Bearer ${node.token}`
  try {
    const r = await fetch(target + upstreamPath, { headers })
    const body = await r.text()
    res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" })
    res.end(body)
  } catch (e: any) {
    res.writeHead(502, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: e?.message || "upstream fetch failed" }))
  }
}


// --- One day, across the fleet ----------------------------------------
//
// Clicking an activity column asks a fleet question, so this fans out the
// same way the window query does. Conversations keep their node, for the
// same reason jobs do: you act on them per node.

export interface MergedDay {
  day: string
  nodes: Array<{ name: string; url: string; ok: boolean; error?: string; runs: number }>
  totals: DayActivity["totals"]
  origins: DayActivity["origins"]
  causes: DayActivity["causes"]
  conversations: Array<DayConversation & { node: string; nodeUrl: string }>
}

export async function fetchMeshDay(
  nodes: NodeTarget[],
  q: { day: string; tzOffsetMinutes: number; limit: number },
  timeoutMs = 6000,
): Promise<MergedDay> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const qs = `?day=${encodeURIComponent(q.day)}&tzOffset=${q.tzOffsetMinutes}&limit=${q.limit}`
  let results: Array<{ node: NodeTarget; data?: DayActivity; error?: string }>
  try {
    results = await Promise.all(nodes.map(async (node) => {
      const headers: Record<string, string> = { Accept: "application/json" }
      if (node.token) headers["Authorization"] = `Bearer ${node.token}`
      try {
        const r = await fetch(node.url + "/analytics/day" + qs, { headers, signal: ac.signal })
        if (!r.ok) return { node, error: `HTTP ${r.status}` }
        return { node, data: (await r.json()) as DayActivity }
      } catch (e: any) {
        return { node, error: e?.name === "AbortError" ? "timeout" : (e?.message || "unreachable") }
      }
    }))
  } finally { clearTimeout(timer) }
  return mergeMeshDay(results, q.day)
}

export function mergeMeshDay(
  results: Array<{ node: NodeTarget; data?: DayActivity; error?: string }>,
  day: string,
): MergedDay {
  const totals = { runs: 0, errors: 0, ms: 0, inputTokens: 0, outputTokens: 0 }
  const origins = new Map<string, { channel: string; runs: number; errors: number; ms: number }>()
  const causes = new Map<CauseId, number>()
  const conversations: MergedDay["conversations"] = []

  for (const { node, data } of results) {
    if (!data) continue
    totals.runs += data.totals.runs
    totals.errors += data.totals.errors
    totals.ms += data.totals.ms
    totals.inputTokens += data.totals.inputTokens
    totals.outputTokens += data.totals.outputTokens
    for (const o of data.origins) {
      const cur = origins.get(o.channel) || { channel: o.channel, runs: 0, errors: 0, ms: 0 }
      cur.runs += o.runs; cur.errors += o.errors; cur.ms += o.ms
      origins.set(o.channel, cur)
    }
    for (const c of data.causes) causes.set(c.cause, (causes.get(c.cause) || 0) + c.count)
    for (const c of data.conversations) conversations.push({ ...c, node: node.name, nodeUrl: node.url })
  }

  return {
    day,
    nodes: results.map((r) => ({
      name: r.node.name, url: r.node.url, ok: !!r.data,
      error: r.error, runs: r.data?.totals.runs || 0,
    })),
    totals,
    origins: [...origins.values()].sort((a, b) => b.runs - a.runs),
    causes: [...causes.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count),
    conversations: conversations.sort((a, b) => b.ms - a.ms || b.turns - a.turns),
  }
}
