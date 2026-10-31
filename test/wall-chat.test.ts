import { describe, expect, it } from "vitest"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_CHAT_SCRIPT } from "../src/daemon/ui/pages/wall-chat.client"
import { chatContextLine, chatLogHtml } from "../src/daemon/ui/pages/wall-chat-view"
import { openWall } from "./wall-settings-harness"

// #1528: the Hub chat panel, option A (notes/design/hub-chat-panel.md).
// The panel's real script runs against a stubbed DOM and fetch below.

type Reply = { status: number; body: unknown } | "down"

function openChat(opts: { owner?: boolean; signIn?: boolean; thread?: string; route?: (url: string, init: any) => Reply | undefined } = {}) {
  const page = renderWallPage({ owner: opts.owner ?? true, signIn: opts.signIn })
  const els = new Map<string, any>()
  const on = (e: any) => (t: string, f: (ev: any) => void) => { (e.on[t] ??= []).push(f) }
  const make = (id: string, tag: string) => {
    const attrs: Record<string, string> = {}
    const e: any = {
      id, on: {}, hidden: /\shidden[\s>]/.test(tag), value: "", textContent: "", innerHTML: "", disabled: false, scrollTop: 0, scrollHeight: 0,
      offsetParent: {}, focused: 0, focus() { e.focused++ }, click() { (e.on.click ?? []).forEach((f: any) => f({ target: e })) },
      getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v },
    }
    e.addEventListener = on(e)
    return e
  }
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(page)
      if (!tag) return null
      els.set(id, make(id, tag[0]))
    }
    return els.get(id)
  }
  const wallCls = new Set<string>()
  const wall = { classList: { toggle: (c: string, v: boolean) => { v ? wallCls.add(c) : wallCls.delete(c) } } }
  const docOn: any = { on: {} }
  const doc = { getElementById: el, querySelector: (s: string) => (s === ".ax-wall" ? wall : null), addEventListener: on(docOn) }
  const ls = new Map<string, string>(opts.thread ? [["ax-assistant-thread", opts.thread]] : [])
  const storage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v) }, removeItem: (k: string) => { ls.delete(k) } }
  const calls: Array<{ url: string; method: string; body: any; headers: any }> = []
  const fetchStub = (url: string, init: any = {}) => {
    const method = init.method || "GET"
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers })
    const r = opts.route?.(url, init)
      ?? (url === "/api/agents" ? { status: 200, body: { agents: [{ id: "scout", name: "Scout" }, { id: "forge", name: "Forge" }] } }
        : url === "/api/monitor" ? { status: 200, body: { nodes: [{ name: "studio", url: "http://studio", ok: true }] } }
        : url === "/api/assistant/threads" ? { status: 200, body: { threads: [] } }
        : { status: 404, body: { error: "not found" } })
    if (r === "down") return Promise.reject(new TypeError("Failed to fetch"))
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })
  }
  const win: any = { AX_LOCAL_TOKEN: "tok", addEventListener: () => {}, axPageContext: () => ({ page: "Hub", view: "feed", status: "failed", count: 2, inView: ["Nightly backup", "Weekly digest"] }) }
  const timers: Array<() => void> = []
  new Function("document", "window", "fetch", "location", "localStorage", "setTimeout", "clearTimeout", WALL_CHAT_SCRIPT)(
    doc, win, fetchStub, { pathname: "/hub", hash: "#status=failed" }, storage, (f: () => void) => { timers.push(f); return timers.length }, () => {},
  )
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const fire = async (id: string, type: string, ev: any = {}) => {
    for (const f of el(id).on[type] ?? []) f({ preventDefault() {}, ...ev })
    await settle()
  }
  return { page, el, calls, ls, wallCls, fire, settle, timers, docOn }
}

