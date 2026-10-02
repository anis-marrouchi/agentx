import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { closeDb } from "../src/storage/sqlite"

// One check at the top of the dashboard (#452): an address that is not
// sent in its normal form is refused before any page or data route sees
// it, so a proxy that publishes /member and /api/member only cannot be
// used to reach another page by climbing out of them.

const home = process.cwd()
let dir: string
let server: Server
let base: string

beforeAll(async () => {
  closeDb()
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-normal-form-")))
  dir = process.cwd()
  server = createServer((req, res) => {
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" } })
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), config } as unknown as Ctx)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  closeDb()
  process.chdir(home)
  rmSync(dir, { recursive: true, force: true })
})

/** The address exactly as typed: fetch() folds "/a/../b" before sending. */
function raw(path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base)
    const req = request({ hostname, port, path, method: "GET" }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on("error", reject)
    req.end()
  })
}

const REFUSED = JSON.stringify({ error: "not found" })

describe("an address not in normal form", () => {
  it.each([
    // To the member page, and from it.
    "/x/../member", "/member/./", "/member/../approvals", "/member/%2e%2e/approvals", "/api/member/../admin/approvals/requests",
    // To the phone app, and from it.
    "/member/../app", "/api/member/%2E%2E/app/fleet", "/app/../live", "/app/./",
    // To admin pages and their data.
    "/member/x/../../approvals", "/api/member/..%2f..%2fapi/admin/approvals/requests/../requests", "/member\\..\\approvals", "//approvals",
  ])("is refused before any route: %s", async (path) => {
    const r = await raw(path)
    expect([path, r.status, r.text]).toEqual([path, 404, REFUSED])
  })

  it("is refused for every method, before the origin and preflight checks", async () => {
    for (const method of ["POST", "OPTIONS"]) {
      const r = await new Promise<number>((resolve, reject) => {
        const { hostname, port } = new URL(base)
        const req = request({ hostname, port, path: "/member/../api/admin/approvals/requests/close", method }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
        req.on("error", reject)
        req.end()
      })
      expect([method, r]).toEqual([method, 404])
    }
  })
})

describe("an address in normal form", () => {
  it("reaches its page as before, with or without a query", async () => {
    // The member page and the phone app ask for their own key; an admin page opens on loopback.
    for (const [path, status] of [["/member", 401], ["/api/member/me", 401], ["/api/app/fleet", 401], ["/approvals", 200], ["/approvals?next=/../live", 200]] as const) {
      const r = await raw(path)
      expect([path, r.status]).toEqual([path, status])
      expect(r.text).not.toBe(REFUSED)
    }
  })
})
