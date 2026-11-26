import { describe, expect, it } from "vitest"
import { fdAgo, fdClock, fdCounts, fdGroupOf, fdInTab, fdPatch, fdSortBy, fdState, fdStates, type FdEl } from "../src/daemon/ui/pages/wall-feed-model"
import { injectFns } from "../src/daemon/ui/inject"

// The feed's model (#2101): one state set, tabs whose counts follow the
// filters, one time format, sort, and rows patched by key.

const post = (state: string, extra: Record<string, unknown> = {}) => ({ state, runs: 1, ownerCards: [], lastFailure: null, ...extra })

describe("fdState: one state set (orca-design recipes §9)", () => {
  it("maps each post to one state, what needs you first", () => {
    expect(fdState(post("waiting_owner"), false)).toBe("needs")
    expect(fdState(post("in_progress", { ownerCards: [{}] }), true)).toBe("needs")
    expect(fdState(post("needs_attention"), true)).toBe("failed")
    expect(fdState(post("in_progress", { lastFailure: { taskId: "t" } }), false)).toBe("failed")
    // A new run going now wins over the last one that failed.
    expect(fdState(post("in_progress", { lastFailure: { taskId: "t" } }), true)).toBe("working")
    expect(fdState(post("waiting_other"), false)).toBe("waiting")
    expect(fdState(post("in_progress", { runs: 0 }), false)).toBe("notstarted")
    expect(fdState(post("in_progress", { runs: 0 }), true)).toBe("working")
    expect(fdState(post("done"), false)).toBe("done")
    expect(fdState(post("dropped"), false)).toBe("cancelled")
    expect(fdState(post("declined"), false)).toBe("cancelled")
  })
  it("has one icon, word and tone per state, in order; only Failed is red", () => {
    const s = fdStates()
    expect(Object.keys(s).sort((a, b) => s[a].order - s[b].order)).toEqual(["needs", "failed", "working", "waiting", "notstarted", "cancelled", "done"])
    expect(s.working).toMatchObject({ icon: "loader-circle", word: "Working" })
    expect(s.needs).toMatchObject({ icon: "circle-alert", word: "Waiting on you", tone: "warn" })
    expect(Object.values(s).filter((x) => x.tone === "err").map((x) => x.word)).toEqual(["Failed"])
  })
  it("puts Failed under Needs you", () => {
    expect(fdGroupOf("failed")).toBe("needs")
    expect(fdGroupOf("working")).toBe("working")
  })
})

describe("fdCounts: the tab counts follow the filters", () => {
  const tabs = ["open", "in_progress", "waiting", "failed", "done", ""]
  it("counts each tab over the posts the filters leave", () => {
    const states = ["needs", "failed", "working", "working", "waiting", "notstarted", "done", "cancelled"]
    expect(fdCounts(states, tabs)).toEqual({ open: 6, in_progress: 2, waiting: 2, failed: 1, done: 1, "": 8 })
  })
  it("a filter that leaves fewer posts lowers every count, and a tab shows what it counts", () => {
    const filtered = ["working", "done"]
    const c = fdCounts(filtered, tabs)
    expect(c).toEqual({ open: 1, in_progress: 1, waiting: 0, failed: 0, done: 1, "": 2 })
    for (const t of tabs) expect(filtered.filter((s) => fdInTab(s, t)).length).toBe(c[t])
  })
})

describe("fdAgo and fdClock: one time format", () => {
  const now = Date.parse("2026-11-26T10:04:00Z")
  it("says now, 2m, 1h, 2d", () => {
    expect(fdAgo(now - 20e3, now)).toBe("now")
    expect(fdAgo(now - 125e3, now)).toBe("2m")
    expect(fdAgo(now - 3600e3 * 1.5, now)).toBe("1h")
    expect(fdAgo(now - 86400e3 * 2.2, now)).toBe("2d")
    expect(fdAgo(now + 5000, now)).toBe("now")
  })
  it("gives a sync its local clock time", () => {
    expect(fdClock(new Date(2026, 10, 26, 9, 5).getTime())).toBe("09:05")
  })
})

describe("fdSortBy: the List view's sort", () => {
  const rows = [{ id: "a", idle: 2 }, { id: "b", idle: 5 }, { id: "c", idle: 2 }, { id: "d", idle: 0 }]
  it("sorts falling and rising, and keeps ties in their order", () => {
    expect(fdSortBy(rows, (r) => r.idle, -1).map((r) => r.id)).toEqual(["b", "a", "c", "d"])
    expect(fdSortBy(rows, (r) => r.idle, 1).map((r) => r.id)).toEqual(["d", "a", "c", "b"])
  })
})