describe("Hub chat: what it draws (#1528)", () => {
  it("sums up the page context in one line", () => {
    expect(chatContextLine({ page: "Hub", status: "failed", count: 2 })).toBe("Hub · Failed · 2 posts in view")
    expect(chatContextLine({ page: "Post", post: { id: "p1", headline: "Nightly backup" } })).toBe("Post · post “Nightly backup”")
    expect(chatContextLine({ page: "Hub", status: "waiting_owner", count: 1 })).toBe("Hub · waiting owner · 1 post in view")
    expect(chatContextLine(null)).toBe("this page")
  })

  it("draws the empty state, a pending answer and a rendered reply", () => {
    expect(chatLogHtml([], { agent: "Scout" })).toContain("Ask about what you see")
    const html = chatLogHtml([
      { role: "user", content: "Why <did> it fail?", status: "done" },
      { role: "assistant", content: "**403**", status: "done" },
      { role: "user", content: "And now?", status: "done" },
      { role: "assistant", content: "", status: "pending" },
    ], { agent: "Scout", md: (s) => "<p>" + s.replace(/\*\*(.+)\*\*/, "<b>$1</b>") + "</p>" })
    expect(html).toContain("Why &lt;did&gt; it fail?")
    expect(html).toContain("<p><b>403</b></p>")
    expect(html).toContain("Scout is answering")
    // Chat and New post stay apart: an answer offers no Post as a task.
    expect(html).not.toMatch(/post as a task/i)
  })

  it("offers Try again and Ask another agent only under the last failed reply", () => {
    const failed = [{ role: "user" as const, content: "Which two?", status: "done" as const }, { role: "assistant" as const, content: "budget reached", status: "error" as const }]
    const html = chatLogHtml(failed, { agent: "Atlas" })
    expect(html).toContain("<b>Atlas could not answer</b>budget reached")
    expect(html).toContain("data-hc-retry")
    expect(html).toContain("data-hc-other")
    expect(chatLogHtml([...failed, { role: "user", content: "again", status: "done" }], { agent: "Atlas" })).not.toContain("data-hc-retry")
  })

  it("keeps a message the node did not take, marked Not sent", () => {
    const html = chatLogHtml([], { agent: "Scout", notSent: "Is <it> up?" })
    expect(html).toContain("Is &lt;it&gt; up?")
    expect(html).toContain("<b>Not sent</b>")
    expect(html).not.toContain("Ask about what you see")
  })
})

