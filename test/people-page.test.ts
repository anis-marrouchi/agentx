import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { peopleRows } from "../src/daemon/people-panel"
import { renderPeoplePage } from "../src/daemon/ui/pages/people"
import { renderGuestsPage } from "../src/daemon/ui/pages/guests"
import { TokenStore } from "../src/daemon/token-store"
import { PairCodeStore } from "../src/daemon/pair-codes"
import { MemberStore } from "../src/members/store"
import { inviteMember } from "../src/members/pairing"
import { decideCard, listCards } from "../src/approvals/cards"
import { requestsOf, runsOf } from "../src/people/activity"
import { RequestStore } from "../src/requests/store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { attachSqliteSubscribers } from "../src/storage/subscribers"
import { recordTraceStart } from "../src/storage/traces"
import { getEventBus } from "../src/events/bus"
import { exposedDashboardMounts } from "../src/commands/app"
import type { Person } from "../src/people/people"

// The People page (#441): the owner's dashboard view of `agentx people
// list`, `devices` and `show`, with "End access" for one machine. Driven
// through the dashboard's own request handler, so the token gate and the
// member page's paths in front of it are the real ones.

const PEOPLE: Person[] = [
  { id: "anis", name: "Anis M", role: "owner", identities: ["telegram:4242"] },
  { id: "sara", name: "Sara B", role: "member", identities: ["gitlab:sara.b", "whatsapp:21620123456"], agents: ["coder"] },
  { id: "lina", name: "Lina G", role: "guest", identities: [] },
]

const home = process.cwd()
let dir: string
let server: Server
let base: string
let token: string | undefined
let people: Person[]

beforeAll(async () => {
  closeDb()
  // The dashboard reads its stores from the folder it runs in. No
  // agentx.json there: the people list is the one the dashboard started with.
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-people-page-")))
  dir = process.cwd()
  server = createServer((req, res) => {
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, people })
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), token, config } as unknown as Ctx)
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
beforeEach(() => { token = undefined; people = PEOPLE })
afterEach(() => {
  closeDb()
  rmSync(join(dir, ".agentx"), { recursive: true, force: true })
})

const WRITE = { "X-Requested-With": "agentx-board", "Content-Type": "application/json" }
const get = async (path: string, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { headers })
  return { status: r.status, body: await r.json() as any }
}
const end = (person: string, tokenId: string, headers: Record<string, string> = WRITE) =>
  fetch(`${base}/api/admin/people/${person}/devices/${tokenId}/end`, { method: "POST", headers, body: "{}" })

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

