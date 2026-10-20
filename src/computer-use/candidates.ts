import type { UICandidate } from "@/decisions/seats/ui-element"

// --- Choosing what the model is allowed to pick from ---
//
// In a browser the accessibility tree holds two unrelated interfaces: the
// page, and the browser wrapped around it. Ask for "the search box" on X
// with both in scope, unmarked, and "Address and search bar" wins at 0.97
// confidence — Chrome's URL bar, and the wrong answer given confidently.
//
// Dropping the browser's controls fixed that and broke the opposite ask.
// In a 20-target race on the dashboard (#1092), 8 of point's 12 misses were
// the browser's own controls (reload, the star, the tab's close button, the
// window's traffic lights), and they were never offered at all.
//
// So both stay, and the browser's controls say what they are ("outside
// the page: Reload"). A page ask still finds the page's search box. An ask
// about the address bar or the tab finds the browser's control.

export interface RawElement {
  id: number
  role: string
  label: string
  value?: string | null
  enabled: boolean
  parent: number
  x: number
  y: number
  width: number
  height: number
  /** AXSubrole, when the helper read one. The traffic lights carry no
   *  label but do carry AXCloseButton / AXMinimizeButton / AXZoomButton. */
  subrole?: string | null
}

export const INTERESTING_ROLE =
  /^AX(Button|MenuItem|MenuButton|TextField|TextArea|CheckBox|RadioButton|PopUpButton|Link|Tab(?!le)|Row|Cell|ComboBox|SearchField|Slider|Disclosure|Toolbar|StaticText|Image|ColorWell)/

/** Ids of everything inside a web area. Empty for a native app. */
function pageIds(elements: RawElement[]): Set<number> {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const rootIds = new Set(elements.filter((e) => e.role === "AXWebArea").map((e) => e.id))
  const inside = new Set<number>()
  if (rootIds.size === 0) return inside
  for (const e of elements) {
    let cur: RawElement | undefined = e
    // Bounded walk: a malformed parent chain must not spin forever.
    for (let hops = 0; cur && hops < 64; hops++) {
      if (rootIds.has(cur.id)) { inside.add(e.id); break }
      if (cur.parent < 0) break
      cur = byId.get(cur.parent)
    }
  }
  return inside
}

/**
 * Split a browser's tree into the page and the browser around it.
 *
 * Identified structurally by the presence of a web area, not by app name:
 * name matching would miss every browser nobody thought to list. A native
 * app, or a browser whose web area is empty, is all page and no browser.
 */
export function splitPage(elements: RawElement[]): { page: RawElement[]; browser: RawElement[] } {
  const inside = pageIds(elements)
  const page = elements.filter((e) => inside.has(e.id))
  if (page.length < 2) return { page: elements, browser: [] }
  return { page, browser: elements.filter((e) => !inside.has(e.id)) }
}

/** The page alone, when this is a browser. Kept for callers that only
 *  ever want the page (reading it aloud, teaching from it). */
export function scopeToPage(elements: RawElement[]): RawElement[] {
  return splitPage(elements).page
}

/** A window button's name, from its subrole. Used even over a label: the
 *  green one is labelled with help text ("this button also has an action
 *  to zoom the window"), which never says which light it is. */
function subroleName(subrole: string | null | undefined): string {
  const named: Record<string, string> = {
    AXCloseButton: "close window (red traffic light)",
    AXMinimizeButton: "minimise window (yellow traffic light)",
    AXZoomButton: "zoom window (green traffic light)",
    AXFullScreenButton: "full screen (green traffic light)",
  }
  return subrole ? named[subrole] ?? "" : ""
}

/**
 * A drawing app's canvas (tldraw, Figma, Excalidraw) is one unnamed image
 * covering most of the page. It is where shapes and text are placed, so
 * it is offered as "canvas". Small images are icons and charts, offered
 * as images in the last tier.
 */
