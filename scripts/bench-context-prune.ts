// Benchmark Jev context pruning (#636) on recorded conversations.
//
// For every FRESH turn in the trace store (the only turns that receive the
// history block — a resumed session replays its transcript instead), rebuild
// the history window exactly as SessionStore.buildHistoryContext would have,
// ask the context-prune questions through a real decision backend, and
// report what would have been dropped. Changes no runtime behaviour and
// writes nothing to the daemon's decision store.
//
// Run with (from a checkout, against the daemon's working directory):
//   pnpm exec tsx scripts/bench-context-prune.ts \
//     --root /path/to/daemon/cwd --days 7 --backend typesafe --out /tmp/prune-bench
//
// Cost model, stated because it decides the result:
//   - tokens = characters / 4 (no tokenizer call).
//   - A dropped token on a fresh turn is written to the prompt cache once
//     (cacheCreate rate) and read back on every later model call of that
//     session: the turn's remaining calls (num_turns - 1) and every call of
//     the resumed turns that follow in the same chat until the next fresh
//     turn (cacheRead rate).
//   - Price per agent from agentx.json's model, via CACHE_AWARE_PRICING.
//   - Jev price: --jev-usd-per-mtok (default 0.042, the OpenRouter rate
//     measured on 2026-09-19); output tokens ignored.
//
// "Needed" proxy: a dropped message counts as needed when a distinctive
// token from it (URL, #ref, number of 3+ digits, path or identifier) shows
// up in the agent's reply to that turn but nowhere in what was kept. It is a
// guess; sample.csv is for a person to grade.

import Database from "better-sqlite3"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { registerBuiltinDecisionBackends } from "../src/decisions"
import { getDecisionBackend } from "../src/decisions/backend"
import { CACHE_AWARE_PRICING, TIER2_MULTIPLIER, getModelFamily } from "../src/daemon/token-tracker"
import { DEFAULT_LEAN_CHANNELS } from "../src/agents/session-profile"
import {
  DEFAULT_CONTEXT_PRUNE,
  pruneHistory,
  type ContextPruneSettings,
  type SeatAsker,
} from "../src/agents/context-prune"
import type { SessionMessage } from "../src/agents/sessions"

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.root ?? process.cwd())
const days = Number(args.days ?? 7)
const backendName = args.backend ?? "typesafe"
const outDir = resolve(args.out ?? ".agentx/reports/context-prune-bench")
const limit = Number(args.limit ?? 100000)
const thresholds = (args.thresholds ?? "0.1,0.2,0.3,0.5").split(",").map(Number)
const jevUsdPerMTok = Number(args["jev-usd-per-mtok"] ?? 0.042)
const concurrency = Number(args.concurrency ?? 6)
const settings: ContextPruneSettings = {
  ...DEFAULT_CONTEXT_PRUNE,
  keepLastTurns: Number(args["keep-turns"] ?? DEFAULT_CONTEXT_PRUNE.keepLastTurns),
  threshold: 1, // score everything; thresholds are applied below
  timeoutMs: 15000,
}

interface Trace {
  task_id: string; agent_id: string; channel: string; chat_id: string
  started_at: number; resumed: number; num_turns: number | null
  input_tokens: number | null; output_tokens: number | null
  cache_read_tokens: number | null; cache_create_tokens: number | null
  tier2_input_tokens: number | null; tier2_output_tokens: number | null
  tier2_cache_read_tokens: number | null; tier2_cache_create_tokens: number | null
  original_message: string | null; final_response: string | null
}

const cfg = JSON.parse(readFileSync(resolve(root, "agentx.json"), "utf-8"))
const agentModel = (id: string): string => cfg.agents?.[id]?.model ?? "claude-opus-5"
const price = (id: string) => CACHE_AWARE_PRICING[getModelFamily(agentModel(id))] ?? CACHE_AWARE_PRICING["claude-opus-5"]
const leanChannels = new Set<string>(
  Object.entries(cfg.session?.profileByChannel ?? {})
    .filter(([, p]) => p === "lean").map(([c]) => c)
    .concat(DEFAULT_LEAN_CHANNELS.filter((c) => !(cfg.session?.profileByChannel ?? {})[c])),
)

const db = new Database(resolve(root, ".agentx/db.sqlite"), { readonly: true })
const since = Date.now() - days * 86_400_000
const traces = db.prepare(
  `select task_id, agent_id, channel, chat_id, started_at, resumed, num_turns, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, tier2_input_tokens, tier2_output_tokens,
          tier2_cache_read_tokens, tier2_cache_create_tokens, original_message, final_response
   from task_traces where started_at > ? and resumed is not null order by started_at`,
).all(since) as Trace[]

