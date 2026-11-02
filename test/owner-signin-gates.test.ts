import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { sessionValue } from "../src/daemon/dashboard-session"
import { createCard, decideCard, POPUP_ONLY, readCard } from "../src/approvals/cards"
import { approvals } from "../src/commands/approvals"
import { ENDED_BY_OWNER, PERSON_COOKIE, PersonSessionStore } from "../src/members/person-sessions"
import type { Person } from "../src/people/people"

// #1478: the owner signs in by link. A browser confirmed in the popup on the
// home machine carries full owner rights at every owner gate of
// board-dashboard.ts; a member's or a client's session, an owner browser
// still waiting, or one whose yes came from anywhere else, passes none.

const TOKEN = "dash-secret"
const OFF = { "X-Forwarded-For": "100.64.0.9" }
// A closed port: no daemon answers for the proxied routes.
const CLOSED = "http://127.0.0.1:1"
const home = process.cwd()
let dir: string
let PEOPLE: Person[]

const STORE = { list: () => [], get: () => null, getSource: () => null, save: (wf: unknown) => wf, delete: () => true }
const LAYOUTS = { get: () => null, save: (_id: string, l: unknown) => l, delete: () => {} }
const RUNS = { list: () => [], listRuns: () => [], get: () => null }

/** The people list the dashboard reads again on each request (agentx.json). */
function writePeople(people: Person[]): void {
  PEOPLE = people
  writeFileSync(join(dir, "agentx.json"), JSON.stringify({ node: { id: "node-a", name: "node-a" }, people, dashboard: { daemonUrl: CLOSED } }))
}

beforeAll(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-owner-gates-")))
  dir = process.cwd()
})
afterAll(() => {
  process.chdir(home)
  rmSync(dir, { recursive: true, force: true })
})

let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = undefined
  rmSync(join(dir, ".agentx"), { recursive: true, force: true })
})

async function start(withToken = true): Promise<string> {
  writePeople([
    { id: "anis", name: "Anis M", role: "owner", identities: ["email:anis@example.com"] },
    { id: "dana", name: "Dana K", role: "member", identities: ["email:dana@example.com"] },
    { id: "lee", name: "Lee C", role: "client", identities: ["email:lee@example.com"] },
  ])
  const token = withToken ? TOKEN : undefined
  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, people: PEOPLE, dashboard: { daemonUrl: CLOSED, ...(token ? { token } : {}) } })
  const ctx = { boards: [], sources: new Map(), token, config, workflowStore: STORE, workflowRuns: RUNS, workflowLayouts: LAYOUTS } as unknown as Ctx
  server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A browser signed in by link, waiting on its card, as openSession leaves
 *  it: an owner's card is popup-only unless `popupOnly: false` (a card
 *  written by hand, for the second lock in settle). */
function signedIn(personId: string, opts: { owner?: boolean; popupOnly?: boolean } = {}): { value: string; cardId: string; sessionId: string } {
  const card = createCard(dir, { title: "signed in", ask: "Let them in?", recommend: "Yes if expected.", if_silent: "discard", raised_by: "members" }, { popupOnly: opts.popupOnly ?? !!opts.owner })
  if (!card.ok) throw new Error(card.error)
  const { session, value } = new PersonSessionStore(dir).create(personId, "Chrome", { state: "pending", cardId: card.card.id, ...(opts.owner ? { role: "owner" as const } : {}) })
  return { value, cardId: card.card.id, sessionId: session.id }
}
const yes = (cardId: string, popup: boolean) => decideCard(dir, cardId, "yes", { by: popup ? "operator (popup)" : "Anis (phone app)", popup })

// Every owner gate on main 0985376f, counted again for #1478 (the list is
// in board-dashboard.ts, above ownerCredential).
type Gate = { name: string; method: string; path: string; headers?: Record<string, string>; refused: (r: Response) => boolean }
const status = (s: number) => (r: Response) => r.status === s
const toLogin = (r: Response) => r.status === 302 && (r.headers.get("location") || "").startsWith("/login")
const GATES: Gate[] = [
  { name: "wallOwnerOk: Wall write", method: "POST", path: "/api/admin/wall/post", refused: status(401) },
  { name: "wallOwnerOk: workflow editor", method: "PUT", path: "/api/workflows/wf-1", refused: status(401) },
  { name: "wallOwnerOk: workflow run", method: "POST", path: "/workflows/wf-1/run", refused: status(401) },
  { name: "adminTokenOk: peer proxy", method: "GET", path: "/api/admin/state", headers: { "X-Agentx-Peer": "peer-b" }, refused: status(401) },
  { name: "adminTokenOk: admin API", method: "GET", path: "/api/admin/state", refused: status(401) },
  { name: "adminTokenOk: stream ticket", method: "POST", path: "/api/admin/stream-ticket", refused: status(401) },
  { name: "general /api check", method: "GET", path: "/api/workflows/runs", refused: status(401) },
  { name: "isDashboardOwner: guests", method: "GET", path: "/api/guests", refused: status(401) },
  { name: "pageAllowed: the Hub", method: "GET", path: "/hub", refused: toLogin },
]

