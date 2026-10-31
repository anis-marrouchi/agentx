import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { isOffBox, pageToken, sessionValue } from "../src/daemon/dashboard-session"

// #1306: dashboard pages put dashboard.token in window.AX_LOCAL_TOKEN. Only a
// caller on this machine may get it. The test server listens on loopback, so
// an off-box caller is a request a proxy forwarded (X-Forwarded-For), which
// the dashboard treats the same as a non-loopback socket.

const TOKEN = "dash-secret"
const OFF = { "X-Forwarded-For": "100.64.0.9" }
const PAGES = ["/hub", "/admin", "/admin/graph", "/admin/agents/ops", "/admin/health", "/admin/ledger"]

let server: Server | undefined

async function start(withToken = true): Promise<string> {
  const token = withToken ? TOKEN : undefined
  const config = daemonConfigSchema.parse({
    node: { id: "node-a", name: "node-a" },
    dashboard: { daemonUrl: "http://daemon.invalid:18800", ...(token ? { token } : {}) },
  })
  const ctx = { boards: [], sources: new Map(), token, config } as unknown as Ctx
  server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = undefined
})

async function signIn(base: string, token: string, next = "/admin"): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST", redirect: "manual", headers: { ...OFF, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, next }).toString(),
  })
}

describe("dashboard pages off-box (#1306)", () => {
  it("sends an off-box caller with no session to /login, with no token in the reply", async () => {
    const base = await start()
    for (const page of [...PAGES, "/"]) {
      const r = await fetch(base + page, { headers: OFF, redirect: "manual" })
      const body = await r.text()
      expect(r.status, page).toBe(302)
      expect(body).not.toContain(TOKEN)
      expect(body).not.toContain("AX_LOCAL_TOKEN")
    }
    const r = await fetch(base + "/admin", { headers: OFF, redirect: "manual" })
    expect(r.headers.get("location")).toBe("/login?next=%2Fadmin")
    // /people moved to the Wall (#1441): off-box it still signs in first.
    const people = await fetch(base + "/people", { headers: OFF, redirect: "manual" })
    expect(people.headers.get("location")).toBe("/login?next=%2Fpeople")
    // /approvals moved to Needs you (#1440): off-box it signs in with Needs you as next.
    const approvals = await fetch(base + "/approvals", { headers: OFF, redirect: "manual" })
    expect(approvals.headers.get("location")).toBe("/login?next=" + encodeURIComponent("/hub#status=open&view=decide"))
  })

  it("refuses off-box /api/admin/* without a token or session", async () => {
    const base = await start()
    expect((await fetch(`${base}/api/admin/state`, { headers: OFF })).status).toBe(401)
    expect((await fetch(`${base}/api/admin/people`, { headers: OFF })).status).toBe(401)
    const wrong = { ...OFF, Cookie: "ax_session=" + sessionValue("not-the-token") }
    expect((await fetch(`${base}/api/admin/state`, { headers: wrong })).status).toBe(401)
  })

  it("signs a browser in with the token: an HttpOnly, SameSite=Strict cookie that is not the token", async () => {
    const base = await start()
    const bad = await signIn(base, "guess")
    expect(bad.status).toBe(401)
    expect(bad.headers.get("set-cookie")).toBeNull()

    const ok = await signIn(base, TOKEN)
    expect(ok.status).toBe(303)
    expect(ok.headers.get("location")).toBe("/admin")
    const set = ok.headers.get("set-cookie") || ""
    expect(set).toMatch(/^ax_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/)
    expect(set).not.toContain(TOKEN)
  })

  it("serves a signed-in off-box browser its pages without the token, and the admin API answers it", async () => {
    const base = await start()
    const cookie = ((await signIn(base, TOKEN)).headers.get("set-cookie") || "").split(";")[0]
    const headers = { ...OFF, Cookie: cookie }
    for (const page of PAGES) {
      const r = await fetch(base + page, { headers, redirect: "manual" })
      const body = await r.text()
      expect(r.status, page).toBe(200)
      expect(body, page).not.toContain(TOKEN)
      expect(body, page).not.toContain("window.AX_LOCAL_TOKEN =")
    }
    expect((await fetch(`${base}/api/admin/people`, { headers })).status).toBe(200)
  })

  it("brings a chat task link back to its Wall Task page after sign-in (#1447)", async () => {
    const base = await start()
    const r = await fetch(`${base}/tasks/t1?agent=ops`, { headers: OFF, redirect: "manual" })
    expect(r.status).toBe(302)
    const login = new URL(r.headers.get("location") || "", base)
    expect(login.pathname).toBe("/login")
    const next = login.searchParams.get("next") || ""
    expect(next).toMatch(/^\/#page=task&task=t1&agent=ops&node=/)
    // The form carries it, and signing in lands on the task, not the bare Wall.
    expect(await (await fetch(base + login.pathname + login.search, { headers: OFF })).text()).toContain(`value="${next.replace(/&/g, "&#38;")}"`)
    expect((await signIn(base, TOKEN, next)).headers.get("location")).toBe(next)
    // Signed in, the link goes straight to the Wall.
    const cookie = ((await signIn(base, TOKEN)).headers.get("set-cookie") || "").split(";")[0]
    const direct = await fetch(`${base}/tasks/t1?agent=ops`, { headers: { ...OFF, Cookie: cookie }, redirect: "manual" })
    expect(direct.headers.get("location")).toBe(next)
  })

  it("brings an agent history link back to its Wall Activity tab after sign-in (#1447)", async () => {
    const base = await start()
    const r = await fetch(`${base}/agents/ops/history`, { headers: OFF, redirect: "manual" })
    expect(r.status).toBe(302)
    const login = new URL(r.headers.get("location") || "", base)
    expect(login.pathname).toBe("/login")
    const next = login.searchParams.get("next") || ""
    expect(next).toBe("/hub#page=activity&a-agent=ops&a-period=30d")
    expect((await signIn(base, TOKEN, next)).headers.get("location")).toBe(next)
  })

  it("only sends a sign-in back to a path on this server", async () => {
    const base = await start()
    for (const next of ["//evil.example/x", "https://evil.example/", "/\\evil.example"]) {
      expect((await signIn(base, TOKEN, next)).headers.get("location")).toBe("/")
    }
    const page = await (await fetch(`${base}/login?next=%22%3E%3Cscript%3E`, { headers: OFF })).text()
    expect(page).not.toContain("<script>")
  })

  it("keeps loopback unchanged: the page carries the token and needs no sign-in", async () => {
    const base = await start()
    for (const page of PAGES) {
      const r = await fetch(base + page, { redirect: "manual" })
      expect(r.status, page).toBe(200)
      expect(await r.text(), page).toContain(`window.AX_LOCAL_TOKEN = "${TOKEN}"`)
    }
  })

  // #1608 follow-up: these pages render the ask-an-agent drawer, whose
  // /api/assistant calls are the owner's. On this machine the page carries
  // the token for them; off the box it never does.
  it("gives the drawer pages the token on this machine, never off the box", async () => {
    const base = await start()
    for (const page of ["/mesh", "/monitor", "/workflows", "/admin/projects", "/guests"]) {
      const local = await (await fetch(base + page, { redirect: "manual" })).text()
      expect(local, page).toContain('id="ax-as-dock"')
      expect(local, page).toContain(`window.AX_LOCAL_TOKEN = "${TOKEN}"`)
      const off = await (await fetch(base + page, { headers: OFF, redirect: "manual" })).text()
      expect(off, page).not.toContain(TOKEN)
    }
    // Setup comes before any agent: no drawer to feed.
    const setup = await (await fetch(base + "/setup", { redirect: "manual" })).text()
    expect(setup).not.toContain('id="ax-as-dock"')
    expect(setup).not.toContain(TOKEN)
  })

  it("changes nothing when no dashboard.token is set", async () => {
    const base = await start(false)
    expect((await fetch(`${base}/admin`, { headers: OFF, redirect: "manual" })).status).toBe(200)
    expect((await fetch(`${base}/login`, { redirect: "manual" })).headers.get("location")).toBe("/")
  })
})

describe("isOffBox / pageToken", () => {
  const req = (remoteAddress: string, headers: Record<string, string> = {}) =>
    ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage

  it("treats a non-loopback socket or a forwarded request as off-box", () => {
    expect(isOffBox(req("127.0.0.1"))).toBe(false)
    expect(isOffBox(req("::1"))).toBe(false)
    expect(isOffBox(req("100.64.0.9"))).toBe(true)
    expect(isOffBox(req("127.0.0.1", { "x-forwarded-for": "100.64.0.9" }))).toBe(true)
    expect(isOffBox(req("127.0.0.1", { forwarded: "for=100.64.0.9" }))).toBe(true)
  })

  it("gives the token to loopback callers only", () => {
    expect(pageToken(req("127.0.0.1"), TOKEN)).toBe(TOKEN)
    expect(pageToken(req("100.64.0.9"), TOKEN)).toBeUndefined()
    expect(pageToken(req("127.0.0.1"), undefined)).toBeUndefined()
  })
})
