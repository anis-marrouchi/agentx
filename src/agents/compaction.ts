import type { SessionMessage } from "./sessions"
import type { MemoryStore } from "./memory-store"
import { buildFingerprint, detectDrift, saveFingerprint, loadFingerprint, type DriftReport } from "./drift-detection"

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
const MAX_HISTORY_CHARS = 60_000
// Start compacting when stored history exceeds this. Bumped 10K → 50K
// because the original threshold tripped on trivial multi-message bursts
// (project-bot queues, daily-tick storms), spending Haiku tokens to reduce
// stored history that Claude itself never reads — Claude --resume replays
// from its own copy. The cost-relevant thresholds are tier-2 token rotation
// (~200K tokens / ~800K chars of input) and max-turns; compaction is just
// for our local storage hygiene + cross-session summary seeding, so a
// generous threshold is fine.
const COMPACT_THRESHOLD = 50_000
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
  /** Quality score: percentage of key entities preserved in summary (0-100) */
  qualityScore?: number
  /** Entities that were lost in compaction */
  lostEntities?: string[]
  /** Behavioral drift report (compared to pre-compaction baseline) */
  drift?: DriftReport
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

  // Step 0: Capture behavioral fingerprint BEFORE compaction (drift baseline)
  const preFingerprint = buildFingerprint(toCompact)
  saveFingerprint(agentId, preFingerprint)

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

  // Step 3: Verify compaction quality — check entity preservation
  const { qualityScore, lostEntities } = verifyCompactionQuality(historyText, summary)

  // Step 4: Check for behavioral drift — compare summary against pre-compaction baseline
  let drift: DriftReport | undefined
  const summaryMessages: SessionMessage[] = [{
    role: "agent" as const,
    content: summary,
    timestamp: new Date().toISOString(),
  }]
  const postFingerprint = buildFingerprint(summaryMessages)
  const baseline = loadFingerprint(agentId)
  if (baseline) {
    drift = detectDrift(baseline, postFingerprint)
  }

  return {
    summary,
    compactedCount: toCompact.length,
    keptCount: toKeep.length,
    memoryFlushed,
    qualityScore,
    lostEntities: lostEntities.length > 0 ? lostEntities : undefined,
    drift: drift && drift.overallScore > 0.1 ? drift : undefined,
  }
}

/**
 * Verify compaction quality by checking entity preservation.
 * Extracts key entities (names, IDs, URLs, decisions) from the original
 * and checks how many survived in the summary.
 */
function verifyCompactionQuality(
  original: string,
  summary: string,
): { qualityScore: number; lostEntities: string[] } {
  const entities = extractEntities(original)
  if (entities.length === 0) return { qualityScore: 100, lostEntities: [] }

  const summaryLower = summary.toLowerCase()
  const preserved: string[] = []
  const lost: string[] = []

  for (const entity of entities) {
    if (summaryLower.includes(entity.toLowerCase())) {
      preserved.push(entity)
    } else {
      lost.push(entity)
    }
  }

  const score = Math.round((preserved.length / entities.length) * 100)
  return { qualityScore: score, lostEntities: lost }
}

/**
 * Extract key entities from text: names, IDs, URLs, file paths, decisions.
 */
function extractEntities(text: string): string[] {
  const entities: string[] = []
  const seen = new Set<string>()

  const add = (entity: string) => {
    const key = entity.toLowerCase().trim()
    if (key.length < 3 || seen.has(key)) return
    seen.add(key)
    entities.push(entity.trim())
  }

  // URLs
  const urls = text.match(/https?:\/\/[^\s<>)"]+/g) || []
  for (const url of urls) add(url.slice(0, 80))

  // File paths
  const paths = text.match(/(?:\/[\w.-]+){2,}/g) || []
  for (const p of paths) add(p)

  // Ticket/issue references (#123, !456)
  const refs = text.match(/[#!]\d{2,}/g) || []
  for (const r of refs) add(r)

  // Email addresses
  const emails = text.match(/[\w.-]+@[\w.-]+\.\w+/g) || []
  for (const e of emails) add(e)

  // Quoted strings (potential names, IDs, keys)
  const quoted = text.match(/"([^"]{3,40})"/g) || []
  for (const q of quoted) add(q.slice(1, -1))

  // Capitalized proper nouns (2+ words starting with uppercase)
  const properNouns = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || []
  for (const n of properNouns) add(n)

  // UUIDs and hashes
  const ids = text.match(/[a-f0-9]{8,}/gi) || []
  for (const id of ids.slice(0, 5)) add(id) // cap to avoid noise

  return entities.slice(0, 30) // max 30 entities to check
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
