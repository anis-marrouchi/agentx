import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runInNewContext } from "vm"
// @ts-ignore - no type declarations for qrcode
import QRCode from "qrcode"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest, qrDecoderJs } from "../src/daemon/app-routes"
import { RejectLog } from "../src/daemon/app-auth-log"
import { CODE_ALPHABET, generateCode, formatCode } from "../src/daemon/pair-codes"
import { formatPairInput, parsePairScan } from "../src/daemon/ui/pages/app-pair-logic"
import { renderAppLockedPage } from "../src/daemon/ui/pages/app"
import { SCAN_SCRIPT } from "../src/daemon/ui/pages/app-scan.client"

// #234: scan the pairing QR code from inside the installed app, and a code
// field that formats itself.

const TOKEN = "agx_live_" + "0123456789abcdef".repeat(4)

describe("code field formatting", () => {
  it("capitalises and inserts the dash after four", () => {
    expect(formatPairInput("abcdefgh", 8)).toEqual({ value: "ABCD-EFGH", caret: 9 })
    expect(formatPairInput("abcd", 4)).toEqual({ value: "ABCD", caret: 4 })
    expect(formatPairInput("abcde", 5)).toEqual({ value: "ABCD-E", caret: 6 })
    expect(formatPairInput("", 0)).toEqual({ value: "", caret: 0 })
  })

  it("normalises a paste with spaces, dashes and extra symbols, and stops at eight", () => {
    expect(formatPairInput(" 7kq4 – m2xh ", 13).value).toBe("7KQ4-M2XH")
    expect(formatPairInput("7KQ4-M2XH-9999", 14).value).toBe("7KQ4-M2XH")
  })

  it("keeps exactly the code alphabet", () => {
    for (const ch of CODE_ALPHABET) expect(formatPairInput(ch.toLowerCase(), 1).value).toBe(ch)
    for (const ch of "0O1IL!@ #_") expect(formatPairInput(ch, 1).value).toBe("")
  })

  it("keeps the caret after the same symbol when editing mid-code", () => {
    // Typing X after "AB" in "AB|CD-EFG": raw "ABXCD-EFG", caret 3.
    expect(formatPairInput("ABXCD-EFG", 3)).toEqual({ value: "ABXC-DEFG", caret: 3 })
    // Deleting the dash with Backspace re-adds it; the caret stays put.
    expect(formatPairInput("ABCDEFGH", 4)).toEqual({ value: "ABCD-EFGH", caret: 4 })
    // A caret past the dash moves over it.
    expect(formatPairInput("ABCD-EF", 7)).toEqual({ value: "ABCD-EF", caret: 7 })
  })
})

describe("scan result parsing", () => {
  it("takes the token from a pairing link on any origin", () => {
    for (const origin of ["https://mac.tail1.ts.net", "https://phone-host.example:8443", "http://127.0.0.1:4202"]) {
      expect(parsePairScan(`${origin}/app/pair#token=${TOKEN}`)).toEqual({ kind: "token", token: TOKEN })
    }
    expect(parsePairScan(`  https://x.example/app/pair#foo=1&token=${TOKEN}\n`)).toEqual({ kind: "token", token: TOKEN })
  })

  it("rejects pairing links without a well-formed device token", () => {
    for (const s of [
      "https://x.example/app/pair#token=",
      "https://x.example/app/pair#token=agx_live_short",
      `https://x.example/app/pair#token=${TOKEN.toUpperCase()}`,
      "https://x.example/app/pair#token=%E0%A4%A",
      `https://x.example/app/pairing#token=${TOKEN}`,
      `https://x.example/other/app/pair#token=${TOKEN}`,
      `https://x.example/app/pair?token=${TOKEN}`,
      `javascript:alert(1)//app/pair#token=${TOKEN}`,
    ]) expect(parsePairScan(s)).toEqual({ kind: "none" })
  })

  it("reads a bare code in any case, with or without the dash", () => {
    expect(parsePairScan("7KQ4-M2XH")).toEqual({ kind: "code", code: "7KQ4-M2XH" })
    expect(parsePairScan("7kq4m2xh")).toEqual({ kind: "code", code: "7KQ4-M2XH" })
    expect(parsePairScan(" abcd-efgh ")).toEqual({ kind: "code", code: "ABCD-EFGH" })
  })

  it("calls everything else not a pairing code", () => {
    for (const s of ["", "hello", "https://example.com", "WIFI:S:home;T:WPA;P:secret;;", "ABCD-EFGHI", "ABC-DEFGH", "ABCD--EFGH"]) {
      expect(parsePairScan(s)).toEqual({ kind: "none" })
    }
  })
})

