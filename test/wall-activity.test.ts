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

function openWall(opts: { hash: string; runs?: Record<string, unknown[]>; posts?: unknown[] }) {
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
      hasAttribute: (k: string) => k in e.attrs,
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
  const runs = opts.runs ?? RUNS
  const fetchStub = (url: string, init: any) => {
    calls.push({ url, init })
    const node = /^\/api\/monitor\/activity\?node=([^&]+)/.exec(url)
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
    { getItem: () => null, setItem: () => {} }, () => 0, class { addEventListener() {} close() {} }, (f: () => void) => { f(); return 1 },
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
  return { el, calls, settle, loc, go, pick, click, html, rows }
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
    expect(r.map((x) => /data-act-agent="(\w+)"/.exec(x)![1])).toEqual(["ops", "cx", "ops", "cx"])
    const [running, failed, job, done] = r
    // The Wall's post names the run: its headline, and its project.
    expect(done).toContain("Customer Desk</button>")
    expect(done).toContain(">Refund order 47</a>")
    expect(done).toContain("<b>support</b>")
    expect(done).toContain("chip--done\">Done</span>")
    expect(done).toContain(">1 min</span>")
    expect(done).toContain(">$0.12</span>")
    expect(done).toContain("<time datetime=")
    // With no post, the first line of what was asked.
    expect(job).toContain(">Morning digest</a>")
    expect(job).toContain(">4 min</span>")
    expect(running).toContain('<span class="chip state">Running</span>')
    expect(running).toContain("so far</span>")
    expect(failed).toContain("node-a")
  })

  it("marks a failed run", async () => {
    const w = openWall({ hash: "#page=activity" })
    await w.settle()
    const failed = w.rows().find((x) => x.includes("Fix the checkout test"))!
    expect(failed.startsWith(" is-failed\"")).toBe(true)
    expect(failed).toContain("chip--err\">Failed</span>")
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
    await w.pick("act-result", "failed")
    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toContain("Fix the checkout test")
    expect(w.loc.hash).toContain("page=activity")
    expect(w.loc.hash).toContain("a-agent=cx")
    expect(w.loc.hash).toContain("a-project=shop")
    expect(w.loc.hash).toContain("a-result=failed")
    await w.pick("act-result", "done")
    expect(w.rows()).toHaveLength(0)
    expect(w.html()).toContain("No runs match these filters.")
  })

  it("reads its filters back from a link", async () => {
    const w = openWall({ hash: "#page=activity&a-result=done" })
    await w.settle()
    expect(w.rows().map((x) => /data-act-agent="(\w+)"/.exec(x)![1])).toEqual(["ops", "cx"])
    const other = openWall({ hash: "#page=activity&a-project=-" })
    await other.settle()
    expect(other.rows().map((x) => /data-act-agent="(\w+)"/.exec(x)![1])).toEqual(["ops"])
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
    expect(w.html()).toContain("node-c does not answer: its runs are missing.")
  })

  it("says so when nothing ran", async () => {
    const w = openWall({ hash: "#page=activity", runs: {} })
    await w.settle()
    expect(w.rows()).toHaveLength(0)
    expect(w.html()).toContain("Nothing ran in the last 24 h.")
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
    expect(w.rows().map((x) => /data-act-agent="(\w+)"/.exec(x)![1])).toEqual(["ops", "ops"])
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

describe("Wall Activity on a phone (#1429)", () => {
  it("puts Activity in the bottom bar's More menu", () => {
    const page = renderWallPage()
    expect(page).toContain('.ax-wall__nav > [data-nav="activity"]')
    expect(page).toContain('.ax-wall__nav.is-more > [data-nav="activity"] { bottom: 330px; }')
    expect(page).toMatch(/@media \(max-width: 640px\) \{\n {2}\.wac__bar label/)
  })
})
