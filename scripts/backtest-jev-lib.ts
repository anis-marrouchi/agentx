// Backtest library for the Jev wake gate and model tier (issue #621, steps
// 1-2). The CLI in ./backtest-jev.ts is a thin wrapper; everything that can
// be tested without a network lives here.
//
// WHAT A BACKTEST IS, AND IS NOT.
//
// The daemon's GET /traces lists every task it ran: who asked, on which
// channel, what it cost and how it ended. Replaying those rows through the
// two seats answers one question: had the gate and the tier been active,
// what would they have decided, and what would those decisions have cost
// or saved? Nothing here touches the dispatch path — a backtest changes no
// runtime behaviour, and the seats it asks are not wired into one.
//
// Two things keep the result honest:
//
//   1. The seats only see what was known BEFORE each run (the event text,
//      channel, agent, whether it continued a session). The outcome of the
//      run — status, turns, tokens, the reply — is used only to GRADE the
//      answer afterwards, never shown to the model.
//
//   2. There is no ground truth for "did this event need a run". The
//      closest thing the trace offers is a proxy: a run that finished in a
//      single provider turn (so it used no tool) and wrote a short reply
//      most likely did nothing that mattered, and a run that chained tools
//      or wrote at length most likely did. Every number derived from that
//      is labelled a proxy in the report, and the CSV sample exists so a
//      person can overrule it row by row.

import { askSeat } from "../src/decisions/seat"
import {
  WAKE_GATE_SEAT,
  wakeGateQuestions,
  wakeGateState,
  needsRun as needsRunOf,
  shouldSkipRun,
  SKIP_BELOW,
  type WakeGateAnswers,
} from "../src/decisions/seats/wake-gate"
import {
  TASK_TIER_SEAT,
  taskTierQuestions,
  taskTierState,
  needsFlagship as needsFlagshipOf,
  type TaskTierAnswers,
} from "../src/decisions/seats/task-tier"
import { DOWNGRADE_BELOW, channelKeepsConfiguredModel } from "../src/agents/routing"
import { TokenTracker, type CACHE_AWARE_PRICING } from "../src/daemon/token-tracker"

export type PricingTable = typeof CACHE_AWARE_PRICING

// --- input ----------------------------------------------------------------

/** One row of GET /traces. Only the fields the backtest reads; the export
 *  carries more and they are ignored. */
export interface BacktestTrace {
  taskId: string
  agentId: string
  channel: string | null
  chatId: string | null
  status: string
  model: string | null
  startedAt: number
  finishedAt: number | null
  numTurns: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreateTokens: number | null
  tier2InputTokens: number | null
  tier2OutputTokens: number | null
  tier2CacheReadTokens: number | null
  tier2CacheCreateTokens: number | null
  resumed: boolean | null
  messagePreview: string | null
  originalMessage: string | null
}

/**
 * Accept what GET /traces returns (`{ traces: [...] }`), a bare array of
 * rows, or an array of such responses concatenated by hand. Rows still in
 * flight have no outcome and are dropped; duplicates (the same task in two
 * exports) are kept once.
 */
export function parseTraceExport(raw: unknown): BacktestTrace[] {
  const rows: unknown[] = []
  const collect = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) collect(item)
    } else if (v && typeof v === "object" && Array.isArray((v as any).traces)) {
      for (const item of (v as any).traces) rows.push(item)
    } else if (v && typeof v === "object" && typeof (v as any).taskId === "string") {
      rows.push(v)
    }
  }
  collect(raw)

  const seen = new Set<string>()
  const out: BacktestTrace[] = []
  for (const r of rows as Array<Record<string, unknown>>) {
    const taskId = str(r.taskId)
    const agentId = str(r.agentId)
    if (!taskId || !agentId || seen.has(taskId)) continue
    const status = str(r.status) ?? "unknown"
    if (status === "in-flight") continue
    seen.add(taskId)
    out.push({
      taskId,
      agentId,
      channel: str(r.channel),
      chatId: str(r.chatId),
      status,
      model: str(r.model),
      startedAt: num(r.startedAt) ?? 0,
      finishedAt: num(r.finishedAt),
      numTurns: num(r.numTurns),
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      cacheReadTokens: num(r.cacheReadTokens),
      cacheCreateTokens: num(r.cacheCreateTokens),
      tier2InputTokens: num(r.tier2InputTokens),
      tier2OutputTokens: num(r.tier2OutputTokens),
      tier2CacheReadTokens: num(r.tier2CacheReadTokens),
      tier2CacheCreateTokens: num(r.tier2CacheCreateTokens),
      resumed: typeof r.resumed === "boolean" ? r.resumed : r.resumed === 1 ? true : r.resumed === 0 ? false : null,
      messagePreview: str(r.messagePreview),
      originalMessage: str(r.originalMessage),
    })
  }
  out.sort((a, b) => a.startedAt - b.startedAt)
  return out
}

