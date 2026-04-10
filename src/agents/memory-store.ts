import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs"
import { resolve } from "path"
import { buildIndexCached, scoreAll } from "../memory/bm25"

// --- Persistent agent memory store ---
// JSONL-based. One file per agent: .agentx/memory/{agentId}.jsonl
// Extracted by Haiku post-conversation, injected pre-conversation.

export interface MemoryFact {
  id: string
  agentId: string
  category: "fact" | "secret" | "preference" | "commitment" | "task-state"
  content: string
  keywords: string[]
  source: { channel: string; chatId: string; sender: string; date: string }
  createdAt: string
  expiresAt?: string
  // Spaced repetition fields
  accessCount?: number
  lastAccessed?: string
  nextReview?: string
  /** Review interval in days — doubles on each successful recall */
  intervalDays?: number
}

const MAX_MEMORIES = 200
const TASK_STATE_TTL_DAYS = 7


export class MemoryStore {
  private memoryDir: string

  constructor(baseDir: string = process.cwd()) {
    this.memoryDir = resolve(baseDir, ".agentx/memory")
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true })
    }
  }

  private filePath(agentId: string): string {
    return resolve(this.memoryDir, `${agentId}.jsonl`)
  }

  addMemory(agentId: string, fact: Omit<MemoryFact, "id" | "createdAt">): void {
    const entry: MemoryFact = {
      ...fact,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    }
    appendFileSync(this.filePath(agentId), JSON.stringify(entry) + "\n")
  }

  getAll(agentId: string): MemoryFact[] {
    const file = this.filePath(agentId)
    if (!existsSync(file)) return []

    try {
      const lines = readFileSync(file, "utf-8").split("\n").filter(l => l.trim())
      return lines.map(l => {
        try { return JSON.parse(l) as MemoryFact } catch { return null }
      }).filter((m): m is MemoryFact => m !== null)
    } catch {
      return []
    }
  }

  findRelevant(message: string, agentId: string, limit: number = 8): MemoryFact[] {
    const memories = this.getAll(agentId)
    if (memories.length === 0) return []

    // BM25 over keywords + content (cached)
    const docs = memories.map((m) => `${m.keywords.join(" ")} ${m.content}`)
    const cachePath = resolve(this.memoryDir, `${agentId}_bm25_cache.json`)
    const index = buildIndexCached(docs, cachePath)
    const bm25Scores = scoreAll(message, index)
    const scoreMap = new Map(bm25Scores.map((r) => [r.docIndex, r.score]))

    const scored = memories.map((m, i) => {
      let s = scoreMap.get(i) ?? 0
      // Category boosts (preserved from original)
      if (m.category === "secret") s += 2
      if (m.category === "commitment") s += 1
      return { memory: m, score: s }
    })

    const matched = scored.filter((s) => s.score > 0)
    if (matched.length === 0) return memories.slice(-limit) // fallback: recent

    const selected = matched
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.memory)

    // Track access for spaced repetition (fire-and-forget)
    if (selected.length > 0) {
      try { this.recordAccess(agentId, selected.map(m => m.id)) } catch {}
    }

    return selected
  }

  buildContext(memories: MemoryFact[]): string {
    if (memories.length === 0) return ""

    const lines = ["[Agent Memory — persistent facts from past conversations]"]
    let chars = lines[0].length

    for (const m of memories) {
      const isDM = !m.source.chatId.startsWith("-") && /^\d+$/.test(m.source.chatId)
      const scope = isDM ? "DM" : m.source.chatId
      const line = `- [${m.category}] ${m.content} (${scope}, ${m.source.date})`

      if (chars + line.length > 2400) break
      lines.push(line)
      chars += line.length
    }

    lines.push("[End Memory]")
    return lines.join("\n")
  }

  /**
   * Record that memories were accessed (for spaced repetition tracking).
   */
  recordAccess(agentId: string, memoryIds: string[]): void {
    if (memoryIds.length === 0) return
    const memories = this.getAll(agentId)
    const idSet = new Set(memoryIds)
    let changed = false

    for (const m of memories) {
      if (idSet.has(m.id)) {
        m.accessCount = (m.accessCount || 0) + 1
        m.lastAccessed = new Date().toISOString()
        // Double the review interval (spaced repetition: 1 → 2 → 4 → 8 → 16 days)
        const currentInterval = m.intervalDays || 1
        m.intervalDays = Math.min(currentInterval * 2, 30)
        m.nextReview = new Date(Date.now() + m.intervalDays * 86400000).toISOString()
        changed = true
      }
    }

    if (changed) {
      writeFileSync(
        this.filePath(agentId),
        memories.map(m => JSON.stringify(m)).join("\n") + "\n",
      )
    }
  }

  /**
   * Get memories due for review (spaced repetition).
   * Returns facts whose nextReview date has passed or that have never been reviewed.
   */
  getDueForReview(agentId: string, limit: number = 5): MemoryFact[] {
    const memories = this.getAll(agentId)
    const now = Date.now()

    return memories
      .filter(m => {
        // Skip task-state (ephemeral)
        if (m.category === "task-state") return false
        // Never reviewed → due
        if (!m.nextReview) return true
        // Past review date → due
        return new Date(m.nextReview).getTime() <= now
      })
      .sort((a, b) => {
        // Prioritize: never reviewed, then oldest nextReview, then most accessed
        if (!a.nextReview && b.nextReview) return -1
        if (a.nextReview && !b.nextReview) return 1
        if (a.nextReview && b.nextReview) {
          return new Date(a.nextReview).getTime() - new Date(b.nextReview).getTime()
        }
        return (a.accessCount || 0) - (b.accessCount || 0)
      })
      .slice(0, limit)
  }

  /**
   * Build a recall prompt for memories due for review.
   * Injected into heartbeat context so the agent proactively recalls facts.
   */
  buildRecallContext(agentId: string): string {
    const due = this.getDueForReview(agentId, 5)
    if (due.length === 0) return ""

    const lines = ["[Memory Recall — facts due for review, verify they are still accurate]"]
    for (const m of due) {
      const age = Math.round((Date.now() - new Date(m.createdAt).getTime()) / 86400000)
      lines.push(`- [${m.category}] ${m.content} (${age}d old, accessed ${m.accessCount || 0}x)`)
    }
    lines.push("[If any fact is outdated, note the correction. Otherwise, acknowledge recall.]")
    return lines.join("\n")
  }

  /**
   * Check if a substantially similar memory already exists.
   */
  hasSimilar(agentId: string, content: string): boolean {
    const memories = this.getAll(agentId)
    const contentLower = content.toLowerCase()
    const contentWords = contentLower.split(/\s+/).filter(w => w.length > 3)

    return memories.some(m => {
      const mLower = m.content.toLowerCase()
      // Check for high word overlap
      const overlap = contentWords.filter(w => mLower.includes(w)).length
      return overlap >= contentWords.length * 0.7
    })
  }

  /**
   * Prune old/expired memories. Cap at MAX_MEMORIES per agent.
   */
  prune(agentId: string): void {
    let memories = this.getAll(agentId)
    if (memories.length === 0) return

    const now = Date.now()
    const ttlMs = TASK_STATE_TTL_DAYS * 24 * 60 * 60 * 1000

    // Remove expired task-state memories
    memories = memories.filter(m => {
      if (m.category === "task-state" && m.expiresAt) {
        return new Date(m.expiresAt).getTime() > now
      }
      if (m.category === "task-state" && !m.expiresAt) {
        return now - new Date(m.createdAt).getTime() < ttlMs
      }
      return true
    })

    // Cap at MAX_MEMORIES (keep most recent)
    if (memories.length > MAX_MEMORIES) {
      memories = memories.slice(-MAX_MEMORIES)
    }

    // Rewrite file
    const file = this.filePath(agentId)
    writeFileSync(file, memories.map(m => JSON.stringify(m)).join("\n") + "\n")
  }
}
