import type { UICandidate } from "@/decisions/seats/ui-element"

// --- Choosing what the model is allowed to pick from ---
//
// In a browser the accessibility tree holds two unrelated interfaces: the
// page, and the browser wrapped around it. Ask for "the search box" on X
// with both in scope and "Address and search bar" wins at 0.97 confidence
// — Chrome's URL bar, and the wrong answer given confidently. Ask for
// "the Latest tab" and Chrome's "New Tab" button wins.
//
// No prompt fixes that, because neither answer is unreasonable in
// isolation. The candidate set is what is wrong: a question about a page
// should never have been shown the browser's own furniture.
//
// So when the tree contains a web area, the page wins and the chrome is
// dropped. When it does not — a native app — everything stays.
//
// Dropped is not the same as unreachable, though (#1092). Eight of twenty
// misses on a live run were browser parts people really do ask for: the
// bookmark star, the profile avatar, reload, a tab's close button, the red
// window button, site info, tab search. So the chrome comes back in two
// cases, and always marked as the browser's so it cannot pass for page
// content: when the request itself names a browser part, and as a second
// look when nothing on the page matches.

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
}

export const INTERESTING_ROLE =
  /^AX(Button|MenuItem|MenuButton|TextField|TextArea|CheckBox|RadioButton|PopUpButton|Link|Tab|Row|Cell|ComboBox|SearchField|Slider|Disclosure|Toolbar|StaticText)/

/**
 * Requests that are about the browser rather than the page.
 *
 * Deliberately phrases, not single words: "tab" alone would bring Chrome's
 * "New Tab" back for "the Latest tab" on x.com, the very case page-scoping
 * was written for. Anything not named here still reaches the chrome
 * through the second look, once the page has said it has no match.
 */
const BROWSER_PART =
  /\b(browser|chrome'?s?|address bar|url bar|omnibox|location bar|reload|bookmark|star (this|the) page|tab (bar|strip|search)|search tabs|new tab button|close (this |the )?tab|tab'?s? close|traffic lights?|(red|yellow|green) (window )?(button|light|dot)|close window|minimi[sz]e|full ?screen button|site info|site settings|page info|padlock|lock icon|extensions? (menu|button|icon|puzzle))\b/i

export function namesBrowserPart(request: string): boolean {
  return BROWSER_PART.test(request)
}

/** Ids of everything inside a web area, or null when there is none. */
function pageIds(elements: RawElement[]): Set<number> | null {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const rootIds = new Set(elements.filter((e) => e.role === "AXWebArea").map((e) => e.id))
  if (rootIds.size === 0) return null

  const isDescendant = (e: RawElement): boolean => {
    let cur: RawElement | undefined = e
    // Bounded walk: a malformed parent chain must not spin forever.
    for (let hops = 0; cur && hops < 64; hops++) {
      if (rootIds.has(cur.id)) return true
      if (cur.parent < 0) return false
      cur = byId.get(cur.parent)
    }
    return false
  }
  return new Set(elements.filter(isDescendant).map((e) => e.id))
}

/**
 * Restrict to page content when this is a browser.
 *
 * Identified structurally by the presence of a web area, not by app name:
 * name matching would miss every browser nobody thought to list.
 */
export function scopeToPage(elements: RawElement[]): RawElement[] {
  const ids = pageIds(elements)
  if (!ids) return elements
  const page = elements.filter((e) => ids.has(e.id))
  // If scoping leaves nothing usable the web area was empty, and the
  // browser chrome is genuinely all there is — better than offering
  // nothing at all.
  return page.length >= 2 ? page : elements
}

/** The browser's own furniture: everything outside the web area. Empty
 *  for a native app, where nothing was set aside in the first place. */
export function browserChrome(elements: RawElement[]): RawElement[] {
  const ids = pageIds(elements)
  if (!ids || scopeToPage(elements) === elements) return []
  return elements.filter((e) => !ids.has(e.id) && e.role !== "AXWebArea")
}

/**
 * The set handed to the model: page-scoped, interesting roles only,
 * visible, capped.
 *
 * Unlabelled controls are kept and described by role — window buttons
 * carry no label on macOS, and dropping everything unnamed removes the
 * controls people most often ask for.
 */
