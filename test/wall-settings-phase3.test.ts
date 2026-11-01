import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import type { IncomingMessage, ServerResponse } from "http"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import { handleAdminApi } from "../src/daemon/admin-panel"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { HIDDEN_SECRET, hideConfigSecrets, restoreConfigSecrets } from "../src/daemon/config-hidden"
import { openWall, settingsHtml, STATE, type Route } from "./wall-settings-harness"

// #1428 phase 3: Mesh, Business, Boards, Actions, Tokens, Screen capture,
// the wiki notes inbox, Advanced (agentx.json), and the approval and
// request settings /approvals held, on the Hub's Settings. Each loads,
// saves with the classic call under /api/admin/wall/settings, shows an
// error, and is the owner's alone.

const P3 = {
  ...STATE,
  nodeName: "node-a",
  mesh: { enabled: true, discovery: "static", peers: [{ url: "http://peer-b:18800", name: "peer-b", hasToken: true }, { url: "http://peer-c:18800", name: "peer-c", hasToken: false }],
    healthCheck: { interval: 60, timeout: 10 } },
  business: {
    enabled: true, orgChart: { cx: { role: "Support lead", reportsTo: "", schedule: { start: "09:00", end: "17:00", days: ["mon", "tue"] } } },
    projects: [{ id: "example/app", pm: "cx", client: "example" }], contactMap: [{ channel: "telegram", chatId: "1001", client: "example" }],
    clients: { example: { kind: "client", respondWithin: "4h" } },
  },
  boards: [{ id: "main", name: "Main board", source: { type: "gitlab", projects: ["example/app"] }, primaryToolLabel: "", timeRangeDays: 30, closedWindowDays: 14,
    columns: [{ id: "doing", title: "Doing", kind: "scoped-label", scopedLabel: "Status::Doing" }] }],
  actions: [{ id: "deploy", title: "Deploy", kind: "shell", description: "", command: "make deploy V={{version}}", timeoutMs: 30000,
    inputs: [{ name: "version", type: "string", required: true }, { name: "dry", type: "boolean", required: false }] }],
  screen: { maxPixels: 1000000, timeoutMs: 8000, intervalMs: 250, changeThreshold: 0.02, stableMs: 600, regions: { chat: { x: 0, y: 60, width: 720, height: 800 } },
    buffer: { enabled: false, region: "screen", seconds: 10, fps: 1, maxPixels: 300000 } },
  wikiNotes: { enabled: false, inbox: "", crons: [], absorbAgent: "", maxNotesPerRun: 20, maxDeferrals: 3 },
}
const TOKENS = [
  { id: "t1", name: "Chat bridge", prefix: "ax_ab12", scopes: ["agent:*"], createdAt: "2026-10-01T00:00:00Z", lastUsedAt: new Date().toISOString() },
  { id: "t2", name: "Old script", prefix: "ax_cd34", scopes: [], createdAt: "2026-01-01T00:00:00Z", revokedAt: "2026-02-01T00:00:00Z" },
]

function open(section: string, route?: Route, business = false) {
  return openWall({ hash: `#page=settings&section=${section}`, business, route: (u, i) => route?.(u, i)
    ?? (u === "/api/admin/state" ? { status: 200, body: P3 } : u === "/api/admin/tokens" ? { status: 200, body: TOKENS } : undefined) })
}
type W = ReturnType<typeof openWall>
const fill = (w: W, v: Record<string, string | boolean>) => {
  for (const [id, x] of Object.entries(v)) { const e = w.el(id); expect(e, id).toBeTruthy(); if (typeof x === "boolean") e.checked = x; else e.value = x }
}
const refuse = (path: string, error: string): Route => (u, i) => (u === `/api/admin/wall/settings/${path}` && i.method && i.method !== "GET" ? { status: 400, body: { error } } : undefined)
async function confirm(w: W, key: string) {
  await w.click({ "data-st-act": "ask", "data-key": key })
  await w.click({ "data-st-act": "confirm", "data-key": key })
}

