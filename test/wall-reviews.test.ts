import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { handleWallReviews, WALL_REVIEWS_PATH } from "../src/daemon/wall-reviews"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_REVIEWS_SCRIPT } from "../src/daemon/ui/pages/wall-reviews.client"

// The Wall's review queue (#1182): graph classifications that went to
// review, with the decision, its reason and the taxonomy an approval
// added. Read straight from the graph's files; driven both directly and
// through the dashboard's own request handler.

const home = process.cwd()
let graphDir: string
let server: Server
let base: string
let token: string | undefined
const T = (min: number) => new Date(Date.UTC(2026, 9, 20, 9, min)).toISOString()

const row = (o: Record<string, unknown>) => ({
  agentId: "coder", channel: "telegram", proposedAxes: {}, leaf: {}, source: "llm", status: "pending", ...o,
})
function log(dir: string, rows: Record<string, unknown>[]) {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, "classifications.jsonl"), rows.map((r) => JSON.stringify(row(r))).join("\n") + "\n")
}
const reviews = (dir: string, q: Record<string, string> = {}) =>
  handleWallReviews(new URLSearchParams(q), { baseDir: dir, enabled: true }, "node-a", Date.now())

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(base + path, { method: "GET", headers }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    r.on("error", reject)
    r.end()
  })
}

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-reviews-")))
  writeFileSync("agentx.json", JSON.stringify({ agents: { coder: { name: "Coder" } } }))
  graphDir = join(process.cwd(), ".agentx/graph")
  // One existing node, then the node an approval added after its proposal.
  mkdirSync(graphDir, { recursive: true })
  writeFileSync(join(graphDir, "nodes.json"), JSON.stringify({ version: 1, nodes: [
    { id: "work", level: "category", parentId: null, axes: { name: "Work" }, createdAt: T(0) },
    { id: "work.invoice", level: "verb", parentId: "work", axes: { name: "Invoice", kind: "task" }, createdAt: T(12), createdBy: "reviewer" },
  ] }))
  log(graphDir, [
    // a1: pending, then approved by the review agent with a reason.
    { ts: T(10), msgHash: "a1", path: ["work", "work.invoice"], proposedAxes: { "work.invoice": { name: "Invoice", kind: "task" } }, confidence: 0.62, preview: "Send the invoice to the demo shop" },
    // p1: still pending.
    { ts: T(20), msgHash: "p1", path: ["work", "work.refund"], proposedAxes: { "work.refund": { name: "Refund" } }, confidence: 0.41, preview: "Refund order 12, token=supersecretvalue123" },
    // r1: pending, then rejected with a reason.
    { ts: T(30), msgHash: "r1", path: ["work", "work.lunch"], proposedAxes: { "work.lunch": { name: "Lunch" } }, confidence: 0.3, preview: "What is for lunch?" },
    // c1: the classifier approved it itself: never went to review.
    { ts: T(40), msgHash: "c1", path: ["work"], status: "approved", source: "cache", preview: "hello" },
    { ts: T(13), msgHash: "a1", path: ["work", "work.invoice"], proposedAxes: { "work.invoice": { name: "Invoice", kind: "task" } }, confidence: 0.62, status: "approved",
      preview: "Send the invoice to the demo shop · reviewer=reviewer · The wiki has an invoicing page for this client." },
    { ts: T(35), msgHash: "r1", path: ["work", "work.lunch"], proposedAxes: { "work.lunch": { name: "Lunch" } }, confidence: 0.3, status: "rejected",
      preview: "What is for lunch? · reviewer=reviewer · Small talk, not a work intent." },
  ])

  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, agents: { coder: { name: "Coder", workspace: process.cwd() } }, graph: { enabled: true } })
  server = createServer((req, res) => {
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), token, config } as unknown as Ctx)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  process.chdir(home)
})

describe("empty queue", () => {
  it("answers an empty queue when the graph has no files, and creates none", () => {
    const dir = join(process.cwd(), "no-graph-here")
    const body = reviews(dir).body as any
    expect(body.reviews).toEqual([])
    expect(body.counts).toEqual({ pending: 0, approved: 0, rejected: 0, autoApproved: 0 })
    expect(existsSync(dir)).toBe(false)
  })

  it("leaves classifications the classifier approved itself out of the queue", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-wall-reviews-auto-"))
    log(dir, [{ ts: T(1), msgHash: "x", path: ["work"], status: "approved" }])
    const body = reviews(dir).body as any
    expect(body.reviews).toEqual([])
    expect(body.counts.autoApproved).toBe(1)
  })

  it("answers an empty queue with no graph configured", () => {
    const body = handleWallReviews(new URLSearchParams(), { baseDir: null, enabled: false }, "n", 0).body as any
    expect(body).toMatchObject({ enabled: false, reviews: [] })
  })
})

describe("a pending item", () => {
  it("shows the path, the proposed axes and the confidence, with no decision", () => {
    const body = reviews(graphDir, { status: "pending" }).body as any
    expect(body.reviews).toHaveLength(1)
    const p = body.reviews[0]
    expect(p).toMatchObject({
      id: "p1", status: "pending", path: ["work", "work.refund"], proposedAxes: { "work.refund": { name: "Refund" } },
      confidence: 0.41, source: "llm", decision: null, taxonomy: [],
    })
    expect(p.message).toContain("[redacted]")
    expect(p.message).not.toContain("supersecretvalue123")
  })
})

