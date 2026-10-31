import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { sessionValue } from "../src/daemon/dashboard-session"
import { PERSON_COOKIE, PERSON_SESSION_MAX_AGE_S, PersonSessionStore } from "../src/members/person-sessions"
import type { Person } from "../src/people/people"

// #1478 slice 1: personal sessions (ax_person). A person's own sign-in is
// kept apart from the owner's ax_session, so no owner gate takes it.

const PEOPLE: Person[] = [
  { id: "anis", name: "Anis M", role: "owner", identities: [] },
  { id: "dana", name: "Dana K", role: "member", identities: ["email:dana@example.com"] },
  { id: "lee", name: "Lee C", role: "client", identities: ["email:lee@example.com"] },
  { id: "gus", name: "Gus T", role: "guest", identities: ["email:gus@example.com"] },
]

const TOKEN = "dash-secret"
const OFF = { "X-Forwarded-For": "100.64.0.9" }
const home = process.cwd()
let dir: string

beforeAll(() => {
  // The dashboard keeps its stores in the folder it runs in.
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-person-sessions-")))
  dir = process.cwd()
})
afterAll(() => {
  process.chdir(home)
  rmSync(dir, { recursive: true, force: true })
})
afterEach(() => rmSync(join(dir, ".agentx"), { recursive: true, force: true }))

describe("PersonSessionStore", () => {
  it("keeps only the hash of the cookie value, and finds the person by it", () => {
    const store = new PersonSessionStore(dir)
    const { session, value } = store.create("dana", "Chrome on a Mac")
    const file = readFileSync(join(dir, ".agentx/wall-sessions.json"), "utf-8")
    expect(file).not.toContain(value)
    expect(file).toContain(session.hash)
    expect(store.verify(value, PEOPLE)?.person.id).toBe("dana")
    expect(store.verify(value + "x", PEOPLE)).toBeNull()
    expect(store.verify("", PEOPLE)).toBeNull()
  })

  it("stops working once the person is off the list, or is a guest", () => {
    const store = new PersonSessionStore(dir)
    const dana = store.create("dana", "Firefox").value
    const gus = store.create("gus", "Safari").value
    expect(store.verify(dana, PEOPLE.filter((p) => p.id !== "dana"))).toBeNull()
    expect(store.verify(gus, PEOPLE)).toBeNull()
  })

  it("ends one session at once and leaves the person's other one", () => {
    const store = new PersonSessionStore(dir)
    const a = store.create("dana", "Chrome on a Mac")
    const b = store.create("dana", "Safari on an iPhone")
    expect(store.end("lee", a.session.id, "x")).toBeNull()
    expect(store.end("dana", a.session.id, "ended by the owner (dashboard)")?.endedReason).toBe("ended by the owner (dashboard)")
    expect(store.end("dana", a.session.id, "again")).toBeNull()
    expect(store.verify(a.value, PEOPLE)).toBeNull()
    expect(store.verify(b.value, PEOPLE)?.person.id).toBe("dana")
  })

  it("expires after 30 days, and lists it as expired", () => {
    let now = Date.parse("2026-11-01T10:00:00Z")
    const store = new PersonSessionStore(dir, () => now)
    const { value } = store.create("dana", "Chrome")
    now += PERSON_SESSION_MAX_AGE_S * 1000 - 1
    expect(store.verify(value, PEOPLE)).not.toBeNull()
    now += 1
    expect(store.verify(value, PEOPLE)).toBeNull()
    expect(store.sessions("dana")[0]).toMatchObject({ endedReason: "expired", endedAt: "2026-12-01T10:00:00.000Z" })
  })

  it("writes the last use at most once a minute", () => {
    let now = Date.parse("2026-11-01T10:00:00Z")
    const store = new PersonSessionStore(dir, () => now)
    const { value } = store.create("dana", "Chrome")
    now += 30_000
    store.verify(value, PEOPLE)
    expect(store.sessions("dana")[0].lastUsedAt).toBe("2026-11-01T10:00:00.000Z")
    now += 30_000
    store.verify(value, PEOPLE)
    expect(store.sessions("dana")[0].lastUsedAt).toBe("2026-11-01T10:01:00.000Z")
  })
})

