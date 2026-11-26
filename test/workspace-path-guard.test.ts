import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { AgentXDaemon } from "../src/daemon"
import { daemonConfigSchema } from "../src/daemon/config"
import { isHiddenName, resolveWorkspaceFile } from "../src/daemon/workspace-path-guard"

// GET /agents/:id/workspace/<file> (#2316): the real daemon handler over a
// real socket, on loopback with no chat secret (a caller the auth gate lets
// through), so only the path guard decides.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0x01])
const PDF = Buffer.from("%PDF-1.4\n\x00\xff binary\n%%EOF\n", "latin1")

let tmp: string
let workspace: string
let outside: string
let base: string
let server: Server

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "agentx-ws-guard-")))
  workspace = join(tmp, "workspace")
  outside = join(tmp, "outside")
  mkdirSync(join(workspace, ".agentx", "outbox"), { recursive: true })
  mkdirSync(join(workspace, "charts", "q3"), { recursive: true })
  mkdirSync(join(workspace, ".git"), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE_SECRET")
  writeFileSync(join(workspace, ".env"), "NOT_A_REAL_VALUE=1\n")
  writeFileSync(join(workspace, ".env.local"), "NOT_A_REAL_VALUE=2\n")
  writeFileSync(join(workspace, "id_rsa"), "KEY")
  writeFileSync(join(workspace, "credentials.json"), "{}")
  writeFileSync(join(workspace, ".git", "config"), "[core]")
  writeFileSync(join(workspace, ".agentx", "outbox", "chart.png"), PNG)
  writeFileSync(join(workspace, "report.pdf"), PDF)
  writeFileSync(join(workspace, "charts", "q3", "notes.txt"), "nested ok")
  symlinkSync(join(outside, "secret.txt"), join(workspace, "leak.txt"))
  symlinkSync(outside, join(workspace, "linkdir"))
  symlinkSync(join(workspace, ".env"), join(workspace, "innocent.txt"))
  symlinkSync(join(workspace, "charts"), join(workspace, "charts-link"))

  const config = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
  const daemon = Object.assign(Object.create(AgentXDaemon.prototype), {
    config,
    log: () => {},
    registry: { list: () => [{ id: "helper" }], getAgent: (id: string) => (id === "helper" ? { workspace } : undefined) },
  })
  server = createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true })
    void daemon.handleHttp(req, res)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => {
  vi.stubEnv("AGENTX_CHAT_SECRET", "")
  vi.stubEnv("TELEGRAM_BOT_API_SECRET", "")
})
afterEach(() => vi.unstubAllEnvs())

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(tmp, { recursive: true, force: true })
})

/** GET with the path sent exactly as written (fetch would fold `..`). */
function get(rawPath: string): Promise<{ status: number; type: string; body: Buffer }> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: `/agents/helper/workspace/${rawPath}`, method: "GET" }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("GET /agents/:id/workspace/<file> path guard (#2316)", () => {
  it("refuses a link to a file outside the workspace", async () => {
    const r = await get("leak.txt")
    expect(r.status).toBe(403)
    expect(r.body.toString()).not.toContain("OUTSIDE_SECRET")
  })

  it("refuses a file reached through a link to a folder outside the workspace", async () => {
    const r = await get("linkdir/secret.txt")
    expect(r.status).toBe(403)
    expect(r.body.toString()).not.toContain("OUTSIDE_SECRET")
  })

  it("refuses a harmless-looking link to .env inside the workspace", async () => {
    const r = await get("innocent.txt")
    expect(r.status).toBe(403)
    expect(r.body.toString()).not.toContain("NOT_A_REAL_VALUE")
  })

  it.each([".env", ".env.local", ".ENV", "id_rsa", "credentials.json", ".git/config", "charts/../.env"])("refuses %s", async (file) => {
    const r = await get(file)
    expect(r.status).toBe(403)
    expect(r.body.toString()).not.toMatch(/NOT_A_REAL_VALUE|KEY|\[core\]/)
  })

  it.each(["..%2Foutside%2Fsecret.txt", "%2E%2E%2Foutside%2Fsecret.txt", "charts%2F..%2F..%2Foutside%2Fsecret.txt"])("refuses .. in %s", async (file) => {
    const r = await get(file)
    expect(r.status).toBe(403)
    expect(r.body.toString()).not.toContain("OUTSIDE_SECRET")
  })

  it("refuses an absolute path, even one inside the workspace", async () => {
    const r = await get(encodeURIComponent(join(workspace, "report.pdf")))
    expect(r.status).toBe(400)
  })

  it("answers 400, not a crash, to a malformed escape", async () => {
    expect((await get("%E0%A4%A")).status).toBe(400)
  })

  it("serves a png artifact byte for byte as image/png", async () => {
    const r = await get(".agentx/outbox/chart.png")
    expect(r.status).toBe(200)
    expect(r.type).toBe("image/png")
    expect(r.body.equals(PNG)).toBe(true)
  })

  it("serves a pdf artifact byte for byte as application/pdf", async () => {
    const r = await get("report.pdf")
    expect(r.status).toBe(200)
    expect(r.type).toBe("application/pdf")
    expect(r.body.equals(PDF)).toBe(true)
  })

  it("serves a nested file, and one through a link that stays inside", async () => {
    for (const file of ["charts/q3/notes.txt", "charts%2Fq3%2Fnotes.txt", "charts-link/q3/notes.txt"]) {
      const r = await get(file)
      expect(r.status).toBe(200)
      expect(r.type).toBe("text/plain")
      expect(r.body.toString()).toBe("nested ok")
    }
  })

  it("answers 404 for a missing file and for a folder", async () => {
    expect((await get("nope.png")).status).toBe(404)
    expect((await get("charts")).status).toBe(404)
  })
})

describe("resolveWorkspaceFile", () => {
  it("returns the real path of a file inside", () => {
    expect(resolveWorkspaceFile(workspace, "charts/q3/notes.txt")).toEqual({ ok: true, realPath: join(workspace, "charts", "q3", "notes.txt") })
  })

  it.each([
    ["leak.txt", 403], ["linkdir/secret.txt", 403], ["innocent.txt", 403], [".env", 403], ["../outside/secret.txt", 403],
    ["/etc/passwd", 400], ["~/x", 400], ["C:/x", 400], ["a\0b", 400], ["x".repeat(1025), 400], ["", 404], ["nope", 404],
  ])("refuses %s with %i", (path, status) => {
    const r = resolveWorkspaceFile(workspace, path)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.status).toBe(status)
  })

  it("answers 404 for a missing workspace", () => {
    expect(resolveWorkspaceFile(join(tmp, "gone"), "a.png")).toMatchObject({ ok: false, status: 404 })
  })
})

describe("isHiddenName", () => {
  it.each([".env", ".env.production", "server.key", "cert.PEM", "id_ed25519.pub", "credentials", "secrets.yaml", "token.txt", "tokens.json", "auth.json", ".git", "node_modules", ".ssh", ".npmrc"])("hides %s", (n) => {
    expect(isHiddenName(n)).toBe(true)
  })
  it.each(["chart.png", "report.pdf", ".agentx", "environment.md", "keys.md", "tokenizer.json", "notes.txt"])("shows %s", (n) => {
    expect(isHiddenName(n)).toBe(false)
  })
})