/**
 * A `workflow` row that recorded no tokens. The workflow dispatcher writes
 * one trace per non-agent step (transform, branch, signal, action) so the
 * trace list can show a whole run; no agent ran for those and nothing was
 * spent. Replaying them through the gate inflates the skip count with rows
 * that could never have saved anything (#626), so they are dropped before
 * any seat is asked. A workflow step that did run an agent records tokens
 * and stays.
 */
export function isZeroCostWorkflowRow(t: BacktestTrace): boolean {
  if (t.channel !== "workflow") return false
  const tokens =
    (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheReadTokens ?? 0) + (t.cacheCreateTokens ?? 0) +
    (t.tier2InputTokens ?? 0) + (t.tier2OutputTokens ?? 0) + (t.tier2CacheReadTokens ?? 0) + (t.tier2CacheCreateTokens ?? 0)
  return tokens === 0
}

/** Split an export into the rows worth replaying and the zero-cost
 *  workflow rows (see isZeroCostWorkflowRow). The count of the latter goes
 *  into the report so a reader can see what was left out. */
export function dropZeroCostWorkflowRows(traces: BacktestTrace[]): { kept: BacktestTrace[]; dropped: BacktestTrace[] } {
  const kept: BacktestTrace[] = []
  const dropped: BacktestTrace[] = []
  for (const t of traces) (isZeroCostWorkflowRow(t) ? dropped : kept).push(t)
  return { kept, dropped }
}

// --- ground-truth proxy ---------------------------------------------------

/**
 *   noop     the run used no tool and wrote a short reply. The trace cannot
 *            say whether that reply mattered, but a run that read the event
 *            and said "nothing to do" looks exactly like this.
 *   worked   the run chained tools, or wrote at length. Skipping it would
 *            most likely have lost real work.
 *   unknown  anything else: a run that errored or timed out before it
 *            could show what it would do, a row with no turn count, or a
 *            short run on the boundary.
 */
export type ProxyLabel = "noop" | "worked" | "unknown"

export interface ProxyOptions {
  /** A run with this many provider turns or fewer used no tool (each tool
   *  call adds a turn). */
  noopMaxTurns: number
  /** …and wrote at most this many output tokens. */
  noopMaxOutputTokens: number
  /** A run with at least this many provider turns did real work. */
  workedMinTurns: number
  /** …or wrote at least this many output tokens. */
  workedMinOutputTokens: number
}

export const DEFAULT_PROXY: ProxyOptions = {
  noopMaxTurns: 1,
  noopMaxOutputTokens: 200,
  workedMinTurns: 3,
  workedMinOutputTokens: 1500,
}

export function proxyLabel(t: BacktestTrace, opts: ProxyOptions = DEFAULT_PROXY): ProxyLabel {
  if (t.status !== "ok") return "unknown"
  const turns = t.numTurns
  const out = t.outputTokens ?? 0
  if (turns == null) return "unknown"
  if (turns <= opts.noopMaxTurns && out <= opts.noopMaxOutputTokens) return "noop"
  if (turns >= opts.workedMinTurns || out >= opts.workedMinOutputTokens) return "worked"
  return "unknown"
}