// Draw a QR code to RGBA pixels, the way the page's canvas hands frames to
// the decoder, and read it back with the exact file /app/qr.js serves.
function qrPixels(text: string, scale = 6, margin = 4) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" })
  const n = modules.size
  const size = (n + margin * 2) * scale
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!modules.get(y, x)) continue
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4
      data[i] = data[i + 1] = data[i + 2] = 0
    }
  }
  return { data, size }
}

function servedJsQR(): (d: Uint8ClampedArray, w: number, h: number, o?: object) => { data: string } | null {
  const box: any = {}
  runInNewContext(qrDecoderJs()!.toString("utf8"), { self: box })
  return box.jsQR
}

describe("decoder path: generated QR → jsQR → parsePairScan", () => {
  it("pairs from the QR that agentx app pair prints", () => {
    const jsQR = servedJsQR()
    const link = `https://mac.tail1.ts.net/app/pair#token=${TOKEN}`
    const { data, size } = qrPixels(link)
    const found = jsQR(data, size, size, { inversionAttempts: "attemptBoth" })
    expect(found?.data).toBe(link)
    expect(parsePairScan(found!.data)).toEqual({ kind: "token", token: TOKEN })
  })

  it("reads a code QR, and names a foreign QR as such", () => {
    const jsQR = servedJsQR()
    const code = formatCode(generateCode())
    const a = qrPixels(code)
    expect(parsePairScan(jsQR(a.data, a.size, a.size)!.data)).toEqual({ kind: "code", code })
    const b = qrPixels("https://example.com/menu")
    expect(parsePairScan(jsQR(b.data, b.size, b.size)!.data)).toEqual({ kind: "none" })
  })
})