function isCanvas(e: RawElement, page: RawElement[]): boolean {
  if (e.role !== "AXImage") return false
  const area = Math.max(0, ...page.filter((p) => p.role === "AXWebArea").map((p) => p.width * p.height))
  return area > 0 && e.width * e.height >= area * 0.4
}

/** Container roles the browser reports with a placeholder label. They are
 *  groupings, not controls; their children are offered instead. */
const BROWSER_NOISE = /^AX(Toolbar|TabGroup)$/

/** Words of the request worth matching against labels. */
function requestWords(request: string): string[] {
  const filler = new Set(["the", "a", "an", "of", "on", "in", "to", "at", "for", "and", "or", "this", "that", "my", "button", "icon"])
  return request.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !filler.has(w))
}

/** How many of the request's words a label carries, as whole words or
 *  word prefixes ("restart" matches "Restart when idle"). */
function overlap(label: string, words: string[]): number {
  if (!words.length) return 0
  const have = label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return words.filter((w) => have.some((h) => h === w || (w.length >= 4 && h.startsWith(w)))).length
}

export interface CandidateOptions {
  /** What the person asked for. Lets labels that share its words survive
   *  the cap on a long page. */
  request?: string
}

/**
 * The set handed to the model: interesting roles only, visible, capped,
 * with a browser's own controls marked as such.
 *
 * Unlabelled controls are kept and described by subrole or role — window
 * buttons carry no label on macOS, and dropping everything unnamed
 * removes the controls people most often ask for.
 */
