import { describe, expect, it } from "vitest"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"

// #1429: the Wall's Activity page lists the agents' runs, newest first,
// from the endpoints the classic /activity Timeline reads. These run the
// page's real script against a stubbed DOM and fetch.

const NOW = Date.now()
const H = 3600e3
const NODES = { nodes: [
  { name: "node-a", url: "http://node-a", ok: true },
  { name: "node-b", url: "http://node-b", ok: true },
  { name: "node-c", url: "http://node-c", ok: false, error: "timeout" },
] }
const RUNS: Record<string, unknown[]> = {
  "http://node-a": [
    { id: "t1", agentId: "cx", channel: "telegram", chatId: "demo", status: "ok", startedAt: NOW - 3 * H, durationMs: 95e3, preview: "Answer the refund question\nfor order 47", costUsd: 0.1234 },
    { id: "t2", agentId: "cx", channel: "gitlab", chatId: "shop:42", project: "shop", status: "error", startedAt: NOW - 1 * H, durationMs: 30e3, preview: "Fix the checkout test", costUsd: 0.5 },
  ],
  "http://node-b": [
    { id: "t3", agentId: "ops", channel: "cron", chatId: "cron:digest", status: "ok", startedAt: NOW - 2 * H, durationMs: 4 * 60e3, preview: "Morning digest" },
    { id: "t4", agentId: "ops", channel: "github", chatId: "site:7", project: "site", status: "in-flight", startedAt: NOW - 60e3, durationMs: null, preview: "Update the pricing page", costUsd: null },
  ],
}
const POST = { id: "r1", owner: "cx", state: "in_progress", headline: "Refund order 47", group: { channel: "telegram", chatId: "demo" }, project: "support",
  node: { name: "node-a", peer: null }, createdAt: NOW - 5 * H, lastMoveAt: NOW - H, runs: 1, failedRuns: 0, runMs: 95e3, lastRun: { taskId: "t1", agentId: "cx" } }