function call(base: string, gate: Gate, cookie: string): Promise<Response> {
  return fetch(base + gate.path, {
    method: gate.method, redirect: "manual",
    headers: { ...OFF, ...gate.headers, Cookie: cookie, "X-Requested-With": "agentx-board", "Content-Type": "application/json" },
    body: gate.method === "GET" ? undefined : "{}",
  })
}
async function passesAll(base: string, cookie: string): Promise<void> {
  for (const gate of GATES) expect(gate.refused(await call(base, gate, cookie)), `${gate.name} should let the owner in`).toBe(false)
}
async function refusedAll(base: string, cookie: string): Promise<void> {
  for (const gate of GATES) expect(gate.refused(await call(base, gate, cookie)), `${gate.name} should refuse`).toBe(true)
}
const person = (value: string) => `${PERSON_COOKIE}=${value}`
const hubOwnerView = async (base: string, cookie: string) => (await (await fetch(`${base}/hub`, { headers: { ...OFF, Cookie: cookie } })).text()).includes("window.AX_WALL_SETTINGS = ")

describe("an owner browser signed in by link, with dashboard.token set", () => {
  it("passes no owner gate while it waits, and every one once confirmed in the popup", async () => {
    const base = await start()
    const b = signedIn("anis", { owner: true })
    await refusedAll(base, person(b.value))
    yes(b.cardId, true)
    await passesAll(base, person(b.value))
    expect(await hubOwnerView(base, person(b.value))).toBe(true)
    const ticket = await (await call(base, GATES[5], person(b.value))).json() as { ticket: string }
    expect(ticket.ticket).toMatch(/^\d+\./)
    expect(new PersonSessionStore(dir).sessions("anis")[0]).toMatchObject({ approvedAt: expect.any(String) })
  })

  it("refuses a yes from outside the popup, and the browser keeps waiting", async () => {
    const base = await start()
    const b = signedIn("anis", { owner: true })
    expect(yes(b.cardId, false)).toEqual({ ok: false, error: POPUP_ONLY })
    expect(readCard(dir, b.cardId)?.status).toBe("pending")
    await refusedAll(base, person(b.value))
    expect(new PersonSessionStore(dir).sessions("anis")[0]).toMatchObject({ state: "pending" })
  })

  it("second lock: a yes outside the popup on a card that is not popup-only lets nobody in", async () => {
    const base = await start()
    const b = signedIn("anis", { owner: true, popupOnly: false })
    yes(b.cardId, false)
    await refusedAll(base, person(b.value))
    expect(await hubOwnerView(base, person(b.value))).toBe(false)
    expect(new PersonSessionStore(dir).sessions("anis")[0]).toMatchObject({ state: "pending", offBoxYes: expect.any(String) })
  })

  it("asks again for a second browser: an earlier yes does not carry over", async () => {
    const base = await start()
    const first = signedIn("anis", { owner: true })
    yes(first.cardId, true)
    await passesAll(base, person(first.value))
    const second = signedIn("anis", { owner: true })
    await refusedAll(base, person(second.value))
  })

  it("refuses a member's and a client's session at every gate, even let in", async () => {
    const base = await start()
    for (const id of ["dana", "lee"]) {
      const b = signedIn(id)
      yes(b.cardId, true)
      await refusedAll(base, person(b.value))
      expect(await hubOwnerView(base, person(b.value))).toBe(false)
    }
  })

  it("gives no owner rights to a member's session when the member is made the owner", async () => {
    const base = await start()
    const b = signedIn("dana")
    yes(b.cardId, true)
    writePeople(PEOPLE.map((p) => p.id === "dana" ? { ...p, role: "owner" } : p))
    await refusedAll(base, person(b.value))
  })

  it("ends owner rights at the next request on End access, a role change, or removal", async () => {
    const base = await start()
    const ended = signedIn("anis", { owner: true })
    yes(ended.cardId, true)
    await passesAll(base, person(ended.value))
    new PersonSessionStore(dir).end("anis", ended.sessionId, ENDED_BY_OWNER)
    await refusedAll(base, person(ended.value))

    const demoted = signedIn("anis", { owner: true })
    yes(demoted.cardId, true)
    await passesAll(base, person(demoted.value))
    writePeople(PEOPLE.map((p) => p.id === "anis" ? { ...p, role: "member" } : p))
    await refusedAll(base, person(demoted.value))

    writePeople(PEOPLE.map((p) => p.id === "anis" ? { ...p, role: "owner" } : p))
    await passesAll(base, person(demoted.value))
    writePeople(PEOPLE.filter((p) => p.id !== "anis"))
    await refusedAll(base, person(demoted.value))
  })

  it("does not take the owner's cookie on a request another site started", async () => {
    const base = await start()
    const b = signedIn("anis", { owner: true })
    yes(b.cardId, true)
    const r = await fetch(`${base}/api/admin/state`, { headers: { ...OFF, Cookie: person(b.value), "Sec-Fetch-Site": "cross-site" } })
    expect(r.status).toBe(401)
  })
})

