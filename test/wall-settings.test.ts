import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"

// #1428: Settings on the Wall, phase 1 (the shell, Agents and Health), as
// the accepted screen draws it (notes/design/wall-v2-round-2.md §2). It
// writes settings for the owner only (#1449), with the endpoints classic
// /admin calls; every other Wall page sends no settings write. These run the
// page's real script against a stubbed DOM and fetch.

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
  nodeName: "node-a",
  telegram: { enabled: true, accounts: [{ id: "main" }] }, slack: { enabled: false, botTokenRef: "SLACK_TOKEN" }, discord: { enabled: false },
  crons: [{ id: "daily-digest", agent: "cx", schedule: "0 9 * * *" }, { id: "weekly-report", agent: "cx", schedule: "0 9 * * 1", model: "model-b" }, { id: "nightly", agent: "ops", schedule: "0 2 * * *" }],
}
const BUDGETS = { agents: [{ agentId: "cx", spentUsd: 3, capUsd: 40, state: "ok" }], agentIds: ["cx", "ops", "new"] }
const ORG = {
  roots: [{ id: "cx", name: "Customer Desk", title: "Support lead", status: "idle", reports: [{ id: "ops", name: "Night Shift", status: "paused", heldBy: "the owner", reports: [] }] }],
  outside: [{ id: "new", name: "New Hire", status: "waiting", reports: [] }],
  live: true,
}
const LIVE = { nodes: [
  { name: "node-a", url: "http://node-a", reachable: true, version: "1.2.3", agents: [{ id: "cx", name: "Customer Desk", runningTasks: [] }, { id: "ops", name: "Night Shift", runningTasks: [] }] },
  { name: "node-b", url: "http://node-b", reachable: false, error: "timed out", agents: [{ id: "far", name: "Far Away", runningTasks: [] }] },
] }

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
        : url.startsWith("/api/live") ? { status: 200, body: LIVE }
        : url === "/api/admin/observability/budgets" ? { status: 200, body: BUDGETS }
        : url === "/api/admin/tokens" ? { status: 200, body: [{ id: "t1" }, { id: "t2", revokedAt: "2026-01-01" }] }
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
  /** Types into a field: sets its value and sends the input event, as a browser does. */
  const type = async (id: string, v: string) => {
    const e = el(id)
    e.value = v
    for (const f of onDoc.input ?? []) f({ target: e })
    await settle()
  }
  const writes = () => calls.filter((c) => c.method !== "GET")
  return { page, el, calls, writes, settle, go, click, submit, type, paints: () => paints, wall }
}

const settingsHtml = (w: ReturnType<typeof openWall>) => w.el("wall-settings")!.innerHTML as string

