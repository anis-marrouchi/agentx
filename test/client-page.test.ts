import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { TokenStore } from "../src/daemon/token-store"
import { PairCodeStore } from "../src/daemon/pair-codes"
import { PairAttemptLimiter } from "../src/daemon/app-pair-code"
import { MemberStore } from "../src/members/store"
import { inviteMember, MEMBER_CODE_FAILED, NETWORK_MISMATCH } from "../src/members/pairing"
import { handleMemberRequest, withoutAgents } from "../src/daemon/member-routes"
import { CLIENT_MANIFEST_PATH, renderClientManifest, renderClientPage } from "../src/daemon/ui/pages/client"
import { clientRequestState, clientSentState, clientSummary } from "../src/daemon/ui/pages/client-logic"
import { renderMemberLockedPage, renderMemberWaitingPage } from "../src/daemon/ui/pages/member"
import { renderPeoplePage } from "../src/daemon/ui/pages/people"
import { pageFor } from "../src/commands/people"
import { peopleConfigSchema } from "../src/daemon/config"
import { PERSON_ROLES, type Person } from "../src/people/people"
import { closeDb, openDb } from "../src/storage/sqlite"
import { recordTraceStart } from "../src/storage/traces"
import { decideCard, listCards } from "../src/approvals/cards"

// #453: the owner decided that a client (someone they do work for) gets a
// role of their own in the people list and a page of their own, "Your
// project", instead of the teammate's "My work". Same door (pairing, the
// owner's yes on a card, one key per machine), another page behind it.

const PEOPLE: Person[] = [
  { id: "sara", name: "Sara B", role: "member", identities: ["gitlab:sara.b"] },
  { id: "acme", name: "Acme Bakery", role: "client", identities: ["whatsapp:21620123456"] },
]

describe("the client role", () => {
  it("is one of the four roles, accepted by the config and the command", () => {
    expect(PERSON_ROLES).toEqual(["owner", "member", "client", "guest"])
    expect(peopleConfigSchema.parse([{ id: "acme", name: "Acme Bakery", role: "client" }])[0].role).toBe("client")
    expect(() => peopleConfigSchema.parse([{ id: "acme", name: "Acme Bakery", role: "customer" }])).toThrow()
    expect(pageFor("client")).toBe("Your project")
    expect(pageFor("member")).toBe("My work")
  })

  it("has a badge on the People page", () => {
    expect(renderPeoplePage()).toContain("client: 'Client'")
    expect(renderPeoplePage()).toContain("--role client")
  })
})

describe("the words on the client's page", () => {
  it("name no agent and no owner", () => {
    expect(clientSentState({ status: "in-flight", request: null })).toEqual({ label: "Being worked on", tone: "work" })
    expect(clientSentState({ status: "in-flight", request: { state: "waiting_owner" } })).toEqual({ label: "Waiting on us", tone: "wait" })
    expect(clientSentState({ status: "in-flight", request: { state: "waiting_other" } })).toEqual({ label: "Waiting on us", tone: "wait" })
    expect(clientSentState({ status: "ok", request: { state: "needs_attention" } })).toEqual({ label: "Needs a look from us", tone: "stuck" })
    expect(clientSentState({ status: "ok", request: null })).toEqual({ label: "Finished", tone: "done" })
    expect(clientSentState({ status: "error" })).toMatchObject({ label: "Stopped, we will look at it", tone: "stuck" })
    expect(clientSentState({ status: "canceled" })).toEqual({ label: "Stopped", tone: "off" })
    expect(clientRequestState("in_progress")).toEqual({ label: "Being worked on", tone: "work" })
    expect(clientRequestState("waiting_owner")).toEqual({ label: "Waiting on us", tone: "wait" })
    expect(clientRequestState("declined")).toEqual({ label: "Not taken on", tone: "off" })
    expect(clientRequestState("dropped")).toEqual({ label: "Set aside", tone: "off" })
  })

  it("sum up in one sentence", () => {
    expect(clientSummary([])).toBe("Nothing asked for yet.")
    expect(clientSummary(["work"])).toBe("1 request is being worked on for you.")
    expect(clientSummary(["work", "work", "wait", "stuck", "done"])).toBe("2 requests are being worked on for you. 1 is waiting on us. 1 needs a look from us.")
    expect(clientSummary(["done", "done", "off"])).toBe("Nothing in progress right now. 2 requests finished this week.")
    expect(clientSummary(["off"])).toBe("Nothing in progress right now.")
  })

  it("on the pairing pages, never send a person to a terminal they do not have", () => {
    for (const text of [MEMBER_CODE_FAILED, NETWORK_MISMATCH, renderMemberLockedPage(), renderMemberWaitingPage()]) {
      expect(text).not.toContain("agentx ")
      expect(text).toContain("the person who invited you")
    }
  })
})