// --- one verdict per trace ------------------------------------------------

export interface Verdict {
  taskId: string
  agentId: string
  channel: string
  chatId: string | null
  status: string
  startedAt: number
  /** The model the run is priced at, and where that came from. */
  model: string
  modelSource: "trace" | "agent" | "default"
  /** P(this event needs a run); null when the seat did not answer. */
  pNeedsRun: number | null
  /** P(this task needs the flagship); null when not asked or unanswered. */
  pNeedsFlagship: number | null
  /** Why the tier was not consulted, when it was not. Mirrors the rules in
   *  src/agents/routing.ts so the replay cannot promise a downgrade the
   *  live path would refuse. */
  tierBlocked: "channel keeps its model" | "follow-up on a warm cache" | null
  proxy: ProxyLabel
  numTurns: number | null
  outputTokens: number
  totalTokens: number
  /** What the run cost at the list price of its model. */
  costUsd: number
  /** What the same tokens would cost on the cheap model. A proxy: a
   *  smaller model may use more or fewer tokens for the same task. */
  cheapCostUsd: number
  preview: string
  errors: string[]
}

export interface DecideOptions {
  /** Seat settings are read from the decisions runtime; the caller has
   *  configured it (see ./backtest-jev.ts). */
  cheapModel: string
  pricing: PricingTable
  /** Model per agent id, from agentx.json, for rows that did not record one. */
  agentModels?: Record<string, string | undefined>
  /** Priced when neither the row nor the agent names a model. */
  defaultModel: string
  /** How long a cached prefix is assumed to live (routing.ts assumes an hour). */
  cacheTtlMs?: number
  proxy?: ProxyOptions
  concurrency?: number
  timeoutMs?: number
  onProgress?: (done: number, total: number) => void
}

export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000

/**
 * Ask both seats for every trace. Calls go through askSeat, so they are
 * recorded in whatever store the runtime was configured with (or none),
 * and a backend failure yields a null probability rather than an
 * exception: the live path fails open to "run on the flagship", and so
 * does the replay.
 */
export async function decideTraces(traces: BacktestTrace[], opts: DecideOptions): Promise<Verdict[]> {
  const previous = previousInThread(traces)
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const verdicts: Verdict[] = new Array(traces.length)
  let next = 0
  let done = 0

  const worker = async () => {
    while (next < traces.length) {
      const i = next++
      const t = traces[i]
      verdicts[i] = await decideOne(t, previous.get(t.taskId) ?? null, ttl, opts)
      done++
      opts.onProgress?.(done, traces.length)
    }
  }
  const n = Math.max(1, Math.min(opts.concurrency ?? 4, traces.length || 1))
  await Promise.all(Array.from({ length: n }, worker))
  return verdicts
}