function openWall(opts: { hash: string; runs?: Record<string, unknown[]>; posts?: unknown[]; build?: unknown; monitorFails?: boolean; monitorHangs?: boolean }) {
  const page = renderWallPage()
  const script = CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c), add: (c: string) => s.add(c), remove: (c: string) => s.delete(c) } }
  const attrsOf = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"')]))
  const make = (id: string, tag: string) => {
    const on: Record<string, (ev?: unknown) => void> = {}
    let html = ""
    const e: any = {
      on, id, attrs: attrsOf(tag), hidden: /\shidden[\s>]/.test(tag), textContent: "", value: id === "f-status" ? "open" : "", checked: false,
      type: /type="checkbox"/.test(tag) ? "checkbox" : "select", style: {}, disabled: false, children: [] as any[],
      classList: classes(), parentNode: { classList: classes() },
      get innerHTML() { return html },
      set innerHTML(v: string) {
        html = v
        for (const m of v.matchAll(/<(\w+)\b[^>]*\sid="([^"]+)"[^>]*>/g)) els.set(m[2], make(m[2], m[0]))
      },
      getAttribute: (k: string) => e.attrs[k] ?? null, setAttribute: (k: string, v: string) => { e.attrs[k] = v },
      hasAttribute: (k: string) => k in e.attrs, removeAttribute: (k: string) => { delete e.attrs[k] },
      addEventListener: (t: string, f: (ev?: unknown) => void) => { on[t] = f },
      appendChild: (c: any) => { e.children.push(c); return c },
      querySelector: () => null,
    }
    return e
  }
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(page)
      if (!tag) throw new Error(`no element #${id} on the page`)
      els.set(id, make(id, tag[0]))
    }
    return els.get(id)
  }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  const onWindow: Record<string, () => void> = {}
  const doc = {
    getElementById: el, hidden: false,
    querySelector: (sel: string) => (sel === ".ax-wall" ? { classList: classes() } : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) },
    createElement: () => ({ className: "", innerHTML: "", setAttribute() {}, querySelector: () => ({ setAttribute() {}, innerHTML: "" }) }),
  }
  const loc: any = { hash: opts.hash, search: "", href: "" }
  const calls: Array<{ url: string; init: any }> = []
  const timers: Array<() => void> = []
  const runs = opts.runs ?? RUNS
  const fetchStub = (url: string, init: any) => {
    calls.push({ url, init })
    const node = /^\/api\/monitor\/activity\?node=([^&]+)/.exec(url)
    if (url === "/api/monitor" && opts.monitorHangs) return new Promise(() => {})
    if (url === "/api/monitor" && opts.monitorFails) return Promise.resolve({ ok: false, status: 502, json: async () => ({ error: "bad gateway" }) })
    if (url === "/api/node/build") return opts.build === undefined ? Promise.resolve({ ok: false, status: 502, json: async () => ({}) }) : opts.build === null ? Promise.reject(new Error("down")) : Promise.resolve({ ok: true, status: 200, json: async () => opts.build })
    const body = url.startsWith("/api/admin/wall?") ? { node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }], failures: [], posts: opts.posts ?? [POST] }
      : url === "/api/live" ? { nodes: [{ name: "node-a", url: "http://node-a", reachable: true, agents: [{ id: "cx", name: "Customer Desk" }, { id: "ops", name: "Night Shift" }] }] }
      : url === "/api/monitor" ? NODES
      : node ? { node: decodeURIComponent(node[1]).replace("http://", ""), since: NOW - 24 * H, runs: runs[decodeURIComponent(node[1])] ?? [], marks: [] }
      : { runs: [] }
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", "EventSource", "requestAnimationFrame", script)(
    doc, { addEventListener: (t: string, f: () => void) => { onWindow[t] = f } }, fetchStub, loc,
    { replaceState: (_: unknown, __: string, h: string) => { loc.hash = h } },
    { getItem: () => null, setItem: () => {} }, (f: () => void) => { timers.push(f); return 0 }, class { addEventListener() {} close() {} }, (f: () => void) => { f(); return 1 },
  )
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const go = async (hash: string) => { loc.hash = hash; onWindow.hashchange?.(); await settle() }
  /** A change on one of the page's selects. */
  const pick = async (id: string, value: string) => { for (const f of onDoc.change ?? []) f({ target: { id, value } }); await settle() }
  /** A click on an element carrying these attributes. */
  const click = async (attrs: Record<string, string>) => {
    const t: any = { attrs, getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs }
    t.closest = (sel: string) => [...sel.matchAll(/\[([\w-]+)\]/g)].some((m) => m[1] in attrs) ? t : null
    for (const f of onDoc.click ?? []) f({ target: t, preventDefault() {} })
    await settle()
  }
  const html = () => el("wall-activity").innerHTML as string
  /** The rows, in order, as one string each. */
  const rows = () => html().split('<article class="wp wac').slice(1)
  /** Let every interval fire once, as a minute going by would. */
  const tick = async () => { for (const f of timers) f(); await settle() }
  return { el, calls, settle, loc, go, pick, click, html, rows, tick, opts }
}

