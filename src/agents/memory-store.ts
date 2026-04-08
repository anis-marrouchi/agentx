import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs"
import { resolve } from "path"

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
}

const MAX_MEMORIES = 200
const TASK_STATE_TTL_DAYS = 7

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "through",
  "and", "but", "or", "not", "no", "if", "then", "so", "what", "how",
  "when", "where", "who", "which", "that", "this", "it", "i", "you",
  "we", "they", "he", "she", "me", "my", "your", "our", "their",
  "please", "just", "also", "very", "much", "some", "any", "all",
])

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

    const words = message.toLowerCase()
      .replace(/[^a-z0-9\s@_-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))

    if (words.length === 0) return memories.slice(-limit) // fallback: recent memories

    const scored = memories.map(m => {
      let score = 0
      const contentLower = m.content.toLowerCase()
      const keywordsLower = m.keywords.map(k => k.toLowerCase())

      for (const word of words) {
        if (keywordsLower.some(k => k.includes(word))) score += 3
        if (contentLower.includes(word)) score += 1
      }

      // Boost secrets and commitments (more important to recall)
      if (m.category === "secret") score += 2
      if (m.category === "commitment") score += 1

      return { memory: m, score }
    })

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.memory)
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
