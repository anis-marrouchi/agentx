import { describe, expect, it } from "vitest"
import {
  HUB_CAP, HUB_FOLDS_CSS, HUB_FOLDS_FNS, HUB_FOLDS_KEY, HUB_FOLDS_SCRIPT, HUB_LAYOUT_KEYS,
  hubCapLabel, hubFoldHtml, hubFoldIsOpen, hubFoldsRead, hubLayoutReset, hubScrollKeep, hubScrollKey,
} from "../src/daemon/ui/pages/hub-folds"
import { HUB_PANELS_FNS, HUB_PANELS_KEY } from "../src/daemon/ui/pages/hub-panels"
import { injectFns } from "../src/daemon/ui/inject"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_CHAT_CSS, wallChatPanelHtml } from "../src/daemon/ui/pages/wall-chat.client"
import { jobLedgerPageHtml } from "../src/daemon/ui/pages/wall-jobledger"

// #2352 (Anis 2026-11-26, orca-design C22–C23): sections fold with counts,
// live lists show 3 then Show all (N), Back keeps the scroll, one Reset layout.

describe("Hub folds: the saved choices (#2352)", () => {
  it("reads what was saved and drops anything that is not a yes or no", () => {
    const f = hubFoldsRead(JSON.stringify({ open: { a: true, b: "x", c: false }, all: { desk: true }, junk: 1 }))
    expect(f).toEqual({ open: { a: true, c: false }, all: { desk: true } })
  })
  it("gives no choices for a broken or missing value", () => {
    for (const raw of [null, undefined, "", "{", "[]", "3", JSON.stringify({ open: [] })]) {
      expect(hubFoldsRead(raw)).toEqual({ open: {}, all: {} })
    }
  })
  it("opens a fold as the page starts it, until the reader chooses", () => {
    const f = hubFoldsRead(JSON.stringify({ open: { filters: true, agents: false } }))
    expect(hubFoldIsOpen(f, "new", null)).toBe(true)
    expect(hubFoldIsOpen(f, "noisy", "closed")).toBe(false)
    expect(hubFoldIsOpen(f, "filters", "closed")).toBe(true)
    expect(hubFoldIsOpen(f, "agents", "open")).toBe(false)
  })
})

describe("Hub folds: Show all (N)", () => {
  it("needs no button at 3 rows or fewer", () => {
    expect(HUB_CAP).toBe(3)
    expect(hubCapLabel(0, false)).toBe("")
    expect(hubCapLabel(3, false)).toBe("")
    expect(hubCapLabel(3, true)).toBe("")
  })
  it("says Show all with the count, then Show fewer", () => {
    expect(hubCapLabel(253, false)).toBe("Show all (253)")
    expect(hubCapLabel(253, true)).toBe("Show fewer")
    expect(hubCapLabel(5, false, 5)).toBe("")
  })
  it("hides the rows past the third in CSS, unless the list shows all", () => {
    expect(HUB_FOLDS_CSS).toContain("[data-cap]:not(.is-all) > :nth-child(n+4) { display: none; }")
  })
})

describe("Hub folds: the header", () => {
  it("draws chevron, title and count, and a noisy one starts closed", () => {
    const h = hubFoldHtml("agents.Mac", "Mac <b>", 34, "<p>x</p>", "closed")
    expect(h).toBe('<details class="axp-fold" data-fold="agents.Mac" data-fold-start="closed" open><summary class="axp-fold__h"><span class="axp-fold__t">Mac &lt;b&gt;</span><span class="axp-fold__n">34</span></summary><p>x</p></details>')
    expect(hubFoldHtml("k", "T", null, "")).not.toContain("axp-fold__n")
  })
  it("draws the lucide chevron in CSS and turns it over 150ms when open, still under reduced motion", () => {
    expect(HUB_FOLDS_CSS).toContain('.axp-fold > summary::before { content: ""')
    expect(HUB_FOLDS_CSS).toContain("lucide-chevron-right")
    expect(HUB_FOLDS_CSS).toContain("transition: transform 150ms ease-out")
    expect(HUB_FOLDS_CSS).toContain(".axp-fold[open] > summary::before { transform: rotate(90deg); }")
    expect(HUB_FOLDS_CSS).toContain("@media (prefers-reduced-motion: reduce) { .axp-fold > summary::before { transition: none; } }")
  })
})

describe("Hub folds: Reset layout", () => {
  it("forgets the panels, the folds and the side menu's folds, in one store each", () => {
    expect(HUB_LAYOUT_KEYS).toEqual([HUB_PANELS_KEY, HUB_FOLDS_KEY, "ax.hub.agentOpen"])
    const m = new Map<string, string>([[HUB_PANELS_KEY, "{}"], [HUB_FOLDS_KEY, "{}"], ["ax.hub.agentFilter", "done"]])
    const store = { getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k) } }
    expect(hubLayoutReset(store, HUB_LAYOUT_KEYS)).toEqual([HUB_PANELS_KEY, HUB_FOLDS_KEY])
    expect([...m.keys()]).toEqual(["ax.hub.agentFilter"])
  })
  it("does not throw when the browser keeps nothing", () => {
    const store = { getItem: () => { throw new Error("private") }, removeItem: () => { throw new Error("private") } }
    expect(hubLayoutReset(store, HUB_LAYOUT_KEYS)).toEqual([])
  })
})

