import type { Workflow } from "./types"

export interface WorkflowMatchInput {
  agentId: string
  channel?: string
  message: string
  intentPath?: string[]
}

export interface WorkflowMatch {
  workflow: Workflow
  confidence: number
  reasons: string[]
}

function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  )
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n / Math.max(a.size, b.size)
}

export function matchWorkflow(input: WorkflowMatchInput, workflows: Workflow[]): WorkflowMatch | null {
  const messageWords = words(input.message)
  const active = workflows.filter((wf) => wf.state === "active" && (wf.status ?? "active") === "active")
  let best: WorkflowMatch | null = null

  for (const wf of active) {
    let score = 0
    const reasons: string[] = []
    if (wf.ownerAgent && wf.ownerAgent === input.agentId) { score += 0.25; reasons.push("owner-agent") }
    if (input.channel && wf.tags.includes(input.channel)) { score += 0.15; reasons.push("channel-tag") }
    if (input.intentPath?.length && wf.intentPath.length) {
      const same = input.intentPath.filter((p, i) => wf.intentPath[i] === p).length
      if (same > 0) { score += Math.min(0.3, same * 0.1); reasons.push("intent-path") }
    }
    const text = [wf.id, wf.title, wf.description ?? "", ...wf.tags].join(" ")
    const wordScore = overlap(messageWords, words(text))
    if (wordScore > 0) { score += Math.min(0.35, wordScore); reasons.push("text-similarity") }
    if ((wf.matchCount ?? 0) > 0) { score += Math.min(0.1, wf.matchCount * 0.01); reasons.push("prior-matches") }
    const confidence = Math.max(0, Math.min(1, score))
    if (!best || confidence > best.confidence) best = { workflow: wf, confidence, reasons }
  }

  return best && best.confidence > 0 ? best : null
}
