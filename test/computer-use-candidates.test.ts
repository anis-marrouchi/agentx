import { describe, it, expect } from "vitest"
import { buildCandidates, scopeToPage, type RawElement } from "../src/computer-use/candidates"
import { uiElementState, type PriorAttempt } from "../src/decisions/seats/ui-element"

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

  it("honours the cap", () => {
    const elements = Array.from({ length: 80 }, (_, i) =>
      el({ id: i, role: "AXButton", label: `b${i}` }))
    expect(buildCandidates(elements, 12)).toHaveLength(12)
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

  it("never puts the browser chrome in front of the model by accident", () => {
    const state = uiElementState(base) as any
    expect(state.controls).toHaveLength(1)
    expect(state.controls[0].label).toBe("Search")
  })
})
