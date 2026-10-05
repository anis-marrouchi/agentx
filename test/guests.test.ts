import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { PairCodeStore } from "../src/daemon/pair-codes"
import { PairAttemptLimiter } from "../src/daemon/app-pair-code"
import { decideCard, listCards } from "../src/approvals/cards"
import { GuestStore } from "../src/guests/store"
import { grantBrief, guestAccess, guestTask, inviteGuest, joinGuest, updateGrant, JOIN_FAILED, NO_GRANT, PAUSED, WAITING_HOST } from "../src/guests/grants"
import { handleGuestApi, type GuestApiDeps } from "../src/guests/daemon-api"
import { GuestHostStore } from "../src/guests/hosts"
import { isControlPost, isMeshGatedPath } from "../src/daemon/mesh-auth"
import { classifyInitiator } from "../src/a2a/initiator"

// Another organisation's mesh is let into part of this one (#380): one
// host agent, named folders, skills and commands, a freedom level and an
// end date. The guest asks, the host's agent acts; the host keeps it in
// hand while it is in use.

let dir: string
let tokens: TokenStore
let codes: PairCodeStore
let guests: GuestStore
let now: number
let ran: Array<ReturnType<typeof guestTask>>
let cancelled: string[]
let logs: string[]
let deps: GuestApiDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-guests-"))
  now = Date.parse("2026-10-01T12:00:00Z")
  tokens = new TokenStore(dir)
  codes = new PairCodeStore(dir, undefined, () => now)
  guests = new GuestStore(dir, () => now)
  ran = []
  cancelled = []
  logs = []
  deps = {
    tokens, codes, guests, root: dir, limiter: new PairAttemptLimiter(), now: () => now, minMs: 0, log: (l) => logs.push(l),
    hasAgent: (id) => id === "support" || id === "coder",
    run: async (t) => { ran.push(t); return { content: `answer for ${t.context.chatId}`, tokensUsed: 120 } },
    cancel: (g) => { cancelled.push(g.id); return 1 },
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const api = (method: string, path: string, body?: Record<string, unknown>, token: string | null = null, address = "100.64.0.9") =>
  handleGuestApi(method, path, body, { token, address }, deps)

function invite(over: Partial<Parameters<typeof inviteGuest>[1]> = {}) {
  const r = inviteGuest(deps, { name: "Support session for Company X", guest: "Company X", agentId: "support", folders: ["/srv/app"], skills: ["deploy-notes"], level: "propose", days: 7, ...over })
  if (!r.ok) throw new Error(r.error)
  return r
}

async function joinWith(code: string) {
  const r = await api("POST", "/mesh/guest/join", { code, node: { id: "node-x", name: "Company X main" } })
  return r
}

function approve(verdict: "yes" | "no" = "yes") {
  const [card] = listCards(dir, "pending")
  expect(card).toBeTruthy()
  expect(decideCard(dir, card.id, verdict, { by: "owner" }).ok).toBe(true)
  return card
}

describe("opening a grant", () => {
  it("mints a key for that grant alone, with the code the guest joins with", () => {
    const r = invite()
    expect(r.grant).toMatchObject({ name: "Support session for Company X", guest: "Company X", agentId: "support", level: "propose", state: "pending", folders: ["/srv/app"], skills: ["deploy-notes"], commands: [] })
    expect(r.grant.expiresAt).toBe("2026-10-08T12:00:00.000Z")
    const rec = tokens.list().find((t) => t.id === r.grant.tokenId)!
    expect(rec.scopes).toEqual([`guest:${r.grant.id}`])
    expect(guests.events(r.grant.id)[0]).toMatchObject({ event: "invited" })
    expect(statSync(join(dir, ".agentx/guests.json")).mode & 0o777).toBe(0o600)
  })

  it("refuses an unknown agent, a bad level and a bad length", () => {
    expect(inviteGuest(deps, { name: "x", guest: "y", agentId: "nope" })).toMatchObject({ ok: false, error: expect.stringContaining("agent must be") })
    expect(inviteGuest(deps, { name: "x", guest: "y", agentId: "support", level: "god" })).toMatchObject({ ok: false, error: expect.stringContaining("level") })
    expect(inviteGuest(deps, { name: "x", guest: "y", agentId: "support", days: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("days") })
    expect(inviteGuest(deps, { name: "", guest: "y", agentId: "support" })).toMatchObject({ ok: false })
  })
})

describe("joining", () => {
  it("holds the guest until the host says yes, then lets it ask", async () => {
    const inv = invite()
    const r = await joinWith(inv.code)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ grant: inv.grant.id, agentId: "support", level: "propose", state: "pending" })
    const token = r.token!
    expect(token.startsWith("agx_live_")).toBe(true)
    // The card names what the host needs to decide.
    const [card] = listCards(dir, "pending")
    expect(card.title).toBe("Guest mesh: Company X wants to join")
    expect(card.ask).toContain('"Company X main" at 100.64.0.9')
    expect(card.ask).toContain("support")
    expect(card.ask).toContain("until 2026-10-08")
    expect(guests.get(inv.grant.id)?.guestNode).toEqual({ id: "node-x", name: "Company X main", address: "100.64.0.9" })
    // Waiting: nothing runs.
    expect(await api("GET", "/mesh/guest/me", undefined, token)).toMatchObject({ status: 403, body: { error: WAITING_HOST, waiting: true } })
    expect(await api("POST", "/mesh/guest/task", { message: "hi" }, token)).toMatchObject({ status: 403 })
    expect(ran).toEqual([])
    approve("yes")
    const me = await api("GET", "/mesh/guest/me", undefined, token)
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ grant: inv.grant.id, state: "active", folders: ["/srv/app"] })
    expect(guests.get(inv.grant.id)?.state).toBe("active")
    expect(guests.events(inv.grant.id).map((e) => e.event)).toEqual(expect.arrayContaining(["invited", "joined", "approved"]))
  })

  it("ends the key when the host says no", async () => {
    const inv = invite()
    const { token } = await joinWith(inv.code)
    approve("no")
    expect(await api("GET", "/mesh/guest/me", undefined, token!)).toMatchObject({ status: 401, body: { error: NO_GRANT } })
    expect(guests.get(inv.grant.id)).toMatchObject({ state: "ended", endedReason: "the host said no" })
    expect(tokens.list().find((t) => t.id === inv.grant.tokenId)?.revokedAt).toBeTruthy()
  })

  it("refuses a wrong code with one answer, spends a good one, and locks out", async () => {
    // The guest has no terminal on the host: the answer names no command
    // (the phone app's "run agentx app pair" was returned here by mistake).
    expect(await joinWith("AAAA-AAAA")).toMatchObject({ status: 401, body: { error: JOIN_FAILED } })
    expect(JOIN_FAILED).not.toContain("agentx ")
    const inv = invite()
    expect((await joinWith(inv.code)).status).toBe(200)
    expect(await joinWith(inv.code)).toMatchObject({ status: 401, body: { error: JOIN_FAILED } })
    for (let i = 0; i < 4; i++) await joinWith("BBBB-BBBB")
    expect(await joinWith("CCCC-CCCC")).toMatchObject({ status: 429 })
  })

  it("never opens with the mesh token, a member key, an app key or nothing", async () => {
    const { token: app } = tokens.create({ name: "phone", scopes: ["app"] })
    const { token: member } = tokens.create({ name: "m", scopes: ["member:sara"] })
    for (const t of [app, member, "agx_live_" + "0".repeat(64), null]) {
      expect((await api("GET", "/mesh/guest/me", undefined, t)).status).toBe(401)
      expect((await api("POST", "/mesh/guest/task", { message: "x" }, t)).status).toBe(401)
    }
    expect(ran).toEqual([])
  })
})

