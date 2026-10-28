import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"

// #1428: Settings on the Wall, phase 1 (the shell and the Agents section).
// It writes settings for the owner only (#1449), with the endpoints classic
// /admin calls; every other Wall page sends no settings write. These run the page's real script
// against a stubbed DOM and fetch.

const STATE = {
  exists: true,
  agents: [
    { id: "cx", name: "Customer Desk", tier: "claude-code", model: "model-a", mentions: ["@cx", "cx"], access: "private", systemPrompt: "You answer customers.",
      maxConcurrent: 2, maxExecutionMinutes: 20, permissionMode: "default", wikiAbsorb: true,
      integrations: [{ kind: "custom", label: "Team CRM", enabled: true, credentials: { tokenEnv: "CRM_TOKEN" }, credStatus: { tokenEnv: "unset" }, metadata: {} }] },
    { id: "ops", name: "Night Shift", tier: "codex-cli", mentions: ["@ops"], access: "public", maxConcurrent: 1, maxExecutionMinutes: 20, permissionMode: "default", wikiAbsorb: true, integrations: [] },
    { id: "new", name: "New Hire", tier: "claude-code", mentions: ["@new"], access: "private", maxConcurrent: 1, maxExecutionMinutes: 20, permissionMode: "default", wikiAbsorb: true, integrations: [] },
  ],
  wikiCurator: { enabled: true, agent: "" },
  crons: [
    { id: "digest", schedule: "0 9 * * *", agent: "cx", model: "", enabled: true },
    { id: "audit", schedule: "0 3 * * 1", agent: "cx", model: "model-z", enabled: true },
    { id: "night", schedule: "0 1 * * *", agent: "ops", model: "", enabled: true },
  ],
}
const BUDGETS = { agents: [{ agentId: "cx", spentUsd: 12.5, capUsd: 40, state: "ok" }], agentIds: ["cx", "ops", "new"] }
const ORG = {
  roots: [{ id: "cx", name: "Customer Desk", title: "Support lead", status: "idle", reports: [{ id: "ops", name: "Night Shift", status: "paused", heldBy: "the owner", reports: [] }] }],
  outside: [{ id: "new", name: "New Hire", status: "waiting", reports: [] }],
  live: true,
}
const LIVE = { nodes: [{ name: "node-a", url: "http://node-a", reachable: true, agents: [{ id: "cx", name: "Customer Desk", runningTasks: [] }, { id: "ops", name: "Night Shift", runningTasks: [] }] }] }

type Reply = { status: number; body: unknown }
type Route = (url: string, init: any) => Reply | undefined

function openWall(opts: { hash: string; owner?: boolean; business?: boolean; route?: Route }) {
  const page = renderWallPage({ owner: opts.owner ?? true, business: opts.business })
  const cfg = /<script>window\.AX_WALL_SETTINGS = (.*?);<\/script>/.exec(page)
  const script = CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  let paints = 0
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c), add: (c: string) => s.add(c), remove: (c: string) => s.delete(c) } }
  const attrsOf = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"')]))
  const make = (id: string, tag: string) => {
    let html = ""
    const e: any = {
      id, attrs: attrsOf(tag), hidden: /\shidden[\s>]/.test(tag), textContent: "", value: id === "f-status" ? "open" : "", checked: false,
      type: /type="checkbox"/.test(tag) ? "checkbox" : "select", style: {}, className: "", classList: classes(), parentNode: { classList: classes() },
      get innerHTML() { return html },
      set innerHTML(v: string) {
        html = v
        if (id === "wall-settings") paints++
        for (const m of v.matchAll(/<(\w+)\b[^>]*\sid="([^"]+)"[^>]*>/g)) els.set(m[2], make(m[2], m[0]))
      },
      getAttribute: (k: string) => e.attrs[k] ?? null, setAttribute: (k: string, v: string) => { e.attrs[k] = v }, removeAttribute: (k: string) => { delete e.attrs[k] },
      hasAttribute: (k: string) => k in e.attrs, addEventListener: () => {}, focus: () => {},
      querySelector: () => null,
    }
    return e
  }
  // A browser returns null for an id that is not on the page; the page's
  // markup and script text both count, as in the other Wall tests.
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(page)
      if (!tag) return null
      els.set(id, make(id, tag[0]))
    }
    return els.get(id)
  }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  const onWindow: Record<string, () => void> = {}
  const wall = { classList: classes() }
  const doc = {
    getElementById: el, hidden: false, activeElement: null,
    querySelector: (sel: string) => (sel === ".ax-wall" ? wall : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) },
    createElement: () => ({ className: "", innerHTML: "", setAttribute() {}, querySelector: () => ({ setAttribute() {}, innerHTML: "" }) }),
  }
  const loc: any = { search: "", href: "" }
  let hash = opts.hash
  Object.defineProperty(loc, "hash", { get: () => hash, set: (h: string) => { hash = h.startsWith("#") || !h ? h : "#" + h; Promise.resolve().then(() => onWindow.hashchange?.()) } })
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fetchStub = (url: string, init: any = {}) => {
    const method = init.method || "GET"
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined })
    const r = opts.route?.(url, init)
      ?? (url === "/api/admin/state" ? { status: 200, body: STATE }
        : url === "/api/admin/org" ? { status: 200, body: ORG }
        : url.startsWith("/api/live?") ? { status: 200, body: LIVE }
        : url === "/api/admin/observability/budgets" ? { status: 200, body: BUDGETS }
        : url.startsWith("/api/admin/wall?") ? { status: 200, body: { node: "node-a", syncedAt: Date.now(), nodes: [{ name: "node-a", ok: true }], failures: [], posts: [] } }
        : method !== "GET" ? { status: 200, body: { summary: "ok" } }
        : { status: 200, body: { runs: [] } })
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })
  }
  const win: any = { addEventListener: (t: string, f: () => void) => { onWindow[t] = f } }
  if (cfg) win.AX_WALL_SETTINGS = JSON.parse(cfg[1])
  class FakeEventSource { constructor() {} addEventListener() {} close() {} }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", "EventSource", "requestAnimationFrame", script)(
    doc, win, fetchStub, loc, { replaceState: (_: unknown, __: string, h: string) => { hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0, FakeEventSource, (f: () => void) => { f(); return 1 },
  )
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const go = async (h: string) => { hash = h; onWindow.hashchange?.(); await settle() }
  /** A click on an element carrying these attributes. */
  const click = async (attrs: Record<string, string>) => {
    const t: any = { getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs }
    t.closest = (sel: string) => sel.split(",").some((s) => Object.keys(attrs).some((k) => s.trim() === `[${k}]`)) ? t : null
    for (const f of onDoc.click ?? []) f({ target: t, preventDefault() {} })
    await settle()
  }
  const submit = async (attrs: Record<string, string>) => {
    const form: any = { getAttribute: (k: string) => attrs[k] ?? null }
    for (const f of onDoc.submit ?? []) f({ target: { closest: () => form }, preventDefault() {} })
    await settle()
  }
  /** Typing in a field, or ticking a box: the field changes, then its input event. */
  const type = async (id: string, v: string | boolean) => {
    const t = el(id)
    if (typeof v === "boolean") t.checked = v
    else t.value = v
    for (const f of onDoc.input ?? []) f({ target: t })
    await settle()
  }
  const key = async (k: string) => {
    for (const f of onDoc.keydown ?? []) f({ key: k, target: { id: "" }, preventDefault() {} })
    await settle()
  }
  const writes = () => calls.filter((c) => c.method !== "GET")
  return { page, el, calls, writes, settle, go, click, submit, type, key, paints: () => paints, wall }
}

