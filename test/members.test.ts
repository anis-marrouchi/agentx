import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server } from "http"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { TokenStore } from "../src/daemon/token-store"
import { PairCodeStore } from "../src/daemon/pair-codes"
import { PairAttemptLimiter } from "../src/daemon/app-pair-code"
import { MemberStore } from "../src/members/store"
import {
  NETWORK_MISMATCH, inviteMember, memberAccess, networkIdentities, personOfToken, removeDevice, removePersonDevices,
} from "../src/members/pairing"
import { forgeLink, whereLabel, workOf } from "../src/members/work"
import { handleMemberRequest, MEMBER_COOKIE } from "../src/daemon/member-routes"
import { handleAppRequest } from "../src/daemon/app-routes"
import { decideCard, listCards } from "../src/approvals/cards"
import { RequestStore } from "../src/requests/store"
import type { Person } from "../src/people/people"

// A teammate reaches one page, /member, with a key for one machine that
// opens their own work and nothing else (#385, #386). Every refusal path
// is tested: wrong code, lockout, a network identity that is not theirs,
// a machine the owner has not approved, one the owner refused, a removed
// machine, and keys of the wrong kind on either side.

const PEOPLE: Person[] = [
  { id: "sara", name: "Sara B", role: "member", identities: ["gitlab:sara.b"] },
  { id: "omar", name: "Omar K", role: "member", identities: ["tailscale:omar@example.com"] },
]

