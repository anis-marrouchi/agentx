import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { AppChatStore } from "../src/daemon/app-chat-store"
import type { AppChatDeps } from "../src/daemon/app-chat"
import { readSse } from "../src/daemon/app-chat-relay"
import { APP_FILES_PATH, handleAppFilesApi, parseRange } from "../src/daemon/app-files-api"
import { decideMeshAuth, isMeshGatedPath } from "../src/daemon/mesh-auth"
import { openDb, closeDb } from "../src/storage/sqlite"

// Files an agent declares for the phone (#253). Three real servers on
// 127.0.0.1: this computer's daemon (agent "alpha"), a mesh peer's daemon
// (agent "beta"), and the phone app routes in front of both. Each daemon
// serves GET /app-files from its agent's workspace as the real daemon does.

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3e1a1d60000000049454e44ae426082", "hex")

let dir: string, wsA: string, wsB: string
let tokens: TokenStore, store: AppChatStore, deps: AppChatDeps
let local: Server, peer: Server, app: Server
let localUrl: string, peerUrl: string, base: string
let phone: string, otherPhone: string
const hits: Array<{ node: string; url: string; auth?: string; range?: string }> = []
const logs: string[] = []

function daemon(name: string, agent: string, workspace: () => string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://x")
    if (url.pathname === APP_FILES_PATH) {
      hits.push({ node: name, url: req.url || "", auth: req.headers.authorization, range: req.headers.range })
      return handleAppFilesApi(req, res, url, { workspaceOf: (id) => (id === agent ? workspace() : null), log: (m) => logs.push(m) })
    }
    // POST /task: one turn that saved a chart and declared it.
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const content = 'Here is the chart.\n\n![Trend](https://example.com/t.png)\n<agentx-artifact>{"filename":"charts/a.png","mime":"image/png"}</agentx-artifact>\n<agentx-artifact>{"filename":"../outside/secret.png","mime":"image/png"}</agentx-artifact>'
    res.write(`event: text\ndata: ${JSON.stringify({ text: content })}\n\n`)
    res.write(`event: done\ndata: ${JSON.stringify({ content })}\n\n`)
    res.end()
  }
}

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  return `http://127.0.0.1:${(s.address() as any).port}`
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-app-files-"))
  wsA = join(dir, "ws-a"); wsB = join(dir, "ws-b")
  mkdirSync(join(wsA, "charts"), { recursive: true }); mkdirSync(wsB); mkdirSync(join(dir, "outside"))
  writeFileSync(join(wsA, "charts/a.png"), PNG)
  writeFileSync(join(wsA, "report.pdf"), "%PDF-1.4 demo")
  writeFileSync(join(wsA, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  writeFileSync(join(wsA, "page.html"), "<script>alert(1)</script>")
  writeFileSync(join(wsA, "big.mp4"), ""); truncateSync(join(wsA, "big.mp4"), 20 * 1024 * 1024 + 1)
  writeFileSync(join(dir, "outside/secret.png"), PNG)
  symlinkSync(join(dir, "outside/secret.png"), join(wsA, "escape.png"))
  symlinkSync(join(wsA, "page.html"), join(wsA, "disguised.png"))
  symlinkSync(join(wsA, "charts/a.png"), join(wsA, "inside.png"))
  mkdirSync(join(wsA, "folder.png"))
  writeFileSync(join(wsB, "peer.png"), PNG)
  mkdirSync(join(wsA, ".agentx/outbox"), { recursive: true })
  writeFileSync(join(wsA, ".agentx/outbox/chart.png"), PNG)
  writeFileSync(join(dir, "chart.png"), PNG)

  tokens = new TokenStore(dir)
  store = new AppChatStore(openDb({ path: join(dir, "db.sqlite") })!)
  phone = tokens.create({ name: "Phone", scopes: ["app"] }).token
  otherPhone = tokens.create({ name: "Other phone", scopes: ["app"] }).token

  local = createServer((req, res) => { void daemon("local", "alpha", () => wsA)(req, res) })
  peer = createServer((req, res) => { void daemon("peer-b", "beta", () => wsB)(req, res) })
  localUrl = await listen(local)
  peerUrl = await listen(peer)
  deps = {
    store: () => store,
    daemon: { url: localUrl, token: "daemon-secret", name: "node-a" },
    snapshot: async () => ({ nodes: [{ id: "a", url: localUrl, name: "node-a", reachable: true, agents: [{ id: "alpha", name: "Alpha", active: 0, errors: 0, runningTasks: [] }] }] }),
    meshPeers: async () => [{ peer: "peer-b", peerUrl: peerUrl + "/", healthy: true, skills: [{ id: "beta" }] }],
    nodePost: async () => ({ status: 200, body: {} }),
    tokenFor: (u) => (u === peerUrl ? "mesh-secret" : undefined),
  }
  app = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    if (!(await handleAppRequest(req, res, path, req.method || "GET", { tokens, chat: deps }))) { res.writeHead(418); res.end() }
  })
  base = await listen(app)
})

