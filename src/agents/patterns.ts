import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs"
import { resolve } from "path"
import { buildIndexCached, scoreAll } from "../memory/bm25"

// --- Behavioral Pattern Store ---
//
// Agents learn HOW to work, not just WHAT they know.
// After each response, Haiku extracts behavioral patterns:
//   "When user asks about deployment, check CI status first"
//   "Code reviews should mention test coverage"
//
// Before each prompt, relevant patterns are injected so the agent
// improves over time — a self-correcting loop.

export interface BehavioralPattern {
  id: string
  agentId: string
  pattern: string        // the learned behavior
  context: string        // when this applies
  confidence: number     // 0-1, increases with validation
  accessCount: number
  createdAt: string
  lastUsed?: string
  source: { channel: string; date: string }
}

const MAX_PATTERNS = 50
const EXTRACTION_MODEL = "claude-haiku-4-20250514"

const PATTERN_EXTRACTION_PROMPT = `You are a behavioral pattern extractor. Given a conversation between a user and an AI agent, extract behavioral patterns — lessons about HOW to approach tasks, not facts about the world.

Extract patterns like:
- "When asked about X, the approach that works is Y"
- "User prefers Z style of communication"
- "For deployment tasks, always check A before doing B"
- "This codebase uses pattern X, so generate code following X"

SKIP:
- Factual information (names, dates, URLs)
- Routine task completions
- Greetings or small talk

Output a JSON array:
[{"pattern":"the behavioral lesson","context":"when this applies","confidence":0.5}]

If nothing worth extracting, output: []`

export class PatternStore {
  private patternsDir: string

  constructor(baseDir: string = process.cwd()) {
    this.patternsDir = resolve(baseDir, ".agentx/patterns")
    if (!existsSync(this.patternsDir)) {
      mkdirSync(this.patternsDir, { recursive: true })
    }
  }

  private filePath(agentId: string): string {
    return resolve(this.patternsDir, `${agentId}.jsonl`)
  }

  getAll(agentId: string): BehavioralPattern[] {
    const file = this.filePath(agentId)
    if (!existsSync(file)) return []
    try {
      return readFileSync(file, "utf-8")
        .split("\n")
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l) } catch { return null } })
        .filter((p): p is BehavioralPattern => p !== null)
    } catch {
      return []
    }
  }

  addPattern(agentId: string, pattern: Omit<BehavioralPattern, "id" | "createdAt" | "accessCount">): void {
    const entry: BehavioralPattern = {
      ...pattern,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      accessCount: 0,
      createdAt: new Date().toISOString(),
    }
    appendFileSync(this.filePath(agentId), JSON.stringify(entry) + "\n")
  }

  /**
   * Find patterns relevant to the current task.
   */
  findRelevant(message: string, agentId: string, limit: number = 5): BehavioralPattern[] {
    const patterns = this.getAll(agentId)
    if (patterns.length === 0) return []

    const docs = patterns.map(p => `${p.context} ${p.pattern}`)
    const cachePath = resolve(this.patternsDir, `${agentId}_bm25_cache.json`)
    const index = buildIndexCached(docs, cachePath)
    const scored = scoreAll(message, index)

    const results = scored
      .slice(0, limit)
      .map(s => patterns[s.docIndex])
      .filter(p => p.confidence >= 0.3) // only confident patterns

    // Track access
    if (results.length > 0) {
      this.recordAccess(agentId, results.map(p => p.id))
    }

    return results
  }

  /**
   * Build context string from relevant patterns for prompt injection.
   */
  buildContext(patterns: BehavioralPattern[]): string {
    if (patterns.length === 0) return ""

    const lines = ["[Learned Patterns — behavioral lessons from past interactions]"]
    for (const p of patterns) {
      lines.push(`- ${p.pattern} (context: ${p.context}, confidence: ${Math.round(p.confidence * 100)}%)`)
    }
    lines.push("[Apply these patterns when relevant to the current task]")
    return lines.join("\n")
  }

  /**
   * Check if a similar pattern already exists.
   */
  hasSimilar(agentId: string, pattern: string): boolean {
    const existing = this.getAll(agentId)
    const words = pattern.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    return existing.some(p => {
      const pWords = p.pattern.toLowerCase()
      const overlap = words.filter(w => pWords.includes(w)).length
      return overlap >= words.length * 0.6
    })
  }

  private recordAccess(agentId: string, ids: string[]): void {
    const patterns = this.getAll(agentId)
    const idSet = new Set(ids)
    let changed = false
    for (const p of patterns) {
      if (idSet.has(p.id)) {
        p.accessCount++
        p.lastUsed = new Date().toISOString()
        // Boost confidence slightly on each use (max 1.0)
        p.confidence = Math.min(1.0, p.confidence + 0.05)
        changed = true
      }
    }
    if (changed) {
      writeFileSync(this.filePath(agentId), patterns.map(p => JSON.stringify(p)).join("\n") + "\n")
    }
  }

  /**
   * Prune low-confidence or old patterns. Cap at MAX_PATTERNS.
   */
  prune(agentId: string): void {
    let patterns = this.getAll(agentId)
    if (patterns.length <= MAX_PATTERNS) return

    // Sort by confidence * accessCount (most valuable first)
    patterns.sort((a, b) => (b.confidence * b.accessCount) - (a.confidence * a.accessCount))
    patterns = patterns.slice(0, MAX_PATTERNS)
    writeFileSync(this.filePath(agentId), patterns.map(p => JSON.stringify(p)).join("\n") + "\n")
  }
}

/**
 * Extract behavioral patterns from a conversation (fire-and-forget).
 */
export async function extractPatterns(
  agentId: string,
  userMessage: string,
  agentResponse: string,
  source: { channel: string; date: string },
  store: PatternStore,
): Promise<void> {
  if (userMessage.length < 30 && agentResponse.length < 100) return

  const { createProvider } = await import("@/agent/providers")
  const provider = createProvider("claude")

  const result = await provider.generate(
    [
      { role: "system", content: PATTERN_EXTRACTION_PROMPT },
      { role: "user", content: `User: ${userMessage.slice(0, 500)}\n\nAgent: ${agentResponse.slice(0, 1000)}` },
    ],
    { model: EXTRACTION_MODEL, maxTokens: 512 },
  )

  const jsonMatch = result.content.trim().match(/\[[\s\S]*\]/)
  if (!jsonMatch) return

  const patterns = JSON.parse(jsonMatch[0]) as Array<{
    pattern: string
    context: string
    confidence: number
  }>

  if (!Array.isArray(patterns) || patterns.length === 0) return

  for (const p of patterns) {
    if (store.hasSimilar(agentId, p.pattern)) continue
    store.addPattern(agentId, {
      agentId,
      pattern: p.pattern,
      context: p.context,
      confidence: p.confidence || 0.5,
      source,
    })
  }

  // Probabilistic pruning
  if (Math.random() < 0.05) store.prune(agentId)
}