async function decideOne(
  t: BacktestTrace,
  prev: BacktestTrace | null,
  cacheTtlMs: number,
  opts: DecideOptions,
): Promise<Verdict> {
  const message = t.originalMessage ?? t.messagePreview ?? ""
  const channel = t.channel ?? "unknown"
  const errors: string[] = []
  const { model, modelSource } = resolveModel(t, opts)
  const continues = t.resumed ?? prev != null

  // Only pre-run facts reach the state. See the header.
  const gate = await askSeat(
    WAKE_GATE_SEAT,
    wakeGateState({ message, agent: t.agentId, channel, continuesExistingSession: continues }),
    wakeGateQuestions,
    {
      incumbent: { needsRun: 1 },
      features: { agent: t.agentId, channel },
      links: [{ kind: "task", id: t.taskId }],
      timeoutMs: opts.timeoutMs,
    },
  )
  if (!gate) errors.push("wake-gate: no answer")
  const pNeedsRun = gate ? needsRunOf(gate.answers as WakeGateAnswers) : null

  let tierBlocked: Verdict["tierBlocked"] = null
  if (channelKeepsConfiguredModel(channel)) tierBlocked = "channel keeps its model"
  else if (continues) {
    const idle = prev ? t.startedAt - (prev.finishedAt ?? prev.startedAt) : 0
    if (idle < cacheTtlMs) tierBlocked = "follow-up on a warm cache"
  }

  let pNeedsFlagship: number | null = null
  if (!tierBlocked) {
    const tier = await askSeat(
      TASK_TIER_SEAT,
      taskTierState({ message, agent: t.agentId, channel, isFollowUp: continues }),
      taskTierQuestions,
      {
        incumbent: { needsFlagship: 1 },
        features: { agent: t.agentId, channel },
        links: [{ kind: "task", id: t.taskId }],
        timeoutMs: opts.timeoutMs,
      },
    )
    if (!tier) errors.push("task-tier: no answer")
    pNeedsFlagship = tier ? needsFlagshipOf(tier.answers as TaskTierAnswers) : null
  }

  const usage = {
    tasks: 1,
    inputTokens: t.inputTokens ?? 0,
    outputTokens: t.outputTokens ?? 0,
    cacheReadTokens: t.cacheReadTokens ?? 0,
    cacheCreateTokens: t.cacheCreateTokens ?? 0,
    tier2InputTokens: t.tier2InputTokens ?? 0,
    tier2OutputTokens: t.tier2OutputTokens ?? 0,
    tier2CacheReadTokens: t.tier2CacheReadTokens ?? 0,
    tier2CacheCreateTokens: t.tier2CacheCreateTokens ?? 0,
    totalDuration: 0,
    errors: 0,
  }
  const totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreateTokens +
    usage.tier2InputTokens + usage.tier2OutputTokens + usage.tier2CacheReadTokens + usage.tier2CacheCreateTokens

  return {
    taskId: t.taskId,
    agentId: t.agentId,
    channel,
    chatId: t.chatId,
    status: t.status,
    startedAt: t.startedAt,
    model,
    modelSource,
    pNeedsRun,
    pNeedsFlagship,
    tierBlocked,
    proxy: proxyLabel(t, opts.proxy),
    numTurns: t.numTurns,
    outputTokens: usage.outputTokens,
    totalTokens,
    costUsd: TokenTracker.calculateCost(usage, model, opts.pricing),
    cheapCostUsd: TokenTracker.calculateCost(usage, opts.cheapModel, opts.pricing),
    preview: oneLine(t.messagePreview ?? message.slice(0, 200)),
    errors,
  }
}

function resolveModel(t: BacktestTrace, opts: DecideOptions): { model: string; modelSource: Verdict["modelSource"] } {
  if (t.model) return { model: t.model, modelSource: "trace" }
  const fromAgent = opts.agentModels?.[t.agentId]
  if (fromAgent) return { model: fromAgent, modelSource: "agent" }
  return { model: opts.defaultModel, modelSource: "default" }
}

/** The run before each one in the same agent/channel/chat thread, so a
 *  follow-up's idle time can be read off the export. */
function previousInThread(traces: BacktestTrace[]): Map<string, BacktestTrace> {
  const last = new Map<string, BacktestTrace>()
  const prev = new Map<string, BacktestTrace>()
  for (const t of [...traces].sort((a, b) => a.startedAt - b.startedAt)) {
    const key = `${t.agentId}|${t.channel ?? ""}|${t.chatId ?? ""}`
    const p = last.get(key)
    if (p) prev.set(t.taskId, p)
    last.set(key, t)
  }
  return prev
}

// --- the policy, replayed at any threshold --------------------------------

export function gateWouldSkip(v: Verdict, skipBelow: number): boolean {
  if (v.pNeedsRun == null) return false
  return shouldSkipRun({ needsRun: { type: "noul", noul: v.pNeedsRun } }, { maxNeedsRun: skipBelow })
}

export function tierWouldDowngrade(v: Verdict, downgradeBelow: number): boolean {
  if (v.tierBlocked || v.pNeedsFlagship == null) return false
  return v.pNeedsFlagship < downgradeBelow
}

