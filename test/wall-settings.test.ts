import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import type { IncomingMessage, ServerResponse } from "http"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import { handleAdminApi, secretRef } from "../src/daemon/admin-panel"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { LIVE, ORG, openWall, settingsHtml, STATE, type Route } from "./wall-settings-harness"

// #1428: Settings on the Wall, phase 1 (the shell and the Agents section).
// It writes settings for the owner only (#1449), with the endpoints classic
// /admin calls; every other Wall page sends no settings write. These run the page's real script
// against a stubbed DOM and fetch (wall-settings-harness.ts).

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

  it("offers sign-in to a viewer who is not the owner only when the dashboard has a token (#1619)", async () => {
    // No dashboard.token: the off-box viewer /admin now sends here; /login only goes back to /.
    const open = openWall({ hash: "#page=settings", owner: false })
    await open.settle()
    expect(settingsHtml(open)).toContain("This dashboard has no sign-in")
    expect(settingsHtml(open)).not.toContain('href="/login"')
    const signed = openWall({ hash: "#page=settings", owner: false, signIn: true })
    await signed.settle()
    expect(settingsHtml(signed)).toContain('<a href="/login">sign in</a> with the dashboard token')
    // The owner's page carries no sign-in flag.
    expect(renderWallPage({ owner: true, signIn: true })).not.toContain("window.AX_WALL_SIGN_IN = true")
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
    expect(renderWallPage({ owner: true })).toContain('data-nav="settings" href="#page=settings"')
    // Classic Settings redirects to the Hub's now (#1447): no one is sent there.
    for (const owner of [true, false]) expect(renderWallPage({ owner })).not.toContain('href="/admin"')
    const w = openWall({ hash: "#page=agents" })
    await w.settle()
    const html = w.el("wall-agents-page").innerHTML
    expect(html).toContain('<a href="#page=settings&amp;section=agents&amp;agent=cx">Settings</a>')
    expect(html).not.toContain('href="/admin/agents/cx"')
  })

  it("lists every section in its group, the chosen one first on a phone, with none left on the classic page", async () => {
    const w = openWall({ hash: "#page=settings" })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Settings")
    expect(w.el("wall-settings").hidden).toBe(false)
    expect(w.wall.classList.contains("is-settings")).toBe(true)
    const html = settingsHtml(w)
    const groups = html.split("</nav>")[0].split('<h3 class="wst__grp">').slice(1).map((g) => [g.split("<")[0], [...g.matchAll(/<span>([^<]+)<small/g)].map((m) => m[1])])
    expect(groups).toEqual([
      ["Fleet", ["Agents", "Channels", "Schedules", "Webhooks", "Mesh", "Boards", "Actions", "Inbox", "Requests"]],
      ["Access", ["Guests", "People", "Tokens"]],
      ["Machines", ["Health", "Diagnostics", "Screen capture", "Advanced"]],
    ])
    expect(html).toContain("3 agents, their pictures, models and on/off")
    // Every section is on the Hub (#1428 phase 3): only Guests and People open their own pages.
    expect(html.match(/is-classic/g)).toHaveLength(2)
    expect(html).not.toContain('href="/admin')
    // No section in the link: on a phone the list is the screen.
    expect(html).toContain('<div class="wst">')
    await w.go("#page=settings&section=channels")
    expect(settingsHtml(w)).toContain('<div class="wst has-section">')
    expect(settingsHtml(w)).not.toContain('href="/admin#tab=channels"')
    await w.go("#page=settings&section=inbox")
    expect(settingsHtml(w)).not.toContain('href="/admin#tab=channels"')
    expect(settingsHtml(w)).toContain("<h2>Inbox</h2>")
    await w.go("#page=settings&section=schedules")
    expect(settingsHtml(w)).not.toContain('href="/admin#tab=crons"')
    expect(settingsHtml(w)).toContain("Add a schedule")
    for (const [sec, h2] of [["mesh", "Mesh"], ["boards", "Boards"], ["actions", "Actions"], ["tokens", "Tokens"], ["requests", "Requests"], ["screen", "Screen capture"], ["advanced", "Advanced"]]) {
      await w.go(`#page=settings&section=${sec}`)
      expect(settingsHtml(w), sec).toContain(`<h2>${h2}</h2>`)
      expect(settingsHtml(w), sec).not.toContain('href="/admin')
    }
    await w.go("#page=settings&section=guests")
    expect(settingsHtml(w)).toContain("Guests has its own page.")
    expect(settingsHtml(w)).toContain('href="/guests"')
    await w.go("#page=settings&section=people")
    expect(settingsHtml(w)).toContain("People has its own page on the Hub.")
    expect(settingsHtml(w)).toContain('href="#page=people"')
  })

  it("lists Business only when the business layer is on", async () => {
    const w = openWall({ hash: "#page=settings" })
    await w.settle()
    expect(settingsHtml(w)).not.toContain("<span>Business<small")
    const b = openWall({ hash: "#page=settings", business: true })
    await b.settle()
    expect(settingsHtml(b)).toContain("<span>Business<small")
    // With the business layer off, its section is not drawn even by its link.
    await w.go("#page=settings&section=business")
    expect(settingsHtml(w)).not.toContain("<h2>Business</h2>")
    expect(settingsHtml(w)).toContain("<h2>Agents</h2>")
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
    // An agent waiting for approval is decided in Needs you, not here.
    const hire = html.split('id="st-agent-new"')[1].split("</article>")[0]
    expect(hire).toContain('href="#status=open&amp;view=decide"')
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

describe("Wall Settings: Schedules (#1428 phase 2)", () => {
  it("lists every schedule with when it runs and its agent", async () => {
    const w = openWall({ hash: "#page=settings&section=schedules" })
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("<b>digest</b> <code>0 9 * * *</code> <small>runs @cx</small>")
    expect(html).toContain("<b>night</b>")
    expect(w.writes()).toEqual([])
  })

  it("adds a schedule with the classic call and previews a preset's next runs", async () => {
    const w = openWall({ hash: "#page=settings&section=schedules", route: (u) => (u.endsWith("/crons/preview") ? { status: 200, body: { human: "At 09:00 on Monday", timezone: "UTC", next: ["2026-11-02T09:00:00Z"] } } : undefined) })
    await w.settle()
    await w.click({ "data-st-act": "cron-preset", "data-cron": "0 9 * * 1" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/crons/preview", method: "POST", body: { schedule: "0 9 * * 1" } }])
    expect(w.el("st-c-preview").innerHTML).toContain("At 09:00 on Monday")
    w.el("st-c-id").value = "weekly"; w.el("st-c-agent").value = "ops"; w.el("st-c-prompt").value = "Send the numbers."
    await w.submit({ "data-st-form": "cron" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/crons", method: "POST", body: { id: "weekly", schedule: "0 9 * * 1", agent: "ops", prompt: "Send the numbers." } })
  })

  it("shows why a schedule was not added", async () => {
    const w = openWall({ hash: "#page=settings&section=schedules", route: (u, i) => (u === "/api/admin/wall/settings/crons" && i.method === "POST" ? { status: 400, body: { error: "Invalid cron expression." } } : undefined) })
    await w.settle()
    await w.submit({ "data-st-form": "cron" })
    expect(w.el("st-n-cron-add").textContent).toBe("Not added: Invalid cron expression.")
  })

  it("asks before deleting a schedule, then deletes it", async () => {
    const w = openWall({ hash: "#page=settings&section=schedules" })
    await w.settle()
    await w.click({ "data-st-act": "ask", "data-key": "cron:night" })
    expect(settingsHtml(w)).toContain("Delete the schedule <b>night</b>?")
    expect(w.writes()).toEqual([])
    await w.click({ "data-st-act": "confirm", "data-key": "cron:night" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/crons", method: "DELETE", body: { id: "night" } }])
    expect(settingsHtml(w)).toContain("Deleted night.")
  })
})

describe("Wall Settings: Webhooks (#1428 phase 2)", () => {
  it("lists each webhook with its address, secret and state", async () => {
    const w = openWall({ hash: "#page=settings&section=webhooks" })
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("<code>http://node-a:18800/webhook/cx/github</code>")
    expect(html).toContain("secret: <code>${GH_SECRET}</code>")
    expect(html).toContain('<span class="wsj__pill is-ok">receiving</span>')
    expect(html).toContain('<span class="wsj__pill is-warn">signing secret missing</span>')
    expect(html).toContain("<code>issues.opened → triage</code>")
  })

  it("adds, turns off and deletes a webhook with the classic calls", async () => {
    const w = openWall({ hash: "#page=settings&section=webhooks" })
    await w.settle()
    w.el("st-w-id").value = "ci"; w.el("st-w-source").value = "gitlab"; w.el("st-w-agent").value = "cx"; w.el("st-w-secret").value = "GL_SECRET"
    await w.submit({ "data-st-form": "wh" })
    await w.click({ "data-st-act": "wh-toggle", "data-id": "repo" })
    await w.click({ "data-st-act": "ask", "data-key": "wh:pay" })
    await w.click({ "data-st-act": "confirm", "data-key": "wh:pay" })
    expect(w.writes()).toEqual([
      { url: "/api/admin/wall/settings/webhooks", method: "POST", body: { id: "ci", source: "gitlab", agentId: "cx", secretEnv: "GL_SECRET", description: "" } },
      { url: "/api/admin/wall/settings/webhooks", method: "PATCH", body: { id: "repo", patch: { enabled: false } } },
      { url: "/api/admin/wall/settings/webhooks", method: "DELETE", body: { id: "pay" } },
    ])
  })

  it("edits the routing: removes a trigger, saves the default, and says what is missing", async () => {
    const w = openWall({ hash: "#page=settings&section=webhooks" })
    await w.settle()
    await w.click({ "data-st-act": "wh-trig-rm", "data-id": "repo", "data-event": "issues.opened" })
    await w.submit({ "data-st-form": "wh-default", "data-id": "repo" })
    expect(w.writes()).toEqual([
      { url: "/api/admin/wall/settings/webhooks/triggers", method: "POST", body: { id: "repo", triggers: {} } },
      { url: "/api/admin/wall/settings/webhooks/triggers", method: "POST", body: { id: "repo", defaultWorkflow: "" } },
    ])
    await w.submit({ "data-st-form": "wh-trig", "data-id": "repo" })
    expect(w.el("st-n-wh").textContent).toBe("Write the event type and the workflow id.")
    expect(w.writes()).toHaveLength(2)
  })
})

describe("Wall Settings: Channels (#1428 phase 2)", () => {
  const CH_STATE = {
    ...STATE,
    telegram: { enabled: true, accounts: [{ id: "support", botUsername: "support_bot", agentBinding: "cx", botTokenRef: "${TG_SUPPORT}" }] },
    email: { enabled: false, accounts: [{ id: "hello", address: "hello@example.com", agent: "cx", imap: "imap.example.com:993", smtp: "smtp.example.com:465", allowFrom: ["*"], send: "approve", passwordRef: "${EMAIL_PW}" }] },
    slack: { enabled: false },
    gitlab: { enabled: true, host: "https://gitlab.example.com", tokenRef: "${GITLAB_TOKEN}", webhookPort: 18810, routeCount: 2, agentMappingCount: 1 },
    requestStatus: ["gitlab"],
  }
  const openChannels = (route?: Route) => openWall({ hash: "#page=settings&section=channels", route: (u, i) => route?.(u, i) ?? (u === "/api/admin/state" ? { status: 200, body: CH_STATE } : undefined) })

  it("shows Telegram first, with its accounts and the token's variable name only", async () => {
    const w = openChannels()
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("Telegram <span class=\"wsj__pill is-ok\">on</span>")
    expect(html).toContain("<b>support</b>")
    expect(html).toContain("answers as @cx · token <code>${TG_SUPPORT}</code>")
    expect(html).toContain('data-st-ch-toggle="telegram/toggle" checked')
    // WhatsApp is a tab like the others: no link to the classic page is left.
    expect(html).toContain('data-ch="whatsapp"')
    expect(html).not.toContain("/admin#tab=channels")
    expect(html).not.toContain("WhatsApp and routing")
    expect(w.writes()).toEqual([])
  })

  it("adds, edits and deletes a Telegram account with the classic calls", async () => {
    const w = openChannels()
    await w.settle()
    w.el("st-tg-id").value = "sales"; w.el("st-tg-agent").value = "ops"; w.el("st-tg-user").value = ""; w.el("st-tg-env").value = "TG_SALES"
    await w.submit({ "data-st-form": "tg" })
    await w.click({ "data-st-act": "tg-edit", "data-id": "support" })
    expect(settingsHtml(w)).toContain('data-st-form="tg-edit" data-id="support"')
    await w.submit({ "data-st-form": "tg-edit", "data-id": "support" })
    await w.click({ "data-st-act": "ask", "data-key": "tg:support" })
    expect(settingsHtml(w)).toContain("Delete the Telegram account <b>support</b>?")
    await w.click({ "data-st-act": "confirm", "data-key": "tg:support" })
    const writes = w.writes()
    expect(writes[0]).toEqual({ url: "/api/admin/wall/settings/channels/telegram", method: "POST", body: { id: "sales", agentBinding: "ops", botUsername: "", botTokenEnv: "TG_SALES" } })
    expect(writes[1].method).toBe("PATCH")
    expect(writes[1].body.id).toBe("support")
    expect(writes[2]).toEqual({ url: "/api/admin/wall/settings/channels/telegram", method: "DELETE", body: { id: "support" } })
  })

  it("adds a mailbox, and shows why it was not added", async () => {
    const w = openChannels((u, i) => (u.endsWith("/channels/email") && i.method === "POST" ? { status: 400, body: { error: "address is required" } } : undefined))
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "email" })
    expect(settingsHtml(w)).toContain("<b>hello@example.com</b>")
    expect(settingsHtml(w)).toContain("password <code>${EMAIL_PW}</code>")
    w.el("st-em-id").value = "help"; w.el("st-em-address").value = ""; w.el("st-em-auto").checked = true
    await w.submit({ "data-st-form": "em" })
    expect(w.writes()[0].body).toMatchObject({ id: "help", send: "auto" })
    expect(w.el("st-n-em-add").textContent).toBe("Not saved: address is required")
  })

  it("connects GitLab with the classic call and shows its request status switch", async () => {
    const w = openChannels()
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "gitlab" })
    const html = settingsHtml(w)
    expect(html).toContain("2 route(s) · 1 agent mapping(s)")
    expect(html).toContain('value="GITLAB_TOKEN"')
    expect(html).toContain('data-st-rs="gitlab" checked')
    w.el("st-gl-host").value = "https://gitlab.example.com"; w.el("st-gl-env").value = "GITLAB_TOKEN"; w.el("st-gl-port").value = "18810"
    await w.submit({ "data-st-form": "gitlab" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/channels/gitlab", method: "POST", body: { host: "https://gitlab.example.com", tokenEnv: "GITLAB_TOKEN", webhookPort: 18810 } }])
  })

  it("lists GitHub's webhooks and reads the calls without writing", async () => {
    const w = openChannels((u) => (u === "/api/admin/channels/webrtc/history" ? { status: 200, body: { active: [], history: [{ startedAt: 0, agentId: "cx", target: "owner", durationSec: 75, transcriptChunks: 3 }] } } : undefined))
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "github" })
    expect(settingsHtml(w)).toContain("<code>http://node-a:18800/webhook/cx/github</code>")
    await w.click({ "data-st-act": "ch", "data-ch": "calls" })
    expect(settingsHtml(w)).toContain("@cx with owner · 1 min 15 s · 3 transcript parts")
    expect(w.writes()).toEqual([])
  })
})

describe("Hub Settings: WhatsApp (#1428 phase 2)", () => {
  const WA_STATE = {
    ...STATE,
    whatsapp: { enabled: true, sessionDir: ".agentx/whatsapp-sessions", routeCount: 1 },
    whatsappTriage: { enabled: false, secretEnv: "WACLI_WEBHOOK_SECRET", secretSet: false, batchSeconds: 20, allowAutoAck: false,
      rules: [{ id: "shop", agent: "cx", chats: ["+10000000000"], senders: [], enabled: true, quietHours: { start: "22:00", end: "07:00" } }] },
  }
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
  const openWa = (route?: Route, state: object = WA_STATE) => openWall({ hash: "#page=settings&section=channels", route: (u, i) => route?.(u, i)
    ?? (u === "/api/admin/state" ? { status: 200, body: state }
      : u === "/api/admin/channels/whatsapp/state" ? { status: 200, body: { connection: "connecting", qr: "pairing-code", qrUpdatedAt: "2026-10-31T10:00:00Z" } }
      : u === "/api/admin/channels/whatsapp/qr.svg" ? { status: 200, body: SVG } : undefined) })

  it("shows the pairing state and the code as an image while the tab is open, and writes nothing", async () => {
    const w = openWa()
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "whatsapp" })
    const html = settingsHtml(w)
    expect(html).toContain("WhatsApp <span class=\"wsj__pill is-ok\">on</span>")
    expect(html).toContain("session folder <code>.agentx/whatsapp-sessions</code> · 1 route(s)")
    const pair = w.el("st-wa-pair").innerHTML as string
    expect(pair).toContain("waiting for scan")
    // The SVG is an image source, never markup in the page.
    expect(pair).toContain('src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SVG).replace(/'/g, "&#39;") + '"')
    expect(pair).not.toContain("<svg")
    expect(w.calls.some((c) => c.url === "/api/admin/channels/whatsapp/qr.svg")).toBe(true)
    expect(w.writes()).toEqual([])
  })

  it("says when it is paired, and when WhatsApp is off reads no pairing state", async () => {
    const w = openWa((u) => (u === "/api/admin/channels/whatsapp/state" ? { status: 200, body: { connection: "open", qr: null } } : undefined))
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "whatsapp" })
    expect(w.el("st-wa-pair").innerHTML).toContain("Paired: the daemon is signed in to WhatsApp.")
    expect(w.calls.some((c) => c.url.includes("qr.svg"))).toBe(false)
    const off = openWa(undefined, { ...WA_STATE, whatsapp: { enabled: false, routeCount: 0 } })
    await off.settle()
    await off.click({ "data-st-act": "ch", "data-ch": "whatsapp" })
    expect(settingsHtml(off)).toContain("WhatsApp is off in agentx.json.")
    expect(off.calls.some((c) => c.url.startsWith("/api/admin/channels/whatsapp/"))).toBe(false)
  })

  it("lists chats and contacts, and sweeps them into a wiki under the Settings prefix", async () => {
    const w = openWa((u) => u === "/api/admin/channels/whatsapp/chats" ? { status: 200, body: { chats: [{ jid: "1@s.whatsapp.net", name: "Example Shop", isGroup: false, unreadCount: 2 }, { jid: "2@g.us", name: "Team", isGroup: true }] } }
      : u === "/api/admin/channels/whatsapp/contacts" ? { status: 200, body: { contacts: [{ jid: "1@s.whatsapp.net", phone: "+10000000000", name: "Example Shop" }] } }
      : u.endsWith("/channels/whatsapp/ingest") ? { status: 200, body: { scannedContacts: 3, scannedGroups: 1, wroteContacts: 0, skippedUnchanged: 1, errors: [], dryRunEntries: [{}, {}] } } : undefined)
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "whatsapp" })
    await w.click({ "data-st-act": "wa-lists" })
    const html = settingsHtml(w)
    expect(html).toContain("Example Shop <small>chat · 2 unread</small>")
    expect(html).toContain("Team <small>group</small>")
    expect(html).toContain("Example Shop <small>+10000000000</small>")
    expect(w.writes()).toEqual([])
    w.el("st-wa-ing-agent").value = "cx"; w.el("st-wa-ing-dry").checked = true
    await w.submit({ "data-st-form": "wa-ingest" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/channels/whatsapp/ingest", method: "POST", body: { dryRun: true, force: false, agent: "cx" } }])
    expect(w.el("st-n-wa-ingest").textContent).toBe("Dry run: 3 contacts and 1 groups read, 2 entries would be written, 1 unchanged.")
  })

  it("says why the chats could not be read", async () => {
    const w = openWa((u) => (u === "/api/admin/channels/whatsapp/chats" ? { status: 500, body: { error: "daemon 503: WhatsApp channel not enabled" } } : undefined))
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "whatsapp" })
    await w.click({ "data-st-act": "wa-lists" })
    expect(settingsHtml(w)).toContain("Could not read them: daemon 503: WhatsApp channel not enabled")
  })

  it("turns watched chats on, and adds, turns off and deletes a watch rule with the classic calls", async () => {
    const w = openWa()
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "whatsapp" })
    const html = settingsHtml(w)
    expect(html).toContain("<code>http://node-a:18800/webhook/wacli</code>")
    expect(html).toContain("Secret <code>WACLI_WEBHOOK_SECRET</code> in .env: <b>not set</b>.")
    expect(html).toContain("goes to @cx · quiet 22:00–07:00")
    await w.change({ "data-st-wa-triage": "" }, true)
    w.el("st-wa-id").value = "school"; w.el("st-wa-agent").value = "ops"; w.el("st-wa-chats").value = "+10000000001, +10000000002"
    w.el("st-wa-quiet-start").value = "22:00"; w.el("st-wa-quiet-end").value = "07:00"
    await w.submit({ "data-st-form": "wa-rule" })
    await w.click({ "data-st-act": "wa-rule", "data-id": "shop", "data-on": "0" })
    await w.click({ "data-st-act": "ask", "data-key": "wa:shop" })
    expect(settingsHtml(w)).toContain("Delete the watch rule <b>shop</b>?")
    await w.click({ "data-st-act": "confirm", "data-key": "wa:shop" })
    expect(w.writes()).toEqual([
      { url: "/api/admin/wall/settings/whatsapp-triage", method: "POST", body: { enabled: true } },
      { url: "/api/admin/wall/settings/whatsapp-triage/rules", method: "POST", body: { id: "school", agent: "ops", chats: "+10000000001, +10000000002", senders: "", prompt: "", quietStart: "22:00", quietEnd: "07:00" } },
      { url: "/api/admin/wall/settings/whatsapp-triage/rules", method: "PATCH", body: { id: "shop", patch: { enabled: false } } },
      { url: "/api/admin/wall/settings/whatsapp-triage/rules", method: "DELETE", body: { id: "shop" } },
    ])
  })

  it("shows why a watch rule was not added", async () => {
    const w = openWa((u, i) => (u.endsWith("/whatsapp-triage/rules") && i.method === "POST" ? { status: 400, body: { error: 'Unknown agent "".' } } : undefined))
    await w.settle()
    await w.click({ "data-st-act": "ch", "data-ch": "whatsapp" })
    w.el("st-wa-id").value = "school"
    await w.submit({ "data-st-form": "wa-rule" })
    expect(w.el("st-n-wa-add").textContent).toBe('Not saved: Unknown agent "".')
  })
})

