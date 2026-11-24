// --- Hub layout gaps (#2101 P2): one post per item, Needs you first ---
//
// R10 "No duplicate posts": the feed showed the same "Check #2101 PR 1c"
// post three times. They were three records (three promises with the same
// headline, made by retries), not one record drawn three times. The feed
// now shows one post per item: open posts of one owner with the same
// headline fold into the newest, which says how many more there are and
// links them. Closed posts never fold: a done copy is history, not noise.
//
// R3 "Needs you first, short": Orca puts "Waiting for input" at the top,
// in red. The Hub's left column now opens with the oldest five things that
// wait on the owner, from the same list and count as the Needs you page
// (/api/admin/approvals, wall-decide.client.ts), and "Show all N".
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

/** What the Needs you box reads of one waiting item (decAll in wall-decide). */
export interface WsNeed {
  key: string
  title?: string
  agent?: string
  /** When it was asked, ms; 0 when unknown. */
  at?: number
  /** Put off (Later): not shown, as on the Needs you page's Waiting tab. */
  snoozed?: number
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

/**
 * The Needs you box at the top of the left column (R3): the oldest five
 * waiting items, then "Show all N". `total` is the Needs you count (so it
 * matches the nav and the page); nothing is drawn when it is 0. `who` is
 * "you", or "the owner" for anyone else.
 */
export function wsNeedsHtml(items: WsNeed[], total: number, who: string, href: string, now: number,
  esc: (s: unknown) => string, age: (ms: number) => string, nameOf: (id: string) => string): string {
  const waiting = (items || []).filter((i) => i && !i.snoozed)
    .sort((a, b) => (a.at || Infinity) - (b.at || Infinity))
  const n = Math.max(total || 0, waiting.length)
  if (!n) return ""
  const rows = waiting.slice(0, 5).map((i) => {
    const when = i.at ? '<time>' + esc(age(Math.max(0, now - i.at))) + "</time>" : ""
    const sub = [i.agent ? esc(nameOf(i.agent)) : "", when].filter(Boolean).join(" · ")
    return '<a class="lt__row lt__need" href="' + esc(href) + '" title="' + esc((i.agent ? nameOf(i.agent) + ": " : "") + (i.title || "")) + '">' +
      '<span class="lt__dot lt__dot--need" role="img" aria-label="needs ' + esc(who) + '"></span>' +
      '<span class="lt__txt"><span class="lt__title">' + esc(i.title || "A question") + '</span><span class="lt__sub">' + sub + "</span></span></a>"
  }).join("")
  const all = n > 5 || n > waiting.length ? '<a class="lt__more" href="' + esc(href) + '">Show all ' + n + "</a>" : ""
  return '<h2 class="lt__h lt__h--need" id="wall-needs-h">Needs ' + esc(who) + ' <b class="lt__badge is-need" title="' + n + ' waiting">' + n + "</b></h2>" + rows + all
}
