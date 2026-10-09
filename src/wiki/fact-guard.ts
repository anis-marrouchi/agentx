import { droppedFacts } from "./absorb-context"

// --- Fact-loss guard for edits to an existing article (#824) ---
//
// A fleet test found page rewrites had dropped a contact's phone number
// and their "main contact" role. `droppedFacts` already guards absorb
// against losing commits, links and numbers; this adds the structured
// facts a person page carries in words: email addresses, roles and
// contact markers. Every edit path that changes an existing article
// (`wiki patch`, the daily contribution merge) runs it and holds the
// change instead of saving it silently.

/** Phrases that mark a person's standing; losing one loses a fact. */
const CONTACT_MARKERS = [
  "main contact",
  "primary contact",
  "point of contact",
  "billing contact",
  "technical contact",
  "decision maker",
]

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const ROLE_RE = /\b(role|title|position|job)\s*\**\s*[:：]\s*\**\s*([^\n;|]+)/gi

/**
 * Structured facts `before` carries that `after` no longer does.
 *
 * `superseded` lists values the edit replaces on purpose (a checked
 * correction keeps the old value in the fact ledger's history and the
 * page's version history), so they don't count as lost.
 */
export function lostStructuredFacts(before: string, after: string, superseded: string[] = []): string[] {
  const kept = [after, ...superseded].join("\n")
  const keptLower = kept.toLowerCase()
  const lost = droppedFacts(before, kept)

  for (const email of unique(before.match(EMAIL_RE) ?? [])) {
    if (!keptLower.includes(email.toLowerCase())) lost.push(`email ${email}`)
  }
  const beforeLower = before.toLowerCase()
  for (const marker of CONTACT_MARKERS) {
    if (beforeLower.includes(marker) && !keptLower.includes(marker)) lost.push(`marker "${marker}"`)
  }
  for (const m of before.matchAll(ROLE_RE)) {
    const role = m[2].replace(/\*+/g, "").trim()
    if (role && !keptLower.includes(role.toLowerCase())) lost.push(`${m[1].toLowerCase()} "${role}"`)
  }
  return unique(lost)
}

function unique(list: string[]): string[] {
  return [...new Set(list)]
}

/** Below this share of the old line count, an edit is a rewrite. */
const MIN_KEPT_LINES = 0.9

/** The model talking about its task instead of writing the article. */
const CHATTER_RE = /^\s*(?:wait\b|here(?:'s| is) the (?:updated|modified|patched|revised)|i (?:must|need to|will|should) (?:output|return|write)|(?:okay|ok|sure)[,.!]\s|let me\b|as requested\b)/im

/**
 * Why an LLM-applied patch to an existing article must not be saved
 * as it is. Empty means it looks like the small edit it was asked for.
 *
 * The fleet test behind #824 found `wiki patch` doing four things a
 * patch must not: replacing the whole body with just the new section
 * (33 → 4 lines), pasting its own reasoning into the page ("Wait — I
 * must output the full article body"), duplicating header lines, and
 * dropping facts. Each is checked here.
 */
export function patchProblems(before: string, after: string): string[] {
  const problems: string[] = []
  const oldLines = before.split("\n").filter((l) => l.trim()).length
  const newLines = after.split("\n").filter((l) => l.trim()).length
  if (oldLines >= 5 && newLines < Math.floor(oldLines * MIN_KEPT_LINES)) {
    problems.push(`the article shrinks from ${oldLines} to ${newLines} lines`)
  }
  const chatter = after.match(CHATTER_RE)
  if (chatter && !before.match(CHATTER_RE)) problems.push(`it contains the model's own commentary ("${chatter[0].trim().slice(0, 40)}")`)
  const headings = (text: string) => {
    const n = new Map<string, number>()
    for (const l of text.split("\n")) if (/^#{1,6} /.test(l)) n.set(l.trim(), (n.get(l.trim()) ?? 0) + 1)
    return n
  }
  const was = headings(before)
  for (const [h, count] of headings(after)) {
    if (count > 1 && count > (was.get(h) ?? 0)) problems.push(`the heading "${h}" appears ${count} times`)
  }
  const lost = lostStructuredFacts(before, after)
  if (lost.length) problems.push(`it drops ${lost.length} fact(s): ${lost.slice(0, 6).join(", ")}${lost.length > 6 ? ", …" : ""}`)
  return problems
}
