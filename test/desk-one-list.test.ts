import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { createServer, type Server } from "http"
import { Readable } from "stream"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { createCard } from "../src/approvals/cards"
import { decide, type InboxContext } from "../src/approvals/inbox"
import { runApprovalsSweep, type ApprovalSettings } from "../src/approvals/sweep"
import { nextCardToPop, nextRequestToPop } from "../src/approvals/popup-runner"
import { handleApprovalsPanelApi } from "../src/daemon/approvals-panel"
import { handleAppDesk } from "../src/daemon/app-desk"
import { daemonConfigSchema } from "../src/daemon/config"
import { buildDesk, type DeskCard } from "../src/desk/board"
import { readOwnerList } from "../src/desk/owner-list"
import { deskRoutedPath, deskRouting, reaches, routeDesk, type DeskRouting } from "../src/desk/route"
import { RequestStore } from "../src/requests/store"

// One Desk (#1138 step C). What must hold:
//   - the dashboard's Approvals API, the phone app's Desk API and the digest
//     show the same open item, in the same shape, with one count
//   - put-off items are counted apart ("later") everywhere, never as waiting
//   - notifications.desk.phone / .computer and approvals.digest are the
//     three settings; changing one changes where the next item goes, with
//     no code change
// Names and texts here are invented.

const NOW = Date.parse("2026-09-26T08:00:00.000Z")
const HOUR = 3_600_000
const NODE = { url: "http://studio:18800", name: "studio" }

let root: string
let configPath: string
let requests: RequestStore

const ctx = (now = NOW): InboxContext => ({ root, configPath, reload: false, now, requests })

function writeConfig(extra: Record<string, unknown> = {}) {
  writeFileSync(configPath, JSON.stringify({
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: { alpha: { name: "Alpha", workspace: "./agents/alpha", tier: "claude-code" } },
    ...extra,
  }, null, 2))
}

function card(extra: Record<string, unknown> = {}) {
  return { title: "Publish the launch post", ask: "Publish the draft on Monday?", recommend: "Yes", if_silent: "discard", raised_by: "alpha", ...extra }
}

