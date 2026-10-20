import { describe, it, expect } from "vitest"
import { buildCandidates, closeBlocked, scopeToPage, type RawElement } from "../src/computer-use/candidates"
import { uiElementQuestions, uiElementState, type PriorAttempt } from "../src/decisions/seats/ui-element"

// What can and cannot be tested here.
//
// The screen cannot: reading a real accessibility tree, OCR and pointing
// all need a logged-in machine with windows open, so those are exercised
// by running a lesson and watching. What CAN be pinned is every decision
// made about the data before it reaches the model — scoping, ranking,
// capping, and what the state says. Those are the parts that broke
// silently and took a screen recording to notice.

const el = (over: Partial<RawElement>): RawElement => ({
  id: 0, role: "AXButton", label: "", value: null, enabled: true,
  parent: -1, x: 0, y: 0, width: 40, height: 20, ...over,
})

describe("scopeToPage", () => {
  it("drops the browser's own furniture once a web area exists", () => {
    // The bug this prevents: "the search box" chose Chrome's address bar
    // at 0.97 confidence, because the browser's chrome was in the running.
    const elements = [
      el({ id: 0, role: "AXWindow" }),
      el({ id: 1, role: "AXTextField", label: "Address and search bar", parent: 0 }),
      el({ id: 2, role: "AXWebArea", parent: 0 }),
      el({ id: 3, role: "AXTextField", label: "Search query", parent: 2 }),
    ]
    const page = scopeToPage(elements).map((e) => e.label)
    expect(page).toContain("Search query")
    expect(page).not.toContain("Address and search bar")
  })

  it("leaves a native app alone, where there is no page to scope to", () => {
    const elements = [
      el({ id: 0, role: "AXWindow" }),
      el({ id: 1, role: "AXButton", label: "Share", parent: 0 }),
    ]
    expect(scopeToPage(elements)).toHaveLength(2)
  })

  it("keeps the chrome when the web area is empty, rather than offering nothing", () => {
    const elements = [
      el({ id: 0, role: "AXWindow" }),
      el({ id: 1, role: "AXTextField", label: "Address and search bar", parent: 0 }),
      el({ id: 2, role: "AXWebArea", parent: 0 }),
    ]
    expect(scopeToPage(elements).length).toBeGreaterThan(1)
  })

  it("survives a parent chain that points at itself", () => {
    const elements = [el({ id: 0, role: "AXWebArea", parent: 0 }), el({ id: 1, parent: 0 })]
    expect(() => scopeToPage(elements)).not.toThrow()
  })
})

