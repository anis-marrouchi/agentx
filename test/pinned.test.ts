import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { PinnedStore, configPinId, configPins, parsePinLabel, parsePinUrl, pinnedDeps, type PinnedDeps } from "../src/daemon/app-pinned"
import { daemonConfigSchema } from "../src/daemon/config"
import { APP_PINNED_SCRIPT } from "../src/daemon/ui/pages/app-pinned.client"
import { renderAppPage } from "../src/daemon/ui/pages/app"

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentx-pinned-")) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const freshStore = () => new PinnedStore(join(dir, `pinned-${++n}.json`))
const NODE = { id: "n", name: "n" }

describe("parsePinUrl and parsePinLabel", () => {
  it("accepts an https address and a label", () => {
    expect(parsePinUrl(" https://tools.example.ts.net/remote ")).toEqual({ ok: true, value: "https://tools.example.ts.net/remote" })
    expect(parsePinLabel("  My   remote ")).toEqual({ ok: true, value: "My remote" })
  })
  it("refuses http, other schemes, credentials and junk", () => {
    expect(parsePinUrl("http://tools.example.ts.net").ok).toBe(false)
    expect(parsePinUrl("javascript:alert(1)").ok).toBe(false)
    expect(parsePinUrl("https://user:pw@tools.example.ts.net").ok).toBe(false)
    expect(parsePinUrl("not a url").ok).toBe(false)
    expect(parsePinUrl("").ok).toBe(false)
    expect(parsePinUrl(`https://example.com/${"a".repeat(2100)}`).ok).toBe(false)
    expect(parsePinLabel("").ok).toBe(false)
    expect(parsePinLabel("x".repeat(41)).ok).toBe(false)
  })
})

describe("config pages", () => {
  it("parse with defaults and refuse http", () => {
    const c = daemonConfigSchema.parse({ node: NODE })
    expect(c.app.pinned).toEqual({ enabled: true, pages: [], file: ".agentx/pinned.json", max: 12 })
    expect(() => daemonConfigSchema.parse({ node: NODE, app: { pinned: { pages: [{ label: "A", url: "http://example.com" }] } } })).toThrow()
  })
  it("get stable ids and drop duplicates", () => {
    const pins = configPins([{ label: "A", url: "https://a.example" }, { label: "B", url: "https://a.example/" }])
    expect(pins).toEqual([{ id: configPinId("https://a.example/"), label: "A", url: "https://a.example/" }])
  })
})

describe("/api/app/pinned", () => {
  let tokens: TokenStore
  let server: Server
  let base: string
  let deps: PinnedDeps
  let call: (method: string, path: string, body?: unknown) => Promise<Response>

  beforeAll(async () => {
    tokens = new TokenStore(dir)
    server = createServer(async (req, res) => {
      const path = new URL(req.url || "/", "http://x").pathname
      if (!await handleAppRequest(req, res, path, req.method || "GET", { tokens, pinned: deps })) { res.writeHead(418); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as any).port}`
    const { token } = tokens.create({ name: "Test phone", scopes: ["app"] })
    call = (method, path, body) => fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  })
  afterAll(() => server.close())
  beforeEach(() => {
    deps = { enabled: true, max: 3, config: configPins([{ label: "Status", url: "https://status.example.ts.net" }]), store: freshStore() }
  })

  it("needs a paired phone", async () => {
    expect((await fetch(`${base}/api/app/pinned`)).status).toBe(401)
  })

  it("lists config pages, adds, renames and removes app pages", async () => {
    const add = await call("POST", "/api/app/pinned/add", { label: "Remote", url: "https://tools.example.ts.net/remote" })
    expect(add.status).toBe(200)
    const { page } = await add.json()
    expect(page).toMatchObject({ label: "Remote", source: "app" })
    let state = await (await call("GET", "/api/app/pinned")).json()
    expect(state.pages.map((p: any) => [p.label, p.source])).toEqual([["Status", "config"], ["Remote", "app"]])
    expect((await call("POST", "/api/app/pinned/rename", { id: page.id, label: "TV remote" })).status).toBe(200)
    state = await (await call("GET", "/api/app/pinned")).json()
    expect(state.pages[1].label).toBe("TV remote")
    expect((await call("POST", "/api/app/pinned/remove", { id: page.id })).status).toBe(200)
    state = await (await call("GET", "/api/app/pinned")).json()
    expect(state.pages).toHaveLength(1)
    expect((await call("POST", "/api/app/pinned/remove", { id: page.id })).status).toBe(404)
  })

  it("keeps config pages read only and refuses duplicates, http and too many", async () => {
    const cfg = deps.config[0]
    expect((await call("POST", "/api/app/pinned/rename", { id: cfg.id, label: "X" })).status).toBe(409)
    expect((await call("POST", "/api/app/pinned/remove", { id: cfg.id })).status).toBe(409)
    expect((await call("POST", "/api/app/pinned/add", { label: "Dup", url: cfg.url })).status).toBe(409)
    expect((await call("POST", "/api/app/pinned/add", { label: "Plain", url: "http://tools.example.ts.net" })).status).toBe(400)
    expect((await call("POST", "/api/app/pinned/add", { label: "One", url: "https://one.example" })).status).toBe(200)
    expect((await call("POST", "/api/app/pinned/add", { label: "One again", url: "https://one.example" })).status).toBe(409)
    expect((await call("POST", "/api/app/pinned/add", { label: "Two", url: "https://two.example" })).status).toBe(200)
    const full = await call("POST", "/api/app/pinned/add", { label: "Three", url: "https://three.example" })
    expect(full.status).toBe(409)
    expect((await full.json()).error).toContain("app.pinned.max")
  })

  it("says when pinned pages are off", async () => {
    deps.enabled = false
    const state = await (await call("GET", "/api/app/pinned")).json()
    expect(state).toMatchObject({ enabled: false, pages: [] })
    expect((await call("POST", "/api/app/pinned/add", { label: "A", url: "https://a.example" })).status).toBe(403)
  })

  it("builds its deps from the config", () => {
    const c = daemonConfigSchema.parse({ node: NODE, app: { pinned: { pages: [{ label: "Status", url: "https://status.example.ts.net" }], max: 5 } } })
    const d = pinnedDeps(c, dir)
    expect(d).toMatchObject({ enabled: true, max: 5 })
    expect(d.config[0].label).toBe("Status")
  })
})

describe("phone app page", () => {
  it("carries the strip and the Pinned pages card", () => {
    const html = renderAppPage()
    expect(html).toContain('id="pn-strip"')
    expect(html).toContain(APP_PINNED_SCRIPT)
    expect(() => new Function(APP_PINNED_SCRIPT)).not.toThrow()
  })
  it("opens a pinned page in the same window, never a new tab or a frame", () => {
    expect(APP_PINNED_SCRIPT).not.toContain("target=")
    expect(APP_PINNED_SCRIPT).not.toContain("iframe")
  })
})