// A small stand-in for the DOM: elements with a key, markup and children.
class El implements FdEl {
  children: El[] = []
  parent: El | null = null
  attrs: Record<string, string> = {}
  focused = false
  _fdHtml?: string
  constructor(public html = "", key?: string) {
    if (key != null) this.attrs["data-key"] = key
    for (const m of html.matchAll(/<button data-fk="([^"]+)"( aria-expanded="true")?>/g)) {
      const b = new El()
      b.attrs["data-fk"] = m[1]
      if (m[2]) b.attrs["aria-expanded"] = "true"
      b.parent = this
      this.children.push(b)
    }
  }
  getAttribute(k: string) { return this.attrs[k] ?? null }
  insertBefore(el: El, ref: El | null) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    const i = ref ? this.children.indexOf(ref) : -1
    if (i < 0) this.children.push(el); else this.children.splice(i, 0, el)
    el.parent = this
  }
  removeChild(el: El) { this.children.splice(this.children.indexOf(el), 1); el.parent = null }
  replaceChild(el: El, old: El) { this.children[this.children.indexOf(old)] = el; el.parent = this; old.parent = null }
  contains(x: unknown): boolean { return x === this || this.children.some((c) => c.contains(x)) }
  querySelector(sel: string): El | null {
    const fk = /data-fk="([^"]+)"/.exec(sel)?.[1]
    const all: El[] = []
    const walk = (e: El) => { for (const c of e.children) { all.push(c); walk(c) } }
    walk(this)
    if (fk) return all.find((e) => e.attrs["data-fk"] === fk) ?? null
    if (sel.includes("aria-expanded")) return all.find((e) => e.attrs["aria-expanded"] === "true") ?? null
    return null
  }
  focus() { this.focused = true }
}
const make = (html: string) => new El(html, /data-key="([^"]+)"/.exec(html)![1])
const row = (k: string, text: string, extra = "") => ({ key: k, html: `<li data-key="${k}">${text}${extra}</li>` })
const keys = (b: El) => b.children.map((c) => c.getAttribute("data-key"))

describe("fdPatch: live lists patch rows by key (C28)", () => {
  it("adds every row on the first paint", () => {
    const box = new El()
    expect(fdPatch(box, [row("a", "A"), row("b", "B")], make)).toEqual({ added: 2, changed: 0, kept: 2 - 2, removed: 0 })
    expect(keys(box)).toEqual(["a", "b"])
  })
  it("keeps the rows that did not change: the same elements, not new ones", () => {
    const box = new El()
    fdPatch(box, [row("a", "A"), row("b", "B"), row("c", "C")], make)
    const [a, b, c] = box.children
    const n = fdPatch(box, [row("a", "A"), row("b", "B2"), row("c", "C")], make)
    expect(n).toEqual({ added: 0, changed: 1, kept: 2, removed: 0 })
    expect(box.children[0]).toBe(a)
    expect(box.children[1]).not.toBe(b)
    expect(box.children[2]).toBe(c)
  })
  it("moves, adds and drops rows to follow the new order", () => {
    const box = new El()
    fdPatch(box, [row("a", "A"), row("b", "B"), row("c", "C")], make)
    const c = box.children[2]
    const n = fdPatch(box, [row("c", "C"), row("d", "D"), row("a", "A")], make)
    expect(keys(box)).toEqual(["c", "d", "a"])
    expect(box.children[0]).toBe(c)
    expect(n).toEqual({ added: 1, changed: 0, kept: 2, removed: 1 })
  })
  it("gives the focus back to the same control in a changed row", () => {
    const box = new El()
    fdPatch(box, [row("a", "A", '<button data-fk="stop">')], make)
    const old = box.children[0].children[0]
    const n = fdPatch(box, [row("a", "A 2m", '<button data-fk="stop">')], make, { activeElement: old })
    expect(n.changed).toBe(1)
    expect(box.children[0].children[0].focused).toBe(true)
  })
  it("leaves a row with an open menu alone until the next refresh", () => {
    const box = new El()
    fdPatch(box, [row("a", "A", '<button data-fk="more" aria-expanded="true">')], make)
    const a = box.children[0]
    expect(fdPatch(box, [row("a", "A changed")], make).kept).toBe(1)
    expect(box.children[0]).toBe(a)
  })
  it("runs as injected into the page script", () => {
    const src = injectFns({ fdState, fdInTab, fdCounts, fdAgo, fdPatch, fdSortBy })
    const g: Record<string, any> = {}
    new Function("globalThis", src.replace(/globalThis/g, "g").replace(/^/, "const g = globalThis;"))(g)
    expect(g.fdCounts(["working"], ["open"])).toEqual({ open: 1 })
    const box = new El()
    expect(g.fdPatch(box, [row("a", "A")], make).added).toBe(1)
  })
})
