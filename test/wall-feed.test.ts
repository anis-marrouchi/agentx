import { describe, expect, it } from "vitest"
import { renderWallPage, WALL_CLASSIC_LINKS } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"
import { wallCapacity } from "../src/daemon/wall-capacity"

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

function openWall(opts: { data?: unknown; hash?: string; throughput?: unknown; feed?: Promise<unknown>; live?: unknown; post?: Promise<unknown>; thread?: unknown; org?: unknown } = {}) {
  const page = renderWallPage()
  // As on the page: the value line helpers load before the Wall script.
  const script = CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c) } }
  const el = (id: string) => {
    if (!els.has(id)) {
      // The open post's action box (wdo-*) is drawn by the script itself.
      const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(page) ?? (id.startsWith("wdo-") ? [`<x id="${id}">`] : null)
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
    if (opts.post && url === "/api/admin/wall/post") return opts.post
    if (url === "/api/admin/org" && opts.org === "fail") return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
    const body = url.startsWith("/api/admin/wall?") ? (opts.data ?? WALL) : url === "/api/live" ? (opts.live ?? LIVE)
      : url === "/api/admin/org" ? (opts.org ?? { exists: false })
      : url.startsWith("/api/admin/wall/throughput?") ? (opts.throughput ?? {})
      : opts.thread && url.startsWith("/api/admin/wall/thread?") ? opts.thread : { runs: [] }
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", script)(
    doc, { addEventListener: (t: string, f: () => void) => { onWindow[t] = f } }, fetchStub, loc,
    { replaceState: (_: unknown, __: string, h: string) => { loc.hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0,
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
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  /** The browser's hashchange, as after `location.hash = …`. */
  const hashchange = () => onWindow.hashchange?.()
  return { el, wall, calls, click, change, settle, loc, hashchange }
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
    expect(w.el("wall-title").textContent).toBe("Wall")
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
    expect(w.calls.map((c) => c.url)).toContain("/api/live")
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
    expect(w.el("wall-feed").innerHTML).toContain("Could not load the Wall")
    expect(w.el("wall-nodes").innerHTML).toContain("Customer Desk: x")
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
    expect(JSON.parse(posts[0].init.body).text).toMatch(/^The owner mentioned you in a comment on Wall post r1 by @cx/)
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
    expect(prof).toContain('<a href="/org">Org chart</a>')
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
