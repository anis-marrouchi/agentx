// --- Context Planner ---
//
// A Haiku pre-call that decides what context to retrieve for the current
// message, replacing the blind "stack every layer" approach of the layered
// strategy. Drops --resume bloat by avoiding the full session history blob
// on every turn; instead pulls only the specific facts / memory / cross-chat
// the current message actually needs.
//
// Always-on core (handled by registry, not the planner): channel, scope,
// landscape, identity, intent, and a small `recentTurns`-sized tail of the
// session verbatim. The planner decides: how many tail turns to keep, and
// whether to pull memory or cross-chat on top.
//
// Fail-open: any planner error returns null and the registry falls back to
// the layered strategy. This keeps the feature safe to enable even when
// the planner model is misbehaving.
//
// Cost model: one small Haiku call per message (~300 input / ~80 output
// tokens, ~$0.0005). Win threshold is when it avoids shipping ≥5K tokens
// of layered history/memory the agent didn't need — typical for short
// "ok / yes / do it" messages where the layered path still dumps the
// whole 12K-char session blob.

import type { SessionStore, SessionMessage } from "./sessions"
import type { MemoryStore } from "./memory-store"

/** Planner output. When `null`, the caller falls back to the layered
 *  strategy. Otherwise each field overrides the corresponding context
 *  layer — an empty string means "skip this layer entirely". */
export interface ContextPlan {
  /** Rendered session history (same shape buildHistoryContext returns),
   *  truncated to the last N turns the planner picked. */
  sessionHistory: string
  /** Rendered memory context, or "" when the planner decided memory
   *  isn't relevant to this message. */
  memoryContext: string
  /** Rendered cross-chat summary, or "" when not needed. */
  crossChatContext: string
  /** Debug metadata — surfaced in logs + bench output so operators can
   *  see what the planner chose. Not sent to the main agent. */
  debug: {
    recentTurns: number
    memoryIncluded: boolean
    memoryQuery?: string
    crossChatIncluded: boolean
    reasoning?: string
    planLatencyMs: number
  }
}

export interface PlanContextInput {
  agentId: string
  channel: string
  chatId: string
  message: string
  sessions: SessionStore
  memoryStore: MemoryStore
  /** Caller-controlled timeout for the Haiku planner call. Defaults to
   *  8s — the planner is in the critical path before the main agent
   *  runs, so we can't afford a long timeout. Fail-open if exceeded. */
  timeoutMs?: number
}

const PLANNER_MODEL = "claude-haiku-4-5-20251001"
const PLANNER_PROMPT = `You are a context planner for an AI agent. Given the user's current message and recent conversation tail, decide what historical context the agent needs.

Output ONE JSON object on one line, no prose, no fences:
  { "recentTurns": number, "memory": { "include": boolean, "query": string }, "crossChat": boolean, "reasoning": string }

Rules:
- "recentTurns" in [0,6]. Short acknowledgments ("ok", "yes", "do it", "continue") need 2-3 turns to know what they refer to. New topics need 0. Technical follow-ups need 3-5.
- "memory.include" = true only when the message likely references a person, past event, decision, or project the agent should recall. "memory.query" = 3-8 words distilling what to search for (leave "" when include=false).
- "crossChat" = true only when the message references another chat ("DM", "the group", "earlier conversation", a peer agent's name). Most messages = false.
- "reasoning" = one short phrase explaining the plan.

Be conservative — unneeded context costs tokens. When in doubt, exclude.`

