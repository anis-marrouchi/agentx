import { describe, expect, it } from "vitest"
import { WALL_KEEP_SCRIPT } from "../src/daemon/ui/pages/wall-keep.client"

// #2101 R21: a Hub repaint keeps open sections, shown lists and the scroll.
// The real script runs against a small stubbed DOM: each paint() throws the
// old elements away and draws new ones with their defaults, as innerHTML does.

type Node = { id?: string; parentNode: Node | null; [k: string]: any }

function box(id: string): Node {
  const n: Node = { id, parentNode: null, closest: (s: string) => (s === "[id]" ? n : null) }
  return n
}
function details(parent: Node, summary: string, open = false): Node {
  return { parentNode: parent, open, attrs: {}, hasAttribute: (k: string) => k === "data-lt-key" && false, querySelector: () => ({ textContent: summary }) }
}
function moreList(parent: Node, key: string): { list: Node; button: Node } {
  const button: Node = { parentNode: parent, textContent: "12 more (show all)" }
  const list: Node = { parentNode: parent, hidden: true, getAttribute: (k: string) => (k === "data-more-list" ? key : null) }
  parent.querySelector = (s: string) => (s === `[data-more="${key}"]` ? button : null)
  return { list, button }
}

function hub() {
  let page: { details: Node[]; lists: Node[] } = { details: [], lists: [] }
  const listeners: Record<string, (ev: any) => void> = {}
  const win: any = { scrollY: 0, scrollTo: (_x: number, y: number) => { win.scrollY = y } }
  const doc = {
    querySelectorAll: (s: string) => (s === ".ax-wall details" ? page.details : s === ".ax-wall [data-more-list]" ? page.lists : []),
    getElementById: () => null,
    addEventListener: (t: string, f: (ev: any) => void) => { listeners[t] = f },
  }
  const loc = { hash: "#status=open&view=feed" }
  const S: any = { page: "wall", post: "", view: "feed" }
  const api = new Function("document", "window", "location", "S", WALL_KEEP_SCRIPT + "\nreturn { keepState: keepState };")(doc, win, loc, S)
  // A paint that draws the feed again from scratch: two sections closed by
  // default, the second open by default, a list folded.
  const draw = () => {
    const feed = box("wall-feed"), side = box("wall-aside")
    const more = moreList(feed, "p1")
    page = { details: [details(feed, "Request Fix the backup"), details(side, "Last summary", true)], lists: [more.list] }
    return more
  }
  let more = draw()
  // during(): what else the repaint does, such as dropping to the top.
  const paint = (during?: () => void) => api.keepState(() => { more = draw(); during?.() })
  paint() // the first paint: nothing to keep yet
  return { win, loc, S, get page() { return page }, get more() { return more }, paint }
}

describe("Hub keeps its state across a repaint (#2101 R21)", () => {
  it("keeps the sections the reader opened or closed, and a shown list", () => {
    const h = hub()
    h.page.details[0].open = true
    h.page.details[1].open = false
    h.page.lists[0].hidden = false
    h.paint()
    expect(h.page.details[0].open).toBe(true)
    expect(h.page.details[1].open).toBe(false)
    expect(h.page.lists[0].hidden).toBe(false)
    expect(h.more.button.textContent).toBe("12 more (hide)")
  })

  it("puts the scroll back when a repaint on the same page, view and filters moved it", () => {
    const h = hub()
    h.win.scrollY = 840
    h.paint(() => { h.win.scrollY = 0 })
    expect(h.win.scrollY).toBe(840)
  })

  it("starts a new page at its own place: no scroll back when the hash changed", () => {
    const h = hub()
    h.win.scrollY = 700
    h.loc.hash = "#page=settings"
    h.S.page = "settings"
    h.paint(() => { h.win.scrollY = 0 })
    expect(h.win.scrollY).toBe(0)
    // On that page now: its next repaint keeps its own place.
    h.win.scrollY = 300
    h.paint(() => { h.win.scrollY = 0 })
    expect(h.win.scrollY).toBe(300)
  })
})
