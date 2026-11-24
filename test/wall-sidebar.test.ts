import { describe, expect, it } from "vitest"
import { wsFold, wsKey, wsCopiesHtml, wsNeedsHtml } from "../src/daemon/ui/pages/wall-sidebar"

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const age = (ms: number) => Math.round(ms / 60000) + "m"
const OPEN = ["open", "in_progress", "needs_attention"]
const open = (p: { state?: string }) => OPEN.includes(String(p.state))

describe("one post per item (#2101 R10)", () => {
  it("keys on owner and the first headline line, ignoring case and spaces", () => {
    expect(wsKey({ id: "a", owner: "pm", headline: "Check  #2101 PR 1c\nmore" })).toBe("pm|check #2101 pr 1c")
    expect(wsKey({ id: "a", owner: "pm", headline: "" })).toBe("")
  })

  it("folds open copies into the newest, in its own place, and keeps the rest", () => {
    const posts = [
      { id: "x", owner: "pm", headline: "Other", state: "open", lastMoveAt: 50 },
      { id: "p1", owner: "pm", headline: "Check #2101 PR 1c", state: "open", lastMoveAt: 10 },
      { id: "p2", owner: "pm", headline: "check #2101 pr 1c", state: "in_progress", lastMoveAt: 30 },
      { id: "p3", owner: "pm", headline: "Check #2101 PR 1c", state: "open", lastMoveAt: 20 },
    ]
    const out = wsFold(posts, open)
    expect(out.map((p) => p.id)).toEqual(["x", "p2"])
    expect(out[1].copies).toEqual(["p3", "p1"])
    // The input is left as it was.
    expect((posts[2] as { copies?: string[] }).copies).toBeUndefined()
  })

  it("never folds a closed post, another owner's post or a post with no headline", () => {
    const posts = [
      { id: "a", owner: "pm", headline: "Same", state: "open", lastMoveAt: 1 },
      { id: "b", owner: "pm", headline: "Same", state: "done", lastMoveAt: 2 },
      { id: "c", owner: "cx", headline: "Same", state: "open", lastMoveAt: 3 },
      { id: "d", owner: "pm", headline: "", state: "open", lastMoveAt: 4 },
      { id: "e", owner: "pm", headline: "", state: "open", lastMoveAt: 5 },
    ]
    expect(wsFold(posts, open).map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"])
  })

  it("links each folded copy", () => {
    const html = wsCopiesHtml({ id: "p2", copies: ["p3", "p<1"] }, esc)
    expect(html).toContain("2 more posts like this")
    expect(html).toContain('data-open="p&lt;1"')
    expect(wsCopiesHtml({ id: "p" }, esc)).toBe("")
  })
})

describe("Needs you first, short (#2101 R3)", () => {
  const name = (id: string) => id.toUpperCase()
  const NOW = 10 * 3600_000
  const items = Array.from({ length: 7 }, (_, i) => ({ key: "k" + i, title: "Ask " + i, agent: "pm", at: NOW - (i + 1) * 60_000 }))

  it("shows the oldest five, then Show all with the page's count", () => {
    const html = wsNeedsHtml(items, 135, "you", "#status=open&view=decide", NOW, esc, age, name)
    expect(html).toContain("Needs you")
    expect(html).toContain(">135</b>")
    expect((html.match(/lt__need"/g) || []).length).toBe(5)
    expect(html.indexOf("Ask 6")).toBeLessThan(html.indexOf("Ask 2"))
    expect(html).not.toContain("Ask 1<")
    expect(html).toContain("Show all 135")
    expect(html).toContain("PM · <time>7m</time>")
  })

  it("leaves out what was put off, and draws nothing when nothing waits", () => {
    const html = wsNeedsHtml([{ key: "a", title: "Later one", snoozed: 1 }, { key: "b", title: "Now one" }], 1, "you", "#n", NOW, esc, age, name)
    expect(html).toContain("Now one")
    expect(html).not.toContain("Later one")
    expect(html).not.toContain("Show all")
    expect(wsNeedsHtml([], 0, "you", "#n", NOW, esc, age, name)).toBe("")
  })

  it("says the owner to anyone else, and escapes the titles", () => {
    const html = wsNeedsHtml([{ key: "a", title: "<b>x</b>" }], 1, "the owner", "#n", NOW, esc, age, name)
    expect(html).toContain("Needs the owner")
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;")
  })
})
