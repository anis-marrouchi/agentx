import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { createHash } from "crypto"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { PairCodeStore } from "../src/daemon/pair-codes"
import { PairAttemptLimiter } from "../src/daemon/app-pair-code"
import { MemberStore } from "../src/members/store"
import { PersonSessionStore } from "../src/members/person-sessions"
import { handleMemberRequest } from "../src/daemon/member-routes"
import { decideCard, listCards } from "../src/approvals/cards"
import { OidcStateStore, PROVIDER_FAILED, SignInAccountStore, type OidcSetup } from "../src/members/oidc"
import { literalSecretProblems } from "../src/daemon/config"
import type { Person } from "../src/people/people"

// Signing in with an OpenID Connect provider (#1675), against a fake one:
// code flow with PKCE, state bound to the browser, nonce, a verified
// address, then the same personal session and first-sign-in card as the
// email link. The first account used for a person is the only one after.

const ISSUER = "https://id.example.test"
const SETUP: OidcSetup = {
  name: "Example ID", issuer: ISSUER, clientId: "client-1", clientSecret: "s3cret",
  origin: "https://studio.example-tailnet.ts.net", firstSignIn: "card",
}

let PEOPLE: Person[]
let setup: OidcSetup | null
let dir: string
let sessions: PersonSessionStore
let accounts: SignInAccountStore
let clock: number
let server: Server
let base: string
let claims: Record<string, any>
let tokenRequests: URLSearchParams[]
let logLines: string[]

const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` })
  }
  if (url === `${ISSUER}/token`) {
    tokenRequests.push(new URLSearchParams(String(init?.body)))
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return Response.json({ id_token: `e30.${payload}.sig`, access_token: "at" })
  }
  return new Response("", { status: 404 })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-oidc-"))
  clock = Date.parse("2026-11-01T15:00:00Z")
  const now = () => clock
  sessions = new PersonSessionStore(dir, now)
  accounts = new SignInAccountStore(dir)
  setup = SETUP
  tokenRequests = []
  logLines = []
  PEOPLE = [
    { id: "dana", name: "Dana", role: "member", identities: ["email:dana@example.com"] },
    { id: "boss", name: "Boss", role: "owner", identities: ["email:boss@example.com"] },
  ]
  const members = new MemberStore(dir)
  const states = new OidcStateStore(now)
  const pairLimiter = new PairAttemptLimiter()
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const handled = await handleMemberRequest(req, res, path, req.method || "GET", {
      tokens: new TokenStore(dir), members, pairCodes: new PairCodeStore(dir), pairLimiter,
      pairMinMs: 0, root: dir, people: () => PEOPLE, log: (line) => logLines.push(line), sessions, now,
      oidcSetup: () => setup, oidcStates: states, signInAccounts: accounts, fetch: fakeFetch as any,
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

const claimsFor = (email: string, sub = "sub-dana", over: Record<string, any> = {}) => ({
  iss: ISSUER, aud: "client-1", sub, email, email_verified: true, exp: clock / 1000 + 600, ...over,
})

/** Start a sign-in; the provider's address and this browser's state cookie. */
async function start(machine = "Dana's laptop", headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/member/signin/oidc?machine=${encodeURIComponent(machine)}`, { redirect: "manual", headers })
  expect(r.status).toBe(302)
  const to = new URL(r.headers.get("location")!)
  const cookie = /ax_oidc=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")![1]
  return { to, cookie }
}

/** Come back from the provider with a code, as the browser would. */
async function back(state: string, cookie: string | null, { nonce }: { nonce?: string } = {}, extra = "", headers: Record<string, string> = {}) {
  if (nonce !== undefined) claims.nonce = nonce
  return fetch(`${base}/member/signin/oidc/done?code=c0de&state=${state}${extra}`, {
    redirect: "manual", headers: { ...headers, ...(cookie ? { Cookie: `ax_oidc=${cookie}` } : {}) },
  })
}

async function signIn(email: string, sub?: string, over: Record<string, any> = {}, headers: Record<string, string> = {}) {
  const { to, cookie } = await start(undefined, headers)
  claims = claimsFor(email, sub, { nonce: to.searchParams.get("nonce"), ...over })
  return back(to.searchParams.get("state")!, cookie, {}, "", headers)
}

const answerCard = (answer: "yes" | "no") => decideCard(dir, listCards(dir).find((c) => c.status === "pending")!.id, answer, { by: "owner" })

