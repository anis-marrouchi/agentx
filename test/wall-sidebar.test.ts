import { describe, expect, it } from "vitest"
import { wsFold, wsKey, wsCopiesHtml } from "../src/daemon/ui/pages/wall-sidebar"

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
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
