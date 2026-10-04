// --- Context pruning (issue #636) ---
//
// Before a fresh session's history block is rendered, ask the
// `context-prune` seat which earlier messages the current one needs, and
// drop the rest. Off by default: the seat's mode (decisions.seats or
// AGENTX_DECISION_SEAT_CONTEXT_PRUNE) decides — `shadow` scores and
// records but drops nothing, `active` drops.
//
// The floor is never sent to the model and never dropped:
//   - the current message and the last `keepLastTurns` user turns (with
//     every message after the first of them),
//   - any message matching one of `keepPatterns` (approvals, instructions,
//     pinned facts by default).
// The system prompt, memory and continuity memo are separate prompt
// layers and never pass through here.
//
// Fails open: any error, timeout or missing answer keeps the message.

import type { SessionMessage } from "./sessions"
import { askSeat, recordSeatOutcome, type SeatResult } from "@/decisions/seat"
import {
  CONTEXT_PRUNE_SEAT,
  contextPruneQuestions,
  contextPruneState,
  neededProbability,
  type ContextPruneCandidate,
} from "@/decisions/seats/context-prune"
import type { Questions } from "@/decisions/types"

export interface ContextPruneSettings {
  /** Drop a message when P(needed) is at or below this. */
  threshold: number
  /** Most recent user turns always kept, with everything after them. */
  keepLastTurns: number
  /** Case-insensitive regexes; a matching message is always kept. */
  keepPatterns: string[]
  /** Skip the call when fewer candidates than this remain after the floor. */
  minCandidates: number
  /** Backend override; unset uses the seat's, then decisions.defaultBackend. */
  backend?: string
  timeoutMs: number
}

export const DEFAULT_KEEP_PATTERNS = [
  "\\b(approved?|approval|go ahead|green light|confirmed?|lgtm)\\b",
  "\\b(always|never|from now on|do not|don't|must|make sure|remember)\\b",
  "\\b(pinned?|note that|for the record|keep in mind)\\b",
]

export const DEFAULT_CONTEXT_PRUNE: ContextPruneSettings = {
  threshold: 0.2,
  keepLastTurns: 2,
  keepPatterns: DEFAULT_KEEP_PATTERNS,
  minCandidates: 3,
  timeoutMs: 4000,
}

/** Config, with AGENTX_CONTEXT_PRUNE_* environment overrides on top so an
 *  operator can tune one process without editing agentx.json. */
export function resolveContextPruneSettings(
  cfg: Partial<ContextPruneSettings> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ContextPruneSettings {
  const defined = Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined))
  const s: ContextPruneSettings = { ...DEFAULT_CONTEXT_PRUNE, ...defined }
  const num = (v: string | undefined) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined)
  s.threshold = num(env.AGENTX_CONTEXT_PRUNE_THRESHOLD) ?? s.threshold
  s.keepLastTurns = num(env.AGENTX_CONTEXT_PRUNE_KEEP_TURNS) ?? s.keepLastTurns
  s.backend = env.AGENTX_CONTEXT_PRUNE_BACKEND?.trim() || s.backend
  return s
}

export interface FloorSplit {
  /** Indices of messages that are always kept. */
  floor: Set<number>
  /** Indices the seat is asked about. */
  candidates: number[]
}

/** Split a history window into the floor and the candidates. Pure. */
export function splitFloor(messages: SessionMessage[], settings: ContextPruneSettings): FloorSplit {
  const floor = new Set<number>()
  // Walk back to the start of the Nth most recent user turn. The last
  // message is the current one, so it always counts as a user turn even
  // when the channel recorded it otherwise.
  let turns = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    start = i
    if (messages[i].role === "user" || i === messages.length - 1) {
      turns++
      if (turns >= Math.max(1, settings.keepLastTurns + 1)) break
    }
  }
  for (let i = start; i < messages.length; i++) floor.add(i)

  const patterns = compilePatterns(settings.keepPatterns)
  const candidates: number[] = []
  for (let i = 0; i < start; i++) {
    if (patterns.some((re) => re.test(messages[i].content))) floor.add(i)
    else candidates.push(i)
  }
  return { floor, candidates }
}

export interface PruneOutcome {
  /** Messages to render, in their original order. */
  messages: SessionMessage[]
  dropped: number
  candidates: number
  /** True when the seat answered (shadow or active). */
  scored: boolean
  mode: "off" | "shadow" | "active" | "skipped" | "failed"
  latencyMs: number
  /** P(needed) per candidate index, for logs and the benchmark. */
  scores: Array<{ index: number; p: number; dropped: boolean }>
}

export type SeatAsker = (
  state: ReturnType<typeof contextPruneState>,
  questions: Questions,
  opts: { timeoutMs: number; backend?: string; features: Record<string, string | number | boolean | null> },
) => Promise<SeatResult<Questions> | null>

const defaultAsker: SeatAsker = (state, questions, opts) =>
  askSeat(CONTEXT_PRUNE_SEAT, state, questions, opts)

/** Prune a history window. The last message is the one being answered. */
export async function pruneHistory(
  messages: SessionMessage[],
  settings: ContextPruneSettings,
  ctx: { agentId: string; channel: string },
  ask: SeatAsker = defaultAsker,
): Promise<PruneOutcome> {
  const started = Date.now()
  const keepAll = (mode: PruneOutcome["mode"], candidates = 0): PruneOutcome => ({
    messages, dropped: 0, candidates, scored: false, mode, latencyMs: Date.now() - started, scores: [],
  })
  if (messages.length < 2) return keepAll("skipped")

  const { candidates } = splitFloor(messages, settings)
  if (candidates.length < settings.minCandidates) return keepAll("skipped", candidates.length)

  const current = messages[messages.length - 1]
  const candidateMsgs: ContextPruneCandidate[] = candidates.map((i) => ({
    key: `m${i}`,
    name: messages[i].name || messages[i].role,
    content: messages[i].content,
  }))
  const kept = messages
    .slice(0, -1)
    .filter((_, i) => !candidates.includes(i))
    .map((m) => ({ name: m.name || m.role, content: m.content }))

  const result = await ask(
    contextPruneState({ current: current.content, kept, candidates: candidateMsgs }),
    contextPruneQuestions(candidateMsgs),
    {
      timeoutMs: settings.timeoutMs,
      backend: settings.backend,
      features: { agent: ctx.agentId, channel: ctx.channel, candidates: candidates.length },
    },
  ).catch(() => null)
  if (!result) return keepAll("failed", candidates.length)

  const drop = new Set<number>()
  const scores: PruneOutcome["scores"] = []
  for (const i of candidates) {
    const p = neededProbability(result.answers, `m${i}`)
    const wouldDrop = Number.isFinite(p) && p <= settings.threshold
    if (wouldDrop) drop.add(i)
    scores.push({ index: i, p, dropped: wouldDrop })
  }

  const active = result.mode === "active"
  // "skip" = messages were left out of the prompt on this answer.
  if (active && drop.size > 0) recordSeatOutcome(result.callId, "skip")
  return {
    messages: active ? messages.filter((_, i) => !drop.has(i)) : messages,
    dropped: active ? drop.size : 0,
    candidates: candidates.length,
    scored: true,
    mode: active ? "active" : "shadow",
    latencyMs: Date.now() - started,
    scores,
  }
}

function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"))
    } catch {
      /* a bad pattern keeps nothing extra; config check reports it */
    }
  }
  return out
}
