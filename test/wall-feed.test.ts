import { describe, expect, it } from "vitest"
import { renderWallPage, WALL_CLASSIC_LINKS } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"
import { wallCapacity } from "../src/daemon/wall-capacity"
import { buildOrgView } from "../src/business/org-view"

// #1207: the Wall reads like a social feed. These tests run the page's real
// script against a stubbed DOM and fetch, over the data the Wall already
// loads, and check the author line, the action row, the Agents box and the
// agent profile.

const NOW = Date.now()
const node = { name: "node-a", peer: null, daemonUrl: null }
const post = (id: string, owner: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, owner, state, headline: `Post ${id}`, askedBy: "Demo operator", group: { channel: "telegram", chatId: "demo" },
  project: null, node, createdAt: NOW - 7200e3, lastMoveAt: NOW - 600e3, closedAt: null, runs: 1, failedRuns: 0, runMs: 120e3,
  blocked: null, timeFlag: null, home: null, evidence: null, lastRun: { taskId: `t-${id}`, agentId: owner }, ...extra,
})
const WALL = {
  node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }], failures: [],
  posts: [
    post("r1", "cx", "in_progress", { home: { kind: "issue", link: "https://example.com/demo/shop/issues/47" } }),
    post("r2", "cx", "waiting_owner"),
    post("r3", "reviewer", "done"),
  ],
}
const LIVE = { nodes: [{ name: "node-a", reachable: true, version: "1.0.0", agents: [
  { id: "cx", name: "Customer Desk", runningTasks: [{ id: "t9", startedAt: new Date(NOW).toISOString(), messagePreview: "x" }] },
  { id: "reviewer", name: "Reviewer", runningTasks: [] },
] }] }

/** What /api/admin/approvals answers (#1440): one card waits, the owner's list counts it. */
const APPROVALS = {
  items: [{ key: "card:c1", kind: "card", title: "Send the newsletter?", ask: "Send it today?", yes: "tell cx yes", no: "tell cx no",
    recommend: "Tuesday: the open rate is best", if_silent: "keep", expires: new Date(NOW + 3 * 3600e3).toISOString(), raised_by: "cx",
    created_at: new Date(NOW - 600e3).toISOString(), choices: ["Monday", "Tuesday"], draft: "Send it on {choice}." }],
  snoozed: 0, errors: [], desk: { count: 1, later: 0, items: [] }, settings: { popup: { enabled: false } },
}

function openWall(opts: { data?: unknown; hash?: string; throughput?: unknown; feed?: Promise<unknown>; live?: unknown; post?: Promise<unknown>; thread?: unknown; org?: unknown; cost?: unknown; budgets?: unknown; people?: unknown; person?: Record<string, unknown>; peerCost?: (peer: string, url: string) => unknown; budgetPost?: (body: any, peer: string | null) => { status: number; body: unknown }; timers?: Array<() => void>; liveFails?: boolean; workflows?: unknown; wfRuns?: unknown; wfRun?: Record<string, unknown>; wfWrite?: (method: string, url: string, body: any) => { status: number; body: unknown }; approvals?: unknown; decide?: { status: number; body: unknown }; reviews?: unknown; requests?: unknown; runs?: unknown; editor?: unknown; editorCfg?: unknown; confirm?: () => boolean; owner?: boolean } = {}) {
  const page = renderWallPage()
  // As on the page: the value line helpers load before the Wall script.
  const script = CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c) } }
  const el = (id: string) => {
    if (!els.has(id)) {
      // The open post's action box (wdo-*) is drawn by the script itself.
      const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(page) ?? (/^(wdo|cb)-|^wall-editor-root$/.test(id) ? [`<x id="${id}">`] : null)
      if (!tag) throw new Error(`no element #${id} on the page`)
      const attrs: Record<string, string> = {}
      const on: Record<string, (ev: unknown) => void> = {}
      let html = ""
      els.set(id, {
        on,
        // As in a browser, drawing new markup replaces the fields in it, so
        // a field the script drew holds the value the new markup gives it.
        get innerHTML() { return html },
        set innerHTML(v: string) {
          html = v
          for (const m of v.matchAll(/<(textarea|input)\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)/g)) {
            if (!els.has(m[2])) continue
            els.get(m[2]).value = m[1] === "textarea" ? m[3] : (/\bvalue="([^"]*)"/.exec(m[0])?.[1] ?? "")
          }
        },
        id, hidden: /\shidden[\s>]/.test(tag[0]), textContent: "", value: id === "f-status" ? "open" : "", checked: false,
        type: /type="checkbox"/.test(tag[0]) ? "checkbox" : /type="search"/.test(tag[0]) ? "search" : "select",
        classList: classes(), parentNode: { classList: classes() },
        addEventListener: (t: string, f: (ev: unknown) => void) => { on[t] = f }, setAttribute: (k: string, v: string) => { attrs[k] = v },
      })
    }
    return els.get(id)
  }
  const wall = { classList: classes() }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  const onWindow: Record<string, () => void> = {}
  const doc = {
    getElementById: el, hidden: false,
    querySelector: (sel: string) => (sel === ".ax-wall" ? wall : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) },
  }
  const loc = { hash: opts.hash ?? "", search: "" }
  const calls: Array<{ url: string; init: any }> = []
  const fetchStub = (url: string, init: any) => {
    calls.push({ url, init })
    if (opts.feed && url.startsWith("/api/admin/wall?")) return opts.feed
    if (opts.liveFails && url === "/api/live?quick=1") return Promise.resolve({ ok: false, status: 502, json: async () => ({}) })
    if (opts.post && url === "/api/admin/wall/post") return opts.post
    const peer = init?.headers?.["X-Agentx-Peer"] as string | undefined
    if (peer && opts.peerCost && url.startsWith("/api/admin/observability/")) {
      const body = opts.peerCost(peer, url)
      return Promise.resolve({ ok: body !== null, status: body === null ? 404 : 200, json: async () => body ?? { error: "unknown peer" } })
    }
    if (opts.budgetPost && url === "/api/admin/wall/budget" && init?.method === "POST") {
      const r = opts.budgetPost(JSON.parse(init.body), peer ?? null)
      return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })
    }
    if (url === "/api/admin/org" && opts.org === "fail") return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
    if (url.startsWith("/api/admin/observability/cost?") && opts.cost === "fail") return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
    if (url === "/api/admin/wall/decide" && opts.decide) return Promise.resolve({ ok: opts.decide.status < 400, status: opts.decide.status, json: async () => opts.decide!.body })
    if (url === "/api/admin/people" && opts.people === "fail") return Promise.resolve({ ok: false, status: 401, json: async () => ({}) })
    if (opts.wfWrite && (init?.method === "PUT" || init?.method === "POST") && (url.startsWith("/api/workflows/") || /^\/workflows\/[^/]+\/run$/.test(url))) {
      const r = opts.wfWrite(init.method, url, JSON.parse(init.body))
      return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })
    }
    if (url === "/api/workflows" && opts.workflows === "fail") return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
    if (url.endsWith("/end")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    const body = url.startsWith("/api/admin/wall?") ? (opts.data ?? WALL) : url === "/api/live?quick=1" ? (opts.live ?? LIVE)
      : url === "/api/admin/org" ? (opts.org ?? { exists: false })
      : url.startsWith("/api/admin/approvals?") || url === "/api/admin/approvals" ? structuredClone(opts.approvals ?? APPROVALS)
      : url === "/api/admin/wall/decide" ? { ok: true, message: "card:c1: cx will be told yes (Tuesday, the suggested option)" }
      : url.startsWith("/api/admin/wall/reviews") && opts.reviews ? opts.reviews
      : url === "/api/admin/approvals/requests" && opts.requests ? opts.requests
      : url.startsWith("/api/workflows/runs") && opts.runs ? opts.runs
      : url.startsWith("/api/admin/wall/request/") || url.startsWith("/api/admin/wall/review/") ? { ok: true, message: "Done." }
      : url.startsWith("/api/admin/observability/cost?") ? (opts.cost ?? { days: [] })
      : url === "/api/admin/observability/budgets" && opts.budgets ? opts.budgets
      : url === "/api/admin/people" ? (opts.people ?? { people: [], paired: 0 })
      : url.startsWith("/api/admin/people/") && opts.person ? opts.person[decodeURIComponent(url.slice(18))]
      : url === "/api/workflows" ? (opts.workflows ?? { workflows: [] })
      : url.startsWith("/api/workflows/runs?") && opts.wfRuns ? opts.wfRuns
      : url.startsWith("/api/workflows/runs/") && opts.wfRun ? { run: opts.wfRun[decodeURIComponent(url.slice(20))] }
      : url === "/api/workflows/follow-ups" ? { groups: [{ tag: "client:demo", rows: [{ runId: "w9" }, { runId: "w8" }] }], unreachable: [] }
      : url === "/api/workflows/required" ? { settings: { enabled: false }, agents: [] }
      : url.startsWith("/api/workflows/") && (opts.workflows as any)?.workflows ? { workflow: (opts.workflows as any).workflows.find((w: any) => url.endsWith("/" + w.id)) }
      : url.startsWith("/api/admin/wall/throughput?") ? (opts.throughput ?? {})
      : opts.thread && url.startsWith("/api/admin/wall/thread?") ? opts.thread : { runs: [] }
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }
  // With `timers`, the script's timeouts are kept for the test to run.
  const later = opts.timers ? (f: () => void) => { opts.timers!.push(f); return 0 } : setTimeout
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", "setTimeout", script)(
    doc, { addEventListener: (t: string, f: () => void) => { onWindow[t] = f }, AXWorkflowEditor: opts.editor, AX_WALL_EDITOR: opts.editorCfg, confirm: opts.confirm, AX_WALL_SETTINGS: opts.owner ? {} : undefined }, fetchStub, loc,
    { replaceState: (_: unknown, __: string, h: string) => { loc.hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0, later,
  )
  /** A click on an element carrying these attributes. */
  const click = (attrs: Record<string, string>) => {
    const t = { hasAttribute: (k: string) => k in attrs, getAttribute: (k: string) => attrs[k] }
    // closest() finds the element only for a selector naming one of its attributes.
    const ev = { preventDefault: () => {}, target: { closest: (sel: string) => Object.keys(attrs).some((k) => sel.includes(`[${k}]`)) ? t : null } }
    for (const f of onDoc.click ?? []) f(ev)
  }
  /** A change on an element the script drew, such as the List's Group by. */
  const change = (id: string, value: string) => { for (const f of onDoc.change ?? []) f({ target: { id, value } }) }
  /** An input or change on a field the script drew, carrying these attributes. */
  const field = (type: string, target: Record<string, unknown>, attrs: Record<string, string> = {}) => {
    for (const f of onDoc[type] ?? []) f({ target: { ...target, getAttribute: (k: string) => attrs[k] ?? null } })
  }
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  /** The browser's hashchange, as after `location.hash = …`. */
  const hashchange = () => onWindow.hashchange?.()
  /** Any document event, with a target the test builds (#1440). */
  const fire = (type: string, ev: unknown) => { for (const f of onDoc[type] ?? []) f(ev) }
  /** A form's submit, as the Enter key or its button sends it. */
  const submit = (attrs: Record<string, string>) => { for (const f of onDoc.submit ?? []) f({ preventDefault: () => {}, target: { hasAttribute: (k: string) => k in attrs } }) }
  return { el, wall, calls, click, change, field, submit, settle, loc, hashchange, fire }
}

describe("Wall as a social feed (#1207)", () => {
  it("shows each post with its agent's avatar, name, @handle and time", async () => {
    const w = openWall()
    await w.settle()
    const feed = w.el("wall-feed").innerHTML
    expect(feed).toContain('<button type="button" class="av is-live" style="--av-h:')
    expect(feed).toContain('data-agent="cx" title="Customer Desk: profile and posts">CD</button>')
    expect(feed).toContain('<button type="button" class="name" data-agent="cx">Customer Desk</button><span class="h">@cx</span>')
    expect(feed).toMatch(/<time datetime="[^"]+" title="[^"]+UTC[^"]+">10m<\/time>/)
    expect(feed).toContain('<span class="chip state ">in progress</span>')
  })

  it("puts thread, runs and minutes in a compact action row; the links in the opened post (#1355)", async () => {
    const w = openWall()
    await w.settle()
    const feed = w.el("wall-feed").innerHTML
    const row = /<div class="wp__acts">(.*?)<\/div>/.exec(feed)![1]
    expect(row).toContain('data-thread="r1"')
    expect(row).toContain("1 run</span>")
    expect(row).toContain("2 min</span>")
    expect(feed).not.toContain('href="https://example.com/demo/shop/issues/47"')
    expect(feed).not.toContain('class="wp__meta"')
    const open = openWall({ hash: "#post=r1" })
    await open.settle()
    const page = open.el("wall-post").innerHTML
    expect(page).toContain('href="https://example.com/demo/shop/issues/47"')
    expect(page).toContain("Task record and trace</a>")
    expect(page).toContain('class="wtk__facts"')
  })

  it("lists the agents with their open posts, most open first", async () => {
    const w = openWall()
    await w.settle()
    const box = w.el("wall-agents").innerHTML
    expect(box.indexOf("@cx")).toBeLessThan(box.indexOf("@reviewer"))
    expect(box).toContain("@cx · 2 open · 2 posts")
    expect(box).toContain("@reviewer · 0 open · 1 post<")
  })

  it("opens an agent's profile over its own posts, and back to all", async () => {
    const w = openWall()
    await w.settle()
    expect(w.el("wall-profile").hidden).toBe(true)
    w.click({ "data-agent": "cx" })
    expect(w.el("f-owner").value).toBe("cx")
    expect(w.loc.hash).toContain("owner=cx")
    expect(w.el("wall-profile").hidden).toBe(false)
    const prof = w.el("wall-profile").innerHTML
    expect(prof).toContain("<h2>Customer Desk</h2>")
    expect(prof).toContain("@cx · running now")
    expect(prof).toContain("<b>2</b> open")
    expect(prof).toContain('href="/admin/agents/cx"')
    expect(w.el("wall-feed").innerHTML).not.toContain('id="post-r3"')
    w.click({ "data-profile-clear": "" })
    expect(w.el("f-owner").value).toBe("")
    expect(w.el("wall-profile").hidden).toBe(true)
  })

  it("leads with the result and opens the request under it with one tap (#1242)", async () => {
    const w = openWall({ data: { ...WALL, posts: [
      post("r1", "cx", "in_progress", { result: { text: "Refund <sent>: order 47", at: NOW - 300e3, from: "reply", taskId: "t-r1", agentId: "cx" } }),
      post("r2", "cx", "in_progress", { result: null }),
    ] } })
    await w.settle()
    const feed = w.el("wall-feed").innerHTML
    const r1 = feed.split('id="post-r1"')[1].split('id="post-r2"')[0]
    expect(r1.indexOf('<div class="wp__result ax-md"><p>Refund &lt;sent&gt;: order 47</p></div>')).toBeGreaterThan(-1)
    expect(r1.indexOf("wp__result")).toBeLessThan(r1.indexOf('<details class="wp__ask"><summary><span class="k">Request</span> Post r1</summary>'))
    // A run link opens the Wall's Task page (#1381).
    expect(r1).toContain('href="#page=task&amp;task=t-r1&amp;agent=cx">run t-r1</a>')
    expect(r1).not.toContain('<p class="wp__title">')
    // No result recorded: the request alone, said plainly.
    const r2 = feed.split('id="post-r2"')[1]
    expect(r2).toContain('<p class="wp__title">Post r2 <span class="chip chip--ghost">No result yet</span></p>')
    expect(r2).not.toContain("wp__ask")
  })

  it("only reads: every request is a plain GET", async () => {
    const w = openWall()
    await w.settle()
    w.click({ "data-agent": "cx" })
    expect(w.calls.length).toBeGreaterThan(0)
    for (const c of w.calls) expect(c.init?.method ?? "GET").toBe("GET")
  })
})

// #1316: a post opens on its own with its thread, results render their
// Markdown, and every nav item opens a page and carries its count.
describe("Wall v2 pages (#1316)", () => {
  it("opens a selected post on its own, with its thread, and goes back to the feed", async () => {
    const w = openWall()
    await w.settle()
    w.click({ "data-post": "r1" })
    await w.settle()
    expect(w.loc.hash).toContain("post=r1")
    expect(w.el("wall-post").hidden).toBe(false)
    expect(w.el("wall-feed").hidden).toBe(true)
    expect(w.el("wall-filters").hidden).toBe(true)
    expect(w.el("wall-back").hidden).toBe(false)
    expect(w.el("wall-title").textContent).toBe("Post")
    const page = w.el("wall-post").innerHTML
    expect(page).toContain('<article class="wp wp--open wtk" id="open-r1">')
    expect(page).toContain('<h2 class="wp__th">Thread</h2>')
    expect(page).not.toContain("data-thread=")
    expect(w.calls.map((c) => c.url)).toContain("/api/admin/wall/thread?id=r1")
    w.click({ "data-back": "" })
    expect(w.loc.hash).not.toContain("post=")
    expect(w.el("wall-post").hidden).toBe(true)
    expect(w.el("wall-feed").hidden).toBe(false)
    expect(w.el("wall-title").textContent).toBe("Hub")
  })

  it("opens a post from a shared link, and from the list", async () => {
    const w = openWall({ hash: "#status=open&post=r2" })
    await w.settle()
    expect(w.el("wall-post").innerHTML).toContain('id="open-r2"')
    const l = openWall({ hash: "#status=open&view=list" })
    await l.settle()
    l.click({ "data-open": "r1" })
    expect(l.loc.hash).toContain("view=list")
    expect(l.loc.hash).toContain("post=r1")
    expect(l.el("wall-post").innerHTML).toContain('id="open-r1"')
  })

  it("makes each feed post selectable, its time a link to it", async () => {
    const w = openWall()
    await w.settle()
    const feed = w.el("wall-feed").innerHTML
    expect(feed).toContain('<article class="wp" id="post-r1" data-post="r1" tabindex="0">')
    expect(feed).toMatch(/<a class="wp__link" href="#status=open&amp;post=r1" data-open="r1"[^>]*><time /)
  })

  it("applies an opened post's hash once, not again on the hashchange that follows", async () => {
    const w = openWall({ data: { ...WALL, posts: [post("r1", "cx", "in_progress")] } })
    await w.settle()
    w.click({ "data-post": "r1" })
    await w.settle()
    const before = w.calls.length
    w.el("wall-post").innerHTML = "kept"
    w.hashchange()
    await w.settle()
    expect(w.calls.length).toBe(before)
    expect(w.el("wall-post").innerHTML).toBe("kept")
  })

  it("applies a hash typed back after a filter change rewrote it", async () => {
    const w = openWall({ data: { ...WALL, posts: [post("r1", "cx", "in_progress")] } })
    await w.settle()
    w.click({ "data-post": "r1" })
    await w.settle()
    const opened = w.loc.hash
    w.el("f-q").value = "x"
    w.click({ "data-profile-clear": "" })
    expect(w.loc.hash).not.toBe(opened)
    w.loc.hash = opened
    w.hashchange()
    expect(w.el("f-q").value).toBe("")
  })

  it("renders a result's Markdown, with links to web addresses only", async () => {
    const text = "**Done**: see [the issue](https://example.com/demo/1) and [this](javascript:alert(1)), [here](/tasks/1), [there](//evil.example/x), [back](/\\evil.example/y)\n\n- one\n- two\n\n<b>raw</b>"
    const w = openWall({ data: { ...WALL, posts: [post("r1", "cx", "in_progress", { result: { text, at: NOW, from: "reply" } })] } })
    await w.settle()
    const res = /<div class="wp__result ax-md">(.*?)<\/div>/s.exec(w.el("wall-feed").innerHTML)![1]
    expect(res).toContain("<strong>Done</strong>")
    expect(res).toContain('<a href="https://example.com/demo/1" target="_blank" rel="noopener noreferrer">the issue</a>')
    expect(res).not.toContain("javascript:")
    expect(res).toContain('href="/tasks/1"')
    expect(res).not.toContain("evil.example")
    expect(res).toContain("<ul><li>one</li>")
    expect(res).toContain("&lt;b&gt;raw&lt;/b&gt;")
  })

  it("shows a count next to each nav item", async () => {
    const w = openWall()
    await w.settle()
    expect(w.el("nav-n-wall").textContent).toBe("2")
    expect(w.el("nav-n-needs").textContent).toBe("1")
    expect(w.el("nav-n-running").textContent).toBe("1")
    expect(w.el("nav-n-agents").textContent).toBe("2")
  })

  it("opens Running now and Agents as pages of their own", async () => {
    const page = renderWallPage()
    expect(page).toContain('data-nav="running" href="#page=running"')
    expect(page).toContain('data-nav="agents" href="#page=agents"')
    expect(page).not.toContain("data-scroll")
    const r = openWall({ hash: "#page=running" })
    await r.settle()
    expect(r.el("wall-running").hidden).toBe(false)
    expect(r.el("wall-running").innerHTML).toContain("<b>node-a</b>")
    expect(r.el("wall-feed").hidden).toBe(true)
    expect(r.el("wall-title").textContent).toBe("Running now")
    const a = openWall({ hash: "#page=agents" })
    await a.settle()
    expect(a.el("wall-agents-page").hidden).toBe(false)
    expect(a.el("wall-title").textContent).toBe("Agents")
    const list = a.el("wall-agents-page").innerHTML
    expect(list.indexOf("@cx")).toBeLessThan(list.indexOf("@reviewer"))
    expect(list).toContain('<span class="chip state">running 1</span>')
    expect(list).toContain("on node-a")
    expect(list).toContain('href="/admin/agents/reviewer"')
    a.click({ "data-agent": "reviewer" })
    expect(a.el("wall-agents-page").hidden).toBe(true)
    expect(a.el("f-owner").value).toBe("reviewer")
    expect(a.loc.hash).not.toContain("page=")
  })

  it("names a node that does not answer on the Agents page", async () => {
    const w = openWall({ hash: "#page=agents", live: { nodes: [...LIVE.nodes, { name: "node-b", reachable: false, agents: [] }] } })
    await w.settle()
    expect(w.el("wall-agents-page").innerHTML).toContain("node-b does not answer: agents only there are missing.")
    expect(w.el("wall-agents-page").innerHTML).toContain("@cx")
  })
})