export function buildCandidates(elements: RawElement[], max = 60, opts: CandidateOptions = {}): UICandidate[] {
  // Rank before capping.
  //
  // Slicing in tree order drops whatever appears late, and on x.com the
  // search input sits after a sidebar full of navigation links — so the
  // one element every search question is about was never shown to the
  // model at all, and it confidently picked a nav link instead.
  //
  // Text inputs first, then things you press, then images, then text.
  // Within a tier the tree order is kept, so reading position still breaks
  // ties.
  const rank = (role: string): number => {
    if (/^AX(TextField|TextArea|SearchField|ComboBox)/.test(role)) return 0
    if (/^AX(Button|MenuItem|MenuButton|PopUpButton|CheckBox|RadioButton|Tab|Link|ColorWell)/.test(role)) return 1
    if (/^AX(Row|Cell|Slider|Disclosure|Toolbar)/.test(role)) return 2
    // Images before plain text: an icon or a chart is something people
    // point at, a run of text mostly is not.
    if (role === "AXImage") return 3
    return 4
  }
  const usable = (e: RawElement) => e.width >= 1 && e.height >= 1
  // Split first, then dedupe each half: a dropped duplicate may be the
  // parent that ties its children to the web area.
  const split = splitPage(elements)
  const page = dedupe(split.page)
  const browser = dedupe(split.browser)
  const isWeb = browser.length > 0
  const canvas = new Set(page.filter((e) => isCanvas(e, page)).map((e) => e.id))
  const byRank = (list: RawElement[]) => list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (canvas.has(a.e.id) ? 1 : rank(a.e.role)) - (canvas.has(b.e.id) ? 1 : rank(b.e.role)) || a.i - b.i)
    .map(({ e }) => e)
  // Labels sharing the request's words survive the cap first: on a long
  // settings page "Restart when idle" sat past it behind forty other
  // buttons (#1093). A window button is matched by its subrole name too,
  // since it has no label. Only who survives changes; the survivors keep their
  // tier order, so when nothing is cut the model sees the same list.
  const words = requestWords(opts.request ?? "")
  const capped = (ranked: RawElement[], n: number) => {
    if (ranked.length <= n || !words.length) return ranked.slice(0, n)
    const keep = new Set(ranked
      .map((e, i) => ({ e, i, hits: overlap(`${subroleName(e.subrole)} ${e.label} ${e.value ?? ""}`, words) }))
      .sort((a, b) => b.hits - a.hits || a.i - b.i)
      .slice(0, n)
      .map(({ e }) => e.id))
    return ranked.filter((e) => keep.has(e.id))
  }

  // The browser's own controls are few (17 in Chrome) and always the same
  // kind, so they get a few slots first. Ranked into the page's tiers they
  // lose to every link on a busy page and are cut, which is the bug. The
  // reserve is capped so a small caller (teach, at 45) keeps most of its
  // slots for the page.
  const own = capped(byRank(browser.filter((e) => INTERESTING_ROLE.test(e.role) && !BROWSER_NOISE.test(e.role) && usable(e))),
    Math.min(20, Math.floor(max / 4)))

  const fromPage = capped(byRank(page.filter((e) => (INTERESTING_ROLE.test(e.role) || canvas.has(e.id)) && usable(e))),
    max - own.length)

  const outside = new Set(own.map((e) => e.id))
  const frame = elements.find((e) => e.role === "AXWindow") ?? null
  const chosen = [...fromPage, ...own]
  const times = new Map<string, number>()
  for (const e of chosen) times.set(named(e), (times.get(named(e)) ?? 0) + 1)
  return chosen.map((e, i) => {
    // `label` stays the control's own name, as the app reports it: lesson
    // steps check a click against it (`click --expect`), so it must be
    // text the screen really carries.
    const label = canvas.has(e.id) ? "canvas" : (e.label || e.value || "").trim() || `${e.role.replace(/^AX/, "")} ${i + 1}`
    // `shown` is what the model reads instead, when there is more to say.
    const own = named(e)
    let name = canvas.has(e.id) ? "canvas" : subroleName(e.subrole) || own || innerText(e, elements) || unnamed(e, i)
    // Five cards each with a "history →" and an unnamed chart: the name
    // alone cannot say which card the request means, the card's title can.
    // Only inside a web page, where reading order follows the layout.
    if (isWeb && !outside.has(e.id) && !canvas.has(e.id) && (!own || (times.get(own) ?? 0) > 1)) {
      const ctx = blockTitle(e, page)
      if (ctx) name = `${name} in "${ctx}"`
    }
    // First, so no clipping can cut it: this is the browser's or the
    // app's own control, not one on the page.
    if (outside.has(e.id)) name = `outside the page: ${name}`
    return {
      id: e.id,
      role: e.role,
      label,
      ...(name !== label ? { shown: name } : {}),
      value: e.value ?? null,
      enabled: e.enabled,
      ...(frame ? { where: region(e, frame) } : {}),
      ...(outside.has(e.id) ? { area: "browser" as const } : {}),
      ...(closes(e, isWeb && !outside.has(e.id)) ? { closes: true as const } : {}),
    }
  })
}

// --- Close, quit: never by accident ---
//
// Offering the red light and the tab's close button is what made "close
// this tab" findable (#1092). It also put them one wrong pick away from
// any other ask: "Bookmark this page" landing on the tab's x loses the page.
// So a control that closes something is marked, and only a request that
// asks to close something may land on it.

/** Does pressing it close a window or tab, or quit the app? By subrole
 *  for the red light, else by name: Chrome's tab x is "Close", the menus
 *  say "Close Tab", "Close Window", "Quit Google Chrome". A web page's own
 *  "Close" shuts a dialog on the page, not the page, so it is not marked. */
function closes(e: RawElement, onPage: boolean): boolean {
  if (e.subrole === "AXCloseButton") return true
  return !onPage && /^(close|quit)\b/i.test(named(e))
}

/** Does the request ask to close or quit something? */
export function asksToClose(request: string): boolean {
  return /\b(close|closing|quit|exit|shut)\b/i.test(request)
}

/** True when the pick closes something the request never asked to close:
 *  return it as a candidate and stop, never press or point at it. */
export function closeBlocked(chosen: { closes?: boolean } | null | undefined, request: string): boolean {
  return chosen?.closes === true && !asksToClose(request)
}

