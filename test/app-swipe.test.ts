import { describe, expect, it } from "vitest"
import { swipeAxis, swipeLanding, swipeMayStart, swipeOffset, type SwipeNode } from "../src/daemon/ui/pages/app-swipe-logic"
import { APP_SWIPE_CSS, APP_SWIPE_SCRIPT } from "../src/daemon/ui/pages/app-swipe.client"
import { renderAppPage } from "../src/daemon/ui/pages/app"

// The phone app's swipe between tabs (#444): the rules that decide what a
// touch is, and the page script driven by a small stand-in for the page.

const plain: SwipeNode = { tag: "DIV", scrollsX: false, touchAction: "auto", editable: false }

describe("where a tab swipe may start", () => {
  it("starts on ordinary content", () => {
    expect(swipeMayStart([])).toBe(true)
    expect(swipeMayStart([{ ...plain, tag: "BUTTON" }, plain])).toBe(true)
  })

  it("leaves alone what scrolls sideways itself, at any depth", () => {
    expect(swipeMayStart([plain, { ...plain, tag: "PRE", scrollsX: true }, plain])).toBe(false)
  })

  it("leaves alone the voice orb, text fields and open sheets", () => {
    expect(swipeMayStart([{ ...plain, tag: "BUTTON", touchAction: "none" }])).toBe(false)
    expect(swipeMayStart([{ ...plain, touchAction: "pan-x" }])).toBe(false)
    expect(swipeMayStart([{ ...plain, tag: "TEXTAREA" }])).toBe(false)
    expect(swipeMayStart([{ ...plain, tag: "INPUT" }])).toBe(false)
    expect(swipeMayStart([{ ...plain, editable: true }])).toBe(false)
    expect(swipeMayStart([plain, { ...plain, tag: "DIALOG" }])).toBe(false)
  })
})

describe("telling a swipe from a scroll", () => {
  it("waits until the finger has moved enough", () => {
    expect(swipeAxis(6, 3)).toBe("")
    expect(swipeAxis(-9, 9)).toBe("")
  })

  it("is a swipe only when sideways clearly wins", () => {
    expect(swipeAxis(24, 4)).toBe("x")
    expect(swipeAxis(-24, 10)).toBe("x")
    expect(swipeAxis(4, 24)).toBe("y")
    expect(swipeAxis(14, 14)).toBe("y")
    expect(swipeAxis(18, -14)).toBe("y")
  })
})

describe("where a swipe lands", () => {
  it("moves one tab after a third of the width on a slow release", () => {
    expect(swipeLanding(1, 4, -140, 390, 0)).toBe(2)
    expect(swipeLanding(1, 4, 140, 390, 0.2)).toBe(0)
    expect(swipeLanding(1, 4, -100, 390, -0.3)).toBe(1)
  })

  it("moves one tab on a quick flick, and not on a small twitch", () => {
    expect(swipeLanding(1, 4, -60, 390, -0.9)).toBe(2)
    expect(swipeLanding(1, 4, 60, 390, 0.9)).toBe(0)
    expect(swipeLanding(1, 4, -20, 390, -1.2)).toBe(1)
  })

  it("stays when the finger is flicked back towards the start", () => {
    expect(swipeLanding(1, 4, -200, 390, 0.9)).toBe(1)
  })

  it("stops at the first and the last tab", () => {
    expect(swipeLanding(0, 4, 300, 390, 1)).toBe(0)
    expect(swipeLanding(3, 4, -300, 390, -1)).toBe(3)
  })

  it("follows the finger, and only gives a little past an end", () => {
    expect(swipeOffset(1, 4, -80)).toBe(-80)
    expect(swipeOffset(0, 4, -80)).toBe(-80)
    expect(swipeOffset(0, 4, 80)).toBe(20)
    expect(swipeOffset(3, 4, -80)).toBe(-20)
  })
})

// --- The page script, on a stand-in page ---

function classes() {
  const set = new Set<string>()
  return { add: (...c: string[]) => c.forEach((x) => set.add(x)), remove: (...c: string[]) => c.forEach((x) => set.delete(x)), has: (c: string) => set.has(c) }
}