describe("the dashboard with personal sessions", () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  })

  async function start(withToken = true): Promise<string> {
    const token = withToken ? TOKEN : undefined
    const config = daemonConfigSchema.parse({
      node: { id: "node-a", name: "node-a" }, people: PEOPLE,
      dashboard: { daemonUrl: "http://daemon.invalid:18800", ...(token ? { token } : {}) },
    })
    const ctx = { boards: [], sources: new Map(), token, config } as unknown as Ctx
    server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  // Every owner gate on 2026-10-31 main (ff002dde): the Wall write guard
  // and the workflow editor guard (wallOwnerOk), the peer proxy and the
  // admin API (adminTokenOk), the general /api check, and pageAllowed.
  const GATES: [string, string, Record<string, string>?][] = [
    ["POST", "/api/admin/wall/post"],
    ["PUT", "/api/workflows/wf-1"],
    ["GET", "/api/admin/state", { "X-Agentx-Peer": "peer-b" }],
    ["GET", "/api/admin/state"],
    ["GET", "/api/workflows/runs"],
  ]

  async function call(base: string, [method, path, extra]: (typeof GATES)[number], cookie: string) {
    return fetch(base + path, { method, redirect: "manual", headers: { ...OFF, ...extra, Cookie: cookie, "X-Requested-With": "agentx-board" }, body: method === "GET" ? undefined : "{}" })
  }

  for (const id of ["dana", "lee", "anis"]) {
    it(`refuses a live ${id} session at every owner gate, with dashboard.token set`, async () => {
      const base = await start()
      const { value } = new PersonSessionStore(dir).create(id, "Chrome")
      const cookie = `${PERSON_COOKIE}=${value}`
      for (const gate of GATES) expect((await call(base, gate, cookie)).status, gate.join(" ")).toBe(401)
      const hub = await fetch(base + "/hub", { headers: { ...OFF, Cookie: cookie }, redirect: "manual" })
      expect(hub.status).toBe(302)
      expect(hub.headers.get("location")).toBe("/login?next=%2Fhub")
    })
  }

  it("lets the owner's ax_session through the same gates, so the refusals above are the cookie's", async () => {
    const base = await start()
    const cookie = `ax_session=${sessionValue(TOKEN)}`
    for (const gate of GATES) expect((await call(base, gate, cookie)).status, gate.join(" ")).not.toBe(401)
  })

  it("refuses a personal session's Wall write off the box with no dashboard.token", async () => {
    const base = await start(false)
    const { value } = new PersonSessionStore(dir).create("dana", "Chrome")
    expect((await call(base, GATES[0], `${PERSON_COOKIE}=${value}`)).status).toBe(401)
  })

  it("shows a person's signed-in browsers on People, without the hash, and ends one", async () => {
    const base = await start(false)
    const store = new PersonSessionStore(dir)
    const a = store.create("dana", "Chrome on a Mac")
    const b = store.create("dana", "Safari on an iPhone")
    const one = await (await fetch(`${base}/api/admin/people/dana`)).json() as any
    expect(one.sessions.map((s: any) => s.label).sort()).toEqual(["Chrome on a Mac", "Safari on an iPhone"])
    expect(JSON.stringify(one.sessions)).not.toContain(a.session.hash)

    const end = (id: string, person = "dana") => fetch(`${base}/api/admin/people/${person}/sessions/${id}/end`, { method: "POST", headers: { "X-Requested-With": "agentx-board" }, body: "{}" })
    expect((await end(a.session.id, "lee")).status).toBe(404)
    const r = await end(a.session.id)
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).session.endedReason).toBe("ended by the owner (dashboard)")
    expect((await end(a.session.id)).status).toBe(404)
    expect(store.verify(a.value, PEOPLE)).toBeNull()
    expect(store.verify(b.value, PEOPLE)?.person.id).toBe("dana")
  })

  it("needs the owner to end a session: a personal session cannot end one", async () => {
    const base = await start()
    const { session, value } = new PersonSessionStore(dir).create("dana", "Chrome")
    const r = await fetch(`${base}/api/admin/people/dana/sessions/${session.id}/end`, {
      method: "POST", headers: { ...OFF, Cookie: `${PERSON_COOKIE}=${value}`, "X-Requested-With": "agentx-board" }, body: "{}",
    })
    expect(r.status).toBe(401)
  })
})