const settingsHtml = (w: ReturnType<typeof openWall>) => w.el("wall-settings")!.innerHTML as string

describe("Wall Settings: owner only (#1428)", () => {
  it("draws the Settings nav entry and config only for the owner", () => {
    const owner = renderWallPage({ owner: true })
    expect(owner).toContain('data-nav="settings" href="#page=settings"')
    expect(owner).toContain('<section id="wall-settings"')
    expect(owner).toContain('window.AX_WALL_SETTINGS = {"business":false}')
    // In the grouped nav (#1435), under Owner.
    expect(owner).toMatch(/>Owner<\/span>\s*<a class="ax-wall__item" data-nav="settings"/)
    const other = renderWallPage({ owner: false })
    expect(other).not.toContain('data-nav="settings"')
    expect(other).not.toContain(">Owner</span>")
    expect(other).not.toContain("window.AX_WALL_SETTINGS =")
    // The default is no Settings: a caller must say the viewer is the owner.
    expect(renderWallPage()).not.toContain('data-nav="settings"')
  })

  it("tells a viewer who is not the owner that Settings are the owner's, and reads nothing", async () => {
    const w = openWall({ hash: "#page=settings&section=agents", owner: false })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Settings")
    expect(w.el("wall-settings").hidden).toBe(false)
    expect(settingsHtml(w)).toContain("<h2>Settings are for the owner</h2>")
    expect(settingsHtml(w)).not.toContain("wst__menu")
    expect(w.calls.some((c) => c.url === "/api/admin/state")).toBe(false)
    expect(w.writes()).toEqual([])
  })

  it("says so when the API refuses the viewer", async () => {
    const w = openWall({ hash: "#page=settings&section=agents", route: (u) => (u === "/api/admin/state" ? { status: 401, body: { error: "unauthorized" } } : undefined) })
    await w.settle()
    expect(settingsHtml(w)).toContain("Only the owner can change settings.")
    expect(settingsHtml(w)).not.toContain('class="wsa"')
  })

  it("shows a load error with a way to try again", async () => {
    let fail = true
    const w = openWall({ hash: "#page=settings", route: (u) => (u === "/api/admin/state" && fail ? { status: 500, body: { error: "disk full" } } : undefined) })
    await w.settle()
    expect(settingsHtml(w)).toContain("Could not load the settings: disk full.")
    fail = false
    await w.click({ "data-st-act": "reload" })
    expect(settingsHtml(w)).toContain("Customer Desk")
  })
})