/**
 * A drawing app's canvas (tldraw, Figma, Excalidraw) is one unnamed image
 * covering most of the page. It is where shapes and text are placed, so
 * it is offered as "canvas".
 */
function isCanvas(e: RawElement, page: RawElement[]): boolean {
  if (e.role !== "AXImage") return false
  const area = Math.max(0, ...page.filter((p) => p.role === "AXWebArea").map((p) => p.width * p.height))
  return area > 0 && e.width * e.height >= area * 0.4
}

/**
 * A small image is offered only when it says what it is — a chart's
 * "Requests, last hour" is something people point at (#1092: the
 * sparkline); an unnamed or "0" image is the DOM showing through. An
 * image inside a button or link is that control's icon, and the control
 * is already offered.
 */
function isNamedImage(e: RawElement, byId: Map<number, RawElement>): boolean {
  if (e.role !== "AXImage") return false
  const label = (e.label || "").trim()
  if (label.length <= 1 || label === "0") return false
  const parent = byId.get(e.parent)
  return !(parent && parent.id !== e.id && INTERESTING_ROLE.test(parent.role))
}

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
   *  the cap, and decides whether the browser's chrome is offered. */
  request?: string
  /**
   * Which side of a browser window to offer:
   * - "auto" (default): the page, plus the chrome when the request names a browser part
   * - "page": the page only
   * - "browser": the chrome only — the second look after the page had no match
   */
  scope?: "auto" | "page" | "browser"
}

export function buildCandidates(elements: RawElement[], max = 60, opts: CandidateOptions = {}): UICandidate[] {
  // Rank before capping.
  //
  // Slicing in tree order drops whatever appears late, and on x.com the
  // search input sits after a sidebar full of navigation links — so the
  // one element every search question is about was never shown to the
  // model at all, and it confidently picked a nav link instead.
  //
  // Labels sharing the request's words first — on a long page "Restart
  // when idle" sat past the cap behind forty other buttons (#1092). Then
  // text inputs, then things you press, then labels. Within a tier the
  // tree order is kept, so reading position still breaks ties.
  const rank = (role: string): number => {
    if (/^AX(TextField|TextArea|SearchField|ComboBox)/.test(role)) return 0
    if (/^AX(Button|MenuItem|MenuButton|PopUpButton|CheckBox|RadioButton|Tab|Link)/.test(role)) return 1
    if (/^AX(Row|Cell|Slider|Disclosure|Toolbar)/.test(role)) return 2
    return 3
  }
  const scope = opts.scope ?? "auto"
  const page = scopeToPage(elements)
  const chrome = browserChrome(elements)
  const offerChrome = scope === "browser" || (scope === "auto" && namesBrowserPart(opts.request ?? ""))
  const pool = scope === "browser" ? chrome : offerChrome ? [...page, ...chrome] : page
  const inBrowser = new Set(offerChrome ? chrome.map((e) => e.id) : [])
  const canvas = new Set(page.filter((e) => isCanvas(e, page)).map((e) => e.id))
  const words = requestWords(opts.request ?? "")
  const byId = new Map(elements.map((e) => [e.id, e]))
  const order = (e: RawElement): number => (canvas.has(e.id) ? 1 : rank(e.role))
  return pool
    .filter((e) => INTERESTING_ROLE.test(e.role) || canvas.has(e.id) || isNamedImage(e, byId))
    .filter((e) => e.width >= 1 && e.height >= 1)
    .map((e, i) => ({ e, i, hits: overlap(`${e.label} ${e.value ?? ""}`, words) }))
    .sort((a, b) => b.hits - a.hits || order(a.e) - order(b.e) || a.i - b.i)
    .map(({ e }) => e)
    .slice(0, max)
    .map((e, i) => ({
      id: e.id,
      role: e.role,
      label: canvas.has(e.id) ? "canvas" : (e.label || e.value || "").trim() || `${e.role.replace(/^AX/, "")} ${i + 1}`,
      value: e.value ?? null,
      enabled: e.enabled,
      ...(inBrowser.has(e.id) ? { area: "browser" as const } : {}),
    }))
}
