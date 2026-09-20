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
 * Restrict to page content when this is a browser.
 *
 * Identified structurally by the presence of a web area, not by app name:
 * name matching would miss every browser nobody thought to list.
 */
export function scopeToPage(elements: RawElement[]): RawElement[] {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const rootIds = new Set(elements.filter((e) => e.role === "AXWebArea").map((e) => e.id))
  if (rootIds.size === 0) return elements

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
  const page = elements.filter(isDescendant)
  // If scoping leaves nothing usable the web area was empty, and the
  // browser chrome is genuinely all there is — better than offering
  // nothing at all.
  return page.length >= 2 ? page : elements
}

/**
 * The set handed to the model: page-scoped, interesting roles only,
 * visible, capped.
 *
 * Unlabelled controls are kept and described by role — window buttons
 * carry no label on macOS, and dropping everything unnamed removes the
 * controls people most often ask for.
 */
export function buildCandidates(elements: RawElement[], max = 60): UICandidate[] {
  // Rank before capping.
  //
  // Slicing in tree order drops whatever appears late, and on x.com the
  // search input sits after a sidebar full of navigation links — so the
  // one element every search question is about was never shown to the
  // model at all, and it confidently picked a nav link instead.
  //
  // Text inputs first, then things you press, then labels. Within a tier
  // the tree order is kept, so reading position still breaks ties.
  const rank = (role: string): number => {
    if (/^AX(TextField|TextArea|SearchField|ComboBox)/.test(role)) return 0
    if (/^AX(Button|MenuItem|MenuButton|PopUpButton|CheckBox|RadioButton|Tab|Link)/.test(role)) return 1
    if (/^AX(Row|Cell|Slider|Disclosure|Toolbar)/.test(role)) return 2
    return 3
  }
  return scopeToPage(elements)
    .filter((e) => INTERESTING_ROLE.test(e.role))
    .filter((e) => e.width >= 1 && e.height >= 1)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e.role) - rank(b.e.role) || a.i - b.i)
    .map(({ e }) => e)
    .slice(0, max)
    .map((e, i) => ({
      id: e.id,
      role: e.role,
      label: (e.label || e.value || "").trim() || `${e.role.replace(/^AX/, "")} ${i + 1}`,
      value: e.value ?? null,
      enabled: e.enabled,
    }))
}