function page(opts: { reduce?: boolean; selected?: number } = {}) {
  const names = ["chat", "fleet", "activity", "alerts"]
  let selected = opts.selected ?? 0
  const clicks: string[] = []
  const panels = names.map((n, i) => ({ id: "panel-" + n, hidden: i !== selected, classList: classes(), style: {} as Record<string, string> }))
  const tabs = names.map((n, i) => ({
    getAttribute: (a: string) => (a === "aria-controls" ? "panel-" + n : a === "aria-selected" ? String(i === selected) : null),
    click: () => { clicks.push(n); selected = i; panels.forEach((p, j) => { p.hidden = j !== i }) },
  }))
  const handlers: Record<string, (ev: any) => void> = {}
  // What a redraw took out of the page, as the swipe's watcher sees it.
  const gone = new Set<any>()
  const main = {
    clientWidth: 390, scrollTop: 120, classList: classes(), parentElement: null,
    addEventListener: (type: string, fn: (ev: any) => void) => { handlers[type] = fn },
    contains: (el: any) => !gone.has(el),
  }
  const watchers: Array<() => void> = []
  class MutationObserver {
    constructor(private fn: () => void) {}
    observe() { watchers.push(this.fn) }
  }
  const tabPosition: string[] = []
  const document = {
    querySelector: (selector: string) => selector === ".tabs" ? { style: { setProperty: (_: string, value: string) => tabPosition.push(value) } } : main,
    querySelectorAll: () => tabs,
    getElementById: (id: string) => panels.find((p) => p.id === id),
  }
  const timers: Array<() => void> = []
  const styleOf = (el: any) => el.computed || { touchAction: "auto", overflowX: "visible" }
  new Function("document", "window", "getComputedStyle", "matchMedia", "setTimeout",
    "swipeMayStart", "swipeAxis", "swipeOffset", "swipeLanding", APP_SWIPE_SCRIPT)(
    document, { matchMedia: true, MutationObserver }, styleOf, () => ({ matches: !!opts.reduce }), (fn: () => void) => { timers.push(fn) },
    swipeMayStart, swipeAxis, swipeOffset, swipeLanding,
  )
  const content = { tagName: "P", parentElement: main, isContentEditable: false, scrollWidth: 300, clientWidth: 300 }
  let prevented = 0
  const touch = (type: string, x: number, y: number, target: any = content) =>
    handlers[type]({ target, touches: type === "touchend" ? [] : [{ clientX: x, clientY: y }], cancelable: true, preventDefault: () => { prevented++ } })
  // A redraw replaces `el`; the touch's later events never reach <main>.
  const redraw = (el: any) => { gone.add(el); watchers.forEach((w) => w()) }
  return { main, panels, clicks, timers, tabPosition, touch, redraw, content, prevented: () => prevented, settle: () => { while (timers.length) timers.shift()!() } }
}

