// --- The feed and its List view: states, tabs, counts, time, keyed paint (#2101) ---
//
// The pure half of the Hub's main feed, injected into WALL_PAGE_SCRIPT
// (injectFns), so each function must stand alone: no module constants.
// From the approved mock and orca-design (recipes.md §8 and §9, C17, C27,
// C28):
//   - one state set, in one order, for every row, group and tab: a post is
//     Waiting on you, Failed, Working, Waiting, Not started, Cancelled or
//     Done (fdState); groups follow that order, what needs you first;
//   - the status tabs count the posts the other filters leave (fdCounts),
//     so a count never says more than the tab shows;
//   - one relative time, now / 2m / 1h / 2d (fdAgo);
//   - live lists patch rows by key (fdPatch): a refresh replaces only the
//     rows that changed, keeps focus where it was and leaves a row with an
//     open menu alone, so nothing re-animates and nothing jumps.

export interface FdPostLike {
  state: string
  runs?: number
  ownerCards?: unknown[] | null
  lastFailure?: unknown | null
}

export interface FdStateInfo { order: number; icon: string; word: string; tone: string }

/** The one state set (orca-design recipes.md §9): order, lucide icon, word
 *  and tone. Tone names a colour role, never a colour: warn, err, text,
 *  muted, ok. Only Failed is red; Done colours its icon only. */
export function fdStates(): Record<string, FdStateInfo> {
  return {
    needs: { order: 1, icon: "circle-alert", word: "Waiting on you", tone: "warn" },
    failed: { order: 2, icon: "circle-x", word: "Failed", tone: "err" },
    working: { order: 3, icon: "loader-circle", word: "Working", tone: "text" },
    waiting: { order: 4, icon: "clock", word: "Waiting", tone: "muted" },
    notstarted: { order: 5, icon: "circle-dashed", word: "Not started", tone: "muted" },
    cancelled: { order: 7, icon: "ban", word: "Cancelled", tone: "muted" },
    done: { order: 8, icon: "circle-check", word: "Done", tone: "ok" },
  }
}

/** A post's state in the set above. `live`: one of its runs runs now. */
export function fdState(p: FdPostLike, live: boolean): string {
  const open = ["in_progress", "waiting_owner", "waiting_other", "needs_attention"].indexOf(p.state) >= 0
  if (!open) return p.state === "done" ? "done" : "cancelled"
  if (p.state === "waiting_owner" || (p.ownerCards && p.ownerCards.length)) return "needs"
  if (p.state === "needs_attention") return "failed"
  if (live) return "working"
  if (p.lastFailure) return "failed"
  if (p.state === "waiting_other") return "waiting"
  return (p.runs || 0) > 0 ? "working" : "notstarted"
}

/** The feed group a state sits in: Failed sits under Needs you, as the
 *  mock and recipes.md §9 say. Groups come in fdStates() order. */
export function fdGroupOf(state: string): string {
  return state === "failed" ? "needs" : state
}

/** The group's title. */
export function fdGroupTitle(group: string): string {
  const t: Record<string, string> = { needs: "Needs you", working: "Working", waiting: "Waiting", notstarted: "Not started", cancelled: "Cancelled", done: "Done" }
  return t[group] || group
}

/** Does a post in `state` belong under the status tab `tab` (its filter
 *  value)? Open is every open state; Waiting is on you or on others. */
export function fdInTab(state: string, tab: string): boolean {
  if (tab === "") return true
  if (tab === "open") return state !== "done" && state !== "cancelled"
  if (tab === "in_progress") return state === "working"
  if (tab === "waiting") return state === "needs" || state === "waiting"
  if (tab === "failed") return state === "failed"
  if (tab === "done") return state === "done"
  return false
}

/** Each tab's count over the states of the posts the other filters leave. */
export function fdCounts(states: string[], tabs: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of tabs) out[t] = states.filter((s) => fdInTab(s, t)).length
  return out
}

/** One relative time for the whole feed: now, 2m, 1h, 2d (C17). */
export function fdAgo(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}

/** "10:04", the local clock time of a sync. */
export function fdClock(ms: number): string {
  const d = new Date(ms)
  return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes()
}

/** Rows in order of one column: `val` reads the column, `dir` 1 rising,
 *  -1 falling. Ties keep their order, so a refresh does not shuffle. */
export function fdSortBy<T>(rows: T[], val: (r: T) => unknown, dir: number): T[] {
  return rows.map((r, i) => ({ r, i, v: val(r) as never })).sort((a, b) => {
    const x = a.v, y = b.v
    const c = x > y ? 1 : x < y ? -1 : 0
    return c ? c * dir : a.i - b.i
  }).map((x) => x.r)
}

/** What fdPatch needs of an element: the DOM's own methods. */
export interface FdEl {
  children: ArrayLike<FdEl>
  getAttribute(k: string): string | null
  insertBefore(el: FdEl, ref: FdEl | null): unknown
  removeChild(el: FdEl): unknown
  replaceChild(el: FdEl, old: FdEl): unknown
  contains(el: unknown): boolean
  querySelector(sel: string): (FdEl & { focus?: () => void }) | null
  focus?: () => void
  _fdHtml?: string
}

/** Puts `items` (each a key and its markup, one element) into `box` in
 *  order, touching only what changed: a row whose markup is the same is
 *  kept as it is; a changed row is swapped, unless it has an open menu
 *  (aria-expanded="true" inside: it waits for the next refresh); the focus
 *  moves to the new row's control with the same data-fk; rows no longer
 *  listed go. `make` turns markup into one element. Says what it did. */
export function fdPatch(box: FdEl, items: Array<{ key: string; html: string }>, make: (html: string) => FdEl, doc?: { activeElement?: unknown }): { added: number; changed: number; kept: number; removed: number } {
  const n = { added: 0, changed: 0, kept: 0, removed: 0 }
  const have: Record<string, FdEl> = {}
  for (let i = 0; i < box.children.length; i++) {
    const c = box.children[i]
    const k = c.getAttribute("data-key")
    if (k != null) have[k] = c
  }
  const want: Record<string, boolean> = {}
  items.forEach((it, i) => {
    want[it.key] = true
    let el = have[it.key]
    if (el && (el._fdHtml === it.html || el.querySelector('[aria-expanded="true"]'))) n.kept++
    else {
      const next = make(it.html)
      next._fdHtml = it.html
      if (el) {
        const active = doc && (doc.activeElement as FdEl | null | undefined)
        const fk = active && el.contains(active) ? (active === el ? "" : active.getAttribute("data-fk")) : null
        box.replaceChild(next, el)
        n.changed++
        if (fk === "" && next.focus) next.focus()
        else if (fk) { const f = next.querySelector('[data-fk="' + fk + '"]'); if (f && f.focus) f.focus() }
      } else n.added++
      el = next
      have[it.key] = el
    }
    const at = i < box.children.length ? box.children[i] : null
    if (at !== el) box.insertBefore(el, at)
  })
  for (let i = box.children.length - 1; i >= 0; i--) {
    const c = box.children[i]
    const k = c.getAttribute("data-key")
    if (k == null || !want[k]) { box.removeChild(c); n.removed++ }
  }
  return n
}