/** A run already on a model no dearer than the cheap one saves nothing. */
export function downgradeSaving(v: Verdict): number {
  return Math.max(0, v.costUsd - v.cheapCostUsd)
}

// --- report ---------------------------------------------------------------

export interface GateStats {
  /** Runs the gate would have skipped. */
  skipped: number
  /** …as a share of the runs in this row. */
  share: number
  /** List-price cost of the skipped runs: what would not have been spent. */
  savingUsd: number
  /** PROXY. Skipped runs whose trace says the run did real work. */
  wrongSkips: number
  /** PROXY. Skipped runs whose trace says the run did nothing. */
  rightSkips: number
  /** Skipped runs the proxy cannot grade. */
  unlabelledSkips: number
  /** Runs where the seat gave no answer (fail-open: they would have run). */
  unanswered: number
}

export interface TierStats {
  /** Runs the tier was consulted on (not blocked by channel or warm cache). */
  eligible: number
  blockedChannel: number
  blockedWarmCache: number
  downgraded: number
  /** …as a share of the runs in this row (not of the eligible ones). */
  share: number
  /** PROXY. Cost at the flagship minus cost of the same tokens on the
   *  cheap model, summed over downgraded runs. */
  savingUsd: number
  /** PROXY. Downgraded runs whose trace says the run did real work. */
  riskyDowngrades: number
  /** PROXY. Downgraded runs whose trace says the run did nothing. */
  safeDowngrades: number
  unlabelledDowngrades: number
  unanswered: number
}

export interface ChannelRow {
  channel: string
  runs: number
  costUsd: number
  totalTokens: number
  gate: GateStats
  tier: TierStats
}

export interface SweepRow {
  threshold: number
  count: number
  share: number
  savingUsd: number
  /** PROXY: see GateStats.wrongSkips / TierStats.riskyDowngrades. */
  wrong: number
  right: number
  unlabelled: number
}

export interface BacktestReport {
  generatedAt: string
  backend: string
  thresholds: { skipBelow: number; downgradeBelow: number }
  cheapModel: string
  pricing: { source: string; perMillionTokens: PricingTable }
  cacheTtlMs: number
  proxyRules: ProxyOptions
  traces: {
    total: number
    /** Zero-cost `workflow` rows left out before any seat was asked; not
     *  in `total`. See isZeroCostWorkflowRow. */
    droppedZeroCostWorkflow: number
    unansweredGate: number
    unansweredTier: number
    /** Priced at the agent's configured model or the default, not the
     *  model the run recorded. */
    modelFromAgent: number
    modelFromDefault: number
    byProxy: Record<ProxyLabel, number>
  }
  totals: ChannelRow
  channels: ChannelRow[]
  sweep: { gate: SweepRow[]; tier: SweepRow[] }
  /** Which numbers are proxies, in words, so the JSON is self-describing. */
  proxies: string[]
}

export interface ReportOptions {
  backend: string
  skipBelow?: number
  downgradeBelow?: number
  cheapModel: string
  pricing: PricingTable
  pricingSource: string
  cacheTtlMs?: number
  proxy?: ProxyOptions
  sweep?: number[]
  /** How many zero-cost workflow rows the export held (dropZeroCostWorkflowRows). */
  droppedZeroCostWorkflow?: number
}

export const DEFAULT_SWEEP = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]

export const PROXY_NOTES = [
  "wrongSkips / rightSkips / riskyDowngrades / safeDowngrades come from a proxy, not from a person: a run with no tool use and a short reply counts as 'noop', a run with tool use or a long reply counts as 'worked'. Everything else is unlabelled.",
  "The tier saving assumes the cheap model would have used the same tokens as the flagship did. A smaller model may need more turns, or fewer.",
  "The gate saving is the list-price cost of the runs it would have skipped. It does not include the cost of asking the gate itself, nor any follow-up a wrong skip would have caused.",
  "A follow-up is blocked from the tier when the previous run in the same thread finished less than the cache TTL before it, as the live routing does. The idle time is read off the export, not off the session.",
  "Rows that recorded no model are priced at the agent's configured model, or at the default model when the agent is unknown; the report counts them.",
  "Workflow rows that recorded no tokens (the dispatcher's own step traces: transform, branch, signal, action) are left out before any seat is asked. No agent ran for them, so there was nothing to skip or save. The report counts them under droppedZeroCostWorkflow.",
]

