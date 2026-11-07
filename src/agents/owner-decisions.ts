// --- Owner decisions on a fresh session ---
//
// A fresh session (first turn, or after a rotation) is handed the chat's
// recent history and a continuity memo from the session before it. Both
// can be hours old. On 2026-11-07 a rotated session read its own earlier
// reply in the history ("needs your yes on Telegram for five steps") and
// repeated it to the owner, although the owner had removed those yeses an
// hour before and the work had already merged. The wiki held the newer
// decision, but a fresh session only sees the wiki's catalog of titles.
//
// This block puts the newest decision articles, with their rule text,
// ahead of the history and the memo, and says they win where those
// disagree. Fresh sessions only, like the catalog: a resumed session
// already saw it.

import type { WikiArticle } from "@/wiki/types"

export const DECISION_DAYS = 7
export const MAX_DECISIONS = 6
const RULE_CLIP = 1400

/** The rule of a decision article, newest first. Decision pages are often
 *  appended to ("## Update <date> ..." below an older "## Rule"), so the
 *  latest update comes first and the older rule last, marked as older.
 *  With neither heading, the start of the body. */
export function ruleText(content: string): string {
  const body = content.replace(/^---[\s\S]*?\n---\n/, "")
  const sections: Array<{ head: string; text: string }> = []
  const re = /^##\s+([^\n]*)\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm
  for (let m = re.exec(body); m; m = re.exec(body)) sections.push({ head: m[1].trim(), text: m[2] })
  const clean = (t: string) => t.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim()
  const updates = sections.filter((x) => /^(update|change|amend)/i.test(x.head))
  const rule = sections.find((x) => /^rule\b/i.test(x.head) && !/superseded|earlier rule/i.test(x.head))
  let text: string
  if (updates.length) {
    text = [...updates].reverse().map((u) => `${u.head}:\n${clean(u.text)}`).join("\n\n")
    if (rule) text += `\n\nOlder rule (the updates above win where they differ):\n${clean(rule.text)}`
  } else {
    text = clean(rule ? rule.text : body)
  }
  return text.length > RULE_CLIP ? text.slice(0, RULE_CLIP - 1) + "…" : text
}

export function buildOwnerDecisions(articles: WikiArticle[], now: number, opts: { days?: number; max?: number } = {}): string {
  const since = now - (opts.days ?? DECISION_DAYS) * 86_400_000
  const recent = articles
    .filter((a) => a.meta.type === "decision" && !a.path.includes("/_versions/"))
    .map((a) => ({ a, at: Date.parse(a.meta.lastUpdated || a.meta.created || "") }))
    .filter((x) => Number.isFinite(x.at) && x.at >= since)
    .sort((x, y) => y.at - x.at)
    .slice(0, opts.max ?? MAX_DECISIONS)
  if (recent.length === 0) return ""
  return [
    "[Owner decisions — the newest recorded rulings, from the wiki]",
    "These outrank the chat history, the continuity memo and your own notes below. Where those say something else (an approval still needed, a step still waiting), they are out of date: follow these.",
    ...recent.map(({ a }) => `\n### ${a.meta.title} (updated ${a.meta.lastUpdated || a.meta.created})\n${ruleText(a.content)}`),
    "[End owner decisions]",
  ].join("\n")
}