describe("asking, inside the grant", () => {
  it("runs the guest's message as a turn of the host agent, with the grant in front of it, and counts it", async () => {
    const inv = invite()
    const { token } = await joinWith(inv.code)
    approve()
    const r = await api("POST", "/mesh/guest/task", { message: "Why is checkout failing?" }, token!)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ content: `answer for guest:${inv.grant.id}`, agentId: "support" })
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatchObject({
      agentId: "support", message: "Why is checkout failing?",
      context: { channel: "guest", chatId: `guest:${inv.grant.id}`, sender: "guest:Company X" },
      autonomy: "propose",
    })
    expect(ran[0].systemPromptAppend).toContain('"Company X"')
    expect(ran[0].systemPromptAppend).toContain("Folders: /srv/app")
    expect(ran[0].systemPromptAppend).toContain("propose: you may prepare changes")
    expect(ran[0].systemPromptAppend).toContain("never reveal other chats")
    expect(guests.get(inv.grant.id)?.usage).toEqual({ turns: 1, tokens: 120, lastAt: "2026-10-01T12:00:00.000Z" })
    expect(guests.events(inv.grant.id)[0]).toMatchObject({ event: "task", detail: "Why is checkout failing?" })
    // A guest's turn is not a person of this node.
    expect(classifyInitiator(ran[0].context)).toBe("agent")
  })

  it("act runs with no autonomy guard; report and propose are enforced", () => {
    const g = invite({ level: "act" }).grant
    expect(guestTask(g, "x").autonomy).toBeUndefined()
    expect(guestTask(invite({ level: "report" }).grant, "x").autonomy).toBe("report")
    expect(grantBrief(invite({ level: "report", folders: [] }).grant)).toContain("Folders: none named")
  })

  it("refuses an empty or oversized message", async () => {
    const inv = invite()
    const { token } = await joinWith(inv.code)
    approve()
    expect((await api("POST", "/mesh/guest/task", { message: "  " }, token!)).status).toBe(400)
    expect((await api("POST", "/mesh/guest/task", { message: "x".repeat(20_001) }, token!)).status).toBe(413)
  })
})

