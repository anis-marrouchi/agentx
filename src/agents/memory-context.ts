import { daysSince, needsRecheck, ageDays, VERIFY_OR_ASK_RULE } from "./fact-freshness"
import { isStaleFact, matchFact, type WikiFact } from "@/wiki/facts/ledger"
import type { MemoryFact } from "./memory-store"

// --- The Agent Memory block: flag stale lines, reference the wiki ---
//
// Two rules from #273 apply when memory is rendered into a prompt:
//   - a volatile fact past its TTL is marked UNVERIFIED, with the
//     verify-or-ask rule once at the top of the block;
//   - a memory line that restates a wiki fact is replaced by a reference
//     to that fact, which carries its source and check date. Several lines
//     about one fact become one reference, so the copy never outranks the
//     source and the block gets shorter, not longer.

export const MEMORY_HEADER = "[Agent Memory — persistent facts from past conversations]"
const BUDGET = 2400

export interface ContextLine {
  fact: MemoryFact
  line: string
  unverified: boolean
  /** The wiki fact rendered instead of the memory line. */
  wikiRef?: string
}

function flag(unverified: boolean, age: number | null): string {
  return unverified ? `UNVERIFIED (${age === null ? "age unknown" : `${age}d old`}) ` : ""
}

export function wikiRefLine(f: WikiFact, now = Date.now()): { line: string; unverified: boolean } {
  const unverified = isStaleFact(f, now)
  const line = `- [wiki ${f.id}] ${flag(unverified, daysSince(f.verifiedAt, now))}` +
    `${f.subject} · ${f.attribute}: ${f.value} (${f.source}, checked ${f.verifiedAt.slice(0, 10)} by ${f.verifiedBy})`
  return { line, unverified }
}

function memoryLine(m: MemoryFact, now: number): { line: string; unverified: boolean } {
  const isDM = !m.source.chatId.startsWith("-") && /^\d+$/.test(m.source.chatId)
  const scope = isDM ? "DM" : m.source.chatId
  const unverified = needsRecheck(m, now)
  return { line: `- [${m.category}] ${flag(unverified, ageDays(m, now))}${m.content} (${scope}, ${m.source.date})`, unverified }
}

/** The lines the memory block renders, within its character budget. */
export function memoryContextLines(memories: MemoryFact[], wikiFacts: WikiFact[] = [], now = Date.now()): ContextLine[] {
  const kept: ContextLine[] = []
  const referenced = new Set<string>()
  let chars = MEMORY_HEADER.length
  let ruleCounted = false

  for (const m of memories) {
    const wf = wikiFacts.length > 0 ? matchFact(m.content, wikiFacts) : null
    let rendered: { line: string; unverified: boolean }
    let wikiRef: string | undefined
    // A memory written after the wiki's last check that says something
    // else may be news; it stays, marked, rather than being hidden.
    const newerNews = wf
      && Date.parse(m.createdAt) > Date.parse(wf.verifiedAt)
      && !m.content.toLowerCase().includes(wf.value.toLowerCase())
    if (wf && !newerNews) {
      if (referenced.has(wf.id)) continue
      referenced.add(wf.id)
      rendered = wikiRefLine(wf, now)
      wikiRef = wf.id
    } else {
      rendered = memoryLine(m, now)
      if (wf) rendered.line += ` [differs from wiki ${wf.id}]`
    }

    const extra = rendered.unverified && !ruleCounted ? VERIFY_OR_ASK_RULE.length : 0
    if (chars + extra + rendered.line.length > BUDGET) break
    kept.push({ fact: m, ...rendered, ...(wikiRef ? { wikiRef } : {}) })
    chars += extra + rendered.line.length
    if (extra) ruleCounted = true
  }
  return kept
}

export function renderMemoryBlock(kept: ContextLine[]): string {
  if (kept.length === 0) return ""
  const rule = kept.some((l) => l.unverified) ? [VERIFY_OR_ASK_RULE] : []
  return [MEMORY_HEADER, ...rule, ...kept.map((l) => l.line), "[End Memory]"].join("\n")
}
