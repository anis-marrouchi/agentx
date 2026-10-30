import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, RETIRED_PAGES, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { closeDb } from "../src/storage/sqlite"

// Classic pages with no views in 30 days are retired (#1446). Their
// addresses still work: each opens the closest Wall view.

const home = process.cwd()
let dir: string
let server: Server
let base: string

beforeAll(async () => {
  closeDb()
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-retired-pages-")))
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

describe("retired classic pages", () => {
  it.each([
    ["/boards", "/hub#status=open&view=projects"],
    ["/glossary", "/hub"],
    ["/procedures", "/hub#page=agents"],
    ["/processes", "/hub#status=open&view=jobs"],
    ["/places", "/hub"],
  ])("%s redirects to %s", async (path, target) => {
    expect(RETIRED_PAGES[path]).toBe(target)
    const r = await fetch(base + path, { redirect: "manual" })
    expect(r.status).toBe(302)
    expect(r.headers.get("location")).toBe(target)
  })

  it("redirects to Wall views only", () => {
    for (const target of Object.values(RETIRED_PAGES)) expect(target).toMatch(/^\/hub(#|$)/)
  })

  it("keeps the places API the phone app shares", async () => {
    expect((await fetch(base + "/api/places", { redirect: "manual" })).status).not.toBe(302)
  })
})
