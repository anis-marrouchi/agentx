import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs"
import { resolve } from "path"
import { buildIndex, scoreAll } from "../memory/bm25"

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

    // BM25 over keywords + content
    const docs = memories.map((m) => `${m.keywords.join(" ")} ${m.content}`)
    const index = buildIndex(docs)
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

    return matched
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.memory)
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