describe("an owner browser with no dashboard.token", () => {
  it("writes on the Wall from off the box once confirmed; a member never does", async () => {
    const base = await start(false)
    const owner = signedIn("anis", { owner: true })
    const wallWrite = GATES[0]
    expect((await call(base, wallWrite, person(owner.value))).status).toBe(401)
    yes(owner.cardId, true)
    expect((await call(base, wallWrite, person(owner.value))).status).not.toBe(401)
    expect((await call(base, GATES[7], person(owner.value))).status).not.toBe(401)
    expect(await hubOwnerView(base, person(owner.value))).toBe(true)
    const member = signedIn("dana")
    yes(member.cardId, true)
    expect((await call(base, wallWrite, person(member.value))).status).toBe(401)
    expect((await call(base, GATES[7], person(member.value))).status).toBe(401)
    expect(await hubOwnerView(base, person(member.value))).toBe(false)
  })
})

describe("owner sign-in cards: a yes only in the popup", () => {
  const decide = (base: string, cardId: string, headers: Record<string, string>, action = "yes") => fetch(`${base}/api/admin/approvals/decide`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board", ...headers },
    body: JSON.stringify({ key: `card:${cardId}`, action }),
  })

  it("the HTTP decide route refuses a yes, even from loopback with the dashboard token", async () => {
    const base = await start()
    const here = signedIn("anis", { owner: true })
    const r = await decide(base, here.cardId, { Authorization: `Bearer ${TOKEN}` })
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe(POPUP_ONLY)
    expect(readCard(dir, here.cardId)?.status).toBe("pending")
    await refusedAll(base, person(here.value))

    const away = signedIn("anis", { owner: true })
    expect((await decide(base, away.cardId, { ...OFF, Cookie: `ax_session=${sessionValue(TOKEN)}` })).status).toBe(409)
    expect(readCard(dir, away.cardId)?.status).toBe("pending")
  })

  it("the HTTP decide route refuses a yes from another confirmed owner browser", async () => {
    const base = await start()
    const first = signedIn("anis", { owner: true })
    yes(first.cardId, true)
    const second = signedIn("anis", { owner: true })
    expect((await decide(base, second.cardId, { ...OFF, Cookie: person(first.value) })).status).toBe(409)
    expect(readCard(dir, second.cardId)?.status).toBe("pending")
    await refusedAll(base, person(second.value))
  })

  it("the HTTP decide route still takes a no", async () => {
    const base = await start()
    const b = signedIn("anis", { owner: true })
    expect((await decide(base, b.cardId, { Authorization: `Bearer ${TOKEN}` }, "no")).status).toBe(200)
    expect(readCard(dir, b.cardId)).toMatchObject({ status: "decided", verdict: "no" })
  })

  it("the CLI refuses a yes, with or without AGENTX_AGENT_ID", async () => {
    await start()
    const saved = process.env.AGENTX_AGENT_ID
    const errors: string[] = []
    const err = console.error
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")) }
    try {
      for (const agent of [undefined, "some-agent"]) {
        if (agent) process.env.AGENTX_AGENT_ID = agent
        else delete process.env.AGENTX_AGENT_ID
        const b = signedIn("anis", { owner: true })
        await approvals.parseAsync(["approve", `card:${b.cardId}`], { from: "user" })
        expect(readCard(dir, b.cardId)?.status).toBe("pending")
        expect(process.exitCode).toBe(1)
        process.exitCode = 0
      }
    } finally {
      console.error = err
      if (saved === undefined) delete process.env.AGENTX_AGENT_ID
      else process.env.AGENTX_AGENT_ID = saved
    }
    expect(errors.filter((e) => e.includes(POPUP_ONLY))).toHaveLength(2)
  })
})