describe("buildCandidates", () => {
  it("ranks inputs ahead of navigation before capping", () => {
    // The bug this prevents: x.com's search input sat after a sidebar of
    // links, the list was sliced at 45 in TREE order, and the one element
    // every search question is about never reached the model.
    const elements = [
      ...Array.from({ length: 50 }, (_, i) =>
        el({ id: i, role: "AXLink", label: `nav ${i}` })),
      el({ id: 99, role: "AXTextField", label: "Search query" }),
    ]
    const labels = buildCandidates(elements, 10).map((c) => c.label)
    expect(labels[0]).toBe("Search query")
  })

  it("keeps unlabelled controls, described by role", () => {
    // Window close/minimise buttons carry no label on macOS. Dropping
    // everything unnamed removed the controls people ask for most.
    const out = buildCandidates([el({ id: 1, role: "AXButton", label: "" })], 10)
    expect(out).toHaveLength(1)
    expect(out[0].label).toMatch(/button/i)
  })

  it("drops zero-sized elements, which cannot be pointed at", () => {
    const elements = [
      el({ id: 1, role: "AXButton", label: "Real" }),
      el({ id: 2, role: "AXButton", label: "Hidden", width: 0, height: 0 }),
    ]
    expect(buildCandidates(elements, 10).map((c) => c.label)).toEqual(["Real"])
  })

  it("offers a drawing app's canvas as the canvas, and its icons as images", () => {
    // tldraw's canvas is one unnamed image the size of the page; without
    // it a lesson cannot place a shape or a text box.
    const elements = [
      el({ id: 1, role: "AXWebArea", label: "tldraw", width: 1440, height: 800 }),
      el({ id: 2, role: "AXImage", label: "0", parent: 1, width: 1440, height: 800 }),
      el({ id: 3, role: "AXImage", label: "Comments", parent: 1, width: 20, height: 20 }),
      el({ id: 4, role: "AXCheckBox", label: "Rectangle — R", parent: 1 }),
    ]
    expect(buildCandidates(elements, 10).map((c) => c.shown ?? c.label).sort()).toEqual(["Comments", "Rectangle — R", "canvas"])
  })

  // A browser window: traffic lights and toolbar outside the web area.
  const browser = (page: RawElement[]): RawElement[] => [
    el({ id: 0, role: "AXWindow", width: 1280, height: 800 }),
    el({ id: 1, role: "AXButton", label: "", subrole: "AXCloseButton", parent: 0, x: 10, y: 10, width: 16, height: 16 }),
    el({ id: 2, role: "AXButton", label: "Reload", parent: 0, x: 80, y: 50 }),
    el({ id: 3, role: "AXTextField", label: "Address and search bar", parent: 0, x: 200, y: 50, width: 800 }),
    el({ id: 4, role: "AXWebArea", parent: 0, y: 90, width: 1280, height: 710 }),
    ...page.map((e) => ({ ...e, parent: e.parent < 0 ? 4 : e.parent })),
  ]

  it("offers the browser's own controls, marked as the browser's", () => {
    // The bug this fixes: "the circular arrow reload icon" and "the small
    // x that closes the tab" were never offered, because every control
    // outside the web area was dropped. 8 of 12 misses in the #1092 race.
    const out = buildCandidates(browser([el({ id: 5, role: "AXTextField", label: "Search query", y: 120 })]), 40)
    const labels = out.map((c) => c.shown ?? c.label)
    expect(labels).toContain("Search query")
    expect(labels).toContain("outside the page: Reload")
    // ...and the address bar can no longer pass for the page's search box.
    expect(labels).toContain("outside the page: Address and search bar")
    expect(labels).not.toContain("Address and search bar")
  })

  it("keeps a few browser controls when a busy page fills the cap, and no more", () => {
    const links = Array.from({ length: 80 }, (_, i) => el({ id: 10 + i, role: "AXLink", label: `nav ${i}`, y: 100 + i }))
    const tabs = Array.from({ length: 30 }, (_, i) => el({ id: 200 + i, role: "AXButton", label: `tab ${i}`, parent: 0, y: 40 }))
    const out = buildCandidates([...browser(links), ...tabs], 40)
    const shown = out.map((c) => c.shown ?? c.label)
    expect(out).toHaveLength(40)
    expect(shown).toContain("outside the page: Reload")
    // A quarter at most: a small caller such as teach keeps its page slots.
    expect(shown.filter((l) => l.startsWith("outside the page:"))).toHaveLength(10)
  })

  it("keeps the control's own name as its label, for checking a click", () => {
    // Lesson steps click with --expect <label>; a label the screen does not
    // carry ("Reload (browser…)", "history → in …") makes the helper refuse.
    const out = buildCandidates(browser([el({ id: 5, role: "AXTextField", label: "0", y: 120 })]), 40)
    expect(out.find((c) => c.id === 2)?.label).toBe("Reload")
    expect(out.find((c) => c.id === 5)?.label).toBe("0")
  })

  it("does not cut a page control off its web area when a duplicate parent is dropped", () => {
    const box = { role: "AXGroup", label: "Infobox", x: 800, y: 300, width: 300, height: 400 }
    const out = buildCandidates(browser([
      el({ id: 5, ...box }),
      el({ id: 6, ...box, parent: 5 }),
      el({ id: 7, role: "AXLink", label: "Population", parent: 6, x: 810, y: 320 }),
    ]), 10)
    expect(out.find((c) => c.id === 7)?.shown ?? out.find((c) => c.id === 7)?.label).toBe("Population")
  })

  it("names an unlabelled traffic light by its subrole", () => {
    const labels = buildCandidates(browser([el({ id: 5, role: "AXLink", label: "Home", y: 120 })]), 40).map((c) => c.shown ?? c.label)
    expect(labels).toContain("outside the page: close window (red traffic light)")
  })

  it("names a window button by its subrole even when help text is its label", () => {
    // The green light's label is "this button also has an action to zoom
    // the window", which never says it is the green one.
    const out = buildCandidates([el({ id: 1, label: "this button also has an action to zoom the window", subrole: "AXFullScreenButton" })], 10)
    expect(out[0].shown).toBe("full screen (green traffic light)")
  })

  it("treats Chrome's placeholder \"0\" as no name", () => {
    // Every chart and most text on the dashboard read "0"; the real text
    // was in the value, and the model was shown forty zeroes.
    const out = buildCandidates([
      el({ id: 1, role: "AXStaticText", label: "0", value: "running 2" }),
      el({ id: 2, role: "AXImage", label: "0", width: 300, height: 20 }),
    ], 10)
    const labels = out.map((c) => c.shown ?? c.label)
    expect(labels).toContain("running 2")
    expect(labels.some((l) => l.startsWith("unlabelled chart or graphic"))).toBe(true)
    expect(labels).not.toContain("0")
  })

  it("tells same-named controls apart by the title of their card", () => {
    // Five cards, each with "history →". Without the card's title the
    // model can only guess which one "the marketing-agent card" means.
    const card = (id: number, x: number, title: string): RawElement[] => [
      el({ id, role: "AXStaticText", label: "0", value: title, x, y: 100 }),
      el({ id: id + 1, role: "AXStaticText", value: "last active 1h ago", x, y: 150 }),
      el({ id: id + 2, role: "AXButton", label: "history →", x: x + 200, y: 150 }),
    ]
    const labels = buildCandidates(browser([...card(10, 0, "@marketing-agent"), ...card(20, 400, "@devops-agent")]), 40)
      .map((c) => c.shown ?? c.label)
    expect(labels).toContain('history → in "@marketing-agent last active 1h ago"')
    expect(labels).toContain('history → in "@devops-agent last active 1h ago"')
  })

  it("spends one slot on a thing the tree lists three times", () => {
    // Wikipedia's infobox appears three times over, same name, same place.
    const flag = { role: "AXLink", label: "Flag of Tunisia", x: 800, y: 470, width: 128, height: 85 }
    const out = buildCandidates([el({ id: 1, ...flag }), el({ id: 2, ...flag }), el({ id: 3, ...flag })], 10)
    expect(out).toHaveLength(1)
  })

  it("offers colour wells, and not tables", () => {
    // TextEdit's text colour picker is an AXColorWell; "Tab" once matched
    // AXTable by prefix and offered a whole table as a control.
    const out = buildCandidates([
      el({ id: 1, role: "AXColorWell", label: "text color" }),
      el({ id: 2, role: "AXTable", label: "" }),
    ], 10)
    expect(out.map((c) => c.role)).toEqual(["AXColorWell"])
  })

  it("names an unlabelled row by the text inside it", () => {
    // Finder's sidebar rows carry no name; "Downloads" is in a child.
    const out = buildCandidates([
      el({ id: 1, role: "AXRow", label: "" }),
      el({ id: 2, role: "AXCell", label: "", parent: 1 }),
      el({ id: 3, role: "AXStaticText", label: "", value: "Downloads", parent: 2 }),
    ], 10)
    expect(out.find((c) => c.id === 1)?.shown).toBe("Downloads")
  })

  it("says roughly where each control is, in words", () => {
    const out = buildCandidates(browser([el({ id: 5, role: "AXButton", label: "Ask", x: 1200, y: 760 })]), 10)
    expect(out.find((c) => c.label === "Ask")?.where).toBe("bottom right")
  })

  it("honours the cap", () => {
    const elements = Array.from({ length: 80 }, (_, i) =>
      el({ id: i, role: "AXButton", label: `b${i}` }))
    expect(buildCandidates(elements, 12)).toHaveLength(12)
  })
})

