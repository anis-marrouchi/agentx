import { describe, expect, it } from "vitest"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"

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

function openWall(opts: { data?: unknown; hash?: string; throughput?: unknown } = {}) {
  const page = renderWallPage()
  const script = WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c) } }
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(page)
      if (!tag) throw new Error(`no element #${id} on the page`)
      const attrs: Record<string, string> = {}
      els.set(id, {
        id, hidden: /\shidden[\s>]/.test(tag[0]), innerHTML: "", textContent: "", value: id === "f-status" ? "open" : "", checked: false,
        type: /type="checkbox"/.test(tag[0]) ? "checkbox" : /type="search"/.test(tag[0]) ? "search" : "select",
        classList: classes(), parentNode: { classList: classes() },
        addEventListener: () => {}, setAttribute: (k: string, v: string) => { attrs[k] = v },
      })
    }
    return els.get(id)
  }
  const wall = { classList: classes() }
  let onClick: (ev: any) => void = () => {}
  const doc = {
    getElementById: el, hidden: false,
    querySelector: (sel: string) => (sel === ".ax-wall" ? wall : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { if (t === "click") onClick = f },
  }
  const loc = { hash: opts.hash ?? "", search: "" }
  const calls: Array<{ url: string; init: any }> = []
  const fetchStub = (url: string, init: any) => {
    calls.push({ url, init })
    const body = url.startsWith("/api/admin/wall?") ? (opts.data ?? WALL) : url === "/api/live" ? LIVE
      : url.startsWith("/api/admin/wall/throughput?") ? (opts.throughput ?? {}) : { runs: [] }
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", script)(
    doc, { addEventListener: () => {} }, fetchStub, loc,
    { replaceState: (_: unknown, __: string, h: string) => { loc.hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0,
  )
  /** A click on an element carrying these attributes. */
  const click = (attrs: Record<string, string>) => onClick({
    preventDefault: () => {},
    target: { closest: () => ({ hasAttribute: (k: string) => k in attrs, getAttribute: (k: string) => attrs[k] }) },
  })
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  return { el, wall, calls, click, settle, loc }
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

  it("puts thread, runs, minutes and links in an action row", async () => {
    const w = openWall()
    await w.settle()
    const row = /<div class="wp__acts">(.*?)<\/div>/.exec(w.el("wall-feed").innerHTML)![1]
    expect(row).toContain('data-thread="r1"')
    expect(row).toContain("1 run</span>")
    expect(row).toContain("2 min</span>")
    expect(row).toContain('href="https://example.com/demo/shop/issues/47"')
    expect(row).toContain("Task record and trace</a>")
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

  it("only reads: every request is a plain GET", async () => {
    const w = openWall()
    await w.settle()
    w.click({ "data-agent": "cx" })
    expect(w.calls.length).toBeGreaterThan(0)
    for (const c of w.calls) expect(c.init?.method ?? "GET").toBe("GET")
  })
})

// #1188: the QA verdict line and the "Awaiting QA only" filter, run through
// the page's real match() rather than read from the source.
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
  const qaLine = (feed: string, id: string) => /<div class="wp__qa">(.*?)<\/div>/.exec(feed.split(`id="post-${id}"`)[1]?.split('id="post-')[0] ?? "")?.[1]

  it("shows a risk verdict with who gave it, when and its escaped note", async () => {
    const w = openWall({ data: QA })
    await w.settle()
    const line = qaLine(w.el("wall-feed").innerHTML, "q1")!
    expect(line).toMatch(/^QA: RISK by qa-check, .+: slow on &lt;mobile&gt;$/)
    expect(line).not.toContain("new verdict asked")
  })

  it("marks a block asked again, a pass, and no line without QA", async () => {
    const w = openWall({ data: QA })
    await w.settle()
    const feed = w.el("wall-feed").innerHTML
    expect(qaLine(feed, "q2")).toBe("QA: Awaiting QA sign-off")
    expect(qaLine(feed, "q3")).toMatch(/^QA: BLOCK by qa-check, .+: login fails — new verdict asked$/)
    expect(qaLine(feed, "q4")).toMatch(/^QA: PASS by qa-check, [^<]+ UTC[+-]\d\d:\d\d$/)
    expect(qaLine(feed, "q5")).toBeUndefined()
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
    const rows = html.split("<tr>").slice(2)
    expect(rows[0]).toContain("<td>Web</td>")
    expect(rows[0]).toContain('href="#status=stalled&amp;project=Web&amp;view=list">1</a>')
    expect(rows[0]).toContain('href="#status=open&amp;project=Web&amp;view=list">2</a>')
    expect(rows[1]).toContain("<td>Docs</td><td class=\"num\">0</td>")
    expect(rows[2]).toContain("<i>Other</i>")
    expect(rows[2]).toContain('href="#status=in_progress&amp;project=-&amp;view=list">1</a>')
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
