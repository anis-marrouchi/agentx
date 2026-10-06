import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { inflateSync } from "zlib"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest, APP_COOKIE } from "../src/daemon/app-routes"
import { appIconPng } from "../src/daemon/app-icon"
import { exposedDashboardMounts } from "../src/commands/app"
import { renderAppPage, renderAppPairPage, renderAppLockedPage, renderAppManifest, APP_SERVICE_WORKER } from "../src/daemon/ui/pages/app"

// A real server on 127.0.0.1: every request below is a loopback request,
// which is exactly the case `tailscale serve` produces. None may get in
// without an `app` token.

let dir: string
let store: TokenStore
let server: Server
let base: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-app-"))
  store = new TokenStore(dir)
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const handled = await handleAppRequest(req, res, path, req.method || "GET", { nodeName: "node-a", tokens: store })
    if (!handled) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

describe("app token gate (loopback is not trusted)", () => {
  it("refuses /app and /api/app/* with no token", async () => {
    const page = await fetch(`${base}/app`)
    expect(page.status).toBe(401)
    expect(await page.text()).toContain("agentx app pair")
    expect((await fetch(`${base}/api/app/me`)).status).toBe(401)
    expect((await fetch(`${base}/api/app/anything`)).status).toBe(401)
  })

  it("refuses a valid token that lacks the app scope", async () => {
    const { token } = store.create({ name: "admin", scopes: ["dashboard:write"] })
    expect((await fetch(`${base}/api/app/me`, { headers: bearer(token) })).status).toBe(401)
    expect((await fetch(`${base}/api/app/session`, { method: "POST", headers: bearer(token) })).status).toBe(401)
  })

  it("accepts an app token by header, then by the session cookie", async () => {
    const { token, record } = store.create({ name: "Test phone", scopes: ["app"] })
    const me = await fetch(`${base}/api/app/me`, { headers: bearer(token) })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ id: record.id, device: "Test phone", node: "node-a" })

    const session = await fetch(`${base}/api/app/session`, { method: "POST", headers: bearer(token) })
    expect(session.status).toBe(200)
    const setCookie = session.headers.get("set-cookie") || ""
    expect(setCookie).toMatch(new RegExp(`^${APP_COOKIE}=${token};`))
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(setCookie).toContain(attr)
    expect(setCookie).not.toContain("Strict")

    const cookie = { Cookie: `other=1; ${APP_COOKIE}=${token}` }
    const page = await fetch(`${base}/app`, { headers: cookie })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('role="tablist"')
  })

  it("locks a phone out as soon as it is revoked", async () => {
    const { token, record } = store.create({ name: "Lost phone", scopes: ["app"] })
    expect((await fetch(`${base}/app`, { headers: { Cookie: `${APP_COOKIE}=${token}` } })).status).toBe(200)
    store.revoke(record.id)
    expect((await fetch(`${base}/app`, { headers: { Cookie: `${APP_COOKIE}=${token}` } })).status).toBe(401)
    expect((await fetch(`${base}/api/app/me`, { headers: bearer(token) })).status).toBe(401)
  })

  it("never takes the token from the query string", async () => {
    const { token } = store.create({ name: "Query phone", scopes: ["app"] })
    expect((await fetch(`${base}/api/app/me?token=${token}`)).status).toBe(401)
  })

  it("leaves other paths to the dashboard", async () => {
    expect((await fetch(`${base}/apps`)).status).toBe(418)
    expect((await fetch(`${base}/api/apps`)).status).toBe(418)
  })
})

describe("public shell assets", () => {
  it("serves the manifest, service worker, icons and pair page without a token", async () => {
    const manifest = await fetch(`${base}/app/manifest.webmanifest`)
    expect(manifest.status).toBe(200)
    const m = await manifest.json()
    expect(m).toMatchObject({ start_url: "/app", scope: "/app", display: "standalone" })
    expect(m.icons.map((i: any) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]))

    const sw = await fetch(`${base}/app/sw.js`)
    expect(sw.status).toBe(200)
    expect(sw.headers.get("service-worker-allowed")).toBe("/app")

    for (const size of [192, 512]) {
      const icon = await fetch(`${base}/app/icon-${size}.png`)
      expect(icon.headers.get("content-type")).toBe("image/png")
      expect(Buffer.from(await icon.arrayBuffer()).readUInt32BE(16)).toBe(size)
    }
    expect((await fetch(`${base}/app/pair`)).status).toBe(200)
  })

  it("draws a decodable icon of the right size", () => {
    const png = appIconPng(192)
    expect(png.subarray(1, 4).toString()).toBe("PNG")
    const idatLen = png.readUInt32BE(33)
    const raw = inflateSync(png.subarray(41, 41 + idatLen))
    expect(raw.length).toBe(192 * (1 + 192 * 4))
  })
})