afterAll(() => {
  app.close(); local.close(); peer.close()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => { hits.length = 0; logs.length = 0 })

const device = (t: string) => tokens.verify(t)!.id
const get = (path: string, t = phone, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers: { Authorization: `Bearer ${t}`, ...headers } })

/** Registers `files` as declared by one answer in a new conversation. */
function declare(node: string, agent: string, ...files: string[]) {
  const c = store.create(device(phone), { node, nodeName: node, agent }, "make a file")
  return store.appendWithFiles(device(phone), c.id, { role: "assistant", content: "done", status: "done", at: Date.now() },
    files.map((filename) => ({ type: "image" as const, filename, mime: "image/png" })))!
}

describe("an answer that declares a file", () => {
  it("comes back without its file lines, with the files under fresh ids, and the file loads", async () => {
    const r = await fetch(`${base}/api/app/chat`, {
      method: "POST", headers: { Authorization: `Bearer ${phone}`, "Content-Type": "application/json" },
      body: JSON.stringify({ node: "local", agent: "alpha", message: "chart please" }),
    })
    const events: Array<{ event: string; data: any }> = []
    for await (const ev of readSse(r.body as any)) events.push(ev)
    const final = events.find((e) => e.event === "final")!.data
    expect(final.content).toBe("Here is the chart.\n\n![Trend](https://example.com/t.png)")
    expect(final.files.map((f: any) => [f.name, f.kind])).toEqual([["a.png", "image"], ["secret.png", "image"]])
    const conv = store.list(device(phone))[0]
    expect(store.get(device(phone), conv.id)!.messages[1].files).toEqual(final.files)

    const ok = await get(`/api/app/files/${final.files[0].id}`)
    expect(ok.status).toBe(200)
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(PNG)
    // Declared, but it points outside the workspace.
    expect((await get(`/api/app/files/${final.files[1].id}`)).status).toBe(403)
  })
})

