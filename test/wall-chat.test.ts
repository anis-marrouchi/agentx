import { markdownToHtml } from "../src/utils/markdown-html"
import { describe, expect, it } from "vitest"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_CHAT_SCRIPT } from "../src/daemon/ui/pages/wall-chat.client"
import { WALL_CHAT_INPUT_SCRIPT } from "../src/daemon/ui/pages/wall-chat-input.client"
import { chatAttached, chatContextLine, chatLiveHtml, chatLogHtml } from "../src/daemon/ui/pages/wall-chat-view"
import { cfFoldHtml, cfParseLive } from "../src/daemon/ui/pages/wall-chat-fold"
import { chAskHtml, chAsksFor, chEngine, chFace, chPlanHtml, chProofsHtml, chReqsFor, chState } from "../src/daemon/ui/pages/wall-chat-head.client"
import { openWall } from "./wall-settings-harness"

// #1528: the Hub chat panel, option A (notes/design/hub-chat-panel.md).
// The panel's real script runs against a stubbed DOM and fetch below.

type Reply = { status: number; body: unknown } | "down"

function openChat(opts: { owner?: boolean; signIn?: boolean; thread?: string; node?: string; hash?: string; route?: (url: string, init: any) => Reply | Promise<Reply> | undefined } = {}) {
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
        : url === "/api/monitor?nodes=1" ?{ status: 200, body: { nodes: [{ name: "studio", url: "http://studio", ok: true }] } }
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
  const loc = { pathname: "/hub", hash: opts.hash ?? "#status=failed" }
  const setHash = (_state: unknown, _title: string, href: string) => { loc.hash = href.startsWith("#") ? href : "" }
  const hashes: string[] = []
  win.history = {
    replaceState: setHash,
    pushState(state: unknown, title: string, href: string) {
      hashes.push(loc.hash)
      setHash(state, title, href)
    },
    back() { loc.hash = hashes.pop() ?? "" },
  }
  const timers: Array<() => void> = []
  const delays: number[] = []
  new Function("document", "window", "fetch", "location", "localStorage", "setTimeout", "clearTimeout", WALL_CHAT_SCRIPT)(
    doc, win, fetchStub, loc, storage, (f: () => void, ms: number) => { timers.push(f); delays.push(ms); return timers.length }, () => {},
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
  return { page, el, calls, ls, wallCls, fire, settle, timers, delays, streams, docOn, key, win, loc }
}

describe("Hub entry routes", () => {
  it("opens chat on the bare Hub and backs out to the feed", async () => {
    const h = openChat({ hash: "" })
    expect(h.wallCls.has("hc-open")).toBe(true)
    expect(h.el("hc").hidden).toBe(false)
    expect(h.loc.hash).toBe("#page=chat")
    await h.settle()
    expect(h.loc.hash).toBe("#page=chat&agent=scout")
    await h.fire("hc-back", "click")
    expect(h.el("hc").hidden).toBe(true)
    expect(h.loc.hash).toBe("#status=open&view=feed")
  })

  it("keeps explicit feed links in the feed", () => {
    const h = openChat({ hash: "#status=open&view=feed" })
    expect(h.wallCls.has("hc-open")).toBe(false)
    expect(h.el("hc").hidden).toBe(true)
  })
})

describe("Hub chat: what it draws (#1528)", () => {
  it("sums up the page context in one line", () => {
    expect(chatContextLine({ page: "Hub", status: "failed", count: 2 })).toBe("Hub · Failed · 2 posts in view")
    expect(chatContextLine({ page: "Post", post: { id: "p1", headline: "Nightly backup" } })).toBe("Post · post “Nightly backup”")
    expect(chatContextLine({ page: "Hub", status: "waiting_owner", count: 1 })).toBe("Hub · waiting owner · 1 post in view")
    expect(chatContextLine(null)).toBe("this page")
  })

  it("draws the empty state, a pending answer and a rendered reply", () => {
    expect(chatLogHtml([], { agent: "Scout" })).toContain("<b>Ask Scout</b>")
    const html = chatLogHtml([
      { role: "user", content: "Why <did> it fail?", status: "done" },
      { role: "assistant", content: "**403**", status: "done" },
      { role: "user", content: "And now?", status: "done" },
      { role: "assistant", content: "", status: "pending" },
    ], { agent: "Scout", md: markdownToHtml })
    expect(html).toContain("Why &lt;did&gt; it fail?")
    expect(html).toContain("<p><strong>403</strong></p>")
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
    expect(html).toContain('<div data-hc-live><div class="b"><p>Looking at the log</p></div></div>')
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
    expect(html).not.toContain("hc__empty")
  })
})

describe("Hub chat: on the page (#1528)", () => {
  it("puts the Chat box first in the side column and the chat in the middle pane, for the owner", () => {
    const page = renderWallPage({ owner: true })
    expect(page).toMatch(/<aside class="ax-wall__aside" id="wall-aside">\s*<section class="ax-wall__box hcq" id="hc-quick"/)
    expect(page).toContain('id="hc-quick-form"')
    // The middle pane (#2101 PR 2): last in the main column, no column of its own.
    expect(page).toMatch(/hidden><\/section>\s*<section class="hc" id="hc" aria-label="Chat" hidden>[\s\S]*<\/section>\s*<\/div>\s*<aside class="ax-wall__aside"/)
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

  it("names the machine's refusal to the signed-in owner, with no sign-in", async () => {
    const refused = { status: 502, body: { error: "That machine refused this dashboard's token." } }
    const w = openChat({ thread: "t1", route: (url) => (url.startsWith("/api/assistant") ? refused : undefined) })
    await w.settle()
    await w.fire("hc-btn", "click")
    expect(w.el("hc-log").innerHTML).toContain("refused this dashboard")
    expect(w.el("hc-log").innerHTML).not.toContain("Sign in")
    expect(w.ls.get("ax-assistant-thread")).toBe("t1")
    w.el("hc-agent").value = "scout"
    w.el("hc-text").value = "Hello"
    await w.fire("hc-form", "submit")
    expect(w.el("hc-log").innerHTML).toContain("refused this dashboard")
    expect(w.el("hc-log").innerHTML).not.toContain("Sign in")
    expect(w.el("hc-text").value).toBe("Hello")
    await w.fire("hc-hist", "click")
    expect(w.el("hc-hist-err").hidden).toBe(false)
    expect(w.el("hc-hist-err").textContent).toContain("refused this dashboard")
    expect(w.el("hc-hist-empty").hidden).toBe(true)
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

// #2101 PR 2: the chat is the Hub's middle pane, one conversation per agent
// (R12), answers folded like Claude Code (R14).
const FOLD = { parse: cfParseLive, html: cfFoldHtml }
const thread = (id: string, agentId: string, title: string, extra: object = {}) => ({
  status: 200, body: { thread: { id, title, agentId }, messages: [{ role: "user", content: title, status: "done" }, { role: "assistant", content: "ok", status: "done", taskId: "task-" + id }], ...extra },
})

describe("Hub chat: each agent keeps its own conversation (#2101 R12)", () => {
  it("opens the agent's newest conversation on a switch, and the first one as it was on the way back", async () => {
    const w = openChat({
      thread: "s1",
      route: (url) => url === "/api/assistant/thread?id=s1" ? thread("s1", "scout", "Disk space?")
        : url === "/api/assistant/threads?agent=forge" ? { status: 200, body: { threads: [{ id: "f1", title: "Deploy?", agentId: "forge" }] } }
        : url === "/api/assistant/thread?id=f1" ? thread("f1", "forge", "Deploy?")
        : undefined,
    })
    await w.settle()
    await w.fire("hc-btn", "click")
    expect(w.el("hc-sub").textContent).toBe("Disk space?")
    expect(w.el("hc-who").textContent).toBe("Scout")

    w.el("hc-agent").value = "forge"
    await w.fire("hc-agent", "change")
    expect(w.calls.filter((c) => c.url === "/api/assistant/threads?agent=forge")).toHaveLength(1)
    expect(w.el("hc-sub").textContent).toBe("Deploy?")
    expect(w.el("hc-who").textContent).toBe("Forge")
    expect(w.ls.get("ax-assistant-thread")).toBe("f1")

    // Back to Scout: its conversation from memory, no list read.
    w.el("hc-agent").value = "scout"
    await w.fire("hc-agent", "change")
    expect(w.calls.some((c) => c.url.startsWith("/api/assistant/threads?agent=scout"))).toBe(false)
    expect(w.el("hc-sub").textContent).toBe("Disk space?")
    expect(w.ls.get("ax-assistant-thread")).toBe("s1")

    // And Forge again: remembered too.
    w.el("hc-agent").value = "forge"
    await w.fire("hc-agent", "change")
    expect(w.calls.filter((c) => c.url === "/api/assistant/threads?agent=forge")).toHaveLength(1)
    expect(w.el("hc-sub").textContent).toBe("Deploy?")
    expect(JSON.parse(w.ls.get("ax-hub-chat-agents")!)).toMatchObject({ scout: { t: "s1" }, forge: { t: "f1" } })
  })

  it("starts a new conversation for an agent that has none, and sends it to that agent", async () => {
    const w = openChat({
      thread: "s1",
      route: (url, init) => url === "/api/assistant/thread?id=s1" ? thread("s1", "scout", "Disk space?")
        : url === "/api/assistant/threads?agent=forge" ? { status: 200, body: { threads: [] } }
        : url === "/api/assistant" && init.method === "POST" ? { status: 200, body: { threadId: "f2" } }
        : url === "/api/assistant/thread?id=f2" ? thread("f2", "forge", "Hello forge")
        : undefined,
    })
    await w.settle()
    await w.fire("hc-btn", "click")
    w.el("hc-agent").value = "forge"
    await w.fire("hc-agent", "change")
    expect(w.el("hc-log").innerHTML).toContain("<b>Ask Forge</b>")
    expect(w.ls.get("ax-assistant-thread")).toBeUndefined()
    w.el("hc-text").value = "Hello forge"
    await w.fire("hc-form", "submit")
    const post = w.calls.find((c) => c.method === "POST")!
    expect(post.body).toMatchObject({ agentId: "forge", message: "Hello forge" })
    expect(post.body.threadId).toBeUndefined()
    expect(JSON.parse(w.ls.get("ax-hub-chat-agents")!)).toMatchObject({ scout: { t: "s1" }, forge: { t: "f2" } })
  })

  it("shows the agents as a strip of chips, like the phone, and a chip switches the conversation (#2101)", async () => {
    const w = openChat({
      thread: "s1",
      route: (url) => url === "/api/assistant/thread?id=s1" ? thread("s1", "scout", "Disk space?")
        : url === "/api/assistant/threads?agent=forge" ? { status: 200, body: { threads: [{ id: "f1", title: "Deploy?", agentId: "forge" }] } }
        : url === "/api/assistant/thread?id=f1" ? thread("f1", "forge", "Deploy?")
        : undefined,
    })
    await w.settle()
    await w.fire("hc-btn", "click")
    expect(w.page).toContain('id="hc-strip"')
    const strip = w.el("hc-strip")
    expect(strip.hidden).toBe(false)
    expect(strip.innerHTML).toContain('data-agent="scout" aria-pressed="true"')
    expect(strip.innerHTML).toContain('data-agent="forge" aria-pressed="false"')
    expect(strip.innerHTML).toContain("Forge")
    // A chip that is not an agent (the strip's own padding) does nothing.
    await w.fire("hc-strip", "click", { target: { closest: () => null } })
    expect(w.el("hc-agent").value).toBe("scout")
    // Forge's chip: same switch as the picker, and the strip follows.
    await w.fire("hc-strip", "click", { target: { closest: () => ({ getAttribute: (k: string) => (k === "data-agent" ? "forge" : null) }) } })
    expect(w.el("hc-agent").value).toBe("forge")
    expect(w.el("hc-sub").textContent).toBe("Deploy?")
    expect(strip.innerHTML).toContain('data-agent="forge" aria-pressed="true"')
    expect(strip.innerHTML).toContain('data-agent="scout" aria-pressed="false"')
  })

  it("keeps the picker when there are no agents to put in the strip", async () => {
    const w = openChat({ route: (url) => url === "/api/agents" ? { status: 200, body: { agents: [] } } : undefined })
    await w.settle()
    expect(w.el("hc-strip").hidden).toBe(true)
    expect(w.el("hc-agent").innerHTML).toContain("No agents on this node")
  })

  it("opens from its link, #page=chat&agent=<id>", async () => {
    const w = openChat({
      hash: "#page=chat&agent=forge",
      route: (url) => url === "/api/assistant/threads?agent=forge" ? { status: 200, body: { threads: [{ id: "f1", title: "Deploy?", agentId: "forge" }] } }
        : url === "/api/assistant/thread?id=f1" ? thread("f1", "forge", "Deploy?")
        : undefined,
    })
    await w.settle()
    expect(w.el("hc").hidden).toBe(false)
    expect(w.wallCls.has("hc-open")).toBe(true)
    expect(w.el("hc-agent").value).toBe("forge")
    expect(w.el("hc-sub").textContent).toBe("Deploy?")
  })
})

describe("Hub chat: answers like Claude Code (#2101 R14)", () => {
  it("folds a finished answer's steps under Worked for, one line each", async () => {
    const runs = { "task-s1": { ms: 72_000, steps: [
      { tool: "Read", input: '{"file_path":"/repo/src/wall.ts"}', error: false },
      { tool: "Edit", input: '{"file_path":"/repo/src/index.ts","old_string":"a"}', error: false },
      { tool: "Bash", input: '{"command":"npm test\\nnpm run lint"}', error: true },
    ] } }
    const w = openChat({ thread: "s1", route: (url) => url === "/api/assistant/thread?id=s1" ? thread("s1", "scout", "Fix it", { runs }) : undefined })
    await w.settle()
    await w.fire("hc-btn", "click")
    const log = w.el("hc-log").innerHTML
    expect(log).toContain("Worked for 1m 12s · 3 steps")
    expect(log).toContain(">Read wall.ts</li>")
    expect(log).toContain(">Edited index.ts</li>")
    expect(log).toContain("Ran npm test <b>failed</b>")
    expect(log).toContain('data-hc-fold="task-s1"')
    // Folded: the answer itself shows, the steps wait behind the summary.
    expect(log).not.toContain('data-hc-fold="task-s1" open')
  })

  it("streams the fold and the answer, never the raw tool, thought or init lines, and keeps an error line", async () => {
    const w = openChat({
      thread: "t1", node: "http://studio",
      route: (url) => url.startsWith("/api/assistant/thread?id=t1") ? { status: 200, body: {
        node: "http://studio", thread: { id: "t1", title: "Why?", agentId: "scout" },
        messages: [{ role: "user", content: "Why?", status: "done" }, { role: "assistant", content: "", status: "pending", taskId: "task-7" }],
      } } : undefined,
    })
    await w.settle()
    await w.fire("hc-btn", "click")
    w.streams[0].emit("start", { initial: "· init model=opus\n💭 let me look ↵ closer\n" })
    w.streams[0].emit("chunk", { text: '→ Read({"file_path":"/var/log/backup.log"})\n← line one ↵ line two\n[error] Daily budget reached for scout\nThe backup ran out of disk.' })
    const log = w.el("hc-log").innerHTML
    expect(log).toContain("Working")
    expect(log).toContain("Read backup.log")
    expect(log).toContain("The backup ran out of disk.")
    expect(log).toContain("<pre>line one ↵ line two</pre>")
    expect(log).toContain('<div class="hc__notice" role="alert"><b>Error</b>Daily budget reached for scout</div>')
    for (const raw of ["→ Read", "💭", "let me look", "init model"]) expect(log).not.toContain(raw)
  })

  it("says a spoken message's answer back through the speak route", async () => {
    let pending = true
    const w = openChat({
      route: (url, init) => url === "/api/assistant" && init.method === "POST" ? { status: 200, body: { threadId: "v1", node: "http://studio" } }
        : url.startsWith("/api/assistant/thread?id=v1") ? { status: 200, body: { thread: { id: "v1", title: "Status?", agentId: "scout" },
          messages: [{ role: "user", content: "Status?", status: "done" }, pending ? { role: "assistant", content: "", status: "pending" } : { role: "assistant", content: "All green.", status: "done" }] } }
        : url === "/api/assistant/voice/speak" ? { status: 200, body: { fallback: "browser", text: "All green." } }
        : undefined,
    })
    await w.settle()
    w.el("hc-agent").value = "scout"
    await w.win.AXHubChat.send("Status?", { spoken: true })
    await w.settle()
    expect(w.calls.find((c) => c.url === "/api/assistant")!.body).toMatchObject({ message: "Status?", spoken: true })
    expect(w.calls.some((c) => c.url === "/api/assistant/voice/speak")).toBe(false)
    pending = false
    w.timers.at(-1)!()
    await w.settle()
    const speak = w.calls.filter((c) => c.url === "/api/assistant/voice/speak")
    expect(speak).toHaveLength(1)
    expect(speak[0].body).toEqual({ threadId: "v1", node: "http://studio", text: "All green." })
  })

  it("sends the uploaded files with the message and shows them as chips", async () => {
    const w = openChat({
      route: (url, init) => url === "/api/assistant" && init.method === "POST" ? { status: 200, body: { threadId: "a1" } }
        : url === "/api/assistant/thread?id=a1" ? { status: 200, body: { thread: { id: "a1", title: "Look", agentId: "scout" },
          messages: [{ role: "user", content: "Look\n\nAttached: chart.png", status: "done" }] } }
        : undefined,
    })
    await w.settle()
    w.win.AXHubChat.attachments = () => [{ name: "chart.png", path: "/ws/uploads/x-chart.png" }]
    w.el("hc-agent").value = "scout"
    w.el("hc-text").value = "Look"
    await w.fire("hc-form", "submit")
    expect(w.calls.find((c) => c.url === "/api/assistant")!.body.attachments).toEqual([{ name: "chart.png", path: "/ws/uploads/x-chart.png" }])
    expect(w.el("hc-log").innerHTML).toContain('<div class="b"><p>Look</p></div><div class="hc__files"><span class="hc__file">chart.png</span></div>')
  })

  it("draws the fold and the live part from the parser", () => {
    const p = cfParseLive('→ Grep({"pattern":"TODO"})\n← [error] no match\n> codex command_execution ls -la\nDone.')
    expect(p.steps.map((s) => [s.tool, s.error])).toEqual([["Grep", true], ["Bash", false]])
    expect(p.answer).toBe("Done.")
    expect(chatLiveHtml("", { key: "k", fold: FOLD })).toBeNull()
    expect(chatAttached("Hi\n\nAttached: a.png, b.pdf")).toEqual({ text: "Hi", files: ["a.png", "b.pdf"] })
    expect(chatAttached("Plain")).toEqual({ text: "Plain", files: [] })
  })
})

describe("Hub chat composer (#2101 P7)", () => {
  const agents = { status: 200, body: { agents: [{ id: "scout", name: "Scout", tier: "claude-code", model: "claude-opus-4-6" }, { id: "forge", name: "Forge", tier: "codex-cli", model: "gpt-6.2-sol" }] } }

  it("tells the composer who is in view, with the agent's engine and model", async () => {
    const seen: unknown[] = []
    const w = openChat({ hash: "", route: (url) => (url === "/api/agents" ? agents : undefined) })
    w.win.AXHubChat.onAgent = (...a: unknown[]) => { seen.push(a) }
    await w.settle()
    w.el("hc-agent").value = "forge"
    await w.fire("hc-agent", "change")
    expect(seen).toContainEqual(["scout", "Scout", { tier: "claude-code", model: "claude-opus-4-6" }])
    expect(seen.at(-1)).toEqual(["forge", "Forge", { tier: "codex-cli", model: "gpt-6.2-sol" }])
  })

  it("sends the picked model with the message, and none when the agent's own is kept", async () => {
    const w = openChat({ route: (url, init) => (url === "/api/agents" ? agents : url === "/api/assistant" && init.method === "POST" ? { status: 200, body: { threadId: "t9", pending: true } } : undefined) })
    await w.settle()
    w.el("hc-agent").value = "scout"
    w.win.AXHubChat.model = () => "sonnet"
    w.el("hc-text").value = "Quick one"
    await w.fire("hc-form", "submit")
    const post = w.calls.filter((c) => c.url === "/api/assistant" && c.method === "POST")
    expect(post.at(-1)?.body.model).toBe("sonnet")
    w.win.AXHubChat.model = () => ""
    w.el("hc-text").value = "Another"
    await w.fire("hc-form", "submit")
    expect(w.calls.filter((c) => c.url === "/api/assistant" && c.method === "POST").at(-1)?.body.model).toBeUndefined()
  })

  it("draws one rounded card: To chip, message, attach, model, mic, send arrow", () => {
    const page = renderWallPage({ owner: true })
    const card = /<div class="hc__comp" id="hc-comp">[\s\S]*?<p class="hc__voice"/.exec(page)?.[0] ?? ""
    for (const id of ["hc-to-tag", "hc-text", "hc-attach", "hc-model", "hc-mic", "hc-send"]) expect(card).toContain(`id="${id}"`)
    expect(card.indexOf('id="hc-attach"')).toBeLessThan(card.indexOf('id="hc-model"'))
    expect(card.indexOf('id="hc-model"')).toBeLessThan(card.indexOf('id="hc-send"'))
    expect(card).toContain('aria-label="Send"')
    expect(card).not.toContain(">Send</button>")
  })
})

describe("Hub chat composer script (#2101 P7)", () => {
  function composer() {
    const els = new Map<string, any>()
    const el = (id: string) => {
      if (!els.has(id)) {
        const attrs: Record<string, string> = {}
        const cls = new Set<string>()
        const e: any = { id, on: {}, hidden: ["hc-model", "hc-model-own", "hc-to-tag", "hc-mic"].includes(id), value: "", textContent: "", innerHTML: "",
          getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v },
          classList: { toggle: (c: string, v: boolean) => { v ? cls.add(c) : cls.delete(c) }, has: (c: string) => cls.has(c) },
          addEventListener: (t: string, f: any) => { (e.on[t] ??= []).push(f) } }
        els.set(id, e)
      }
      return els.get(id)
    }
    el("hc-form")
    const ls = new Map<string, string>()
    const storage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v) } }
    let agent = "scout"
    const api: any = { agent: () => agent, node: () => "", headers: (h: any) => h, send: () => Promise.resolve(true) }
    new Function("document", "window", "fetch", "localStorage", WALL_CHAT_INPUT_SCRIPT)({ getElementById: el }, { AXHubChat: api, navigator: {} }, () => Promise.reject(new Error("no")), storage)
    return { el, api, ls, setAgent: (a: string) => { agent = a } }
  }

  it("offers Claude's models to a claude-code agent and keeps the pick per agent", () => {
    const c = composer()
    c.api.onAgent("scout", "Scout", { tier: "claude-code", model: "claude-opus-4-6" })
    expect(c.el("hc-to-tag").hidden).toBe(false)
    expect(c.el("hc-to").textContent).toBe("To Scout")
    expect(c.el("hc-text").getAttribute("placeholder")).toBe("Message Scout…")
    expect(c.el("hc-model").hidden).toBe(false)
    expect(c.el("hc-model").innerHTML).toContain('<option value="sonnet">Sonnet</option>')
    expect(c.el("hc-model").innerHTML).toContain('<option value="">Opus (own)</option>')
    expect(c.api.model()).toBe("")
    c.el("hc-model").value = "haiku"
    c.el("hc-model").on.change[0]()
    expect(c.api.model()).toBe("haiku")
    expect(JSON.parse(c.ls.get("ax-hub-chat-model")!)).toEqual({ scout: "haiku" })
  })

  it("shows a codex agent's own model, with nothing to pick", () => {
    const c = composer()
    c.setAgent("forge")
    c.api.onAgent("forge", "Forge", { tier: "codex-cli", model: "gpt-6.2-sol" })
    expect(c.el("hc-model").hidden).toBe(true)
    expect(c.el("hc-model-own").hidden).toBe(false)
    expect(c.el("hc-model-own").textContent).toBe("gpt-6.2-sol")
    expect(c.api.model()).toBe("")
  })
})

describe("Hub chat header and questions: what it draws (#2101 P5, P6)", () => {
  it("gives each agent a face, an engine name and one state word", () => {
    expect(chFace("pm", "pm")).toEqual({ letter: "P", colour: chFace("pm", "other").colour })
    expect(chFace("pm", "pm").colour).toMatch(/^#[0-9A-F]{6}$/i)
    expect(chEngine("claude-code")).toBe("Claude Code")
    expect(chEngine("codex-cli")).toBe("Codex")
    expect(chEngine("")).toBe("")
    expect(chState({ pending: true, asks: 1, waiting: true, done: true })).toEqual({ key: "work", word: "Working" })
    expect(chState({ pending: false, asks: 1, waiting: false, done: true })).toEqual({ key: "wait", word: "Waiting on you" })
    expect(chState({ pending: false, asks: 0, waiting: false, done: true })).toEqual({ key: "done", word: "Done" })
    expect(chState({ pending: false, asks: 0, waiting: false, done: false })).toBeNull()
  })

  it("keeps only the agent's own Desk cards and the requests it has a step in", () => {
    const items = [{ key: "card:a", kind: "card", raised_by: "pm" }, { key: "card:b", kind: "card", raised_by: "cx" }, { key: "schedule:x", kind: "schedule", raised_by: "pm" }]
    expect(chAsksFor(items, "pm").map((i) => i.key)).toEqual(["card:a"])
    const reqs = [{ id: "r1", agentId: "pm" }, { id: "r2", agentId: "cx", plan: { steps: [{ idx: 1, name: "Build", agentId: "pm" }] } }, { id: "r3", agentId: "cx" }]
    expect(chReqsFor(reqs, "pm").map((r) => r.id)).toEqual(["r1", "r2"])
  })

  it("draws a question as a card with Accept, Ask for changes and Later, escaped", () => {
    const now = Date.parse("2026-11-24T12:00:00Z")
    const html = chAskHtml({ key: "card:c1", ask: "Accept the <design> note?", created_at: "2026-11-24T11:48:00Z" }, { name: "pm", now })
    expect(html).toContain('data-hc-askkey="card:c1"')
    expect(html).toContain("<b>pm</b> asks you")
    expect(html).toContain("12m ago")
    expect(html).toContain("Accept the &lt;design&gt; note?")
    expect(html).toMatch(/hc__ab--pri" data-hc-ask="yes">Accept</)
    expect(html).toContain('data-hc-ask="changes">Ask for changes<')
    expect(html).toContain('data-hc-ask="later">Later<')
    // Choices: one button each, the suggested one in blue.
    const ch = chAskHtml({ key: "card:c2", ask: "Which?", choices: ["Ship", "Wait"], recommend: "Wait: CI is red" }, { name: "pm", now })
    expect(ch).toContain('class="hc__ab" data-hc-ask="yes" data-hc-choice="1">Ship<')
    expect(ch).toContain('class="hc__ab hc__ab--pri" data-hc-ask="yes" data-hc-choice="2">Wait<')
    expect(ch).not.toContain(">Accept<")
    // Ask for changes opens a box for what to change.
    const open = chAskHtml({ key: "card:c1", ask: "Q?" }, { name: "pm", now, draft: { open: true, text: "Shorter" } })
    expect(open).toContain("What should pm change?")
    expect(open).toContain(">Shorter</textarea>")
    expect(open).toContain('data-hc-ask="no"')
  })

  it("lists the plan's steps, and the proofs of the steps done", () => {
    const reqs = [{ id: "req-1", summary: "Restyle", plan: { steps: [
      { idx: 1, name: "Design note", agentId: "dev-session", state: "done", evidence: "https://x.test/c1" },
      { idx: 2, name: "Review", agentId: "pm", state: "active" },
    ] } }]
    const plan = chPlanHtml(reqs, "pm")
    expect(plan).toContain('href="#post=req-1"')
    expect(plan).toContain("2 steps")
    expect(plan).toMatch(/is-done[^]*✓[^]*Design note/)
    expect(plan).toContain("pm · now")
    expect(chPlanHtml([], "pm")).toContain("pm has no open request with a plan.")
    const proofs = chProofsHtml(reqs, "pm")
    expect(proofs).toContain('href="https://x.test/c1"')
    expect(proofs).not.toContain("Review")
    expect(chProofsHtml([], "pm")).toContain("No proofs yet")
  })
})

describe("Hub chat header and questions: on the page (#2101 P5, P6)", () => {
  const thread = { status: 200, body: { thread: { id: "t1", title: "Restyle", agentId: "scout" }, messages: [{ role: "user", content: "Go", status: "done" }, { role: "assistant", content: "", status: "pending", taskId: "task-9" }] } }
  const desk = { status: 200, body: { items: [{ key: "card:c1", kind: "card", raised_by: "scout", ask: "Accept the design note?", created_at: new Date().toISOString() }, { key: "card:c2", kind: "card", raised_by: "forge", ask: "Not Scout's" }] } }
  const requests = { status: 200, body: { items: [{ id: "req-1", agentId: "scout", summary: "Restyle", state: "in_progress", plan: { steps: [{ idx: 1, name: "Build", agentId: "scout", state: "done", evidence: "https://x.test/pr" }] } }] } }
  function route(extra?: (url: string, init: any) => Reply | undefined) {
    return (url: string, init: any): Reply | undefined => extra?.(url, init)
      ?? (url === "/api/agents" ? { status: 200, body: { agents: [{ id: "scout", name: "Scout", tier: "claude-code" }, { id: "forge", name: "Forge", tier: "codex-cli" }] } }
        : url.startsWith("/api/assistant/thread?id=t1") ? thread
        : url === "/api/admin/approvals" ? desk
        : url === "/api/admin/approvals/requests" ? requests
        : undefined)
  }
  const target = (attrs: Record<string, string>, card?: any) => ({
    getAttribute: (k: string) => attrs[k] ?? null,
    closest: (s: string) => (s === "[data-hc-ask]" ? target(attrs, card) : s === "[data-hc-askkey]" ? card : null),
  })

  it("draws the face, computer · engine, Working pill, Stop and ↗ Request", async () => {
    const w = openChat({ thread: "t1", node: "http://studio", route: route() })
    await w.settle()
    await w.fire("hc-btn", "click")
    expect(w.el("hc-face").hidden).toBe(false)
    expect(w.el("hc-face").textContent).toBe("S")
    expect(w.el("hc-where").textContent).toBe("studio · Claude Code")
    expect(w.el("hc-pill").hidden).toBe(false)
    expect(w.el("hc-pill").textContent).toBe("Working")
    expect(w.el("hc-hstop").hidden).toBe(false)
    expect(w.el("hc-req").hidden).toBe(false)
    expect(w.el("hc-req").getAttribute("href")).toBe("#post=req-1")
    // Stop in the header stops the pending run, as the answer's Stop does.
    await w.fire("hc-hstop", "click")
    expect(w.calls.some((c) => c.method === "POST" && c.url === "/api/task/action?node=http%3A%2F%2Fstudio&task=task-9&kind=cancel")).toBe(true)
  })

  it("shows the agent's own question in the thread and answers it through the Desk route", async () => {
    const w = openChat({ thread: "t1", node: "http://studio", route: route((url, init) => (url === "/api/admin/wall/decide" && init.method === "POST" ? { status: 200, body: { ok: true } } : undefined)) })
    await w.settle()
    await w.fire("hc-btn", "click")
    const log = w.el("hc-log").innerHTML
    expect(log).toContain("<b>Scout</b> asks you")
    expect(log).toContain("Accept the design note?")
    expect(log).not.toContain("Not Scout's")
    const card = target({ "data-hc-askkey": "card:c1" })
    await w.fire("hc-log", "click", { target: target({ "data-hc-ask": "yes" }, card) })
    const post = w.calls.find((c) => c.url === "/api/admin/wall/decide")!
    expect(post.body).toEqual({ key: "card:c1", action: "yes" })
    expect(post.headers["X-Requested-With"]).toBe("agentx-board")
    // Answered: gone from the thread.
    expect(w.el("hc-log").innerHTML).not.toContain("Accept the design note?")
  })

  it("asks for changes with a note, and keeps the card when the answer is refused", async () => {
    const w = openChat({ thread: "t1", node: "http://studio", route: route((url, init) => (url === "/api/admin/wall/decide" && init.method === "POST" ? { status: 409, body: { error: "already answered" } } : undefined)) })
    await w.settle()
    await w.fire("hc-btn", "click")
    const card = target({ "data-hc-askkey": "card:c1" })
    await w.fire("hc-log", "click", { target: target({ "data-hc-ask": "changes" }, card) })
    expect(w.el("hc-log").innerHTML).toContain("What should Scout change?")
    // Send with nothing written: nothing goes.
    await w.fire("hc-log", "click", { target: target({ "data-hc-ask": "no" }, card) })
    expect(w.calls.some((c) => c.url === "/api/admin/wall/decide")).toBe(false)
    expect(w.el("hc-log").innerHTML).toContain("Write what to change first.")
    const ta = { value: "Shorter, please", hasAttribute: (k: string) => k === "data-hc-ask-text", closest: () => card }
    await w.fire("hc-log", "input", { target: ta })
    await w.fire("hc-log", "click", { target: target({ "data-hc-ask": "no" }, card) })
    expect(w.calls.find((c) => c.url === "/api/admin/wall/decide")!.body).toEqual({ key: "card:c1", action: "no", note: "Shorter, please" })
    expect(w.el("hc-log").innerHTML).toContain("Not answered: already answered")
    expect(w.el("hc-log").innerHTML).toContain("Accept the design note?")
  })

  it("switches to Plan and Proofs, and back to Chat", async () => {
    const w = openChat({ thread: "t1", node: "http://studio", route: route() })
    await w.settle()
    await w.fire("hc-btn", "click")
    const tab = (t: string) => ({ getAttribute: () => t, closest: () => ({ getAttribute: () => t }) })
    await w.fire("hc-tabs", "click", { target: tab("plan") })
    expect(w.el("hc-log").hidden).toBe(true)
    expect(w.el("hc-tabview").hidden).toBe(false)
    expect(w.el("hc-tabview").innerHTML).toContain("Build")
    await w.fire("hc-tabs", "click", { target: tab("proofs") })
    expect(w.el("hc-tabview").innerHTML).toContain('href="https://x.test/pr"')
    await w.fire("hc-tabs", "click", { target: tab("chat") })
    expect(w.el("hc-log").hidden).toBe(false)
    expect(w.el("hc-tabview").hidden).toBe(true)
  })
})