describe("Wall Activity: the agents' runs, newest first (#1429)", () => {
  it("has a nav entry that opens the page in the middle column", async () => {
    expect(renderWallPage()).toContain('data-nav="activity" href="#page=activity"')
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Activity")
    expect(w.el("wall-activity").hidden).toBe(false)
    expect(w.el("wall-feed").hidden).toBe(true)
  })

  it("lists every machine's runs newest first, with agent, title, result, duration, cost and time", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    const r = w.rows()
    expect(r.map((x) => /data-run-agent="(\w+)"/.exec(x)![1])).toEqual(["ops", "cx", "ops", "cx"])
    const [running, failed, job, done] = r
    // The Wall's post names the run: its headline, and its project.
    expect(done).toContain("Customer Desk</button>")
    expect(done).toContain(">Refund order 47</a>")
    expect(done).toContain("<b>support</b>")
    expect(done).toContain('is-mute">Done</span>')
    expect(done).toContain(">from a message on telegram</span>")
    expect(done).toContain(">1 min</span>")
    expect(done).toContain(">$0.12</span>")
    expect(done).toContain("<time datetime=")
    // With no post, the first line of what was asked.
    expect(job).toContain(">Morning digest</a>")
    expect(job).toContain(">4 min</span>")
    expect(job).toContain(">from a job</span>")
    expect(running).toContain('ax-badge--live">Running</span>')
    expect(running).toContain("so far</span>")
    expect(failed).toContain("node-a")
  })

  it("marks a failed run", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    const failed = w.rows().find((x) => x.includes("Fix the checkout test"))!
    expect(failed.startsWith(" is-failed\"")).toBe(true)
    expect(failed).toContain('ax-badge--err">Failed</span>')
    expect(w.html()).toContain("4 runs, 1 failed in the last 24 h")
  })

  it("shows – for a run with no cost, never $0", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    for (const id of ["Morning digest", "Update the pricing page"]) {
      const row = w.rows().find((x) => x.includes(id))!
      expect(row).toContain('title="No cost recorded for this run">–</span>')
      expect(row).not.toContain("$0")
    }
  })

  it("opens a run's Task page from its row", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    const done = w.rows().find((x) => x.includes("Refund order 47"))!
    expect(done).toContain('href="#page=task&amp;task=t1&amp;agent=cx&amp;node=http%3A%2F%2Fnode-a&amp;ch=telegram&amp;ask=Answer+the+refund+question%0Afor+order+47&amp;at=')
    expect(done).toContain("&amp;done=1\"")
    const running = w.rows().find((x) => x.includes("Update the pricing page"))!
    expect(running).not.toContain("done=1")
  })

  it("combines the agent, project and result filters, and keeps them in the hash", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    await w.pick("act-agent", "cx")
    expect(w.rows()).toHaveLength(2)
    await w.pick("act-project", "shop")
    expect(w.rows()).toHaveLength(1)
    await w.click({ "data-act-result": "failed" })
    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toContain("Fix the checkout test")
    expect(w.loc.hash).toContain("page=activity")
    expect(w.loc.hash).toContain("a-agent=cx")
    expect(w.loc.hash).toContain("a-project=shop")
    expect(w.loc.hash).toContain("a-result=failed")
    await w.click({ "data-act-result": "done" })
    expect(w.rows()).toHaveLength(0)
    expect(w.html()).toContain("No runs match these filters.")
    expect(w.html()).toContain("data-act-clear")
    await w.click({ "data-act-clear": "" })
    expect(w.rows()).toHaveLength(2)
    expect(w.loc.hash).not.toContain("a-result")
  })

  it("reads its filters back from a link", async () => {
    const w = openWall({ hash: "#page=activity&a-result=done" })
    await w.settle()
    expect(w.rows().map((x) => /data-run-agent="(\w+)"/.exec(x)![1])).toEqual(["ops", "cx"])
    const other = openWall({ hash: "#page=activity&a-project=-" })
    await other.settle()
    expect(other.rows().map((x) => /data-run-agent="(\w+)"/.exec(x)![1])).toEqual(["ops"])
  })

  it("reads 7 or 30 days when the period asks, and keeps it in the hash", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    expect(w.calls.filter((c) => c.url.startsWith("/api/monitor/activity?")).map((c) => c.url)).toEqual([
      "/api/monitor/activity?node=http%3A%2F%2Fnode-a&hours=24", "/api/monitor/activity?node=http%3A%2F%2Fnode-b&hours=24"])
    await w.click({ "data-act-period": "30d" })
    expect(w.calls.some((c) => c.url === "/api/monitor/activity?node=http%3A%2F%2Fnode-a&hours=720")).toBe(true)
    expect(w.loc.hash).toContain("a-period=30d")
    expect(w.html()).toContain("in the last 30 d")
    // An older machine keeps its window to seven days: say so.
    expect(w.html()).toContain("node-a sent only its runs since")
  })

  it("names a machine that does not answer", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    expect(w.html()).toContain('<p class="wac__banner is-warn" role="status">node-c does not answer: its runs are missing.</p>')
  })

  it("says so when nothing ran", async () => {
    const w = openWall({ hash: "#page=activity", runs: {} })
    await w.settle()
    expect(w.rows()).toHaveLength(0)
    expect(w.html()).toContain("<h3>Nothing ran in this window</h3>")
    expect(w.html()).toContain("Nothing ran in the last 24 h. Try 7 days.")
  })

  it("writes nothing: every call it makes is a read", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    await w.pick("act-agent", "ops")
    await w.click({ "data-act-period": "7d" })
    expect(w.calls.length).toBeGreaterThan(0)
    expect(w.calls.every((c) => !c.init || !c.init.method || c.init.method === "GET")).toBe(true)
  })
})

