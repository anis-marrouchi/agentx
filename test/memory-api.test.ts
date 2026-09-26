import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import type { AddressInfo } from "net"
import { AgentMemory } from "../src/agents/agent-memory"
import { handleMemoryApi } from "../src/daemon/memory-api"

let root: string
let mem: AgentMemory
let server: Server
let base: string
/** taskId → agentId for tasks "running" right now. */
const running = new Map<string, string>()

beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), "agentx-memapi-"))
  server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost")
    const handled = await handleMemoryApi(req, res, url.pathname, url, {
      mem,
      workspaceFor: () => null,
      runningTaskOwner: (id) => (running.has(id) ? { agentId: running.get(id)! } : null),
    })
    if (!handled) { res.writeHead(404); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  mem = new AgentMemory({ baseDir: mkdtempSync(resolve(root, "case-")) })
  running.clear()
})

const memory = (extra: Record<string, unknown> = {}) => ({
  agentId: "atlas", type: "feedback", name: "no-mock-db", description: "Use a real database", body: "v1", ...extra,
})
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/memory`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })

describe("memory API — identity", () => {
  it("records the agent as author when its running task is named", async () => {
    running.set("t-1", "atlas")
    const r = await post(memory(), { "X-AgentX-Task": "t-1" })
    expect(r.status).toBe(200)
    const rec = mem.get("atlas", "no-mock-db")!
    expect(rec.author).toBe("atlas")
    expect(rec.taskId).toBe("t-1")
  })

  it("refuses a task that belongs to another agent", async () => {
    running.set("t-2", "cx-agent")
    const r = await post(memory(), { "X-AgentX-Task": "t-2" })
    expect(r.status).toBe(403)
    expect(mem.get("atlas", "no-mock-db")).toBeNull()
  })

  it("refuses a task that isn't running", async () => {
    const r = await post(memory(), { "X-AgentX-Task": "finished-or-made-up" })
    expect(r.status).toBe(403)
  })

  it("still accepts a call without the header, marked unverified", async () => {
    const r = await post(memory())
    expect(r.status).toBe(200)
    expect(mem.get("atlas", "no-mock-db")!.author).toBe("unverified")
  })

  it("checks the task on delete and restore too", async () => {
    await post(memory())
    running.set("t-3", "cx-agent")
    const del = await fetch(`${base}/api/memory/no-mock-db?agent=atlas`, { method: "DELETE", headers: { "X-AgentX-Task": "t-3" } })
    expect(del.status).toBe(403)
    const rs = await fetch(`${base}/api/memory/no-mock-db/restore?agent=atlas`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-AgentX-Task": "t-3" }, body: JSON.stringify({ version: "x" }),
    })
    expect(rs.status).toBe(403)
  })
})

describe("memory API — conditional writes", () => {
  it("sends an ETag and honours If-Match with a 409 on mismatch", async () => {
    await post(memory())
    const got = await fetch(`${base}/api/memory/no-mock-db?agent=atlas`)
    const etag = got.headers.get("etag")!
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)

    await post(memory({ body: "someone else" }))
    const stale = await post(memory({ body: "mine" }), { "If-Match": etag })
    expect(stale.status).toBe(409)
    const body = await stale.json()
    expect(body.currentEtag).toBe(mem.get("atlas", "no-mock-db")!.etag)
    expect(mem.get("atlas", "no-mock-db")!.body).toBe("someone else")

    const fresh = await post(memory({ body: "mine" }), { "If-Match": `"${body.currentEtag}"` })
    expect(fresh.status).toBe(200)
  })

  it("If-None-Match: * only creates", async () => {
    expect((await post(memory(), { "If-None-Match": "*" })).status).toBe(200)
    expect((await post(memory({ body: "again" }), { "If-None-Match": "*" })).status).toBe(409)
  })

  it("DELETE with a stale If-Match is refused", async () => {
    await post(memory())
    const etag = (await fetch(`${base}/api/memory/no-mock-db?agent=atlas`)).headers.get("etag")!
    await post(memory({ body: "changed" }))
    const r = await fetch(`${base}/api/memory/no-mock-db?agent=atlas`, { method: "DELETE", headers: { "If-Match": etag } })
    expect(r.status).toBe(409)
  })

  it("append goes through the store in one step", async () => {
    await post(memory({ body: "first" }))
    await post(memory({ body: "second", append: true }))
    expect(mem.get("atlas", "no-mock-db")!.body).toBe("first\n\nsecond")
  })
})

describe("memory API — history", () => {
  it("lists versions and restores one", async () => {
    await post(memory({ body: "v1" }))
    await post(memory({ body: "v2" }))
    const list = await (await fetch(`${base}/api/memory/no-mock-db/versions?agent=atlas`)).json()
    expect(list.versions[0].record.body).toBe("v1")
    const r = await fetch(`${base}/api/memory/no-mock-db/restore?agent=atlas`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: list.versions[0].id }),
    })
    expect(r.status).toBe(200)
    expect(mem.get("atlas", "no-mock-db")!.body).toBe("v1")
  })

  it("brings back a deleted memory", async () => {
    await post(memory({ body: "precious" }))
    await fetch(`${base}/api/memory/no-mock-db?agent=atlas`, { method: "DELETE" })
    const list = await (await fetch(`${base}/api/memory/no-mock-db/versions?agent=atlas`)).json()
    await fetch(`${base}/api/memory/no-mock-db/restore?agent=atlas`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: list.versions[0].id }),
    })
    expect(mem.get("atlas", "no-mock-db")!.body).toBe("precious")
  })

  it("404s an unknown version", async () => {
    await post(memory())
    const r = await fetch(`${base}/api/memory/no-mock-db/restore?agent=atlas`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: "nope" }),
    })
    expect(r.status).toBe(404)
  })
})
