// --- Sourced answers (#1288) ---
//
// Lead research and the daily sales brief must cite where every fact came
// from. A model asked to "add sources" mostly does, and the lines it forgets
// read exactly like the ones it did not: so the check is code, run on the
// answer before it reaches the owner (a schedule's `requireSources`).
//
// A claim is any line of the answer that states something: a list item, a
// table row or a line of prose. Not claims: headings, lines that end in a
// colon (they introduce a list), "Summary:" lines (counts of what follows),
// "No …"/"None"/"Nothing …" lines (nothing to report), rules, table
// header and separator rows, and code blocks. A claim is sourced when it
// carries an http(s) link, or a link to a markdown file in the workspace
// such as `[leads.md](leads.md)`, the team's own record of a lead.

export interface UnsourcedClaim {
  /** 1-based line number in the answer. */
  line: number
  text: string
}

const URL_RE = /\bhttps?:\/\/[^\s<>()\]]+/i
const LOCAL_LINK_RE = /\[[^\]]+\]\((?!https?:)[\w./-]+\.md\)/i

/** True when `line` carries a source: an http(s) URL or a link to a workspace .md file. */
export function hasSource(line: string): boolean {
  return URL_RE.test(line) || LOCAL_LINK_RE.test(line)
}

const TABLE_SEPARATOR = /^\|?[\s:|-]+\|[\s:|-]*$/

function isClaim(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/^#{1,6}\s/.test(t)) return false
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return false
  if (TABLE_SEPARATOR.test(t)) return false
  if (/:\s*$/.test(t.replace(/[*_]+$/, ""))) return false
  const bare = t.replace(/^([-*+]|\d+[.)])\s+/, "").replace(/^[*_]+/, "")
  if (/^summary:/i.test(bare)) return false
  if (/^(no|none|nothing)\b/i.test(bare)) return false
  return true
}

/** The lines of `text` that state something without a source. */
export function unsourcedClaims(text: string): UnsourcedClaim[] {
  const out: UnsourcedClaim[] = []
  let fence = false
  const lines = text.split("\n")
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return }
    if (fence || !isClaim(raw) || hasSource(raw)) return
    // A table's header row names its columns.
    if (raw.trim().startsWith("|") && TABLE_SEPARATOR.test((lines[i + 1] ?? "").trim())) return
    out.push({ line: i + 1, text: raw.trim() })
  })
  return out
}

/** How many unsourced lines the warning lists before "and N more". */
const LISTED = 5

/**
 * `text` as delivered to the owner: unchanged when every claim has a
 * source, else followed by a warning that names the lines without one.
 * The answer is still sent; the owner decides what to do with it.
 */
export function withSourceWarning(text: string): { text: string; unsourced: number } {
  const missing = unsourcedClaims(text)
  if (!missing.length) return { text, unsourced: 0 }
  const shown = missing.slice(0, LISTED).map((c) => `- line ${c.line}: ${c.text.length > 80 ? c.text.slice(0, 79) + "…" : c.text}`)
  if (missing.length > LISTED) shown.push(`- and ${missing.length - LISTED} more`)
  const head = missing.length === 1 ? "1 line above has no source." : `${missing.length} lines above have no source.`
  return {
    text: `${text.trimEnd()}\n\n---\n⚠ ${head} Check before you rely on it:\n${shown.join("\n")}`,
    unsourced: missing.length,
  }
}
