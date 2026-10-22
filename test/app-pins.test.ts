import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { PinStore, parsePinInput, parsePinUrl, pinsDeps, type PinsDeps } from "../src/daemon/app-pins"
import { daemonConfigSchema } from "../src/daemon/config"
import { APP_PINS_SCRIPT } from "../src/daemon/ui/pages/app-pins.client"
import { renderAppPage } from "../src/daemon/ui/pages/app"

const dir = mkdtempSync(join(tmpdir(), "agentx-pins-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const freshStore = () => new PinStore(join(dir, `pins-${n++}.json`))

describe("parsePinInput", () => {
  it("takes a label and an https address", () => {
    expect(parsePinInput({ label: "  Remote  ", url: "https://host.example.ts.net/tool/r/key/mac" }))
      .toEqual({ ok: true, value: { label: "Remote", url: "https://host.example.ts.net/tool/r/key/mac" } })
  })
  it("refuses anything that is not https, and addresses with credentials", () => {
    for (const url of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "example.com", "https://u:p@example.com/"]) {
      expect(parsePinUrl(url).ok).toBe(false)
    }
  })
  it("refuses control and invisible characters in a label", () => {
    expect(parsePinInput({ label: "Re" + String.fromCharCode(27) + "[31mmote", url: "https://a.example" }).ok).toBe(false)
    expect(parsePinInput({ label: "Remote" + String.fromCharCode(0x202e), url: "https://a.example" }).ok).toBe(false)
  })
  it("refuses an empty or long label", () => {
    expect(parsePinInput({ label: " ", url: "https://a.example" }).ok).toBe(false)
    expect(parsePinInput({ label: "x".repeat(41), url: "https://a.example" }).ok).toBe(false)
  })
})

describe("PinStore", () => {
  it("adds, renames and removes, and keeps the file private", () => {
    const s = freshStore()
    const a = s.add({ label: "Remote", url: "https://a.example/x" }, 12)
    if (!a.ok) throw new Error(a.error)
    expect(s.add({ label: "remote", url: "https://b.example" }, 12).ok).toBe(false)
    expect(s.rename(a.pin.id, "TV remote")).toMatchObject({ ok: true, pin: { label: "TV remote" } })
    expect(s.list().map((p) => p.label)).toEqual(["TV remote"])
    expect(s.rename("pin_000000", "x")).toMatchObject({ ok: false, status: 404 })
    expect(s.remove(a.pin.id)).toEqual({ ok: true })
    expect(s.remove(a.pin.id)).toMatchObject({ ok: false, status: 404 })
    expect(s.list()).toEqual([])
  })
  it("stops at the limit", () => {
    const s = freshStore()
    expect(s.add({ label: "A", url: "https://a.example" }, 1).ok).toBe(true)
    expect(s.add({ label: "B", url: "https://b.example" }, 1)).toMatchObject({ ok: false })
  })
  it("drops entries in the file that are not valid pins", () => {
    const path = join(dir, "hand-edited.json")
    writeFileSync(path, JSON.stringify({ pins: [
      { id: "pin_abcdef", label: "Ok", url: "https://ok.example", createdAt: "x" },
      { id: "pin_bad001", label: "Bad", url: "javascript:alert(1)", createdAt: "x" },
      { id: "nope", label: "Bad id", url: "https://ok.example", createdAt: "x" },
    ] }))
    expect(new PinStore(path).list().map((p) => p.label)).toEqual(["Ok"])
  })
  it("never writes over a file it can't read, so a typo loses no pin", () => {
    const broken = join(dir, "broken.json")
    const text = '{ "pins": [ { "id": "pin_abcdef", "label": "A", "url": "https://a.example", "createdAt": "x" }, ] }'
    writeFileSync(broken, text)
    const s = new PinStore(broken)
    expect(s.list()).toEqual([])
    expect(s.add({ label: "B", url: "https://b.example" }, 5)).toMatchObject({ ok: false, status: 409 })
    expect(s.remove("pin_abcdef")).toMatchObject({ ok: false, status: 409 })
    expect(readFileSync(broken, "utf-8")).toBe(text)
    // Entries it would drop count as damage too.
    const partly = join(dir, "partly.json")
    writeFileSync(partly, JSON.stringify({ pins: [{ id: "pin_abcdef", label: "Ok", url: "https://ok.example", createdAt: "x" }, { id: "x" }] }))
    expect(new PinStore(partly).rename("pin_abcdef", "New")).toMatchObject({ ok: false, status: 409 })
  })
  it("writes the file readable by the owner only", () => {
    const path = join(dir, "mode.json")
    new PinStore(path).add({ label: "A", url: "https://a.example" }, 5)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe("config", () => {
  it("has defaults and resolves the file from the folder", () => {
    const config = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(config.app.pins).toEqual({ file: ".agentx/app-pins.json", max: 12 })
    expect(pinsDeps(config, dir).max).toBe(12)
  })
})

describe("/api/app/pins", () => {
  let tokens: TokenStore
  let server: Server
  let base: string
  let deps: PinsDeps

  beforeAll(async () => {
    tokens = new TokenStore(dir)
    server = createServer(async (req, res) => {
      const path = new URL(req.url || "/", "http://x").pathname
      if (!await handleAppRequest(req, res, path, req.method || "GET", { tokens, pins: deps })) { res.writeHead(418); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => server.close())
  beforeEach(() => { deps = { store: freshStore(), max: 3 } })

  function phone() {
    const { token } = tokens.create({ name: "Test phone", scopes: ["app"] })
    return (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  it("needs a paired phone", async () => {
    expect((await fetch(`${base}/api/app/pins`)).status).toBe(401)
    expect((await fetch(`${base}/api/app/pins/add`, { method: "POST", body: "{}" })).status).toBe(401)
  })

  it("pins, lists, renames and removes a page", async () => {
    const call = phone()
    const add = await call("POST", "/api/app/pins/add", { label: "Remote", url: "https://host.example/tool" })
    expect(add.status).toBe(200)
    const { pin } = await add.json()
    expect(await (await call("GET", "/api/app/pins")).json()).toEqual({ pins: [pin], max: 3 })
    const ren = await call("POST", "/api/app/pins/rename", { id: pin.id, label: "TV" })
    expect((await ren.json()).pin.label).toBe("TV")
    expect((await call("POST", "/api/app/pins/remove", { id: pin.id })).status).toBe(200)
    expect((await call("POST", "/api/app/pins/remove", { id: pin.id })).status).toBe(404)
    expect((await (await call("GET", "/api/app/pins")).json()).pins).toEqual([])
  })

  it("refuses a non-https page, a duplicate name and a fourth pin", async () => {
    const call = phone()
    expect((await call("POST", "/api/app/pins/add", { label: "X", url: "http://host.example" })).status).toBe(400)
    for (const label of ["A", "B", "C"]) expect((await call("POST", "/api/app/pins/add", { label, url: "https://h.example" })).status).toBe(200)
    expect((await call("POST", "/api/app/pins/add", { label: "a", url: "https://h.example" })).status).toBe(409)
    expect((await call("POST", "/api/app/pins/add", { label: "D", url: "https://h.example" })).status).toBe(409)
    expect((await call("POST", "/api/app/pins/rename", { id: "pin_nothere", label: "Z" })).status).toBe(404)
  })
})

describe("phone app page", () => {
  it("carries the button row and the card script", () => {
    const html = renderAppPage()
    expect(html).toContain('<nav id="pin-bar"')
    expect(html).toContain(APP_PINS_SCRIPT)
    expect(() => new Function(APP_PINS_SCRIPT)).not.toThrow()
    // The row sits with the header, before the tab panels.
    expect(html.indexOf('id="pin-bar"')).toBeLessThan(html.indexOf("<main>"))
  })

  // Runs the shipped script against a minimal fake page and returns the
  // button row's HTML once /api/app/pins answered with `pins`.
  async function barFor(pins: unknown[]): Promise<{ html: string; hidden: boolean }> {
    const els = new Map<string, any>()
    const el = (id: string) => {
      if (!els.has(id)) {
        els.set(id, {
          id, textContent: "", innerHTML: "", hidden: false, className: "",
          addEventListener: () => {}, insertBefore: () => {}, elements: { namedItem: () => ({ value: "" }) },
        })
      }
      return els.get(id)
    }
    const document = {
      getElementById: (id: string) => (id === "pl-card" || id === "al-recent-head" ? null : el(id)),
      createElement: () => ({ set innerHTML(_: string) {} }),
      addEventListener: () => {},
    }
    const fetch = async () => ({ ok: true, json: async () => ({ pins, max: 12 }) })
    new Function("document", "fetch", "URL", APP_PINS_SCRIPT)(document, fetch, URL)
    await new Promise((r) => setTimeout(r, 10))
    return { html: el("pin-bar").innerHTML, hidden: el("pin-bar").hidden }
  }

  it("shows each pin as a same-window link, escaped", async () => {
    const bar = await barFor([{ id: "pin_abcdef", label: "<b>Remote</b>", url: "https://host.example/a?b=1&c=2" }])
    expect(bar.hidden).toBe(false)
    expect(bar.html).toBe('<a class="pin-btn" href="https://host.example/a?b=1&amp;c=2">&lt;b&gt;Remote&lt;/b&gt;</a>')
    expect(bar.html).not.toContain("target=")
  })

  it("never turns a non-https value into a link, and hides an empty row", async () => {
    const bar = await barFor([{ id: "pin_abcdef", label: "Bad", url: "javascript:alert(1)" }])
    expect(bar.html).toBe("")
    expect(bar.hidden).toBe(true)
  })
})

// The file the CLI and the daemon share is plain JSON.
describe("file format", () => {
  it("is { pins: [...] }", () => {
    const path = join(dir, "format.json")
    new PinStore(path).add({ label: "A", url: "https://a.example" }, 5)
    expect(Object.keys(JSON.parse(readFileSync(path, "utf-8")))).toEqual(["pins"])
  })
})
