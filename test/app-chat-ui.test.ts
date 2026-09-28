import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AppChatStore, LIMITS } from "../src/daemon/app-chat-store"
import { safeUi, upstreamRequest } from "../src/daemon/app-chat-relay"
import { openDb, closeDb } from "../src/storage/sqlite"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { APP_CHAT_SCRIPT } from "../src/daemon/ui/pages/app-chat.client"
import { APP_CHAT_VIEW_SCRIPT } from "../src/daemon/ui/pages/app-chat-view.client"
import { markdownToHtml } from "../src/utils/markdown-html"

// The Chat tab's page code, its safety rules for what an agent writes, and
// the bounds on saved history.

describe("page scripts", () => {
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])

  it("ships the chat scripts in order, and every inline script parses", () => {
    const found = scripts(renderAppPage())
    const chat = found.find((s) => s.includes("window.AXChatView ="))!
    expect(chat).toBeDefined()
    expect(chat.indexOf("markdownToHtml")).toBeLessThan(chat.indexOf("window.AXChatView ="))
    expect(chat.indexOf("window.AXChatView =")).toBeLessThan(chat.indexOf("var V = window.AXChatView"))
    for (const s of found) expect(() => new Function(s)).not.toThrow()
  })

  it("holds no backslash, backtick or dollar-brace (they break inside the template literal)", () => {
    for (const s of [APP_CHAT_SCRIPT, APP_CHAT_VIEW_SCRIPT]) {
      expect(s).not.toContain("\\")
      expect(s).not.toContain("`")
      expect(s).not.toContain("${")
    }
  })
})

/** Just enough DOM for renderUi: elements record children, text and props. */
function fakeDom() {
  const make = (tag: string): any => {
    const el: any = {
      tagName: tag.toUpperCase(), children: [] as any[], listeners: {} as Record<string, Function>,
      appendChild(c: any) { el.children.push(c); return c },
      addEventListener(t: string, f: Function) { el.listeners[t] = f },
      querySelectorAll: (sel: string) => sel === ".cx-reply" ? walk(el).filter((c: any) => c !== el && /\bcx-reply\b/.test(c.className || "")) : [],
      set innerHTML(v: string) { if (v !== "") throw new Error("renderUi must not write HTML: " + v); el.children = [] },
    }
    return el
  }
  return { createElement: make }
}
const walk = (el: any): any[] => [el, ...el.children.flatMap(walk)]

function view() {
  const document = fakeDom()
  const window: any = {}
  new Function("window", "document", "location", "markdownToHtml", APP_CHAT_VIEW_SCRIPT)(
    window, document, { href: "https://phone.example/app" }, markdownToHtml)
  return { V: window.AXChatView, document }
}

