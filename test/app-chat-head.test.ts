import { describe, expect, it } from "vitest"
import type { IncomingMessage, ServerResponse } from "http"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { APP_CHAT_HEAD_CSS, APP_CHAT_HEAD_SCRIPT } from "../src/daemon/ui/pages/app-chat-head.client"
import { appPlanHtml, appProofsHtml } from "../src/daemon/ui/pages/app-chat-plan"
import { APP_REQUESTS_PATH, appRequestsFor, handleAppRequests } from "../src/daemon/app-requests"
import { buildPicker } from "../src/daemon/app-chat"

// The phone Chat tab in the Hub chat header's look (#2101 phone C1): a quiet
// header with the agent and its engine, Chat · Plan · Proofs, the desktop
// ask box; the orb and voice controls stay.

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

const cards = [
  { id: "r1", agentId: "coder", summary: "Fix the login", state: "open", plan: { steps: [
    { idx: 1, name: "Build", agentId: "coder", state: "done", evidence: "https://example.com/pull/1" },
    { idx: 2, name: "Deploy", agentId: "devops", state: "active", evidence: null },
  ] } },
  { id: "r2", agentId: "pm", summary: "Review <b>", state: "open", plan: { steps: [{ idx: 1, name: "Check", agentId: "coder", state: "pending" }] } },
  { id: "r3", agentId: "nadia", summary: "Post", state: "open", plan: null },
]

describe("appRequestsFor", () => {
  it("keeps the requests the agent has or has a step in, with their steps", () => {
    const out = appRequestsFor(cards, "coder")
    expect(out.map((r) => r.id)).toEqual(["r1", "r2"])
    expect(out[0].steps[0]).toEqual({ idx: 1, name: "Build", agentId: "coder", state: "done", evidence: "https://example.com/pull/1" })
    expect(appRequestsFor(cards, "nadia").map((r) => r.id)).toEqual(["r3"])
    expect(appRequestsFor(cards, "nobody")).toEqual([])
  })
})

describe("GET /api/app/requests", () => {
  function call(url: string, method = "GET", list: () => Promise<unknown[]> = async () => cards) {
    const out: { status?: number; body?: any } = {}
    const res = { writeHead(s: number) { out.status = s; return res }, end(b: string) { out.body = JSON.parse(b) } } as unknown as ServerResponse
    return handleAppRequests({ url } as IncomingMessage, res, url.split("?")[0], method, { cards: list }).then((handled) => ({ handled, ...out }))
  }

  it("answers with the agent's requests", async () => {
    const r = await call(APP_REQUESTS_PATH + "?agent=coder")
    expect(r.status).toBe(200)
    expect(r.body.items.map((x: { id: string }) => x.id)).toEqual(["r1", "r2"])
  })
  it("refuses a missing or odd agent id, and any method but GET", async () => {
    expect((await call(APP_REQUESTS_PATH)).status).toBe(400)
    expect((await call(APP_REQUESTS_PATH + "?agent=a%20b")).status).toBe(400)
    expect((await call(APP_REQUESTS_PATH + "?agent=coder", "POST")).status).toBe(405)
  })
  it("says so when the requests can't be read", async () => {
    const r = await call(APP_REQUESTS_PATH + "?agent=coder", "GET", async () => { throw new Error("db locked") })
    expect(r.status).toBe(503)
    expect(r.body.error).toContain("db locked")
  })
  it("leaves other paths alone", async () => {
    expect((await call("/api/app/agents")).handled).toBe(false)
  })
})

describe("Plan and Proofs", () => {
  const items = appRequestsFor(cards, "coder")
  it("Plan numbers each request's steps, marks done and active, and escapes", () => {
    const h = appPlanHtml(items, "Coder", esc)
    expect(h).toContain("<h3>Fix the login</h3>")
    expect(h).toContain('<li class="is-done"><span class="chp-no">✓</span><span><b>Build</b><small>coder · done</small>')
    expect(h).toContain('<li class="is-active"><span class="chp-no">2</span>')
    expect(h).toContain("Review &lt;b&gt;")
    expect(appPlanHtml([], "Coder", esc)).toContain("Coder has no plan on an open request.")
  })
  it("Proofs lists only done steps, with the proof as a link", () => {
    const h = appProofsHtml(items, "Coder", esc)
    expect(h).toContain('<a href="https://example.com/pull/1" target="_blank" rel="noopener">')
    expect(h).not.toContain("Deploy")
    expect(appProofsHtml([{ id: "x", steps: [{ idx: 1, name: "A", state: "done", evidence: "javascript:alert(1)" }] }], "C", esc)).not.toContain("<a ")
    expect(appProofsHtml([], "Coder", esc)).toContain("No step of Coder")
  })
})

describe("the header on the page", () => {
  const html = renderAppPage()
  it("ships the face, engine and Plan helpers before the header script", () => {
    for (const fn of ["function chFace", "function chEngine", "function appPlanHtml", "function appProofsHtml"]) {
      expect(html.indexOf(fn)).toBeGreaterThan(-1)
      expect(html.indexOf(fn)).toBeLessThan(html.indexOf("window.AXChatHead ="))
    }
  })
  it("has the tabs Chat · Plan · Proofs and moves History and New into the header", () => {
    for (const t of ["chat", "plan", "proofs"]) expect(APP_CHAT_HEAD_SCRIPT).toContain(`data-ch-tab="${t}"`)
    expect(APP_CHAT_HEAD_SCRIPT).toContain("['cx-history-btn', 'cx-new']")
    expect(APP_CHAT_HEAD_SCRIPT).toContain("/api/app/requests?agent=")
  })
  it("keeps the orb and its controls, only in the desktop sizes", () => {
    expect(html).toContain('class="vx-orb"')
    expect(APP_CHAT_HEAD_CSS).toContain(".vx-side { width: 40px; height: 40px; border-radius: 10px;")
    expect(APP_CHAT_HEAD_CSS).not.toMatch(/\.vx-orb[^{]*\{[^}]*display:\s*none/)
  })
  it("holds no backslash, backtick or dollar-brace", () => {
    expect(APP_CHAT_HEAD_SCRIPT).not.toContain("\\")
    expect(APP_CHAT_HEAD_SCRIPT).not.toContain("`")
    expect(APP_CHAT_HEAD_SCRIPT).not.toContain("${")
  })
})

describe("the picker carries each agent's engine", () => {
  it("adds tier when the snapshot has it", () => {
    const out = buildPicker([{ id: "n", name: "Mac", url: "http://d", reachable: true, agents: [{ id: "coder", name: "Coder", tier: "claude-code", active: 0, errors: 0 }] }] as any, { url: "http://d", name: "Mac" } as any, [])
    expect(out[0].agents[0].tier).toBe("claude-code")
  })
})