export function buildReport(verdicts: Verdict[], opts: ReportOptions): BacktestReport {
  const skipBelow = opts.skipBelow ?? SKIP_BELOW
  const downgradeBelow = opts.downgradeBelow ?? DOWNGRADE_BELOW
  const byChannel = new Map<string, Verdict[]>()
  for (const v of verdicts) {
    const list = byChannel.get(v.channel) ?? []
    list.push(v)
    byChannel.set(v.channel, list)
  }
  const channels = [...byChannel.entries()]
    .map(([channel, vs]) => channelRow(channel, vs, skipBelow, downgradeBelow))
    .sort((a, b) => b.costUsd - a.costUsd)

  const grid = opts.sweep ?? DEFAULT_SWEEP
  const byProxy: Record<ProxyLabel, number> = { noop: 0, worked: 0, unknown: 0 }
  for (const v of verdicts) byProxy[v.proxy]++

  return {
    generatedAt: new Date().toISOString(),
    backend: opts.backend,
    thresholds: { skipBelow, downgradeBelow },
    cheapModel: opts.cheapModel,
    pricing: { source: opts.pricingSource, perMillionTokens: opts.pricing },
    cacheTtlMs: opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    proxyRules: opts.proxy ?? DEFAULT_PROXY,
    traces: {
      total: verdicts.length,
      droppedZeroCostWorkflow: opts.droppedZeroCostWorkflow ?? 0,
      unansweredGate: verdicts.filter((v) => v.pNeedsRun == null).length,
      unansweredTier: verdicts.filter((v) => !v.tierBlocked && v.pNeedsFlagship == null).length,
      modelFromAgent: verdicts.filter((v) => v.modelSource === "agent").length,
      modelFromDefault: verdicts.filter((v) => v.modelSource === "default").length,
      byProxy,
    },
    totals: channelRow("all", verdicts, skipBelow, downgradeBelow),
    channels,
    sweep: {
      gate: grid.map((th) => sweepRow(verdicts, th, (v) => gateWouldSkip(v, th), (v) => v.costUsd)),
      tier: grid.map((th) => sweepRow(verdicts, th, (v) => tierWouldDowngrade(v, th), downgradeSaving)),
    },
    proxies: PROXY_NOTES,
  }
}

function channelRow(channel: string, vs: Verdict[], skipBelow: number, downgradeBelow: number): ChannelRow {
  const runs = vs.length
  const gate: GateStats = {
    skipped: 0, share: 0, savingUsd: 0, wrongSkips: 0, rightSkips: 0, unlabelledSkips: 0,
    unanswered: vs.filter((v) => v.pNeedsRun == null).length,
  }
  const tier: TierStats = {
    eligible: 0, blockedChannel: 0, blockedWarmCache: 0, downgraded: 0, share: 0, savingUsd: 0,
    riskyDowngrades: 0, safeDowngrades: 0, unlabelledDowngrades: 0, unanswered: 0,
  }
  let costUsd = 0
  let totalTokens = 0
  for (const v of vs) {
    costUsd += v.costUsd
    totalTokens += v.totalTokens
    if (gateWouldSkip(v, skipBelow)) {
      gate.skipped++
      gate.savingUsd += v.costUsd
      if (v.proxy === "worked") gate.wrongSkips++
      else if (v.proxy === "noop") gate.rightSkips++
      else gate.unlabelledSkips++
    }
    if (v.tierBlocked === "channel keeps its model") tier.blockedChannel++
    else if (v.tierBlocked === "follow-up on a warm cache") tier.blockedWarmCache++
    else {
      tier.eligible++
      if (v.pNeedsFlagship == null) tier.unanswered++
    }
    if (tierWouldDowngrade(v, downgradeBelow)) {
      tier.downgraded++
      tier.savingUsd += downgradeSaving(v)
      if (v.proxy === "worked") tier.riskyDowngrades++
      else if (v.proxy === "noop") tier.safeDowngrades++
      else tier.unlabelledDowngrades++
    }
  }
  gate.share = runs ? gate.skipped / runs : 0
  tier.share = runs ? tier.downgraded / runs : 0
  return { channel, runs, costUsd, totalTokens, gate, tier }
}

