// --- Smart truncation ---
//
// Hard `.slice(0, N)` cuts words and lines at arbitrary offsets, which turns
// multi-line webhook bodies (GitLab pipeline events, MR descriptions, long
// agent responses) into visibly-broken fragments in Telegram notifications.
// Prefer a line boundary, fall back to a word boundary, only hard-cut as
// last resort. Append "…" only when truncation actually happened.

export function ellipsize(text: string, maxChars: number, ellipsis: string = "…"): string {
  if (!text) return ""
  if (text.length <= maxChars) return text

  const budget = maxChars - ellipsis.length
  if (budget <= 0) return text.slice(0, maxChars)

  const slice = text.slice(0, budget)

  // Prefer the last line break if it's past 60% of the budget — keeps
  // multi-line bodies readable instead of chopping mid-line.
  const nl = slice.lastIndexOf("\n")
  if (nl > budget * 0.6) return slice.slice(0, nl) + "\n" + ellipsis

  // Fall back to the last word boundary past 60% of the budget.
  const sp = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\t"))
  if (sp > budget * 0.6) return slice.slice(0, sp) + ellipsis

  return slice + ellipsis
}

/**
 * Take the first `maxLines` lines, then ellipsize the result to `maxChars`.
 * Useful for multi-line event bodies where only the summary lines matter.
 */
export function firstLines(text: string, maxLines: number, maxChars: number): string {
  if (!text) return ""
  const lines = text.split("\n")
  const picked = lines.slice(0, maxLines).join("\n")
  return ellipsize(picked, maxChars)
}