// Fleet spend over the window, priced the way TokenTracker.calculateCost
// does: tier-2 buckets (a task above 200k context) at TIER2_MULTIPLIER.
let fleetUsd = 0
const isTier2 = (t: Trace) => (t.tier2_cache_read_tokens ?? 0) + (t.tier2_input_tokens ?? 0) + (t.tier2_cache_create_tokens ?? 0) > 0
for (const t of traces) {
  const p = price(t.agent_id)
  fleetUsd += ((t.input_tokens ?? 0) * p.input + (t.output_tokens ?? 0) * p.output +
    (t.cache_read_tokens ?? 0) * p.cacheRead + (t.cache_create_tokens ?? 0) * p.cacheCreate) / 1e6
  fleetUsd += TIER2_MULTIPLIER * ((t.tier2_input_tokens ?? 0) * p.input + (t.tier2_output_tokens ?? 0) * p.output +
    (t.tier2_cache_read_tokens ?? 0) * p.cacheRead + (t.tier2_cache_create_tokens ?? 0) * p.cacheCreate) / 1e6
}

// Cache re-reads per fresh turn: its own remaining calls plus every call of
// the resumed turns in the same chat until the next fresh turn.
const byChat = new Map<string, Trace[]>()
for (const t of traces) {
  const k = `${t.agent_id}|${t.channel}|${t.chat_id}`
  byChat.set(k, [...(byChat.get(k) ?? []), t])
}
// Weighted by TIER2_MULTIPLIER for turns billed at the tier-2 rate.
function reReads(t: Trace): number {
  const chain = byChat.get(`${t.agent_id}|${t.channel}|${t.chat_id}`) ?? []
  const w = (u: Trace) => (isTier2(u) ? TIER2_MULTIPLIER : 1)
  let n = Math.max(0, (t.num_turns ?? 1) - 1) * w(t)
  let after = false
  for (const u of chain) {
    if (u.task_id === t.task_id) { after = true; continue }
    if (!after) continue
    if (u.resumed !== 1) break
    n += Math.max(1, u.num_turns ?? 1) * w(u)
  }
  return n
}