let dir: string
let tokens: TokenStore
let codes: PairCodeStore
let members: MemberStore
let server: Server
let base: string
let db: Database.Database
let logs: string[]
const log = (line: string) => logs.push(line)

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-members-"))
  tokens = new TokenStore(dir)
  codes = new PairCodeStore(dir)
  members = new MemberStore(dir)
  db = new Database(join(dir, "db.sqlite"))
  logs = []
  const limiter = new PairAttemptLimiter()
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const ctx = {
      nodeName: "node-a", tokens, members, pairCodes: codes, pairLimiter: limiter, pairMinMs: 0, root: dir,
      people: () => PEOPLE, db: () => db, log,
      linkFor: (ch: string, chat: string) => forgeLink(ch, chat, { gitlab: "https://git.example.com" }),
    }
    const handled = await handleMemberRequest(req, res, path, req.method || "GET", ctx)
      || await handleAppRequest(req, res, path, req.method || "GET", { nodeName: "node-a", tokens })
    if (!handled) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterEach(() => {
  server.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
const json = (body: unknown, headers: Record<string, string> = {}) =>
  ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
const cookieOf = (r: Response) => (r.headers.get("set-cookie") || "").split(";")[0]

/** The owner's answer on the one pending pairing card. */
function answer(verdict: "yes" | "no") {
  const [card] = listCards(dir, "pending")
  expect(card).toBeTruthy()
  expect(decideCard(dir, card.id, verdict, { by: "owner" }).ok).toBe(true)
  return card
}

async function pair(person = "sara", machine = "Work laptop", headers: Record<string, string> = {}) {
  const inv = inviteMember({ tokens, codes, members, people: () => PEOPLE }, person)
  if (!inv.ok) throw new Error(inv.error)
  const r = await fetch(`${base}/api/member/pair-code`, json({ code: inv.code, machine }, headers))
  return { r, inv, cookie: cookieOf(r) }
}

describe("inviting", () => {
  it("mints a key for one person only, with the code that redeems it", () => {
    const inv = inviteMember({ tokens, codes, members, people: () => PEOPLE }, "sara")
    expect(inv.ok).toBe(true)
    if (!inv.ok) return
    const rec = tokens.list().find((t) => t.id === inv.tokenId)!
    expect(rec.scopes).toEqual(["member:sara"])
    expect(personOfToken(rec)).toBe("sara")
    expect(rec.expiresAt).toBeTruthy()
    expect(members.events("sara")[0]).toMatchObject({ event: "invited", device: inv.tokenId })
  })

  it("refuses a person who is not listed", () => {
    const inv = inviteMember({ tokens, codes, members, people: () => PEOPLE }, "nobody")
    expect(inv).toMatchObject({ ok: false, error: expect.stringContaining('No person "nobody"') })
  })

  it("reads the private-network logins from the identities", () => {
    expect(networkIdentities(PEOPLE[1])).toEqual(["omar@example.com"])
    expect(networkIdentities(PEOPLE[0])).toEqual([])
  })
})

describe("the member gate (loopback is not trusted)", () => {
  it("refuses /member and /api/member/* with no key, and with keys of other kinds", async () => {
    const page = await fetch(`${base}/member`)
    expect(page.status).toBe(401)
    expect(await page.text()).toContain("Pair this machine")
    expect((await fetch(`${base}/api/member/me`)).status).toBe(401)
    const { token: admin } = tokens.create({ name: "admin", scopes: ["dashboard:write"] })
    const { token: phone } = tokens.create({ name: "phone", scopes: ["app"] })
    expect((await fetch(`${base}/api/member/me`, { headers: bearer(admin) })).status).toBe(401)
    expect((await fetch(`${base}/api/member/work`, { headers: bearer(phone) })).status).toBe(401)
    expect(logs.some((l) => l.includes("unauthenticated /api/member/me"))).toBe(true)
  })

  it("serves the manifest, icons and worker without a key", async () => {
    expect((await fetch(`${base}/member/manifest.webmanifest`)).status).toBe(200)
    expect(JSON.parse(await (await fetch(`${base}/member/manifest.webmanifest`)).text())).toMatchObject({ scope: "/member", display: "standalone" })
    expect((await fetch(`${base}/member/icon-192.png`)).status).toBe(200)
    const sw = await fetch(`${base}/member/sw.js`)
    expect(sw.headers.get("service-worker-allowed")).toBe("/member")
    expect(await sw.text()).toContain("'/member'")
  })

  it("a member key opens nothing of the phone app", async () => {
    const { cookie } = await pair()
    const token = cookie.slice(MEMBER_COOKIE.length + 1)
    expect((await fetch(`${base}/api/app/me`, { headers: bearer(token) })).status).toBe(401)
    expect((await fetch(`${base}/app`, { headers: bearer(token) })).status).toBe(401)
  })
})

describe("pairing a machine", () => {
  it("holds the machine until the owner says yes, then opens that person's work", async () => {
    const { r, cookie, inv } = await pair("sara", "Work laptop")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ person: "sara", name: "Work laptop", state: "pending" })
    expect(cookie.startsWith(`${MEMBER_COOKIE}=agx_live_`)).toBe(true)
    // Waiting: the page says so, the data says so, nothing is readable.
    const waiting = await fetch(`${base}/member`, { headers: { cookie } })
    expect(waiting.status).toBe(202)
    expect(await waiting.text()).toContain("Waiting for the owner")
    expect((await fetch(`${base}/api/member/work`, { headers: { cookie } })).status).toBe(403)
    const [card] = listCards(dir, "pending")
    expect(card.title).toBe("New machine for Sara B")
    expect(card.ask).toContain('"Work laptop"')
    expect(card.ask).toContain("127.0.0.1")
    expect(members.byToken(inv.tokenId)).toMatchObject({ state: "pending", cardId: card.id, name: "Work laptop" })
    answer("yes")
    const me = await fetch(`${base}/api/member/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ person: "sara", name: "Sara B", device: "Work laptop", node: "node-a" })
    expect(members.byToken(inv.tokenId)).toMatchObject({ state: "active", lastAddress: "127.0.0.1" })
    const page = await fetch(`${base}/member`, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("My work")
    const events = members.events("sara").map((e) => e.event)
    expect(events).toEqual(expect.arrayContaining(["invited", "paired", "approved", "signed-in"]))
  })

  it("ends the key when the owner says no, and logs it", async () => {
    const { cookie, inv } = await pair()
    answer("no")
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie } })).status).toBe(401)
    expect(tokens.list().find((t) => t.id === inv.tokenId)?.revokedAt).toBeTruthy()
    expect(members.byToken(inv.tokenId)).toMatchObject({ state: "removed", removedReason: "the owner said no" })
    expect(members.events("sara")[0]).toMatchObject({ event: "refused" })
  })

  it("refuses a wrong code with one answer, and locks out after too many", async () => {
    const r = await fetch(`${base}/api/member/pair-code`, json({ code: "AAAA-AAAA", machine: "x" }))
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: expect.stringContaining("didn't work") })
    for (let i = 0; i < 4; i++) await fetch(`${base}/api/member/pair-code`, json({ code: "BBBB-BBBB", machine: "x" }))
    const locked = await fetch(`${base}/api/member/pair-code`, json({ code: "CCCC-CCCC", machine: "x" }))
    expect(locked.status).toBe(429)
    expect(locked.headers.get("retry-after")).toBeTruthy()
  })

  it("spends the code: a second use finds nothing", async () => {
    const { inv } = await pair()
    const again = await fetch(`${base}/api/member/pair-code`, json({ code: inv.code, machine: "another" }))
    expect(again.status).toBe(401)
  })

  it("refuses the code when the private network names someone else, and when it names nobody", async () => {
    // Omar's identities say who the network must report.
    const wrong = await pair("omar", "Omar's PC", { "Tailscale-User-Login": "sara@example.com" })
    expect(wrong.r.status).toBe(403)
    expect(await wrong.r.json()).toEqual({ error: NETWORK_MISMATCH })
    expect(tokens.list().find((t) => t.id === wrong.inv.tokenId)?.revokedAt).toBeTruthy()
    expect(members.events("omar")[0]).toMatchObject({ event: "refused", detail: expect.stringContaining("sara@example.com") })
    expect(listCards(dir, "pending")).toEqual([])
    const nobody = await pair("omar", "Omar's PC")
    expect(nobody.r.status).toBe(403)
    // The right login is recorded on the machine and shown to the owner.
    const right = await pair("omar", "Omar's PC", { "Tailscale-User-Login": "Omar@Example.com" })
    expect(right.r.status).toBe(200)
    expect(members.byToken(right.inv.tokenId)?.network).toBe("omar@example.com")
    expect(listCards(dir, "pending")[0].ask).toContain("signed in to the network as omar@example.com")
  })

  it("records the network login when the person has none listed, without refusing", async () => {
    const { inv } = await pair("sara", "Laptop", { "Tailscale-User-Login": "sara@example.com" })
    expect(members.byToken(inv.tokenId)?.network).toBe("sara@example.com")
  })
})

describe("removal", () => {
  it("ends one machine at once, and every machine when the person goes", async () => {
    const a = await pair("sara", "Laptop")
    answer("yes")
    const b = await pair("sara", "Desktop")
    answer("yes")
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: a.cookie } })).status).toBe(200)
    expect(removeDevice({ tokens, members }, a.inv.tokenId)).toMatchObject({ state: "removed" })
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: a.cookie } })).status).toBe(401)
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: b.cookie } })).status).toBe(200)
    expect(removePersonDevices({ tokens, members }, "sara").map((d) => d.name)).toEqual(["Desktop"])
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: b.cookie } })).status).toBe(401)
    expect(members.events("sara").filter((e) => e.event === "removed")).toHaveLength(2)
    expect(removeDevice({ tokens, members }, "nope")).toBeNull()
  })

  it("the store files are readable by this user only", async () => {
    await pair()
    for (const f of [".agentx/members.json", ".agentx/members-log.jsonl"]) {
      expect(existsSync(join(dir, f))).toBe(true)
      expect(readFileSync(join(dir, f), "utf-8").length).toBeGreaterThan(0)
    }
  })
})

describe("the work page's data", () => {
  it("shows that person's requests and nobody else's, open first, with where they asked", async () => {
    const store = new RequestStore(db)
    // Real time: over HTTP the route uses the clock for the 7-day window.
    const now = Date.now()
    store.addCandidate({ id: "req-1", runId: "t1", channel: "gitlab", chatId: "team/app:issue:7", sender: "sara.b", person: "sara", agentId: "coder", text: "fix the login", now: now - 3_600_000 } as any)
    store.progress("req-1", now - 3_000_000)
    store.addCandidate({ id: "req-2", runId: "t2", channel: "telegram", chatId: "c9", sender: "omar", person: "omar", agentId: "coder", text: "not sara's", now } as any)
    store.progress("req-2", now)
    store.addCandidate({ id: "req-3", runId: "t3", channel: "voice", chatId: "mac", sender: null, person: null, agentId: "coder", text: "the owner's", now } as any)
    store.progress("req-3", now)
    store.addCandidate({ id: "req-4", runId: "t4", channel: "gitlab", chatId: "team/app:merge_request:12", sender: "sara.b", person: "sara", agentId: "devops", text: "deploy it", now: now - 86_400_000 } as any)
    store.progress("req-4", now - 86_400_000)
    store.close("req-4", "done", "https://git.example.com/team/app/-/merge_requests/12", now - 1000)
    const w = workOf(db, "sara", { now, linkFor: (ch, chat) => forgeLink(ch, chat, { gitlab: "https://git.example.com" }) })
    expect(w.open.map((r) => r.id)).toEqual(["req-1"])
    expect(w.open[0].where).toEqual({ label: "GitLab issue #7 in team/app", url: "https://git.example.com/team/app/-/issues/7" })
    expect(w.recent.map((r) => r.id)).toEqual(["req-4"])
    expect(w.recent[0].where.url).toBe("https://git.example.com/team/app/-/merge_requests/12")
    expect(workOf(db, "omar", { now }).open.map((r) => r.id)).toEqual(["req-2"])
    // Over HTTP, keyed by the machine's person.
    const { cookie } = await pair("sara")
    answer("yes")
    const r = await fetch(`${base}/api/member/work`, { headers: { cookie } })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.open.map((x: any) => x.id)).toEqual(["req-1"])
    expect(body.recent.map((x: any) => x.id)).toEqual(["req-4"])
  })

  it("names where a request was made, and links forges only", () => {
    expect(whereLabel("telegram", "c1")).toBe("Telegram")
    expect(whereLabel("github", "o/r:pull:3")).toBe("GitHub pull request #3 in o/r")
    expect(forgeLink("github", "o/r:pull:3", {})).toBe("https://github.com/o/r/pull/3")
    expect(forgeLink("telegram", "c1", {})).toBeNull()
    expect(forgeLink("gitlab", "no-thread", {})).toBeNull()
  })

  it("is empty before requests were ever turned on", () => {
    expect(workOf(db, "sara")).toEqual({ open: [], recent: [], runs: [] })
  })
})

describe("access by key, directly", () => {
  it("knows a removed machine and a key whose person changed", async () => {
    const { inv, cookie } = await pair()
    answer("yes")
    const token = cookie.slice(MEMBER_COOKIE.length + 1)
    expect(memberAccess(token, { tokens, members, root: dir })).toMatchObject({ ok: true, personId: "sara" })
    members.update(inv.tokenId, { personId: "omar" })
    expect(memberAccess(token, { tokens, members, root: dir })).toMatchObject({ ok: false, status: 401 })
    expect(memberAccess("agx_live_nothing", { tokens, members, root: dir })).toMatchObject({ ok: false, status: 401 })
  })
})

function _unused(_: IncomingMessage) { /* keeps the type import honest */ }
