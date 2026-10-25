import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import type Database from "better-sqlite3"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { TokenStore } from "../src/daemon/token-store"
import { RequestStore } from "../src/requests/store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { isStalledPost, portfolioSummary, portfolioTitle, PORTFOLIO_SCOPE, type PortfolioPost } from "../src/daemon/wall-portfolio"
import { renderPortfolioPage } from "../src/daemon/ui/pages/portfolio"

// The Wall's portfolio (#1194): counts and titles across every group, for
// the people holding a `wall:portfolio` key. Nobody else gets it, the key
// opens nothing else, and no request text, thread, chat or group leaves.
// The keys here live in a temp folder; none is made on a real node.

const home = process.cwd()
let db: Database.Database
let store: RequestStore
let server: Server
let base: string
// The dashboard has a token: without one the portfolio refuses every key.
const OWNER = "tok-owner"
let token: string | undefined = OWNER
const keys: Record<string, string> = {}
const H = 3_600_000
const D = 24 * H
const NOW = Date.now()

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(base + path, { method: "GET", headers }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    r.on("error", reject)
    r.end()
  })
}
const bearer = (k: string) => ({ Authorization: `Bearer ${k}` })

beforeAll(async () => {
  closeDb()
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-portfolio-")))
  writeFileSync("agentx.json", JSON.stringify({ agents: { coder: { name: "Coder" } } }))
  db = openDb({ quiet: true })!
  store = new RequestStore(db)

  // Group A: titled, in progress, GitLab home.
  store.addCandidate({ id: "p1", runId: "t1", channel: "telegram", chatId: "chat-A", sender: "anis", agentId: "coder", text: "Fix the login page token=supersecretvalue123", now: NOW - 2 * H })
  store.progress("p1", NOW - H)
  store.setHome("p1", { kind: "issue", link: "https://gitlab.example.com/acme/web/-/issues/42" }, NOW - H)
  store.setHeadline("p1", { headline: "Login page fix" }, "agent")
  // Group B: no headline, waiting on the owner, same project by home link.
  store.addCandidate({ id: "p2", runId: "t2", channel: "telegram", chatId: "chat-B", sender: "sara", agentId: "pm", text: "Private note about the client budget", now: NOW - 3 * H })
  store.setHome("p2", { kind: "issue", link: "https://gitlab.example.com/acme/web/-/issues/43" }, NOW - 3 * H)
  store.waitOnOwner("p2", "Which budget line, the secret one?", NOW - 2 * H)
  // Group C: no headline, no home, closed done.
  store.addCandidate({ id: "p3", runId: "t3", channel: "whatsapp", chatId: "chat-C", sender: "omar", agentId: "coder", text: "Rename the invoices folder", now: NOW - 5 * H })
  store.progress("p3", NOW - 4 * H)
  store.close("p3", "done", "https://example.com/proof/1", NOW - 3 * H)

  const tokens = new TokenStore()
  keys.director = tokens.create({ name: "Director", scopes: [PORTFOLIO_SCOPE] }).token
  keys.member = tokens.create({ name: "Teammate", scopes: ["member:sara"] }).token
  keys.app = tokens.create({ name: "Phone", scopes: ["app"] }).token
  keys.read = tokens.create({ name: "Reader", scopes: ["dashboard:read"] }).token
  keys.write = tokens.create({ name: "Admin", scopes: ["dashboard:write"] }).token

  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, agents: { coder: { name: "Coder", workspace: process.cwd() } } })
  server = createServer((req, res) => {
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), token, config } as unknown as Ctx)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  closeDb()
  process.chdir(home)
})

describe("who may look", () => {
  it("opens for a wall:portfolio key, named after its holder", async () => {
    const r = await get("/api/portfolio", bearer(keys.director))
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).viewer).toBe("Director")
  })

  it("refuses no key, a wrong key, and keys for anything else", async () => {
    expect((await get("/api/portfolio")).status).toBe(401)
    expect((await get("/api/portfolio", bearer("agx_live_" + "0".repeat(64)))).status).toBe(401)
    for (const k of [keys.member, keys.app, keys.read]) expect((await get("/api/portfolio", bearer(k))).status).toBe(401)
  })

  it("refuses every key while no dashboard token is set, since the Wall itself is then open", async () => {
    token = undefined
    try {
      for (const k of [null, keys.director, keys.write, keys.member, "agx_live_" + "0".repeat(64)]) {
        const r = await get("/api/portfolio", k ? bearer(k) : {})
        expect(r.status).toBe(503)
        expect(JSON.parse(r.body).error).toBe("set dashboard.token first")
        expect(r.body).not.toContain("Login page fix")
      }
    } finally {
      token = OWNER
    }
  })

  it("takes the key from the header only, never from the address", async () => {
    expect((await get(`/api/portfolio?token=${keys.director}`)).status).toBe(401)
  })

  it("opens for the owner's dashboard key", async () => {
    const r = await get("/api/portfolio", bearer(OWNER))
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).viewer).toBeNull()
    expect((await get("/api/portfolio", bearer(keys.write))).status).toBe(200)
  })

  it("opens nothing else: the Wall's posts and threads refuse a portfolio key", async () => {
    for (const p of ["/api/admin/wall", "/api/admin/wall?peer=fleet", "/api/admin/wall/thread?id=p2", "/api/admin/config"]) {
      expect((await get(p, bearer(keys.director))).status).toBe(401)
    }
  })

  it("is read-only", async () => {
    const before = JSON.stringify(db.prepare("SELECT * FROM requests ORDER BY id").all())
    const r = await new Promise<number>((resolve, reject) => {
      const q = request(base + "/api/portfolio", { method: "POST", headers: bearer(keys.director) }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      q.on("error", reject)
      q.end()
    })
    expect(r).toBe(405)
    await get("/api/portfolio", bearer(keys.director))
    expect(JSON.stringify(db.prepare("SELECT * FROM requests ORDER BY id").all())).toBe(before)
  })
})

