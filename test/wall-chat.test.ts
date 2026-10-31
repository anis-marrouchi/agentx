import { describe, expect, it } from "vitest"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_CHAT_SCRIPT } from "../src/daemon/ui/pages/wall-chat.client"
import { chatContextLine, chatLogHtml } from "../src/daemon/ui/pages/wall-chat-view"
import { openWall } from "./wall-settings-harness"

// #1528: the Hub chat panel, option A (notes/design/hub-chat-panel.md).
// The panel's real script runs against a stubbed DOM and fetch below.

type Reply = { status: number; body: unknown } | "down"

function openChat(opts: { owner?: boolean; signIn?: boolean; thread?: string; node?: string; route?: (url: string, init: any) => Reply | Promise<Reply> | undefined } = {}) {
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
  const ls = new Map<string, string>([
    ...(opts.thread ? [["ax-assistant-thread", opts.thread] as [string, string]] : []),
    ...(opts.node ? [["ax-hub-chat-node", opts.node] as [string, string]] : []),
  ])
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
    return Promise.resolve(r).then((r) => {
      if (r === "down") throw new TypeError("Failed to fetch")
      return { ok: r.status < 400, status: r.status, json: async () => r.body }
    })
  }
  // One EventSource per stream the panel opens; emit() plays an event in.
  const streams: Array<{ url: string; closed: boolean; on: Record<string, (ev: any) => void>; emit: (t: string, d?: unknown) => void }> = []
  class FakeES {
    s: any
    constructor(url: string) {
      this.s = { url, closed: false, on: {}, emit: (t: string, d?: unknown) => this.s.on[t]?.({ data: JSON.stringify(d ?? {}) }) }
      streams.push(this.s)
    }
    addEventListener(t: string, f: (ev: any) => void) { this.s.on[t] = f }
    close() { this.s.closed = true }
  }
  const win: any = { AX_LOCAL_TOKEN: "tok", EventSource: FakeES, addEventListener: () => {}, axPageContext: () => ({ page: "Hub", view: "feed", status: "failed", count: 2, inView: ["Nightly backup", "Weekly digest"] }) }
  const timers: Array<() => void> = []
  const delays: number[] = []
  new Function("document", "window", "fetch", "location", "localStorage", "setTimeout", "clearTimeout", WALL_CHAT_SCRIPT)(
    doc, win, fetchStub, { pathname: "/hub", hash: "#status=failed" }, storage, (f: () => void, ms: number) => { timers.push(f); delays.push(ms); return timers.length }, () => {},
  )
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const fire = async (id: string, type: string, ev: any = {}) => {
    for (const f of el(id).on[type] ?? []) f({ preventDefault() {}, ...ev })
    await settle()
  }
  const key = async (ev: any) => {
    for (const f of docOn.on.keydown ?? []) f({ preventDefault() {}, defaultPrevented: false, target: {}, ...ev })
    await settle()
  }
  return { page, el, calls, ls, wallCls, fire, settle, timers, delays, streams, docOn, key }
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

  it("streams a started answer with Stop and Open the run", () => {
    const msgs = [
      { role: "user" as const, content: "Why?", status: "done" as const },
      { role: "assistant" as const, content: "", status: "pending" as const, taskId: "task-7" },
    ]
    const html = chatLogHtml(msgs, { agent: "Scout", md: (s) => "<p>" + s + "</p>", live: "Looking at the log", runHref: "#page=task&task=task-7" })
    expect(html).toContain("<p>Looking at the log</p>")
    expect(html).not.toContain("Thinking…")
    expect(html).toContain('data-hc-stop="task-7"')
    expect(html).toContain('<a class="hc__run" href="#page=task&amp;task=task-7">Open the run</a>')
    expect(html).toContain('<div class="b" data-hc-live><p>Looking at the log</p></div>')
    expect(chatLogHtml(msgs, { agent: "Scout", live: "x", stopFailed: true })).toContain('data-hc-stop="task-7">Not stopped. Try again</button>')
    // Not started yet: no run to stop or open.
    const waiting = chatLogHtml([msgs[0], { ...msgs[1], taskId: null }], { agent: "Scout" })
    expect(waiting).toContain("Thinking…")
    expect(waiting).not.toContain("data-hc-stop")
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

  it("ignores a slow failed read of a conversation no longer open", async () => {
    let failOld!: () => void
    const old = new Promise<Reply>((res) => { failOld = () => res({ status: 500, body: { error: "boom" } }) })
    const w = openChat({
      thread: "old",
      route: (url) => url === "/api/assistant/thread?id=old" ? old
        : url === "/api/assistant/thread?id=new" ? { status: 200, body: { thread: { id: "new", title: "Disk space?", agentId: "scout" }, messages: [] } }
        : undefined,
    })
    await w.settle()
    await w.fire("hc-btn", "click")
    const pick = { closest: (s: string) => (s === "[data-hc-thread]" ? { getAttribute: () => "new" } : null) }
    await w.fire("hc-hist-list", "click", { target: pick })
    expect(w.el("hc-sub").textContent).toBe("Disk space?")
    failOld()
    await w.settle()
    expect(w.ls.get("ax-assistant-thread")).toBe("new")
    expect(w.el("hc-sub").textContent).toBe("Disk space?")
  })

  it("leaves Escape to another Hub dialog that holds the focus", async () => {
    const w = openChat()
    await w.settle()
    await w.fire("hc-btn", "click")
    await w.key({ key: "Escape", target: { closest: () => ({ id: "wf-dlg" }) } })
    expect(w.el("hc").hidden).toBe(false)
    await w.key({ key: "Escape", defaultPrevented: true })
    expect(w.el("hc").hidden).toBe(false)
    await w.key({ key: "Escape" })
    expect(w.el("hc").hidden).toBe(true)
  })

  it("keeps a conversation the node did not delete, and says so", async () => {
    let reply: Reply = { status: 500, body: { error: "disk full" } }
    const w = openChat({
      thread: "t1",
      route: (url) => url === "/api/assistant/delete" ? reply
        : url === "/api/assistant/thread?id=t1" ? { status: 200, body: { thread: { id: "t1", title: "Backup?", agentId: "scout" }, messages: [] } }
        : undefined,
    })
    await w.settle()
    await w.fire("hc-btn", "click")
    const del = { closest: (s: string) => (s === "[data-hc-del]" ? { getAttribute: () => "t1" } : null) }
    await w.fire("hc-hist-list", "click", { target: del })
    expect(w.el("hc-hist-err").hidden).toBe(false)
    expect(w.el("hc-hist-err").textContent).toBe("Not deleted. Try again.")
    expect(w.ls.get("ax-assistant-thread")).toBe("t1")
    expect(w.el("hc-sub").textContent).toBe("Backup?")
    reply = { status: 401, body: { error: "unauthorized" } }
    await w.fire("hc-hist-list", "click", { target: del })
    expect(w.el("hc-log").innerHTML).toContain("Chat is for the owner")
    expect(w.ls.get("ax-assistant-thread")).toBe("t1")
    reply = { status: 200, body: { ok: true } }
    await w.fire("hc-hist-list", "click", { target: del })
    expect(w.el("hc-hist-err").hidden).toBe(true)
    expect(w.ls.get("ax-assistant-thread")).toBeUndefined()
  })

  it("streams the pending run from its node, stops it, and closes the stream with the panel", async () => {
    let pending = true
    const thread = () => ({ status: 200, body: {
      node: "http://studio",
      thread: { id: "t1", title: "Why?", agentId: "scout" },
      messages: [{ role: "user", content: "Why?", status: "done" }, pending
        ? { role: "assistant", content: "", status: "pending", taskId: "task-7" }
        : { role: "assistant", content: "Stopped", status: "error", taskId: "task-7" }],
    } })
    const w = openChat({
      thread: "t1", node: "http://studio",
      route: (url, init) => url === "/api/assistant/thread?id=t1&node=http%3A%2F%2Fstudio" ? thread()
        : url.startsWith("/api/task/action") && init.method === "POST" ? (pending = false, { status: 200, body: { ok: true } })
        : undefined,
    })
    await w.settle()
    await w.fire("hc-btn", "click")
    expect(w.streams.map((s) => s.url)).toEqual(["/api/task/stream?node=http%3A%2F%2Fstudio&agent=scout&task=task-7"])
    w.streams[0].emit("start", { initial: "Reading " })
    w.streams[0].emit("chunk", { text: "the log" })
    const log = w.el("hc-log").innerHTML
    expect(log).toContain("Reading the log")
    expect(log).toContain('href="#page=task&amp;task=task-7&amp;agent=scout&amp;node=http%3A%2F%2Fstudio&amp;ask=Why%3F">Open the run</a>')
    // The stream is open: the thread read is only the fallback.
    expect(w.delays.at(-1)).toBe(5000)

    const stop = { disabled: false, textContent: "Stop", getAttribute: () => "task-7" }
    await w.fire("hc-log", "click", { target: { closest: (s: string) => (s === "[data-hc-stop]" ? stop : null) } })
    const cancel = w.calls.find((c) => c.url.startsWith("/api/task/action"))!
    expect(cancel.url).toBe("/api/task/action?node=http%3A%2F%2Fstudio&task=task-7&kind=cancel")
    expect(w.el("hc-log").innerHTML).toContain("could not answer")
    expect(w.streams[0].closed).toBe(true)

    // A pending answer with the panel closed: no stream, a read every 10 s.
    pending = true
    await w.fire("hc-btn", "click")
    expect(w.el("hc").hidden).toBe(true)
    w.timers.at(-1)!()
    await w.settle()
    expect(w.delays.at(-1)).toBe(10000)
    expect(w.streams.filter((s) => !s.closed)).toEqual([])
  })

  it("falls back to the quick read when the stream errors, without reopening it (#1637)", async () => {
    const w = openChat({
      thread: "t1", node: "http://studio",
      route: (url) => url.startsWith("/api/assistant/thread?id=t1") ? { status: 200, body: {
        node: "http://studio", thread: { id: "t1", title: "Why?", agentId: "scout" },
        messages: [{ role: "user", content: "Why?", status: "done" }, { role: "assistant", content: "", status: "pending", taskId: "task-7" }],
      } } : undefined,
    })
    await w.settle()
    await w.fire("hc-btn", "click")
    expect(w.streams).toHaveLength(1)
    // The node no longer knows the run: `event: error`, then the stream ends.
    w.streams[0].emit("error", { message: "task not found or already evicted" })
    expect(w.streams[0].closed).toBe(true)
    expect(w.delays.at(-1)).toBe(1500)
    w.timers.at(-1)!()
    await w.settle()
    expect(w.streams).toHaveLength(1)
    expect(w.delays.at(-1)).toBe(1500)
  })

  it("repaints only the streamed text on a chunk, so Stop keeps its label (#1637)", async () => {
    let fail = true
    const w = openChat({
      thread: "t1", node: "http://studio",
      route: (url, init) => url.startsWith("/api/assistant/thread?id=t1") ? { status: 200, body: {
        node: "http://studio", thread: { id: "t1", title: "Why?", agentId: "scout" },
        messages: [{ role: "user", content: "Why?", status: "done" }, { role: "assistant", content: "", status: "pending", taskId: "task-7" }],
      } } : url.startsWith("/api/task/action") && init.method === "POST" ? (fail ? "down" : { status: 200, body: { ok: true } })
        : undefined,
    })
    const liveEl = { innerHTML: "" }
    w.el("hc-log").querySelector = (s: string) => (s === "[data-hc-live]" ? liveEl : null)
    await w.settle()
    await w.fire("hc-btn", "click")
    w.streams[0].emit("start", { initial: "Reading " })
    expect(w.el("hc-log").innerHTML).toContain("Reading")
    const stop = { disabled: false, textContent: "Stop", getAttribute: () => "task-7" }
    await w.fire("hc-log", "click", { target: { closest: (s: string) => (s === "[data-hc-stop]" ? stop : null) } })
    expect(stop.textContent).toBe("Not stopped. Try again")
    const before = w.el("hc-log").innerHTML
    w.streams[0].emit("chunk", { text: "the log" })
    w.streams[0].emit("chunk", { text: "\n[task finished]\n" })
    expect(w.el("hc-log").innerHTML).toBe(before)
    expect(liveEl.innerHTML).toContain("Reading the log")
    expect(liveEl.innerHTML).not.toContain("task finished")
    // A full repaint (the thread read) still says Stop did not take.
    w.timers.at(-1)!()
    await w.settle()
    expect(w.el("hc-log").innerHTML).toContain("Not stopped. Try again")
    fail = false
  })

  it("sends a conversation's next message to the node that holds it", async () => {
    const w = openChat({
      thread: "t1", node: "http://studio",
      route: (url, init) => url === "/api/assistant" && init.method === "POST" ? { status: 200, body: { threadId: "t1", node: "http://studio" } }
        : url.startsWith("/api/assistant/thread?id=t1") ? { status: 200, body: { thread: { id: "t1", title: "Why?", agentId: "scout" }, messages: [] } }
        : undefined,
    })
    await w.settle()
    w.el("hc-text").value = "And now?"
    await w.fire("hc-form", "submit")
    expect(w.calls.find((c) => c.method === "POST")!.body.node).toBe("http://studio")
    expect(w.ls.get("ax-hub-chat-node")).toBe("http://studio")
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