describe("GET /app/qr.js", () => {
  let dir: string
  let server: Server
  let base: string
  const lines: string[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agentx-qr-"))
    const tokens = new TokenStore(dir)
    const rejectLog = new RejectLog((l) => lines.push(l))
    server = createServer(async (req, res) => {
      const path = new URL(req.url || "/", "http://x").pathname
      if (!(await handleAppRequest(req, res, path, req.method || "GET", { tokens, rejectLog }))) { res.writeHead(418); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

  it("is public, cached long, and carries the licence notice", async () => {
    const r = await fetch(`${base}/app/qr.js`)
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("text/javascript")
    expect(r.headers.get("cache-control")).toMatch(/^public, max-age=\d{7,}$/)
    const body = await r.text()
    expect(body.startsWith("/*! jsQR 1.4.0 | Apache-2.0 | https://github.com/cozmo/jsQR */")).toBe(true)
    expect(body).toContain("webpackUniversalModuleDefinition")
    expect(lines).toEqual([])
  })
})

describe("locked page scanner", () => {
  it("offers Scan, limits the code field to nine characters, and parses", () => {
    const html = renderAppLockedPage()
    expect(html).toContain('id="scan-btn"')
    expect(html).toContain(">Scan QR code</button>")
    expect(html).toContain('maxlength="9"')
    expect(html).toMatch(/<video id="scan-video" playsinline muted autoplay>/)
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts).toContain(SCAN_SCRIPT)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    expect(SCAN_SCRIPT).not.toMatch(/[\\`]|\$\{/)
    // jsQR is loaded only when Scan is tapped, never with the page.
    expect(html).not.toContain('src="/app/qr.js"')
  })
})

// Run the real page scripts with a fake camera and BarcodeDetector.
function runScanner(scanned: string, opts: { camera?: "ok" | "denied" } = {}) {
  const html = renderAppLockedPage()
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).slice(1)
  const listeners: Record<string, Record<string, Function>> = {}
  const el = (id: string) => ({
    id, hidden: id === "scan", disabled: false, textContent: "", className: "", value: "", srcObject: null as any,
    addEventListener(t: string, f: Function) { (listeners[id] ??= {})[t] = f },
    focus() {}, select() {}, play: () => Promise.resolve(),
  })
  const els: Record<string, any> = {}
  const stopped: string[] = []
  const posts: { url: string; auth?: string }[] = []
  const replaced: string[] = []
  const submitted: string[] = []
  const track = { stop: () => stopped.push("track") }
  const g: Record<string, any> = {
    document: {
      getElementById: (id: string) => (els[id] ??= el(id)),
      addEventListener(t: string, f: Function) { (listeners.document ??= {})[t] = f },
      body: { classList: { add() {}, remove() {} } }, head: { appendChild() {} }, hidden: false,
      createElement: () => ({}),
    },
    navigator: {
      onLine: true,
      mediaDevices: {
        getUserMedia: () => opts.camera === "denied"
          ? Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }))
          : Promise.resolve({ getTracks: () => [track] }),
      },
    },
    location: { replace: (u: string) => replaced.push(u) },
    sessionStorage: { getItem: () => String(Date.now()), setItem() {} }, // no self-heal bounce
    fetch: (url: string, init?: any) => {
      posts.push({ url, auth: init?.headers?.Authorization })
      return Promise.resolve(new Response("{}", { status: url === "/api/app/session" ? 200 : 401 }))
    },
    setInterval, clearInterval, Event,
  }
  g.window = { addEventListener(t: string, f: Function) { (listeners.window ??= {})[t] = f }, BarcodeDetector: undefined as any }
  class FakeDetector {
    static getSupportedFormats() { return Promise.resolve(["qr_code"]) }
    detect() { return Promise.resolve([{ rawValue: scanned }]) }
  }
  g.window.BarcodeDetector = FakeDetector
  new Function(...Object.keys(g), scripts.join(";\n"))(...Object.values(g))
  const form = els["pair-form"]
  form.requestSubmit = () => submitted.push(els["pair-code"].value)
  return {
    tap: () => listeners["scan-btn"].click(),
    hide: () => { g.document.hidden = true; listeners.document.visibilitychange() },
    els, stopped, posts, replaced, submitted,
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("scanner flow (stubbed camera)", () => {
  it("a pairing link posts the token as Bearer, stops the camera and opens the app", async () => {
    const s = runScanner(`https://mac.tail1.ts.net/app/pair#token=${TOKEN}`)
    s.tap()
    await wait(300)
    expect(s.posts).toContainEqual({ url: "/api/app/session", auth: `Bearer ${TOKEN}` })
    expect(s.stopped.length).toBeGreaterThan(0)
    expect(s.replaced).toEqual(["/app"])
  })

  it("a bare code fills the field and submits it", async () => {
    const s = runScanner("abcd-efgh")
    s.tap()
    await wait(300)
    expect(s.submitted).toEqual(["ABCD-EFGH"])
    expect(s.els.scan.hidden).toBe(true)
    expect(s.stopped.length).toBeGreaterThan(0)
  })

  it("any other QR keeps scanning and says so", async () => {
    const s = runScanner("https://example.com/menu")
    s.tap()
    await wait(300)
    expect(s.els["scan-msg"].textContent).toContain("That QR isn't an AgentX pairing code")
    expect(s.els.scan.hidden).toBe(false)
    s.hide()
    expect(s.els.scan.hidden).toBe(true)
    expect(s.stopped.length).toBeGreaterThan(0)
  })

  it("explains a denied camera", async () => {
    const s = runScanner("", { camera: "denied" })
    s.tap()
    await wait(20)
    expect(s.els["scan-msg"].textContent).toContain("Allow camera access")
    expect(s.els["scan-msg"].className).toContain("bad")
  })
})