// #1188: the QA verdict line and the "Awaiting QA only" filter, run through
// the page's real match() rather than read from the source.
describe("Running now does not wait on the feed (#1252)", () => {
  it("draws each node's running tasks while the feed is still loading, then the feed", async () => {
    let answer: (v: unknown) => void = () => {}
    const feed = new Promise((r) => { answer = r })
    const w = openWall({ feed })
    await w.settle()
    expect(w.calls.map((c) => c.url)).toContain("/api/live?quick=1")
    const nodes = w.el("wall-nodes").innerHTML
    expect(nodes).toContain("<b>node-a</b>")
    expect(nodes).toContain("Customer Desk: x")
    expect(w.el("wall-feed").innerHTML).toBe("")
    answer({ ok: true, status: 200, json: async () => WALL })
    await w.settle()
    expect(w.el("wall-feed").innerHTML).toContain('id="post-r1"')
    expect(w.el("wall-nodes").innerHTML).toContain("Customer Desk: x")
  })

  it("still draws Running now when the feed fails", async () => {
    const w = openWall({ feed: Promise.resolve({ ok: false, status: 504, json: async () => ({}) }) })
    await w.settle()
    expect(w.el("wall-feed").innerHTML).toContain("Could not load the Hub")
    expect(w.el("wall-nodes").innerHTML).toContain("Customer Desk: x")
  })
})

describe("Wall home first load (#1442)", () => {
  it("asks for the machines and a quick feed first, and the rest once the posts are drawn", async () => {
    let answer: (v: unknown) => void = () => {}
    const w = openWall({ feed: new Promise((r) => { answer = r }) })
    await w.settle()
    // The build line (#1444) asks its own small route as the script starts.
    expect(w.calls.map((c) => c.url)).toEqual(["/api/node/build", "/api/live?quick=1", "/api/admin/wall?peer=fleet&days=7&quick=1"])
    answer({ ok: true, status: 200, json: async () => WALL })
    await w.settle()
    expect(w.el("wall-feed").innerHTML).toContain('id="post-r1"')
    expect(w.calls.map((c) => c.url).slice(3).sort()).toEqual(["/api/admin/approvals?all=1&answered=1", "/api/admin/observability/budgets", "/api/admin/org", "/api/admin/people", "/api/admin/pictures", "/api/workflows", "/api/workflows/runs?summary=1&limit=100"])
  })

  it("shows a machine that is slow to answer as checking, not down, and asks again", async () => {
    const timers: Array<() => void> = []
    const slow = { nodes: [LIVE.nodes[0], { name: "node-b", reachable: false, error: "timed out", checking: true, agents: [] }] }
    const w = openWall({ live: slow, timers })
    await w.settle()
    const side = w.el("wall-nodes").innerHTML
    expect(side).toContain('<div class="wh"><b>node-b</b><span title="">checking…</span></div>')
    expect(side).not.toContain("does not answer")
    const lives = () => w.calls.filter((c) => c.url === "/api/live?quick=1").length
    expect(lives()).toBe(1)
    timers.splice(0).forEach((f) => f())
    await w.settle()
    expect(lives()).toBe(2)
  })

  it("still names a machine that refuses as down", async () => {
    const down = { nodes: [LIVE.nodes[0], { name: "node-b", reachable: false, error: "unreachable", agents: [] }] }
    const w = openWall({ live: down, timers: [] })
    await w.settle()
    expect(w.el("wall-nodes").innerHTML).toContain('<div class="wh is-down"><b>node-b</b><span title="">does not answer</span></div>')
  })

  it("asks for the feed again while the reply says more is on its way, a few times at most", async () => {
    const timers: Array<() => void> = []
    const w = openWall({ data: { ...WALL, pending: true, nodes: [...WALL.nodes, { name: "node-b", peer: "http://b", ok: false, checking: true }] }, timers })
    await w.settle()
    const feeds = () => w.calls.filter((c) => c.url.startsWith("/api/admin/wall?")).length
    expect(feeds()).toBe(1)
    for (let i = 0; i < 8; i++) { timers.splice(0).forEach((f) => f()); await w.settle() }
    expect(feeds()).toBe(6)
    w.click({ "data-view": "feed" })
    expect(w.el("wall-feed").innerHTML).toContain('id="post-r1"')
  })

  it("tries the machines again when the live read fails, instead of loading forever", async () => {
    const timers: Array<() => void> = []
    const w = openWall({ liveFails: true, timers })
    await w.settle()
    expect(w.el("wall-nodes").innerHTML).toContain("Could not reach the machines just now; trying again.")
    expect(timers.length).toBe(1)
  })
})

describe("QA verdict on the Wall (#1188)", () => {
  const QA = {
    ...WALL,
    posts: [
      post("q1", "cx", "in_progress", { qa: { verdict: "risk", by: "qa-check", at: NOW - 300e3, note: "slow on <mobile>" }, awaitingQa: false }),
      post("q2", "cx", "in_progress", { qa: null, awaitingQa: true }),
      post("q3", "cx", "in_progress", { qa: { verdict: "block", by: "qa-check", at: NOW - 900e3, note: "login fails" }, awaitingQa: true }),
      post("q4", "cx", "in_progress", { qa: { verdict: "pass", by: "qa-check", at: NOW - 60e3, note: null }, awaitingQa: false }),
      post("q5", "cx", "in_progress"),
    ],
  }
  // The QA line is in the opened post; the compact feed post leaves it out (#1355).
  const qaLine = async (id: string) => {
    const w = openWall({ data: QA, hash: `#post=${id}` })
    await w.settle()
    return /<div class="wp__qa">(.*?)<\/div>/.exec(w.el("wall-post").innerHTML)?.[1]
  }

  it("shows a risk verdict with who gave it, when and its escaped note", async () => {
    const line = (await qaLine("q1"))!
    expect(line).toMatch(/^QA: RISK by qa-check, .+: slow on &lt;mobile&gt;$/)
    expect(line).not.toContain("new verdict asked")
  })

  it("marks a block asked again, a pass, and no line without QA", async () => {
    expect(await qaLine("q2")).toBe("QA: Awaiting QA sign-off")
    expect(await qaLine("q3")).toMatch(/^QA: BLOCK by qa-check, .+: login fails — new verdict asked$/)
    expect(await qaLine("q4")).toMatch(/^QA: PASS by qa-check, [^<]+ UTC[+-]\d\d:\d\d$/)
    expect(await qaLine("q5")).toBeUndefined()
    const w = openWall({ data: QA })
    await w.settle()
    expect(w.el("wall-feed").innerHTML).not.toContain('class="wp__qa"')
  })

  it("keeps only posts awaiting a verdict when the filter is on", async () => {
    const w = openWall({ data: QA, hash: "#status=open&qa=1" })
    await w.settle()
    expect(w.el("f-qa").checked).toBe(true)
    expect(w.el("wall-count").textContent).toBe("2 of 5 posts")
    const feed = w.el("wall-feed").innerHTML
    expect(feed).toContain('id="post-q2"')
    expect(feed).toContain('id="post-q3"')
    for (const id of ["q1", "q4", "q5"]) expect(feed).not.toContain(`id="post-${id}"`)
  })

  it("treats a peer post with no qa field as not awaiting", async () => {
    const w = openWall({ hash: "#status=open&qa=1" })
    await w.settle()
    expect(w.el("wall-count").textContent).toBe("0 of 3 posts")
  })
})

// #1190: the Projects view shows the overview rows the reply carries; each
// count links to the list filtered by that project and status, and the
// list's project filter knows "Other" and the status filter "Stalled".
describe("Projects overview on the Wall (#1190)", () => {
  const PROJ = {
    ...WALL,
    posts: [
      post("p1", "cx", "in_progress", { project: "Web", stalled: true }),
      post("p2", "cx", "waiting_owner", { project: "Web", stalled: false, blocked: { who: "owner", why: "?", since: NOW } }),
      post("p3", "reviewer", "in_progress", { project: null, stalled: false }),
    ],
    projects: [
      { project: "Web", open: 2, inProgress: 1, blocked: 1, stalled: 1 },
      { project: "Docs", open: 0, inProgress: 0, blocked: 0, stalled: 0 },
      { project: null, open: 1, inProgress: 1, blocked: 0, stalled: 0 },
    ],
  }

  it("lists each project with its four counts, Other last, each count a link to the list", async () => {
    const w = openWall({ data: PROJ, hash: "#status=open&view=projects" })
    await w.settle()
    expect(w.el("wall-projects").hidden).toBe(false)
    expect(w.el("wall-feed").hidden).toBe(true)
    const html = w.el("wall-projects").innerHTML
    // One card per project (#1355), in the reply's order, Other last.
    const cards = html.split('<article class="wpc">').slice(1)
    expect(cards).toHaveLength(3)
    expect(cards[0]).toContain("<b>Web</b>")
    expect(cards[0]).toContain('<span class="wpc__s is-stalled">stalled</span>')
    expect(cards[0]).toContain('href="#status=stalled&amp;project=Web&amp;view=list">1</a>')
    expect(cards[0]).toContain('href="#status=open&amp;project=Web&amp;view=list">2</a>')
    expect(cards[1]).toContain("<b>Docs</b>")
    expect(cards[1]).toContain('<span class="wpc__s is-moving">moving</span>')
    expect(cards[1]).toContain("<dt>open</dt><dd>0</dd>")
    expect(cards[2]).toContain("<i>Other</i>")
    expect(cards[2]).toContain('href="#status=in_progress&amp;project=-&amp;view=list">1</a>')
  })

  it("filters the list to a project's stalled work, and to Other", async () => {
    const stalled = openWall({ data: PROJ, hash: "#status=stalled&project=Web&view=list" })
    await stalled.settle()
    expect(stalled.el("wall-count").textContent).toBe("1 of 3 posts")
    expect(stalled.el("wall-list").innerHTML).toContain("p1")
    const other = openWall({ data: PROJ, hash: "#status=open&project=-&view=list" })
    await other.settle()
    expect(other.el("f-project").innerHTML).toContain('<option value="-">Other (no project)</option>')
    expect(other.el("wall-count").textContent).toBe("1 of 3 posts")
  })

  it("says so when there is no open work", async () => {
    const w = openWall({ data: { ...WALL, projects: [] }, hash: "#view=projects" })
    await w.settle()
    expect(w.el("wall-projects").innerHTML).toContain("No open work.")
  })
})

// #1192: under the overview, closures per week per project and per owner,
// read once from the throughput reply when the Projects tab opens.
describe("Weekly throughput on the Wall (#1192)", () => {
  const W = 7 * 864e5
  const TP = {
    node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }],
    throughput: {
      weeks: [3, 2, 1, 0].map((i) => ({ from: NOW - (i + 1) * W, to: NOW - i * W })),
      projects: [{ project: "Web", weeks: [1, 0, 0, 3], total: 4 }, { project: null, weeks: [0, 0, 1, 0], total: 1 }],
      owners: [{ owner: "cx", weeks: [1, 0, 1, 3], total: 5 }, { owner: "reviewer", weeks: [0, 0, 0, 0], total: 0 }],
    },
  }

  it("shows four weeks per project and per owner, with totals and a sparkline", async () => {
    const w = openWall({ hash: "#view=projects", throughput: TP })
    await w.settle()
    expect(w.calls.filter((c) => c.url.startsWith("/api/admin/wall/throughput?peer=fleet"))).toHaveLength(1)
    const html = w.el("wall-projects").innerHTML
    expect(html).toContain("Closed per week")
    expect(html).toContain('<td>Web</td><td class="num">1</td><td class="num">0</td><td class="num">0</td><td class="num">3</td><td class="num">4</td>')
    expect(html).toContain("<td><i>Other</i></td><td class=\"num\">0</td>")
    expect(html).toContain('<td>reviewer</td><td class="num">0</td><td class="num">0</td><td class="num">0</td><td class="num">0</td><td class="num">0</td>')
    expect(html).toContain("▃▁▃█")
  })

  it("does not read throughput until the Projects tab is open", async () => {
    const w = openWall({ hash: "#view=feed", throughput: TP })
    await w.settle()
    expect(w.calls.some((c) => c.url.startsWith("/api/admin/wall/throughput"))).toBe(false)
  })

  it("says so when the reply has no throughput (an older node)", async () => {
    const w = openWall({ hash: "#view=projects" })
    await w.settle()
    expect(w.el("wall-projects").innerHTML).toContain("Throughput is not available.")
  })
})

// #1193: the Blocked list grouped by the blocking project or agent, with
// how long each post has been blocked; posts with no recorded blocker last.
describe("Blocked view grouped by blocker (#1193)", () => {
  const since = (h: number) => NOW - h * 3600e3
  const agentBy = (who: string, project: string | null, cross: boolean) => ({ kind: "agent", who, source: "handoff", project, crossProject: cross })
  const BLK = {
    ...WALL,
    posts: [
      post("b1", "coder", "waiting_other", { project: "Web", blocked: { who: "ops", why: "x", since: since(5) }, blockedBy: agentBy("ops", "Ops", true) }),
      post("b2", "coder", "waiting_other", { project: "Web", blocked: { who: "reviewer", why: "x", since: since(2) }, blockedBy: agentBy("reviewer", "Web", false) }),
      post("b3", "coder", "in_progress", { project: "Web", blocked: { who: "coder", why: "quiet", since: since(30) }, blockedBy: null }),
      post("b4", "pm", "waiting_owner", { project: "Ops", blocked: { who: "owner", why: "?", since: since(1) }, blockedBy: { kind: "owner", who: "owner", source: "owner", project: null, crossProject: false } }),
      post("b5", "pm", "waiting_other", { project: "Ops", blocked: { who: "ops", why: "x", since: since(8) }, blockedBy: agentBy("ops", "Ops", false) }),
    ],
  }
  const heads = (html: string) => [...html.matchAll(/<h3>([^<]*) <small>\((\d+)\)<\/small><\/h3>/g)].map((m) => `${m[1]} (${m[2]})`)

  it("groups by the blocking project, oldest block first, with no recorded blocker last", async () => {
    const w = openWall({ data: BLK, hash: "#status=blocked&by=project&view=list" })
    await w.settle()
    const html = w.el("wall-list").innerHTML
    expect(heads(html)).toEqual(["Ops (2)", "Web (1)", "The owner (1)", "No blocker recorded (1)"])
    expect(html).toContain('@ops <small class="chip chip--warn">other project</small>')
    expect(html).toContain("<td>@reviewer</td>")
    expect(html).toContain("5 h ago")
  })

  it("groups by the blocking agent", async () => {
    const w = openWall({ data: BLK, hash: "#status=blocked&by=agent&view=list" })
    await w.settle()
    expect(heads(w.el("wall-list").innerHTML)).toEqual(["@ops (2)", "@reviewer (1)", "The owner (1)", "No blocker recorded (1)"])
  })

  it("keeps the plain list when no grouping is picked, or the status is not Blocked", async () => {
    const plain = openWall({ data: BLK, hash: "#status=blocked&view=list" })
    await plain.settle()
    expect(plain.el("wall-list").innerHTML).not.toContain("<h3>")
    const open = openWall({ data: BLK, hash: "#status=open&by=agent&view=list" })
    await open.settle()
    expect(open.el("wall-list").innerHTML).not.toContain("<h3>")
  })
})

// #1191: the Projects view shows the capacity rows the reply carries, the
// over-capacity flag only when a threshold is set, each owner a link to
// the posts counted for it.
describe("Capacity per owner on the Wall (#1191)", () => {
  const CAP = (threshold: number | null, over: boolean) => ({
    ...WALL,
    capacity: { threshold, owners: [
      { owner: "cx", inProgress: 2, waiting: 1, over },
      { owner: "reviewer", inProgress: 0, waiting: 0, over: false },
    ] },
  })

  it("lists each owner with in progress, waiting and the flag", async () => {
    const w = openWall({ data: CAP(2, true), hash: "#view=projects" })
    await w.settle()
    const html = w.el("wall-projects").innerHTML
    expect(html).toContain("Capacity per owner")
    expect(html).toContain("above 2.")
    const rows = html.split("Capacity per owner")[1].split("<tr").slice(2)
    expect(rows[0]).toContain('href="#load=cx&amp;view=list">cx</a>')
    expect(rows[0]).toContain('<td class="num">2</td><td class="num">1</td><td><span class="chip chip--warn">over capacity</span>')
    expect(rows[1]).toContain("<td>ok</td>")
  })

  it("shows no flag when no threshold is set", async () => {
    const w = openWall({ data: CAP(null, false), hash: "#view=projects" })
    await w.settle()
    const html = w.el("wall-projects").innerHTML
    expect(html).toContain("No threshold set")
    expect(html).not.toContain("over capacity")
  })

  // The owner link lists exactly the posts its numbers count: as active
  // step agent and as a blocker too, not only the posts the agent owns.
  it("lists the posts counted for an agent, matching its in progress plus waiting", async () => {
    const on = (who: string) => ({ kind: "agent", who, source: "handoff", project: null, crossProject: false })
    const posts = [
      post("a1", "coder", "in_progress"),
      post("a2", "coder", "in_progress", { stepAgent: "ops" }),
      post("a3", "coder", "waiting_other", { blockedBy: on("ops") }),
      post("a4", "ops", "waiting_owner"),
      post("a5", "ops", "done", { stepAgent: null }),
      post("a6", "coder", "waiting_other", { blockedBy: on("coder") }),
    ]
    const capacity = wallCapacity(posts as any)
    for (const r of capacity.owners) {
      const w = openWall({ data: { ...WALL, posts, capacity }, hash: `#load=${r.owner}&view=list` })
      await w.settle()
      const ids = [...w.el("wall-list").innerHTML.matchAll(/data-open="([^"]+)"/g)].map((m) => m[1])
      expect(new Set(ids).size, r.owner).toBe(r.inProgress + r.waiting)
    }
    const ops = openWall({ data: { ...WALL, posts, capacity }, hash: "#load=ops&view=list" })
    await ops.settle()
    const html = ops.el("wall-list").innerHTML
    expect(html).toContain('data-open="a2"')
    expect(html).toContain('data-open="a3"')
    expect(html).not.toContain('data-open="a4"')
  })

  it("says so when no agent carries open work, or the node is older", async () => {
    const w = openWall({ data: WALL, hash: "#view=projects" })
    await w.settle()
    expect(w.el("wall-projects").innerHTML).toContain("No agent carries open work.")
  })
})