function sweepRow(
  vs: Verdict[],
  threshold: number,
  acts: (v: Verdict) => boolean,
  saving: (v: Verdict) => number,
): SweepRow {
  const row: SweepRow = { threshold, count: 0, share: 0, savingUsd: 0, wrong: 0, right: 0, unlabelled: 0 }
  for (const v of vs) {
    if (!acts(v)) continue
    row.count++
    row.savingUsd += saving(v)
    if (v.proxy === "worked") row.wrong++
    else if (v.proxy === "noop") row.right++
    else row.unlabelled++
  }
  row.share = vs.length ? row.count / vs.length : 0
  return row
}

// --- the sample a person grades -------------------------------------------

export const SAMPLE_COLUMNS = [
  "kind", "taskId", "agentId", "channel", "status", "startedAt",
  "pNeedsRun", "pNeedsFlagship", "proxyLabel", "numTurns", "outputTokens", "totalTokens",
  "costUsd", "savingUsd", "model", "preview", "humanLabel",
] as const

export interface SampleRow {
  kind: "skipped" | "downgraded"
  verdict: Verdict
  savingUsd: number
}

/**
 * Up to `perKind` skipped and `perKind` downgraded runs, spread evenly over
 * the probability range rather than taken from one end, so the sample
 * shows the confident decisions and the borderline ones alike.
 */
export function sampleRows(
  verdicts: Verdict[],
  opts: { skipBelow: number; downgradeBelow: number; perKind: number },
): SampleRow[] {
  const skipped = verdicts
    .filter((v) => gateWouldSkip(v, opts.skipBelow))
    .sort((a, b) => (a.pNeedsRun ?? 0) - (b.pNeedsRun ?? 0))
    .map((v): SampleRow => ({ kind: "skipped", verdict: v, savingUsd: v.costUsd }))
  const downgraded = verdicts
    .filter((v) => tierWouldDowngrade(v, opts.downgradeBelow))
    .sort((a, b) => (a.pNeedsFlagship ?? 0) - (b.pNeedsFlagship ?? 0))
    .map((v): SampleRow => ({ kind: "downgraded", verdict: v, savingUsd: downgradeSaving(v) }))
  return [...spread(skipped, opts.perKind), ...spread(downgraded, opts.perKind)]
}

function spread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)])
  return out
}

/** The CSV a person opens in a spreadsheet. `humanLabel` is left empty for
 *  them: write `wrong` or `right` per row and the next step of #621 can
 *  grade the proxy against it. The preview is the 200-character message
 *  preview the trace list already carries, never the full message. */