const sessionsDir = resolve(root, ".agentx/sessions")
function loadSession(t: Trace): SessionMessage[] | null {
  const day = new Date(t.started_at).toISOString().slice(0, 10)
  const safe = `${t.agent_id}:${t.channel}:${t.chat_id}:${day}`.replace(/[^a-zA-Z0-9_:-]/g, "_")
  const p = resolve(sessionsDir, `${safe}.json`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf-8")).messages as SessionMessage[] } catch { return null }
}

/** Index of the user message this trace answered: the last user message
 *  stamped at or before the run start (+5 s slack). */
function locate(messages: SessionMessage[], t: Trace): number {
  let idx = -1
  for (let i = 0; i < messages.length; i++) {
    const at = Date.parse(messages[i].timestamp)
    if (at > t.started_at + 5000) break
    if (messages[i].role === "user") idx = i
  }
  return idx
}

function window(all: SessionMessage[]): SessionMessage[] {
  const out: SessionMessage[] = []
  let chars = 0
  for (let i = all.length - 1; i >= 0 && out.length < 30; i--) {
    chars += all[i].content.length
    out.push(all[i])
    if (chars >= 12000) break
  }
  return out.reverse()
}

const DISTINCT = /https?:\/\/\S+|#\d+|\b\d{3,}\b|\b[\w.-]+\/[\w./-]+|\b[a-z]+[A-Z]\w+\b|\b\w+[_-]\w+[_-]?\w*\b/g
function distinctTokens(s: string): Set<string> {
  return new Set((s.match(DISTINCT) ?? []).map((x) => x.toLowerCase()).filter((x) => x.length >= 4))
}

registerBuiltinDecisionBackends({}, {}, cfg.decisions?.backends?.jev ?? {}, cfg.decisions?.backends?.typesafe ?? {})
const backend = getDecisionBackend(backendName)
let jevInTok = 0
const latencies: number[] = []
const ask: SeatAsker = async (state, questions, opts) => {
  const r = await backend.decide({ state, questions, timeoutMs: opts.timeoutMs })
  jevInTok += r.usage?.inputTokens ?? 0
  latencies.push(r.meta?.latencyMs ?? 0)
  return { answers: r.answers as any, callId: null, mode: "active" }
}

interface Row {
  trace: Trace; win: SessionMessage[]; reply: string; reReads: number
  scores: Array<{ index: number; p: number }>; mode: string; latencyMs: number
}

async function main() {
  const eligible = traces.filter((t) => t.resumed === 0 && !leanChannels.has(t.channel)).slice(0, limit)
  const rows: Row[] = []
  let noSession = 0, noMatch = 0
  // Worst case for turns whose history is no longer on disk (sessions are
  // trimmed and compacted): a full 12k-character window, all of it dropped.
  let unmatchedCeilingUsd = 0
  const unmatchedCeiling = (t: Trace) => {
    const p = price(t.agent_id)
    unmatchedCeilingUsd += 3000 * (p.cacheCreate + p.cacheRead * reReads(t)) / 1e6
  }
  const work = eligible.map((t) => async () => {
    const msgs = loadSession(t)
    if (!msgs) { noSession++; unmatchedCeiling(t); return }
    const idx = locate(msgs, t)
    if (idx < 0) { noMatch++; unmatchedCeiling(t); return }
    const win = window(msgs.slice(0, idx + 1))
    const out = await pruneHistory(win, settings, { agentId: t.agent_id, channel: t.channel }, ask)
    const reply = msgs.slice(idx + 1).find((m) => m.role === "agent")?.content ?? t.final_response ?? ""
    rows.push({ trace: t, win, reply, reReads: reReads(t), scores: out.scores, mode: out.mode, latencyMs: out.latencyMs })
  })
  for (let i = 0; i < work.length; i += concurrency) {
    await Promise.all(work.slice(i, i + concurrency).map((f) => f()))
    process.stderr.write(`\r${Math.min(i + concurrency, work.length)}/${work.length}`)
  }
  process.stderr.write("\n")

  const tok = (s: string) => s.length / 4
  const sweep = thresholds.map((th) => {
    let histTok = 0, droppedTok = 0, histUsd = 0, droppedUsd = 0, msgs = 0, dropped = 0, proxyNeeded = 0
    const sample: string[][] = []
    for (const r of rows) {
      const p = price(r.trace.agent_id)
      const perTok = (p.cacheCreate + p.cacheRead * r.reReads) / 1e6
      const drop = new Set(r.scores.filter((s) => Number.isFinite(s.p) && s.p <= th).map((s) => s.index))
      const keptText = r.win.filter((_, i) => !drop.has(i)).map((m) => m.content).join("\n").toLowerCase()
      const replyTokens = distinctTokens(r.reply)
      for (let i = 0; i < r.win.length; i++) {
        const t = tok(r.win[i].content)
        histTok += t; histUsd += t * perTok; msgs++
        if (!drop.has(i)) continue
        dropped++; droppedTok += t; droppedUsd += t * perTok
        const hits = [...distinctTokens(r.win[i].content)].filter((x) => replyTokens.has(x) && !keptText.includes(x))
        if (hits.length) proxyNeeded++
        sample.push([
          r.trace.task_id, r.trace.agent_id, r.trace.channel, String(r.scores.find((s) => s.index === i)?.p.toFixed(3)),
          hits.length ? "proxy-needed" : "", hits.slice(0, 5).join(" "),
          clip(r.win[r.win.length - 1].content, 300), clip(r.win[i].content, 300), clip(r.reply, 400),
        ])
      }
    }
    return { threshold: th, turns: rows.length, messages: msgs, dropped, droppedPct: pct(dropped, msgs),
      historyTokens: Math.round(histTok), droppedTokens: Math.round(droppedTok), droppedTokPct: pct(droppedTok, histTok),
      historyUsd: round(histUsd), savedUsd: Math.round(droppedUsd * 1000) / 1000, proxyNeeded, sample }
  })

  const scored = rows.filter((r) => r.mode === "active")
  const jevUsd = (jevInTok * jevUsdPerMTok) / 1e6
  const sorted = [...latencies].sort((a, b) => a - b)
  const report = {
    window: { days, since: new Date(since).toISOString(), backend: backendName, keepLastTurns: settings.keepLastTurns },
    traces: traces.length,
    freshEligible: eligible.length,
    noSessionFile: noSession, noMatchingMessage: noMatch,
    turnsReplayed: rows.length,
    turnsScored: scored.length,
    turnsSkippedShortHistory: rows.filter((r) => r.mode === "skipped").length,
    turnsFailed: rows.filter((r) => r.mode === "failed").length,
    fleetUsd: round(fleetUsd),
    // Saving if EVERY history message of every fresh turn were dropped.
    ceiling: {
      replayedUsd: round(sweep[0]?.historyUsd ?? 0),
      unmatchedWorstCaseUsd: round(unmatchedCeilingUsd),
      pctOfFleet: pct((sweep[0]?.historyUsd ?? 0) + unmatchedCeilingUsd, fleetUsd),
    },
    jev: { calls: latencies.length, inputTokens: jevInTok, usd: Math.round(jevUsd * 10000) / 10000,
      usdPerCall: latencies.length ? jevUsd / latencies.length : 0,
      p50ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0 },
    sweep: sweep.map(({ sample, ...s }) => ({ ...s, netUsd: Math.round((s.savedUsd - jevUsd) * 1000) / 1000, netPctOfFleet: pct(s.savedUsd - jevUsd, fleetUsd) })),
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2))
  for (const s of sweep) {
    const header = ["task", "agent", "channel", "p_needed", "proxy", "hits", "current", "dropped", "reply"]
    writeFileSync(resolve(outDir, `dropped-${s.threshold}.csv`), [header, ...s.sample].map(csvRow).join("\n"))
  }
  console.log(JSON.stringify(report, null, 2))
}

function clip(s: string, n: number) { return s.length > n ? `${s.slice(0, n)}…` : s }
function pct(a: number, b: number) { return b ? Math.round((a / b) * 1000) / 10 : 0 }
function round(n: number) { return Math.round(n * 100) / 100 }
function csvRow(r: string[]) { return r.map((c) => `"${String(c ?? "").replace(/"/g, '""').replace(/\n/g, " ")}"`).join(",") }
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? ""
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