describe("the swipe script", () => {
  it("parses and is on the page with its helpers, after the tab script", () => {
    expect(() => new Function(APP_SWIPE_SCRIPT)).not.toThrow()
    const html = renderAppPage()
    expect(html).toContain(APP_SWIPE_SCRIPT)
    expect(html).toContain(APP_SWIPE_CSS)
    expect(html).toContain('const swipeLanding=globalThis.__axBind("swipeLanding"')
    expect(html.indexOf("fromHash()")).toBeLessThan(html.indexOf(APP_SWIPE_SCRIPT))
  })

  it("pulls the next tab in under the finger and lands on it", () => {
    const p = page()
    p.touch("touchstart", 300, 400)
    p.touch("touchmove", 240, 404)
    expect(p.main.classList.has("sw-on")).toBe(true)
    expect(p.prevented()).toBe(1)
    expect(Number(p.tabPosition.at(-1))).toBeCloseTo(60 / 390)
    expect(p.panels[0].style.transform).toBe("translateX(-60px)")
    expect(p.panels[1].classList.has("sw-peek")).toBe(true)
    expect(p.panels[1].style.transform).toBe("translateX(330px)")
    expect(p.panels[1].style.top).toBe("120px")
    // Still hidden for the scripts that poll by it; only landing changes that.
    expect(p.panels[1].hidden).toBe(true)

    p.touch("touchmove", 120, 406)
    p.touch("touchend", 0, 0)
    expect(p.main.classList.has("sw-slide")).toBe(true)
    expect(p.panels[0].style.transform).toBe("translateX(-390px)")
    expect(p.panels[1].style.transform).toBe("translateX(0px)")
    expect(p.clicks).toEqual([])

    p.settle()
    expect(p.clicks).toEqual(["fleet"])
    expect(p.tabPosition.at(-1)).toBe("1")
    expect(p.main.scrollTop).toBe(0)
    expect(p.main.classList.has("sw-on") || p.main.classList.has("sw-slide")).toBe(false)
    expect(p.panels[0].style.transform).toBe("")
    expect(p.panels[1].classList.has("sw-peek")).toBe(false)
    expect(p.panels[1].style.transform).toBe("")
  })

  it("goes back with a swipe to the right, and swaps sides when the finger turns", () => {
    const p = page({ selected: 1 })
    p.touch("touchstart", 100, 400)
    p.touch("touchmove", 60, 400)
    expect(p.panels[2].classList.has("sw-peek")).toBe(true)
    p.touch("touchmove", 280, 400)
    expect(p.panels[2].classList.has("sw-peek")).toBe(false)
    expect(p.panels[0].classList.has("sw-peek")).toBe(true)
    expect(p.panels[0].style.transform).toBe("translateX(-210px)")
    p.touch("touchend", 0, 0)
    p.settle()
    expect(p.clicks).toEqual(["chat"])
  })

  it("springs back after a short slow pull and keeps the scroll position", () => {
    // Its own clock: on the real one the three events land a millisecond
    // apart on a busy machine, and 50 px in 1 ms reads as a flick.
    const now = Date.now
    let t = 1000
    Date.now = () => t
    try {
      const p = page()
      p.touch("touchstart", 300, 400)
      t += 300; p.touch("touchmove", 250, 400)
      t += 300; p.touch("touchend", 0, 0)
      expect(p.panels[0].style.transform).toBe("translateX(0px)")
      p.settle()
      expect(p.clicks).toEqual([])
      expect(p.main.scrollTop).toBe(120)
    } finally { Date.now = now }
  })

  it("lands on the neighbour after a short quick flick, not after a pull that rests", () => {
    const now = Date.now
    let t = 1000
    Date.now = () => t
    try {
      const flick = page()
      flick.touch("touchstart", 300, 400)
      t += 40; flick.touch("touchmove", 270, 400)
      t += 40; flick.touch("touchmove", 230, 400)
      t += 10; flick.touch("touchend", 0, 0)
      flick.settle()
      expect(flick.clicks).toEqual(["fleet"])

      const rest = page()
      rest.touch("touchstart", 300, 400)
      t += 40; rest.touch("touchmove", 230, 400)
      t += 400; rest.touch("touchend", 0, 0)
      rest.settle()
      expect(rest.clicks).toEqual([])
    } finally { Date.now = now }
  })

  it("never takes a vertical scroll for a swipe, even if it drifts sideways later", () => {
    const p = page()
    p.touch("touchstart", 200, 400)
    p.touch("touchmove", 204, 370)
    p.touch("touchmove", 20, 360)
    p.touch("touchend", 0, 0)
    p.settle()
    expect(p.prevented()).toBe(0)
    expect(p.main.classList.has("sw-on")).toBe(false)
    expect(p.panels[0].style.transform).toBeUndefined()
    expect(p.clicks).toEqual([])
  })

  it("ignores a swipe that starts on a sideways scroller or on the orb", () => {
    const p = page()
    const strip = { tagName: "UL", parentElement: p.main, isContentEditable: false, scrollWidth: 900, clientWidth: 358, computed: { touchAction: "auto", overflowX: "auto" } }
    const chip = { tagName: "BUTTON", parentElement: strip, isContentEditable: false, scrollWidth: 80, clientWidth: 80 }
    const orb = { tagName: "BUTTON", parentElement: p.main, isContentEditable: false, scrollWidth: 150, clientWidth: 150, computed: { touchAction: "none", overflowX: "visible" } }
    for (const target of [chip, orb]) {
      p.touch("touchstart", 300, 400, target)
      p.touch("touchmove", 100, 400, target)
      p.touch("touchend", 0, 0, target)
    }
    p.settle()
    expect(p.clicks).toEqual([])
    expect(p.main.classList.has("sw-on")).toBe(false)
  })

  it("gives only a little at the last tab and stays on it", () => {
    const p = page({ selected: 3 })
    p.touch("touchstart", 300, 400)
    p.touch("touchmove", 100, 400)
    expect(p.panels[3].style.transform).toBe("translateX(-50px)")
    p.touch("touchend", 0, 0)
    p.settle()
    expect(p.clicks).toEqual([])
  })

  it("with reduced motion, changes tab at once and moves nothing", () => {
    const p = page({ reduce: true })
    p.touch("touchstart", 300, 400)
    p.touch("touchmove", 100, 400)
    expect(p.panels[0].style.transform).toBeUndefined()
    expect(p.panels[1].classList.has("sw-peek")).toBe(false)
    p.touch("touchend", 0, 0)
    expect(p.timers.length).toBe(0)
    expect(p.clicks).toEqual(["fleet"])
    expect(p.tabPosition.at(-1)).toBe("1")
  })

  it("lets go when a second finger lands", () => {
    const p = page()
    p.touch("touchstart", 300, 400)
    p.touch("touchmove", 100, 400)
    p.touch("touchstart", 50, 50)
    p.settle()
    expect(p.clicks).toEqual([])
    expect(p.panels[1].classList.has("sw-peek")).toBe(false)
  })

  it("lands the swipe when a redraw takes the touched content away", () => {
    const p = page()
    p.touch("touchstart", 300, 400)
    p.touch("touchmove", 120, 404)
    expect(p.panels[0].style.transform).toBe("translateX(-180px)")
    p.redraw(p.content)
    // Far enough: it goes on to the neighbour, as if the finger had lifted.
    expect(p.main.classList.has("sw-slide")).toBe(true)
    p.settle()
    expect(p.clicks).toEqual(["fleet"])
    expect(p.panels[0].style.transform).toBe("")
    expect(p.panels[1].classList.has("sw-peek")).toBe(false)
  })

  it("springs back when a redraw interrupts a short pull, and forgets a touch that never became one", () => {
    const now = Date.now
    let t = 1000
    Date.now = () => t
    try {
      const p = page()
      p.touch("touchstart", 300, 400)
      t += 300; p.touch("touchmove", 260, 400)
      t += 300; p.redraw(p.content)
      expect(p.panels[0].style.transform).toBe("translateX(0px)")
      p.settle()
      expect(p.clicks).toEqual([])
      expect(p.main.classList.has("sw-on")).toBe(false)

      const q = page()
      q.touch("touchstart", 300, 400)
      q.redraw(q.content)
      // The next touch is a fresh one, not the end of the lost one.
      q.touch("touchstart", 300, 400)
      q.touch("touchmove", 120, 404)
      expect(q.main.classList.has("sw-on")).toBe(true)
    } finally { Date.now = now }
  })

  it("leaves a redraw elsewhere on the page alone", () => {
    const p = page()
    p.touch("touchstart", 300, 400)
    p.touch("touchmove", 240, 404)
    p.redraw({ tagName: "LI" })
    expect(p.main.classList.has("sw-on")).toBe(true)
    expect(p.main.classList.has("sw-slide")).toBe(false)
    expect(p.panels[0].style.transform).toBe("translateX(-60px)")
  })

  it("keeps the neighbour's hidden attribute and shows it by class", () => {
    expect(APP_SWIPE_CSS).toContain("main > .sw-peek")
    expect(APP_SWIPE_CSS).toContain("prefers-reduced-motion: reduce")
    expect(APP_SWIPE_SCRIPT).not.toMatch(/\.hidden\s*=/)
  })
})