export function toCsv(rows: SampleRow[]): string {
  const lines = [SAMPLE_COLUMNS.join(",")]
  for (const r of rows) {
    const v = r.verdict
    lines.push([
      r.kind, v.taskId, v.agentId, v.channel, v.status, new Date(v.startedAt).toISOString(),
      fmtP(v.pNeedsRun), fmtP(v.pNeedsFlagship), v.proxy, v.numTurns ?? "", v.outputTokens, v.totalTokens,
      v.costUsd.toFixed(4), r.savingUsd.toFixed(4), v.model, v.preview, "",
    ].map(csvCell).join(","))
  }
  return lines.join("\n") + "\n"
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// --- console rendering ----------------------------------------------------

export function renderReport(report: BacktestReport): string {
  const lines: string[] = []
  const line = "─".repeat(100)
  lines.push(line)
  lines.push(`Jev backtest · wake gate (skip below ${report.thresholds.skipBelow}) · model tier (downgrade below ${report.thresholds.downgradeBelow})`)
  lines.push(`backend ${report.backend} · cheap model ${report.cheapModel} · prices: ${report.pricing.source}`)
  lines.push(line)

  const head = [
    pad("channel", 12), padL("runs", 6), padL("cost $", 9),
    padL("skip", 6), padL("skip%", 6), padL("saved $", 9), padL("wrong*", 7), padL("right*", 7),
    padL("down", 6), padL("down%", 6), padL("saved $*", 9), padL("risky*", 7), padL("n/a", 6),
  ].join(" ")
  lines.push(head)
  lines.push("-".repeat(head.length))
  const row = (r: ChannelRow) =>
    [
      pad(r.channel, 12), padL(String(r.runs), 6), padL(r.costUsd.toFixed(2), 9),
      padL(String(r.gate.skipped), 6), padL(pct(r.gate.share), 6), padL(r.gate.savingUsd.toFixed(2), 9),
      padL(String(r.gate.wrongSkips), 7), padL(String(r.gate.rightSkips), 7),
      padL(String(r.tier.downgraded), 6), padL(pct(r.tier.share), 6), padL(r.tier.savingUsd.toFixed(2), 9),
      padL(String(r.tier.riskyDowngrades), 7), padL(String(r.gate.unanswered + r.tier.unanswered), 6),
    ].join(" ")
  for (const r of report.channels) lines.push(row(r))
  lines.push("-".repeat(head.length))
  lines.push(row(report.totals))
  lines.push("")
  lines.push("  skip/down = runs the gate would skip / the tier would move to the cheap model.")
  lines.push("  n/a = seat calls that got no answer (they would have run on the flagship).")
  lines.push("  * = a proxy, not a measurement. See the notes at the end.")

  const sweep = (title: string, rows: SweepRow[], current: number, wrongName: string, rightName: string) => {
    lines.push("")
    lines.push(`  ${title} — the same answers at other thresholds (no extra calls)`)
    lines.push(`  ${pad("threshold", 11)}${padL("count", 7)}${padL("share", 7)}${padL("saved $", 10)}${padL(wrongName, 8)}${padL(rightName, 8)}${padL("unlab.", 8)}`)
    for (const r of rows) {
      const mark = r.threshold === current ? "  <- current" : ""
      lines.push(`  ${pad(String(r.threshold), 11)}${padL(String(r.count), 7)}${padL(pct(r.share), 7)}${padL(r.savingUsd.toFixed(2), 10)}${padL(String(r.wrong), 8)}${padL(String(r.right), 8)}${padL(String(r.unlabelled), 8)}${mark}`)
    }
  }
  sweep("wake gate", report.sweep.gate, report.thresholds.skipBelow, "wrong*", "right*")
  sweep("model tier", report.sweep.tier, report.thresholds.downgradeBelow, "risky*", "safe*")

  lines.push("")
  lines.push(`  traces ${report.traces.total} · proxy noop ${report.traces.byProxy.noop} · worked ${report.traces.byProxy.worked} · unlabelled ${report.traces.byProxy.unknown}`)
  if (report.traces.droppedZeroCostWorkflow > 0) {
    lines.push(`  left out: ${report.traces.droppedZeroCostWorkflow} zero-cost workflow rows (no agent ran, nothing to save)`)
  }
  lines.push(`  priced at the agent's model: ${report.traces.modelFromAgent} · at the default model: ${report.traces.modelFromDefault}`)
  lines.push(`  unanswered: gate ${report.traces.unansweredGate} · tier ${report.traces.unansweredTier}`)
  lines.push("")
  lines.push("  Proxies:")
  for (const p of report.proxies) lines.push(`  - ${p}`)
  lines.push(line)
  return lines.join("\n")
}

// --- small helpers --------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200)
}
function fmtP(p: number | null): string {
  return p == null ? "" : p.toFixed(3)
}
function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`
}
function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n)
}
function padL(s: string, n: number): string {
  return s.padStart(n)
}
