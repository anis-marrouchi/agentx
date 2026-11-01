import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { PairCodeStore } from "../src/daemon/pair-codes"
import { PairAttemptLimiter } from "../src/daemon/app-pair-code"
import { MemberStore } from "../src/members/store"
import { PersonSessionStore } from "../src/members/person-sessions"
import { OwnerBrowserStore, MAX_WAITING } from "../src/members/owner-browsers"
import { handleMemberRequest } from "../src/daemon/member-routes"
import { handleOwnerSignInPanel } from "../src/daemon/owner-signin-panel"
import { sessionValue } from "../src/daemon/dashboard-session"
import { listCards } from "../src/approvals/cards"
import { OWNER_WAIT_GONE, SendLimiter, SignInLinkStore, type SignInSetup } from "../src/members/signin"
import type { OutgoingMail } from "../src/channels/email/smtp"
import type { Person } from "../src/people/people"

// The owner signs in by an email link too (#1478, answer 4, Decision 8):
// full owner rights (the dashboard's ax_session), but each new browser is
// confirmed on the home machine first, never by a phone card.

const SETUP: SignInSetup = {
  origin: "https://studio.example-tailnet.ts.net",
  sender: { kind: "smtp", from: "no-reply@mg.example.com", name: "Example Wall", host: "smtp.example.net", port: 587, secure: false, user: "u", password: "p" },
  firstSignIn: "auto",
}
const TOKEN = "dashboard-token-for-tests"
// A browser off the box arrives through the local proxy (tailscale serve).
const OFF_BOX = { "X-Forwarded-For": "100.64.0.9" }

let PEOPLE: Person[]
let token: string | undefined
let dir: string
let members: MemberStore
let browsers: OwnerBrowserStore
let sent: OutgoingMail[]
let clock: number
let server: Server
let base: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-owner-signin-"))
  clock = Date.parse("2026-11-01T17:00:00Z")
  const now = () => clock
  members = new MemberStore(dir)
  browsers = new OwnerBrowserStore(dir, now)
  sent = []
  token = TOKEN
  PEOPLE = [
    { id: "boss", name: "Boss", role: "owner", identities: ["email:boss@example.com"] },
    { id: "dana", name: "Dana", role: "member", identities: ["email:dana@example.com"] },
  ]
  const links = new SignInLinkStore(dir, now)
  const sessions = new PersonSessionStore(dir, now)
  const limiter = new PairAttemptLimiter()
  const perAddress = new SendLimiter(50, 3600_000, now)
  const perClient = new SendLimiter(50, 3600_000, now)
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    if (await handleOwnerSignInPanel(req, res, path, { browsers, members, token, log: () => {} })) return
    const handled = await handleMemberRequest(req, res, path, req.method || "GET", {
      tokens: new TokenStore(dir), members, pairCodes: new PairCodeStore(dir), pairLimiter: limiter, pairMinMs: 0, root: dir,
      people: () => PEOPLE, log: () => {},
      signInSetup: () => SETUP, signInLinks: links, sessions, now, signInPerAddress: perAddress, signInPerClient: perClient,
      sendMail: async (_s, mail) => { sent.push(mail); return "<id@test>" },
      dashboardToken: () => token, ownerBrowsers: browsers,
    })
    if (!handled) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...OFF_BOX, ...headers }, body: JSON.stringify(body) })
const codeOf = (mail: OutgoingMail) => /\/member\/signin#([A-Za-z0-9_-]{43})/.exec(mail.text)![1]
const cookies = (r: Response) => r.headers.getSetCookie()
const named = (r: Response, name: string) => cookies(r).find((c) => c.startsWith(`${name}=`))
const pair = (c: string | undefined) => (c || "").split(";")[0]

async function link(email = "boss@example.com"): Promise<string> {
  await post("/api/member/signin-link", { email })
  return codeOf(sent[sent.length - 1])
}
const spend = async (code: string, machine = "Work laptop", browser = "") =>
  post("/api/member/signin", { code, machine }, browser ? { cookie: browser } : {})
const poll = (browser: string) => fetch(`${base}/api/member/owner-signin`, { headers: { cookie: browser, ...OFF_BOX } })
const panel = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init)
const answer = (id: string, act: string) => panel(`/api/admin/owner-signins/${id}/${act}`, { method: "POST", headers: { "X-Requested-With": "agentx-board" } })

describe("the owner's link", () => {
  it("is mailed while the dashboard token is set, and names the dashboard", async () => {
    await link()
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe("boss@example.com")
    expect(sent[0].text).toContain("sign in to the dashboard")
  })

  it("is not mailed with no dashboard token, and the answer is the same", async () => {
    token = undefined
    const r = await post("/api/member/signin-link", { email: "boss@example.com" })
    expect(r.status).toBe(200)
    expect(sent).toHaveLength(0)
  })
})