describe("Hub Settings: Mesh (#1428 phase 3)", () => {
  it("shows the peers and turns mesh off, with the classic call", async () => {
    const w = open("mesh")
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("This machine (<b>node-a</b>) is linked to 2 peers.")
    expect(html).toContain("<code>http://peer-b:18800</code>")
    expect(html).toContain("no token")
    expect(w.writes()).toEqual([])
    await w.change({ "data-st-mesh-toggle": "" }, false)
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/mesh/toggle", method: "POST", body: { enabled: false } }])
  })

  it("adds a peer with its token's variable name only, and never a typed token", async () => {
    const w = open("mesh")
    await w.settle()
    fill(w, { "st-m-name": "peer-d", "st-m-url": "http://peer-d:18800", "st-m-token": "tok-literal value" })
    await w.submit({ "data-st-form": "mesh-peer" })
    expect(w.el("st-n-mesh-add").textContent).toBe("Not added: type the name of the .env variable, such as PEER_TOKEN, not the token itself.")
    expect(w.writes()).toEqual([])
    fill(w, { "st-m-token": "PEER_D_TOKEN" })
    await w.submit({ "data-st-form": "mesh-peer" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/mesh/peers", method: "POST", body: { name: "peer-d", url: "http://peer-d:18800", token: "${PEER_D_TOKEN}" } }])
  })

  it("removes a peer after asking, saves the health check, and shows an error", async () => {
    const w = open("mesh", refuse("mesh/health", "interval must be 5..3600 seconds"))
    await w.settle()
    await confirm(w, "peer:1")
    expect(w.writes()[0]).toEqual({ url: "/api/admin/wall/settings/mesh/peers", method: "DELETE", body: { url: "http://peer-c:18800" } })
    fill(w, { "st-mh-interval": "2", "st-mh-timeout": "10" })
    await w.submit({ "data-st-form": "mesh-health" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/mesh/health", method: "POST", body: { interval: 2, timeout: 10 } })
    expect(w.el("st-n-mesh-health").textContent).toBe("Not saved: interval must be 5..3600 seconds")
  })
})

describe("Hub Settings: Tokens (#1428 phase 3)", () => {
  it("lists tokens by prefix, mints one shown once, and forgets it on leaving", async () => {
    const w = open("tokens", (u, i) => (u === "/api/admin/wall/settings/tokens" && i.method === "POST" ? { status: 200, body: { summary: "ok", token: "ax_new_full_secret" } } : undefined))
    await w.settle()
    let html = settingsHtml(w)
    expect(html).toContain("<code>ax_ab12…</code>")
    expect(html).toContain('<span class="wsj__pill">revoked</span>')
    // A public agent gets its own scope.
    expect(html).toContain('data-scope="agent:ops"')
    fill(w, { "st-tk-name": "Laptop", "st-tk-days": "90" })
    w.el("st-tk-scope-3").checked = true
    await w.submit({ "data-st-form": "token" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/tokens", method: "POST", body: { name: "Laptop", scopes: ["mesh:peer"], expiresInDays: 90 } }])
    html = settingsHtml(w)
    expect(html).toContain("Copy it now: it is not shown again")
    expect(html).toContain("ax_new_full_secret")
    await w.go("#page=settings&section=mesh")
    await w.go("#page=settings&section=tokens")
    expect(settingsHtml(w)).not.toContain("ax_new_full_secret")
  })

  it("revokes after asking, and shows why a token was not made", async () => {
    const w = open("tokens", refuse("tokens", "Token name is required."))
    await w.settle()
    await confirm(w, "tok:t1")
    expect(w.writes()[0]).toEqual({ url: "/api/admin/wall/settings/tokens", method: "DELETE", body: { id: "t1" } })
    await w.submit({ "data-st-form": "token" })
    expect(w.el("st-n-tok-add").textContent).toBe("Not made: Token name is required.")
  })
})

describe("Hub Settings: Business (#1428 phase 3)", () => {
  it("lists the org chart, projects, clients and contacts, and saves each with the classic calls", async () => {
    const w = open("business", undefined, true)
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("<h2>Business</h2>")
    expect(html).toContain("<b>Support lead</b> <code>cx</code>")
    expect(html).toContain("<code>example/app</code> <small>PM cx</small>")
    expect(html).toContain("kind client · within 4h")
    expect(html).toContain("<code>chat 1001</code>")
    fill(w, { "st-bo-agent": "ops", "st-bo-role": "Night shift", "st-bo-reports": "cx", "st-bo-start": "", "st-bo-end": "", "st-bo-days": "" })
    await w.submit({ "data-st-form": "biz-org" })
    expect(w.writes()[0]).toEqual({ url: "/api/admin/wall/settings/business/orgchart", method: "POST",
      body: { agentId: "ops", role: "Night shift", reportsTo: "cx", start: "09:00", end: "17:00", days: ["mon", "tue", "wed", "thu", "fri"] } })
    fill(w, { "st-bm-channel": "", "st-bm-chat": "", "st-bm-user": "", "st-bm-sender": "", "st-bm-client": "example" })
    await w.submit({ "data-st-form": "biz-contact" })
    expect(w.el("st-n-biz-contact").textContent).toBe("Not saved: give a chat id, a username or a sender id.")
    expect(w.writes()).toHaveLength(1)
    await confirm(w, "bm:0")
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/business/contact", method: "DELETE", body: { channel: "telegram", chatId: "1001" } })
    await confirm(w, "bp:example/app")
    expect(w.writes()[2]).toEqual({ url: "/api/admin/wall/settings/business/project", method: "DELETE", body: { id: "example/app" } })
  })
})

describe("Hub Settings: a project's name, lead and team (#1687)", () => {
  it("sends them only when filled, so a blank keeps what is saved", async () => {
    const w = open("business", undefined, true)
    await w.settle()
    expect(settingsHtml(w)).toContain('id="st-bp-team"')
    fill(w, { "st-bp-id": "example/app", "st-bp-pm": "cx", "st-bp-client": "", "st-bp-name": "Example app", "st-bp-lead": "person:sam", "st-bp-team": "ops, person:kim" })
    await w.submit({ "data-st-form": "biz-proj" })
    expect(w.writes()[0]).toEqual({ url: "/api/admin/wall/settings/business/project", method: "POST",
      body: { id: "example/app", pm: "cx", client: "", name: "Example app", lead: "person:sam", team: ["ops", "person:kim"] } })
    fill(w, { "st-bp-id": "example/app", "st-bp-pm": "cx", "st-bp-client": "", "st-bp-name": "", "st-bp-lead": "", "st-bp-team": "" })
    await w.submit({ "data-st-form": "biz-proj" })
    expect(w.writes()[1].body).toEqual({ id: "example/app", pm: "cx", client: "" })
    // A ticked Clear removes the lead and the team.
    fill(w, { "st-bp-id": "example/app", "st-bp-pm": "", "st-bp-client": "", "st-bp-name": "", "st-bp-lead": "", "st-bp-team": "", "st-bp-clear-lead": true, "st-bp-clear-team": true })
    await w.submit({ "data-st-form": "biz-proj" })
    expect(w.writes()[2].body).toEqual({ id: "example/app", pm: "", client: "", clear: ["lead", "team"] })
  })
})

describe("Hub Settings: Boards (#1428 phase 3)", () => {
  it("lists boards, fills the form to edit one, adds and removes a column, and shows an error", async () => {
    const w = open("boards", refuse("boards", "at least one project path required"))
    await w.settle()
    expect(settingsHtml(w)).toContain("<b>Doing</b> <small>scoped Status::Doing</small>")
    await w.click({ "data-st-act": "bd-edit", "data-id": "main" })
    expect(settingsHtml(w)).toContain("Update Main board")
    expect(settingsHtml(w)).toContain('id="st-bd-closed" value="14"')
    fill(w, { "st-bd-id": "main", "st-bd-name": "Main board", "st-bd-projects": "", "st-bd-label": "", "st-bd-days": "30", "st-bd-closed": "14" })
    await w.submit({ "data-st-form": "bd" })
    expect(w.writes()[0]).toEqual({ url: "/api/admin/wall/settings/boards", method: "POST",
      body: { id: "main", name: "Main board", projects: "", primaryToolLabel: "", timeRangeDays: 30, closedWindowDays: 14 } })
    expect(w.el("st-n-bd-add").textContent).toBe("Not saved: at least one project path required")
    fill(w, { "st-bdc-id-main": "review", "st-bdc-title-main": "Review", "st-bdc-kind-main": "label", "st-bdc-value-main": "needs-review" })
    await w.submit({ "data-st-form": "bd-col", "data-id": "main" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/boards/columns", method: "POST",
      body: { boardId: "main", columnId: "review", title: "Review", kind: "label", mapsToLabel: "needs-review" } })
    await confirm(w, "bdc:main:0")
    expect(w.writes()[2]).toEqual({ url: "/api/admin/wall/settings/boards/columns", method: "DELETE", body: { boardId: "main", columnId: "doing" } })
    await confirm(w, "bd:main")
    expect(w.writes()[3]).toEqual({ url: "/api/admin/wall/settings/boards", method: "DELETE", body: { id: "main" } })
  })
})

describe("Hub Settings: Actions (#1428 phase 3)", () => {
  it("saves a shell action, runs one with its inputs and shows the output, and removes one", async () => {
    const w = open("actions", (u, i) => (u.endsWith("/actions/run") && i.method === "POST"
      ? { status: 200, body: { result: { ok: true, status: 0, durationMs: 42, output: "deployed 1.2" } } } : undefined))
    await w.settle()
    expect(settingsHtml(w)).toContain("shell <code>make deploy V={{version}}</code>")
    fill(w, { "st-ac-id": "backup", "st-ac-title": "Backup", "st-ac-desc": "", "st-ac-kind": "shell", "st-ac-command": "make backup", "st-ac-cwd": "", "st-ac-inputs": "target:string!", "st-ac-timeout": "" })
    await w.submit({ "data-st-form": "ac" })
    expect(w.writes()[0]).toEqual({ url: "/api/admin/wall/settings/actions", method: "POST",
      body: { id: "backup", title: "Backup", kind: "shell", inputs: [{ name: "target", type: "string", required: true }], timeoutMs: 30000, command: "make backup" } })
    fill(w, { "st-ar-deploy-0": "1.2", "st-ar-deploy-1": true })
    await w.submit({ "data-st-form": "ac-run", "data-id": "deploy" })
    expect(w.writes()[1]).toEqual({ url: "/api/admin/wall/settings/actions/run", method: "POST", body: { id: "deploy", inputs: { version: "1.2", dry: true } } })
    expect(settingsHtml(w)).toContain('<pre class="wst-out">deployed 1.2</pre>')
    expect(settingsHtml(w)).toContain("Done · status 0 · 42 ms")
    await confirm(w, "ac:deploy")
    expect(w.writes()[2]).toEqual({ url: "/api/admin/wall/settings/actions", method: "DELETE", body: { id: "deploy" } })
  })

  it("refuses headers that are not JSON and a shell action with no command, before any call", async () => {
    const w = open("actions")
    await w.settle()
    fill(w, { "st-ac-id": "x", "st-ac-title": "X", "st-ac-kind": "shell", "st-ac-command": "" })
    await w.submit({ "data-st-form": "ac" })
    expect(w.el("st-n-ac-add").textContent).toBe("Not saved: a shell action needs a command.")
    fill(w, { "st-ac-kind": "http", "st-ac-url": "https://example.com/hook", "st-ac-method": "POST", "st-ac-headers": "{nope" })
    await w.submit({ "data-st-form": "ac" })
    expect(w.el("st-n-ac-add").textContent).toBe("Not saved: the headers are not a JSON object.")
    expect(w.writes()).toEqual([])
  })
})

describe("Hub Settings: Screen capture and wiki notes (#1428 phase 3)", () => {
  it("saves screen capture with removed regions sent as null", async () => {
    const w = open("screen")
    await w.settle()
    fill(w, { "st-sc-pixels": "1000000", "st-sc-timeout": "8000", "st-sc-interval": "250", "st-sc-threshold": "0.02", "st-sc-stable": "600", "st-sc-regions": "side=0,0,300,800",
      "st-sc-buffer": true, "st-sc-buf-region": "", "st-sc-buf-seconds": "10", "st-sc-buf-fps": "1", "st-sc-buf-pixels": "300000" })
    await w.submit({ "data-st-form": "screen" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/screen", method: "POST", body: {
      maxPixels: "1000000", timeoutMs: "8000", intervalMs: "250", changeThreshold: "0.02", stableMs: "600", regions: { chat: null, side: "0,0,300,800" },
      buffer: { enabled: true, region: "screen", seconds: "10", fps: "1", maxPixels: "300000" } } }])
    fill(w, { "st-sc-regions": "no equals sign" })
    await w.submit({ "data-st-form": "screen" })
    expect(w.el("st-n-screen").textContent).toBe("Not saved: write each region as name=x,y,width,height.")
  })

  it("saves the wiki notes inbox under Schedules with the picked schedules", async () => {
    const w = open("schedules")
    await w.settle()
    expect(settingsHtml(w)).toContain("Wiki notes inbox")
    fill(w, { "st-wn-on": true, "st-wn-inbox": "cx", "st-wn-cron-0": true, "st-wn-absorb": "cx", "st-wn-max": "10", "st-wn-defer": "3" })
    await w.submit({ "data-st-form": "wn" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/wiki-notes", method: "POST",
      body: { enabled: true, inbox: "cx", crons: ["digest"], absorbAgent: "cx", maxNotesPerRun: 10, maxDeferrals: 3 } }])
  })
})

describe("Hub Settings: Advanced, agentx.json itself (#1428 phase 3)", () => {
  const RAW = JSON.stringify({ dashboard: { token: HIDDEN_SECRET } }, null, 2)
  const advanced = (route?: Route) => open("advanced", (u, i) => route?.(u, i) ?? (u === "/api/admin/config/hidden" ? { status: 200, body: { exists: true, raw: RAW, hidden: 1 } } : undefined))

  it("reads the file with its secrets hidden, refuses invalid JSON, and saves with the classic call", async () => {
    const w = advanced()
    await w.settle()
    expect(w.calls.some((c) => c.url === "/api/admin/config")).toBe(false)
    const html = settingsHtml(w)
    expect(html).toContain("1 secret typed into the file")
    expect(html).toContain("[hidden secret: kept on save]")
    w.el("st-adv-text").value = "{ broken"
    await w.click({ "data-st-act": "adv-save" })
    expect(w.el("st-n-adv-save").textContent).toMatch(/^Not saved: it is not valid JSON/)
    expect(w.writes()).toEqual([])
    w.el("st-adv-text").value = RAW
    await w.click({ "data-st-act": "adv-save" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/config/raw", method: "POST", body: { raw: RAW } }])
  })

  it("shows why it was not saved, and why the file could not be read", async () => {
    const w = advanced(refuse("config/raw", "Invalid JSON: nope"))
    await w.settle()
    w.el("st-adv-text").value = RAW
    await w.click({ "data-st-act": "adv-save" })
    expect(w.el("st-n-adv-save").textContent).toBe("Not saved: Invalid JSON: nope")
    const r = advanced((u) => (u === "/api/admin/config/hidden" ? { status: 500, body: { error: "disk full" } } : undefined))
    await r.settle()
    expect(settingsHtml(r)).toContain("Could not read agentx.json: disk full.")
  })
})

describe("Hub Settings: the approval and request settings from /approvals (#1428 phase 3)", () => {
  const APV = { defaultExpiryDays: 7, maxExpiryDays: 30, laterHours: 4, notifyAgent: true, desk: { phone: "urgent", computer: "all" }, digest: { enabled: false, time: "09:00" } }
  const REQ = { enabled: true, from: ["telegram:1"], channels: [], staleAfterHours: 24, retentionDays: 30, plans: { enabled: true, stallMinutes: 30, maxNudges: 3 }, checkers: { enabled: ["url"], checkEveryMinutes: 10 } }
  const reads: Route = (u) => (u === "/api/admin/approvals" ? { status: 200, body: { items: [], settings: APV } }
    : u === "/api/admin/approvals/requests" ? { status: 200, body: { items: [], settings: REQ } } : undefined)

  it("shows Approvals under Inbox and saves them under the Settings prefix", async () => {
    const w = open("inbox", (u, i) => reads(u, i) ?? (u.endsWith("/approvals/settings") ? { status: 200, body: { ok: true, settings: { ...APV, laterHours: 8 } } } : undefined))
    await w.settle()
    expect(settingsHtml(w)).toContain('<option value="urgent" selected>Only what expires within a day</option>')
    fill(w, { "st-apv-phone": "urgent", "st-apv-computer": "all", "st-apv-expiry": "7", "st-apv-max": "30", "st-apv-later": "8", "st-apv-notify": true, "st-apv-digest": true, "st-apv-time": "08:30", "st-apv-dest": "" })
    await w.submit({ "data-st-form": "apv" })
    expect(w.writes()).toEqual([{ url: "/api/admin/wall/settings/approvals/settings", method: "POST", body: {
      defaultExpiryDays: 7, maxExpiryDays: 30, laterHours: 8, notifyAgent: true, deskPhone: "urgent", deskComputer: "all", digestEnabled: true, digestTime: "08:30", destination: "" } }])
    expect(settingsHtml(w)).toContain('id="st-n-apv" role="status">Saved.</p>')
  })

  it("saves the request settings and shows the error the handler gives", async () => {
    const w = open("requests", (u, i) => reads(u, i) ?? refuse("approvals/requests/settings", "staleAfterHours must be a positive number")(u, i))
    await w.settle()
    expect(settingsHtml(w)).toContain('value="telegram:1"')
    fill(w, { "st-rq-on": true, "st-rq-from": "telegram:1", "st-rq-channels": "", "st-rq-stale": "0", "st-rq-keep": "30", "st-rq-headlines": true, "st-rq-plans": true,
      "st-rq-stall": "30", "st-rq-nudges": "3", "st-rq-approve": "", "st-rq-off": "", "st-rq-work": "", "st-rq-over": "30", "st-rq-checks": "url", "st-rq-every": "10" })
    await w.submit({ "data-st-form": "req" })
    expect(w.writes()[0].url).toBe("/api/admin/wall/settings/approvals/requests/settings")
    expect(w.writes()[0].body).toMatchObject({ enabled: true, from: "telegram:1", staleAfterHours: 0, checkKinds: "url", checkEveryMinutes: 10 })
    expect(w.el("st-n-req").textContent).toBe("Not saved: staleAfterHours must be a positive number")
  })
})

describe("agentx.json with its literal secrets hidden (#1428 phase 3)", () => {
  const CFG = { dashboard: { token: "literal-dash", daemonUrl: "http://x" }, channels: { telegram: { accounts: { a: { token: "${TG_A}", tokenEnv: "TG" } } } },
    mesh: { peers: [{ url: "http://p", token: "literal-peer" }] }, agents: { cx: { maxTokens: 4000 } } }

  it("hides each literal secret, keeps references and names, and gives them back on save", () => {
    const { config, hidden } = hideConfigSecrets(CFG) as { config: any; hidden: number }
    expect(hidden).toBe(2)
    expect(JSON.stringify(config)).not.toContain("literal-")
    expect(config.dashboard.token).toBe(HIDDEN_SECRET)
    expect(config.channels.telegram.accounts.a).toEqual({ token: "${TG_A}", tokenEnv: "TG" })
    expect(config.agents.cx.maxTokens).toBe(4000)
    expect(restoreConfigSecrets(config, CFG)).toEqual(CFG)
  })

  it("refuses a hidden secret moved where the file has none", () => {
    expect(() => restoreConfigSecrets({ dashboard: { password: HIDDEN_SECRET } }, CFG)).toThrow(/dashboard\.password says/)
  })

  const prev = process.cwd()
  let dir = ""
  afterEach(() => { process.chdir(prev); if (dir) rmSync(dir, { recursive: true, force: true }); dir = "" })
  async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method }) as unknown as IncomingMessage
    let status = 200, out = ""
    const res = { writeHead: (s: number) => { status = s; return res }, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, path)
    return { status, body: JSON.parse(out) }
  }

  it("serves the file hidden, and a save through the classic handler keeps the secret on disk", async () => {
    dir = mkdtempSync(join(tmpdir(), "wall-hidden-"))
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ node: { id: "n", name: "n" }, dashboard: { token: "literal-dash-token", daemonUrl: "http://127.0.0.1:9" } }))
    process.chdir(dir)
    const read = await admin("GET", "/api/admin/config/hidden")
    expect(read.body.hidden).toBe(1)
    expect(read.body.raw).not.toContain("literal-dash-token")
    const edited = JSON.parse(read.body.raw)
    edited.node.name = "renamed"
    const saved = await admin("POST", "/api/admin/config/raw", { raw: JSON.stringify(edited) })
    expect(saved.status).toBe(200)
    const disk = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    expect(disk).toEqual({ node: { id: "n", name: "renamed" }, dashboard: { token: "literal-dash-token", daemonUrl: "http://127.0.0.1:9" } })
  })
})

