import { describe, expect, it } from "vitest"
import { followAttach, followBtnHtml } from "../src/daemon/ui/pages/wall-follow"
import { chatLogHtml, type ChatMessage } from "../src/daemon/ui/pages/wall-chat-view"
import { tsFoldHtml, tsTurnHtml } from "../src/daemon/ui/pages/wall-task-session"
import { injectFns } from "../src/daemon/ui/inject"

// #2101 (Anis 11-25): the conversation reads like Orca's chat. It follows a
// streaming reply; scrolling up stops that and shows Jump to latest;
// earlier turns fold to their ask and the newest stays open.

function box(o: { scrollHeight: number; clientHeight: number; scrollTop?: number }) {
  const on: Record<string, Array<(e: unknown) => void>> = {}
  const el = {
    scrollHeight: o.scrollHeight, clientHeight: o.clientHeight, scrollTop: o.scrollTop ?? 0,
    addEventListener(k: string, f: (e: unknown) => void) { (on[k] ||= []).push(f) },
    removeEventListener(k: string, f: (e: unknown) => void) { on[k] = (on[k] || []).filter((g) => g !== f) },
    fire(k: string) { for (const f of on[k] || []) f({ preventDefault() {} }) },
    count(k: string) { return (on[k] || []).length },
  }
  return el
}
function btn() {
  const b = box({ scrollHeight: 0, clientHeight: 0 }) as ReturnType<typeof box> & { hidden: boolean }
  b.hidden = true
  return b
}

describe("followAttach", () => {
  it("follows at the bottom, stops when scrolled up, and the button brings it back", () => {
    const s = box({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 })
    const b = btn()
    const f = followAttach(s as unknown as HTMLElement, b as unknown as HTMLElement)
    expect(f.following()).toBe(true)
    expect(b.hidden).toBe(true)
    // New content while following: it goes to the bottom.
    s.scrollHeight = 2400; f.stick()
    expect(s.scrollTop).toBe(2400)
    // The reader scrolls up: following stops, the button shows.
    s.scrollTop = 800; s.fire("scroll")
    expect(f.following()).toBe(false)
    expect(b.hidden).toBe(false)
    // More content does not move the reader.
    s.scrollHeight = 3000; f.stick()
    expect(s.scrollTop).toBe(800)
    // The button: back to the bottom, following again, hidden.
    b.fire("click")
    expect(s.scrollTop).toBe(3000)
    expect(f.following()).toBe(true)
    expect(b.hidden).toBe(true)
  })

  it("counts 59 px from the bottom as at the bottom, 60 px as scrolled up", () => {
    const s = box({ scrollHeight: 1000, clientHeight: 400 })
    const f = followAttach(s as unknown as HTMLElement, null)
    s.scrollTop = 541; s.fire("scroll")
    expect(f.following()).toBe(true)
    s.scrollTop = 540; s.fire("scroll")
    expect(f.following()).toBe(false)
    f.jump()
    expect(f.following()).toBe(true)
    expect(s.scrollTop).toBe(1000)
  })

  it("stop removes its listeners; no scroll box is a no-op", () => {
    const s = box({ scrollHeight: 10, clientHeight: 10 })
    const b = btn()
    const f = followAttach(s as unknown as HTMLElement, b as unknown as HTMLElement)
    f.stop()
    expect(s.count("scroll")).toBe(0)
    expect(b.count("click")).toBe(0)
    const none = followAttach(null, null)
    expect(() => { none.stick(); none.jump(); none.stop() }).not.toThrow()
  })

  it("stands alone when shipped to the browser", () => {
    const src = injectFns({ followAttach })
    const made = new Function(src + "; return followAttach")() as typeof followAttach
    const s = box({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 })
    expect(made(s as unknown as HTMLElement, null).following()).toBe(true)
  })

  it("the button starts hidden and is labelled", () => {
    const h = followBtnHtml("hc-jump")
    expect(h).toContain('id="hc-jump"')
    expect(h).toContain('aria-label="Jump to latest"')
    expect(h).toMatch(/ hidden>/)
  })
})

describe("chatLogHtml foldTurns", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "First ask about the build", status: "done" },
    { role: "assistant", content: "First answer", status: "done" },
    { role: "user", content: "Second ask", status: "done" },
    { role: "assistant", content: "Second answer", status: "done" },
    { role: "user", content: "Newest ask", status: "done" },
    { role: "assistant", content: "Newest answer", status: "done" },
  ]

  it("folds every turn but the newest, each to its ask", () => {
    const h = chatLogHtml(msgs, { agent: "Coder", foldTurns: true })
    expect(h.match(/<details class="hc__turn"/g)?.length).toBe(2)
    expect(h).toContain('data-hc-turn="0"')
    expect(h).toContain('data-hc-turn="2"')
    expect(h).toContain('<span class="hc__turnask">First ask about the build</span>')
    // The newest turn is not inside a fold.
    expect(h.lastIndexOf("</details>")).toBeLessThan(h.indexOf("Newest ask"))
    expect(h).toContain("Newest answer")
  })

  it("keeps a turn the reader opened open, and does nothing without the option", () => {
    expect(chatLogHtml(msgs, { agent: "Coder", foldTurns: true, openTurns: { "2": true } })).toContain('data-hc-turn="2" open>')
    expect(chatLogHtml(msgs, { agent: "Coder" })).not.toContain("hc__turn")
    expect(chatLogHtml(msgs.slice(0, 2), { agent: "Coder", foldTurns: true })).not.toContain("hc__turn")
  })

  it("cuts a long ask to one line and escapes it", () => {
    const long = "<b>" + "x".repeat(200)
    const h = chatLogHtml([{ role: "user", content: long, status: "done" }, ...msgs.slice(4)], { agent: "Coder", foldTurns: true })
    expect(h).toContain("&lt;b&gt;")
    expect(h).toMatch(/x…<\/span>/)
  })
})

describe("tsFoldHtml", () => {
  it("wraps a turn in a fold with its number and ask", () => {
    const t = { id: "t1", n: 2, message: "Fix the  login\nform", ok: false }
    const inner = tsTurnHtml(t, { agent: "Coder", href: "#x", md: (s) => s, plain: (s) => s, when: () => "" })
    const h = tsFoldHtml(t, inner, false, (s) => s)
    expect(h.startsWith('<details class="wsess__fold" data-turn-fold="t1">')).toBe(true)
    expect(h).toContain("turn 2")
    expect(h).toContain("Fix the login form")
    expect(h).toContain(">failed<")
    expect(h).toContain(inner)
    expect(tsFoldHtml(t, inner, true, (s) => s)).toContain('data-turn-fold="t1" open>')
  })
})