describe("browser chrome — marked, and kept apart from the page (#1093, #1095)", () => {
  // A Chrome window: its toolbar, and a page with its own search box and
  // its own "Bookmark" (x.com's per-post one).
  const browser = [
    el({ id: 0, role: "AXWindow" }),
    el({ id: 1, role: "AXTextField", label: "Address and search bar", parent: 0 }),
    el({ id: 2, role: "AXButton", label: "Reload", parent: 0 }),
    el({ id: 3, role: "AXButton", label: "Bookmark this tab", parent: 0 }),
    el({ id: 4, role: "AXWebArea", parent: 0 }),
    el({ id: 5, role: "AXTextField", label: "Search query", parent: 4 }),
    el({ id: 6, role: "AXButton", label: "Bookmark", parent: 4 }),
  ]

  it("marks the browser's controls, and only those", () => {
    const out = buildCandidates(browser, 40, { request: "the search box" })
    expect(out.find((c) => c.label === "Reload")?.area).toBe("browser")
    expect(out.find((c) => c.label === "Search query")?.area).toBeUndefined()
  })

  it("keeps a page's own Bookmark apart from the browser's star", () => {
    // "bookmark" names both; only the marking separates them.
    const out = buildCandidates(browser, 40, { request: "the bookmark button" })
    expect(out.find((c) => c.label === "Bookmark")?.area).toBeUndefined()
    expect(out.find((c) => c.label === "Bookmark this tab")?.area).toBe("browser")
    const criteria = Object.values((uiElementQuestions(out) as any).target.criteria) as string[]
    expect(criteria.some((c) => /^button: Bookmark \(/.test(c))).toBe(true)
    expect(criteria.some((c) => c.startsWith("button: outside the page: Bookmark this tab"))).toBe(true)
  })
})

describe("buildCandidates — reaching more of the screen (#1092)", () => {
  it("keeps a label that shares the request's words past the cap", () => {
    // "Restart when idle" sat late on a settings page behind forty buttons.
    const elements = [
      ...Array.from({ length: 50 }, (_, i) => el({ id: i, role: "AXButton", label: `option ${i}` })),
      el({ id: 99, role: "AXButton", label: "Restart when idle" }),
    ]
    const labels = buildCandidates(elements, 10, { request: "the restart when idle button" }).map((c) => c.label)
    expect(labels).toContain("Restart when idle")
    expect(labels).toHaveLength(10)
  })

  it("changes only who survives the cap, not the order shown", () => {
    // The matching button sits past the cap; once rescued it still comes
    // after the input, as its tier says.
    const elements = [
      el({ id: 1, role: "AXTextField", label: "Query" }),
      ...Array.from({ length: 20 }, (_, i) => el({ id: 10 + i, role: "AXButton", label: `option ${i}` })),
      el({ id: 99, role: "AXButton", label: "Search options" }),
    ]
    const labels = buildCandidates(elements, 5, { request: "search options" }).map((c) => c.label)
    expect(labels).toHaveLength(5)
    expect(labels[0]).toBe("Query")
    expect(labels[labels.length - 1]).toBe("Search options")
  })

  it("rescues an unlabelled window button by its subrole name", () => {
    const elements = [
      el({ id: 0, role: "AXWindow" }),
      ...Array.from({ length: 30 }, (_, i) => el({ id: 10 + i, role: "AXButton", label: `tool ${i}`, parent: 0 })),
      el({ id: 99, role: "AXButton", label: "", subrole: "AXCloseButton", parent: 0 }),
      el({ id: 4, role: "AXWebArea", parent: 0 }),
      el({ id: 5, role: "AXLink", label: "Home", parent: 4 }),
      el({ id: 6, role: "AXLink", label: "News", parent: 4 }),
    ]
    const out = buildCandidates(elements, 40, { request: "the red traffic light" })
    expect(out.filter((c) => c.area === "browser")).toHaveLength(10)
    expect(out.find((c) => c.id === 99)?.shown).toBe("outside the page: close window (red traffic light)")
  })
})

describe("uiElementState — what the model is actually told", () => {
  const base = {
    request: "the search box",
    app: "Google Chrome",
    candidates: [{ id: 1, role: "AXTextField", label: "Search", value: null, enabled: true }],
  }

  it("says nothing about prior attempts on a first try", () => {
    // An empty array is noise the model reads past on the common case.
    const state = uiElementState(base) as Record<string, unknown>
    expect(state).not.toHaveProperty("alreadyTried")
  })

  it("reports whether the screen CHANGED, not whether the call returned", () => {
    // The distinction the whole loop rests on: every step reported success
    // all day, including the ones that did nothing.
    const prior: PriorAttempt[] = [{ tried: "Search link", changed: false, note: "clicked" }]
    const state = uiElementState({ ...base, priorAttempts: prior }) as any
    expect(state.alreadyTried).toHaveLength(1)
    expect(state.alreadyTried[0].screenChanged).toBe(false)
    expect(state.alreadyTried[0].control).toBe("Search link")
  })

  it("keeps only the last four attempts", () => {
    const prior: PriorAttempt[] = Array.from({ length: 9 }, (_, i) => ({
      tried: `try ${i}`, changed: false,
    }))
    const state = uiElementState({ ...base, priorAttempts: prior }) as any
    expect(state.alreadyTried).toHaveLength(4)
    expect(state.alreadyTried[3].control).toBe("try 8")
  })

  it("shows the model the fuller name, keeping the label as it was", () => {
    const state = uiElementState({ ...base, candidates: [{ ...base.candidates[0], label: "Reload", shown: "outside the page: Reload" }] }) as any
    expect(state.controls[0].label).toBe("outside the page: Reload")
  })

  it("passes the coarse place along when there is one", () => {
    const state = uiElementState({ ...base, candidates: [{ ...base.candidates[0], where: "top right" }] }) as any
    expect(state.controls[0].where).toBe("top right")
  })

  it("never puts the browser chrome in front of the model by accident", () => {
    const state = uiElementState(base) as any
    expect(state.controls).toHaveLength(1)
    expect(state.controls[0].label).toBe("Search")
  })
})

describe("close, quit: never by accident (#1094)", () => {
  // Chrome: the tab's x, the red light, the star, and a page with a
  // dialog's own "Close".
  const chrome = [
    el({ id: 0, role: "AXWindow" }),
    el({ id: 1, role: "AXButton", label: "", subrole: "AXCloseButton", parent: 0 }),
    el({ id: 2, role: "AXButton", label: "Close", parent: 0 }),
    el({ id: 3, role: "AXButton", label: "Bookmark this tab", parent: 0 }),
    el({ id: 4, role: "AXWebArea", parent: 0 }),
    el({ id: 5, role: "AXButton", label: "Close", parent: 4 }),
    el({ id: 6, role: "AXLink", label: "Home", parent: 4 }),
  ]

  it("marks the red light and the tab's x, not the star or a dialog's Close on the page", () => {
    const out = buildCandidates(chrome, 40, { request: "Bookmark this page" })
    const closes = (id: number) => out.find((c) => c.id === id)?.closes
    expect(closes(1)).toBe(true)
    expect(closes(2)).toBe(true)
    expect(closes(3)).toBeUndefined()
    expect(closes(5)).toBeUndefined()
  })

  it("blocks a close pick unless the request asks to close something", () => {
    const tabX = buildCandidates(chrome, 40).find((c) => c.id === 2)
    expect(closeBlocked(tabX, "Bookmark this page")).toBe(true)
    expect(closeBlocked(tabX, "close this tab")).toBe(false)
    expect(closeBlocked(tabX, "quit Chrome")).toBe(false)
    expect(closeBlocked(tabX, "exit full screen")).toBe(true)
    expect(closeBlocked(tabX, "the close-up photo")).toBe(true)
    expect(closeBlocked(buildCandidates(chrome, 40).find((c) => c.id === 3), "Bookmark this page")).toBe(false)
  })

  it("marks an Electron app's editor-tab close inside the web area, not a dialog's bare Close", () => {
    // VS Code is one web area: its editor tab's x is on the "page".
    const vscode = [
      el({ id: 0, role: "AXWindow" }),
      el({ id: 1, role: "AXWebArea", parent: 0 }),
      el({ id: 2, role: "AXButton", label: "Close (⌘W)", parent: 1 }),
      el({ id: 3, role: "AXButton", label: "Close Editor", parent: 1 }),
      el({ id: 4, role: "AXButton", label: "Close All", parent: 1 }),
      el({ id: 5, role: "AXButton", label: "Close", parent: 1 }),
      el({ id: 6, role: "AXButton", label: "Closed issues", parent: 1 }),
      el({ id: 7, role: "AXButton", label: "Run", parent: 1 }),
    ]
    const out = buildCandidates(vscode, 40)
    const closes = (id: number) => out.find((c) => c.id === id)?.closes
    expect(closes(2)).toBe(true)
    expect(closes(3)).toBe(true)
    expect(closes(4)).toBe(true)
    expect(closes(5)).toBeUndefined()
    expect(closes(6)).toBeUndefined()
    expect(closes(7)).toBeUndefined()
  })

  it("reads \"closes\" as a close ask and \"close to\" as a place", () => {
    const tabX = buildCandidates(chrome, 40).find((c) => c.id === 2)
    expect(closeBlocked(tabX, "the button that closes the tab")).toBe(false)
    expect(closeBlocked(tabX, "the icon close to the logo")).toBe(true)
  })

  it("marks a native app's Quit and Close Window menu items", () => {
    const menu = [
      el({ id: 1, role: "AXMenuItem", label: "Quit Google Chrome" }),
      el({ id: 2, role: "AXMenuItem", label: "Close Window" }),
      el({ id: 3, role: "AXMenuItem", label: "Closed Captions" }),
    ]
    const out = buildCandidates(menu, 40)
    expect(out.map((c) => c.closes)).toEqual([true, true, undefined])
  })
})