describe("Hub chat: on the page (#1528)", () => {
  it("puts the Chat box first in the side column and the panel beside it, for the owner", () => {
    const page = renderWallPage({ owner: true })
    expect(page).toMatch(/<aside class="ax-wall__aside" id="wall-aside">\s*<section class="ax-wall__box hcq" id="hc-quick"/)
    expect(page).toContain('id="hc-quick-form"')
    expect(page).toMatch(/<\/aside>\s*<section class="hc" id="hc" aria-label="Chat" hidden>/)
    expect(page).toContain('id="hc-form"')
    expect(page).toContain('id="hc-btn"')
    expect(page).not.toMatch(/post as a task/i)
  })

  it("tells anyone else that chat is the owner's, with sign-in only when there is one", () => {
    const signed = renderWallPage({ owner: false, signIn: true })
    expect(signed).toContain('Chat is for the owner · <a href="/login?next=%2Fhub">Sign in</a>')
    expect(signed).toContain('<a class="ax-btn" href="/login?next=%2Fhub">Sign in</a>')
    expect(signed).not.toContain('id="hc-form"')
    expect(signed).not.toContain('id="hc-quick-form"')
    const open = renderWallPage({ owner: false })
    expect(open).toContain("This Hub has no sign-in")
    expect(open).not.toContain(`href="/login?next=%2Fhub"`)
  })

  it("reads nothing for a viewer who is not the owner", async () => {
    const w = openChat({ owner: false, signIn: true })
    await w.settle()
    expect(w.calls).toEqual([])
    await w.fire("hc-btn", "click")
    expect(w.el("hc").hidden).toBe(false)
    expect(w.calls).toEqual([])
  })

  it("asks from the Chat box: opens the panel and sends the message with the page context", async () => {
    const w = openChat({
      route: (url, init) => url === "/api/assistant" && init.method === "POST" ? { status: 200, body: { threadId: "t1" } }
        : url === "/api/assistant/thread?id=t1" ? { status: 200, body: { thread: { id: "t1", title: "Why did it fail?", agentId: "scout" }, messages: [{ role: "user", content: "Why did it fail?", status: "done" }, { role: "assistant", content: "", status: "pending" }] } }
        : undefined,
    })
    await w.settle()
    expect(w.el("hc-agent").innerHTML).toContain('<option value="scout">Scout @scout</option>')
    // One node: no node picker.
    expect(w.el("hc-node").hidden).toBe(true)
    w.el("hc-agent").value = "scout"
    w.el("hc-quick-text").value = "Why did it fail?"
    await w.fire("hc-quick-form", "submit")
    expect(w.el("hc").hidden).toBe(false)
    expect(w.wallCls.has("hc-open")).toBe(true)
    const post = w.calls.find((c) => c.method === "POST")!
    expect(post.url).toBe("/api/assistant")
    expect(post.headers.Authorization).toBe("Bearer tok")
    expect(post.body).toMatchObject({ agentId: "scout", message: "Why did it fail?", context: { page: "Hub", status: "failed", count: 2, path: "/hub#status=failed" } })
    expect(post.body.node).toBeUndefined()
    // The same conversation key as the classic drawer.
    expect(w.ls.get("ax-assistant-thread")).toBe("t1")
    expect(w.el("hc-sub").textContent).toBe("Why did it fail?")
    expect(w.el("hc-log").innerHTML).toContain("Scout is answering")
    expect(w.el("hc-ctx").textContent).toBe("Hub · Failed · 2 posts in view")
    // Pending: read again in 1.5 s, as the drawer does.
    expect(w.timers.length).toBeGreaterThan(0)
  })

  it("keeps the text and says Not sent when the node does not answer", async () => {
    const w = openChat({ route: (url, init) => (url === "/api/assistant" && init.method === "POST" ? "down" : undefined) })
    await w.settle()
    w.el("hc-agent").value = "scout"
    w.el("hc-text").value = "Is it up?"
    await w.fire("hc-form", "submit")
    expect(w.el("hc-text").value).toBe("Is it up?")
    expect(w.el("hc-log").innerHTML).toContain("<b>Not sent</b>")
    expect(w.el("hc-send").disabled).toBe(false)
  })

  it("shows sign-in when the API refuses the viewer", async () => {
    const w = openChat({ route: (url, init) => (url === "/api/assistant" && init.method === "POST" ? { status: 401, body: { error: "unauthorized" } } : undefined) })
    await w.settle()
    w.el("hc-agent").value = "scout"
    w.el("hc-text").value = "Hello"
    await w.fire("hc-form", "submit")
    expect(w.el("hc-log").innerHTML).toContain("Chat is for the owner")
    expect(w.el("hc-log").innerHTML).toContain('href="/login?next=%2Fhub"')
    expect(w.el("hc-text").value).toBe("Hello")
  })

  it("marks an answer not yet opened under the Chat box and in the header button", async () => {
    const w = openChat({ route: (url) => (url === "/api/assistant/threads" ? { status: 200, body: { threads: [{ id: "t9", title: "Backup?", agentId: "scout", updatedAt: Date.now() }] } } : undefined) })
    await w.settle()
    expect(w.el("hc-last").hidden).toBe(false)
    expect(w.el("hc-last").innerHTML).toContain("<b>Scout answered</b> “Backup?”")
    expect(w.el("hc-dot").hidden).toBe(false)
    await w.fire("hc-btn", "click")
    expect(w.el("hc-dot").hidden).toBe(true)
    expect(w.el("hc-last").innerHTML).toContain("Last: Scout, “Backup?”")
  })

  it("the Hub publishes its page context for the chat", async () => {
    const w = openWall({ hash: "#status=open&view=feed" })
    await w.settle()
    const c = w.win.axPageContext()
    expect(c).toMatchObject({ view: "feed", status: "open", count: 0, inView: [] })
    expect(typeof c.page).toBe("string")
  })
})

it("the chat script is its own, mounted once next to the page script", () => {
  const page = renderWallPage({ owner: true })
  expect(page.split(WALL_CHAT_SCRIPT.slice(0, 80)).length).toBe(2)
})
