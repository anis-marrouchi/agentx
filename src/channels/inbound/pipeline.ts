import type { InboundEnvelope } from "./envelope"
import type { DaemonConfig } from "@/daemon/config"
import type { HandoverStore } from "../handover-store"
import type { AgentRegistry } from "@/agents/registry"

// --- Routing pipeline ---
//
// Replaces the 7-branch resolveAgent() switch in router.ts with a fixed,
// declarative ordering of named stages. Each stage runs in turn; the first
// non-`pass` decision wins. The pipeline emits exactly one trace line per
// envelope (in the router's traceRoute) so every drop has a reason and
// every match names which stage decided.
//
// The order is the contract — matches what resolveAgent did before plus
// two new stages (self-reply-guard, bot-policy) extracted from logic that
// was previously inlined and Telegram-specific.
//
// Order:
//   1.  self-reply-guard — drop messages we sent ourselves (any channel).
//   2.  handover         — operator runtime override wins over config.
//   3.  adapter-resolved — channels that pre-resolve in the adapter
//                          (GitLab agentMappings, WhatsApp routes).
//   4.  dm-binding       — non-group channels route to the bound agent.
//   5.  bot-policy       — set atMentionsOnly when sender is a bot.
//   6.  mention          — find a match via registry.findByMention.
//   7.  fallback-binding — chat platforms: fall back to the account's
//                          bound agent when nothing else matched.

export type StageDecision =
  | { kind: "match"; agentId: string }
  | { kind: "drop"; reason: string }
  | { kind: "pass" }

export interface StageContext {
  config: DaemonConfig
  registry: AgentRegistry
  handoverStore: HandoverStore
  /** Set by `bot-policy` and read by `mention` — sender is a bot, so only
   *  explicit `@`-prefixed mentions count. Mutable across stages. */
  atMentionsOnly: boolean
  /** Surfaced trace lines for every stage that ran. The last entry is
   *  always the deciding stage. Useful for tests. */
  trace: Array<{ stage: string; decision: StageDecision }>
}

export interface Stage {
  readonly name: string
  run(env: InboundEnvelope, ctx: StageContext): StageDecision
}

export interface PipelineResult {
  /** The agentId that should handle this envelope, or undefined when
   *  every stage either passed or dropped. */
  agentId?: string
  /** The stage that produced the final decision (match | drop). */
  decidingStage: string
  /** "match" | "drop". */
  kind: "match" | "drop"
  reason: string
  /** Per-stage trace, oldest first. */
  trace: Array<{ stage: string; decision: StageDecision }>
}

export function runPipeline(
  env: InboundEnvelope,
  stages: Stage[],
  baseCtx: Omit<StageContext, "atMentionsOnly" | "trace">,
): PipelineResult {
  const ctx: StageContext = { ...baseCtx, atMentionsOnly: false, trace: [] }
  for (const stage of stages) {
    const decision = stage.run(env, ctx)
    ctx.trace.push({ stage: stage.name, decision })
    if (decision.kind === "match") {
      return {
        agentId: decision.agentId,
        decidingStage: stage.name,
        kind: "match",
        reason: `agent=${decision.agentId}`,
        trace: ctx.trace,
      }
    }
    if (decision.kind === "drop") {
      return {
        decidingStage: stage.name,
        kind: "drop",
        reason: decision.reason,
        trace: ctx.trace,
      }
    }
  }
  // Every stage passed — fallthrough is a drop.
  return {
    decidingStage: "fallthrough",
    kind: "drop",
    reason: "no stage matched",
    trace: ctx.trace,
  }
}