describe("what it shows", () => {
  it("counts per project and owner across every group", async () => {
    const s = JSON.parse((await get("/api/portfolio", bearer(keys.director))).body)
    expect(s.totals).toEqual({ open: 2, inProgress: 1, blocked: 1, stalled: 0, done: 1 })
    expect(s.projects).toEqual([
      { project: "acme/web", open: 2, inProgress: 1, blocked: 1, stalled: 0, done: 0 },
      { project: "Other", open: 0, inProgress: 0, blocked: 0, stalled: 0, done: 1 },
    ])
    expect(s.owners).toEqual([
      { owner: "coder", open: 1, inProgress: 1, blocked: 0, done: 1 },
      { owner: "pm", open: 1, inProgress: 0, blocked: 1, done: 0 },
    ])
    expect(s.blocks).toEqual([{ title: "acme/web #43", project: "acme/web", owner: "pm", waitingOn: "owner", since: expect.any(Number), node: "node-a" }])
    expect(s.nodes).toEqual([{ name: "node-a", ok: true }])
  })

  it("never carries a request's text, its question, its proof, its chat or its group", async () => {
    const body = (await get("/api/portfolio", bearer(keys.director))).body
    for (const leak of ["Fix the login", "supersecret", "Private note", "budget", "Rename the invoices", "proof/1", "chat-A", "chat-B", "chat-C", "telegram", "whatsapp", "sara", "omar", "p1", "p2", "p3"]) {
      expect(body).not.toContain(leak)
    }
  })

  it("names a post by its set headline, else its home, else not at all", () => {
    const base = { id: "x", state: "in_progress", owner: "a", lastMoveAt: NOW, closedAt: null, blocked: null } as const
    expect(portfolioTitle({ ...base, headline: "Set by an agent", titled: true, project: null, home: null })).toBe("Set by an agent")
    expect(portfolioTitle({ ...base, headline: "cut from the chat", titled: false, project: "acme/web", home: { kind: "issue", link: "https://gitlab.example.com/acme/web/-/merge_requests/9" } })).toBe("acme/web !9")
    // A post from an older node carries no `titled`: its headline may be chat text.
    expect(portfolioTitle({ ...base, headline: "cut from the chat", project: null, home: null })).toBe("Untitled request")
    expect(portfolioTitle({ ...base, headline: "token=supersecretvalue123", titled: true, project: null, home: null })).not.toContain("supersecretvalue123")
  })

  it("counts stalled work and only work finished inside the days asked", () => {
    const posts: PortfolioPost[] = [
      { id: "a", state: "in_progress", headline: "", owner: "x", project: "p", home: null, lastMoveAt: NOW - 3 * D, closedAt: null, blocked: null },
      { id: "b", state: "done", headline: "", owner: "x", project: "p", home: null, lastMoveAt: NOW - 9 * D, closedAt: NOW - 9 * D, blocked: null },
      { id: "c", state: "dropped", headline: "", owner: "x", project: "p", home: null, lastMoveAt: NOW, closedAt: NOW, blocked: null },
    ]
    expect(isStalledPost(posts[0], NOW, 24)).toBe(true)
    const s = portfolioSummary(posts, { node: "n", now: NOW, days: 7, staleAfterHours: 24, viewer: null })
    expect(s.totals).toEqual({ open: 1, inProgress: 1, blocked: 0, stalled: 1, done: 0 })
    expect(portfolioSummary(posts, { node: "n", now: NOW, days: 10, staleAfterHours: 24, viewer: null }).totals.done).toBe(1)
  })

  it("serves a page with no data on it, asking for the key", async () => {
    const r = await get("/portfolio")
    expect(r.status).toBe(200)
    expect(r.body).toContain('id="key-form"')
    expect(r.body).not.toContain("Login page fix")
    expect(renderPortfolioPage()).not.toMatch(/innerHTML/)
  })

  it("lets the owner mint a portfolio key", () => {
    expect(() => new TokenStore().create({ name: "Ops lead", scopes: [PORTFOLIO_SCOPE] })).not.toThrow()
  })
})