describe("starting", () => {
  it("sends the browser to the provider with PKCE, state, nonce and the fixed return address", async () => {
    const { to, cookie } = await start()
    expect(`${to.origin}${to.pathname}`).toBe(`${ISSUER}/authorize`)
    const q = to.searchParams
    expect(q.get("response_type")).toBe("code")
    expect(q.get("client_id")).toBe("client-1")
    expect(q.get("redirect_uri")).toBe("https://studio.example-tailnet.ts.net/member/signin/oidc/done")
    expect(q.get("scope")).toBe("openid email")
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("nonce")).toBeTruthy()
    expect(q.get("state")).toBe(cookie)
    expect(q.toString()).not.toContain("s3cret")
  })

  it("asks for the hosted domain when one is set", async () => {
    setup = { ...SETUP, hd: "example.com" }
    expect((await start()).to.searchParams.get("hd")).toBe("example.com")
  })

  it("offers the button only when a provider is set", async () => {
    expect(await (await fetch(`${base}/member/signin`)).text()).toContain("Sign in with Example ID")
    setup = null
    expect(await (await fetch(`${base}/member/signin`)).text()).not.toContain("/member/signin/oidc")
    expect((await fetch(`${base}/member/signin/oidc`, { redirect: "manual" })).status).toBe(404)
  })
})

describe("coming back", () => {
  it("gives a member a waiting session and raises the owner's card on the first sign-in", async () => {
    const { to, cookie } = await start()
    claims = claimsFor("dana@example.com", "sub-dana", { nonce: to.searchParams.get("nonce") })
    const r = await back(to.searchParams.get("state")!, cookie)
    expect(r.status).toBe(302)
    expect(r.headers.get("location")).toBe("/member")
    expect(r.headers.get("set-cookie")).toMatch(/ax_person=/)
    // The code went back with the PKCE verifier and the secret, from the Wall.
    const sent = tokenRequests[0]
    expect(sent.get("code")).toBe("c0de")
    expect(sent.get("client_secret")).toBe("s3cret")
    expect(createHash("sha256").update(sent.get("code_verifier")!).digest("base64url")).toBe(to.searchParams.get("code_challenge"))
    const open = listCards(dir).filter((c) => c.status === "pending")
    expect(open).toHaveLength(1)
    expect(open[0].recommend).toContain("Dana's Example ID account")
    expect(sessions.sessions("dana")[0]).toMatchObject({ label: "Dana's laptop", state: "pending" })
  })

  it("lets a person in straight away once the owner has said yes", async () => {
    await signIn("dana@example.com")
    const card = listCards(dir).find((c) => c.status === "pending")!
    decideCard(dir, card.id, "yes", { by: "owner" })
    const r = await signIn("dana@example.com")
    expect(r.status).toBe(302)
    expect(sessions.sessions("dana").some((s) => !s.state && s.approvedAt)).toBe(true)
  })

  it("refuses a state from another browser, and a state used twice", async () => {
    const { to, cookie } = await start()
    claims = claimsFor("dana@example.com", "sub-dana", { nonce: to.searchParams.get("nonce") })
    const state = to.searchParams.get("state")!
    expect((await back(state, null)).status).toBe(401)
    expect((await back(state, "x".repeat(43))).status).toBe(401)
    expect(tokenRequests).toHaveLength(0)
    expect((await back(state, cookie)).status).toBe(302)
    expect((await back(state, cookie)).status).toBe(401)
    expect(sessions.sessions("dana")).toHaveLength(1)
  })

  it("refuses an unverified address, a wrong nonce, another audience and an old token", async () => {
    for (const over of [{ email_verified: false }, { nonce: "other" }, { aud: "client-2" }, { exp: clock / 1000 - 1 }]) {
      const r = await signIn("dana@example.com", "sub-dana", over)
      expect(r.status).toBe(401)
      expect(await r.text()).toContain(PROVIDER_FAILED)
    }
    expect(sessions.sessions("dana")).toHaveLength(0)
  })

  it("refuses an account of another hosted domain when one is set", async () => {
    setup = { ...SETUP, hd: "example.com" }
    expect((await signIn("dana@example.com", "sub-dana", { hd: "other.com" })).status).toBe(401)
    expect((await signIn("dana@example.com", "sub-dana", { hd: "example.com" })).status).toBe(302)
  })

  it("lets in no owner, no unknown address, and the same answer for both", async () => {
    const owner = await signIn("boss@example.com", "sub-boss")
    const unknown = await signIn("nobody@example.com", "sub-x")
    expect([owner.status, unknown.status]).toEqual([401, 401])
    expect(await owner.text()).toBe(await unknown.text())
    expect(sessions.sessions("boss")).toHaveLength(0)
  })

  it("keeps the first account: another account with the same address gets nobody in", async () => {
    expect((await signIn("dana@example.com", "sub-dana")).status).toBe(302)
    answerCard("yes")
    expect((await signIn("dana@example.com", "sub-new")).status).toBe(401)
    expect(accounts.get("dana", ISSUER)).toBe("sub-dana")
    expect(sessions.sessions("dana")).toHaveLength(1)
  })

  it("keeps no account while the owner's card waits, nor after a no", async () => {
    expect((await signIn("dana@example.com", "sub-stranger")).status).toBe(302)
    expect(accounts.get("dana", ISSUER)).toBeNull()
    answerCard("no")
    expect((await signIn("dana@example.com", "sub-dana")).status).toBe(302)
    expect(accounts.get("dana", ISSUER)).toBeNull()
    answerCard("yes")
    // The yes is read on the next sign-in or page load; then the account is kept.
    expect((await signIn("dana@example.com", "sub-dana")).status).toBe(302)
    expect(accounts.get("dana", ISSUER)).toBe("sub-dana")
  })

  it("lets in only the kept account when the owner says yes to two waiting accounts", async () => {
    expect((await signIn("dana@example.com", "sub-dana")).status).toBe(302)
    expect((await signIn("dana@example.com", "sub-other")).status).toBe(302)
    const waiting = listCards(dir).filter((c) => c.status === "pending")
    expect(waiting).toHaveLength(2)
    for (const c of waiting) decideCard(dir, c.id, "yes", { by: "owner" })
    // The next sign-in reads both yeses, the older card first.
    expect((await signIn("dana@example.com", "sub-dana")).status).toBe(302)
    expect(accounts.get("dana", ISSUER)).toBe("sub-dana")
    const other = sessions.sessions("dana").find((s) => s.account?.subject === "sub-other")!
    expect(other.endedAt).toBeTruthy()
    expect(other.approvedAt).toBeUndefined()
    expect((await signIn("dana@example.com", "sub-other")).status).toBe(401)
  })

  it("keeps no account when the network check refuses the sign-in", async () => {
    PEOPLE[0] = { ...PEOPLE[0], identities: ["email:dana@example.com", "tailscale:dana@example.com"] }
    setup = { ...SETUP, firstSignIn: "auto" }
    const r = await signIn("dana@example.com", "sub-stranger", {}, { "Tailscale-User-Login": "someone@else.com" })
    expect(r.status).toBe(403)
    expect(accounts.get("dana", ISSUER)).toBeNull()
    expect(accounts.personOf(ISSUER, "sub-stranger")).toBeNull()
    expect((await signIn("dana@example.com", "sub-dana", {}, { "Tailscale-User-Login": "dana@example.com" })).status).toBe(302)
    expect(accounts.get("dana", ISSUER)).toBe("sub-dana")
  })

  it("cleans the provider's error before it reaches the log", async () => {
    const { to, cookie } = await start()
    const r = await back(to.searchParams.get("state")!, cookie, {}, "&error=bad%0Aline%1B%5B31m")
    expect(r.status).toBe(401)
    const line = logLines.find((l) => l.includes("provider said"))!
    expect(line).toContain("provider said bad?line?[31m")
    expect(line).not.toMatch(/[\x00-\x1f]/)
  })

  it("accepts the issuer written without its scheme, as Google sends it", async () => {
    expect((await signIn("dana@example.com", "sub-dana", { iss: "id.example.test" })).status).toBe(302)
  })
})

