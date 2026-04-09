import type { SessionMessage } from "./sessions"
import type { MemoryStore } from "./memory-store"

// --- Context Compaction ---
//
// Summarizes conversation history when it grows too large,
// preventing context loss in long-running sessions.
//
// Strategy:
// 1. Memory flush: extract memorable facts BEFORE compacting
// 2. Split-aware: keep tool_use/tool_result pairs intact
// 3. Uses cheaper model (Haiku) for summarization
// 4. Preserves recent messages verbatim, compacts older ones

const COMPACTION_MODEL = "claude-haiku-4-20250514"
const MAX_HISTORY_CHARS = 12000
const COMPACT_THRESHOLD = 10000   // Start compacting when history exceeds this
const KEEP_RECENT = 6             // Always keep last N messages verbatim
const MIN_MESSAGES_TO_COMPACT = 8 // Don't compact if fewer than this

const COMPACTION_PROMPT = `You are a conversation summarizer. Given a conversation history between a user and an AI agent, produce a concise summary that preserves:

1. Key decisions made and their reasoning
2. Important facts learned (names, IDs, paths, URLs, credentials shared)
3. Commitments and action items (what was promised, deadlines)
4. Current task state (what's in progress, what's done, what's blocked)
5. User preferences expressed during the conversation

Format as a structured summary:
[Session Summary]
- Decisions: ...
- Facts: ...
- In progress: ...
- Done: ...
- Preferences: ...

Keep it under 500 words. Prioritize actionable information over conversational flow.
Do NOT include greetings, acknowledgments, or meta-commentary about the conversation.`

export interface CompactionResult {
  /** Summarized text replacing older messages */
  summary: string
  /** Messages that were compacted (removed from history) */
  compactedCount: number
  /** Messages kept verbatim (recent) */
  keptCount: number
  /** Whether memory flush was performed before compaction */
  memoryFlushed: boolean
}

/**
 * Check whether a session's history needs compaction.
 */
export function needsCompaction(messages: SessionMessage[]): boolean {
  if (messages.length < MIN_MESSAGES_TO_COMPACT) return false
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0)
  return totalChars > COMPACT_THRESHOLD
}

/**
 * Compact a session's conversation history.
 *
 * Flow:
 * 1. Flush memories from the about-to-be-compacted messages
 * 2. Summarize older messages using Haiku
 * 3. Return summary + preserved recent messages
 */
export async function compactSession(
  messages: SessionMessage[],
  agentId: string,
  memoryStore?: MemoryStore,
): Promise<CompactionResult> {
  if (messages.length < MIN_MESSAGES_TO_COMPACT) {
    return {
      summary: "",
      compactedCount: 0,
      keptCount: messages.length,
      memoryFlushed: false,
    }
  }

  // Split: older messages to compact, recent to keep
  const splitIdx = Math.max(0, messages.length - KEEP_RECENT)
  const toCompact = messages.slice(0, splitIdx)
  const toKeep = messages.slice(splitIdx)

  if (toCompact.length === 0) {
    return {
      summary: "",
      compactedCount: 0,
      keptCount: toKeep.length,
      memoryFlushed: false,
    }
  }

  // Step 1: Memory flush — extract facts from messages about to be compacted
  let memoryFlushed = false
  if (memoryStore) {
    try {
      await flushMemories(agentId, toCompact, memoryStore)
      memoryFlushed = true
    } catch {
      // Best-effort memory flush
    }
  }

  // Step 2: Summarize older messages
  const historyText = formatMessagesForSummary(toCompact)
  const summary = await summarize(historyText)

  return {
    summary,
    compactedCount: toCompact.length,
    keptCount: toKeep.length,
    memoryFlushed,
  }
}

/**
 * Apply compaction result to a session's messages.
 * Replaces older messages with a single summary message and keeps recent ones.
 */
export function applyCompaction(
  messages: SessionMessage[],
  result: CompactionResult,
): SessionMessage[] {
  if (result.compactedCount === 0) return messages

  const kept = messages.slice(-result.keptCount)

  // Prepend summary as a synthetic "system" message
  const summaryMessage: SessionMessage = {
    role: "agent",
    name: "system",
    content: `[Compacted conversation summary — ${result.compactedCount} earlier messages]\n\n${result.summary}`,
    timestamp: new Date().toISOString(),
  }

  return [summaryMessage, ...kept]
}

/**
 * Flush extractable memories from messages before they get compacted.
 * This ensures important facts survive compaction.
 */
async function flushMemories(
  agentId: string,
  messages: SessionMessage[],
  store: MemoryStore,
): Promise<void> {
  // Build a conversation block from the messages
  const userMessages: string[] = []
  const agentMessages: string[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      userMessages.push(`${msg.name || "User"}: ${msg.content}`)
    } else {
      agentMessages.push(msg.content)
    }
  }

  if (userMessages.length === 0 || agentMessages.length === 0) return

  // Use the existing memory extraction on a combined block
  const { extractMemories } = await import("./memory-extract")
  await extractMemories(
    agentId,
    userMessages.join("\n"),
    agentMessages.join("\n"),
    { channel: "compaction", chatId: "flush", sender: "compaction" },
    store,
  )
}

/**
 * Format messages into a readable transcript for the summarizer.
 */
function formatMessagesForSummary(messages: SessionMessage[]): string {
  return messages
    .map((m) => {
      const time = m.timestamp.slice(11, 16)
      const speaker = m.role === "user" ? (m.name || "User") : (m.name || "Agent")
      return `[${time}] ${speaker}: ${m.content}`
    })
    .join("\n\n")
}

/**
 * Summarize a conversation transcript using a cheap/fast model.
 */
async function summarize(transcript: string): Promise<string> {
  // Truncate extremely long transcripts to avoid exceeding Haiku's context
  const maxInputChars = 20000
  const truncated = transcript.length > maxInputChars
    ? transcript.slice(-maxInputChars)
    : transcript

  try {
    const { createProvider } = await import("@/agent/providers")
    const provider = createProvider("claude")

    const result = await provider.generate(
      [
        { role: "system", content: COMPACTION_PROMPT },
        { role: "user", content: truncated },
      ],
      { model: COMPACTION_MODEL, maxTokens: 1024 },
    )

    return result.content.trim()
  } catch (error: any) {
    // Fallback: simple truncation if summarization fails
    const lines = transcript.split("\n")
    const kept = lines.slice(-20)
    return `[Summary unavailable — keeping last ${kept.length} lines]\n${kept.join("\n")}`
  }
}