describe("Hub folds: Back keeps the scroll", () => {
  it("keys a position by the history entry", () => {
    expect(hubScrollKey("abc", 4, "#page=agents")).toBe("k:abc")
    expect(hubScrollKey(null, 4, "#page=agents")).toBe("i:4#page=agents")
    expect(hubScrollKey(undefined, undefined, "")).toBe("i:x")
  })
  it("keeps the newest positions and drops the oldest past the limit", () => {
    let pos: Record<string, number> = {}
    pos = hubScrollKeep(pos, "a", 600.4)
    pos = hubScrollKeep(pos, "b", -5)
    expect(pos).toEqual({ a: 600, b: 0 })
    pos = hubScrollKeep(pos, "c", 1, 2)
    expect(pos).toEqual({ b: 0, c: 1 })
    pos = hubScrollKeep(pos, "b", 30, 2)
    expect(Object.keys(pos)).toEqual(["c", "b"])
  })
})

describe("Hub folds: in the page", () => {
  it("ships its helpers next to the panels' without a clash, and the script parses", () => {
    const names = Object.keys(HUB_FOLDS_FNS)
    for (const n of names) expect(Object.keys(HUB_PANELS_FNS)).not.toContain(n)
    expect(() => new Function(injectFns({ ...HUB_PANELS_FNS, ...HUB_FOLDS_FNS }) + "\n" + HUB_FOLDS_SCRIPT)).not.toThrow()
    expect(HUB_FOLDS_SCRIPT).toContain('"ax.hub.panels","ax.hub.folds","ax.hub.agentOpen"')
  })
  it("puts the 10 Search filters behind one Filters button, Group by under Group and columns, and ships the folds", () => {
    const html = renderWallPage()
    // A popover the Filters button opens (#2101 feed mock): closed on load.
    expect(html).toMatch(/<button type="button" class="ax-btn ax-btn--ghost fd-btn" id="wall-search" data-fd-pop aria-controls="wall-filters" aria-expanded="false"[^>]*>.*?<span>Filters<\/span> <b id="wall-fn"/)
    const pop = html.slice(html.indexOf('<section class="ax-wall__filters fd-pop" id="wall-filters"'), html.indexOf("</section>", html.indexOf('id="wall-filters"')))
    expect(pop.match(/<select /g)).toHaveLength(10)
    expect(pop).not.toContain('id="f-q"')
    expect(pop).not.toContain('id="f-grp"')
    const cols = html.slice(html.indexOf('id="fd-cols"'), html.indexOf("</section>", html.indexOf('id="fd-cols"')))
    expect(cols).toContain('id="f-grp"')
    expect(html).toContain("[data-cap]:not(.is-all)")
    expect(html).toContain("hubFoldsRead")
  })
})

describe("Hub folds: the chat agent strip and the Jobs chips (#2352)", () => {
  it("folds the chat's agent strip from an Agents header with its count, and shows the picker while folded", () => {
    const html = wallChatPanelHtml({ owner: true, signIn: false })
    expect(html).toContain('<details class="axp-fold hc__sfold" data-fold="chat.agents" open><summary class="axp-fold__h"><span class="axp-fold__t">Agents</span><span class="axp-fold__n" id="hc-strip-n"></span></summary><div class="hc__strip" id="hc-strip"')
    // The To picker hides only behind an open strip; no strip yet, no header.
    expect(WALL_CHAT_CSS).toContain(".hc__to:has(.hc__sfold[open] .hc__strip:not([hidden])) #hc-agent { display: none; }")
    expect(WALL_CHAT_CSS).toContain(".hc__sfold:has(.hc__strip[hidden]) { display: none; }")
    expect(wallChatPanelHtml({ owner: false, signIn: true })).not.toContain("data-fold")
  })
  it("folds the Jobs state chips from a header with the state picked and its count", () => {
    const base = { list: [], counts: { working: 2, continue: 1, waiting: 0, blocked: 1, stalled: 1, done: 7, dropped: 1 }, total: 0, state: "open", door: "", open: "", detail: null, detailErr: "", missed: [], error: "", multi: false, now: 0 }
    const html = jobLedgerPageHtml(base)
    expect(html).toContain('<details class="axp-fold wjl__fold" data-fold="jobs.states" open><summary class="axp-fold__h"><span class="axp-fold__t">State: Open</span><span class="axp-fold__n">5</span></summary><div class="wjl__chips"')
    expect(jobLedgerPageHtml({ ...base, state: "done" })).toContain('<span class="axp-fold__t">State: Done</span><span class="axp-fold__n">7</span>')
    // Before the counts come, the header has no number.
    expect(jobLedgerPageHtml({ ...base, counts: null, list: null })).toContain('<span class="axp-fold__t">State: Open</span></summary>')
  })
  it("keeps the three folds in the one store Reset layout clears", () => {
    // Every fold goes through HUB_FOLDS_SCRIPT's details[data-fold], kept under ax.hub.folds.
    expect(HUB_FOLDS_SCRIPT).toContain("details[data-fold]:not([data-fold-on])")
    expect(HUB_LAYOUT_KEYS).toContain(HUB_FOLDS_KEY)
  })
})