describe("a new browser", () => {
  it("waits for the confirm on the home machine, then gets ax_session once", async () => {
    const r = await spend(await link())
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toMatchObject({ person: "boss", state: "confirm", check: expect.stringMatching(/^\d{3} \d{3}$/) })
    // No owner rights yet, and no personal session either.
    expect(named(r, "ax_session")).toBeUndefined()
    expect(named(r, "ax_person")).toBeUndefined()
    const browserCookie = named(r, "ax_owner_browser")!
    expect(browserCookie).toContain("HttpOnly")
    expect(browserCookie).toContain("Path=/api/member")
    const browser = pair(browserCookie)
    // No phone card: the confirm is on the home machine only.
    expect(listCards(dir, "pending")).toHaveLength(0)

    const waiting = await poll(browser)
    expect(waiting.status).toBe(202)
    expect(await waiting.json()).toEqual({ state: "confirm", check: body.check, name: "Work laptop" })

    const list = await (await panel("/api/admin/owner-signins")).json()
    expect(list.waiting).toBe(1)
    expect(list.browsers[0]).toMatchObject({ label: "Work laptop", check: body.check, state: "pending" })
    expect(list.browsers[0].hash).toBeUndefined()
    expect(readFileSync(join(dir, ".agentx/owner-browsers.json"), "utf-8")).not.toContain(browser.split("=")[1])

    expect((await answer(list.browsers[0].id, "confirm")).status).toBe(200)
    const done = await poll(browser)
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ state: "active", next: "/hub" })
    expect(pair(named(done, "ax_session"))).toBe(`ax_session=${sessionValue(TOKEN)}`)
    // Collected once: the cookie is not handed out again.
    expect((await poll(browser)).status).toBe(401)
    expect(members.events("boss").map((e) => e.event)).toEqual(["signed-in", "approved", "paired", "invited"])
  })

  it("goes straight in on its next link once confirmed", async () => {
    const browser = pair(named(await spend(await link()), "ax_owner_browser"))
    await answer(browsers.list()[0].id, "confirm")
    await poll(browser)
    const again = await spend(await link(), "ignored", browser)
    expect(await again.json()).toMatchObject({ state: "active", next: "/hub", name: "Work laptop" })
    expect(pair(named(again, "ax_session"))).toBe(`ax_session=${sessionValue(TOKEN)}`)
    expect(browsers.list()).toHaveLength(1)
  })

  it("is refused when the owner presses Refuse", async () => {
    const browser = pair(named(await spend(await link()), "ax_owner_browser"))
    await answer(browsers.list()[0].id, "refuse")
    const r = await poll(browser)
    expect(r.status).toBe(401)
    expect((await r.json()).error).toBe(OWNER_WAIT_GONE)
    expect(named(r, "ax_session")).toBeUndefined()
  })

  it("asks again after End", async () => {
    const browser = pair(named(await spend(await link()), "ax_owner_browser"))
    const id = browsers.list()[0].id
    await answer(id, "confirm")
    await poll(browser)
    expect((await answer(id, "end")).status).toBe(200)
    const again = await spend(await link(), "Work laptop", browser)
    expect(await again.json()).toMatchObject({ state: "confirm" })
    expect(named(again, "ax_session")).toBeUndefined()
  })

  it("stops waiting after 15 minutes, and a late confirm does nothing", async () => {
    const browser = pair(named(await spend(await link()), "ax_owner_browser"))
    const id = browsers.list()[0].id
    clock += 15 * 60_000
    expect((await poll(browser)).status).toBe(401)
    expect((await answer(id, "confirm")).status).toBe(404)
  })

  it("gives nothing once the person is no longer the owner, or the token is gone", async () => {
    const browser = pair(named(await spend(await link()), "ax_owner_browser"))
    await answer(browsers.list()[0].id, "confirm")
    token = undefined
    expect((await poll(browser)).status).toBe(401)
    token = TOKEN
    PEOPLE[0] = { ...PEOPLE[0], role: "member" }
    expect((await poll(browser)).status).toBe(401)
  })

  it("keeps at most a few sign-ins waiting", async () => {
    for (let i = 0; i < MAX_WAITING; i++) expect((await spend(await link())).status).toBe(200)
    const r = await spend(await link())
    expect(r.status).toBe(503)
    expect(named(r, "ax_owner_browser")).toBeUndefined()
  })

  it("keeps the network check: an owner with a tailscale login must arrive with it", async () => {
    PEOPLE[0] = { ...PEOPLE[0], identities: ["email:boss@example.com", "tailscale:boss@example.com"] }
    const r = await spend(await link(), "x")
    expect(r.status).toBe(403)
    expect(browsers.list()).toHaveLength(0)
  })

  it("does not touch a member's sign-in", async () => {
    const r = await spend(await link("dana@example.com"), "Dana's laptop")
    expect(await r.json()).toMatchObject({ person: "dana", state: "active" })
    expect(named(r, "ax_person")).toBeDefined()
    expect(named(r, "ax_session")).toBeUndefined()
  })
})

describe("the home machine's page", () => {
  it("answers a caller on this machine only", async () => {
    await spend(await link())
    const id = browsers.list()[0].id
    expect((await panel("/signin-requests", { headers: OFF_BOX })).status).toBe(403)
    expect((await panel("/api/admin/owner-signins", { headers: OFF_BOX })).status).toBe(403)
    // Even a browser holding the owner's session cannot confirm from elsewhere.
    const elsewhere = await panel(`/api/admin/owner-signins/${id}/confirm`, {
      method: "POST", headers: { ...OFF_BOX, "X-Requested-With": "agentx-board", cookie: `ax_session=${sessionValue(TOKEN)}` },
    })
    expect(elsewhere.status).toBe(403)
    expect(browsers.list()[0].state).toBe("pending")
    const page = await panel("/signin-requests")
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("Sign-in requests")
  })

  it("refuses a write without X-Requested-With, so another site cannot press Confirm", async () => {
    await spend(await link())
    const r = await panel(`/api/admin/owner-signins/${browsers.list()[0].id}/confirm`, { method: "POST" })
    expect(r.status).toBe(400)
    expect(browsers.list()[0].state).toBe("pending")
  })
})

describe("the browser's waiting page", () => {
  it("polls for the confirm and holds no code itself", async () => {
    const r = await fetch(`${base}/member/signin/owner`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain("Confirm on the home machine")
    expect(html).toContain("/api/member/owner-signin")
  })
})