describe("GET /api/app/files/:id", () => {
  it("serves the owner's file with safe headers", async () => {
    const [f] = declare("local", "alpha", "charts/a.png")
    const r = await get(`/api/app/files/${f.id}`)
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("image/png")
    expect(r.headers.get("x-content-type-options")).toBe("nosniff")
    expect(r.headers.get("content-disposition")).toMatch(/^inline; filename="a.png"/)
    expect(r.headers.get("cache-control")).toMatch(/^private/)
    expect(r.headers.get("content-security-policy")).toContain("sandbox")
    expect(hits).toEqual([{ node: "local", url: expect.stringContaining("agent=alpha"), auth: "Bearer daemon-secret", range: undefined }])
    expect(hits[0].url).toContain("file=charts%2Fa.png")
  })

  it("is a 404 for another phone, an undeclared id or a made-up one", async () => {
    const [f] = declare("local", "alpha", "charts/a.png")
    expect((await get(`/api/app/files/${f.id}`, otherPhone)).status).toBe(404)
    expect((await get(`/api/app/files/${"0".repeat(32)}`)).status).toBe(404)
    expect((await get("/api/app/files/charts%2Fa.png")).status).toBe(404)
    expect((await fetch(`${base}/api/app/files/${f.id}`)).status).toBe(401)
    expect(hits).toEqual([])
  })

  it("refuses a path that leaves the workspace, directly or through a link", async () => {
    const [up, link] = declare("local", "alpha", "../outside/secret.png", "escape.png")
    expect((await get(`/api/app/files/${up.id}`)).status).toBe(403)
    expect((await get(`/api/app/files/${link.id}`)).status).toBe(403)
    const [abs] = declare("local", "alpha", join(dir, "outside/secret.png"))
    expect((await get(`/api/app/files/${abs.id}`)).status).toBe(403)
    // A link that stays inside is fine.
    const [inside] = declare("local", "alpha", "inside.png")
    expect((await get(`/api/app/files/${inside.id}`)).status).toBe(200)
  })

  it("tells an agent that attached a file outside its workspace to use the outbox (#258)", async () => {
    const [tmp] = declare("local", "alpha", join(dir, "chart.png"))
    const r = await get(`/api/app/files/${tmp.id}`)
    expect(r.status).toBe(403)
    expect((await r.json()).error).toContain("copy it into .agentx/outbox/ first")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("from alpha")
    expect(logs[0]).toContain(".agentx/outbox/")
    // The same file, copied into the outbox, reaches the phone.
    const [outbox] = declare("local", "alpha", ".agentx/outbox/chart.png")
    const ok = await get(`/api/app/files/${outbox.id}`)
    expect(ok.status).toBe(200)
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(PNG)
  })

  it("refuses a disallowed type, a folder, a missing file and an oversized one", async () => {
    const [disguised, folder, missing] = declare("local", "alpha", "disguised.png", "folder.png", "nope.png")
    expect((await get(`/api/app/files/${disguised.id}`)).status).toBe(415)
    expect((await get(`/api/app/files/${folder.id}`)).status).toBe(404)
    expect((await get(`/api/app/files/${missing.id}`)).status).toBe(404)
    const c = store.create(device(phone), { node: "local", nodeName: "n", agent: "alpha" }, "x")
    const [big] = store.appendWithFiles(device(phone), c.id, { role: "assistant", content: "", at: 1 }, [{ type: "file", filename: "big.mp4", mime: "video/mp4" }])!
    expect(big.kind).toBe("video")
    expect((await get(`/api/app/files/${big.id}`)).status).toBe(413)
  })

  it("downloads documents and never serves svg inline", async () => {
    const c = store.create(device(phone), { node: "local", nodeName: "n", agent: "alpha" }, "x")
    const [pdf, svg] = store.appendWithFiles(device(phone), c.id, { role: "assistant", content: "", at: 1 }, [
      { type: "pdf", filename: "report.pdf", mime: "application/pdf" },
      { type: "image", filename: "diagram.svg", mime: "image/svg+xml" },
    ])!
    const p = await get(`/api/app/files/${pdf.id}`)
    expect(p.headers.get("content-type")).toBe("application/pdf")
    expect(p.headers.get("content-disposition")).toMatch(/^attachment; filename="report.pdf"/)
    const s = await get(`/api/app/files/${svg.id}`)
    expect(svg.kind).toBe("file")
    expect(s.headers.get("content-disposition")).toMatch(/^attachment/)
    expect(s.headers.get("content-security-policy")).toContain("sandbox")
  })

  it("answers byte ranges, for video players", async () => {
    const [f] = declare("local", "alpha", "charts/a.png")
    const r = await get(`/api/app/files/${f.id}`, phone, { Range: "bytes=0-7" })
    expect(r.status).toBe(206)
    expect(r.headers.get("content-range")).toBe(`bytes 0-7/${PNG.length}`)
    expect(Buffer.from(await r.arrayBuffer())).toEqual(PNG.subarray(0, 8))
    expect(parseRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 })
    expect(parseRange("bytes=20-", 10)).toBe("unsatisfiable")
    expect(parseRange("items=1-2", 10)).toBeNull()
  })
})

describe("a conversation on a mesh peer", () => {
  it("fetches from that peer's daemon, with the token for that peer", async () => {
    const [f] = declare("peer-b", "beta", "peer.png")
    const r = await get(`/api/app/files/${f.id}`)
    expect(r.status).toBe(200)
    expect(Buffer.from(await r.arrayBuffer())).toEqual(PNG)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ node: "peer-b", auth: "Bearer mesh-secret" })
    expect(hits[0].url).toContain("agent=beta")
  })

  it("is a 502 when the peer left the mesh, and never asks another node", async () => {
    const [f] = declare("peer-gone", "beta", "peer.png")
    expect((await get(`/api/app/files/${f.id}`)).status).toBe(502)
    expect(hits).toEqual([])
  })
})

describe("the daemon route", () => {
  it("is mesh-gated: off-box callers need a mesh token", () => {
    expect(isMeshGatedPath("/app-files")).toBe(true)
    const accepted = new Set(["mesh-secret"])
    expect(decideMeshAuth({ remoteAddress: "100.64.0.9", authorizationHeader: "", acceptedTokens: accepted }).allowed).toBe(false)
    expect(decideMeshAuth({ remoteAddress: "100.64.0.9", authorizationHeader: "Bearer mesh-secret", acceptedTokens: accepted }).allowed).toBe(true)
  })

  it("refuses an unknown agent, a bad path and other methods", async () => {
    const q = (s: string) => fetch(`${localUrl}${APP_FILES_PATH}?${s}`)
    expect((await q("agent=nobody&file=charts/a.png")).status).toBe(404)
    expect((await q("agent=alpha&file=charts/../charts/a.png")).status).toBe(403)
    expect((await q("agent=alpha&file=page.html")).status).toBe(415)
    expect((await q("agent=alpha&file=")).status).toBe(400)
    expect((await q("agent=../x&file=a.png")).status).toBe(400)
    expect((await fetch(`${localUrl}${APP_FILES_PATH}?agent=alpha&file=charts/a.png`, { method: "DELETE" })).status).toBe(405)
  })
})