describe("decided items", () => {
  it("shows an approval with the reviewer, its reason and the taxonomy diff", () => {
    const a = (reviews(graphDir).body as any).reviews.find((r: any) => r.id === "a1")
    expect(a.status).toBe("approved")
    expect(a.decision).toMatchObject({ verdict: "approved", by: "reviewer", reason: "The wiki has an invoicing page for this client." })
    expect(a.message).toBe("Send the invoice to the demo shop")
    expect(a.taxonomy).toEqual([
      { op: "keep", id: "work", level: "category", parentId: null, axes: { name: "Work" } },
      { op: "add", id: "work.invoice", level: "verb", parentId: "work", axes: { name: "Invoice", kind: "task" } },
    ])
    // The wiki search for the path: node names, root first.
    expect(a.wikiQuery).toBe("Work Invoice")
  })

  it("names a pending item's wiki search from its proposed axes when the node is not there yet", () => {
    const p = (reviews(graphDir, { status: "pending" }).body as any).reviews[0]
    expect(p.wikiQuery).toBe("Work Refund")
  })

  it("shows a rejection with its reason and no diff", () => {
    const r = (reviews(graphDir, { status: "decided" }).body as any).reviews.find((x: any) => x.id === "r1")
    expect(r.decision).toMatchObject({ verdict: "rejected", by: "reviewer", reason: "Small talk, not a work intent." })
    expect(r.taxonomy).toEqual([])
  })

  it("counts every status and keeps the newest decision first", () => {
    const body = reviews(graphDir).body as any
    expect(body.counts).toEqual({ pending: 1, approved: 1, rejected: 1, autoApproved: 1 })
    expect(body.reviews.map((r: any) => r.id)).toEqual(["r1", "p1", "a1"])
  })

  it("marks a node an approval named that is no longer in nodes.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-wall-reviews-gone-"))
    log(dir, [
      { ts: T(1), msgHash: "g", path: ["gone"], proposedAxes: { gone: { name: "Gone" } } },
      { ts: T(2), msgHash: "g", path: ["gone"], proposedAxes: { gone: { name: "Gone" } }, status: "approved" },
    ])
    const g = (reviews(dir).body as any).reviews[0]
    expect(g.decision).toMatchObject({ verdict: "approved", by: null, reason: null })
    expect(g.taxonomy).toEqual([{ op: "missing", id: "gone", level: null, parentId: null, axes: { name: "Gone" } }])
  })
})

describe("thread by classification id", () => {
  it("lists the classification's own rows, oldest first", () => {
    const body = reviews(graphDir, { id: "a1" }).body as any
    expect(body.review.id).toBe("a1")
    expect(body.events.map((e: any) => [e.status, e.who])).toEqual([["pending", "coder"], ["approved", "reviewer"]])
    expect(body.events[0].text).toBe("Proposed work › work.invoice (llm, confidence 0.62)")
    expect(body.events[1].text).toBe("Approved: The wiki has an invoicing page for this client.")
  })

  it("answers 404 for an unknown id or one that never went to review", () => {
    expect(reviews(graphDir, { id: "nope" }).status).toBe(404)
    expect(reviews(graphDir, { id: "c1" }).status).toBe(404)
  })
})

describe("route and page", () => {
  it("serves the queue from the dashboard, behind the dashboard token", async () => {
    const list = JSON.parse((await get(WALL_REVIEWS_PATH)).body)
    expect(list).toMatchObject({ node: "node-a", enabled: true })
    expect(list.reviews.map((r: any) => r.id).sort()).toEqual(["a1", "p1", "r1"])
    expect(JSON.parse((await get(`${WALL_REVIEWS_PATH}?id=r1`)).body).events).toHaveLength(2)
    token = "tok-123"
    try {
      expect((await get(WALL_REVIEWS_PATH)).status).toBe(401)
      expect((await get(WALL_REVIEWS_PATH, { Authorization: "Bearer tok-123" })).status).toBe(200)
    } finally {
      token = undefined
    }
  })

  it("only reads: the graph's files are unchanged after every call", async () => {
    const snap = () => readdirSync(graphDir).sort().map((f) => `${f}:${readFileSync(join(graphDir, f), "utf-8")}`).join("\n")
    const before = snap()
    await get(WALL_REVIEWS_PATH)
    await get(`${WALL_REVIEWS_PATH}?id=a1`)
    expect(snap()).toBe(before)
  })

  it("puts Reviews in the Wall's views, decided under the Wall's guarded route (#1440, #1454)", () => {
    const html = renderWallPage()
    expect(html).toContain('data-nav="reviews"')
    expect(html).toContain('id="wall-reviews"')
    expect(html).toContain("/api/admin/wall/reviews")
    expect(html).toContain("/admin/wiki/search?q=")
    expect(WALL_REVIEWS_SCRIPT).toContain("'/api/admin/wall/review/' + verdict")
    expect(WALL_REVIEWS_SCRIPT).toContain('data-rdecide="approve"')
    expect(WALL_REVIEWS_SCRIPT).toContain('data-rdecide="reject"')
    // Its one write is that decision: nothing else is sent.
    expect(WALL_REVIEWS_SCRIPT.match(/method: '(POST|PUT|PATCH|DELETE)'/g)).toEqual(["method: 'POST'"])
  })
})