describe("the page's script", () => {
  type Answer = number | { status: number; body: unknown }
  const ME = { name: "Acme Bakery", device: "Front desk PC", role: "client" }

  function openPage(answers: { work?: Answer[] } = {}) {
    const page = renderClientPage()
    const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop()!
    const els = new Map<string, any>()
    const el = (id: string) => {
      if (!els.has(id)) {
        const tag = new RegExp(`<[^>]*id="${id}"[^>]*>([^<]*)`).exec(page)
        if (!tag) throw new Error(`no element #${id} on the page`)
        const listeners: Record<string, () => void> = {}
        els.set(id, { hidden: /\shidden[\s>]/.test(tag[0]), textContent: tag[1], innerHTML: "", disabled: false, addEventListener: (t: string, f: () => void) => { listeners[t] = f }, click: () => listeners.click() })
      }
      return els.get(id)
    }
    const timers: Array<{ id: number; fn: () => void; ms: number }> = []
    let seq = 0
    const setTimeoutStub = (fn: () => void, ms: number) => { timers.push({ id: ++seq, fn, ms }); return seq }
    const clearTimeoutStub = (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }
    const queue = [...(answers.work ?? [])]
    const left: string[] = []
    const fetchStub = (url: string) => {
      const a: Answer = url === "/api/member/me" ? 200 : (queue.shift() ?? 200)
      const status = typeof a === "number" ? a : a.status
      const body = typeof a === "number" ? (url === "/api/member/me" ? ME : { open: [], recent: [], runs: [], other: [] }) : a.body
      return Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body })
    }
    new Function("document", "window", "navigator", "fetch", "location", "localStorage", "matchMedia", "setTimeout", "clearTimeout", "AbortController", script)(
      { getElementById: el, documentElement: { getAttribute: () => "light", setAttribute: () => {} } },
      { addEventListener: () => {} }, { onLine: true, userAgent: "Macintosh" }, fetchStub, { replace: (to: string) => { left.push(to) } },
      { setItem: () => {} }, () => ({ matches: false }), setTimeoutStub, clearTimeoutStub, AbortController,
    )
    const settle = () => new Promise<void>((r) => setImmediate(r))
    return { el, left, settle, pending: () => timers.map((t) => t.ms) }
  }

  it("parses, and touches only elements the page renders", () => {
    const html = renderClientPage()
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    for (const m of scripts.join("").matchAll(/getElementById\('([^']+)'\)/g)) expect(html).toContain(`id="${m[1]}"`)
    expect(html).toContain("<h1>Your project</h1>")
    expect(html).not.toContain("My work")
    expect(html).toContain(`href="${CLIENT_MANIFEST_PATH}"`)
    expect(JSON.parse(renderClientManifest())).toMatchObject({ short_name: "Your project", scope: "/member", start_url: "/member" })
  })

  it("shows what the client asked for in their words, with no agent id", async () => {
    const now = Date.now()
    const body = {
      open: [{ id: "r2", state: "waiting_owner", text: "Put our **logo** on the quote", createdAt: now, updatedAt: now, where: { label: "WhatsApp", url: null } }],
      recent: [], other: [],
      runs: [
        { taskId: "t1", channel: "whatsapp", chatId: "c1", status: "in-flight", startedAt: now, finishedAt: null, messagePreview: "Quote for the spring catalogue", where: { label: "WhatsApp", url: null }, request: null },
        { taskId: "t0", channel: "gitlab", chatId: "shop/site:issue:3", status: "ok", startedAt: now - 3_600_000, finishedAt: now - 3_000_000, messagePreview: "Fix the shop banner", where: { label: "GitLab issue #3 in shop/site", url: "https://git.example.com/shop/site/-/issues/3" }, request: { id: "r1", state: "done", evidence: "https://git.example.com/shop/site/-/merge_requests/4" } },
      ],
    }
    const p = openPage({ work: [{ status: 200, body }] })
    await p.settle()
    expect(p.el("who").textContent).toBe("Acme Bakery · Front desk PC")
    expect(p.el("sum").textContent).toBe("1 request is being worked on for you. 1 is waiting on us.")
    const rows = p.el("asked").innerHTML
    expect(rows).toContain(">Being worked on<")
    expect(rows).toContain(">Waiting on us<")
    expect(rows).toContain(">Finished<")
    expect(rows).toContain("Put our logo on the quote")
    expect(rows).toContain('<a href="https://git.example.com/shop/site/-/merge_requests/4" target="_blank" rel="noopener noreferrer">What was delivered</a>')
    expect(rows).toContain("asked on WhatsApp")
    expect(rows).not.toMatch(/coder|agent/i)
    expect(p.el("offline").hidden).toBe(true)
    expect(p.pending()).toEqual([30_000])
  })

  it("says so when nothing was asked, and goes back to /member when the key ended", async () => {
    const p = openPage()
    await p.settle()
    expect(p.el("sum").textContent).toBe("Nothing asked for yet.")
    expect(p.el("asked").innerHTML).toContain("Nothing here yet.")
    const q = openPage({ work: [401] })
    await q.settle()
    expect(q.left).toEqual(["/member"])
  })
})