describe("Wall agent profile: the Activity tab (#1429)", () => {
  it("shows only that agent's runs under its profile, with the Activity tab on", async () => {
    const w = openWall({ hash: "#page=activity&a-agent=ops" })
    await w.settle()
    expect(w.rows().map((x) => /data-run-agent="(\w+)"/.exec(x)![1])).toEqual(["ops", "ops"])
    const html = w.html()
    expect(html).toContain('<nav class="wpf__tabs"')
    expect(html).toContain('<button type="button" data-agent="ops">Posts</button><a href="#page=activity&amp;a-agent=ops" class="is-on" aria-current="page">Activity</a>')
    // The profile picks the agent: no agent select on its tab.
    expect(html).not.toContain('id="act-agent"')
    await w.click({ "data-act-all": "" })
    expect(w.rows()).toHaveLength(4)
  })

  it("links the Wall's profile to its Activity tab, in place of the classic history page", async () => {
    const w = openWall({ hash: "#status=&owner=cx" })
    await w.settle()
    const profile = w.el("wall-profile").innerHTML as string
    expect(profile).toContain('<a href="#page=activity&amp;a-agent=cx">Activity</a>')
    expect(profile).not.toContain("/history")
    await w.go("#page=agents")
    expect(w.el("wall-agents-page").innerHTML).toContain('<a href="#page=activity&amp;a-agent=ops">Activity</a>')
    expect(w.el("wall-agents-page").innerHTML).not.toContain("/history")
  })
})

describe("Wall Activity, design #1451 frame 3", () => {
  it("has outcome tabs, with the failed count, over the filters and the period", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    const html = w.html()
    expect(html).toContain('role="tablist" aria-label="Outcome"')
    expect(html).toContain('data-act-result="" aria-selected="true" class="is-on">All</button>')
    expect(html).toContain('data-act-result="failed" aria-selected="false">Failed <b class="wac__n">1</b></button>')
    expect(html).toContain('id="act-source"')
    expect(html).toContain("4 runs, 1 failed in the last 24 h, newest first")
    // Feed or Timeline beside the title; Timeline is the classic lane view.
    expect(w.el("wall-act-switch").hidden).toBe(false)
    expect(renderWallPage()).toContain('<a href="/activity" title="The classic lane view, and the Map">Timeline</a>')
  })

  it("filters by what started a run", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    await w.pick("act-source", "jobs")
    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toContain("Morning digest")
    expect(w.loc.hash).toContain("a-source=jobs")
  })

  it("opens a run in place, with what was asked, where it ran and a link to the run", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    expect(w.html()).not.toContain("wac__open")
    await w.click({ "data-act-row": "t1" })
    const open = w.rows().find((x) => x.includes("Refund order 47"))!
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('<dd class="wac__ask">Answer the refund question\nfor order 47</dd>')
    expect(open).toContain("<dd>node-a · telegram · demo</dd>")
    expect(open).toContain("No review findings for this run")
    expect(open).toContain(">Open the run</a>")
    await w.click({ "data-act-row": "t1" })
    expect(w.html()).not.toContain("wac__open")
  })

  it("sums up the period in the side column, with unpriced runs counted apart", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    const side = w.el("wall-act-side").innerHTML as string
    expect(side).toContain("<h2>Last 24 h</h2>")
    expect(side).toContain("<b>4</b><span>runs</span>")
    expect(side).toContain("<span>cost, 2 unpriced</span>")
    expect(side).toContain('<h2>By agent</h2>')
    expect(side).toContain('data-act-agent="cx"')
    expect(w.el("wall-aside").classList.contains("is-act")).toBe(true)
  })

  it("shows rows of placeholders while it loads, then an error with Try again when the machines cannot be read", async () => {
    const slow = openWall({ hash: "#page=activity", monitorHangs: true })
    await slow.settle()
    expect(slow.html()).toContain('<div class="wac__list" aria-busy="true">')
    expect(slow.el("wall-act-side").innerHTML).toContain("Loading…")
    const w = openWall({ hash: "#page=activity", monitorFails: true })
    await w.settle()
    expect(w.html()).toContain('<p class="wac__banner is-err" role="alert">Could not read the runs:')
    expect(w.html()).toContain("data-act-retry")
  })
})