describe("Wall post actions (#1316)", () => {
  const sent = (w: ReturnType<typeof openWall>, url: string) => w.calls.filter((c) => c.url === url).map((c) => ({ method: c.init?.method, body: JSON.parse(c.init?.body ?? "null") }))

  it("an open post offers a comment, a call and a Space with another agent", async () => {
    const w = openWall({ hash: "#status=open&post=r1" })
    await w.settle()
    const page = w.el("wall-post").innerHTML
    expect(page).toContain('<textarea id="wdo-text"')
    expect(page).toContain('data-act="comment"')
    expect(page).toContain(">Call Customer Desk</button>")
    expect(page).toContain('<option value="reviewer">Reviewer</option>')
    expect(page).not.toContain('<option value="cx">')
  })

  it("a closed post takes a comment that opens it again, and can still be talked about (#1355)", async () => {
    const w = openWall({ hash: "#post=r3" })
    await w.settle()
    const page = w.el("wall-post").innerHTML
    expect(page).toContain('data-act="comment"')
    expect(page).toContain("this post is done, so a comment opens it again")
    expect(page).toContain('data-act="call"')
  })

  it("sends the comment and the call to the post's node, the Space to this one", async () => {
    const w = openWall({ hash: "#status=open&post=r1" })
    await w.settle()
    w.el("wdo-text").value = "  Use the staging token "
    w.click({ "data-act": "comment" })
    w.click({ "data-act": "call" })
    w.el("wdo-with").value = "reviewer"
    w.click({ "data-act": "space" })
    await w.settle()
    expect(sent(w, "/api/admin/wall/comment")).toEqual([{ method: "POST", body: { id: "r1", text: "Use the staging token" } }])
    expect(sent(w, "/api/admin/wall/call")).toEqual([{ method: "POST", body: { id: "r1" } }])
    expect(sent(w, "/api/admin/wall/space")[0].body).toMatchObject({ id: "r1", agent: "cx", with: "reviewer" })
    const space = w.calls.find((c) => c.url === "/api/admin/wall/space")!
    expect(space.init.headers["X-Agentx-Peer"]).toBeUndefined()
  })

  // /approvals had Hand to agent, Done and Drop on every open request; it
  // redirects to the Hub now, so an open post has them for the owner (#1440).
  it("shows a promise's loop in the opened post's facts (#1440)", async () => {
    const loop = { owedTo: "owner", promise: true, dueAt: NOW + 3600e3, check: "https://example.com/quote answers", verifyState: "failed", verifyDetail: "HTTP 503" }
    const w = openWall({ hash: "#status=open&post=r1", data: { ...WALL, posts: [post("r1", "cx", "in_progress", { loop })] } })
    await w.settle()
    const facts = /<dl class="wtk__facts">(.*?)<\/dl>/.exec(w.el("wall-post").innerHTML)![1]
    expect(facts).toContain("<dt>Promised to</dt><dd>you</dd>")
    expect(facts).toContain("<dt>Due</dt>")
    expect(facts).toContain('<dt>Closes when</dt><dd>https://example.com/quote answers <span class="is-warn">(check not met: HTTP 503)</span></dd>')
  })

  it("gives the owner Hand to, Done and Drop on an open post, and no one else", async () => {
    const owner = openWall({ hash: "#status=open&post=r1", owner: true })
    await owner.settle()
    const page = owner.el("wall-post").innerHTML
    expect(page).toContain('data-act="close-done"')
    expect(page).toContain('data-act="close-drop"')
    expect(page).toContain('<select id="wdo-hand" aria-label="Hand it to"><option value="">Hand to…</option><option value="cx">Customer Desk (has it: try again)</option><option value="reviewer">Reviewer</option></select>')
    const guest = openWall({ hash: "#status=open&post=r1" })
    await guest.settle()
    expect(guest.el("wall-post").innerHTML).not.toContain("close-done")
    const closed = openWall({ hash: "#post=r3", owner: true })
    await closed.settle()
    expect(closed.el("wall-post").innerHTML).not.toContain("close-done")
  })

  it("asks once, then sends Done, Drop or the hand-off with the comment box's words", async () => {
    const w = openWall({ hash: "#status=open&post=r1", owner: true })
    await w.settle()
    w.click({ "data-act": "close-done" })
    expect(w.el("wdo-close").innerHTML).toContain("<b>Close “Post r1” as done.</b> It cannot be taken back.")
    expect(sent(w, "/api/admin/wall/request/close")).toEqual([])
    w.click({ "data-act": "close-back" })
    expect(w.el("wdo-close").innerHTML).not.toContain("Confirm")
    w.el("wdo-text").value = " https://example.test/pr/4 "
    w.click({ "data-act": "close-done" })
    w.click({ "data-act": "close-go" })
    await w.settle()
    w.el("wdo-text").value = ""
    w.click({ "data-act": "close-drop" })
    w.click({ "data-act": "close-go" })
    await w.settle()
    w.change("wdo-hand", "reviewer")
    expect(w.el("wdo-close").innerHTML).toContain("<b>Hand “Post r1” to Reviewer.</b>")
    w.click({ "data-act": "close-go" })
    await w.settle()
    expect(sent(w, "/api/admin/wall/request/close")).toEqual([
      { method: "POST", body: { id: "r1", action: "done", evidence: "https://example.test/pr/4" } },
      { method: "POST", body: { id: "r1", action: "drop", reason: "" } },
    ])
    expect(sent(w, "/api/admin/wall/request/handoff")).toEqual([{ method: "POST", body: { id: "r1", agentId: "reviewer", note: "" } }])
    expect(w.el("wdo-note").textContent).toBe("Done.")
  })

  it("sends the comment box's words as they are at Confirm, and says so as they are typed", async () => {
    const w = openWall({ hash: "#status=open&post=r1", owner: true })
    await w.settle()
    w.el("wdo-text").value = ""
    w.click({ "data-act": "close-drop" })
    expect(w.el("wdo-close").innerHTML).not.toContain("Your words above go with it.")
    w.el("wdo-text").value = "Out of scope"
    w.field("input", { id: "wdo-text", value: "Out of scope" })
    expect(w.el("wdo-close").innerHTML).toContain("<b>Drop “Post r1”.</b> Your words above go with it.")
    w.el("wdo-text").value = " Out of scope this quarter "
    w.click({ "data-act": "close-go" })
    await w.settle()
    expect(sent(w, "/api/admin/wall/request/close")).toEqual([{ method: "POST", body: { id: "r1", action: "drop", reason: "Out of scope this quarter" } }])
    expect(w.el("wdo-text").value).toBe("")
  })
})

describe("Wall v2 feed (#1355)", () => {
  const V2 = {
    ...WALL,
    posts: [
      post("a", "cx", "in_progress", { project: "shop" }),
      post("b", "cx", "waiting_other", { blocked: { who: "reviewer", since: NOW - 3 * 3600e3, why: "needs a review" } }),
      post("c", "reviewer", "waiting_owner", { ownerCards: [{ title: "Ship it?", ask: "Ship it?", expiresAt: NOW + 3600e3, recommend: "yes", silence: "wait", ifSilent: "discard", raisedBy: "reviewer", createdAt: NOW - 600e3 }] }),
      post("d", "cx", "in_progress", { failedRuns: 2, runs: 3 }),
      post("e", "reviewer", "done"),
    ],
    projects: [{ project: "shop", open: 1, inProgress: 1, blocked: 0, stalled: 0 }],
  }
  const LIVE2 = { nodes: [
    { ...LIVE.nodes[0], url: "http://node-a", crons: [{ id: "j1", agent: "cx", schedule: "0 9 * * *", enabled: true, consecutiveErrors: 0 }] },
    { name: "node-b", url: "http://node-b", reachable: true, agents: [{ id: "far", name: "Far Agent", runningTasks: [] }] },
  ] }
  const ids = (html: string) => [...html.matchAll(/id="post-([^"]+)"/g)].map((m) => m[1])

  it("filters by the status tabs: Working, Waiting, Done, Failed, All", async () => {
    const tab = async (status: string) => {
      const w = openWall({ data: V2, hash: `#status=${status}` })
      await w.settle()
      return ids(w.el("wall-feed").innerHTML)
    }
    expect(await tab("open")).toEqual(["a", "b", "c", "d"])
    expect(await tab("in_progress")).toEqual(["a", "d"])
    expect(await tab("waiting")).toEqual(["b", "c"])
    expect(await tab("done")).toEqual(["e"])
    expect(await tab("failed")).toEqual(["d"])
    expect(await tab("")).toEqual(["a", "b", "c", "d", "e"])
  })

  it("a tab click sets the status filter in the link", async () => {
    const w = openWall({ data: V2 })
    await w.settle()
    w.click({ "data-tab": "waiting" })
    expect(w.el("f-status").value).toBe("waiting")
    expect(w.loc.hash).toContain("status=waiting")
    expect(ids(w.el("wall-feed").innerHTML)).toEqual(["b", "c"])
  })

  it("keeps a compact post to one amber line on who it waits on", async () => {
    const w = openWall({ data: V2 })
    await w.settle()
    const feed = w.el("wall-feed").innerHTML
    const of = (id: string) => feed.split(`id="post-${id}"`)[1].split('id="post-')[0]
    expect(of("b")).toMatch(/<div class="wp__block">Waits on <b>reviewer<\/b> for 3 h — needs a review<\/div>/)
    expect(of("c")).toContain('<div class="wp__block">Waits on you: <b>Ship it?</b>, card expires in 60 min</div>')
    expect(of("c")).not.toContain('class="wc"')
    expect(of("a")).not.toContain("wp__block")
    expect(of("a")).toContain("shop</span>")
  })

  it("counts Projects and Jobs in the nav, and opens them from it", async () => {
    const w = openWall({ data: V2, live: LIVE2, hash: "#status=open&view=jobs" })
    await w.settle()
    expect(w.el("nav-n-projects").textContent).toBe("1")
    expect(w.el("nav-n-jobs").textContent).toBe("1")
    expect(w.el("wall-title").textContent).toBe("Jobs")
    expect(w.el("wall-views").hidden).toBe(true)
    expect(w.el("wall-compose").hidden).toBe(true)
    expect(w.el("wall-jobs").hidden).toBe(false)
  })

  it("shows one line per machine under Happening now", async () => {
    const w = openWall({ data: V2, live: LIVE2 })
    await w.settle()
    const side = w.el("wall-nodes").innerHTML
    expect(side).toContain('<div class="wh"><b>node-a</b><span title="Customer Desk: x">Customer Desk: x</span></div>')
    expect(side).toContain("<b>node-b</b><span title=\"\">nothing running</span>")
    expect(side).toContain('href="#page=running"')
  })

  it("posts from the composer to the agent its @name picks, on that agent's node", async () => {
    const w = openWall({ data: V2, live: LIVE2 })
    await w.settle()
    expect(w.el("wall-compose").hidden).toBe(false)
    const submit = async (text: string) => { w.el("wc-text").value = text; w.el("wall-compose").on.submit({ preventDefault: () => {} }); await w.settle() }
    await submit("hello, no one picked")
    expect(w.el("wc-note").textContent).toMatch(/Pick who it is for/)
    await submit("@cx please check the deploy log")
    await submit("@far look at node b")
    const posted = w.calls.filter((c) => c.url === "/api/admin/wall/post")
    expect(posted.map((c) => JSON.parse(c.init.body))).toEqual([
      { agent: "cx", text: "@cx please check the deploy log" },
      { agent: "far", text: "@far look at node b" },
    ])
    expect(posted[0].init.headers["X-Agentx-Peer"]).toBeUndefined()
    expect(posted[1].init.headers["X-Agentx-Peer"]).toBe("http://node-b")
    expect(w.el("wc-text").value).toBe("")
  })

  it("sends a post once when Post is pressed twice while it is in flight", async () => {
    const w = openWall({ data: V2, live: LIVE2 })
    await w.settle()
    w.el("wc-text").value = "@cx please check the deploy log"
    w.el("wall-compose").on.submit({ preventDefault: () => {} })
    expect(w.el("wc-post").disabled).toBe(true)
    w.el("wall-compose").on.submit({ preventDefault: () => {} })
    await w.settle()
    expect(w.calls.filter((c) => c.url === "/api/admin/wall/post")).toHaveLength(1)
    expect(w.el("wc-post").disabled).toBe(false)
  })
})

