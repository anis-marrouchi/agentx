// --- Hub layout gaps (#2101 P2): one post per item ---
//
// R10 "No duplicate posts": the feed showed the same "Check #2101 PR 1c"
// post three times. They were three records (three promises with the same
// headline, made by retries), not one record drawn three times. The feed
// now shows one post per item: open posts of one owner with the same
// headline fold into the newest, which says how many more there are and
// links them. Closed posts never fold: a done copy is history, not noise.
//
// R3 "Needs you first, short" had a box here; R27 took it out of the side
// menu, where the agent list's Needs you group and Desk's count say it once.
//
// Shipped to the browser through injectFns (see ../inject.ts): each
// function is self-contained, and the escaper and age format are passed
// in, never imported (an import is not bound in the browser).

/** What the fold reads of a Hub post. */
export interface WsPost {
  id: string
  owner?: string
  headline?: string
  lastMoveAt?: number
  /** Set by wsFold on the post it keeps: the ids it folded into it. */
  copies?: string[]
}

/** The fold key: owner and first headline line, case and spaces ignored. */
export function wsKey(p: WsPost): string {
  const h = String((p && p.headline) || "").split("\n")[0].trim().toLowerCase().replace(/\s+/g, " ")
  return h ? String(p.owner || "") + "|" + h : ""
}

/**
 * One post per item (R10). Open posts (`open(p)`) of one owner with the
 * same headline become one: the one that moved last stays, in its own
 * place, as a copy carrying `copies` (the others' ids, newest first).
 * The input is not changed.
 */
export function wsFold<T extends WsPost>(posts: T[], open: (p: T) => boolean): T[] {
  const groups: Record<string, T[]> = {}
  for (const p of posts || []) {
    const k = open(p) ? wsKey(p) : ""
    if (k) (groups[k] = groups[k] || []).push(p)
  }
  const kept: Record<string, T> = {}
  for (const k of Object.keys(groups)) {
    const g = groups[k]
    if (g.length < 2) continue
    const sorted = g.slice().sort((a, b) => (b.lastMoveAt || 0) - (a.lastMoveAt || 0))
    kept[sorted[0].id] = { ...sorted[0], copies: sorted.slice(1).map((p) => p.id) }
    for (const p of sorted.slice(1)) kept[p.id] = null as unknown as T
  }
  const out: T[] = []
  for (const p of posts || []) {
    if (!(p.id in kept)) out.push(p)
    else if (kept[p.id]) out.push(kept[p.id])
  }
  return out
}

/** The line a folded post carries: "2 more posts like this", each linked. */
export function wsCopiesHtml(p: WsPost, esc: (s: unknown) => string): string {
  const c = (p && p.copies) || []
  if (!c.length) return ""
  return '<div class="wp__copies">' + c.length + (c.length === 1 ? " more post" : " more posts") + " like this: " +
    c.map((id) => '<a href="#status=open&amp;post=' + encodeURIComponent(id) + '" data-open="' + esc(id) + '">' + esc(id) + "</a>").join(", ") + "</div>"
}