describe("Phase 3 writes are the owner's, and reach the classic handlers (#1428)", () => {
  const WRITES: Array<[string, string, unknown]> = [
    ["POST", "mesh/peers", {}], ["DELETE", "mesh/peers", {}], ["POST", "mesh/toggle", {}], ["POST", "mesh/health", {}],
    ["POST", "business/orgchart", {}], ["DELETE", "business/orgchart", {}], ["POST", "business/project", {}], ["DELETE", "business/project", {}],
    ["POST", "business/client", {}], ["DELETE", "business/client", {}], ["POST", "business/contact", {}], ["DELETE", "business/contact", {}],
    ["POST", "boards", {}], ["DELETE", "boards", {}], ["POST", "boards/columns", {}], ["DELETE", "boards/columns", {}],
    ["POST", "actions", {}], ["DELETE", "actions", {}], ["POST", "actions/run", {}], ["POST", "tokens", {}], ["DELETE", "tokens", {}],
    ["POST", "screen", {}], ["POST", "wiki-notes", {}], ["POST", "config/raw", {}],
    ["POST", "approvals/settings", {}], ["POST", "approvals/requests/settings", {}],
  ]
  // Bodies each handler refuses before it writes anything.
  const REFUSED: Array<[string, string, unknown, RegExp]> = [
    ["POST", "mesh/peers", {}, /Peer URL/], ["DELETE", "business/orgchart", {}, /agentId required/], ["POST", "business/project", {}, /project id required/],
    ["DELETE", "business/contact", {}, /at least one filter/], ["POST", "boards", {}, /id required/], ["DELETE", "boards/columns", {}, /boardId and columnId/],
    ["DELETE", "actions", {}, /id required/], ["POST", "actions/run", {}, /id required/], ["DELETE", "tokens", {}, /Token id is required/],
    ["POST", "config/raw", {}, /Config body is empty/],
    ["POST", "approvals/settings", { defaultExpiryDays: -1 }, /defaultExpiryDays must be a positive number/],
    ["POST", "approvals/requests/settings", { staleAfterHours: -1 }, /staleAfterHours must be a positive number/],
  ]
  const TOKEN = "dash-secret"
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

  it("refuses every phase 3 write from anyone but the owner, before any handler runs", async () => {
    const base = await start()
    for (const [method, path, body] of WRITES) {
      const r = await fetch(`${base}/api/admin/wall/settings/${path}`, { method, headers: { "X-Forwarded-For": "100.64.0.9", "X-Requested-With": "agentx-board" }, body: JSON.stringify(body) })
      expect(r.status, `${method} ${path}`).toBe(401)
    }
  })

  it("hands the owner's writes to the classic handlers, approvals ones included", async () => {
    const base = await start()
    const auth = { Authorization: `Bearer ${TOKEN}`, "X-Requested-With": "agentx-board", "Content-Type": "application/json" }
    for (const [method, path, body, error] of REFUSED) {
      const r = await fetch(`${base}/api/admin/wall/settings/${path}`, { method, headers: auth, body: JSON.stringify(body) })
      expect(r.status, `${method} ${path}`).toBe(400)
      expect((await r.json()).error, `${method} ${path}`).toMatch(error)
    }
  })
})