describe("Hub Settings: Inbox, how notifications reach the owner (#1428 phase 2)", () => {
  const IN_STATE = {
    ...STATE,
    notifications: { longTaskThreshold: 30, destination: { channel: "telegram", chatId: "1001" }, on: { taskComplete: true, taskError: true, taskQueued: false },
      local: { banner: true, sound: true, soundName: "Glass", volume: 0.4 }, ntfy: { enabled: false, server: "https://ntfy.sh", topicSet: true, tokenSet: false } },
  }
  const openInbox = (route?: Route) => openWall({ hash: "#page=settings&section=inbox", route: (u, i) => route?.(u, i) ?? (u === "/api/admin/state" ? { status: 200, body: IN_STATE } : undefined) })
  const fill = (w: ReturnType<typeof openWall>, v: Record<string, string | boolean>) => {
    for (const [id, x] of Object.entries(v)) { if (typeof x === "boolean") w.el(id).checked = x; else w.el(id).value = x }
  }
  const FORM = { "st-in-channel": "telegram", "st-in-chat": "1001", "st-in-account": "", "st-in-threshold": "45", "st-in-complete": true, "st-in-error": true, "st-in-queued": false,
    "st-in-banner": true, "st-in-sound": false, "st-in-sound-name": "Glass", "st-in-volume": "0.4", "st-in-icon": "", "st-in-ntfy": false, "st-in-ntfy-server": "https://ntfy.sh",
    "st-in-ntfy-topic": "", "st-in-ntfy-token": "" }

  it("shows where the inbox goes, with no ntfy secret, and saves it with the classic call", async () => {
    const w = openInbox()
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("Goes to <code>telegram:1001</code>.")
    expect(html).toContain('<option value="telegram" selected>Telegram</option>')
    expect(html).toContain("(set; empty keeps it)")
    expect(w.el("st-in-ntfy-topic").value).toBe("")
    expect(w.writes()).toEqual([])
    fill(w, { ...FORM, "st-in-ntfy": true, "st-in-ntfy-topic": "NTFY_TOPIC" })
    await w.submit({ "data-st-form": "inbox" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/notifications", method: "POST", body: {
      on: { taskComplete: true, taskError: true, taskQueued: false }, longTaskThreshold: 45,
      local: { banner: true, sound: false, soundName: "Glass", volume: 0.4, icon: "" },
      ntfy: { enabled: true, topic: "${NTFY_TOPIC}" },
      destination: { channel: "telegram", chatId: "1001" },
    } }])
    expect(settingsHtml(w)).toContain("Saved. Restart the daemon for phone push: agentx daemon restart --when-idle.")
  })

  it("never sends a typed topic or token, only a variable's name", async () => {
    const w = openInbox()
    await w.settle()
    for (const [id, v] of [["st-in-ntfy-topic", "my-secret-topic"], ["st-in-ntfy-token", "tk_example value"]]) {
      fill(w, { ...FORM, [id]: v })
      await w.submit({ "data-st-form": "inbox" })
      expect(w.el("st-n-inbox-save").textContent).toBe("Not saved: type the name of the .env variable, such as NTFY_TOPIC, not the topic or token itself.")
    }
    expect(w.writes()).toEqual([])
  })

  it("asks for both a channel and a chat id, sends no ntfy change it did not make, and clears the destination", async () => {
    const w = openInbox((u, i) => (u.endsWith("/notifications") && i.method === "POST" ? { status: 400, body: { error: "volume must be between 0 and 1" } } : undefined))
    await w.settle()
    fill(w, { ...FORM, "st-in-chat": "" })
    await w.submit({ "data-st-form": "inbox" })
    expect(w.el("st-n-inbox-save").textContent).toBe("Not saved: give both a channel and a chat id, or neither.")
    expect(w.writes()).toEqual([])
    fill(w, { ...FORM, "st-in-channel": "", "st-in-chat": "", "st-in-volume": "3" })
    await w.submit({ "data-st-form": "inbox" })
    expect(w.writes()[0].body).not.toHaveProperty("ntfy")
    expect(w.writes()[0].body).not.toHaveProperty("destination")
    expect(w.el("st-n-inbox-save").textContent).toBe("Not saved: volume must be between 0 and 1")
    await w.click({ "data-st-act": "inbox-clear" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/notifications", method: "POST", body: { destination: null } })
  })
})