describe("live control by the host", () => {
  it("pauses (stopping running turns), resumes, widens, narrows and ends", async () => {
    const inv = invite()
    const { token } = await joinWith(inv.code)
    approve()
    const id = inv.grant.id
    expect(await api("POST", `/mesh/guests/${id}/pause`)).toMatchObject({ status: 200, body: { stopped: 1 } })
    expect(cancelled).toEqual([id])
    expect(await api("GET", "/mesh/guest/me", undefined, token!)).toMatchObject({ status: 403, body: { error: PAUSED, paused: true } })
    expect(await api("POST", `/mesh/guests/${id}/pause`)).toMatchObject({ status: 409 })
    expect(await api("POST", `/mesh/guests/${id}/resume`)).toMatchObject({ status: 200 })
    expect((await api("GET", "/mesh/guest/me", undefined, token!)).status).toBe(200)
    const widened = await api("POST", `/mesh/guests/${id}/update`, { level: "act", folders: "/srv/app,/srv/docs" })
    expect(widened.body).toMatchObject({ grant: { level: "act", folders: ["/srv/app", "/srv/docs"] } })
    expect(guests.events(id)[0]).toMatchObject({ event: "widened" })
    expect(await api("POST", `/mesh/guests/${id}/update`, { level: "report", days: 2 })).toMatchObject({ status: 200 })
    expect(guests.events(id)[0]).toMatchObject({ event: "narrowed" })
    expect(guests.get(id)?.expiresAt).toBe("2026-10-03T12:00:00.000Z")
    expect(await api("POST", `/mesh/guests/${id}/update`, { level: "nope" })).toMatchObject({ status: 400 })
    const list = await api("GET", "/mesh/guests")
    expect((list.body as any).grants[0]).toMatchObject({ id, state: "active" })
    expect((await api("GET", `/mesh/guests/${id}`)).body).toMatchObject({ grant: { id, trail: expect.any(Array) } })
    expect(await api("POST", `/mesh/guests/${id}/end`)).toMatchObject({ status: 200 })
    expect(await api("GET", "/mesh/guest/me", undefined, token!)).toMatchObject({ status: 401 })
    expect(await api("POST", `/mesh/guests/${id}/end`)).toMatchObject({ status: 409 })
    expect(await api("GET", "/mesh/guests/nope")).toMatchObject({ status: 404 })
  })

  it("ends on its date", async () => {
    const inv = invite({ days: 1 })
    const { token } = await joinWith(inv.code)
    approve()
    expect((await api("GET", "/mesh/guest/me", undefined, token!)).status).toBe(200)
    now += 25 * 3_600_000
    expect((await api("GET", "/mesh/guest/me", undefined, token!)).status).toBe(401)
    expect(guests.get(inv.grant.id)).toMatchObject({ state: "ended", endedReason: "expired" })
    expect(updateGrant(deps, inv.grant.id, { days: 3 })).toMatchObject({ ok: false })
  })

  it("keeps the host's panel behind the operator gates", () => {
    expect(isMeshGatedPath("/mesh/guests")).toBe(true)
    expect(isMeshGatedPath("/mesh/guests/g-1-a")).toBe(true)
    expect(isControlPost("/mesh/guests/g-1-a/pause")).toBe(true)
    expect(isControlPost("/mesh/guests/g-1-a/update")).toBe(true)
    // The guest's own routes are not mesh-token routes: the key decides.
    expect(isMeshGatedPath("/mesh/guest/task")).toBe(false)
    expect(isControlPost("/mesh/guest/task")).toBe(false)
  })
})

describe("the guest's side", () => {
  it("keeps the hosts it joined in a file of its own, readable by this user only", () => {
    const store = new GuestHostStore(dir)
    store.add({ name: "company-x", url: "https://host.example.com", token: "agx_live_x", grant: "g-1-a", agentId: "support", expiresAt: "2026-10-08T12:00:00.000Z", joinedAt: "2026-10-01T12:00:00.000Z" })
    expect(store.get("company-x")?.agentId).toBe("support")
    expect(statSync(join(dir, ".agentx/guest-hosts.json")).mode & 0o777).toBe(0o600)
    expect(store.remove("company-x")).toBe(true)
    expect(store.remove("company-x")).toBe(false)
    expect(store.hosts()).toEqual([])
  })
})
