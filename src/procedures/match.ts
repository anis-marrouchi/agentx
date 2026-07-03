import type { Procedure } from "./types"

// --- Procedure matching ---
// Cheap keyword-overlap scoring so an incoming task can be checked against
// known procedures without an LLM call (same posture as workflows/matcher).
// Only `active` procedures are ever surfaced — drafts await review and
// deprecated ones are history.

export interface ProcedureMatch {
  procedure: Procedure
  score: number
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

export function matchProcedures(
  message: string,
  procedures: Procedure[],
  opts: { limit?: number; minScore?: number } = {},
): ProcedureMatch[] {
  const limit = Math.max(1, opts.limit ?? 3)
  const minScore = opts.minScore ?? 0.2
  const messageWords = words(message)
  const matches: ProcedureMatch[] = []

  for (const p of procedures) {
    if (p.meta.status !== "active") continue
    const reasons: string[] = []
    // Trigger text is the primary signal — it literally describes when the
    // procedure applies. Title/tags/inputs corroborate.
    const triggerScore = overlap(messageWords, words(p.meta.trigger))
    if (triggerScore > 0) reasons.push("trigger")
    const metaText = [p.meta.id, p.meta.title, ...p.meta.tags, ...p.meta.inputs].join(" ")
    const metaScore = overlap(messageWords, words(metaText))
    if (metaScore > 0) reasons.push("title/tags")
    const score = Math.min(1, triggerScore * 0.7 + metaScore * 0.5)
    if (score >= minScore) matches.push({ procedure: p, score, reasons })
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Render matched procedures as an instruction block for agent context.
 *  Kept terse — this rides inside a token-budgeted context layer. */
export function renderProcedureContext(matches: ProcedureMatch[]): string {
  const sections = matches.map((m) => {
    const p = m.procedure
    const lines = [`[Known procedure: ${p.meta.title}]`, p.meta.trigger]
    if (p.meta.inputs.length) lines.push(`Inputs: ${p.meta.inputs.join(", ")}`)
    lines.push(p.body)
    if (p.meta.expected) lines.push(`Done when: ${p.meta.expected}`)
    lines.push(`(details: agentx procedure show ${p.meta.id})`)
    return lines.join("\n")
  })
  return [
    "The user's request matches an established procedure. Follow its steps unless the user asks otherwise — they encode the known-good path.",
    ...sections,
  ].join("\n\n")
}