describe("over HTTP", () => {
  const home = process.cwd()
  let dir: string
  let server: Server
  let base: string
  let people: Person[]
  let members: MemberStore

  beforeAll(async () => {
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-client-page-")))
    dir = process.cwd()
    const limiter = new PairAttemptLimiter()
    server = createServer(async (req, res) => {
      const path = new URL(req.url || "/", "http://x").pathname
      const handled = await handleMemberRequest(req, res, path, req.method || "GET", {
        nodeName: "node-a", tokens: new TokenStore(dir), members, pairCodes: new PairCodeStore(dir), pairLimiter: limiter, pairMinMs: 0,
        root: dir, people: () => people, db: () => openDb({ quiet: true }), log: () => {},
      })
      if (!handled) { res.writeHead(418); res.end() }
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
  beforeEach(() => { people = [...PEOPLE]; members = new MemberStore(dir) })
  afterEach(() => { closeDb(); rmSync(join(dir, ".agentx"), { recursive: true, force: true }) })

  async function pair(person: string, machine: string) {
    const inv = inviteMember({ tokens: new TokenStore(dir), codes: new PairCodeStore(dir), members, people: () => people }, person)
    if (!inv.ok) throw new Error(inv.error)
    const r = await fetch(`${base}/api/member/pair-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: inv.code, machine }) })
    expect(r.status).toBe(200)
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0]
    const card = listCards(dir, "pending").find((c) => c.id === members.byToken(inv.tokenId)?.cardId)!
    expect(decideCard(dir, card.id, "yes", { by: "owner" }).ok).toBe(true)
    const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } })
    return { get }
  }

  it("opens Your project for a client and My work for a teammate, through the same door", async () => {
    const client = await pair("acme", "Front desk PC")
    const teammate = await pair("sara", "Laptop")
    const clientPage = await client.get("/member")
    expect(clientPage.status).toBe(200)
    const clientHtml = await clientPage.text()
    expect(clientHtml).toContain("<h1>Your project</h1>")
    expect(clientHtml).not.toContain("My work")
    const teammateHtml = await (await teammate.get("/member")).text()
    expect(teammateHtml).toContain("<h1>My work</h1>")
    expect(teammateHtml).not.toContain("Your project")
    expect(await (await client.get("/api/member/me")).json()).toMatchObject({ person: "acme", name: "Acme Bakery", role: "client", device: "Front desk PC" })
    expect(await (await teammate.get("/api/member/me")).json()).toMatchObject({ person: "sara", role: "member" })
  })

  it("serves the client's manifest without a key, next to the teammate's", async () => {
    const r = await fetch(`${base}${CLIENT_MANIFEST_PATH}`)
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("application/manifest+json")
    expect(await r.json()).toMatchObject({ short_name: "Your project" })
    expect(await (await fetch(`${base}/member/manifest.webmanifest`)).json()).toMatchObject({ short_name: "My work" })
  })

  it("sends a client their work with no agent card and no agent id, and a teammate the cards", async () => {
    const db = openDb({ quiet: true })!
    recordTraceStart(db, { agentId: "coder", channel: "whatsapp", chatId: "c1", messagePreview: "Quote for the spring catalogue", person: "acme" } as any, "T-acme")
    recordTraceStart(db, { agentId: "coder", channel: "gitlab", chatId: "shop/site:issue:3", messagePreview: "Fix the banner", person: "sara" } as any, "T-sara")
    const client = await pair("acme", "Front desk PC")
    const teammate = await pair("sara", "Laptop")
    const forClient = await (await client.get("/api/member/work")).json() as any
    expect(forClient.runs.map((r: any) => r.taskId)).toEqual(["T-acme"])
    expect(forClient.agents).toEqual([])
    expect(JSON.stringify(forClient)).not.toContain("coder")
    const forTeammate = await (await teammate.get("/api/member/work")).json() as any
    expect(forTeammate.runs.map((r: any) => [r.taskId, r.agentId])).toEqual([["T-sara", "coder"]])
    expect(forTeammate.agents.map((a: any) => a.agentId)).toEqual(["coder"])
  })

  it("a role changed to client in the people list changes the page on the next open", async () => {
    const sara = await pair("sara", "Laptop")
    expect(await (await sara.get("/member")).text()).toContain("<h1>My work</h1>")
    people = people.map((p) => (p.id === "sara" ? { ...p, role: "client" } : p))
    expect(await (await sara.get("/member")).text()).toContain("<h1>Your project</h1>")
  })

  it("refuses a wrong code with words for someone who has no terminal here", async () => {
    const r = await fetch(`${base}/api/member/pair-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "AAAA-AAAA", machine: "x" }) })
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: MEMBER_CODE_FAILED })
  })
})

describe("withoutAgents", () => {
  it("takes the agent id out of every row and leaves the rest", () => {
    const item = { id: "r1", state: "done", agentId: "coder", text: "t", channel: "whatsapp", chatId: "c", createdAt: 1, updatedAt: 2, closedAt: 3, question: null, attentionReason: null, evidence: null, where: { label: "WhatsApp", url: null } }
    const run = { taskId: "t1", agentId: "coder", channel: "whatsapp", chatId: "c", status: "ok", startedAt: 1, finishedAt: 2, messagePreview: "p", where: null, request: null } as any
    const out = withoutAgents({ open: [item], recent: [item], runs: [run], other: [] })
    expect(out.open[0]).not.toHaveProperty("agentId")
    expect(out.open[0]).toMatchObject({ id: "r1", where: { label: "WhatsApp", url: null } })
    expect(out.runs[0]).toEqual({ taskId: "t1", channel: "whatsapp", chatId: "c", status: "ok", startedAt: 1, finishedAt: 2, messagePreview: "p", where: null, request: null })
    expect(out.other).toEqual([])
  })
})