/** Two cards (one urgent), one put off, and a request whose agent asked a question. */
function seed() {
  const a = createCard(root, card({ title: "Merge the release PR", expires: "5h" }), { now: NOW - HOUR })
  const b = createCard(root, card({ title: "Send the invoice", expires: "3d" }), { now: NOW - 2 * HOUR })
  const c = createCard(root, card({ title: "Rename the folder" }), { now: NOW - 3 * HOUR })
  if (!a.ok || !b.ok || !c.ok) throw new Error("card not created")
  requests.addCandidate({ id: "req-1", runId: "run-1", channel: "telegram", chatId: "c1", agentId: "alpha", text: "book the venue", now: NOW - 4 * HOUR })
  requests.waitOnOwner("req-1", "Which date: the 3rd or the 10th?", NOW - 30 * 60_000)
  return { urgent: a.card, later: b.card, plain: c.card }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desk-one-"))
  configPath = join(root, "agentx.json")
  writeConfig()
  requests = new RequestStore(new Database(":memory:"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe("one list, one count", () => {
  let server: Server
  let base: string
  beforeEach(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost")
      const handled = await handleApprovalsPanelApi(req, res, url.pathname, url, { ctx: ctx(), node: NODE })
      if (!handled) { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())) })

  it("shows the same item, in the same shape, with the same count on the dashboard, the phone app and the digest", async () => {
    const { later } = seed()
    const off = await decide(ctx(), `card:${later.id}`, "later", { laterHours: 24 })
    expect(off.ok).toBe(true)

    // The dashboard's Approvals API.
    const dash = await (await fetch(`${base}/api/admin/approvals`)).json() as any
    // The phone app's Desk API, as the dashboard serves it (board-dashboard.ts appDeskDeps).
    const app = await appDesk()
    // The digest.
    const sendDigest = vi.fn(async (_d: unknown, _t: string) => {})
    const settings: ApprovalSettings = { defaultExpiryDays: 3, maxExpiryDays: 30, laterHours: 24, notifyAgent: true, digest: { enabled: true, time: "07:00", timezone: "UTC" } }
    const r = await runApprovalsSweep({ ctx: ctx(), settings, sendDigest, fallbackDestination: { channel: "push", chatId: "default" }, node: NODE, log: () => {} })
    expect(r.digest).toBe("sent")
    const digest = sendDigest.mock.calls[0][1]

    // Two cards and the request's question wait; the put-off card is apart.
    expect(dash.desk.count).toBe(3)
    expect(dash.desk.later).toBe(1)
    const yours = app.cards.filter((c: DeskCard) => c.column === "yours")
    expect(app.figures.yours.count).toBe(3)
    expect(app.figures.yours.later).toBe(1)
    expect(digest).toMatch(/^3 waiting for you on the Desk \(and 1 you put off for later\)\./)

    // The same items, the same shape, in the same order.
    expect(yours).toEqual(dash.desk.items)
    expect(dash.desk.items.map((c: DeskCard) => c.key)).toEqual(expect.arrayContaining(["request:req-1"]))
    expect(dash.desk.items.some((c: DeskCard) => c.key === `card:${later.id}`)).toBe(false)
    // The digest names the first of them.
    expect(digest).toContain(`Most urgent: ${dash.desk.items[0].title}: ${dash.desk.items[0].ask}`)
    expect(dash.desk.items[0].title).toBe("Merge the release PR")
  })

  it("counts nothing twice: a request whose question is a card waiting is one item", async () => {
    const c = createCard(root, card({ title: "Pick the venue date" }), { now: NOW - HOUR })
    if (!c.ok) throw new Error(c.error)
    requests.addCandidate({ id: "req-2", runId: "run-2", channel: "telegram", chatId: "c1", agentId: "alpha", text: "book it", now: NOW - 2 * HOUR })
    requests.waitOnOwner("req-2", "Which date?", NOW - HOUR)
    requests.link("req-2", "card", c.card.id, NOW - HOUR)
    const list = readOwnerList(ctx(), NODE)
    expect(list.items.map((x) => x.key)).toEqual([`card:${c.card.id}`])
    expect(list.count).toBe(1)
  })

  it("an empty list is an empty list everywhere", async () => {
    const dash = await (await fetch(`${base}/api/admin/approvals`)).json() as any
    expect(dash.desk).toMatchObject({ count: 0, later: 0, items: [], errors: [] })
    expect((await appDesk()).figures.yours.count).toBe(0)
  })
})

/** GET /api/app/desk with the board built the way the dashboard builds it. */
async function appDesk(): Promise<any> {
  const owner = readOwnerList(ctx(), NODE)
  const board = buildDesk({ now: NOW, node: NODE.url, nodeName: NODE.name, inbox: [], requests: null, cards: [], liveRuns: new Set(), owner })
  const req = Readable.from([]) as any
  req.headers = {}
  let body: any
  const res: any = { writeHead() {}, end(b: string) { body = JSON.parse(b) } }
  await handleAppDesk(req, res, "/api/app/desk", "GET", { board: async () => board, reply: async () => ({ status: 200, body: {} }) })
  return body
}

describe("three settings route without code", () => {
  const base = (desk?: Record<string, unknown>, popup = false) =>
    daemonConfigSchema.parse({ node: { id: "t", name: "T" }, approvals: { popup: { enabled: popup } }, notifications: desk ? { desk } : {} })
  const routingOf = (cfg: ReturnType<typeof base>): DeskRouting =>
    deskRouting({ desk: cfg.notifications.desk, popupEnabled: cfg.approvals.popup.enabled })

  it("defaults to what an install did before: phone off, computer as the popup switch says", () => {
    expect(routingOf(base())).toEqual({ phone: "off", computer: "off" })
    expect(routingOf(base(undefined, true))).toEqual({ phone: "off", computer: "all" })
    expect(daemonConfigSchema.safeParse({ node: { id: "t", name: "T" }, notifications: { desk: { phone: "loud" } } }).success).toBe(false)
  })

  async function route(routing: DeskRouting, now = NOW) {
    const phone = vi.fn(async (_c: DeskCard, _u: boolean) => {})
    const computer = vi.fn(async (_c: DeskCard) => true)
    const r = await routeDesk({ root, now, list: readOwnerList(ctx(now), NODE), routing, phone, computer, log: () => {} })
    return { r, phone: phone.mock.calls.map((c) => c[0].key), urgent: phone.mock.calls.map((c) => c[1]), computer: computer.mock.calls.map((c) => c[0].key) }
  }

  it("records what already waits on the first run and sends none of it", async () => {
    seed()
    const first = await route({ phone: "all", computer: "all" })
    expect(first.r.primed).toBe(true)
    expect(first.phone).toEqual([])
    expect(existsSync(deskRoutedPath(root))).toBe(true)
    expect((await route({ phone: "all", computer: "all" })).phone).toEqual([])
  })

  it("sends each new item once, to the surfaces the settings name, and a change applies to the next item", async () => {
    await route({ phone: "all", computer: "all" }) // primed, nothing waiting
    const { urgent, later, plain } = seed()

    // phone: urgent only, computer: everything.
    const one = await route({ phone: "urgent", computer: "all" })
    expect(one.phone).toEqual([`card:${urgent.id}`])
    expect(one.urgent).toEqual([true])
    expect(one.computer.sort()).toEqual([`card:${urgent.id}`, `card:${later.id}`, `card:${plain.id}`, "request:req-1"].sort())
    // Routed once: the next minute sends nothing again.
    expect((await route({ phone: "all", computer: "all" })).phone).toEqual([])

    // The owner changes the settings: the next item follows the new ones.
    const n = createCard(root, card({ title: "Approve the quote" }), { now: NOW + 60_000 })
    if (!n.ok) throw new Error(n.error)
    const two = await route({ phone: "all", computer: "off" }, NOW + 2 * 60_000)
    expect(two.phone).toEqual([`card:${n.card.id}`])
    expect(two.urgent).toEqual([false])
    expect(two.computer).toEqual([])

    const m = createCard(root, card({ title: "Approve the other quote" }), { now: NOW + 3 * 60_000 })
    if (!m.ok) throw new Error(m.error)
    const three = await route({ phone: "off", computer: "urgent" }, NOW + 4 * 60_000)
    expect(three.phone).toEqual([])
    expect(three.computer).toEqual([])
  })

  it("the setting is read from agentx.json: changing the file changes the routing", async () => {
    const { readDeskRouting } = await import("../src/approvals/settings")
    expect(readDeskRouting(configPath)).toEqual({ phone: "off", computer: "off" })
    writeConfig({ notifications: { desk: { phone: "urgent" } }, approvals: { popup: { enabled: true } } })
    expect(readDeskRouting(configPath)).toEqual({ phone: "urgent", computer: "all" })
    writeConfig({ notifications: { desk: { phone: "all", computer: "off" } }, approvals: { popup: { enabled: true } } })
    expect(readDeskRouting(configPath)).toEqual({ phone: "all", computer: "off" })
  })

  it("the dashboard form writes the two settings, and refuses a value it does not know", async () => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost")
      await handleApprovalsPanelApi(req, res, url.pathname, url, { ctx: ctx(), configPath })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(server.address() as any).port}/api/admin/approvals/settings`
    const post = (body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" }, body: JSON.stringify(body) })
    try {
      const ok = await post({ deskPhone: "urgent", deskComputer: "all", digestTime: "18:30" })
      expect(ok.status).toBe(200)
      expect((await ok.json() as any).settings.desk).toEqual({ phone: "urgent", computer: "all" })
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"))
      expect(cfg.notifications.desk).toEqual({ phone: "urgent", computer: "all" })
      expect(cfg.approvals.digest.time).toBe("18:30")
      expect((await post({ deskPhone: "sometimes" })).status).toBe(400)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("the Mac card takes only what notifications.desk.computer lets through", () => {
    const { urgent } = seed()
    const urgentOnly = (i: { expires?: string }) => reaches("urgent", i, NOW)
    expect(nextCardToPop(ctx(), urgentOnly)?.id).toBe(urgent.id)
    expect(nextCardToPop(ctx(), (i) => reaches("off", i, NOW))).toBeNull()
    // A request has no expiry: it reaches only a computer that takes everything.
    requests.needsAttention("req-1", "It stopped.", NOW)
    expect(nextRequestToPop(ctx(), urgentOnly)).toBeNull()
    expect(nextRequestToPop(ctx(), (i) => reaches("all", i, NOW))?.id).toBe("req-1")
  })

  it("a computer held in Focus gets the item when the hold ends, and only then", async () => {
    await routeDesk({ root, now: NOW, list: readOwnerList(ctx(), NODE), routing: { phone: "off", computer: "all" }, phone: async () => {}, computer: async () => true, log: () => {} })
    const { urgent } = seed()
    let held = true
    const shown: string[] = []
    const computer = async (c: DeskCard) => { if (held) return false; shown.push(c.key); return true }
    const run = (now: number) => routeDesk({ root, now, list: readOwnerList(ctx(now), NODE), routing: { phone: "off", computer: "urgent" }, phone: async () => {}, computer, log: () => {} })
    await run(NOW + 60_000)
    expect(shown).toEqual([])
    held = false
    await run(NOW + 2 * 60_000)
    expect(shown).toEqual([`card:${urgent.id}`])
    await run(NOW + 3 * 60_000)
    expect(shown).toEqual([`card:${urgent.id}`])
  })
})