describe("Wall Settings: owner only (#1428)", () => {
  it("draws the Settings entry, section and config only for the owner", () => {
    const owner = renderWallPage({ owner: true })
    expect(owner).toContain('data-nav="settings" href="#page=settings"')
    expect(owner).toContain('<section id="wall-settings"')
    expect(owner).toContain('window.AX_WALL_SETTINGS = {"business":false}')
    const other = renderWallPage({ owner: false })
    expect(other).not.toContain('data-nav="settings" href')
    expect(other).not.toContain("window.AX_WALL_SETTINGS =")
    // Opening the address anyway says whose page it is (§2).
    expect(other).toContain("Settings are for the owner.")
    // The default is no Settings: a caller must say the viewer is the owner.
    expect(renderWallPage()).not.toContain('data-nav="settings" href')
  })

  it("tells a viewer who is not the owner that Settings are the owner's, and reads nothing", async () => {
    const w = openWall({ hash: "#page=settings", owner: false })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Settings")
    expect(w.el("wall-settings").hidden).toBe(false)
    expect(w.page).toContain('<p class="ax-wall__empty wst__notowner">Settings are for the owner.')
    expect(w.calls.some((c) => c.url === "/api/admin/state")).toBe(false)
    expect(w.el("wall-feed").hidden).toBe(true)
  })

  it("says so when the API refuses the viewer", async () => {
    const w = openWall({ hash: "#page=settings&section=agents", route: (u) => (u === "/api/admin/state" ? { status: 401, body: { error: "unauthorized" } } : undefined) })
    await w.settle()
    expect(settingsHtml(w)).toContain("Settings are for the owner.")
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

  it("lists the sections grouped Fleet, Access and Machines, and links unported ones to their classic place", async () => {
    const w = openWall({ hash: "#page=settings" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Settings")
    expect(w.el("wall-st-chip").hidden).toBe(false)
    expect(w.el("wall-settings").hidden).toBe(false)
    expect(w.wall.classList.contains("is-settings")).toBe(true)
    const html = settingsHtml(w)
    expect([...html.matchAll(/<h2 class="wst__grp">(\w+)<\/h2>/g)].map((m) => m[1])).toEqual(["Fleet", "Access", "Machines"])
    expect([...html.matchAll(/class="wst__sec[^"]*"[^>]*><span>(\w+)<\/span>/g)].map((m) => m[1])).toEqual(
      ["Agents", "Channels", "Schedules", "Webhooks", "Mesh", "Boards", "Actions", "Inbox", "Guests", "People", "Tokens", "Health", "Advanced"])
    expect(html).not.toContain("<span>Business</span>")
    // The agent count, and an amber count where something needs attention.
    expect(html).toContain('<span>Agents</span><b class="wst__c">3</b>')
    expect(html).toContain('<span>Health</span><b class="wst__c is-warn" title="Needs attention">1</b>')
    // The phone's list has Health on top and one line under each section.
    expect(html).toContain('id="st-health-phone"')
    expect(html).toContain('<i class="wst__about">3 agents, their pictures, models and on/off</i>')
    // No section in the link: on a phone the list is the screen.
    expect(html).toContain('<div class="wst">')
    await w.go("#page=settings&section=channels")
    expect(settingsHtml(w)).toContain('<div class="wst has-section">')
    expect(settingsHtml(w)).toContain('href="/admin#tab=channels"')
    await w.go("#page=settings&section=schedules")
    expect(settingsHtml(w)).toContain('href="/admin#tab=crons"')
    await w.go("#page=settings&section=people")
    expect(settingsHtml(w)).toContain('<a class="ax-btn" href="#page=people">Open People on the Wall</a>')
    await w.go("#page=settings&section=guests")
    expect(settingsHtml(w)).toContain('<a class="ax-btn" href="/guests">Open Guests on its classic page</a>')
  })

  it("shows Health: the strip, one line per machine and what to fix", async () => {
    const w = openWall({ hash: "#page=settings&section=health" })
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("<b>2 of 3</b><span>agents online</span>")
    expect(html).toContain("<b>1 of 2</b><span>channels on</span>")
    expect(html).toContain('<div class="wsh__s is-warn"><b>1</b><span>needs attention</span>')
    expect(html).toContain("<b>1</b><span>active tokens</span>")
    expect(html).toContain('<li class="is-up"><i aria-hidden="true"></i><b>node-a</b><span>answering · v1.2.3</span></li>')
    expect(html).toContain('<li class="is-down"><i aria-hidden="true"></i><b>node-b</b><span>not answering</span></li>')
    expect(html).toContain('node-b does not answer: timed out. <a href="#page=live">See it on Live</a>')
    expect(w.writes()).toEqual([])
  })

  it("lists Business only when the business layer is on", async () => {
    const w = openWall({ hash: "#page=settings", business: true })
    await w.settle()
    expect(settingsHtml(w)).toContain("<span>Business</span>")
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

  it("opens one agent with the classic tabs, its picture and its switch on top", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Customer Desk")
    const html = settingsHtml(w)
    expect(html).toContain('<a href="#page=settings&amp;section=agents">Agents</a> › Customer Desk · on node-a')
    expect([...html.matchAll(/role="tab" href="[^"]*" class="[^"]*" aria-selected="(?:true|false)">(\w+)<\/a>/g)].map((m) => m[1])).toEqual(
      ["Overview", "Personality", "Skills", "Channels", "Handovers"])
    expect(html).toContain('aria-selected="true">Overview</a>')
    expect(html).toContain('role="switch" aria-checked="true" data-st-hold="cx"')
    expect(html).toContain('<form class="wsf wsc wse-form" data-st-form="edit" data-id="cx" novalidate>')
    expect(html).toContain('id="st-e-name" data-st-f="name" class="" aria-describedby="st-e-name-was" maxlength="80" value="Customer Desk"')
    for (const label of ["Display name", "Wake words", "AI engine", "Model", "Conversations at once", "Longest task, minutes", "Who can reach it", "Tool permissions", "Add its conversations to the wiki", "Instructions"]) {
      expect(html).toContain(`<span>${label}`)
    }
  })

  it("turns a changed field blue, says what it was, and counts the changes in the bar", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    expect(w.el("st-bar").className).toBe("wsb is-empty")
    await w.type("st-e-maxConcurrent", "3")
    expect(w.el("st-e-maxConcurrent").classList.contains("is-changed")).toBe(true)
    expect(w.el("st-e-maxConcurrent-was").textContent).toBe("Changed from 2.")
    expect(w.el("st-bar").innerHTML).toContain("1 change not saved. It applies without a restart.")
    await w.type("st-e-model", "model-b")
    expect(w.el("st-e-model-was").textContent).toBe("Changed from model-a. Needs a restart.")
    expect(w.el("st-bar").innerHTML).toContain("2 changes not saved. The new model needs a restart.")
    expect(w.el("st-bar").innerHTML).toContain('data-st-act="discard">Discard</button>')
    expect(w.el("st-bar").innerHTML).toContain('data-st-act="review">Save…</button>')
    // Typing back the saved value is no change.
    await w.type("st-e-maxConcurrent", "2")
    expect(w.el("st-e-maxConcurrent").classList.contains("is-changed")).toBe(false)
    expect(w.el("st-bar").innerHTML).toContain("1 change not saved.")
    expect(w.writes()).toEqual([])
  })

  it("keeps what was typed across tabs, and Discard puts the saved values back", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", "Help Desk")
    await w.go("#page=settings&section=agents&agent=cx&tab=channels")
    await w.go("#page=settings&section=agents&agent=cx")
    expect(settingsHtml(w)).toContain('class="is-changed" aria-describedby="st-e-name-was" maxlength="80" value="Help Desk"')
    expect(w.el("st-bar").innerHTML).toContain("1 change not saved.")
    await w.click({ "data-st-act": "discard" })
    expect(settingsHtml(w)).toContain('value="Customer Desk"')
    expect(w.el("st-bar").className).toBe("wsb is-empty")
    expect(w.writes()).toEqual([])
  })

  it("confirms with the before and after, the agent's jobs and its cap, then saves only what changed", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-model", "model-b")
    await w.type("st-e-maxConcurrent", "3")
    await w.click({ "data-st-act": "review" })
    expect(w.writes()).toEqual([])
    const dlg = w.el("st-dialog").innerHTML
    expect(dlg).toContain('role="dialog" aria-modal="true"')
    expect(dlg).toContain("Save 2 changes to Customer Desk?")
    expect(dlg).toContain('<th scope="row">Model</th><td><s>model-a</s> → <b>model-b</b></td>')
    expect(dlg).toContain('<th scope="row">Conversations at once</th><td><s>2</s> → <b>3</b></td>')
    expect(dlg).toContain("Customer Desk&#39;s recurring job follows the agent&#39;s model, so it changes too.")
    expect(dlg).toContain("The job weekly-report names its own model (model-b) and keeps it: change it on Jobs to match.")
    expect(dlg).toContain("Spend may change: Customer Desk&#39;s month cap is $40.")
    expect(dlg).toContain("The new model applies after a restart: agentx daemon restart --when-idle.")
    // Back closes it and keeps the changes.
    await w.click({ "data-st-act": "back" })
    expect(w.el("st-dialog").innerHTML).toBe("")
    expect(w.el("st-bar").innerHTML).toContain("2 changes not saved.")
    await w.click({ "data-st-act": "review" })
    const before = w.calls.filter((c) => c.url === "/api/admin/state").length
    await w.click({ "data-st-act": "save" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/agents", method: "PATCH", body: { id: "cx", patch: { model: "model-b", maxConcurrent: 3 } } }])
    expect(w.calls.filter((c) => c.url === "/api/admin/state").length).toBe(before + 1)
    expect(w.el("st-bar").innerHTML).toContain("Saved. Restart the daemon for the new model to apply: agentx daemon restart --when-idle.")
  })

  it("sends every Overview field with the classic PATCH's names and types", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", " Help Desk "); await w.type("st-e-tier", "codex-cli"); await w.type("st-e-model", ""); await w.type("st-e-triggerWords", "@help, help")
    await w.type("st-e-systemPrompt", "Be brief."); await w.type("st-e-maxConcurrent", "3"); await w.type("st-e-maxExecutionMinutes", "30"); await w.type("st-e-permissionMode", "plan")
    await w.type("st-e-access", "public"); await w.type("st-e-wikiAbsorb", "off")
    await w.click({ "data-st-act": "review" })
    expect(w.el("st-dialog").innerHTML).toContain('<th scope="row">Instructions</th><td><s>the saved text</s> → <b>the new text (9 characters)</b></td>')
    await w.click({ "data-st-act": "save" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/agents", method: "PATCH", body: { id: "cx", patch: {
      name: "Help Desk", triggerWords: "@help, help", tier: "codex-cli", model: "", maxConcurrent: 3, maxExecutionMinutes: 30,
      access: "public", permissionMode: "plan", wikiAbsorb: false, systemPrompt: "Be brief.",
    } } }])
    expect(w.el("st-bar").innerHTML).toContain("Saved. Restart the daemon for the new engine, model and permission mode to apply")
  })

  it("says a save of hot-applied fields needs no restart", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", "Help Desk")
    await w.click({ "data-st-act": "review" })
    expect(w.el("st-dialog").innerHTML).toContain("No restart needed: it applies from the agent&#39;s next run.")
    // A name change moves no job and no spend.
    expect(w.el("st-dialog").innerHTML).not.toContain("recurring job")
    expect(w.el("st-dialog").innerHTML).not.toContain("Spend may change")
    await w.click({ "data-st-act": "save" })
    expect(w.el("st-bar").innerHTML).toContain("Saved. It applies from the agent&#39;s next run.")
  })

  it("shows a save error in the bar and keeps the form as it was typed", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx", route: (u, i) => (u === "/api/admin/wall/settings/agents" && i.method === "PATCH" ? { status: 400, body: { error: 'Agent "cx" not found' } } : undefined) })
    await w.settle()
    await w.type("st-e-name", "Typed name")
    const paints = w.paints()
    await w.click({ "data-st-act": "review" })
    await w.click({ "data-st-act": "save" })
    expect(w.el("st-dialog").innerHTML).toBe("")
    expect(w.el("st-bar").innerHTML).toContain("Not saved: Agent &quot;cx&quot; not found. 1 change not saved.")
    expect(w.el("st-bar").className).toBe("wsb is-dirty is-err")
    expect(w.paints()).toBe(paints)
    expect(w.el("st-e-name").value).toBe("Typed name")
  })

  it("does not send an empty name or a number out of range", async () => {
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx" })
    await w.settle()
    await w.type("st-e-name", "  ")
    await w.click({ "data-st-act": "review" })
    await w.click({ "data-st-act": "save" })
    expect(w.writes()).toEqual([])
    expect(w.el("st-bar").innerHTML).toContain("Not saved: The display name cannot be empty.")
    await w.type("st-e-name", "Customer Desk")
    await w.type("st-e-maxExecutionMinutes", "999")
    await w.click({ "data-st-act": "review" })
    await w.click({ "data-st-act": "save" })
    expect(w.writes()).toEqual([])
    expect(w.el("st-bar").innerHTML).toContain("Longest task, minutes must be a number from 1 to 240.")
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
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&tab=channels" })
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
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&tab=channels" })
    await w.settle()
    w.el("st-i-kind").value = "linear"; w.el("st-i-label").value = "Tracker"
    await w.submit({ "data-st-form": "int", "data-id": "cx" })
    expect(w.writes()).toEqual([])
    expect(w.el("st-n-int-add").textContent).toContain("environment variable")
  })

  it("opens the instruction files on Personality and the skills on Skills, and asks before deleting a skill", async () => {
    const files = { identity: [{ path: "CLAUDE.md", title: "CLAUDE.md", exists: true, size: 2048 }], skills: [{ path: ".claude/skills/report/SKILL.md", slug: "report", title: "Weekly report" }] }
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&tab=personality", route: (u) =>
      u.startsWith("/api/admin/files?") ? { status: 200, body: files }
      : u.startsWith("/api/admin/files/read?") ? { status: 200, body: { content: "# Customer Desk" } } : undefined })
    await w.settle()
    expect(settingsHtml(w)).toContain("CLAUDE.md<small>2 KB</small>")
    expect(settingsHtml(w)).not.toContain("Weekly report")
    await w.click({ "data-st-act": "open-file", "data-path": "CLAUDE.md" })
    expect(w.calls.some((c) => c.url === "/api/admin/files/read?agent=cx&path=CLAUDE.md")).toBe(true)
    expect(settingsHtml(w)).toContain("# Customer Desk</textarea>")
    w.el("st-f-text").value = "# Help Desk"
    await w.click({ "data-st-act": "save-file" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/files", method: "PUT", body: { agent: "cx", path: "CLAUDE.md", content: "# Help Desk" } }])
    await w.go("#page=settings&section=agents&agent=cx&tab=skills")
    expect(settingsHtml(w)).toContain("Weekly report<small>report</small>")
    expect(settingsHtml(w)).toContain("Add a skill")
    await w.click({ "data-st-act": "ask", "data-key": "skill:0" })
    expect(settingsHtml(w)).toContain('Delete the skill "report"?')
    await w.click({ "data-st-act": "confirm", "data-key": "skill:0" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/files/skill", method: "DELETE", body: { agent: "cx", slug: "report" } })
  })

  it("lists handovers, releases one after asking, and hands a chat over", async () => {
    const ho = { incoming: [], outgoing: [{ channel: "telegram", chatId: "1001", toAgent: "ops", createdAt: "2026-10-01", summary: "Pricing question" }] }
    const w = openWall({ hash: "#page=settings&section=agents&agent=cx&tab=handovers", route: (u, i) =>
      u === "/api/admin/agent/cx/handovers" && (i.method || "GET") === "GET" ? { status: 200, body: ho } : undefined })
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("<b>telegram · 1001</b><small>handed to ops · no end · note waiting</small>")
    expect(html).toContain("No chat is routed to this agent.")
    await w.click({ "data-st-act": "ask", "data-key": "ho:out:0" })
    expect(w.writes()).toEqual([])
    expect(settingsHtml(w)).toContain("Release telegram 1001?")
    await w.click({ "data-st-act": "confirm", "data-key": "ho:out:0" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/agent/cx/handovers", method: "DELETE", body: { channel: "telegram", chatId: "1001" } }])
    w.el("st-h-ch").value = "whatsapp"; w.el("st-h-chat").value = "+10000000000"; w.el("st-h-to").value = "ops"
    await w.submit({ "data-st-form": "ho" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/agent/cx/handovers", method: "POST", body: { channel: "whatsapp", chatId: "+10000000000", toAgent: "ops" } })
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
  const SETTINGS_WRITES = ["/api/admin/wall/settings/"]
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
    await w.click({ "data-st-act": "save" })
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
  async function start(): Promise<string> {
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: "http://daemon.invalid:18800", token: TOKEN } })
    const ctx = { boards: [], sources: new Map(), token: TOKEN, config } as unknown as Ctx
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

  it("runs a Settings write as the classic route it names, past the owner guard, and nothing else", async () => {
    const base = await start()
    const owner = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }
    // No id: the classic handler answers, so the write reached it.
    const r = await fetch(`${base}/api/admin/wall/settings/agents`, { method: "PATCH", headers: owner, body: "{}" })
    expect((await r.json()).error).toMatch(/Agent id is required|agentx\.json/)
    expect((await fetch(`${base}/api/admin/wall/settings/config/raw`, { method: "POST", headers: owner, body: "{}" })).status).toBe(404)
    expect((await fetch(`${base}/api/admin/wall/settings/agents`, { method: "PUT", headers: owner, body: "{}" })).status).toBe(404)
    expect((await fetch(`${base}/api/admin/wall/settings/tokens`, { method: "POST", headers: owner, body: "{}" })).status).toBe(404)
  })
})