describe("page scripts parse", () => {
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])

  it("app shell, pair page and service worker are valid JavaScript", () => {
    for (const html of [renderAppPage(), renderAppPairPage()]) {
      const found = scripts(html)
      expect(found.length).toBeGreaterThan(1)
      for (const s of found) expect(() => new Function(s)).not.toThrow()
    }
    expect(() => new Function(APP_SERVICE_WORKER)).not.toThrow()
    expect(() => JSON.parse(renderAppManifest())).not.toThrow()
  })

  it("the service worker never caches the API", () => {
    expect(APP_SERVICE_WORKER).toContain("indexOf('/api/') === 0) return")
  })

  it("the shell has four labelled tabs, safe-area padding and a theme toggle", () => {
    const html = renderAppPage()
    for (const t of ["Chat", "Fleet", "Activity", "Alerts"]) expect(html).toContain(`<span>${t}</span></button>`)
    expect(html).toContain("viewport-fit=cover")
    expect(html).toContain("env(safe-area-inset-bottom)")
    expect(html).toContain('id="theme"')
  })

  it("every phone page shares the approved palette, with readable blue text (#488)", () => {
    for (const html of [renderAppPage(), renderAppPairPage(), renderAppLockedPage()]) {
      // 5.13:1 on white and 6.4:1 on the dark ground; #2979FF would be 3.98:1.
      expect(html).toContain("--ax-accent: #1f66e5")
      expect(html).toContain("--ax-accent: #6aa0ff")
    }
    // The palette comes after the desktop tokens, so it wins.
    const locked = renderAppLockedPage()
    expect(locked.indexOf("--ax-accent: var(--ax-blue)")).toBeLessThan(locked.indexOf("--ax-accent: #1f66e5"))
  })
})

describe("token store", () => {
  it("accepts the app scope", () => {
    expect(() => store.create({ name: "p", scopes: ["app"] })).not.toThrow()
  })
})

describe("agentx app pair: tailscale serve guard", () => {
  const web = (handlers: Record<string, string>) => ({
    Web: { "mac.tail1.ts.net:443": { Handlers: Object.fromEntries(Object.entries(handlers).map(([m, p]) => [m, { Proxy: p }])) } },
  })

  it("flags `tailscale serve 4202`, which mounts the whole dashboard at /", () => {
    expect(exposedDashboardMounts(web({ "/": "http://127.0.0.1:4202" }), 4202)).toEqual(["mac.tail1.ts.net:443/"])
  })

  it("accepts the path-scoped setup from the guide", () => {
    const status = web({ "/app": "http://127.0.0.1:4202/app", "/api/app": "http://127.0.0.1:4202/api/app" })
    expect(exposedDashboardMounts(status, 4202)).toEqual([])
  })

  it("accepts the member page's two paths, alone or next to the app's", () => {
    const member = { "/member": "http://127.0.0.1:4202/member", "/api/member": "http://127.0.0.1:4202/api/member" }
    expect(exposedDashboardMounts(web(member), 4202)).toEqual([])
    expect(exposedDashboardMounts(web({ ...member, "/app": "http://127.0.0.1:4202/app", "/api/app/": "http://127.0.0.1:4202/api/app" }), 4202)).toEqual([])
    expect(exposedDashboardMounts(web({ ...member, "/members": "http://127.0.0.1:4202/members" }), 4202)).toEqual(["mac.tail1.ts.net:443/members"])
  })

  it("accepts the Android guide's assetlinks.json path, only when it proxies to that same path (#703)", () => {
    const app = { "/app": "http://127.0.0.1:4202/app", "/api/app": "http://127.0.0.1:4202/api/app" }
    const links = { "/.well-known/assetlinks.json": "http://127.0.0.1:4202/.well-known/assetlinks.json" }
    expect(exposedDashboardMounts(web({ ...app, ...links }), 4202)).toEqual([])
    expect(exposedDashboardMounts(web({ "/.well-known/assetlinks.json": "http://127.0.0.1:4202/" }), 4202))
      .toEqual(["mac.tail1.ts.net:443/.well-known/assetlinks.json"])
    expect(exposedDashboardMounts(web({ "/.well-known/assetlinks.json": "http://127.0.0.1:4202" }), 4202))
      .toEqual(["mac.tail1.ts.net:443/.well-known/assetlinks.json"])
    expect(exposedDashboardMounts(web({ "/.well-known": "http://127.0.0.1:4202/.well-known" }), 4202))
      .toEqual(["mac.tail1.ts.net:443/.well-known"])
  })

  it("ignores other local services and a missing tailscale", () => {
    expect(exposedDashboardMounts(web({ "/": "http://localhost:3000" }), 4202)).toEqual([])
    expect(exposedDashboardMounts(null, 4202)).toEqual([])
  })

  it("also checks foreground serve sessions", () => {
    const status = { Foreground: { abc: web({ "/admin": "localhost:4202/admin" }) } }
    expect(exposedDashboardMounts(status, 4202)).toEqual(["mac.tail1.ts.net:443/admin"])
  })
})
