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
import { handleMemberRequest } from "../src/daemon/member-routes"
import { decideCard, listCards } from "../src/approvals/cards"
import { LINK_ASKED, LINK_FAILED, LINK_TTL_MS, SendLimiter, SignInLinkStore, personByEmail, type SignInSetup } from "../src/members/signin"
import type { OutgoingMail } from "../src/channels/email/smtp"
import type { Person } from "../src/people/people"

// Signing in with a link sent by email (#1478, slice 3): the link gives the
// browser a personal session (ax_person), never a member key. A person's
// first sign-in waits for the owner's card; later ones go straight in. Only
// a member or a client with that `email:` identity gets a link, and the
// answer never says whether an address is known.

const SETUP: SignInSetup = {
  origin: "https://studio.example-tailnet.ts.net",
  sender: { kind: "smtp", from: "no-reply@mg.example.com", name: "Example Wall", host: "smtp.example.net", port: 587, secure: false, user: "u", password: "p" },
  firstSignIn: "card",
}

let PEOPLE: Person[]
let setup: SignInSetup | null
let dir: string
let tokens: TokenStore
let members: MemberStore
let links: SignInLinkStore
let sessions: PersonSessionStore
let sent: OutgoingMail[]
let clock: number
let server: Server
let base: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-signin-"))
  clock = Date.parse("2026-10-31T17:00:00Z")
  const now = () => clock
  tokens = new TokenStore(dir)
  members = new MemberStore(dir)
  links = new SignInLinkStore(dir, now)
  sessions = new PersonSessionStore(dir, now)
  sent = []
  setup = SETUP
  PEOPLE = [
    { id: "dana", name: "Dana", role: "member", identities: ["email:Dana@Example.com"] },
    { id: "lee", name: "Lee", role: "client", identities: ["email:lee@example.com"] },
    { id: "boss", name: "Boss", role: "owner", identities: ["email:boss@example.com"] },
    { id: "gus", name: "Gus", role: "guest", identities: ["email:gus@example.com"] },
  ]
  const limiter = new PairAttemptLimiter()
  const perAddress = new SendLimiter(5, 3600_000, now)
  const perClient = new SendLimiter(20, 3600_000, now)
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const handled = await handleMemberRequest(req, res, path, req.method || "GET", {
      tokens, members, pairCodes: new PairCodeStore(dir), pairLimiter: limiter, pairMinMs: 0, root: dir,
      people: () => PEOPLE, log: () => {},
      signInSetup: () => setup, signInLinks: links, sessions, now, signInPerAddress: perAddress, signInPerClient: perClient,
      sendMail: async (_s, mail) => { sent.push(mail); return "<id@test>" },
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
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
const ask = (email: string) => post("/api/member/signin-link", { email })
const codeOf = (mail: OutgoingMail) => /\/member\/signin#([A-Za-z0-9_-]{43})/.exec(mail.text)![1]
const spend = (code: string, machine = "Dana's laptop") => post("/api/member/signin", { code, machine })

describe("asking for a link", () => {
  it("mails a member a link to the fixed origin, and keeps only its hash", async () => {
    const r = await ask("dana@example.com")
    expect(r.status).toBe(200)
    expect((await r.json()).message).toBe(LINK_ASKED)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe("dana@example.com")
    expect(sent[0].text).toContain("https://studio.example-tailnet.ts.net/member/signin#")
    expect(sent[0].text).toContain('"My work"')
    const file = readFileSync(join(dir, ".agentx/signin-links.json"), "utf-8")
    expect(file).not.toContain(codeOf(sent[0]))
  })

  it("matches the address in any case, and mails a client too", async () => {
    await ask("DANA@example.COM")
    await ask("lee@example.com")
    expect(sent.map((m) => m.to)).toEqual(["dana@example.com", "lee@example.com"])
    expect(sent[1].text).toContain('"Your project"')
  })

  it("answers an unknown address, the owner and a guest the same, and mails none of them", async () => {
    const known = await (await ask("dana@example.com")).json()
    for (const email of ["nobody@example.com", "boss@example.com", "gus@example.com"]) {
      const r = await ask(email)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual(known)
    }
    expect(sent).toHaveLength(1)
  })

  it("sends at most 5 links an hour to one address", async () => {
    for (let i = 0; i < 7; i++) expect((await ask("dana@example.com")).status).toBe(200)
    expect(sent).toHaveLength(5)
    clock += 3600_000
    await ask("dana@example.com")
    expect(sent).toHaveLength(6)
  })

  it("is closed while the origin or the sender is not set", async () => {
    setup = null
    expect((await ask("dana@example.com")).status).toBe(404)
    expect((await spend("x".repeat(43))).status).toBe(404)
    expect(await (await fetch(`${base}/member/signin`)).text()).toContain("not set up here")
    expect(await (await fetch(`${base}/member`)).text()).not.toContain("/member/signin")
    expect(sent).toHaveLength(0)
  })
})

describe("spending a link", () => {
  async function linkFor(email = "dana@example.com") {
    await ask(email)
    return codeOf(sent[sent.length - 1])
  }

  const cookieOf = (r: Response) => (r.headers.get("set-cookie") || "").split(";")[0]

  it("gives a personal session, held on the first sign-in until the owner says yes", async () => {
    const r = await spend(await linkFor())
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ person: "dana", state: "pending" })
    const set = r.headers.get("set-cookie") || ""
    expect(set).toMatch(/^ax_person=[A-Za-z0-9_-]{43};/)
    expect(set).toContain("HttpOnly")
    const cookie = cookieOf(r)
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie } })).status).toBe(403)
    const waiting = await fetch(`${base}/member`, { headers: { cookie } })
    expect(waiting.status).toBe(202)
    expect(await waiting.text()).toContain("first sign-in")
    const [card] = listCards(dir, "pending")
    expect(card.title).toBe("Dana signed in for the first time")
    expect(card.recommend).toContain("link mailed to Dana")
    decideCard(dir, card.id, "yes", { by: "owner" })
    const me = await fetch(`${base}/api/member/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ person: "dana", device: "Dana's laptop" })
    expect((await fetch(`${base}/member`, { headers: { cookie } })).status).toBe(200)
    // No member key and no paired machine: a session, on People with End access.
    expect(tokens.list().filter((t) => t.scopes.includes("member:dana"))).toHaveLength(0)
    expect(members.devices("dana")).toHaveLength(0)
    expect(sessions.sessions("dana")).toMatchObject([{ label: "Dana's laptop", approvedAt: expect.any(String) }])
  })

  it("lets a person in straight away once the owner has said yes before", async () => {
    await spend(await linkFor())
    decideCard(dir, listCards(dir, "pending")[0].id, "yes", { by: "owner" })
    // The first browser has not called back yet: the yes still counts.
    const r = await spend(await linkFor(), "Phone")
    expect(await r.json()).toMatchObject({ state: "active" })
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: cookieOf(r) } })).status).toBe(200)
    expect(listCards(dir, "pending")).toHaveLength(0)
  })

  it("ends the session when the owner says no, and the next sign-in asks again", async () => {
    const r = await spend(await linkFor())
    decideCard(dir, listCards(dir, "pending")[0].id, "no", { by: "owner" })
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: cookieOf(r) } })).status).toBe(401)
    expect(sessions.sessions("dana")[0]).toMatchObject({ endedReason: "the owner said no" })
    expect(await (await spend(await linkFor())).json()).toMatchObject({ state: "pending" })
  })

  it("skips the card for a member under firstSignIn auto, never for a client", async () => {
    setup = { ...SETUP, firstSignIn: "auto" }
    const dana = await spend(await linkFor())
    expect(await dana.json()).toMatchObject({ state: "active" })
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: cookieOf(dana) } })).status).toBe(200)
    const lee = await spend(await linkFor("lee@example.com"), "Lee's Mac")
    expect(await lee.json()).toMatchObject({ state: "pending" })
    expect(listCards(dir, "pending")).toHaveLength(1)
  })

  it("stops at once on End access, or when the person leaves the list", async () => {
    setup = { ...SETUP, firstSignIn: "auto" }
    const one = cookieOf(await spend(await linkFor()))
    const two = cookieOf(await spend(await linkFor(), "Phone"))
    const first = sessions.sessions("dana").find((s) => s.label === "Dana's laptop")!
    sessions.end("dana", first.id, "ended by the owner (dashboard)")
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: one } })).status).toBe(401)
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: two } })).status).toBe(200)
    PEOPLE = PEOPLE.filter((p) => p.id !== "dana")
    expect((await fetch(`${base}/api/member/me`, { headers: { cookie: two } })).status).toBe(401)
  })

  it("cleans the browser name it is given before the card and the page show it", async () => {
    const r = await spend(await linkFor(), '<img src=x onerror=alert(1)>"Laptop"')
    const name = (await r.json()).name
    expect(name).not.toMatch(/[<>"=]/)
    expect(listCards(dir, "pending")[0].ask).not.toContain("<img")
  })

  it("works once", async () => {
    const code = await linkFor()
    expect((await spend(code)).status).toBe(200)
    const again = await spend(code)
    expect(again.status).toBe(401)
    expect((await again.json()).error).toBe(LINK_FAILED)
  })

  it("stops after 15 minutes", async () => {
    const code = await linkFor()
    clock += LINK_TTL_MS + 1
    expect((await spend(code)).status).toBe(401)
  })

  it("stops when a newer link is asked for", async () => {
    const first = await linkFor()
    await linkFor()
    expect((await spend(first)).status).toBe(401)
  })

  it("stops when the address is no longer the person's", async () => {
    const code = await linkFor()
    PEOPLE[0] = { ...PEOPLE[0], identities: ["email:dana@other.example.com"] }
    expect((await spend(code)).status).toBe(401)
    expect(listCards(dir, "pending")).toHaveLength(0)
  })

  it("refuses a made-up code without raising a card", async () => {
    expect((await spend("A".repeat(43))).status).toBe(401)
    expect((await spend("short")).status).toBe(401)
    expect(listCards(dir, "pending")).toHaveLength(0)
  })

  it("keeps the network check of pairing: a person with a tailscale login must arrive with it", async () => {
    PEOPLE[0] = { ...PEOPLE[0], identities: ["email:dana@example.com", "tailscale:dana@example.com"] }
    const r = await post("/api/member/signin", { code: await linkFor(), machine: "x" }, { "Tailscale-User-Login": "someone@else.com" })
    expect(r.status).toBe(403)
    expect(r.headers.get("set-cookie")).toBeNull()
    expect(sessions.sessions("dana")).toHaveLength(0)
  })
})

describe("the pages", () => {
  it("offers the email road on the locked page when it is set up", async () => {
    expect(await (await fetch(`${base}/member`)).text()).toContain('href="/member/signin"')
    const page = await (await fetch(`${base}/member/signin`)).text()
    expect(page).toContain("Send me a link")
    expect(page).toContain("history.replaceState")
  })
})

describe("personByEmail", () => {
  it("compares the whole address in lower case, with no +tag rules", () => {
    const people: Person[] = [{ id: "a", name: "A", role: "member", identities: ["email:a@example.com"] }]
    expect(personByEmail(people, " A@Example.com ")?.id).toBe("a")
    expect(personByEmail(people, "a+x@example.com")).toBeNull()
  })
})