describe("rendering what an agent wrote", () => {
  it("escapes text and keeps only web links", () => {
    const { V } = view()
    expect(V.esc(`<img src=x onerror="a()">&'`)).toBe("&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;")
    expect(V.httpUrl("javascript:alert(1)")).toBe("")
    expect(V.httpUrl("data:text/html,x")).toBe("")
    expect(V.httpUrl("https://example.com/a")).toBe("https://example.com/a")
  })

  it("markdown escapes raw HTML before adding markup", () => {
    const html = markdownToHtml("**hi** <script>x()</script> [a](javascript:alert(1))")
    expect(html).toContain("<strong>hi</strong>")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })

  it("hides a half-written agentx:ui block while streaming", () => {
    const { V } = view()
    expect(V.preview("Answer\n```agentx:ui\n{\"butt")).toBe("Answer")
    expect(V.preview("Answer only")).toBe("Answer only")
  })

  it("streams pictures as links for an agent with rich messages off (#259)", () => {
    const { V } = view()
    const text = "See ![Sales](https://example.com/s.png) and `![c](https://x/c.png)`\n```\n![f](https://x/f.png)\n```"
    expect(V.preview(text, true)).toBe("See [Sales](https://example.com/s.png) and `![c](https://x/c.png)`\n```\n![f](https://x/f.png)\n```")
    expect(V.preview("![](https://example.com/a.png)", true)).toBe("[https://example.com/a.png](https://example.com/a.png)")
    expect(V.preview(text)).toBe(text)
  })

  it("renders buttons, a poll and media as elements with text, never HTML", () => {
    const { V } = view()
    const box = fakeDom().createElement("div")
    const sent: string[] = []
    V.renderUi(box, {
      media: { type: "image", url: "https://example.com/p.png", caption: "<b>cap</b>" },
      buttons: [{ label: "<i>Docs</i>", url: "https://example.com/docs" }, { label: "Evil", url: "javascript:alert(1)" }],
      poll: { question: "Ship?", options: ["Yes", "<No>"] },
    }, (t: string) => sent.push(t))
    const all = walk(box)
    const img = all.find((e) => e.tagName === "IMG")
    expect(img.src).toBe("https://example.com/p.png")
    expect(img.alt).toBe("<b>cap</b>") // a property, not markup
    const links = all.filter((e) => e.tagName === "A")
    expect(links.map((a) => [a.textContent, a.href, a.rel])).toEqual([["<i>Docs</i>", "https://example.com/docs", "noopener noreferrer"]])
    const options = all.filter((e) => e.tagName === "BUTTON")
    expect(options.map((b) => b.textContent)).toEqual(["Yes", "<No>"])
    options[1].listeners.click()
    expect(sent).toEqual(["<No>"]) // a poll answer is the next message
  })

  it("sends a tapped quick reply as the next message, then none can be tapped again", () => {
    const { V } = view()
    const box = fakeDom().createElement("div")
    const sent: string[] = []
    V.renderUi(box, { quickReplies: ["Yes", "No", "<Later>"] }, (t: string) => sent.push(t))
    const chips = walk(box).filter((e) => e.tagName === "BUTTON")
    expect(chips.map((b) => [b.textContent, b.disabled])).toEqual([["Yes", undefined], ["No", undefined], ["<Later>", undefined]])
    chips[1].listeners.click()
    expect(sent).toEqual(["No"]) // exactly what typing "No" would send
    expect(chips.map((b) => b.disabled)).toEqual([true, true, true])
  })

  it("clips a long label on screen but sends the full text, and a reply button sends its reply", () => {
    const { V } = view()
    const box = fakeDom().createElement("div")
    const sent: string[] = []
    const long = "Please also update the changelog and the docs page"
    V.renderUi(box, { quickReplies: [long], replies: [{ label: "Tests", reply: "Please run the tests" }] }, (t: string) => sent.push(t))
    const [chip, reply] = walk(box).filter((e) => e.tagName === "BUTTON")
    expect(chip.textContent).toBe(long.slice(0, 39) + "…")
    expect(chip.title).toBe(long)
    expect(chip.children).toEqual([])
    expect(reply.textContent).toBe("Tests")
    expect(reply.children.map((c: any) => [c.tagName, c.textContent])).toEqual([["SMALL", "Please run the tests"]])
    chip.listeners.click()
    expect(sent).toEqual([long])
    expect(reply.disabled).toBe(true)
  })

  it("keeps quick replies tappable when the message could not be sent", () => {
    const { V } = view()
    const box = fakeDom().createElement("div")
    V.renderUi(box, { quickReplies: ["Yes", "No"] }, () => false) // offline
    const chips = walk(box).filter((e) => e.tagName === "BUTTON")
    chips[0].listeners.click()
    expect(chips.map((b) => b.disabled)).toEqual([undefined, undefined])
  })

  it("drops media that isn't a web link", () => {
    const { V } = view()
    const box = fakeDom().createElement("div")
    V.renderUi(box, { media: { type: "video", url: "javascript:alert(1)" } }, () => {})
    expect(walk(box)).toHaveLength(1)
  })
})