describe("Wall Settings: the shell (#1428)", () => {
  it("points the owner's Settings and Agent page links at the Wall", async () => {
    expect(renderWallPage({ owner: true })).toContain('<a href="#page=settings">Settings</a>')
    expect(renderWallPage({ owner: false })).toContain('<a href="/admin">Settings</a>')
    const w = openWall({ hash: "#page=agents" })
    await w.settle()
    const html = w.el("wall-agents-page").innerHTML
    expect(html).toContain('<a href="#page=settings&amp;section=agents&amp;agent=cx">Settings</a>')
    expect(html).not.toContain('href="/admin/agents/cx"')
  })

  it("lists every section in its group, the chosen one first on a phone, and links unported ones to their classic page", async () => {
    const w = openWall({ hash: "#page=settings" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Settings")
    expect(w.el("wall-settings").hidden).toBe(false)
    expect(w.wall.classList.contains("is-settings")).toBe(true)
    const html = settingsHtml(w)
    const groups = html.split("</nav>")[0].split('<h3 class="wst__grp">').slice(1).map((g) => [g.split("<")[0], [...g.matchAll(/<span>([^<]+)<small/g)].map((m) => m[1])])
    expect(groups).toEqual([
      ["Fleet", ["Agents", "Channels", "Schedules", "Webhooks", "Mesh", "Boards", "Actions", "Inbox"]],
      ["Access", ["Guests", "People", "Tokens"]],
      ["Machines", ["Health", "Advanced"]],
    ])
    expect(html).toContain("3 agents, their pictures, models and on/off")
    // Agents and Health are built: the rest say they open their classic page.
    expect(html.match(/is-classic/g)).toHaveLength(11)
    // No section in the link: on a phone the list is the screen.
    expect(html).toContain('<div class="wst">')
    await w.go("#page=settings&section=channels")
    expect(settingsHtml(w)).toContain('<div class="wst has-section">')
    expect(settingsHtml(w)).toContain('href="/admin#tab=channels"')
    await w.go("#page=settings&section=schedules")
    expect(settingsHtml(w)).toContain('href="/admin#tab=crons"')
    await w.go("#page=settings&section=guests")
    expect(settingsHtml(w)).toContain('href="/guests"')
    await w.go("#page=settings&section=people")
    expect(settingsHtml(w)).toContain("People has its own page on the Wall.")
    expect(settingsHtml(w)).toContain('href="#page=people"')
  })

  it("lists Business only when the business layer is on", async () => {
    const w = openWall({ hash: "#page=settings" })
    await w.settle()
    expect(settingsHtml(w)).not.toContain("<span>Business<small")
    const b = openWall({ hash: "#page=settings", business: true })
    await b.settle()
    expect(settingsHtml(b)).toContain("<span>Business<small")
  })

  it("puts an amber count on the sections that need the owner", async () => {
    const calm = openWall({ hash: "#page=settings", route: (u) => u === "/api/admin/state" ? { status: 200, body: { ...STATE, agents: STATE.agents.map((a) => ({ ...a, integrations: [] })) } }
      : u === "/api/admin/org" ? { status: 200, body: { ...ORG, outside: [] } } : undefined })
    await calm.settle()
    expect(settingsHtml(calm)).not.toContain("wst__n-att")
    expect(settingsHtml(calm)).toContain('<b class="wst__n-all" title="Agents on this machine">3</b>')
    // cx misses a credential and new waits for approval; node-b does not answer, node-a waits for a restart.
    const w = openWall({ hash: "#page=settings", route: (u) => u.startsWith("/api/live?") ? { status: 200, body: { nodes: [
      { ...LIVE.nodes[0], restart: { state: "pending" } }, { name: "node-b", url: "http://node-b", reachable: false, agents: [] },
    ] } } : undefined })
    await w.settle()
    const html = settingsHtml(w)
    const count = (s: string) => (html.split(`<span>${s}<small`)[1].split("</a>")[0].match(/wst__n-att[^>]*>(\d+)</) || [])[1]
    expect(count("Agents")).toBe("2")
    expect(count("Mesh")).toBe("1")
    expect(count("Health")).toBe("2")
    expect(count("Channels")).toBeUndefined()
  })
})

describe("Wall Settings: Health (#1428)", () => {
  const TOKENS = [{ id: "t1", name: "ci" }, { id: "t2", name: "old", revokedAt: "2026-01-01T00:00:00Z" }, { id: "t3", name: "gone", expiresAt: "2020-01-01T00:00:00Z" }]
  const twoNodes = (u: string) => u.startsWith("/api/live?") ? { status: 200, body: { nodes: [
    { ...LIVE.nodes[0], version: "1.2.3", restart: { state: "pending" } }, { name: "node-b", url: "http://node-b", reachable: false, error: "timed out", agents: [{ id: "far", runningTasks: [] }] },
  ] } } : u === "/api/admin/tokens" ? { status: 200, body: TOKENS }
    : u === "/api/admin/state" ? { status: 200, body: { ...STATE, telegram: { enabled: true, accounts: [{ id: "default" }] }, slack: { enabled: false, botTokenRef: "SLACK_TOKEN" } } }
    : undefined

  it("shows the four numbers, one line per machine and what to fix, on the Wall", async () => {
    const w = openWall({ hash: "#page=settings&section=health", route: twoNodes })
    await w.settle()
    const html = settingsHtml(w)
    expect(html).not.toContain('href="/admin"')
    const nums = [...html.matchAll(/<div class="wsh__s[^"]*"><b>([^<]+)<\/b><span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]])
    expect(nums).toEqual([["2 of 3", "agents online"], ["1 of 2", "channels on"], ["2", "need you"], ["1", "active tokens"]])
    expect(html).toContain('<li class="is-up"><i aria-hidden="true"></i><b>node-a</b><span>answering · v1.2.3</span><span class="ax-badge ax-badge--warn">Restart pending</span></li>')
    expect(html).toContain("<b>node-b</b><span>not answering</span>")
    expect(html).toContain('node-b does not answer: timed out. <a href="#page=live">See it on Live</a>')
    expect(html).toContain('node-a waits for a restart (pending). <a href="#page=live">Restart it on Live</a>')
    expect(w.writes()).toEqual([])
  })

  it("says nothing needs fixing when every machine answers", async () => {
    const w = openWall({ hash: "#page=settings&section=health" })
    await w.settle()
    expect(settingsHtml(w)).toContain('<p class="wsh__ok">Nothing to fix.</p>')
    // No token list (refused or not read): a dash, not a zero.
    expect(settingsHtml(w)).toContain("<b>—</b><span>active tokens</span>")
  })

  it("puts Health on top of the section list, the phone's first screen, and not inside a section", async () => {
    const w = openWall({ hash: "#page=settings", route: twoNodes })
    await w.settle()
    const side = settingsHtml(w).split('<div class="wst__body">')[0]
    expect(side).toContain('<div class="wst__phonehealth" id="st-health-phone"><section class="wsh wsh--compact" aria-label="Health"><h2>Health</h2>')
    expect(side.indexOf("wst__phonehealth")).toBeLessThan(side.indexOf("wst__menu"))
    await w.go("#page=settings&section=agents")
    expect(settingsHtml(w)).not.toContain("wst__phonehealth")
  })
})

describe("Wall Settings: Agents (#1428)", () => {
  it("loads one card per agent with its name, role, engine, model and on/off", async () => {
    const w = openWall({ hash: "#page=settings&section=agents" })
    await w.settle()
    expect(w.calls.filter((c) => c.url === "/api/admin/state")).toHaveLength(1)
    const html = settingsHtml(w)
    const cx = html.split('id="st-agent-cx"')[1].split("</article>")[0]
    expect(cx).toContain('href="#page=settings&amp;section=agents&amp;agent=cx"')
    expect(cx).toContain("<b>Customer Desk</b>")
    expect(cx).toContain("@cx · Support lead")
    expect(cx).toContain("Claude Code · model-a")
    expect(cx).toContain('role="switch" aria-checked="true" data-st-hold="cx"')
    const ops = html.split('id="st-agent-ops"')[1].split("</article>")[0]
    expect(ops).toContain('aria-checked="false"')
    expect(ops).toContain("Codex CLI · public API")
    // An agent waiting for approval is decided in Approvals, not here.
    const hire = html.split('id="st-agent-new"')[1].split("</article>")[0]
    expect(hire).toContain('href="/approvals"')
    expect(hire).not.toContain("data-st-hold")
  })

  it("turns an agent off and on with the Org page's hold call", async () => {
    const w = openWall({ hash: "#page=settings&section=agents" })
    await w.settle()
    await w.click({ "data-st-hold": "cx" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/org/hold", method: "POST", body: { agent: "cx", paused: true } }])
    await w.click({ "data-st-hold": "ops" })
    expect(w.writes()[1].body).toEqual({ agent: "ops", paused: false })
    expect(settingsHtml(w)).toContain("On: it works again.")
  })

  it("shows the hold error and keeps the switch as it was", async () => {
    const w = openWall({ hash: "#page=settings&section=agents", route: (u, i) => (u === "/api/admin/wall/settings/org/hold" && i.method === "POST" ? { status: 400, body: { error: "Unknown agent" } } : undefined) })
    await w.settle()
    await w.click({ "data-st-hold": "cx" })
    expect(w.el("st-n-hold-cx").textContent).toBe("Not changed: Unknown agent")
    expect(w.el("st-n-hold-cx").className).toBe("wst__n is-err")
  })

  it("draws one agent with its picture, its switch on top and the classic tabs", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx", route: (u) =>
      u === "/api/admin/pictures" ? { status: 200, body: { agents: {}, people: {}, editable: { agent: ["cx"], person: [] } } } : undefined })
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain('<nav class="wsa-crumb" aria-label="Breadcrumb"><a href="#page=settings&amp;section=agents">Agents</a> › <span>Customer Desk</span></nav>')
    const head = html.split('<header class="wsa-head">')[1].split("</header>")[0]
    expect(head).toContain("@cx · Support lead")
    expect(head).toContain('role="switch" aria-checked="true" data-st-hold="cx"')
    expect(head).toContain('data-pic-set="cx"')
    expect([...html.matchAll(/<nav class="wsa-tabs"[^>]*>(.*?)<\/nav>/g)][0][1].match(/>([A-Z][a-z]+)<\/a>/g)).toEqual(
      [">Overview</a>", ">Personality</a>", ">Skills</a>", ">Channels</a>", ">Handovers</a>"])
    expect(html).toContain('href="#page=settings&amp;section=agents&amp;agent=cx&amp;atab=skills"')
    expect(html).toContain('id="st-e-name" data-st-f="name" value="Customer Desk"')
    // Nothing changed yet: no bar.
    expect(w.el("st-bar").hidden).toBe(true)
  })

  it("marks a changed field blue with its old value and counts the changes in the bar", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-maxConcurrent", "3")
    expect(w.el("st-fw-maxConcurrent").classList.contains("is-changed")).toBe(true)
    expect(w.el("st-fh-maxConcurrent").textContent).toBe("Changed from 2.")
    expect(w.el("st-bar").hidden).toBe(false)
    expect(w.el("st-bar").innerHTML).toContain("1 change not saved. It applies without a restart.")
    await w.type("st-e-model", "model-b")
    expect(w.el("st-fh-model").textContent).toBe("Changed from model-a.")
    expect(w.el("st-bar").innerHTML).toContain("2 changes not saved. The new model needs a daemon restart.")
    expect(w.el("st-bar").innerHTML).toContain('data-st-act="discard">Discard</button>')
    expect(w.el("st-bar").innerHTML).toContain('data-st-act="review">Save…</button>')
    // Typing it back unmarks it; nothing is written while typing.
    await w.type("st-e-maxConcurrent", "2")
    expect(w.el("st-fw-maxConcurrent").classList.contains("is-changed")).toBe(false)
    expect(w.el("st-bar").innerHTML).toContain("1 change not saved.")
    expect(w.writes()).toEqual([])
  })

  it("keeps the draft across the agent's tabs and a repaint, and Discard drops it", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", "Help Desk")
    await w.go("#page=settings&section=agents&agent=cx&atab=channels")
    expect(settingsHtml(w)).toContain("1 change not saved.")
    await w.go("#page=settings&section=agents&agent=cx")
    expect(settingsHtml(w)).toContain('id="st-e-name" data-st-f="name" value="Help Desk"')
    expect(settingsHtml(w)).toContain('class="wsf__f is-changed" id="st-fw-name"')
    await w.click({ "data-st-act": "discard" })
    expect(settingsHtml(w)).toContain('id="st-e-name" data-st-f="name" value="Customer Desk"')
    expect(settingsHtml(w)).toContain('id="st-bar" role="region" aria-label="Changes not saved" hidden>')
    expect(w.writes()).toEqual([])
  })

  it("Save… shows each change before and after, with the jobs that follow the model and the spend against the cap", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-model", "model-b")
    await w.type("st-e-maxConcurrent", "3")
    await w.click({ "data-st-act": "review" })
    const dlg = w.el("st-dlg").innerHTML as string
    expect(dlg).toContain('role="dialog" aria-modal="true"')
    expect(dlg).toContain("Save 2 changes to Customer Desk?")
    expect(dlg).toContain('<tr><th scope="row">Model</th><td><s>model-a</s> → <b>model-b</b></td></tr>')
    expect(dlg).toContain('<tr><th scope="row">Conversations at once</th><td><s>2</s> → <b>3</b></td></tr>')
    expect(dlg).toContain("1 of Customer Desk&#39;s recurring jobs follow the agent&#39;s model and change too; 1 name their own model and keep it.")
    expect(dlg).toContain("Spend may change: Customer Desk has spent $12.50 of its $40.00 cap this month.")
    expect(dlg).toContain("The new model applies after a daemon restart: agentx daemon restart --when-idle.")
    expect(w.writes()).toEqual([])
    // Back keeps the form as typed.
    await w.click({ "data-st-act": "back" })
    expect(w.el("st-dlg").innerHTML).toBe("")
    expect(w.el("st-bar").innerHTML).toContain("2 changes not saved.")
  })

  it("says a change that leaves the model alone moves no job and needs no restart", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-access", true)
    await w.click({ "data-st-act": "review" })
    const dlg = w.el("st-dlg").innerHTML as string
    expect(dlg).toContain("<s>Off</s> → <b>On</b>")
    expect(dlg).not.toContain("recurring")
    expect(dlg).toContain("No restart needed.")
  })

  it("saves every field in one PATCH under the Wall's guard, then shows Saved", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", "Help Desk"); await w.type("st-e-tier", "codex-cli"); await w.type("st-e-model", "")
    await w.type("st-e-triggerWords", "@help, help"); await w.type("st-e-systemPrompt", "Be brief.")
    await w.type("st-e-maxConcurrent", "3"); await w.type("st-e-maxExecutionMinutes", "30"); await w.type("st-e-permissionMode", "plan")
    await w.type("st-e-access", true); await w.type("st-e-wikiAbsorb", false)
    expect(w.el("st-bar").innerHTML).toContain("10 changes not saved. The new engine, model and permission mode needs a daemon restart.")
    const before = w.calls.filter((c) => c.url === "/api/admin/state").length
    await w.click({ "data-st-act": "review" })
    expect(w.el("st-dlg").innerHTML).toContain("<s>21 characters</s> → <b>9 characters</b>")
    await w.click({ "data-st-act": "save" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/agents", method: "PATCH", body: { id: "cx", patch: {
      name: "Help Desk", tier: "codex-cli", model: "", triggerWords: "@help, help", systemPrompt: "Be brief.",
      maxConcurrent: 3, maxExecutionMinutes: 30, permissionMode: "plan", access: "public", wikiAbsorb: false,
    } } }])
    expect(w.calls.filter((c) => c.url === "/api/admin/state").length).toBe(before + 1)
    expect(w.el("st-dlg").innerHTML).toBe("")
    expect(settingsHtml(w)).toContain("Saved. Restart the daemon for the new engine, model and permission mode to apply: agentx daemon restart --when-idle.")
  })

  it("says a save of hot-applied fields needs no restart", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", "Help Desk")
    await w.click({ "data-st-act": "review" })
    await w.click({ "data-st-act": "save" })
    expect(w.writes()[0].body.patch).toMatchObject({ name: "Help Desk", tier: "claude-code", model: "model-a", maxConcurrent: 2, access: "private", wikiAbsorb: true })
    expect(settingsHtml(w)).toContain("Saved. It applies from the agent&#39;s next run.")
  })

  it("shows a save error with the form kept as typed", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx", route: (u, i) => (u === "/api/admin/wall/settings/agents" && i.method === "PATCH" ? { status: 400, body: { error: 'Agent "cx" not found.' } } : undefined) })
    await w.settle()
    await w.type("st-e-name", "Typed name")
    const paints = w.paints()
    await w.click({ "data-st-act": "review" })
    await w.click({ "data-st-act": "save" })
    expect(w.el("st-dlg").innerHTML).toBe("")
    expect(w.el("st-n-edit").textContent).toBe('Not saved: Agent "cx" not found. The form keeps what you typed.')
    expect(w.paints()).toBe(paints)
    expect(w.el("st-bar").innerHTML).toContain("1 change not saved.")
    expect(w.el("st-e-name").value).toBe("Typed name")
  })

  it("does not send an empty name", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", "  ")
    await w.click({ "data-st-act": "review" })
    await w.click({ "data-st-act": "save" })
    expect(w.writes()).toEqual([])
    expect(w.el("st-n-dlg").textContent).toContain("the display name cannot be empty")
  })

  it("closes the dialog on Escape without saving", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", "Help Desk")
    await w.click({ "data-st-act": "review" })
    expect(w.el("st-dlg").innerHTML).toContain("Save 1 change to Customer Desk?")
    await w.key("Escape")
    expect(w.el("st-dlg").innerHTML).toBe("")
    expect(w.writes()).toEqual([])
  })

  it("adds an agent, then makes it public, as classic Settings does", async () => {
    const w = openWall({ hash: "#page=settings&section=agents" })
    await w.settle()
    w.el("st-a-id").value = "sales"; w.el("st-a-name").value = "Sales Desk"; w.el("st-a-triggers").value = "@sales"
    w.el("st-a-tier").value = "claude-code"; w.el("st-a-public").checked = true
    await w.submit({ "data-st-form": "add" })
    expect(w.writes()).toEqual([
      { url: "/api/admin/wall/settings/agents", method: "POST", body: { id: "sales", name: "Sales Desk", triggerWords: "@sales", tier: "claude-code", access: "public" } },
      { url: "/api/admin/wall/settings/agents/access", method: "POST", body: { id: "sales", access: "public" } },
    ])
    expect(settingsHtml(w)).toContain("Added @sales. It starts working after a daemon restart")
  })

  it("shows why an agent was not added", async () => {
    const w = openWall({ hash: "#page=settings&section=agents", route: (u, i) => (u === "/api/admin/wall/settings/agents" && i.method === "POST" ? { status: 400, body: { error: "At least one trigger word is required." } } : undefined) })
    await w.settle()
    await w.submit({ "data-st-form": "add" })
    expect(w.el("st-n-add").textContent).toBe("Not added: At least one trigger word is required.")
  })

  it("saves the wiki page curator", async () => {
    const w = openWall({ hash: "#page=settings&section=agents" })
    await w.settle()
    w.el("st-wc-on").checked = false; w.el("st-wc-agent").value = "cx"
    await w.submit({ "data-st-form": "curator" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/wiki/curator", method: "POST", body: { enabled: false, agent: "cx" } }])
  })

  it("asks before deleting an agent, then deletes it and goes back to the list", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.click({ "data-st-act": "ask", "data-key": "delete" })
    expect(w.writes()).toEqual([])
    expect(settingsHtml(w)).toContain("Delete @cx for good?")
    await w.click({ "data-st-act": "cancel" })
    expect(settingsHtml(w)).not.toContain("Delete @cx for good?")
    await w.click({ "data-st-act": "ask", "data-key": "delete" })
    await w.click({ "data-st-act": "confirm", "data-key": "delete" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/agents", method: "DELETE", body: { id: "cx" } }])
    await w.settle()
    expect(settingsHtml(w)).toContain("Deleted @cx. Its workspace folder is still on disk.")
    expect(settingsHtml(w)).not.toContain("data-st-form=\"edit\"")
  })

  it("adds and, after asking, removes an integration with only an env var name", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&atab=channels" })
    await w.settle()
    expect(settingsHtml(w)).toContain("tokenEnv not set")
    w.el("st-i-kind").value = "linear"; w.el("st-i-label").value = "Tracker"; w.el("st-i-env").value = "LINEAR_TOKEN"; w.el("st-i-meta").value = "team=core, region"
    await w.submit({ "data-st-form": "int", "data-id": "cx" })
    expect(w.writes()[0]).toEqual({ url: "/api/admin/wall/settings/agents/integrations", method: "POST",
      body: { agentId: "cx", kind: "linear", label: "Tracker", credentials: { tokenEnv: "LINEAR_TOKEN" }, metadata: { team: "core", region: "" } } })
    await w.click({ "data-st-act": "ask", "data-key": "int:0" })
    expect(w.writes()).toHaveLength(1)
    await w.click({ "data-st-act": "confirm", "data-key": "int:0" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/agents/integrations", method: "DELETE", body: { agentId: "cx", kind: "custom", label: "Team CRM" } })
  })

  it("refuses an integration with no token variable before calling the API", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&atab=channels" })
    await w.settle()
    w.el("st-i-kind").value = "linear"; w.el("st-i-label").value = "Tracker"
    await w.submit({ "data-st-form": "int", "data-id": "cx" })
    expect(w.writes()).toEqual([])
    expect(w.el("st-n-int-add").textContent).toContain("environment variable")
  })

  it("lists, opens and saves an agent's files, and asks before deleting a skill", async () => {
    const files = { identity: [{ path: "CLAUDE.md", title: "CLAUDE.md", exists: true, size: 2048 }], skills: [{ path: ".claude/skills/report/SKILL.md", slug: "report", title: "Weekly report" }] }
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&atab=personality", route: (u) =>
      u.startsWith("/api/admin/files?") ? { status: 200, body: files }
      : u.startsWith("/api/admin/files/read?") ? { status: 200, body: { content: "# Customer Desk" } } : undefined })
    await w.settle()
    // Personality opens with the instruction files listed; the skills are on Skills.
    expect(settingsHtml(w)).toContain("CLAUDE.md<small>2 KB</small>")
    expect(settingsHtml(w)).not.toContain("Weekly report")
    await w.click({ "data-st-act": "open-file", "data-path": "CLAUDE.md" })
    expect(w.calls.some((c) => c.url === "/api/admin/files/read?agent=cx&path=CLAUDE.md")).toBe(true)
    expect(settingsHtml(w)).toContain("# Customer Desk</textarea>")
    w.el("st-f-text").value = "# Help Desk"
    await w.click({ "data-st-act": "save-file" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/files", method: "PUT", body: { agent: "cx", path: "CLAUDE.md", content: "# Help Desk" } }])
    await w.go("#page=settings&section=agents&agent=cx&atab=skills")
    expect(settingsHtml(w)).toContain("Weekly report<small>report</small>")
    await w.click({ "data-st-act": "ask", "data-key": "skill:0" })
    expect(settingsHtml(w)).toContain('Delete the skill "report"?')
    await w.click({ "data-st-act": "confirm", "data-key": "skill:0" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/files/skill", method: "DELETE", body: { agent: "cx", slug: "report" } })
  })

  it("lists an agent's handovers both ways, releases one after asking, and hands a chat over", async () => {
    const HO = {
      outgoing: [{ channel: "telegram", chatId: "1001", fromAgent: "cx", toAgent: "ops", summary: "Pricing question", createdAt: "2026-10-01T00:00:00Z" }],
      incoming: [{ channel: "whatsapp", chatId: "+10000000000", accountId: "main", fromAgent: "new", toAgent: "cx", expiresAt: "2026-12-01", createdAt: "2026-10-02T00:00:00Z" }],
    }
    let reads = 0
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&atab=handovers", route: (u, init) =>
      u === "/api/admin/agent/cx/handovers" && !init.method ? (reads++, { status: 200, body: HO }) : undefined })
    await w.settle()
    expect(reads).toBe(1)
    const html = settingsHtml(w)
    expect(html).not.toContain("Open the classic agent page")
    expect(html.split("<h4>Routed to")[0]).toContain("<b>telegram · 1001</b><small>handed to @ops · no end · note not read yet</small>")
    expect(html.split("<h4>Routed to")[1]).toContain("<b>whatsapp · +10000000000 · main</b><small>from @new · until 2026-12-01</small>")
    // Hand to lists the other agents only.
    expect(html).toContain('<option value="ops">Night Shift (ops)</option>')
    expect(html).not.toContain('<option value="cx">')
    await w.click({ "data-st-act": "ask", "data-key": "ho:in:0" })
    expect(w.writes()).toEqual([])
    expect(settingsHtml(w)).toContain("Release whatsapp +10000000000? Its next message goes where agentx.json routes it.")
    await w.click({ "data-st-act": "confirm", "data-key": "ho:in:0" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/agent/cx/handovers", method: "DELETE", body: { channel: "whatsapp", chatId: "+10000000000", accountId: "main" } }])
    expect(reads).toBe(2)
    expect(settingsHtml(w)).toContain("Released whatsapp +10000000000.")
    // A chat id and an agent are needed before any call.
    await w.submit({ "data-st-form": "ho" })
    expect(w.writes()).toHaveLength(1)
    expect(w.el("st-n-ho-add").textContent).toBe("Write the chat id and pick the agent that takes it.")
    w.el("st-h-chat").value = " 2002 "; w.el("st-h-to").value = "ops"; w.el("st-h-note").value = "They asked for a quote."
    await w.submit({ "data-st-form": "ho" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/agent/cx/handovers", method: "POST",
      body: { channel: "telegram", chatId: "2002", toAgent: "ops", summary: "They asked for a quote." } })
    expect(settingsHtml(w)).toContain("Handed telegram 2002 to @ops.")
  })

  it("shows why the handovers could not be read, with a way to try again", async () => {
    let fail = true
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&atab=handovers", route: (u) =>
      u === "/api/admin/agent/cx/handovers" ? (fail ? { status: 400, body: { error: "store locked" } } : { status: 200, body: { incoming: [], outgoing: [] } }) : undefined })
    await w.settle()
    expect(settingsHtml(w)).toContain("Could not read the handovers: store locked")
    fail = false
    await w.click({ "data-st-act": "ho-load" })
    expect(settingsHtml(w)).toContain("No chat is routed away from Customer Desk.")
    expect(settingsHtml(w)).toContain("No chat is routed to Customer Desk.")
  })

  it("test-drives an agent and shows its answer or its error", async () => {
    let fail = false
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx", route: (u, i) =>
      u === "/api/admin/wall/settings/agents/test" && i.method === "POST" ? (fail ? { status: 400, body: { error: "agent is busy" } } : { status: 200, body: { response: { content: "Hello there" } } }) : undefined })
    await w.settle()
    w.el("st-td-text").value = "Hi"
    await w.click({ "data-st-act": "td-send", "data-id": "cx" })
    const sent = w.writes()[0]
    expect(sent.url).toBe("/api/admin/wall/settings/agents/test")
    expect(sent.body.agent).toBe("cx")
    expect(sent.body.message).toBe("Hi")
    expect(w.el("st-td-log").innerHTML).toContain('<li class="wtd__m is-agent">Hello there</li>')
    fail = true
    w.el("st-td-text").value = "Again"
    await w.click({ "data-st-act": "td-send", "data-id": "cx" })
    expect(w.writes()[1].body.chatId).toBe(sent.body.chatId)
    expect(w.el("st-td-log").innerHTML).toContain('<li class="wtd__m is-err">agent is busy</li>')
  })
})

