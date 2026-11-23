import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"

// The guided first run's steps save a key, start the daemon and ask the
// agent (#2143): through the real dashboard router they are the owner's
// alone, and a write needs the board's own header.

const TOKEN = "dash-secret"
const OFF = { "X-Forwarded-For": "100.64.0.9" }
let server: Server | undefined

async function start(): Promise<string> {
  const config = daemonConfigSchema.parse({
    node: { id: "node-a", name: "node-a" },
    dashboard: { daemonUrl: "http://daemon.invalid:18800", token: TOKEN },
  })
  const ctx = { boards: [], sources: new Map(), token: TOKEN, config } as unknown as Ctx
  server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = undefined
})

describe("setup API gate (#2143)", () => {
  it("refuses a caller without the owner's credential, with a sentence saying where to run it", async () => {
    const base = await start()
    for (const headers of [{}, OFF]) {
      const r = await fetch(`${base}/api/setup/agent`, {
        method: "POST", headers: { ...headers, "X-Requested-With": "agentx-board", "Content-Type": "application/json" }, body: "{}",
      })
      expect(r.status).toBe(401)
      expect((await r.json()).error).toMatch(/Only the owner can run the setup/)
    }
  })

  it("lets the owner through, and still wants the board's header on a write", async () => {
    const base = await start()
    const auth = { Authorization: `Bearer ${TOKEN}` }
    const noHeader = await fetch(`${base}/api/setup/agent`, { method: "POST", headers: auth, body: "{}" })
    expect(noHeader.status).toBe(400)
    const wrongVerb = await fetch(`${base}/api/setup/agent`, { headers: auth })
    expect(wrongVerb.status).toBe(405)
  })
})
