import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { APP_COOKIE, handleAppRequest } from "../src/daemon/app-routes"
import { CODE_ALPHABET, CODE_TTL_MS, PairCodeStore, formatCode, generateCode, normalizeCode } from "../src/daemon/pair-codes"
import { PAIR_CODE_FAILED, PairAttemptLimiter } from "../src/daemon/app-pair-code"
import { renderAppLockedPage, APP_SERVICE_WORKER } from "../src/daemon/ui/pages/app"
import { LOCKED_SCRIPT } from "../src/daemon/ui/pages/app-locked.client"

vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execFileSync: () => { throw new Error("no tailscale in tests") },
}))

let dir: string
let tokens: TokenStore
let clock: number
let codes: PairCodeStore
let limiter: PairAttemptLimiter
let server: Server
let base: string
const MIN_MS = 60

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-paircode-"))
  tokens = new TokenStore(dir)
  codes = new PairCodeStore(dir, undefined, () => clock)
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const ctx = { tokens, pairCodes: codes, pairLimiter: limiter, pairMinMs: MIN_MS }
    if (!(await handleAppRequest(req, res, path, req.method || "GET", ctx))) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

beforeEach(() => {
  clock = Date.now()
  limiter = new PairAttemptLimiter(undefined, () => clock)
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

function pairPhone(name = "Test phone") {
  const { token, record } = tokens.create({ name, scopes: ["app"] })
  const { code } = codes.create({ token, tokenId: record.id, name })
  return { token, record, code }
}

async function tryCode(code: string) {
  const t0 = Date.now()
  const r = await fetch(`${base}/api/app/pair-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  })
  return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie"), retryAfter: r.headers.get("retry-after"), ms: Date.now() - t0 }
}

describe("code format", () => {
  it("is 8 symbols from an alphabet without look-alikes", () => {
    for (const ch of "0O1IL") expect(CODE_ALPHABET).not.toContain(ch)
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = generateCode()
      expect(c).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`))
      seen.add(c)
    }
    expect(seen.size).toBe(200)
    expect(formatCode("ABCD2345")).toBe("ABCD-2345")
  })

  it("normalises case, spaces and dashes, and rejects anything else", () => {
    expect(normalizeCode("abcd-2345")).toBe("ABCD2345")
    expect(normalizeCode(" ab cd – 23 45 ")).toBe("ABCD2345")
    expect(normalizeCode("ABCD234")).toBeNull()
    expect(normalizeCode("ABCD23450")).toBeNull()
    expect(normalizeCode("ABCD-O345")).toBeNull()
    expect(normalizeCode(12345678)).toBeNull()
  })
})

describe("code store", () => {
  it("stores neither the code nor the device token, only a hash and a sealed token", () => {
    const { token, record, code } = pairPhone()
    const file = join(dir, ".agentx/pair-codes.json")
    const raw = readFileSync(file, "utf-8")
    expect(raw).not.toContain(code)
    expect(raw).not.toContain(token)
    const rec = JSON.parse(raw).codes.find((c: any) => c.tokenId === record.id)
    expect(rec.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.keys(rec).sort()).toEqual(["createdAt", "expiresAt", "id", "name", "sealed", "tokenId"])
    expect(Date.parse(rec.expiresAt) - Date.parse(rec.createdAt)).toBe(CODE_TTL_MS)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("redeems the same device token once, in any spelling", () => {
    const { token, record, code } = pairPhone()
    expect(codes.redeem(formatCode(code).toLowerCase())).toEqual({ token, tokenId: record.id, name: "Test phone" })
    expect(codes.redeem(code)).toBeNull()
  })

  it("expires after 10 minutes", () => {
    const { code } = pairPhone()
    clock += CODE_TTL_MS + 1
    expect(codes.redeem(code)).toBeNull()
  })
})

describe("POST /api/app/pair-code", () => {
  it("is public, sets the session cookie and opens the app", async () => {
    const { token, code } = pairPhone("My phone")
    const r = await tryCode(formatCode(code))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ device: "My phone" })
    expect(r.cookie).toMatch(new RegExp(`^${APP_COOKIE}=${token};`))
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(r.cookie).toContain(attr)
    expect(r.cookie).not.toContain("Strict")
    const page = await fetch(`${base}/app`, { headers: { Cookie: `${APP_COOKIE}=${token}` } })
    expect(page.status).toBe(200)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[app] pair-code paired"))
  })

  it("gives wrong, expired, used and malformed codes the same answer and timing", async () => {
    const used = pairPhone().code
    expect((await tryCode(used)).status).toBe(200)
    const expired = pairPhone().code
    clock += CODE_TTL_MS + 1
    const answers = [await tryCode("ZZZZ-ZZZZ"), await tryCode(expired), await tryCode(used), await tryCode("nope")]
    for (const a of answers) {
      expect(a.status).toBe(401)
      expect(a.body).toEqual({ error: PAIR_CODE_FAILED })
      expect(a.cookie).toBeNull()
      expect(a.ms).toBeGreaterThanOrEqual(MIN_MS - 5)
    }
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[app] pair-code failed from"))
  })

  it("refuses a code whose device was revoked meanwhile", async () => {
    const { record, code } = pairPhone()
    tokens.revoke(record.id)
    expect((await tryCode(code)).status).toBe(401)
  })

  it("locks out after repeated failures, even for a correct code", async () => {
    const { code } = pairPhone()
    for (let i = 0; i < 5; i++) expect((await tryCode("ZZZZ-ZZZZ")).status).toBe(401)
    const locked = await tryCode(code)
    expect(locked.status).toBe(429)
    expect(locked.body.error).toBe("too many attempts")
    expect(Number(locked.retryAfter)).toBeGreaterThan(0)
    clock += 5 * 60 * 1000 + 1
    expect((await tryCode(code)).status).toBe(200)
  })
})

