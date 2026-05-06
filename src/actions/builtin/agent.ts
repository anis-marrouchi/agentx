import { z } from "zod"
import { getAgentRegistry } from "@/agents/registry-instance"
import type { BuiltinAction } from "./types"

// --- agent.call ---
//
// Same-node sub-agent delegation, typed and traceable. Counterpart to
// `mesh.delegate`: that one calls a remote peer's agent over HTTP+mesh,
// this one calls a local agent on the same daemon — the common case for
// triage/router patterns where one agent classifies + dispatches to a
// specialized worker on the same machine.
//
// Why this exists separately from the daemon's POST /task endpoint:
//   - Going through HTTP for a same-node call is wasteful and harder
//     to trace (the action becomes a Bash + curl + parse-JSON dance,
//     exactly what AGENTX_HANDOFF.md item #1 flagged).
//   - Calling registry.execute() directly captures the call as a
//     structured action step in /traces (action=agent.call,
//     input=<typed>, output=<reply>) instead of opaque shell text.
//   - freshSession defaults to TRUE — the run-3/run-4 stickiness bug
//     was triage's curl reusing a warm pool; this default makes
//     "safe" the easy path.
//
// Architecturally this is a documented cross-tier seam: a Tier-3
// procedure reaches into the Tier-1 agent registry via the explicit
// getAgentRegistry() singleton (see registry-instance.ts and
// test/tier-discipline.test.ts:DOCUMENTED_SEAMS).

const agentCallInput = z.object({
  /** Local agent id to dispatch the task to. */
  agentId: z.string().min(1),
  /** The task message — verbatim user message or a synthesized prompt. */
  message: z.string().min(1),
  /** Force a fresh session on the receiving agent. Defaults to TRUE so
   *  that triage/router agents don't accidentally inherit a previous
   *  visitor's conversation state. Pass `false` only when you genuinely
   *  want continuity (rare for delegation). */
  freshSession: z.boolean().default(true),
  /** Optional channel + chatId. Defaults to a synthetic per-call chatId
   *  so multiple concurrent delegations don't share a session. */
  channel: z.string().default("api"),
  chatId: z.string().optional(),
  /** Identity of the calling agent — passed through to the receiving
   *  agent's context for trace-stitching and (eventually) capability
   *  validation. */
  senderAgentId: z.string().optional(),
  /** Per-call timeout. Default 90s — long enough for most agent
   *  reasoning; capped at 10min. */
  timeoutMs: z.number().int().min(1).max(600_000).default(90_000),
})
type AgentCallInput = z.infer<typeof agentCallInput>

const agentCallOutput = z.object({
  agentId: z.string(),
  /** The agent's reply. Same shape as POST /task's `content`. */
  reply: z.string(),
  /** Optional structured error if the underlying agent run failed.
   *  Surfaced so callers can branch on auth/billing/tool-required. */
  error: z.string().optional(),
  errorKind: z.string().optional(),
  /** Token usage for cost accounting. */
  usage: z.object({
    inputTokens: z.number().int().default(0),
    outputTokens: z.number().int().default(0),
    cacheReadTokens: z.number().int().default(0),
    cacheCreateTokens: z.number().int().default(0),
  }).default({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }),
  durationMs: z.number().int().default(0),
})
type AgentCallOutput = z.infer<typeof agentCallOutput>

export const agentCall: BuiltinAction<AgentCallInput, AgentCallOutput> = {
  name: "agent.call",
  description: "Dispatch a task to a local agent on the same daemon (fresh session by default — replaces ad-hoc 'Bash curl /task' delegation)",
  inputSchema: agentCallInput,
  outputSchema: agentCallOutput,
  timeoutMs: 600_000,
  handler: async (input) => {
    const registry = getAgentRegistry()
    if (!registry) {
      throw new Error("agent registry not wired (daemon not started or running in a non-daemon process)")
    }
    // Synthesize a per-call chatId by default so concurrent delegations
    // don't share a session. Caller can override for explicit continuity.
    const chatId = input.chatId ?? `agent-call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const started = Date.now()
    // senderAgentId is intentionally NOT placed in context (the
    // standard AgentTask context shape doesn't include it). The receiving
    // agent's prompt can reference {{trigger.input.senderAgentId}} if
    // configured; for trace stitching, the action's invocation already
    // creates a parent step so children land under the same task tree.
    const response = await registry.execute({
      agentId: input.agentId,
      message: input.message,
      freshSession: input.freshSession,
      context: {
        channel: input.channel,
        chatId,
      },
    })
    return {
      agentId: input.agentId,
      reply: response.content ?? "",
      error: response.error,
      errorKind: (response as any).errorKind,
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        cacheReadTokens: (response.usage as any)?.cacheReadTokens ?? 0,
        cacheCreateTokens: (response.usage as any)?.cacheCreateTokens ?? 0,
      },
      durationMs: response.duration ?? (Date.now() - started),
    }
  },
}