describe("Wall Settings: a literal secret in agentx.json is never sent or shown (#1567)", () => {
  // Fake values: each is a literal written into agentx.json instead of a reference.
  const LITERALS = {
    telegram: "123456:tg-literal-bot-token",
    slackBot: "xoxb-literal-slack-bot",
    slackApp: "xapp-literal-slack-app",
    discord: "literal-discord-token",
    gitlab: "glpat-literal-gitlab-token",
    imap: "literal-imap-password",
  }
  const prev = process.cwd()
  let dir = ""
  afterEach(() => { process.chdir(prev); if (dir) rmSync(dir, { recursive: true, force: true }); dir = "" })

  async function adminState(): Promise<any> {
    const req = Object.assign(Readable.from([]), { method: "GET" }) as unknown as IncomingMessage
    let out = ""
    const res = { writeHead: () => res, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, "/api/admin/state")
    return JSON.parse(out)
  }

  it("treats any reference the daemon expands as a reference, lowercase included", () => {
    expect(secretRef("${TG_SALES}")).toBe("${TG_SALES}")
    expect(secretRef("${tg_sales}")).toBe("${tg_sales}")
    expect(secretRef("${Slack_Bot2}")).toBe("${Slack_Bot2}")
    expect(secretRef("${}")).toEqual({ literal: true })
    expect(secretRef("${TG-SALES}")).toEqual({ literal: true })
    expect(secretRef("prefix-${TG_SALES}")).toEqual({ literal: true })
    expect(secretRef("")).toBe("")
    expect(secretRef(undefined)).toBe("")
  })

  it("sends a marker for each literal, keeps references, and the Channels page shows neither value nor pre-fill", async () => {
    dir = mkdtempSync(join(tmpdir(), "wall-literal-"))
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({
      node: { id: "n", name: "n" },
      agents: { cx: { name: "Customer Desk" } },
      channels: {
        telegram: { enabled: true, accounts: { support: { token: LITERALS.telegram, agentBinding: "cx" }, sales: { token: "${TG_SALES}", agentBinding: "cx" } } },
        slack: { enabled: true, botToken: LITERALS.slackBot, appToken: LITERALS.slackApp, agentBinding: "cx" },
        discord: { enabled: true, token: LITERALS.discord, agentBinding: "cx" },
        gitlab: { enabled: true, host: "https://gitlab.example.com", token: LITERALS.gitlab },
        email: { enabled: true, accounts: { hello: { agent: "cx", address: "hello@example.com", imap: { host: "imap.example.com", password: LITERALS.imap }, smtp: { host: "smtp.example.com" } } } },
      },
    }))
    process.chdir(dir)
    const state = await adminState()
    const json = JSON.stringify(state)
    for (const v of Object.values(LITERALS)) expect(json).not.toContain(v)
    expect(state.telegram.accounts.find((a: any) => a.id === "support").botTokenRef).toEqual({ literal: true })
    expect(state.telegram.accounts.find((a: any) => a.id === "sales").botTokenRef).toBe("${TG_SALES}")
    expect(state.slack.botTokenRef).toEqual({ literal: true })
    expect(state.slack.appTokenRef).toEqual({ literal: true })
    expect(state.discord.tokenRef).toEqual({ literal: true })
    expect(state.gitlab.tokenRef).toEqual({ literal: true })
    expect(state.email.accounts[0].passwordRef).toEqual({ literal: true })
    process.chdir(prev)

    const w = openWall({ hash: "#page=settings&section=channels", route: (u) => (u === "/api/admin/state" ? { status: 200, body: { ...STATE, ...state, agents: STATE.agents } } : undefined) })
    await w.settle()
    await w.click({ "data-st-act": "tg-edit", "data-id": "support" })
    const pages = [settingsHtml(w)]
    expect(pages[0]).toContain("set in agentx.json as a literal value: move it to .env")
    expect(pages[0]).toContain("<code>${TG_SALES}</code>")
    expect(w.el("st-tge-env").value).toBe("")
    for (const ch of ["email", "slack", "discord", "gitlab"]) {
      await w.click({ "data-st-act": "ch", "data-ch": ch })
      const html = settingsHtml(w)
      expect(html, ch).toContain("set in agentx.json as a literal value: move it to .env")
      pages.push(html)
    }
    for (const id of ["st-sl-bot", "st-sl-app", "st-dc-env", "st-gl-env"]) expect(w.el(id)?.value ?? "", id).toBe("")
    for (const html of pages) for (const v of Object.values(LITERALS)) expect(html).not.toContain(v)
    expect(pages.join("")).not.toContain("[object Object]")
    expect(w.writes()).toEqual([])
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
  const WA_INBOX_WRITES = [["POST", "channels/whatsapp/ingest"], ["POST", "whatsapp-triage"], ["POST", "whatsapp-triage/rules"], ["PATCH", "whatsapp-triage/rules"],
    ["DELETE", "whatsapp-triage/rules"], ["POST", "notifications"]]
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
    expect(await (await fetch(base + "/hub")).text()).toContain('data-nav="settings" href="#page=settings"')
    const signIn = await fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { ...OFF, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: TOKEN, next: "/hub" }).toString() })
    const cookie = (signIn.headers.get("set-cookie") || "").split(";")[0]
    expect(await (await fetch(base + "/hub", { headers: { ...OFF, Cookie: cookie } })).text()).toContain('data-nav="settings" href="#page=settings"')
    const stranger = await fetch(base + "/hub", { headers: OFF, redirect: "manual" })
    expect(stranger.status).toBe(302)
    expect(await stranger.text()).not.toContain("AX_WALL_SETTINGS")
    expect((await fetch(`${base}/api/admin/state`, { headers: OFF })).status).toBe(401)
    expect((await fetch(`${base}/api/admin/agents`, { method: "PATCH", headers: OFF, body: "{}" })).status).toBe(401)
    expect((await fetch(`${base}/api/admin/wall/settings/agents`, { method: "PATCH", headers: OFF, body: "{}" })).status).toBe(401)
    // WhatsApp and Inbox writes too: refused before any handler runs.
    for (const [method, path] of WA_INBOX_WRITES) {
      expect((await fetch(`${base}/api/admin/wall/settings/${path}`, { method, headers: { ...OFF, "X-Requested-With": "agentx-board" }, body: "{}" })).status, `${method} ${path}`).toBe(401)
    }
  })

  it("with no dashboard token, draws Settings on this machine only, as the writes allow", async () => {
    const base = await start(null)
    expect(await (await fetch(base + "/hub")).text()).toContain('data-nav="settings" href="#page=settings"')
    const off = await (await fetch(base + "/hub", { headers: OFF })).text()
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
    expect((await fetch(`${base}/api/admin/wall/settings/agents/integrations`, { method: "PATCH", headers: auth, body: "{}" })).status).toBe(404)
    // Phase 2: Schedules and Webhooks reach their classic handlers.
    for (const [method, path] of [["POST", "crons"], ["DELETE", "crons"], ["POST", "crons/preview"], ["POST", "webhooks"], ["PATCH", "webhooks"], ["DELETE", "webhooks"], ["POST", "webhooks/triggers"],
      ["POST", "channels/telegram"], ["PATCH", "channels/telegram"], ["DELETE", "channels/email"], ["POST", "channels/slack/toggle"], ["POST", "channels/request-status"],
      // WhatsApp watch rules and Inbox: an empty body is refused by the handler, so nothing is written
      // (the sweep and the triage switch are left out: one calls the daemon, the other would write).
      ["POST", "whatsapp-triage/rules"], ["PATCH", "whatsapp-triage/rules"], ["DELETE", "whatsapp-triage/rules"], ["POST", "notifications"]]) {
      expect((await fetch(`${base}/api/admin/wall/settings/${path}`, { method, headers: auth, body: "{}" })).status, `${method} ${path}`).not.toBe(404)
    }
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