describe("attempt limiter", () => {
  it("limits each client, and all clients together", () => {
    let now = 0
    const l = new PairAttemptLimiter({ perClient: 5, global: 10, windowMs: 600_000, lockoutMs: 300_000 }, () => now)
    for (let i = 0; i < 4; i++) l.fail("a")
    expect(l.retryAfter("a")).toBe(0)
    l.fail("a")
    expect(l.retryAfter("a")).toBe(300)
    expect(l.retryAfter("b")).toBe(0)
    // Ten failures spread over many clients lock everyone out.
    for (let i = 0; i < 5; i++) l.fail(`c${i}`)
    expect(l.retryAfter("fresh")).toBe(300)
    now += 300_001
    expect(l.retryAfter("fresh")).toBe(0)
    // Failures still inside the window count: one more re-locks at once.
    l.fail("fresh")
    expect(l.retryAfter("other")).toBe(300)
    // Once the window has passed, the count starts over.
    now += 600_001
    l.fail("x")
    expect(l.retryAfter("other")).toBe(0)
  })
})

describe("locked page", () => {
  it("has a phone-friendly code field and keeps the QR instructions", () => {
    const html = renderAppLockedPage()
    for (const attr of ['autocomplete="one-time-code"', 'inputmode="text"', 'autocapitalize="characters"', 'id="pair-btn"', "pair-offline"]) {
      expect(html).toContain(attr)
    }
    expect(html).toContain("QR code")
    expect(html).toContain("agentx app pair")
  })

  it("scripts parse and hold no template-literal hazards", () => {
    const scripts = [...renderAppLockedPage().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts.length).toBe(3) // theme boot, injected helpers, page
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    // The hand-written script is a TS template literal; the injected
    // helpers are compiled code interpolated at runtime, so they may not.
    expect(LOCKED_SCRIPT).not.toMatch(/[\\`]|\$\{/)
    expect(scripts[2]).toBe(LOCKED_SCRIPT)
  })

  it("the service worker keeps the locked page for offline starts", () => {
    expect(APP_SERVICE_WORKER).toContain("c.put('/app/locked', res)")
    expect(APP_SERVICE_WORKER).toContain("caches.match('/app/locked')")
  })
})

describe("agentx app pair", () => {
  it("prints a one-time code that redeems the QR's device token", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentx-paircli-"))
    vi.spyOn(process, "cwd").mockReturnValue(cwd)
    const lines: string[] = []
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")) })
    const { appCmd } = await import("../src/commands/app")
    await appCmd.parseAsync(["pair", "--name", "CLI phone", "--url", "https://host.example.ts.net"], { from: "user" })
    const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")
    const m = out.match(/Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})/)
    expect(m).not.toBeNull()
    expect(out).toContain("It works once, for 10 minutes")
    const redeemed = new PairCodeStore(cwd).redeem(m![1])
    const device = new TokenStore(cwd).list().find((r) => r.name === "CLI phone")
    expect(redeemed?.tokenId).toBe(device?.id)
    expect(new TokenStore(cwd).list()).toHaveLength(1)
    rmSync(cwd, { recursive: true, force: true })
  })
})