describe("the saved agentx:ui block", () => {
  it("keeps web links only and bounds sizes", () => {
    const ui = safeUi({
      buttons: [...Array(12)].map((_, i) => ({ label: "x".repeat(200), url: i ? `https://e.com/${i}` : "javascript:x" })),
      poll: { question: "q", options: [...Array(20)].map((_, i) => `o${i}`) },
      media: { type: "image", url: "file:///etc/passwd" },
      skippedActions: ["a"],
    })!
    expect(ui.buttons).toHaveLength(8)
    expect(ui.buttons![0]).toEqual({ label: "x".repeat(80), url: "https://e.com/1" })
    expect(ui.poll!.options).toHaveLength(10)
    expect(ui.media).toBeUndefined()
    expect(ui.skippedActions).toBeUndefined()
    expect(safeUi({ buttons: [{ label: "a", url: "ftp://x" }] })).toBeUndefined()
  })

  it("keeps at most 4 quick replies and 4 reply buttons, with their full text", () => {
    const long = "y".repeat(60)
    const ui = safeUi({
      quickReplies: ["a", "b", "c", long, "e"],
      replies: [...Array(6)].map((_, i) => ({ label: `r${i}`, reply: `reply ${i}` })),
    })!
    expect(ui.quickReplies).toEqual(["a", "b", "c", long])
    expect(ui.replies).toHaveLength(4)
    expect(ui.replies![0]).toEqual({ label: "r0", reply: "reply 0" })
    expect(safeUi({ quickReplies: ["z".repeat(900)] })!.quickReplies![0]).toHaveLength(500)
  })

  it("routes local agents to /task and peers to /mesh/task with the app context", () => {
    expect(upstreamRequest({ node: "local", agent: "a", message: "m", chatId: "app:c1" }))
      .toEqual({ path: "/task", body: { agent: "a", message: "m", stream: true, context: { channel: "app", chatId: "app:c1", sender: "operator" } } })
    expect(upstreamRequest({ node: "peer", agent: "a", message: "m", chatId: "app:c1" }).path).toBe("/mesh/task")
  })
})

describe("history bounds", () => {
  let dir: string
  let store: AppChatStore
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-app-chat-store-"))
    store = new AppChatStore(openDb({ path: join(dir, "db.sqlite") })!)
  })
  afterAll(() => { closeDb(); rmSync(dir, { recursive: true, force: true }) })
  const target = { node: "local", nodeName: "node-a", agent: "alpha" }

  it("keeps the newest messages of a conversation and cuts a very long one", () => {
    const c = store.create("dev-1", target, "hello")
    for (let i = 0; i < LIMITS.messagesPerConversation + 25; i++) store.append("dev-1", c.id, { role: "user", content: `m${i}`, at: i })
    store.append("dev-1", c.id, { role: "assistant", content: "y".repeat(LIMITS.content + 500), at: 9999 })
    const got = store.get("dev-1", c.id)!
    expect(got.messages).toHaveLength(LIMITS.messagesPerConversation)
    expect(got.messages[0].content).toBe("m26")
    expect(got.messages.at(-1)!.content.length).toBeLessThan(LIMITS.content + 100)
    expect(got.messages.at(-1)!.content).toMatch(/Cut here/)
  })

  it("keeps the newest conversations per phone and never mixes phones", () => {
    const first = store.create("dev-2", target, "oldest", 1)
    for (let i = 0; i < LIMITS.conversationsPerDevice; i++) store.create("dev-2", target, `c${i}`, 10 + i)
    expect(store.list("dev-2")).toHaveLength(LIMITS.conversationsPerDevice)
    expect(store.get("dev-2", first.id)).toBeNull()
    expect(store.list("dev-2")[0].title).toBe(`c${LIMITS.conversationsPerDevice - 1}`)
    expect(store.list("dev-3")).toEqual([])
    expect(store.append("dev-3", store.list("dev-2")[0].id, { role: "user", content: "x", at: 1 })).toBe(false)
    expect(store.get("dev-2", "../../etc")).toBeNull()
  })
})