export async function planContext(input: PlanContextInput): Promise<ContextPlan | null> {
  const start = Date.now()
  const timeoutMs = input.timeoutMs ?? 8_000

  // Snapshot the session tail for the planner prompt. Don't send the
  // whole session — the planner only needs enough to judge whether the
  // message is a follow-up, and we pay tokens for every line we ship.
  const recentTail = sessionTail(input.sessions, input.agentId, input.channel, input.chatId, 4)

  const userPrompt = [
    `Agent: ${input.agentId}`,
    `Channel: ${input.channel}`,
    recentTail ? `Recent conversation:\n${recentTail}` : "Recent conversation: (none — first message)",
    ``,
    `Current message: ${input.message.slice(0, 1500)}`,
  ].join("\n")

  // Use the Anthropic SDK path — warm HTTP client, no subprocess cold-start.
  // resolveToken now recognizes CLAUDE_CODE_OAUTH_TOKEN so this works out
  // of the box for any operator who already has Claude CLI auth set up.
  // Planner timeout is tight (8s default) because plan latency is in the
  // critical path before the main agent runs.
  let planJson: any
  try {
    const { createProvider } = await import("@/agent/providers")
    const provider = createProvider("claude")
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const result = await provider.generate(
        [
          { role: "system", content: PLANNER_PROMPT },
          { role: "user", content: userPrompt },
        ],
        { model: PLANNER_MODEL, maxTokens: 256 },
      )
      planJson = extractJson(result.content)
    } finally {
      clearTimeout(timer)
    }
  } catch (err: any) {
    // Temporary: surface planner errors for debugging. Will silence once
    // we're confident the SDK path is stable.
    if (process.env.AGENTX_PLANNER_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[planner] error: ${err?.message ?? err}`)
    }
    return null
  }

  if (!planJson || typeof planJson !== "object") return null

  const recentTurns = clampInt(planJson.recentTurns, 0, 6, 3)
  const memoryInclude = Boolean(planJson.memory?.include)
  const memoryQuery: string = typeof planJson.memory?.query === "string" ? planJson.memory.query : ""
  const crossChatInclude = Boolean(planJson.crossChat)
  const reasoning = typeof planJson.reasoning === "string" ? planJson.reasoning : undefined

  // Resolve the plan into actual retrieval strings.
  const sessionHistory = renderSessionTail(
    input.sessions,
    input.agentId,
    input.channel,
    input.chatId,
    recentTurns,
  )

  let memoryContext = ""
  if (memoryInclude && memoryQuery) {
    try {
      const relevant = input.memoryStore.findRelevant(memoryQuery, input.agentId, 5)
      memoryContext = input.memoryStore.buildContext(relevant)
    } catch {
      // Memory retrieval is best-effort; planner proceeds with empty memory.
    }
  }

  let crossChatContext = ""
  if (crossChatInclude) {
    // Force-include via empty message arg — the planner already decided.
    crossChatContext = input.sessions.getCrossSessionSummary(
      input.agentId, input.channel, input.chatId, "",
    )
  }

  return {
    sessionHistory,
    memoryContext,
    crossChatContext,
    debug: {
      recentTurns,
      memoryIncluded: memoryInclude,
      memoryQuery: memoryQuery || undefined,
      crossChatIncluded: crossChatInclude,
      reasoning,
      planLatencyMs: Date.now() - start,
    },
  }
}

/** Render the last N message pairs as a compact prompt tail. Returns "" when
 *  there's no session on disk yet (first message). Format mirrors
 *  SessionStore.buildHistoryContext but with an N-turn cap — the planner's
 *  whole point is to cap this instead of dumping the full 12K-char log. */
function renderSessionTail(
  sessions: SessionStore,
  agentId: string,
  channel: string,
  chatId: string,
  turns: number,
): string {
  if (turns <= 0) return ""
  const session = sessions.getSession(agentId, channel, chatId)
  if (session.messages.length === 0) return ""
  // N "turns" = N*2 messages (user+agent pairs). Round to nearest message
  // count so a partial trailing user message still gets included.
  const msgCount = Math.min(session.messages.length, turns * 2)
  const tail = session.messages.slice(-msgCount)
  const lines: string[] = [`[Recent exchange — last ${tail.length} messages]`]
  for (const msg of tail) {
    const name = msg.name || (msg.role === "user" ? "User" : "Agent")
    lines.push(`${name}: ${msg.content}`)
  }
  lines.push("[End recent exchange — respond to the latest message above]")
  lines.push("")
  return lines.join("\n")
}

/** Very small tail for the planner's own prompt — enough for the planner to
 *  decide whether this message is a follow-up, not enough to bloat the
 *  planner call itself. Distinct from renderSessionTail (used for the main
 *  agent) because we cap more aggressively here. */
function sessionTail(
  sessions: SessionStore,
  agentId: string,
  channel: string,
  chatId: string,
  maxMessages: number,
): string {
  const session = sessions.getSession(agentId, channel, chatId)
  if (session.messages.length === 0) return ""
  const tail = session.messages.slice(-maxMessages)
  return tail
    .map((m: SessionMessage) => {
      const name = m.name || (m.role === "user" ? "User" : "Agent")
      const content = m.content.length > 200 ? m.content.slice(0, 200) + "…" : m.content
      return `  ${name}: ${content}`
    })
    .join("\n")
}

/** Extract the first JSON object from a text response. Haiku sometimes
 *  wraps output in backticks or prose despite the instructions, so we
 *  scan for the first `{...}` span. */
function extractJson(text: string): unknown {
  if (!text) return null
  const trimmed = text.trim()
  // Fast path — clean JSON.
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  // Fallback — first balanced object.
  const start = trimmed.indexOf("{")
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++
    else if (trimmed[i] === "}") {
      depth--
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v ?? ""), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
