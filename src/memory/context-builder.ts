// --- Context Builder: smart assembly with @-import resolution and relevance trimming ---

import { existsSync, readFileSync } from "fs"
import path from "path"
import { buildIndex, scoreAll } from "./bm25"

interface ContextSection {
  label: string
  content: string
  priority: number // higher = more important
}

/**
 * Resolve @-imports in content: replace @path/to/file with file contents.
 */
export function resolveAtImports(content: string, basedir: string): string {
  return content.replace(/@([\w./-]+)/g, (match, filePath: string) => {
    const resolved = path.resolve(basedir, filePath)
    if (existsSync(resolved)) {
      try {
        return readFileSync(resolved, "utf8")
      } catch {
        return match // keep original if read fails
      }
    }
    return match // keep original if file doesn't exist
  })
}

/**
 * Load project instructions from SHADXN.md or CLAUDE.md.
 */
export function loadProjectInstructions(cwd: string): string {
  const candidates = ["SHADXN.md", "CLAUDE.md"]
  for (const name of candidates) {
    const filePath = path.join(cwd, name)
    if (existsSync(filePath)) {
      try {
        let content = readFileSync(filePath, "utf8")
        content = resolveAtImports(content, cwd)
        return content
      } catch {
        // skip if unreadable
      }
    }
  }
  return ""
}

/**
 * Estimate token count from content (rough chars-to-tokens).
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

export class ContextBuilder {
  private sections: ContextSection[] = []

  addSection(label: string, content: string, priority = 50): void {
    if (!content.trim()) return
    this.sections.push({ label, content, priority })
  }

  /**
   * Build final context, trimming lowest-relevance sections if over budget.
   */
  buildContext(task: string, maxTokens = 12000): string {
    if (this.sections.length === 0) return ""

    // Score each section via BM25
    const docs = this.sections.map((s) => s.content)
    const index = buildIndex(docs)
    const bm25Results = scoreAll(task, index)
    const scoreMap = new Map(bm25Results.map((r) => [r.docIndex, r.score]))

    const scored = this.sections.map((s, i) => ({
      ...s,
      relevance: scoreMap.get(i) ?? 0,
      tokens: estimateTokens(s.content),
    }))

    // Sort by combined score (priority weight + relevance)
    scored.sort(
      (a, b) => b.priority + b.relevance * 100 - (a.priority + a.relevance * 100)
    )

    // Include sections until budget is exceeded
    const included: typeof scored = []
    let totalTokens = 0

    for (const section of scored) {
      if (totalTokens + section.tokens > maxTokens && included.length > 0) {
        // Skip this section — over budget
        continue
      }
      included.push(section)
      totalTokens += section.tokens
    }

    return included.map((s) => s.content).join("\n\n")
  }
}