/** A teammate pairs a machine through the member page; the owner answers the card. */
async function pair(person: string, machine: string, verdict: "yes" | "no" | null = "yes") {
  const members = new MemberStore(dir)
  const inv = inviteMember({ tokens: new TokenStore(dir), codes: new PairCodeStore(dir), members, people: () => people }, person)
  if (!inv.ok) throw new Error(inv.error)
  const r = await fetch(`${base}/api/member/pair-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: inv.code, machine }) })
  expect(r.status).toBe(200)
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0]
  if (verdict) {
    const card = listCards(dir, "pending").find((c) => c.id === members.byToken(inv.tokenId)?.cardId)!
    expect(decideCard(dir, card.id, verdict, { by: "owner" }).ok).toBe(true)
  }
  const me = () => fetch(`${base}/api/member/me`, { headers: { cookie } }).then((x) => x.status)
  return { tokenId: inv.tokenId, cookie, me }
}

describe("the list", () => {
  it("shows each person with name, role and channel identities", async () => {
    const { status, body } = await get("/api/admin/people")
    expect(status).toBe(200)
    expect(body.people.map((p: any) => [p.id, p.name, p.role])).toEqual([["anis", "Anis M", "owner"], ["sara", "Sara B", "member"], ["lina", "Lina G", "guest"]])
    expect(body.people[1]).toMatchObject({ identities: ["gitlab:sara.b", "whatsapp:21620123456"], agents: ["coder"], machines: { active: 0, pending: 0 } })
    expect(body.paired).toBe(0)
  })

  it("works with nothing configured: the built-in owner, and nobody paired", async () => {
    people = []
    const { body } = await get("/api/admin/people")
    expect(body).toEqual({ paired: 0, people: [{ id: "owner", name: "Owner of this machine", role: "owner", identities: [], agents: [], builtIn: true, machines: { active: 0, pending: 0 } }] })
    expect((await get("/api/admin/people/owner")).body).toMatchObject({ devices: [], requests: [], runs: [] })
  })

  it("adds the built-in owner only when no owner is listed", () => {
    expect(peopleRows(PEOPLE, []).map((p) => p.id)).toEqual(["anis", "sara", "lina"])
    expect(peopleRows(PEOPLE.slice(1), []).map((p) => [p.id, p.builtIn])).toEqual([["owner", true], ["sara", undefined], ["lina", undefined]])
  })

  it("counts machines that work or wait, not ended ones", async () => {
    const laptop = await pair("sara", "Laptop")
    expect(await laptop.me()).toBe(200)
    await pair("sara", "Desktop", null)
    const { body } = await get("/api/admin/people")
    expect(body.people[1].machines).toEqual({ active: 1, pending: 1 })
    expect(body.paired).toBe(2)
    await end("sara", laptop.tokenId)
    expect((await get("/api/admin/people")).body).toMatchObject({ paired: 1, people: [{}, { machines: { active: 0, pending: 1 } }, {}] })
  })

  it("shows the owner's answer on a machine that has not called since", async () => {
    // The record turns active or removed only when that machine next calls.
    const yes = await pair("sara", "Approved")
    const no = await pair("sara", "Refused", "no")
    const list = await get("/api/admin/people")
    expect(list.body.people[1].machines).toEqual({ active: 1, pending: 0 })
    const { body } = await get("/api/admin/people/sara")
    expect(body.devices.map((d: any) => [d.name, d.state, d.answer])).toEqual([["Refused", "pending", "no"], ["Approved", "pending", "yes"]])
    expect(await yes.me()).toBe(200)
    expect(await no.me()).toBe(401)
    expect((await get("/api/admin/people/sara")).body.devices.map((d: any) => [d.name, d.state, d.answer])).toEqual([["Refused", "removed", undefined], ["Approved", "active", undefined]])
  })
})

describe("one person", () => {
  it("lists each machine with its name, state, where it paired from, first and last use", async () => {
    const laptop = await pair("sara", "Work laptop")
    expect(await laptop.me()).toBe(200)
    const waiting = await pair("sara", "Desktop", null)
    const { status, body } = await get("/api/admin/people/sara")
    expect(status).toBe(200)
    expect(body.person).toMatchObject({ id: "sara", name: "Sara B", role: "member" })
    // Newest pairing first.
    expect(body.devices.map((d: any) => [d.tokenId, d.name, d.state])).toEqual([[waiting.tokenId, "Desktop", "pending"], [laptop.tokenId, "Work laptop", "active"]])
    const d = body.devices[1]
    expect(d.address).toBe("127.0.0.1")
    expect(Date.parse(d.createdAt)).toBeGreaterThan(0)
    expect(d.lastSeenAt).toBeTruthy()
    expect(d.lastAddress).toBe("127.0.0.1")
    expect(body.devices[0].lastSeenAt).toBeUndefined()
    // Nobody else's machines.
    expect((await get("/api/admin/people/lina")).body.devices).toEqual([])
  })

  it("lists their requests with the state each is in now, newest first, and the turns they started", async () => {
    const db = openDb()!
    const store = new RequestStore(db)
    const ask = (id: string, person: string | null, now: number) => {
      store.addCandidate({ id, runId: `T-${id}`, channel: "gitlab", chatId: "team/app:issue:7", agentId: "coder", text: `ask ${id}`, now, person } as any)
      store.progress(id, now)
    }
    ask("old", "sara", 1_000)
    ask("mid", "sara", 2_000)
    ask("new", "sara", 3_000)
    ask("lina-1", "lina", 2_500)
    store.close("mid", "done", "https://git.example.com/team/app/-/issues/7", 4_000)
    store.addCandidate({ id: "maybe", runId: "T-maybe", channel: "gitlab", chatId: "c", agentId: "coder", text: "not confirmed", now: 5_000, person: "sara" } as any)
    expect(requestsOf(db, "sara").map((r) => [r.id, r.state])).toEqual([["new", "in_progress"], ["mid", "done"], ["old", "in_progress"]])
    expect(requestsOf(db, "sara", 1).map((r) => r.id)).toEqual(["new"])

    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      for (const [taskId, at] of [["T1", "2026-01-01T10:00:00.000Z"], ["T2", "2026-01-02T10:00:00.000Z"]]) {
        bus.emit("task:started", { agentId: "coder", channel: "gitlab", chatId: "team/app:issue:7", messagePreview: `turn ${taskId}`, at, taskId, person: { id: "sara" } })
      }
      bus.emit("task:completed", { agentId: "coder", channel: "gitlab", chatId: "team/app:issue:7", durationMs: 5, at: "2026-01-01T10:00:01.000Z", taskId: "T1" })
    } finally { dispose() }

    const { body } = await get("/api/admin/people/sara")
    expect(body.requests.map((r: any) => [r.id, r.state, r.agentId])).toEqual([["new", "in_progress", "coder"], ["mid", "done", "coder"], ["old", "in_progress", "coder"]])
    expect(body.runs.map((r: any) => [r.taskId, r.status])).toEqual([["T2", "in-flight"], ["T1", "ok"]])
    expect((await get("/api/admin/people/lina")).body.requests.map((r: any) => r.id)).toEqual(["lina-1"])
    expect((await get("/api/admin/people/anis")).body).toMatchObject({ requests: [], runs: [] })
  })

  it("keeps turns started in the same millisecond newest first", () => {
    const db = openDb()!
    const now = vi.spyOn(Date, "now").mockReturnValue(1_767_261_600_000)
    try {
      for (const taskId of ["T1", "T2", "T3"]) recordTraceStart(db, { agentId: "coder", channel: "gitlab", person: "sara" }, taskId)
    } finally { now.mockRestore() }
    expect(runsOf(db, "sara").map((r) => r.taskId)).toEqual(["T3", "T2", "T1"])
  })

  it("answers 404 for someone who is not listed", async () => {
    expect((await get("/api/admin/people/nobody")).status).toBe(404)
    expect((await get("/api/admin/people/Sara")).status).toBe(404)
  })
})

describe("End access", () => {
  it("stops that machine at once and leaves the person's other machine working", async () => {
    const laptop = await pair("sara", "Laptop")
    const desktop = await pair("sara", "Desktop")
    expect(await laptop.me()).toBe(200)
    const r = await end("sara", laptop.tokenId)
    expect(r.status).toBe(200)
    expect((await r.json() as any).device).toMatchObject({ tokenId: laptop.tokenId, state: "removed", removedReason: "removed by the owner (dashboard)" })
    expect(await laptop.me()).toBe(401)
    expect(await desktop.me()).toBe(200)
    expect(new TokenStore(dir).isActive(laptop.tokenId)).toBe(false)
    expect(new MemberStore(dir).events("sara").find((e) => e.event === "removed")).toMatchObject({ device: laptop.tokenId })
    expect((await get("/api/admin/people/sara")).body.devices.map((d: any) => d.state)).toEqual(["active", "removed"])
    expect((await end("sara", laptop.tokenId)).status).toBe(409)
  })

  it("ends a machine still waiting for approval", async () => {
    const waiting = await pair("sara", "Desktop", null)
    expect((await end("sara", waiting.tokenId)).status).toBe(200)
    expect(await waiting.me()).toBe(401)
  })

  it("refuses a machine that is not this person's, an unknown one, and a write from no page", async () => {
    const laptop = await pair("sara", "Laptop")
    expect((await end("lina", laptop.tokenId)).status).toBe(404)
    expect((await end("sara", "tok_00000000")).status).toBe(404)
    expect((await end("sara", laptop.tokenId, { "Content-Type": "application/json" })).status).toBe(400)
    expect(await laptop.me()).toBe(200)
  })
})

describe("who can open it", () => {
  it("needs the dashboard token when one is set, for reading and for ending", async () => {
    const laptop = await pair("sara", "Laptop")
    token = "dash-secret"
    expect((await get("/api/admin/people")).status).toBe(401)
    expect((await get("/api/admin/people/sara")).status).toBe(401)
    expect((await end("sara", laptop.tokenId)).status).toBe(401)
    // A teammate's own key is not the owner's.
    expect((await get("/api/admin/people", { cookie: laptop.cookie })).status).toBe(401)
    expect(await laptop.me()).toBe(200)
    const auth = { Authorization: "Bearer dash-secret" }
    expect((await get("/api/admin/people", auth)).status).toBe(200)
    expect((await end("sara", laptop.tokenId, { ...WRITE, ...auth })).status).toBe(200)
    expect(await laptop.me()).toBe(401)
  })

  it("is not under the member page's served paths", async () => {
    // What the guide publishes: /member and /api/member, each to itself.
    for (const path of ["/member/people", "/api/member/people", "/api/member/admin/people", "/api/member/people/sara"]) {
      const r = await raw(path)
      expect([path, r.status]).toEqual([path, 401])
      expect(r.text).not.toContain("Sara B")
    }
    // A served path cannot climb out to the page or its data.
    for (const path of ["/member/../people", "/member/%2e%2e/people", "/api/member/../admin/people", "/api/member/%2E%2E/admin/people/sara", "/member/x/../../api/admin/people"]) {
      const r = await raw(path)
      expect([path, r.status]).toEqual([path, 404])
      expect(r.text).not.toContain("Sara B")
      expect(r.text).not.toContain("pp-list")
    }
    expect((await raw("/people")).status).toBe(200)
    expect((await raw("/api/admin/people?x=1")).status).toBe(200)
  })

  it("publishing the page itself on the network is flagged, like any other dashboard path", () => {
    const web = (handlers: Record<string, string>) => ({
      Web: { "mac.tail1.ts.net:443": { Handlers: Object.fromEntries(Object.entries(handlers).map(([m, p]) => [m, { Proxy: p }])) } },
    })
    const member = { "/member": "http://127.0.0.1:4202/member", "/api/member": "http://127.0.0.1:4202/api/member" }
    expect(exposedDashboardMounts(web(member), 4202)).toEqual([])
    expect(exposedDashboardMounts(web({ ...member, "/people": "http://127.0.0.1:4202/people", "/api/admin/people": "http://127.0.0.1:4202/api/admin/people" }), 4202))
      .toEqual(["mac.tail1.ts.net:443/people", "mac.tail1.ts.net:443/api/admin/people"])
  })
})

describe("the page", () => {
  it("is served at /people and linked from the dashboard navigation", async () => {
    const r = await fetch(`${base}/people`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain("<h1>People</h1>")
    expect(html).toMatch(/<a href="\/people" class="ax-topbar__tab is-active">People<\/a>/)
    // On every other page too.
    expect(renderGuestsPage({})).toMatch(/<a href="\/people" class="ax-topbar__tab">People<\/a>/)
  })

  it("says so when nobody is paired and shows how to invite someone", () => {
    const html = renderPeoplePage()
    expect(html).toContain("Nobody has paired a machine yet")
    expect(html).toContain("agentx people add sara")
    expect(html).toContain("agentx people invite sara")
    // Shown by the script when the list reports no paired machine.
    expect(html).toContain("none.hidden = d.paired > 0")
  })

  it("carries the dashboard token to its own script only when one is set", () => {
    expect(renderPeoplePage()).not.toContain("AX_LOCAL_TOKEN =")
    expect(renderPeoplePage({ localToken: "dash-secret" })).toContain('window.AX_LOCAL_TOKEN = "dash-secret"')
  })

  it("has scripts that parse, call only functions that exist, and touch only elements the page renders", () => {
    const html = renderPeoplePage({ localToken: "t" })
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter(Boolean)
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    const page = scripts.find((s) => s.includes("pp-list"))!
    for (const m of page.matchAll(/getElementById\('([^']+)'\)/g)) expect(html).toContain(`id="${m[1]}"`)
    const declared = new Set([...page.matchAll(/function (\w+)\(/g)].map((m) => m[1]))
    for (const m of page.matchAll(/(?<![.\w'])([a-z]\w*)\(/g)) {
      const name = m[1]
      if (["function", "if", "for", "return", "confirm", "fetch", "isNaN", "setInterval", "encodeURIComponent"].includes(name)) continue
      expect([name, declared.has(name)]).toEqual([name, true])
    }
  })
})