describe("Wall v2 pages (#1355)", () => {
  const PAGES = {
    ...WALL,
    posts: [
      post("a", "cx", "in_progress", { project: "shop", lastMoveAt: NOW - 4 * 864e5, estimateMinutes: 1, runMs: 300e3 }),
      post("b", "cx", "waiting_other", { project: "shop", blocked: { who: "reviewer", since: NOW - 5 * 864e5, why: "review" }, blockedBy: { kind: "agent", who: "reviewer", project: null } }),
      post("c", "reviewer", "in_progress", { project: null }),
    ],
    projects: [{ project: "shop", open: 2, inProgress: 1, blocked: 1, stalled: 0 }, { project: null, open: 1, inProgress: 1, blocked: 0, stalled: 0 }],
    capacity: { threshold: 1, owners: [{ owner: "cx", inProgress: 1, waiting: 1, over: true }] },
  }
  const runs = (statuses: string[]) => statuses.map((status, i) => ({ at: new Date(NOW - i * 3600e3).toISOString(), status }))
  const JOBS_LIVE = { nodes: [{
    ...LIVE.nodes[0], url: "http://node-a",
    crons: [
      { id: "digest", agent: "cx", schedule: "0 9 * * *", enabled: true, consecutiveErrors: 0, nextRun: new Date(NOW + 3600e3).toISOString(), value: { why: "the owner reads it", metric: "opened daily" } },
      { id: "sync", agent: "reviewer", schedule: "*/30 * * * *", enabled: true, consecutiveErrors: 3 },
    ],
    cronRuns: [
      { jobId: "digest", startedAt: new Date(NOW - 60e3).toISOString(), status: "success", taskId: "t-digest" },
      { jobId: "sync", startedAt: new Date(NOW - 120e3).toISOString(), status: "failed", errorSummary: "token expired" },
      { jobId: "sync", startedAt: new Date(NOW - 180e3).toISOString(), status: "success", quiet: true },
    ],
    routines: [
      { id: "cron:digest", recent: runs(["success", "success"]), consecutiveFailures: 0, flags: [], lastRun: { at: new Date(NOW - 60e3).toISOString(), status: "success" } },
      { id: "cron:sync", recent: runs(["failed", "failed", "failed", "success", "success", "success", "success"]), consecutiveFailures: 3, flags: [], lastRun: { at: new Date(NOW - 120e3).toISOString(), status: "failed", summary: "token expired" } },
    ],
  }] }

  it("draws the List with seven columns, quick views and amber old waits; Columns adds the rest", async () => {
    const w = openWall({ data: PAGES, hash: "#status=open&view=list" })
    await w.settle()
    const html = w.el("wall-list").innerHTML
    expect(html).toContain('data-tab="blocked">Blocked</button>')
    expect(html).toContain('data-quick="cols"')
    expect(html.match(/<th data-sort=/g)).toHaveLength(7)
    expect(html).toContain('<td class="num is-amber">4</td>')
    expect(html).toMatch(/<td class="is-amber">5 \/ 1 min/)
    w.click({ "data-quick": "cols" })
    expect(w.el("wall-list").innerHTML.match(/<th data-sort=/g)).toHaveLength(10)
  })

  it("groups the List by owner, project or blocker, each group with its count and oldest wait", async () => {
    const w = openWall({ data: PAGES, hash: "#status=open&grp=owner&view=list" })
    await w.settle()
    let html = w.el("wall-list").innerHTML
    expect(html).toMatch(/<tr class="wl__g"><th colspan="7">@cx <small>2 posts · oldest wait 5 d<\/small>/)
    expect(html).toContain("@reviewer <small>1 post")
    const b = openWall({ data: PAGES, hash: "#status=open&grp=blocked&view=list" })
    await b.settle()
    html = b.el("wall-list").innerHTML
    expect(html).toContain("@reviewer <small>1 post")
    expect(html).toContain("No blocker recorded <small>2 posts")
  })

  it("lists jobs per machine with today's totals, seven squares and look stale", async () => {
    const w = openWall({ data: PAGES, live: JOBS_LIVE, hash: "#status=open&view=jobs" })
    await w.settle()
    const html = w.el("wall-jobs").innerHTML
    expect(html).toContain("<dt>ran</dt><dd>3</dd>")
    expect(html).toContain("<dt>worked</dt><dd>1</dd>")
    expect(html).toContain("<dt>failed</dt><dd>1</dd>")
    expect(html).toContain("<dt>quiet</dt><dd>1</dd>")
    expect(html).toContain("<dt>look stale</dt><dd>1</dd>")
    const sync = html.split("<b>sync</b>")[1]
    expect(sync).toContain('title="failed 3 times in a row; no value line">look stale</span>')
    expect(sync.split('class="wjb__sq"')[1].match(/class="is-(ok|err)"/g)).toHaveLength(7)
    expect(sync).toContain("token expired")
    expect(sync).toContain('disabled title="Phase 2, not built">Pause</button>')
    const digest = html.split("<b>digest</b>")[1].split("<b>sync</b>")[0]
    expect(digest).toContain('<span class="chip chip--done">on</span>')
    expect(digest.match(/class="is-none"/g)).toHaveLength(5)
    expect(digest).toContain("t-digest")
  })

  it("posts a task from the Creator, with Done when, project and estimate", async () => {
    const w = openWall({ data: PAGES, live: JOBS_LIVE, hash: "#page=creator" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("New post")
    let html = w.el("wall-creator").innerHTML
    expect(html).toContain("This page sends a message")
    expect(html).toContain('data-creator-agent="cx"')
    expect(html).toMatch(/data-creator-agent="cx"[^>]*>.*?over capacity/)
    expect(html).toContain("data-creator-post disabled")
    w.click({ "data-creator-agent": "reviewer" })
    w.el("cr-text").value = "Check the release notes"
    w.el("cr-done").value = "a merged PR"
    w.el("cr-project").value = "shop"
    w.el("cr-estimate").value = "30"
    w.click({ "data-creator-post": "" })
    await w.settle()
    const posted = w.calls.filter((c) => c.url === "/api/admin/wall/post").map((c) => JSON.parse(c.init.body))
    expect(posted).toEqual([{ agent: "reviewer", text: "Check the release notes\nDone when: a merged PR\nProject: shop\nEstimate: 30 min" }])
    html = w.el("wall-creator").innerHTML
    expect(html).toContain("Post to Reviewer")
  })

  it("keeps the List's warnings in its cells: forge, card, time and concurrent", async () => {
    const data = { ...WALL, posts: [
      post("w1", "cx", "in_progress", {
        forgeState: { provider: "gitlab", state: "closed", closedBy: "a-person", mismatch: "forge-closed" },
        timeFlag: "Ran past its estimate", estimateMinutes: 10, runMs: 30 * 60e3,
        forgeTime: { loggedMinutes: 5, estimateMinutes: 60, flags: ["Logged less than it ran"] },
        concurrent: [{ on: ["chat"], runs: ["t1", "t2"] }],
      }),
      post("w2", "cx", "waiting_owner", { forgeState: { provider: "github", unknown: "token expired" },
        ownerCards: [{ title: "Ship it?", ask: "Ship it?", expiresAt: NOW + 3600e3, raisedBy: "cx", createdAt: NOW }] }),
      post("w3", "reviewer", "done", { forgeState: { provider: "github", state: "open", mismatch: "forge-open" } }),
    ] }
    const w = openWall({ data, hash: "#status=&view=list" })
    await w.settle()
    const rows = w.el("wall-list").innerHTML.split("<tr>").slice(2)
    const row = (id: string) => rows.find((r: string) => r.includes(`data-open="${id}"`)) ?? ""
    expect(row("w1")).toContain("GitLab closed by a-person")
    expect(row("w1")).toContain('title="Closed on the forge, still open here">⚠')
    expect(row("w1")).toContain('title="Ran past its estimate">⚠')
    expect(row("w1")).toContain('title="Logged less than it ran">⚠')
    expect(row("w1")).toContain('title="Concurrent runs: t1 + t2">⚠ concurrent')
    expect(row("w2")).toContain('title="token expired">GitHub unknown')
    expect(row("w2")).toContain("card expires")
    expect(row("w3")).toContain('title="Open on the forge, closed here">⚠')
  })

  it("empties the Creator after a post, so a second click sends nothing", async () => {
    let answer: (v: unknown) => void = () => {}
    const pending = new Promise((r) => { answer = r })
    const w = openWall({ data: PAGES, live: JOBS_LIVE, hash: "#page=creator", post: pending })
    await w.settle()
    w.click({ "data-creator-agent": "reviewer" })
    w.el("cr-text").value = "Check the release notes"
    w.el("cr-done").value = "a merged PR"
    w.click({ "data-creator-post": "" })
    // In flight: the button is off and a second click sends nothing.
    expect(w.el("wall-creator").innerHTML).toContain("data-creator-post disabled")
    w.click({ "data-creator-post": "" })
    answer({ ok: true, status: 200, json: async () => ({ message: "Posted." }) })
    await w.settle()
    const posts = () => w.calls.filter((c) => c.url === "/api/admin/wall/post")
    expect(posts()).toHaveLength(1)
    expect(w.el("cr-text").value).toBe("")
    expect(w.el("cr-done").value).toBe("")
    expect(w.el("wall-creator").innerHTML).toContain('<textarea id="cr-text" rows="4" maxlength="3500" placeholder="What should be done? Markdown works."></textarea>')
    w.click({ "data-creator-post": "" })
    await w.settle()
    expect(posts()).toHaveLength(1)
    expect(w.el("cr-note").textContent + w.el("wall-creator").innerHTML).toContain("Write the request first.")
  })

  it("shows Projects as cards with the worst state and closed per week", async () => {
    const tp = { throughput: { weeks: [], projects: [{ project: "shop", weeks: [0, 2, 1, 4], total: 7 }], owners: [] } }
    const w = openWall({ data: PAGES, throughput: tp, hash: "#status=open&view=projects" })
    await w.settle()
    await w.settle()
    const card = w.el("wall-projects").innerHTML.split('<article class="wpc">')[1]
    expect(card).toContain('<span class="wpc__s is-blocked">blocked</span>')
    expect(card.match(/<span style="height:\d+px" title="\d closed">/g)).toHaveLength(4)
    expect(card).toContain('title="4 closed"')
  })
})

describe("Wall v2 pages (#1355)", () => {
  const PAGES = {
    ...WALL,
    posts: [
      post("a", "cx", "in_progress", { project: "shop", lastMoveAt: NOW - 4 * 864e5, estimateMinutes: 1, runMs: 300e3 }),
      post("b", "cx", "waiting_other", { project: "shop", blocked: { who: "reviewer", since: NOW - 5 * 864e5, why: "review" }, blockedBy: { kind: "agent", who: "reviewer", project: null } }),
      post("c", "reviewer", "in_progress", { project: null }),
    ],
    projects: [{ project: "shop", open: 2, inProgress: 1, blocked: 1, stalled: 0 }, { project: null, open: 1, inProgress: 1, blocked: 0, stalled: 0 }],
    capacity: { threshold: 1, owners: [{ owner: "cx", inProgress: 1, waiting: 1, over: true }] },
  }
  const runs = (statuses: string[]) => statuses.map((status, i) => ({ at: new Date(NOW - i * 3600e3).toISOString(), status }))
  const JOBS_LIVE = { nodes: [{
    ...LIVE.nodes[0], url: "http://node-a",
    crons: [
      { id: "digest", agent: "cx", schedule: "0 9 * * *", enabled: true, consecutiveErrors: 0, nextRun: new Date(NOW + 3600e3).toISOString(), value: { why: "the owner reads it", metric: "opened daily" } },
      { id: "sync", agent: "reviewer", schedule: "*/30 * * * *", enabled: true, consecutiveErrors: 3 },
    ],
    cronRuns: [
      { jobId: "digest", startedAt: new Date(NOW - 60e3).toISOString(), status: "success", taskId: "t-digest" },
      { jobId: "sync", startedAt: new Date(NOW - 120e3).toISOString(), status: "failed", errorSummary: "token expired" },
      { jobId: "sync", startedAt: new Date(NOW - 180e3).toISOString(), status: "success", quiet: true },
    ],
    routines: [
      { id: "cron:digest", recent: runs(["success", "success"]), consecutiveFailures: 0, flags: [], lastRun: { at: new Date(NOW - 60e3).toISOString(), status: "success" } },
      { id: "cron:sync", recent: runs(["failed", "failed", "failed", "success", "success", "success", "success"]), consecutiveFailures: 3, flags: [], lastRun: { at: new Date(NOW - 120e3).toISOString(), status: "failed", summary: "token expired" } },
    ],
  }] }

  it("draws the List with seven columns, quick views and amber old waits; Columns adds the rest", async () => {
    const w = openWall({ data: PAGES, hash: "#status=open&view=list" })
    await w.settle()
    const html = w.el("wall-list").innerHTML
    expect(html).toContain('data-tab="blocked">Blocked</button>')
    expect(html).toContain('data-quick="cols"')
    expect(html.match(/<th data-sort=/g)).toHaveLength(7)
    expect(html).toContain('<td class="num is-amber">4</td>')
    expect(html).toMatch(/<td class="is-amber">5 \/ 1 min/)
    w.click({ "data-quick": "cols" })
    expect(w.el("wall-list").innerHTML.match(/<th data-sort=/g)).toHaveLength(10)
  })

  it("groups the List by owner, project or blocker, each group with its count and oldest wait", async () => {
    const w = openWall({ data: PAGES, hash: "#status=open&grp=owner&view=list" })
    await w.settle()
    let html = w.el("wall-list").innerHTML
    expect(html).toMatch(/<tr class="wl__g"><th colspan="7">@cx <small>2 posts · oldest wait 5 d<\/small>/)
    expect(html).toContain("@reviewer <small>1 post")
    const b = openWall({ data: PAGES, hash: "#status=open&grp=blocked&view=list" })
    await b.settle()
    html = b.el("wall-list").innerHTML
    expect(html).toContain("@reviewer <small>1 post")
    expect(html).toContain("No blocker recorded <small>2 posts")
  })

  it("lists jobs per machine with today's totals, seven squares and look stale", async () => {
    const w = openWall({ data: PAGES, live: JOBS_LIVE, hash: "#status=open&view=jobs" })
    await w.settle()
    const html = w.el("wall-jobs").innerHTML
    expect(html).toContain("<dt>ran</dt><dd>3</dd>")
    expect(html).toContain("<dt>worked</dt><dd>1</dd>")
    expect(html).toContain("<dt>failed</dt><dd>1</dd>")
    expect(html).toContain("<dt>quiet</dt><dd>1</dd>")
    expect(html).toContain("<dt>look stale</dt><dd>1</dd>")
    const sync = html.split("<b>sync</b>")[1]
    expect(sync).toContain('title="failed 3 times in a row; no value line">look stale</span>')
    expect(sync.split('class="wjb__sq"')[1].match(/class="is-(ok|err)"/g)).toHaveLength(7)
    expect(sync).toContain("token expired")
    expect(sync).toContain('disabled title="Phase 2, not built">Pause</button>')
    const digest = html.split("<b>digest</b>")[1].split("<b>sync</b>")[0]
    expect(digest).toContain('<span class="chip chip--done">on</span>')
    expect(digest.match(/class="is-none"/g)).toHaveLength(5)
    expect(digest).toContain("t-digest")
  })

  it("posts a task from the Creator, with Done when, project and estimate", async () => {
    const w = openWall({ data: PAGES, live: JOBS_LIVE, hash: "#page=creator" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("New post")
    let html = w.el("wall-creator").innerHTML
    expect(html).toContain("This page sends a message")
    expect(html).toContain('data-creator-agent="cx"')
    expect(html).toMatch(/data-creator-agent="cx"[^>]*>.*?over capacity/)
    expect(html).toContain("data-creator-post disabled")
    w.click({ "data-creator-agent": "reviewer" })
    w.el("cr-text").value = "Check the release notes"
    w.el("cr-done").value = "a merged PR"
    w.el("cr-project").value = "shop"
    w.el("cr-estimate").value = "30"
    w.click({ "data-creator-post": "" })
    await w.settle()
    const posted = w.calls.filter((c) => c.url === "/api/admin/wall/post").map((c) => JSON.parse(c.init.body))
    expect(posted).toEqual([{ agent: "reviewer", text: "Check the release notes\nDone when: a merged PR\nProject: shop\nEstimate: 30 min" }])
    html = w.el("wall-creator").innerHTML
    expect(html).toContain("Post to Reviewer")
  })

  it("keeps the List's warnings in its cells: forge, card, time and concurrent", async () => {
    const data = { ...WALL, posts: [
      post("w1", "cx", "in_progress", {
        forgeState: { provider: "gitlab", state: "closed", closedBy: "a-person", mismatch: "forge-closed" },
        timeFlag: "Ran past its estimate", estimateMinutes: 10, runMs: 30 * 60e3,
        forgeTime: { loggedMinutes: 5, estimateMinutes: 60, flags: ["Logged less than it ran"] },
        concurrent: [{ on: ["chat"], runs: ["t1", "t2"] }],
      }),
      post("w2", "cx", "waiting_owner", { forgeState: { provider: "github", unknown: "token expired" },
        ownerCards: [{ title: "Ship it?", ask: "Ship it?", expiresAt: NOW + 3600e3, raisedBy: "cx", createdAt: NOW }] }),
      post("w3", "reviewer", "done", { forgeState: { provider: "github", state: "open", mismatch: "forge-open" } }),
    ] }
    const w = openWall({ data, hash: "#status=&view=list" })
    await w.settle()
    const rows = w.el("wall-list").innerHTML.split("<tr>").slice(2)
    const row = (id: string) => rows.find((r: string) => r.includes(`data-open="${id}"`)) ?? ""
    expect(row("w1")).toContain("GitLab closed by a-person")
    expect(row("w1")).toContain('title="Closed on the forge, still open here">⚠')
    expect(row("w1")).toContain('title="Ran past its estimate">⚠')
    expect(row("w1")).toContain('title="Logged less than it ran">⚠')
    expect(row("w1")).toContain('title="Concurrent runs: t1 + t2">⚠ concurrent')
    expect(row("w2")).toContain('title="token expired">GitHub unknown')
    expect(row("w2")).toContain("card expires")
    expect(row("w3")).toContain('title="Open on the forge, closed here">⚠')
  })

  it("empties the Creator after a post, so a second click sends nothing", async () => {
    let answer: (v: unknown) => void = () => {}
    const pending = new Promise((r) => { answer = r })
    const w = openWall({ data: PAGES, live: JOBS_LIVE, hash: "#page=creator", post: pending })
    await w.settle()
    w.click({ "data-creator-agent": "reviewer" })
    w.el("cr-text").value = "Check the release notes"
    w.el("cr-done").value = "a merged PR"
    w.click({ "data-creator-post": "" })
    // In flight: the button is off and a second click sends nothing.
    expect(w.el("wall-creator").innerHTML).toContain("data-creator-post disabled")
    w.click({ "data-creator-post": "" })
    answer({ ok: true, status: 200, json: async () => ({ message: "Posted." }) })
    await w.settle()
    const posts = () => w.calls.filter((c) => c.url === "/api/admin/wall/post")
    expect(posts()).toHaveLength(1)
    expect(w.el("cr-text").value).toBe("")
    expect(w.el("cr-done").value).toBe("")
    expect(w.el("wall-creator").innerHTML).toContain('<textarea id="cr-text" rows="4" maxlength="3500" placeholder="What should be done? Markdown works."></textarea>')
    w.click({ "data-creator-post": "" })
    await w.settle()
    expect(posts()).toHaveLength(1)
    expect(w.el("cr-note").textContent + w.el("wall-creator").innerHTML).toContain("Write the request first.")
  })

  it("shows Projects as cards with the worst state and closed per week", async () => {
    const tp = { throughput: { weeks: [], projects: [{ project: "shop", weeks: [0, 2, 1, 4], total: 7 }], owners: [] } }
    const w = openWall({ data: PAGES, throughput: tp, hash: "#status=open&view=projects" })
    await w.settle()
    await w.settle()
    const card = w.el("wall-projects").innerHTML.split('<article class="wpc">')[1]
    expect(card).toContain('<span class="wpc__s is-blocked">blocked</span>')
    expect(card.match(/<span style="height:\d+px" title="\d closed">/g)).toHaveLength(4)
    expect(card).toContain('title="4 closed"')
  })
})

describe("Wall v2 live sessions, comments and calls (#1355)", () => {
  const LIVE3 = { nodes: [
    { name: "node-a", url: "http://node-a", reachable: true, space: { agents: ["cx", "reviewer"], topic: "Release notes", startedAt: new Date(NOW - 300e3).toISOString() },
      crons: [{ id: "digest", agent: "cx", schedule: "0 9 * * *", enabled: true, consecutiveErrors: 0, nextRun: new Date(NOW + 1800e3).toISOString() }],
      agents: [
        { id: "cx", name: "Customer Desk", runningTasks: [{ id: "t9", startedAt: new Date(NOW - 60e3).toISOString(), messagePreview: "Answering a refund" }] },
        { id: "reviewer", name: "Reviewer", runningTasks: [] },
      ] },
    { name: "node-b", url: "http://node-b", reachable: true, space: { agents: ["far"], topic: "Far talk", startedAt: new Date(NOW).toISOString() },
      agents: [{ id: "far", name: "Far Agent", runningTasks: [] }] },
  ] }

  it("lists live sessions with Spaces first, joins a Space here, names one elsewhere, and shows what comes up", async () => {
    const w = openWall({ live: LIVE3, hash: "#page=live" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Live")
    expect(w.el("nav-n-live").textContent).toBe("3")
    const html = w.el("wall-live").innerHTML
    // Spaces first; the runs after them open the Wall's Task page (#1381).
    const order = [...html.matchAll(/<(?:article|a) class="wls is-(\w+)"/g)].map((m) => m[1])
    expect(order).toEqual(["space", "space", "work"])
    expect(html).toContain("Release notes")
    expect(html).toContain("data-join-space")
    expect(html).toContain("Plays on node-b")
    expect(html).toContain('href="#page=task&amp;task=t9&amp;agent=cx&amp;node=http%3A%2F%2Fnode-a&amp;ask=Answering+a+refund&amp;at=')
    expect(html).toContain("<b>digest</b>")
    w.click({ "data-join-space": "" })
    await w.settle()
    expect(w.calls.some((c) => c.url === "/api/admin/wall/space" && !c.init?.method)).toBe(false)
    expect(w.calls.filter((c) => c.url === "/api/admin/wall/space").map((c) => c.init.method)).toEqual(["GET"])
  })

  it("starts a Space from the Live page with two agents and a topic", async () => {
    const w = openWall({ live: LIVE3, hash: "#page=live" })
    await w.settle()
    w.el("lv-a").value = "cx"
    w.el("lv-b").value = "reviewer"
    w.el("lv-topic").value = "What to ship Friday"
    w.click({ "data-live-start": "" })
    await w.settle()
    const sent = w.calls.filter((c) => c.url === "/api/admin/wall/space" && c.init.method === "POST").map((c) => JSON.parse(c.init.body))
    expect(sent).toEqual([{ agent: "cx", with: "reviewer", topic: "What to ship Friday" }])
  })

  it("sends a comment's @mentions to those agents as posts on their own machines", async () => {
    const w = openWall({ live: LIVE3, hash: "#status=open&post=r1" })
    await w.settle()
    w.el("wdo-text").value = "Please check with @reviewer and @far, not @nobody"
    w.click({ "data-act": "comment" })
    await w.settle()
    const posts = w.calls.filter((c) => c.url === "/api/admin/wall/post")
    expect(posts.map((c) => JSON.parse(c.init.body).agent)).toEqual(["reviewer", "far"])
    expect(JSON.parse(posts[0].init.body).text).toMatch(/^The owner mentioned you in a comment on Hub post r1 by @cx/)
    expect(posts[0].init.headers["X-Agentx-Peer"]).toBeUndefined()
    expect(posts[1].init.headers["X-Agentx-Peer"]).toBe("http://node-b")
    expect(w.el("wdo-note").textContent).toMatch(/Also posted to @reviewer, @far\./)
  })

  it("finds a mention by a display name of several words, in the order written", async () => {
    const live = { nodes: [LIVE3.nodes[0], { ...LIVE3.nodes[1], agents: [{ id: "ops", name: "Night Shift", runningTasks: [] }] }] }
    const w = openWall({ live, hash: "#status=open&post=r1" })
    await w.settle()
    w.el("wdo-text").value = "Ask @night shift first, then @Reviewer. Not mail@reviewer, @reviewers or @night"
    w.click({ "data-act": "comment" })
    await w.settle()
    const posts = w.calls.filter((c) => c.url === "/api/admin/wall/post")
    expect(posts.map((c) => JSON.parse(c.init.body).agent)).toEqual(["ops", "reviewer"])
  })

  it("calls an agent and joins its live work from the Agents page", async () => {
    const w = openWall({ live: LIVE3, hash: "#page=agents" })
    await w.settle()
    const html = w.el("wall-agents-page").innerHTML
    const cx = html.split('id="agent-cx"')[1].split('id="agent-')[0]
    expect(cx).toContain('data-call-agent="cx"')
    expect(cx).toContain("● Join live</a>")
    expect(html.split('id="agent-reviewer"')[1].split('id="agent-')[0]).not.toContain("Join live")
    w.click({ "data-call-agent": "far" })
    await w.settle()
    const call = w.calls.find((c) => c.url === "/api/admin/wall/call")!
    expect(JSON.parse(call.init.body)).toEqual({ agent: "far" })
    expect(call.init.headers["X-Agentx-Peer"]).toBe("http://node-b")
  })
})

// #1355 Task design: an opened post reads as a task.
describe("Wall v2 task view (#1355)", () => {
  const PLAN = [
    { idx: 1, name: "Build the fix", agentId: "cx", state: "done", doneWhen: "PR merged", evidence: "https://example.com/pr/9", note: null },
    { idx: 2, name: "Deploy", agentId: "reviewer", state: "blocked", doneWhen: "release live", evidence: null, note: "waits on the <deploy> window" },
    { idx: 3, name: "Tell the client", agentId: "cx", state: "pending", doneWhen: "", evidence: null, note: null },
  ]

  it("leads with the request as its title, where it stands, then the plan and the facts", async () => {
    const w = openWall({ hash: "#post=r1", thread: { events: [], plan: PLAN } })
    await w.settle()
    const page = w.el("wall-post").innerHTML
    expect(page).toContain('<h1 class="wtk__title">Post r1</h1>')
    const prog = /<ol class="wtk__prog"[^>]*>(.*?)<\/ol>/.exec(page)![1]
    expect(prog).toContain('<li class="is-done"><b>Asked</b>')
    expect(prog).toContain('<li class="is-now" aria-current="step"><b>Working</b><span>1 run, 2 min</span>')
    expect(page).toContain("Plan <span class=\"k\">1 of 3 done</span>")
    expect(page).toContain('<li class="is-blocked">')
    expect(page).toContain("Done when: PR merged")
    expect(page).toContain('<a href="https://example.com/pr/9" target="_blank" rel="noopener">Proof</a>')
    expect(page).toContain("waits on the &lt;deploy&gt; window")
    expect(page).toContain("<dt>Asked by</dt><dd>Demo operator</dd>")
    expect(page).toContain("<dt>Time</dt><dd>2 min of runs</dd>")
    expect(page.indexOf("wtk__prog")).toBeLessThan(page.indexOf("wtk__plan"))
    expect(page.indexOf("wtk__plan")).toBeLessThan(page.indexOf("wtk__facts"))
  })

  it("marks a waiting task's step amber, and a done one closed", async () => {
    const w = openWall({ hash: "#post=r2" })
    await w.settle()
    const wait = /<ol class="wtk__prog"[^>]*>(.*?)<\/ol>/.exec(w.el("wall-post").innerHTML)![1]
    expect(wait).toContain('<li class="is-wait" aria-current="step"><b>Waits</b><span>on you</span>')
    expect(w.el("wall-post").innerHTML).not.toContain("wtk__plan")
    const d = openWall({ hash: "#post=r3", data: { ...WALL, posts: [post("r3", "reviewer", "done", { closedAt: NOW - 60e3 })] } })
    await d.settle()
    const done = /<ol class="wtk__prog"[^>]*>(.*?)<\/ol>/.exec(d.el("wall-post").innerHTML)![1]
    expect(done).toContain('<li class="is-done"><b>Working</b>')
    expect(done).toMatch(/<li class="is-done"><b>Done<\/b><span>\d+s ago<\/span>/)
    expect(d.el("wall-post").innerHTML).toContain("<dt>Closed</dt>")
  })

  // Review notes on #1377.
  const strip = (html: string) => /<ol class="wtk__prog"[^>]*>(.*?)<\/ol>/.exec(html)![1]
  const one = (p: unknown, thread?: unknown) => openWall({ hash: "#post=x", data: { ...WALL, posts: [p] }, thread })

  it("names who a post waits on: another agent, the active step's owner, never you", async () => {
    const a = one(post("x", "cx", "waiting_other"))
    await a.settle()
    expect(strip(a.el("wall-post").innerHTML)).toContain("<b>Waits</b><span>on another agent</span>")
    const b = one(post("x", "cx", "waiting_other"), { events: [], plan: PLAN })
    await b.settle()
    expect(strip(b.el("wall-post").innerHTML)).toContain("<b>Waits</b><span>on @reviewer</span>")
  })

  it("says who blocks a post once, in the strip, and why under it", async () => {
    const w = one(post("x", "cx", "waiting_other", { blocked: { who: "reviewer", since: NOW - 3 * 3600e3, why: "needs a review" } }))
    await w.settle()
    const page = w.el("wall-post").innerHTML
    expect(strip(page)).toContain("<b>Waits</b><span>on reviewer for 3 h</span>")
    expect(page).toMatch(/<div class="wp__block" title="Since [^"]+">Why it waits: needs a review<\/div>/)
    expect(page.match(/>reviewer</g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it("leaves an open post nobody picked up at Asked", async () => {
    const w = one(post("x", "cx", "in_progress", { runs: 0, runMs: 0 }))
    await w.settle()
    const s = strip(w.el("wall-post").innerHTML)
    expect(s).toContain('<li class="is-now" aria-current="step"><b>Asked</b>')
    expect(s).toContain('<li class=""><b>Working</b><span>not picked up yet</span>')
  })
})

// #1392: the Goal filter shows only that goal's posts, under a line with its
// progress and cost; with no goal picked the Wall is as before.
describe("Goal filter on the Wall (#1392)", () => {
  const launch = { id: "launch", title: "Launch the site" }
  const GOALS = {
    ...WALL,
    posts: [
      post("g1", "cx", "in_progress", { goal: launch }),
      post("g2", "cx", "done", { goal: launch }),
      post("g3", "reviewer", "in_progress", { goal: { id: "hire", title: "Hire a designer" } }),
      post("n1", "reviewer", "in_progress", { goal: null }),
    ],
    goals: [
      { id: "launch", title: "Launch the site", open: 1, done: 1, dropped: 1, progress: 0.5, costUsd: 0.75, runs: 3, unpriced: 1, lastAt: NOW },
      { id: "hire", title: "Hire a designer", open: 1, done: 0, dropped: 0, progress: 0, costUsd: 0, runs: 0, unpriced: 0, lastAt: NOW - 1 },
    ],
  }

  it("with no goal picked, lists every post and shows no goal line", async () => {
    const w = openWall({ data: GOALS, hash: "#status=" })
    await w.settle()
    expect(w.el("wall-count").textContent).toBe("4 of 4 posts")
    expect(w.el("wall-goal").hidden).toBe(true)
    expect(w.el("f-goal").innerHTML).toContain('<option value="launch">Launch the site</option>')
    expect(w.el("f-goal").innerHTML).toContain('<option value="hire">Hire a designer</option>')
    // The post without a goal is listed, without a goal chip.
    const feed = w.el("wall-feed").innerHTML
    expect(feed).toContain('data-post="n1"')
    expect(/id="post-n1"[^]*?<\/article>/.exec(feed)![0]).not.toContain("data-goal")
  })

  it("lists the same posts as a Wall reply with no goals at all", async () => {
    const plain = openWall({ data: WALL, hash: "#status=" })
    await plain.settle()
    expect(plain.el("wall-count").textContent).toBe("3 of 3 posts")
    expect(plain.el("wall-goal").hidden).toBe(true)
    expect(plain.el("wall-feed").innerHTML).not.toContain("data-goal")
  })

  it("picking a goal shows only its posts, open and closed, with progress and cost", async () => {
    const w = openWall({ data: GOALS, hash: "#status=&goal=launch" })
    await w.settle()
    expect(w.el("wall-count").textContent).toBe("2 of 4 posts")
    const feed = w.el("wall-feed").innerHTML
    expect(feed).toContain('data-post="g1"')
    expect(feed).toContain('data-post="g2"')
    expect(feed).not.toContain('data-post="g3"')
    expect(feed).not.toContain('data-post="n1"')
    const line = w.el("wall-goal")
    expect(line.hidden).toBe(false)
    expect(line.innerHTML).toContain("Launch the site")
    expect(line.innerHTML).toContain('role="progressbar"')
    expect(line.innerHTML).toContain('aria-valuenow="50"')
    expect(line.innerHTML).toContain("1 of 2 done (50%) · 1 open · 1 dropped")
    expect(line.innerHTML).toContain("$0.75 (1 of 3 runs without a cost)")
  })

  it("a post's goal chip opens the filter; All goals clears it", async () => {
    const w = openWall({ data: GOALS, hash: "#status=open" })
    await w.settle()
    expect(w.el("wall-feed").innerHTML).toContain('data-goal="hire"')
    w.click({ "data-goal": "hire" })
    await w.settle()
    expect(w.loc.hash).toContain("goal=hire")
    expect(w.el("wall-count").textContent).toBe("1 of 4 posts")
    w.click({ "data-goal-clear": "" })
    await w.settle()
    expect(w.loc.hash).not.toContain("goal=")
    expect(w.el("wall-goal").hidden).toBe(true)
    expect(w.el("wall-count").textContent).toBe("4 of 4 posts")
  })

  it("says so when no machine sent a row for the goal, and still shows its posts", async () => {
    const w = openWall({ data: { ...GOALS, goals: [] }, hash: "#status=&goal=launch" })
    await w.settle()
    expect(w.el("wall-count").textContent).toBe("2 of 4 posts")
    expect(w.el("wall-goal").innerHTML).toContain("No progress or cost for this goal")
  })
})

describe("The org on the Wall (#1398)", () => {
  const ORG = { exists: true, live: true, outside: [], roots: [
    { id: "reviewer", name: "Reviewer", title: "Head of Quality", status: "idle", reports: [
      { id: "cx", name: "Customer Desk", title: "Support Lead", reportsTo: "reviewer", status: "working", reports: [] },
    ] },
  ] }

  it("links to /org from the Wall's classic pages", () => {
    expect(WALL_CLASSIC_LINKS).toContainEqual(["Org", "/org"])
    expect(renderWallPage()).toContain('<a href="/org">Org</a>')
  })

  it("shows an agent's role and who it reports to on its profile", async () => {
    const w = openWall({ org: ORG })
    await w.settle()
    w.click({ "data-agent": "cx" })
    await w.settle()
    const prof = w.el("wall-profile").innerHTML
    expect(prof).toContain('<div class="wp__meta wpf__org"><span><b>Support Lead</b></span>')
    expect(prof).toContain('reports to <button type="button" data-agent="reviewer">Reviewer</button>')
    expect(prof).toContain('<a href="#page=org">Org chart</a>')
    w.click({ "data-agent": "reviewer" })
    await w.settle()
    const boss = w.el("wall-profile").innerHTML
    expect(boss).toContain("<b>Head of Quality</b>")
    expect(boss).toContain("1 reports to it")
    expect(boss).not.toContain("reports to <button")
  })

  it("names a person boss in plain text, with no agent button (#1418)", async () => {
    const org = { exists: true, live: true, outside: [], people: [{ id: "owner", name: "Sam Owner" }], roots: [
      { id: "cx", name: "Customer Desk", title: "Support Lead", reportsTo: "person:owner", status: "idle", reports: [] },
    ] }
    const w = openWall({ org })
    await w.settle()
    w.click({ "data-agent": "cx" })
    await w.settle()
    const prof = w.el("wall-profile").innerHTML
    expect(prof).toContain("<span>reports to Sam Owner</span>")
    expect(prof).not.toContain('data-agent="person:owner"')
  })

  it("shows the role and boss on each Agents page card", async () => {
    const w = openWall({ org: ORG, hash: "#page=agents" })
    await w.settle()
    const page = w.el("wall-agents-page").innerHTML
    expect(page).toMatch(/id="agent-cx"[\s\S]*<b>Support Lead<\/b>[\s\S]*reports to <button type="button" data-agent="reviewer">Reviewer<\/button>/)
  })

  it("only reads the org: no hold, Pause or Resume from the Wall", async () => {
    const w = openWall({ org: ORG, hash: "#page=agents" })
    await w.settle()
    w.click({ "data-agent": "cx" })
    await w.settle()
    const org = w.calls.filter((c) => c.url.startsWith("/api/admin/org"))
    expect(org.map((c) => c.url)).toEqual(["/api/admin/org"])
    expect(org[0].init?.method ?? "GET").toBe("GET")
    const html = w.el("wall-profile").innerHTML + w.el("wall-agents-page").innerHTML
    expect(html).not.toContain("data-hold")
    expect(html).not.toMatch(/>(Pause|Resume)</)
  })

  it("draws the profile as before when the org is missing or fails", async () => {
    for (const org of [undefined, "fail"]) {
      const w = openWall({ org })
      await w.settle()
      w.click({ "data-agent": "cx" })
      await w.settle()
      const prof = w.el("wall-profile").innerHTML
      expect(prof).toContain("<h2>Customer Desk</h2>")
      expect(prof).not.toContain("wpf__org")
    }
  })
})

describe("People and relation types on the Wall (#1421)", () => {
  // The /api/admin/org shape from #1418: people, and typed relations between
  // `agent:<id>` and `person:<id>` members. The tree still nests agents only.
  const ORG = { exists: true, live: true, outside: [],
    people: [{ id: "owner", name: "The Owner" }, { id: "sam", name: "Sam Lee" }],
    roots: [
      { id: "reviewer", name: "Reviewer", title: "Head of Quality", reportsTo: "person:owner", status: "idle", reports: [
        { id: "cx", name: "Customer Desk", title: "Support Lead", reportsTo: "reviewer", status: "working", reports: [] },
      ] },
    ],
    relations: [
      { from: "agent:reviewer", to: "person:owner", type: "reports-to" },
      { from: "agent:cx", to: "agent:reviewer", type: "reports-to" },
      { from: "agent:cx", to: "person:sam", type: "dotted-line" },
      { from: "agent:cx", to: "person:owner", type: "acts-for" },
    ],
  }
  async function profile(org: unknown, id: string) {
    const w = openWall({ org })
    await w.settle()
    w.click({ "data-agent": id })
    await w.settle()
    return w
  }

  it("shows a person as the boss, as plain text with their name", async () => {
    const prof = (await profile(ORG, "reviewer")).el("wall-profile").innerHTML
    expect(prof).toContain("<span>reports to The Owner</span>")
    expect(prof).not.toContain('data-agent="owner"')
    expect(prof).toContain("1 reports to it")
  })

  it("shows dotted-line and acts-for relations next to reports-to", async () => {
    const prof = (await profile(ORG, "cx")).el("wall-profile").innerHTML
    expect(prof).toContain('reports to <button type="button" data-agent="reviewer">Reviewer</button>')
    expect(prof).toContain("<span>dotted line to Sam Lee</span>")
    expect(prof).toContain("<span>acts for The Owner</span>")
  })

  it("reads a legacy reportsTo and a person's id when people are not listed", async () => {
    const legacy = { exists: true, live: true, outside: [], roots: [
      { id: "cx", name: "Customer Desk", reportsTo: "person:owner", status: "idle", reports: [] },
    ] }
    const prof = (await profile(legacy, "cx")).el("wall-profile").innerHTML
    expect(prof).toContain("<span>reports to owner</span>")
  })

  it("shows the relations on the Agents page card", async () => {
    const w = openWall({ org: ORG, hash: "#page=agents" })
    await w.settle()
    const page = w.el("wall-agents-page").innerHTML
    expect(page).toMatch(/id="agent-cx"[\s\S]*<span>dotted line to Sam Lee<\/span>[\s\S]*<span>acts for The Owner<\/span>/)
  })

  it("opens the Wall's Org page from the profile's Org link and writes nothing", async () => {
    expect(renderWallPage()).toContain('<a href="/org">Org</a>')
    const w = await profile(ORG, "cx")
    expect(w.el("wall-profile").innerHTML).toContain('<a href="#page=org">Org chart</a>')
    const org = w.calls.filter((c) => c.url.startsWith("/api/admin/org"))
    expect(org.map((c) => c.url)).toEqual(["/api/admin/org"])
    expect(org[0].init?.method ?? "GET").toBe("GET")
    expect(w.calls.every((c) => (c.init?.method ?? "GET") === "GET" || !c.url.includes("/org"))).toBe(true)
  })

  it("reads what GET /api/admin/org returns for people and typed relations (#1418)", async () => {
    const view = buildOrgView({
      agents: { reviewer: { name: "Reviewer" }, cx: { name: "Customer Desk" } },
      people: [{ id: "owner", name: "The Owner" }, { id: "sam", name: "Sam Lee" }],
      business: {
        orgChart: { reviewer: { role: "Head of Quality", reportsTo: "person:owner" }, cx: { role: "Support Lead", reportsTo: "reviewer" } },
        relations: [{ from: "cx", to: "person:sam", type: "dotted-line" }, { from: "cx", to: "person:owner", type: "acts-for" }],
      },
    }, {}, null)
    const org = { exists: true, ...view }
    const boss = (await profile(org, "reviewer")).el("wall-profile").innerHTML
    expect(boss).toContain("<span>reports to The Owner</span>")
    expect(boss).toContain("1 reports to it")
    const prof = (await profile(org, "cx")).el("wall-profile").innerHTML
    expect(prof).toContain('reports to <button type="button" data-agent="reviewer">Reviewer</button>')
    expect(prof).toContain("<span>dotted line to Sam Lee</span>")
    expect(prof).toContain("<span>acts for The Owner</span>")
  })

  it("shows the Wall as today when the org fails or its relations are malformed", async () => {
    for (const org of ["fail", { exists: true, roots: [], people: "x", relations: { nope: 1 } }]) {
      const prof = (await profile(org, "cx")).el("wall-profile").innerHTML
      expect(prof).toContain("<h2>Customer Desk</h2>")
      expect(prof).not.toContain("wpf__org")
    }
  })
})

describe("The Cost page on the Wall (#1423)", () => {
  const today = new Date().toISOString().slice(0, 10)
  const COST = { generatedAt: new Date().toISOString(), kpis: { spendToday: 1.5, spend7d: 4, spendDeltaWoW: 0.25 },
    days: [{ date: today, cost: 4, tasks: 3, input: 100, cacheRead: 300, agents: { cx: { cost: 3, tasks: 2 }, reviewer: { cost: 1, tasks: 1 } } }] }
  const BUDGETS = { month: "2026-10", agents: [{ agentId: "cx", spentUsd: 3, capUsd: 10, state: "ok" }], fleet: { spentUsd: 4, state: "uncapped" } }

  it("opens from the nav with the month total, reads the cost for twice the range, and a row opens the profile", async () => {
    const w = openWall({ hash: "#status=open&view=cost", cost: COST, budgets: BUDGETS })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Cost")
    expect(w.el("wall-cost-n").textContent).toBe("$4.00")
    expect(w.calls.map((c) => c.url)).toContain("/api/admin/observability/cost?range=60")
    const html = w.el("wall-cost").innerHTML
    expect(w.el("wall-cost").hidden).toBe(false)
    expect(html).toContain("<b>$4.00</b> this month")
    expect(html).toMatch(/data-cagent="cx"[\s\S]*Customer Desk[\s\S]*<b>\$3\.00<\/b>[\s\S]*data-cagent="reviewer"/)
    w.click({ "data-cagent": "cx" })
    await w.settle()
    expect(w.el("wall-cost").hidden).toBe(true)
    expect(w.el("wall-profile").hidden).toBe(false)
    expect(w.el("wall-profile").innerHTML).toContain("<h2>Customer Desk</h2>")
  })

  it("a range tab reads that range again", async () => {
    const w = openWall({ hash: "#status=open&view=cost", cost: COST, budgets: BUDGETS })
    await w.settle()
    w.click({ "data-crange": "90" })
    await w.settle()
    expect(w.calls.map((c) => c.url)).toContain("/api/admin/observability/cost?range=180")
    expect(w.el("wall-cost").innerHTML).toMatch(/data-crange="90" class="is-on"/)
  })

  it("says so when the cost read fails, and the rest of the Wall still works", async () => {
    const w = openWall({ hash: "#status=open&view=cost", cost: "fail" })
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toContain("Could not read the cost: node-a answered with an error. The rest of the Hub still works.")
    w.click({ "data-view": "feed" })
    await w.settle()
    expect(w.el("wall-cost").hidden).toBe(true)
    expect(w.el("wall-feed").innerHTML).toContain("Post r1")
  })
})

describe("Needs you: answer on the Wall (#1440)", () => {
  /** An item on the page, as closest("[data-dkey]") finds it. */
  function item(key: string, picked: string | null, peer: string | null = null, choices = true) {
    return {
      getAttribute: (k: string) => (k === "data-dkey" ? key : k === "data-dpeer" ? peer : k === "data-dtitle" ? "Send the newsletter?" : null),
      // A card with choices has radios; picked is the checked one, if any.
      querySelector: (sel: string) => (!choices ? null : sel.endsWith(":checked") ? (picked == null ? null : { value: picked }) : { focus: () => {} }),
      querySelectorAll: () => [],
    }
  }
  /** A click on a button with this attribute inside the item. */
  function press(w: ReturnType<typeof openWall>, it: ReturnType<typeof item>, attr: string, value = "") {
    const btn = { hasAttribute: (k: string) => k === attr, getAttribute: () => value, closest: (sel: string) => (sel === "[data-dkey]" ? it : null) }
    w.fire("click", { target: { closest: (sel: string) => (sel.includes(`[${attr}]`) ? btn : null) } })
  }
  /** An answer: the button, then Confirm on the line it opens. */
  function answer(w: ReturnType<typeof openWall>, key: string, action: string, picked: string | null, peer: string | null = null, choices = true) {
    const it = item(key, picked, peer, choices)
    press(w, it, "data-decide", action)
    press(w, it, "data-dgo")
  }
  const decideCalls = (w: ReturnType<typeof openWall>) => w.calls.filter((c) => c.url === "/api/admin/wall/decide")

  it("opens from the nav as the owner's list, with the same count, tabs and kind chips", async () => {
    const page = renderWallPage()
    expect(page).toContain('data-nav="needs" href="#status=open&amp;view=decide"')
    const w = openWall({ hash: "#status=open&view=decide" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Needs you")
    expect(w.el("nav-n-needs").textContent).toBe("1")
    expect(w.el("wall-decide").hidden).toBe(false)
    expect(w.el("wall-feed").hidden).toBe(true)
    const html = w.el("wall-decide").innerHTML
    expect(html).toContain("1 waiting for you")
    expect(html).toContain("Same count as the Desk and the digest")
    expect(html).toMatch(/data-dtab="waiting"[^>]*>Waiting <span class="n">1<\/span>[\s\S]*data-dtab="later"[^>]*>Put off<[\s\S]*data-dtab="answered"[^>]*>Answered</)
    expect(html).toContain('data-dkind="" class="wdc__chip is-on" aria-pressed="true">All <span class="n">1</span>')
    for (const chip of ["Decisions <span class=\"n\">1", "Schedules <span class=\"n\">0", "Memory", "Wiki", "Drafts", "Requests", "Reviews <span class=\"n\">0"]) expect(html).toContain(chip)
    expect(html).toContain("Send the newsletter?")
    expect(html).toContain('<span class="wdc__badge is-card">Decision</span>')
    // The advised choice comes picked; the draft is folded, filled with it.
    expect(html).toContain('value="1" checked><span>Tuesday <em>advised</em>')
    expect(html).toContain("<summary>The draft, and what Yes and No do</summary>")
    expect(html).toContain("Send it on Tuesday.</textarea>")
    expect(html).toContain("Unblocks: nothing waits on it.")
    expect(html).toMatch(/data-decide="yes"[\s\S]*data-decide="no"[\s\S]*data-decide="later"/)
    // No raw keys or commands in the text.
    expect(html).not.toContain("agentx approvals")
    expect(html).not.toMatch(/>[^<]*card:c1/)
  })

  it("asks to confirm, naming what is sent, then sends a yes as /approvals does", async () => {
    const w = openWall({ hash: "#status=open&view=decide" })
    await w.settle()
    press(w, item("card:c1", "1"), "data-decide", "yes")
    await w.settle()
    expect(decideCalls(w)).toHaveLength(0)
    expect(w.el("wall-decide").innerHTML).toContain("<b>Send Customer Desk: Yes, Tuesday.</b> It is recorded as your answer, as on the Desk, and cannot be taken back.")
    press(w, item("card:c1", "1"), "data-dgo")
    await w.settle()
    const sent = decideCalls(w)
    expect(sent).toHaveLength(1)
    expect(sent[0].init.method).toBe("POST")
    expect(sent[0].init.headers["X-Requested-With"]).toBe("agentx-board")
    // The choice by its number; no text, since the message was not edited.
    expect(JSON.parse(sent[0].init.body)).toEqual({ key: "card:c1", action: "yes", choice: 2 })
    // The note names the item by its title, not its key.
    expect(w.el("wall-decide").innerHTML).toContain("“Send the newsletter?”: cx will be told yes")
    expect(w.el("wall-decide").innerHTML).not.toContain("card:c1:")
  })

  it("sends nothing on Back", async () => {
    const w = openWall({ hash: "#status=open&view=decide" })
    await w.settle()
    press(w, item("card:c1", "1"), "data-decide", "no")
    press(w, item("card:c1", "1"), "data-dback")
    await w.settle()
    expect(decideCalls(w)).toHaveLength(0)
    expect(w.el("wall-decide").innerHTML).not.toContain("wdc__confirm")
  })

  it("asks for a pick before a yes on a card with choices", async () => {
    const w = openWall({ hash: "#status=open&view=decide" })
    await w.settle()
    answer(w, "card:c1", "yes", null)
    expect(decideCalls(w)).toHaveLength(0)
    expect(w.el("wall-decide").innerHTML).not.toContain("wdc__confirm")
  })

  it("says only the owner can answer when the dashboard refuses", async () => {
    const w = openWall({ hash: "#status=open&view=decide", decide: { status: 401, body: { error: "unauthorized" } } })
    await w.settle()
    answer(w, "card:c1", "no", "1")
    await w.settle()
    expect(decideCalls(w)).toHaveLength(1)
    expect(w.el("wall-decide").innerHTML).toContain("Not answered: Only the owner can answer this.")
    expect(w.el("wall-decide").innerHTML).toContain("Send the newsletter?")
  })

  it("answers a request in place: a reply, hand it on, done or drop, under the Wall guard", async () => {
    const w = openWall({ hash: "#status=open&view=decide", approvals: { ...APPROVALS, items: [], desk: { count: 1, later: 0, items: [{ key: "request:r2", title: "Which logo?", ask: "The round one or the square one?", agent: "cx" }] } },
      requests: { items: [{ id: "r2", stall: { group: "owner", who: "owner", why: "1 day" } }], agents: [{ id: "cx", name: "cx" }, { id: "reviewer", name: "Reviewer" }] } })
    await w.settle()
    const html = w.el("wall-decide").innerHTML
    expect(html).toContain("Which logo?")
    expect(html).toContain('<span class="wdc__badge is-warn">Stalled on you</span>')
    expect(html).toContain('placeholder="Write a reply to Customer Desk"')
    expect(html).toMatch(/data-decide="reply"[^>]*>Send reply[\s\S]*<option value="reviewer">Reviewer<\/option>[\s\S]*data-decide="done"[\s\S]*data-decide="drop"/)
    const it = item("request:r2", null, null, false)
    w.fire("input", { target: { hasAttribute: (k: string) => k === "data-dreply", value: "The round one.", closest: () => it } })
    answer(w, "request:r2", "reply", null, null, false)
    await w.settle()
    const sent = w.calls.filter((c) => c.url === "/api/admin/wall/request/reply")
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0].init.body)).toEqual({ id: "r2", text: "The round one." })
    answer(w, "request:r2", "drop", null, null, false)
    await w.settle()
    expect(JSON.parse(w.calls.filter((c) => c.url === "/api/admin/wall/request/close")[0].init.body)).toEqual({ id: "r2", action: "drop" })
  })

  it("shows the empty state from the frame", async () => {
    const w = openWall({ hash: "#status=open&view=decide", approvals: { ...APPROVALS, items: [], desk: { count: 0, later: 0, items: [] },
      answered: [{ key: "card:x", kind: "card", title: "Old", raised_by: "cx", answer: "yes", by: "operator", at: new Date(NOW - 3600e3).toISOString() }] } })
    await w.settle()
    expect(w.el("wall-decide").innerHTML).toContain("<h2>Nothing needs you</h2><p>When an agent asks you something, it shows here. 1 answered this week.</p>")
    expect(w.el("nav-n-needs").textContent).toBe("0")
  })

  it("keeps put-off items on Put off, and lists what was answered", async () => {
    const snoozed = { ...APPROVALS.items[0], key: "card:c2", title: "Renew the domain?", snoozed_until: new Date(NOW + 864e5).toISOString() }
    const w = openWall({ hash: "#status=open&view=decide", approvals: { ...APPROVALS, items: [APPROVALS.items[0], snoozed], desk: { count: 1, later: 1, items: [] },
      answered: [{ key: "memory:cx/f1", kind: "memory", title: "Invoices go out on the 1st", raised_by: "cx", answer: "yes", by: "operator (dashboard)", at: new Date(NOW - 60e3).toISOString() }] } })
    await w.settle()
    expect(w.el("wall-decide").innerHTML).toContain("1 waiting for you, 1 put off for later")
    expect(w.el("wall-decide").innerHTML).not.toContain("Renew the domain?")
    w.click({ "data-dtab": "later" })
    await w.settle()
    expect(w.el("wall-decide").innerHTML).toContain("Renew the domain?")
    expect(w.el("wall-decide").innerHTML).not.toContain("Send the newsletter?")
    w.click({ "data-dtab": "answered" })
    await w.settle()
    expect(w.el("wall-decide").innerHTML).toContain("<b>Kept</b> · Customer Desk · <span dir=\"auto\">Invoices go out on the 1st</span>")
    // The side column: what waits, answered today, how it reaches you.
    const side = w.el("wall-dec-side").innerHTML
    expect(side).toContain("What waits on you")
    expect(side).toContain("<b>Kept</b> · Customer Desk · Invoices go out on the 1st")
    expect(side).toContain("Reaching you</h2><p>Phone: off. Computer: off. No daily digest.")
  })

  it("names what an answer unblocks: the post the card is on and the runs paused on it", async () => {
    const card = { id: "c1", title: "Send the newsletter?", ask: "", recommend: "Tuesday", expiresAt: NOW + 3600e3, silence: "", ifSilent: "keep", raisedBy: "cx", createdAt: NOW - 600e3, source: null, choices: [], draft: null }
    const data = { ...WALL, posts: [post("r9", "cx", "waiting_owner", { headline: "October newsletter", ownerCards: [card] })] }
    const runs = { runs: [{ id: "run1", status: "paused", homeNode: "mini", pausedAt: { kind: "ownerDecision", cardId: "c1" }, updatedAt: new Date(NOW).toISOString() }] }
    const w = openWall({ hash: "#status=open&view=decide", data, runs })
    await w.settle()
    const html = w.el("wall-decide").innerHTML
    expect(html).toContain("<h3>Answering unblocks</h3><p>The post <a href=")
    expect(html).toContain('data-open="r9">October newsletter</a> (waiting 10m) and 1 run on mini, paused until you answer.')
    expect(html).toContain('data-open="r9">Reply instead</a>')
    expect(w.el("wall-dec-side").innerHTML).toContain("<b>1 run</b> held on mini")
  })

  it("decides a classifier review from the Reviews chip, outside the count", async () => {
    const reviews = { reviews: [{ id: "m1", status: "pending", path: ["work", "billing"], message: "Invoice for March", proposedAt: new Date(NOW - 60e3).toISOString(), source: "classifier" }], counts: { pending: 1 } }
    const w = openWall({ hash: "#status=open&view=decide", reviews })
    await w.settle()
    expect(w.el("wall-decide").innerHTML).toContain("All <span class=\"n\">1</span>")
    expect(w.el("wall-decide").innerHTML).toContain("Reviews <span class=\"n\">1</span>")
    expect(w.el("nav-n-needs").textContent).toBe("1")
    w.click({ "data-dkind": "reviews" })
    await w.settle()
    expect(w.el("wall-decide").innerHTML).toContain("work › billing")
    answer(w, "review:m1", "approve", null, null, false)
    await w.settle()
    const sent = w.calls.filter((c) => c.url === "/api/admin/wall/review/approve")
    expect(JSON.parse(sent[0].init.body)).toEqual({ msgHash: "m1" })
  })

  it("keeps the total equal to the /approvals count, with reviews waiting", async () => {
    const second = { ...APPROVALS.items[0], key: "card:c2", title: "Renew the domain?" }
    const approvals = { ...APPROVALS, items: [APPROVALS.items[0], second], desk: { count: 2, later: 0, items: [] } }
    const reviews = { reviews: ["m1", "m2", "m3"].map((id) => ({ id, status: "pending", path: ["work"], message: "", proposedAt: new Date(NOW).toISOString(), source: "classifier" })), counts: { pending: 3 } }
    const w = openWall({ hash: "#status=open&view=decide", approvals, reviews })
    await w.settle()
    const html = w.el("wall-decide").innerHTML
    // The count the Desk, the digest and /approvals give: reviews are not in it.
    expect(html).toMatch(/data-dtab="waiting"[^>]*>Waiting <span class="n">2<\/span>/)
    expect(html).toContain("All <span class=\"n\">2</span>")
    expect(html).toContain("Reviews <span class=\"n\">3</span>")
    expect(w.el("nav-n-needs").textContent).toBe(String(approvals.desk.count))
  })

  it("says when the answered list started, and shows a card its agent closed", async () => {
    const since = "2026-10-28T09:00:00.000Z"
    const empty = openWall({ hash: "#status=open&view=decide", approvals: { ...APPROVALS, answered: [], answered_since: since } })
    await empty.settle()
    empty.click({ "data-dtab": "answered" })
    await empty.settle()
    expect(empty.el("wall-decide").innerHTML).toMatch(/<h2>Nothing answered yet<\/h2><p>History starts 2026-10-2[89]\. /)
    // Reviews and request replies skip decide(), so the page does not promise them.
    expect(empty.el("wall-decide").innerHTML).toContain("Your yes and no answers show here, from this page, the Desk, the phone app and the Mac card. Reviews and request replies are not listed.")
    const closed = { key: "card:c9", kind: "card", title: "Book the room?", raised_by: "cx", answer: "closed", text: "Owner said yes in chat", by: "cx", at: new Date(NOW - 60e3).toISOString() }
    const w = openWall({ hash: "#status=open&view=decide", approvals: { ...APPROVALS, answered: [closed], answered_since: since } })
    await w.settle()
    w.click({ "data-dtab": "answered" })
    await w.settle()
    expect(w.el("wall-decide").innerHTML).toContain('<b>Closed</b> · Customer Desk · <span dir="auto">Book the room?</span> · <span dir="auto" class="k">Owner said yes in chat</span>')
    // Answered today uses the same word, not "No".
    expect(w.el("wall-dec-side").innerHTML).toContain("<b>Closed</b> · Customer Desk · Book the room?")
  })

  it("words each answer the same on the Answered tab and in Answered today", async () => {
    const at = new Date(NOW - 60e3).toISOString()
    const line = (key: string, kind: string, title: string, answer: string) => ({ key, kind, title, raised_by: "cx", answer, by: "operator", at })
    const answered = [
      line("card:a", "card", "Send it?", "yes"), line("card:b", "card", "Pay it?", "no"),
      line("memory:cx/f1", "memory", "Keep this fact", "yes"), line("memory:cx/f2", "memory", "Drop this fact", "no"),
      line("card:c", "card", "Book it?", "closed"),
    ]
    const w = openWall({ hash: "#status=open&view=decide", approvals: { ...APPROVALS, answered } })
    await w.settle()
    w.click({ "data-dtab": "answered" })
    await w.settle()
    const tab = w.el("wall-decide").innerHTML, side = w.el("wall-dec-side").innerHTML
    for (const [verb, title] of [["Yes", "Send it?"], ["No", "Pay it?"], ["Kept", "Keep this fact"], ["Dropped", "Drop this fact"], ["Closed", "Book it?"]]) {
      expect(tab).toContain(`<b>${verb}</b> · Customer Desk · <span dir="auto">${title}</span>`)
      expect(side).toContain(`<b>${verb}</b> · Customer Desk · ${title}`)
    }
  })

  it("shows anyone else the same cards read only, as Needs the owner", async () => {
    const w = openWall({ hash: "#status=open&view=decide", approvals: { ...APPROVALS, owner: false } })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Needs the owner")
    const html = w.el("wall-decide").innerHTML
    expect(html).toContain("Only the owner can answer these. You see them read only.")
    expect(html).toContain("Send the newsletter?")
    expect(html).toContain("Advice: <span>Tuesday: the open rate is best</span>")
    expect(html).not.toContain("data-decide")
    expect(html).not.toContain("wdc__chips")
  })

  it("answers a card on its post, at the node that keeps the post", async () => {
    const card = { id: "c9", title: "Ship it?", ask: "Ship it?", recommend: "Yes", expiresAt: NOW + 3600e3, silence: "nothing is approved", ifSilent: "keep",
      raisedBy: "cx", createdAt: NOW - 600e3, source: null, choices: [], draft: null }
    const data = { ...WALL, posts: [post("r2", "cx", "waiting_owner", { node: { name: "node-b", peer: "https://node-b.example", daemonUrl: null }, ownerCards: [card] })] }
    const w = openWall({ hash: "#post=r2", data })
    await w.settle()
    const page = w.el("wall-post").innerHTML
    expect(page).toContain('data-dkey="card:c9" data-dpeer="https://node-b.example"')
    expect(page).not.toContain("Answer it on the Desk")
    answer(w, "card:c9", "yes", null, "https://node-b.example", false)
    await w.settle()
    const sent = decideCalls(w)
    expect(sent[0].init.headers["X-Agentx-Peer"]).toBe("https://node-b.example")
    expect(JSON.parse(sent[0].init.body)).toEqual({ key: "card:c9", action: "yes" })
    // The post updates without a reload: the card is gone from it.
    expect(w.el("wall-post").innerHTML).not.toContain('data-dkey="card:c9"')
  })
})

describe("The Org page on the Wall (#1419)", () => {
  // The reply /api/admin/org gives, built by the real view from a demo config.
  const ORG = { exists: true, ...buildOrgView({
    agents: { cx: { name: "Customer Desk" }, reviewer: { name: "Reviewer" }, scout: { name: "Scout" }, intern: { name: "Intern" } },
    people: [{ id: "sam", name: "Sam Demo", role: "owner" }, { id: "alex", name: "Alex Client", role: "client" }],
    business: {
      orgChart: { reviewer: { role: "Head of Quality", reportsTo: "person:sam" }, cx: { role: "Support Lead", reportsTo: "reviewer" }, intern: { role: "Helper", reportsTo: "cx" } },
      relations: [{ from: "cx", to: "person:sam", type: "dotted-line" }, { from: "cx", to: "person:alex", type: "acts-for" }],
    },
  }, {}, [{ id: "cx", active: 1 }, { id: "reviewer", active: 0 }]) }

  it("is a page in the Wall's nav, with the chart's member count", async () => {
    const page = renderWallPage()
    expect(page).toContain('data-nav="org" href="#page=org"')
    // The classic page stays one tap away under Dashboard pages.
    expect(page).toContain('<a href="/org">Org</a>')
    const w = openWall({ org: ORG })
    await w.settle()
    expect(w.el("nav-n-org").textContent).toBe("4")
    expect(w.el("wall-org").hidden).toBe(true)
  })

  it("draws a card per member with name, @handle, role and status; a person has a person chip and no status dot", async () => {
    const w = openWall({ org: ORG, hash: "#page=org" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Org")
    expect(w.el("wall-org").hidden).toBe(false)
    expect(w.wall.classList.contains("is-wide")).toBe(true)
    const html = w.el("wall-org").innerHTML
    const card = (key: string) => new RegExp(`<article class="wog__card[^"]*" data-org-key="${key}"[\\s\\S]*?</article>`).exec(html)?.[0] ?? ""
    // The phone shows this line (CSS); the chart itself stays read-only.
    expect(html).toContain('<p class="ax-wall__count wog__note wog__owner">Only the owner can change the org</p>')
    expect(card("person:sam")).toContain("is-person is-top")
    // The tools sit in a toolbar row above the legend (#1681), room for more.
    const bar = html.indexOf('<div class="wog__toolbar wog__tools" role="toolbar" aria-label="Org tools">')
    expect(bar).toBeGreaterThan(-1)
    expect(html.indexOf('<ul class="wog__legend"')).toBeGreaterThan(bar)
    // Person and agent differ on sight (#1681): a tag with an icon and the word.
    expect(card("person:sam")).toMatch(/<span class="wog__kind is-person"><svg[^]*?<\/svg>Person<\/span>/)
    expect(card("agent:cx")).toMatch(/<span class="wog__kind is-agent"><svg[^]*?<\/svg>Agent<\/span>/)
    expect(card("person:sam")).toContain("<small class=\"wog__title\">Owner</small>")
    expect(card("person:sam")).not.toContain("wog__dot")
    expect(card("person:sam")).not.toContain("data-agent")
    expect(card("agent:cx")).toContain('data-agent="cx"')
    expect(card("agent:cx")).toContain('<b>Customer Desk<span class="wog__dot is-working" title="Working"></span></b><small>@cx</small><small class="wog__title">Support Lead</small>')
    expect(card("agent:reviewer")).toContain("grid-row: 2")
    expect(card("agent:intern")).toContain("grid-row: 4")
    // acts-for is a chip, not a line; the dotted line waits for its toggle.
    expect(card("agent:cx")).toContain('<span class="wog__chip is-acts">acts for Alex Client</span>')
    expect(card("agent:cx")).toContain('is-dotted is-quiet">dotted line to Sam Demo</span>')
    expect(html).toContain('data-org-dotted aria-pressed="false"')
    // A legend, and the edit link for the owner.
    expect(html).toContain("Reports to</li>")
    expect(html).toContain('<a class="ax-btn ax-btn--ghost wog__edit" href="/org">Open the org chart</a>')
    // No raw member keys in what a reader sees.
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/(agent|person):/)
  })

  it("shows a department as a chip on its members, grouped side by side, with a legend key (#1681)", async () => {
    const org = { exists: true, ...buildOrgView({
      agents: { ann: { name: "Ann" }, bob: { name: "Bob" }, cid: { name: "Cid" } },
      people: [{ id: "sam", name: "Sam Demo", role: "owner" }, { id: "zed", name: "Zed" }],
      business: {
        orgChart: { ann: { reportsTo: "person:sam" }, bob: { reportsTo: "person:sam" }, cid: { reportsTo: "person:sam" } },
        relations: [{ from: "person:zed", to: "person:sam", type: "reports-to" }],
        departments: { dev: { name: "Dev", head: "person:sam", members: ["ann", "cid", "person:zed"] } },
      },
    }, {}, null) }
    const w = openWall({ org, hash: "#page=org" })
    await w.settle()
    // Departments open first (#1681); the chart is one tap away.
    w.click({ "data-org-view": "chart" })
    await w.settle()
    const html = w.el("wall-org").innerHTML
    const card = (key: string) => new RegExp(`<article class="wog__card[^"]*" data-org-key="${key}"[\\s\\S]*?</article>`).exec(html)?.[0] ?? ""
    expect(html).toContain('data-org-view="chart" aria-pressed="true"')
    expect(card("agent:ann")).toContain('<span class="wog__chip is-dept">Dev</span>')
    // Zed is in the department, as a person card.
    expect(card("person:zed")).toContain('<span class="wog__chip is-dept">Dev</span>')
    expect(card("agent:bob")).not.toContain("is-dept")
    expect(html).toContain('<span class="wog__key is-dept"></span>Department</li>')
    // Members first, side by side; Bob, outside the department, after them.
    const order = [...html.matchAll(/data-org-key="([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(["person:sam", "agent:ann", "agent:cid", "person:zed", "agent:bob"])
    // One run of cards side by side, so one band number on all three; Bob has none.
    expect(card("agent:ann")).toContain('data-org-band="0"')
    expect(card("person:zed")).toContain('data-org-band="0"')
    expect(card("agent:bob")).not.toContain("data-org-band")
  })

  it("opens on the Departments view: name, head card on top, member grid, then the rest (#1681)", async () => {
    const org = { exists: true, ...buildOrgView({
      agents: { ann: { name: "Ann" }, bob: { name: "Bob" }, cid: { name: "Cid" }, loose: { name: "Loose" } },
      people: [{ id: "sam", name: "Sam Demo", role: "owner" }, { id: "zed", name: "Zed" }],
      business: {
        orgChart: { ann: { reportsTo: "person:sam" }, bob: { reportsTo: "person:sam" }, cid: { reportsTo: "person:sam" } },
        relations: [{ from: "person:zed", to: "person:sam", type: "reports-to" }],
        departments: { dev: { name: "Dev", head: "person:sam", members: ["ann", "cid", "person:zed"] } },
      },
    }, {}, null) }
    const w = openWall({ org, hash: "#page=org" })
    await w.settle()
    const html = w.el("wall-org").innerHTML
    expect(html).toContain('data-org-view="dept" aria-pressed="true"')
    // No chart, no zoom: boxes only.
    expect(html).not.toContain('id="wog-chart"')
    expect(html).not.toContain("data-org-zoom")
    const box = /<section class="wod__box" data-org-dept="dev"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ""
    expect(box).toContain('<h3 class="wod__name">Dev <small>4</small></h3>')
    // The head is a full card on top, marked Head, before the member grid.
    const head = /<div class="wod__head">([\s\S]*?)<\/div><div class="wod__grid">/.exec(box)?.[1] ?? ""
    expect(head).toContain("is-person is-top is-lead")
    expect(head).toContain('<span class="wog__chip is-lead">Head</span>')
    expect(head).toContain("<b>Sam Demo</b>")
    const names = (part: string) => [...part.matchAll(/<b>([^<]+)/g)].map((m) => m[1])
    expect(names(box.slice(box.indexOf("wod__grid")))).toEqual(["Ann", "Cid", "Zed"])
    // Everyone else, outside-the-chart agents too, in "Not in a department".
    const rest = /<section class="wod__box is-rest"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ""
    expect(rest).toContain("Not in a department <small>2</small>")
    expect(names(rest)).toEqual(["Bob", "Loose"])
    // A card in the view has no grid place and no fold.
    expect(box).not.toContain("grid-row")
    expect(box).not.toContain("data-org-fold")
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/(agent|person):/)
  })

  it("keeps the chart and no view switch when there are no departments (#1681)", async () => {
    const w = openWall({ org: ORG, hash: "#page=org" })
    await w.settle()
    const html = w.el("wall-org").innerHTML
    expect(html).toContain('id="wog-chart"')
    expect(html).not.toContain("data-org-view")
    expect(html).not.toContain("wod__box")
  })

  it("shows dotted lines on request, and folds a branch", async () => {
    const w = openWall({ org: ORG, hash: "#page=org" })
    await w.settle()
    w.click({ "data-org-dotted": "" })
    await w.settle()
    expect(w.el("wall-org").innerHTML).toContain('data-org-dotted aria-pressed="true"')
    expect(w.el("wall-org").innerHTML).not.toContain("is-quiet")
    expect(w.el("wall-org").innerHTML).toContain('data-org-fold="agent:reviewer" aria-expanded="true">Hide 1 report')
    w.click({ "data-org-fold": "agent:reviewer" })
    await w.settle()
    const html = w.el("wall-org").innerHTML
    expect(html).toContain('aria-expanded="false">Show 2 under')
    expect(html).not.toContain('data-org-key="agent:cx"')
    expect(html).not.toContain('data-org-key="agent:intern"')
    w.click({ "data-org-fold": "agent:reviewer" })
    await w.settle()
    expect(w.el("wall-org").innerHTML).toContain('data-org-key="agent:intern"')
  })

  it("lists counts and the agents outside the chart in the side rail", async () => {
    const w = openWall({ org: ORG, hash: "#page=org" })
    await w.settle()
    expect(w.el("wall-org-rail").hidden).toBe(false)
    const rail = w.el("wall-org-rail-body").innerHTML
    expect(rail).toContain("<dt>People</dt><dd>1</dd>")
    expect(rail).toContain("<dt>Agents</dt><dd>3</dd>")
    expect(rail).toContain("<dt>Levels</dt><dd>4</dd>")
    expect(rail).toMatch(/Not in the org chart[\s\S]*data-agent="scout"/)
  })

  it("opens the agent's Wall profile, with its org line (#1424)", async () => {
    const w = openWall({ org: ORG, hash: "#page=org" })
    await w.settle()
    w.click({ "data-agent": "cx" })
    await w.settle()
    expect(w.el("wall-org").hidden).toBe(true)
    const prof = w.el("wall-profile").innerHTML
    expect(prof).toContain('<span>reports to <button type="button" data-agent="reviewer">Reviewer</button></span>')
    expect(prof).toContain("<span>1 reports to it</span>")
    expect(prof).toContain('<a href="#page=org">Org chart</a>')
    w.click({ "data-agent": "reviewer" })
    await w.settle()
    expect(w.el("wall-profile").innerHTML).toContain("<span>reports to Sam Demo</span>")
  })

  it("only reads: no write from the Org page", async () => {
    const w = openWall({ org: ORG, hash: "#page=org" })
    await w.settle()
    w.click({ "data-org-fold": "agent:reviewer" })
    w.click({ "data-org-zoom": "1" })
    await w.settle()
    expect(w.calls.filter((c) => c.init?.method && c.init.method !== "GET")).toEqual([])
    expect(w.el("wall-org").innerHTML).toContain(">110%<")
  })

  it("says so when the org cannot be read, and the rest of the Wall still works", async () => {
    const w = openWall({ org: "fail", hash: "#page=org" })
    await w.settle()
    expect(w.el("wall-org").innerHTML).toContain("Could not load the org chart: HTTP 500. The rest of the Hub still works.")
    expect(w.el("nav-n-org").textContent).toBe("")
    w.click({ "data-view": "feed" })
    await w.settle()
    expect(w.el("wall-org").hidden).toBe(true)
    expect(w.el("wall-feed").innerHTML).toContain("Post r1")
  })

  it("explains an empty chart and links to /org", async () => {
    const w = openWall({ org: { exists: true, ...buildOrgView({ agents: { cx: { name: "Customer Desk" } } }, {}, null) }, hash: "#page=org" })
    await w.settle()
    expect(w.el("wall-org").innerHTML).toContain("<h2>No org chart yet</h2>")
    expect(w.el("wall-org").innerHTML).toContain('href="/org">Open the org chart</a>')
  })

  // #1420, decision B: the org chart is edited on /org only; the Wall reads.
  it("has no org edit controls, even for the owner, and links to /org from the Agents and Org pages", async () => {
    const owner = { ...ORG, canEdit: true, setup: { members: [], relations: [] }, choices: { agents: [], people: [], roles: [], types: ["reports-to"] } }
    const pages: string[] = []
    for (const hash of ["#page=agents", "#page=org", "#page=orgsetup"]) {
      const w = openWall({ org: owner, hash })
      await w.settle()
      w.click({ "data-agent": "cx" })
      await w.settle()
      pages.push(w.el("wall-agents-page").innerHTML + w.el("wall-org").innerHTML + w.el("wall-profile").innerHTML)
      expect(w.calls.filter((c) => c.url.startsWith("/api/admin/org")).every((c) => (c.init?.method ?? "GET") === "GET")).toBe(true)
      expect(w.calls.some((c) => c.url === "/api/admin/org/chart")).toBe(false)
    }
    const all = pages.join("")
    expect(all).not.toMatch(/orgsetup|Set up the org|Edit org|data-os=|<select|<input/)
    expect(pages[0]).toContain('<a href="/org">Open the org chart</a>')
    expect(pages[1]).toContain('href="/org">Open the org chart</a>')
    expect(renderWallPage()).not.toContain("wall-orgsetup")
  })

  it("shows an agent on another node as a dashed card with its node, grey when down, not counted and not opened", async () => {
    const org = { exists: true, ...buildOrgView({
      agents: { ann: { name: "Ann" } },
      people: [{ id: "sam", name: "Sam Demo", role: "owner" }],
      mesh: { peers: [{ name: "far" }] },
      business: {
        orgChart: { ann: { reportsTo: "person:sam" } },
        relations: [{ from: "agent:far/seif", to: "person:sam", type: "reports-to" }, { from: "agent:far/omar", to: "person:sam", type: "reports-to" }],
      },
    }, {}, null, [{ peer: "far", healthy: false, skills: [{ id: "seif", name: "Seif" }, { id: "kai", name: "Kai" }] }]) }
    const w = openWall({ org, hash: "#page=org" })
    await w.settle()
    const html = w.el("wall-org").innerHTML
    const card = (key: string) => new RegExp(`<article class="wog__card[^"]*" data-org-key="${key}"[\\s\\S]*?</article>`).exec(html)?.[0] ?? ""
    expect(card("agent:far/seif")).toContain("is-remote is-gone")
    expect(card("agent:far/seif")).toContain(">down: far</span>")
    expect(card("agent:far/omar")).toContain(">not seen: far</span>")
    // Shown, not routed to: no profile button and no status dot.
    expect(card("agent:far/seif")).not.toContain("data-agent")
    expect(card("agent:far/seif")).not.toContain("wog__dot")
    // Counted apart from this node's staff; the unplaced one is listed by node.
    expect(html).toContain("<dt>Agents</dt><dd>1</dd>")
    expect(html).toContain("<dt>Other nodes</dt><dd>2</dd>")
    expect(html).toContain("On other nodes, not placed yet")
    expect(html).toContain("@kai on far")
    expect(html).toContain("On another node: shown, not routed to")
  })
})

describe("The workflow editor on the Wall (#1524)", () => {
  function fakeEditor() {
    const mounts: any[] = []
    let unmounted = 0
    return {
      mounts, unmounted: () => unmounted,
      api: { mount: (el: any, props: any) => { mounts.push({ el, props }); return { unmount: () => { unmounted++ } } } },
    }
  }

  it("opens a workflow in the editor, under Workflows in the nav, owner or not", async () => {
    const ed = fakeEditor()
    const w = openWall({ hash: "#page=editor&e-wf=deploy", editor: ed.api, editorCfg: { owner: true } })
    await w.settle()
    expect(w.el("wall-editor").hidden).toBe(false)
    expect(w.wall.classList.contains("is-editor")).toBe(true)
    expect(w.el("wall-title").textContent).toBe("Workflow editor")
    expect(w.el("wall-feed").hidden).toBe(true)
    expect(ed.mounts).toHaveLength(1)
    expect(ed.mounts[0].props).toMatchObject({ workflowId: "deploy", isNew: false, owner: true })
    // A refresh repaints the Wall, not the editor.
    w.hashchange()
    await w.settle()
    expect(ed.mounts).toHaveLength(1)
    const viewer = fakeEditor()
    const v = openWall({ hash: "#page=editor&e-wf=deploy", editor: viewer.api })
    await v.settle()
    expect(viewer.mounts[0].props.owner).toBe(false)
  })

  it("starts a new workflow, and names it in the link once saved", async () => {
    const ed = fakeEditor()
    const w = openWall({ hash: "#page=editor&e-new=1", editor: ed.api })
    await w.settle()
    expect(ed.mounts[0].props).toMatchObject({ isNew: true, workflowId: "new-workflow" })
    ed.mounts[0].props.onSaved("weekly-report")
    expect(w.loc.hash).toContain("page=editor")
    expect(w.loc.hash).toContain("e-wf=weekly-report")
    expect(w.loc.hash).not.toContain("e-new")
    w.hashchange()
    await w.settle()
    // Same workflow, same editor: saving did not reload it.
    expect(ed.mounts).toHaveLength(1)
  })

  it("asks before leaving with changes that are not saved, and stays when told to", async () => {
    const ed = fakeEditor()
    let asked = 0, answer = false
    const w = openWall({ hash: "#page=editor&e-wf=deploy", editor: ed.api, confirm: () => { asked++; return answer } })
    await w.settle()
    ed.mounts[0].props.onDirty(true)
    w.loc.hash = "#page=agents"
    w.hashchange()
    await w.settle()
    expect(asked).toBe(1)
    expect(w.loc.hash).toContain("page=editor")
    expect(ed.unmounted()).toBe(0)
    // The browser's hashchange for the hash put back: still the same editor.
    w.hashchange()
    await w.settle()
    expect(ed.mounts).toHaveLength(1)
    answer = true
    w.loc.hash = "#page=agents"
    w.hashchange()
    await w.settle()
    expect(ed.unmounted()).toBe(1)
    expect(w.el("wall-editor").hidden).toBe(true)
    expect(w.wall.classList.contains("is-editor")).toBe(false)
  })

  it("goes back to the workflow on the Workflows page, or to the list after a delete", async () => {
    const ed = fakeEditor()
    const w = openWall({ hash: "#page=editor&e-wf=deploy", editor: ed.api })
    await w.settle()
    ed.mounts[0].props.onBack()
    expect(w.loc.hash).toBe("#page=workflows&w-open=deploy")
    ed.mounts[0].props.onBack(true)
    expect(w.loc.hash).toBe("#page=workflows")
  })

  it("says what to do when no workflow is named", async () => {
    const w = openWall({ hash: "#page=editor", editor: fakeEditor().api })
    await w.settle()
    expect(w.el("wall-editor").innerHTML).toContain('href="#page=workflows"')
    expect(w.el("wall-editor").innerHTML).toContain('href="#page=editor&amp;e-new=1"')
  })
})

describe("The Workflows page on the Wall (#1445)", () => {
  const iso = (ago: number) => new Date(NOW - ago).toISOString()
  const step = (nodeId: string, status: string, extra: Record<string, unknown> = {}) => ({ at: iso(60e3), nodeId, status, inputKeys: [], idempotencyKey: nodeId, ...extra })
  const SUPPORT = { id: "support-reply", title: "New support ticket to reply draft", state: "active", project: "Support",
    nodes: [
      { id: "trigger", type: "trigger.channel", config: { source: "email" } },
      { id: "read_ticket", type: "agent", config: { agentId: "cx" } },
      { id: "write_reply", type: "agent", config: { agentId: "reviewer" } },
      { id: "send_to_needs_you", type: "owner.ask", config: {} },
    ], edges: [] }
  const HELP = { id: "help-page", title: "Publish a help page", state: "active", project: "Help centre", approval: "step",
    nodes: [
      { id: "trigger", type: "trigger.manual", config: { inputSchema: { properties: { title: { type: "string", title: "Page title" }, source: { type: "string", title: "Draft from", enum: ["Shipping notes", "Returns notes"] } }, required: ["title"] } } },
      { id: "draft", type: "agent", config: { agentId: "cx" } },
    ], edges: [] }
  const WEEKLY = { id: "weekly", title: "Weekly report", state: "active",
    nodes: [{ id: "trigger", type: "trigger.cron", config: { spec: "0 16 * * 5" } }, { id: "a", type: "agent", config: { agentId: "cx" } }, { id: "b", type: "agent", config: { agentId: "reviewer" } }], edges: [] }
  const OLD = { id: "old-onboarding", title: "Old onboarding checklist", state: "disabled",
    nodes: [{ id: "trigger", type: "trigger.manual", config: {} }], edges: [] }
  const WORKFLOWS = { workflows: [OLD, WEEKLY, HELP, SUPPORT] }
  const run = (id: string, workflowId: string, status: string, ago: number, history: unknown[] = []) =>
    ({ id, workflowId, status, homeNode: "node-a", entityRef: { backend: "channel", id }, history, pending: status === "running" ? ["b"] : [], createdAt: iso(ago + 100e3), updatedAt: iso(ago) })
  const FAILED_STEPS = [step("trigger", "ok"), step("read_ticket", "ok", { durationMs: 8000 }), step("write_reply", "failed", { note: "Reviewer was paused" })]
  const RUNS = { runs: [
    run("s1", "support-reply", "failed", 60e3, FAILED_STEPS),
    ...[2, 3, 4, 5, 6, 7].map((i) => run("s" + i, "support-reply", "completed", i * 3600e3)),
    run("w1", "weekly", "running", 30e3, [step("trigger", "ok"), step("a", "ok", { durationMs: 90e3 })]),
    run("h1", "help-page", "completed", 86400e3, [step("trigger", "ok"), step("draft", "ok")]),
    run("o1", "old-onboarding", "completed", 41 * 86400e3),
  ] }
  const S1 = { ...RUNS.runs[0], context: { trigger: { subject: "Where is my order" } } }

  it("opens from the nav: one row per workflow with what starts it, agents, project, last runs and state", async () => {
    const w = openWall({ hash: "#page=workflows", workflows: WORKFLOWS, wfRuns: RUNS })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Workflows")
    expect(w.el("nav-n-workflows").textContent).toBe("4")
    expect(w.el("wall-workflows").hidden).toBe(false)
    expect(w.el("wall-feed").hidden).toBe(true)
    expect(w.el("wall-wf-new").hidden).toBe(false)
    expect(w.calls.map((c) => c.url)).toContain("/api/workflows/runs?summary=1&limit=500")
    const html = w.el("wall-workflows").innerHTML
    expect(html).toContain("4 workflows, 3 on · ")
    // Failing first, the off one last.
    expect(html.indexOf("New support ticket")).toBeLessThan(html.indexOf("Weekly report"))
    expect(html.indexOf("Weekly report")).toBeLessThan(html.indexOf("Old onboarding"))
    expect(html).toMatch(/New support ticket to reply draft<\/button><span class="chip chip--err">Last run failed<\/span>[\s\S]*role="switch" aria-checked="true"/)
    expect(html).toMatch(/When a message arrives by email[\s\S]*Customer Desk, Reviewer[\s\S]*Support/)
    expect(html).toMatch(/stopped at &quot;Write reply&quot;: Reviewer was paused/)
    expect(html).toMatch(/aria-label="Last 7 runs: completed, completed, completed, completed, completed, completed, failed"/)
    expect(html).toMatch(/Fridays at 16:00[\s\S]*step 2 of 2/)
    expect(html).toContain("Started by hand")
    expect(html).toContain("no run for 41 days · looks stale")
    expect(html).toContain('data-wf-run="help-page"')
    expect(html).not.toContain('data-wf-run="old-onboarding"')
    expect(html).toContain("Only the owner can start, turn on or turn off a workflow.")
    // The side column: follow-ups and the "every task" setting.
    const side = w.el("wall-wf-side").innerHTML
    expect(side).toContain("<b>2</b> runs started for your requests")
    expect(side).toContain("Off. When on, each new task runs through a workflow.")
    expect(w.el("wall-aside").classList.contains("is-wf")).toBe(true)
  })

  it("filters by tab, text and project, kept in the link", async () => {
    const w = openWall({ hash: "#page=workflows", workflows: WORKFLOWS, wfRuns: RUNS })
    await w.settle()
    expect(w.el("wall-workflows").innerHTML).toMatch(/data-wf-tab="running"[^>]*>Running <b class="wac__n is-run">1<\/b>/)
    w.click({ "data-wf-tab": "failed" })
    await w.settle()
    let html = w.el("wall-workflows").innerHTML
    expect(html).toContain("New support ticket")
    expect(html).not.toContain("Weekly report")
    expect(w.loc.hash).toContain("w-tab=failed")
    w.click({ "data-wf-tab": "off" })
    await w.settle()
    expect(w.el("wall-workflows").innerHTML).toContain("Old onboarding")
    w.click({ "data-wf-tab": "" })
    w.field("input", { id: "wf-q", value: "weekly" })
    await w.settle()
    html = w.el("wall-workflows").innerHTML
    expect(html).toContain("Weekly report")
    expect(html).not.toContain("Publish a help page")
    w.field("input", { id: "wf-q", value: "" })
    w.change("wf-project", "Help centre")
    await w.settle()
    expect(w.loc.hash).toContain("w-project=Help+centre")
    html = w.el("wall-workflows").innerHTML
    expect(html).toContain("Publish a help page")
    expect(html).not.toContain("Weekly report")
  })

  it("opens a workflow: its last run step by step, where it stopped, Run again, the editor and all runs", async () => {
    const w = openWall({ hash: "#page=workflows", workflows: WORKFLOWS, wfRuns: RUNS, wfRun: { s1: S1 } })
    await w.settle()
    w.click({ "data-wf-open": "support-reply" })
    await w.settle()
    expect(w.loc.hash).toContain("w-open=support-reply")
    expect(w.calls.map((c) => c.url)).toContain("/api/workflows/runs/s1")
    const html = w.el("wall-workflows").innerHTML
    expect(html).toMatch(/<b>Run at \d\d:\d\d<\/b> <span class="chip chip--err">Failed<\/span> <small>took 1 min 40 s · started when a message arrives by email · on node-a/)
    expect(html).toMatch(/class="is-ok">[\s\S]*<b>Read ticket<\/b><small>Customer Desk · 8 s<\/small>/)
    expect(html).toMatch(/class="is-err">[\s\S]*<b>Write reply<\/b><small>Reviewer · stopped: Reviewer was paused<\/small>/)
    expect(html).toMatch(/class="is-todo">[\s\S]*<b>Send to needs you<\/b><small>not reached<\/small>/)
    expect(html).toContain('data-wf-again="support-reply"')
    // The editor is a Wall page (#1524): same tab, no new window.
    expect(html).toContain('href="#page=editor&amp;e-wf=support-reply">Open in the editor</a>')
    expect(html).toContain('href="/workflows#support-reply">All 7 runs</a>')
  })

  it("Run… asks for the inputs, says what will happen, then starts the run with the owner's token", async () => {
    const sent: Array<{ method: string; url: string; body: any }> = []
    const w = openWall({ hash: "#page=workflows", workflows: WORKFLOWS, wfRuns: RUNS, wfWrite: (method, url, body) => { sent.push({ method, url, body }); return { status: 200, body: { ok: true, runId: "run-123456789" } } } })
    await w.settle()
    w.click({ "data-wf-run": "help-page" })
    const dlg = w.el("wall-wf-dialog")
    expect(dlg.hidden).toBe(false)
    expect(dlg.innerHTML).toContain('Run "Publish a help page"?')
    expect(dlg.innerHTML).toMatch(/<label for="wfr-title">Page title <span aria-hidden="true">\*<\/span><\/label><input id="wfr-title" type="text"/)
    expect(dlg.innerHTML).toMatch(/<select id="wfr-source" data-wfr-key="source"><option value=""><\/option><option>Shipping notes<\/option>/)
    expect(dlg.innerHTML).toContain("<summary>Inputs as JSON</summary>")
    expect(dlg.innerHTML).toContain("Customer Desk does the steps. A message to a person waits for your yes in Needs you.")
    // A required input left empty is asked for; nothing is sent.
    w.click({ "data-wf-start": "" })
    expect(dlg.innerHTML).toContain("Fill in Page title.")
    expect(sent).toEqual([])
    // The other input alone is not enough.
    w.field("change", { id: "wfr-source", value: "Returns notes" }, { "data-wfr-key": "source" })
    w.click({ "data-wf-start": "" })
    expect(dlg.innerHTML).toContain("Fill in Page title.")
    expect(sent).toEqual([])
    w.field("input", { id: "wfr-title", value: "Returns and refunds" }, { "data-wfr-key": "title" })
    w.field("change", { id: "wfr-source", value: "Returns notes" }, { "data-wfr-key": "source" })
    w.click({ "data-wf-start": "" })
    await w.settle()
    expect(dlg.hidden).toBe(true)
    expect(sent).toEqual([{ method: "POST", url: "/workflows/help-page/run", body: { payload: { title: "Returns and refunds", source: "Returns notes" }, force: false } }])
    const call = w.calls.find((c) => c.url === "/workflows/help-page/run")!
    expect(call.init.headers["X-Requested-With"]).toBe("agentx-board")
    expect(w.el("wall-workflows").innerHTML).toContain("Started &quot;Publish a help page&quot;, run run-1234.")
    expect(w.loc.hash).toContain("w-open=help-page")
  })

  it("Run again sends the last run's input, standing in for what normally starts it", async () => {
    const sent: any[] = []
    const w = openWall({ hash: "#page=workflows&w-open=support-reply", workflows: WORKFLOWS, wfRuns: RUNS, wfRun: { s1: S1 }, wfWrite: (_m, url, body) => { sent.push({ url, body }); return { status: 200, body: { ok: true } } } })
    await w.settle()
    w.click({ "data-wf-again": "support-reply" })
    await w.settle()
    expect(sent).toEqual([{ url: "/workflows/support-reply/run", body: { payload: { subject: "Where is my order" }, force: true } }])
  })

  it("the switch turns a workflow off by saving it with its state flipped, and says what that does", async () => {
    const sent: any[] = []
    const w = openWall({ hash: "#page=workflows", workflows: WORKFLOWS, wfRuns: RUNS, wfWrite: (method, url, body) => { sent.push({ method, url, body }); return { status: 200, body: { workflow: body } } } })
    await w.settle()
    w.click({ "data-wf-toggle": "weekly" })
    await w.settle()
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe("PUT")
    expect(sent[0].url).toBe("/api/workflows/weekly")
    expect(sent[0].body).toMatchObject({ id: "weekly", state: "disabled", nodes: WEEKLY.nodes })
    const html = w.el("wall-workflows").innerHTML
    expect(html).toContain("&quot;Weekly report&quot; is off. It takes no new runs; runs under way go on.")
    expect(html).toMatch(/Weekly report<\/button><span class="chip chip--ghost wwf__offchip">Off<\/span>[\s\S]*role="switch" aria-checked="false"/)
  })

  it("says so when a write is refused, and when the list cannot be read; the rest of the Wall goes on", async () => {
    const w = openWall({ hash: "#page=workflows", workflows: WORKFLOWS, wfRuns: RUNS, wfWrite: () => ({ status: 401, body: { error: "unauthorized" } }) })
    await w.settle()
    w.click({ "data-wf-toggle": "weekly" })
    await w.settle()
    expect(w.el("wall-workflows").innerHTML).toContain("Could not turn &quot;Weekly report&quot; off: Only the owner can start, turn on or turn off a workflow.")
    const bad = openWall({ hash: "#page=workflows", workflows: "fail" })
    await bad.settle()
    expect(bad.el("wall-workflows").innerHTML).toContain("Could not read the workflows: HTTP 503")
    bad.click({ "data-view": "feed" })
    await bad.settle()
    expect(bad.el("wall-workflows").hidden).toBe(true)
    expect(bad.el("wall-feed").innerHTML).toContain("Post r1")
  })

  it("shows how to start when there is no workflow, and Failures links here", async () => {
    const w = openWall({ hash: "#page=workflows" })
    await w.settle()
    expect(w.el("wall-workflows").innerHTML).toContain("No workflows yet")
    expect(w.el("wall-workflows").innerHTML).toContain('href="#page=editor&amp;e-new=1">New workflow</a>')
    const f = openWall({ hash: "#status=open&view=failures", wfRuns: RUNS })
    await f.settle()
    expect(f.el("wall-failures").innerHTML).toContain('href="#page=workflows&amp;w-open=support-reply"')
  })
})

describe("The People page on the Wall (#1441)", () => {
  const PEOPLE = { paired: 2, people: [
    { id: "owner", name: "Owner of this machine", role: "owner", identities: [], agents: [], builtIn: true, machines: { active: 0, pending: 0 } },
    { id: "sara", name: "Sara B", role: "member", identities: ["gitlab:sara.b"], agents: ["cx"], machines: { active: 1, pending: 1 } },
  ] }
  const SARA = {
    person: PEOPLE.people[1], database: true,
    devices: [
      { tokenId: "tok_laptop", personId: "sara", name: "Sara laptop", state: "active", address: "100.64.0.7", network: "sara@", createdAt: "2026-10-01T09:00:00.000Z", lastSeenAt: "2026-10-26T09:00:00.000Z" },
      { tokenId: "tok_phone", personId: "sara", name: "Sara phone", state: "pending", createdAt: "2026-10-26T10:00:00.000Z" },
    ],
    requests: [
      { id: "r9", state: "in_progress", channel: "gitlab", agentId: "cx", text: "[agentx:same-home] Fix the  checkout", createdAt: NOW - 3600e3 },
      { id: "r8", state: "done", channel: "gitlab", agentId: "cx", text: "Old ask", createdAt: NOW - 86400e3 },
    ],
    runs: [{ taskId: "T1", agentId: "cx", channel: "gitlab", status: "ok", startedAt: NOW - 3600e3, messagePreview: "Fix the checkout" }],
  }
  const DATA = { ...WALL, posts: [...WALL.posts, post("r9", "cx", "in_progress", { askedBy: "sara" }), post("r8", "cx", "done", { askedBy: "sara" })] }

  it("opens from the nav with everyone listed, their role, identities and open requests on the Wall", async () => {
    const w = openWall({ hash: "#page=people", data: DATA, people: PEOPLE })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("People")
    expect(w.el("nav-n-people").textContent).toBe("2")
    expect(w.el("wall-people").hidden).toBe(false)
    expect(w.el("wall-feed").hidden).toBe(true)
    const html = w.el("wall-people").innerHTML
    expect(html).toContain("Owner of this machine")
    expect(html).toMatch(/Sara B[\s\S]*Member[\s\S]*gitlab:sara\.b[\s\S]*Customer Desk/)
    expect(html).toContain("<b>1</b> waiting for approval")
    expect(html).toContain('<a href="#status=open&asker=sara"><b>1</b> open request on the Hub</a>')
    expect(html).not.toContain("Nobody has paired")
  })

  it("opens a person: machines, open requests linked to their posts, earlier ones folded, turns to the Task page", async () => {
    const w = openWall({ hash: "#page=people", data: DATA, people: PEOPLE, person: { sara: SARA } })
    await w.settle()
    w.click({ "data-pp-open": "sara" })
    await w.settle()
    expect(w.calls.map((c) => c.url)).toContain("/api/admin/people/sara")
    const html = w.el("wall-people").innerHTML
    expect(html).toMatch(/Sara laptop[\s\S]*Active[\s\S]*End access[\s\S]*100\.64\.0\.7[\s\S]*as sara@/)
    expect(html).toMatch(/Sara phone[\s\S]*Waiting for your approval/)
    expect(html).toContain('<a href="#post=r9" class="wpp__text">Fix the checkout</a>')
    expect(html).toContain("1 earlier request")
    expect(html).toMatch(/href="#page=task&amp;task=T1&amp;agent=cx[^"]*"/)
    // No raw markers or machine ids in the text.
    expect(html).not.toContain("[agentx:")
    expect(html.replace(/data-pp-end="[^"]*"/g, "")).not.toContain("tok_laptop")
  })

  it("ends one machine through the people API, then reads the list again", async () => {
    const w = openWall({ hash: "#page=people", data: DATA, people: PEOPLE, person: { sara: SARA } })
    await w.settle()
    w.click({ "data-pp-open": "sara" })
    await w.settle()
    const before = w.calls.filter((c) => c.url === "/api/admin/people").length
    w.click({ "data-pp-end": "tok_laptop", "data-pp-person": "sara", "data-pp-name": "Sara laptop" })
    await w.settle()
    const end = w.calls.find((c) => c.url === "/api/admin/people/sara/devices/tok_laptop/end")!
    expect(end.init.method).toBe("POST")
    expect(end.init.headers["X-Requested-With"]).toBe("agentx-board")
    expect(w.calls.filter((c) => c.url === "/api/admin/people").length).toBe(before + 1)
    expect(w.el("wall-people").innerHTML).toContain("Access ended for &quot;Sara laptop&quot;.")
  })

  it("a person's link shows only what they asked, with a way back to everyone", async () => {
    const w = openWall({ hash: "#status=open&asker=sara", data: DATA, people: PEOPLE })
    await w.settle()
    expect(w.el("f-asker").value).toBe("sara")
    const feed = w.el("wall-feed").innerHTML
    expect(feed).toContain("Post r9")
    expect(feed).not.toContain("Post r1")
    expect(w.el("wall-count").innerHTML).toContain("asked by Sara B")
    w.click({ "data-asker-clear": "" })
    await w.settle()
    expect(w.el("wall-feed").innerHTML).toContain("Post r1")
  })

  it("shows how to invite someone when nobody is paired, and says so when the list cannot be read", async () => {
    const none = openWall({ hash: "#page=people", people: { paired: 0, people: [PEOPLE.people[0]] } })
    await none.settle()
    expect(none.el("wall-people").innerHTML).toContain("Nobody has paired a machine yet")
    expect(none.el("wall-people").innerHTML).toContain("agentx people invite sara")
    const bad = openWall({ hash: "#page=people", people: "fail" })
    await bad.settle()
    expect(bad.el("wall-people").innerHTML).toContain("Could not read the people list: HTTP 401")
    bad.click({ "data-view": "feed" })
    await bad.settle()
    expect(bad.el("wall-people").hidden).toBe(true)
    expect(bad.el("wall-feed").innerHTML).toContain("Post r1")
  })
})

describe("The Cost page does all /admin/cost did (#1423, #1449)", () => {
  const today = new Date().toISOString().slice(0, 10)
  const cost = (agent: string, usd: number) => ({ generatedAt: new Date().toISOString(), kpis: { spendToday: usd, spend7d: usd, spendDeltaWoW: 0 },
    days: [{ date: today, cost: usd, tasks: 1, input: 10, output: 1, cacheRead: 0, cacheCreate: 0, unpriced: 0, agents: { [agent]: { cost: usd, tasks: 1, unpriced: 0 } } }] })
  const BUDGETS = { month: "2026-10", fleet: { spentUsd: 4, capUsd: 50, state: "ok" }, agents: [{ agentId: "cx", spentUsd: 3, capUsd: 10, state: "ok" }], agentIds: ["cx", "reviewer"] }
  const PEER_BUDGETS = { month: "2026-10", fleet: { spentUsd: 6, capUsd: 50, state: "ok" }, agents: [], agentIds: ["builder"] }
  // node-b is read through the peer proxy; node-c is in the mesh but this dashboard has no address for it.
  const DATA = { ...WALL, nodes: [{ name: "node-a", peer: null, ok: true }, { name: "node-b", peer: "http://node-b", ok: true }] }
  const LIVE3 = { nodes: [...LIVE.nodes, { name: "node-b", url: "http://node-b", reachable: true, agents: [] }, { name: "node-c", url: "http://node-c", reachable: true, agents: [] }] }
  const open = (extra: Record<string, unknown> = {}) => openWall({ hash: "#status=open&view=cost", data: DATA, live: LIVE3, cost: cost("cx", 4), budgets: BUDGETS,
    peerCost: (peer, url) => (peer !== "http://node-b" ? null : url === "/api/admin/observability/budgets" ? PEER_BUDGETS : cost("builder", 6)), ...extra })

  it("adds up every machine the feed reads, and asks none the dashboard cannot reach", async () => {
    const w = open()
    await w.settle()
    const html = w.el("wall-cost").innerHTML
    expect(html).toContain("$10.00 over 30 days · 2 runs · $5.00 per run · 2 machines")
    expect(html).toContain("Not read: node-c (this dashboard has no address for it). Its spend is not in these numbers.")
    expect(w.el("wall-cost-n").textContent).toBe("$10.00")
    expect(w.calls.some((c) => c.init?.headers?.["X-Agentx-Peer"] === "http://node-c")).toBe(false)
    expect(w.calls.filter((c) => c.init?.headers?.["X-Agentx-Peer"] === "http://node-b").map((c) => c.url)).toEqual(
      expect.arrayContaining(["/api/admin/observability/cost?range=60", "/api/admin/observability/budgets"]))
  })

  it("keeps the range in the link, All included", async () => {
    const w = open({ hash: "#status=open&view=cost&range=14" })
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toMatch(/data-crange="14" class="is-on"/)
    expect(w.calls.map((c) => c.url)).toContain("/api/admin/observability/cost?range=30")
    w.click({ "data-crange": "0" })
    await w.settle()
    expect(w.loc.hash).toContain("range=all")
    expect(w.calls.map((c) => c.url)).toContain("/api/admin/observability/cost?range=all")
    expect(w.el("wall-cost").innerHTML).toContain("over every day kept")
  })

  it("opens the details and filters the days", async () => {
    const w = open()
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toContain('<div id="wc-details" hidden>')
    w.click({ "data-cdetails": "" })
    expect(w.el("wall-cost").innerHTML).toContain('<div id="wc-details">')
    w.click({ "data-cfilter": "over10" })
    expect(w.el("wall-cost").innerHTML).toContain('data-cfilter="over10" aria-pressed="true"')
    expect(w.el("wall-cost").innerHTML).toContain("No days match this filter.")
  })

  it("lets the owner set a budget on the machine picked, and says when it is refused", async () => {
    const sent: Array<{ body: any; peer: string | null }> = []
    let status = 200
    const w = open({ budgetPost: (body: any, peer: string | null) => { sent.push({ body, peer }); return status === 200 ? { status, body: { ok: true } } : { status, body: { error: "unauthorized" } } } })
    await w.settle()
    const html = w.el("wall-cost").innerHTML
    expect(html).toContain("Monthly budgets")
    expect(html).toContain('<form class="wc__form" data-cform')
    expect(html).toContain('<option value="node-b">node-b</option>')
    w.change("cb-scope", "agent:reviewer")
    w.el("cb-usd").value = "25"
    w.submit({ "data-cform": "" })
    await w.settle()
    expect(sent).toEqual([{ body: { scope: "agent", id: "reviewer", monthlyUsd: 25 }, peer: null }])
    expect(w.el("wall-cost").innerHTML).toContain("Saved. It applies now")
    // Another machine: the change goes to it, through the peer proxy.
    w.change("cb-machine", "node-b")
    w.el("cb-usd").value = ""
    w.submit({ "data-cform": "" })
    await w.settle()
    expect(sent[1]).toEqual({ body: { scope: "fleet", monthlyUsd: null }, peer: "http://node-b" })
    expect(w.el("wall-cost").innerHTML).toContain("Saved: no cap.")
    status = 401
    w.el("cb-usd").value = "5"
    w.submit({ "data-cform": "" })
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toContain("Not saved: only the owner can change a budget")
  })

  it("an agent row's Set a cap picks that agent in the form, on the machine that runs it", async () => {
    const sent: Array<{ body: any; peer: string | null }> = []
    const w = open({ budgetPost: (body: any, peer: string | null) => { sent.push({ body, peer }); return { status: 200, body: { ok: true } } } })
    await w.settle()
    const html = w.el("wall-cost").innerHTML
    expect(html).toContain('data-ccap="cx" title="Set the monthly cap of Customer Desk">Change cap</button>')
    expect(html).toContain('data-ccap="builder" title="Set the monthly cap of builder">Set a cap</button>')
    w.click({ "data-ccap": "builder" })
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toContain('<option value="node-b" selected>node-b</option>')
    expect(w.el("wall-cost").innerHTML).toContain('<option value="agent:builder" selected>Agent @builder</option>')
    w.el("cb-usd").value = "7"
    w.submit({ "data-cform": "" })
    await w.settle()
    expect(sent).toEqual([{ body: { scope: "agent", id: "builder", monthlyUsd: 7 }, peer: "http://node-b" }])
    // Back to an agent on this machine.
    w.click({ "data-ccap": "cx" })
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toContain('<option value="node-a" selected>node-a</option>')
    expect(w.el("wall-cost").innerHTML).toContain('<option value="agent:cx" selected>Agent @cx</option>')
    expect(w.el("cb-usd").value).toBe("10")
  })
})