describe("a flood of starts", () => {
  it("pushes out only the flooding address's own sign-ins", () => {
    const states = new OidcStateStore(() => clock)
    const dana = states.create("Dana's laptop", "100.64.0.2")!
    for (let i = 0; i < 50; i++) expect(states.create("x", "100.64.0.9")).not.toBeNull()
    expect(states.spend(dana.state)).not.toBeNull()
  })

  it("refuses new starts, not waiting ones, once too many wait", () => {
    const states = new OidcStateStore(() => clock)
    const dana = states.create("Dana's laptop", "100.64.0.2")!
    for (let i = 0; i < 300; i++) states.create("x", `100.64.1.${i}`)
    expect(states.create("y", "100.64.2.1")).toBeNull()
    expect(states.spend(dana.state)).not.toBeNull()
  })

  it("turns away an address locked out by failed sign-ins", async () => {
    for (let i = 0; i < 20; i++) await back("x".repeat(43), null)
    const r = await fetch(`${base}/member/signin/oidc`, { redirect: "manual" })
    expect(r.status).toBe(429)
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/)
  })
})

describe("config", () => {
  it("takes the client secret only as a ${VAR} reference", () => {
    const at = (clientSecret: string) => literalSecretProblems({ wall: { signIn: { oidc: { clientSecret } } } })
    expect(at("${AGENTX_OIDC_CLIENT_SECRET}")).toEqual([])
    expect(at("GOCSPX-literal")[0]).toContain("wall.signIn.oidc.clientSecret")
  })
})