/** One entry per thing on screen. Wikipedia's infobox is in the tree three
 *  times over, same role, same name, same place, and each copy spent a
 *  slot the cap could have given to something else. */
function dedupe(elements: RawElement[]): RawElement[] {
  const seen = new Set<string>()
  return elements.filter((e) => {
    if (e.role === "AXWebArea" || e.role === "AXWindow") return true
    const key = `${e.role}|${e.label}|${e.value ?? ""}|${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.width)},${Math.round(e.height)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The element's own name. Chrome reports "0" for an unnamed DOM node,
 *  which hid every chart and most text on the dashboard behind the same
 *  meaningless label. */
function named(e: RawElement): string {
  const real = (s: string | null | undefined) => {
    const t = (s ?? "").trim()
    return t && t !== "0" ? t : ""
  }
  return real(e.label) || real(e.value)
}

/** A row or cell that names nothing itself is named by the text inside
 *  it. Finder's sidebar rows are unlabelled; "Downloads" is a child. */
function innerText(e: RawElement, all: RawElement[]): string {
  if (!/^AX(Row|Cell)$/.test(e.role)) return ""
  const inside = new Set([e.id])
  for (const x of all) {
    if (!inside.has(x.parent)) continue
    inside.add(x.id)
    if (x.role === "AXStaticText" || x.role === "AXTextField") {
      const t = named(x)
      if (t) return t
    }
  }
  return ""
}

/** What to call a control with no name at all. An unnamed image is
 *  almost always an icon or a chart, and saying so lets the model match
 *  "the sparkline" to it; "Image 30" reads as nothing in particular. */
function unnamed(e: RawElement, i: number): string {
  if (e.role === "AXImage") return `unlabelled ${e.width > 3 * e.height ? "chart or graphic" : "icon or image"} ${i + 1}`
  return `${e.role.replace(/^AX/, "")} ${i + 1}`
}

/** The title of the visual block an element sits in, e.g. its card.
 *
 *  Web trees are often flat, so the hierarchy cannot say which card a
 *  button belongs to. Reading order can: walking back from the element,
 *  a block's contents rise up the screen towards its title, and the walk
 *  has left the block when the next element is suddenly lower down, off
 *  to the right (the end of the previous card) or far above. The first text of the block is
 *  its title. */
function blockTitle(e: RawElement, page: RawElement[]): string {
  const at = page.findIndex((p) => p.id === e.id)
  if (at < 0) return ""
  let top = at
  let prevY = e.y
  let right = e.x + e.width
  for (let i = at - 1; i >= 0 && at - i <= 20; i--) {
    const p = page[i]
    if (!INTERESTING_ROLE.test(p.role)) continue
    // Lower down, far above, or off to the right: another block.
    if (p.y > prevY + 10 || e.y - p.y > 300 || p.x > right + 20) break
    top = i
    prevY = p.y
    right = Math.max(right, p.x + p.width)
  }
  const words: string[] = []
  for (let i = top; i < at && words.length < 2; i++) {
    if (page[i].role === "AXStaticText" && named(page[i])) words.push(named(page[i]).slice(0, 40))
  }
  return words.join(" ")
}

/** Which ninth of the window the control sits in, in words.
 *
 *  Not coordinates: those invite the model to guess geometrically. But
 *  people say "the icon at the top right" and "the tab on the right
 *  edge", and without this the model cannot tell two same-named
 *  controls apart by the one thing the request says about them. */
function region(e: RawElement, w: RawElement): string {
  const fx = (e.x + e.width / 2 - w.x) / Math.max(1, w.width)
  const fy = (e.y + e.height / 2 - w.y) / Math.max(1, w.height)
  const col = fx < 1 / 3 ? "left" : fx > 2 / 3 ? "right" : ""
  const row = fy < 1 / 3 ? "top" : fy > 2 / 3 ? "bottom" : ""
  return [row, col].filter(Boolean).join(" ") || "middle"
}