describe("Wall nav and phone bar, design #1451 frame 0", () => {
  it("groups the nav under Work, Automation, Fleet and Owner, with the new pages", () => {
    const page = renderWallPage()
    const nav = page.slice(page.indexOf('<nav class="ax-wall__nav"'), page.indexOf("</nav>"))
    const order = [...nav.matchAll(/data-nav="([\w]+)"|ax-wall__navlbl" aria-hidden="true">(\w+)</g)].map((m) => m[1] || m[2])
    expect(order).toEqual(["wall", "needs", "Work", "live", "running", "projects", "activity", "Automation", "jobs", "workflows", "reviews", "failures",
      "Fleet", "agents", "people", "org", "cost", "Owner", "settings", "dashboard", "creator"])
    // Not on the Wall yet: they open their classic page until built.
    expect(nav).toContain('data-nav="workflows" href="/workflows"')
    expect(nav).toContain('data-nav="people" href="/people"')
    expect(nav).toContain('data-nav="org" href="/org"')
    expect(nav).toContain('data-nav="settings" href="/admin"')
  })

  it("keeps four pages in the phone bar and puts the rest in the More sheet, in the same groups", () => {
    const page = renderWallPage()
    for (const k of ["wall", "needs", "running", "projects"]) expect(page).toMatch(new RegExp(`data-nav="${k}" href="[^"]*" data-bar`))
    expect(page).toContain(".ax-wall__nav > .ax-wall__item:not([data-bar]):not(.ax-wall__morebtn)")
    const sheet = page.slice(page.indexOf('id="wall-more"'), page.indexOf('<div class="ax-wall__main">'))
    expect([...sheet.matchAll(/<h2 class="ax-wall__navlbl">(\w+)<\/h2>/g)].map((m) => m[1])).toEqual(["Work", "Automation", "Fleet"])
    expect([...sheet.matchAll(/class="ax-wall__moreitem" data-nav="(\w+)"/g)].map((m) => m[1])).toEqual(["live", "activity", "jobs", "workflows", "reviews", "failures", "agents", "people", "org", "cost"])
    expect(sheet).toContain('data-n-for="nav-n-live"')
    expect(sheet).toContain('data-nav="settings" href="/admin">Settings</a>')
    expect(sheet).toContain("data-wall-theme>Light / dark</button>")
    expect(page).toMatch(/@media \(max-width: 640px\) \{\n {2}\.wac__bar/)
  })

  it("opens More as a sheet and closes it when a page is picked", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    expect(w.el("wall-more").hidden).toBe(true)
    await w.click({ "data-more-nav": "" })
    expect(w.el("wall-more").hidden).toBe(false)
    await w.click({ "data-nav": "jobs" })
    expect(w.el("wall-more").hidden).toBe(true)
    await w.click({ "data-more-nav": "" })
    await w.click({ "data-more-close": "" })
    expect(w.el("wall-more").hidden).toBe(true)
  })
})

describe("Wall build line, design #1451 frame 0 (#1444)", () => {
  const BUILD = { version: "0.182.0", commit: "4f2c9a1", startedAt: "2026-10-27T08:14:00Z", diskNewer: false, node: "node-a" }

  it("shows the version, commit and since on the title row", async () => {
    const w = openWall({ hash: "#page=activity", build: BUILD })
    await w.settle()
    const b = w.el("wall-build")
    expect(b.innerHTML).toContain('<span class="wbl__v">0.182.0 · 4f2c9a1</span><span class="wbl__since">since ')
    expect(b.innerHTML).not.toContain("Restart pending")
    expect(b.title).toBe("The build the daemon is running, and when it started. Node: node-a")
    expect(w.calls.filter((c) => c.url === "/api/node/build")).toHaveLength(1)
  })

  it("says Restart pending with the classic hover text, and links to the restart controls", async () => {
    const w = openWall({ hash: "#page=wall", build: { ...BUILD, diskNewer: true } })
    await w.settle()
    const b = w.el("wall-build")
    expect(b.innerHTML).toContain('<span class="ax-badge ax-badge--warn wbl__stale" role="status">Restart pending</span>')
    expect(b.title).toBe("The code on disk is newer than the running daemon. Restart the daemon to load it. Node: node-a")
    expect(b.attrs.href).toBe("/live")
  })

  it("draws nothing until the first answer, keeping its place", async () => {
    const page = renderWallPage()
    expect(page).toContain('<a class="wbl is-wait" id="wall-build" href="#page=live" aria-hidden="true">&nbsp;</a>')
    const w = openWall({ hash: "#page=wall" })
    await w.settle()
    expect(w.el("wall-build").innerHTML).toBe("")
  })

  it("asks again every minute, and keeps the last answer, marked as of, when one fails", async () => {
    const w = openWall({ hash: "#page=wall", build: BUILD })
    await w.settle()
    ;(w.opts as any).build = null
    await w.tick()
    expect(w.el("wall-build").innerHTML).toContain("0.182.0 · 4f2c9a1")
    expect(w.el("wall-build").innerHTML).toContain('wbl__asof">as of ')
  })
})