describe("Every other Wall page sends no settings write (#1428)", () => {
  const SETTINGS_WRITES = ["/api/admin/wall/settings/", "/api/admin/agents", "/api/admin/org/hold", "/api/admin/wiki/curator", "/api/admin/files"]
  const PAGES = ["#status=open", "#status=waiting_owner", "#page=running", "#page=agents", "#page=live", "#page=creator",
    "#status=open&view=list", "#status=open&view=projects", "#status=open&view=jobs", "#status=open&view=reviews", "#status=open&view=failures"]

  it("sends no write call while any other page loads, even for the owner", async () => {
    for (const hash of PAGES) {
      const w = openWall({ hash })
      await w.settle()
      expect(w.writes(), hash).toEqual([])
      expect(w.calls.some((c) => c.url === "/api/admin/state"), hash).toBe(false)
    }
  })

  it("ignores a Settings control outside #page=settings", async () => {
    const w = openWall({ hash: "#page=agents" })
    await w.settle()
    await w.click({ "data-st-hold": "cx" })
    await w.click({ "data-st-act": "confirm", "data-key": "delete" })
    expect(w.writes().filter((c) => SETTINGS_WRITES.some((p) => c.url.startsWith(p)))).toEqual([])
  })
})

describe("/wall gives Settings to the owner only (#1428)", () => {
  const TOKEN = "dash-secret"
  const OFF = { "X-Forwarded-For": "100.64.0.9" }
  let server: Server | undefined
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  })
  async function start(token: string | null = TOKEN): Promise<string> {
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: "http://daemon.invalid:18800", ...(token ? { token } : {}) } })
    const ctx = { boards: [], sources: new Map(), token: token || undefined, config } as unknown as Ctx
    server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it("draws Settings on this machine and for a signed-in browser; anyone else gets no page and no API", async () => {
    const base = await start()
    expect(await (await fetch(base + "/wall")).text()).toContain('data-nav="settings" href="#page=settings"')
    const signIn = await fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { ...OFF, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: TOKEN, next: "/wall" }).toString() })
    const cookie = (signIn.headers.get("set-cookie") || "").split(";")[0]
    expect(await (await fetch(base + "/wall", { headers: { ...OFF, Cookie: cookie } })).text()).toContain('data-nav="settings" href="#page=settings"')
    const stranger = await fetch(base + "/wall", { headers: OFF, redirect: "manual" })
    expect(stranger.status).toBe(302)
    expect(await stranger.text()).not.toContain("AX_WALL_SETTINGS")
    expect((await fetch(`${base}/api/admin/state`, { headers: OFF })).status).toBe(401)
    expect((await fetch(`${base}/api/admin/agents`, { method: "PATCH", headers: OFF, body: "{}" })).status).toBe(401)
    expect((await fetch(`${base}/api/admin/wall/settings/agents`, { method: "PATCH", headers: OFF, body: "{}" })).status).toBe(401)
  })

  it("with no dashboard token, draws Settings on this machine only, as the writes allow", async () => {
    const base = await start(null)
    expect(await (await fetch(base + "/wall")).text()).toContain('data-nav="settings" href="#page=settings"')
    const off = await (await fetch(base + "/wall", { headers: OFF })).text()
    expect(off).not.toContain('data-nav="settings"')
    expect(off).not.toContain("window.AX_WALL_SETTINGS =")
    expect((await fetch(`${base}/api/admin/wall/settings/agents`, { method: "PATCH", headers: { ...OFF, "X-Requested-With": "agentx-board" }, body: "{}" })).status).toBe(401)
  })

  it("serves Settings' writes under /api/admin/wall/settings with the classic handlers, and nothing else there", async () => {
    const base = await start()
    const auth = { Authorization: `Bearer ${TOKEN}`, "X-Requested-With": "agentx-board", "Content-Type": "application/json" }
    // An empty edit: the classic handler answers it (no 404, no 401).
    const r = await fetch(`${base}/api/admin/wall/settings/agents`, { method: "PATCH", headers: auth, body: "{}" })
    expect(r.status).toBe(400)
    expect((await r.json()).error).not.toMatch(/unknown|not found/)
    // A classic admin route that Settings does not use is not reachable through the Wall's prefix.
    expect((await fetch(`${base}/api/admin/wall/settings/boards`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404)
    expect((await fetch(`${base}/api/admin/wall/settings/agents`, { method: "PUT", headers: auth, body: "{}" })).status).toBe(404)
    // Handovers go to the classic agent page's handler: a release with no chat is its own 400.
    const ho = await fetch(`${base}/api/admin/wall/settings/agent/cx/handovers`, { method: "DELETE", headers: auth, body: "{}" })
    expect(ho.status).toBe(400)
    expect((await ho.json()).error).toBe("channel and chatId required")
    // Its other routes, and a read, are not under the prefix.
    expect((await fetch(`${base}/api/admin/wall/settings/agent/cx/mcp`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404)
    expect((await fetch(`${base}/api/admin/wall/settings/agent/cx`, { method: "PATCH", headers: auth, body: "{}" })).status).toBe(404)
  })
})
