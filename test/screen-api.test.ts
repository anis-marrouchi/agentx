import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { buildScreen, describeScreen, SCREEN_LIST_MAX, type ScreenInput } from "../src/daemon/screen-api"
import { decideMeshAuth, isMeshGatedPath } from "../src/daemon/mesh-auth"
import { RequestStore } from "../src/requests/store"
import { AGENTX_TOOL_NAMES, READ_TOOL_NAMES } from "../src/mcp/tool-names"
import type { DecisionCard } from "../src/approvals/cards"
import type { PendingNotification } from "../src/notify/queue"
import type { QueueItem } from "../src/voice/speaking-queue"

// GET /screen (#400): what is in front of the owner now, titles only and
// bounded. Names and texts here are invented.

const NOW = Date.parse("2026-01-05T12:00:00Z")
const HOUR = 3_600_000

function card(id: string, over: Partial<DecisionCard> = {}): DecisionCard {
  return {
    id, title: `Approve ${id}`, ask: "SECRET ASK: ship it?", recommend: "Yes", if_silent: "keep",
    expires: new Date(NOW + HOUR).toISOString(), raised_by: "helper", created_at: new Date(NOW - HOUR).toISOString(),
    status: "pending", ...over,
  } as DecisionCard
}

const notice = (id: string, at: number): PendingNotification => ({
  id, at: new Date(at).toISOString(), from: "builder", title: `Build ${id} finished`, message: "SECRET MESSAGE", heldBecause: "Focus",
})

const voiceLine = (id: string, text: string): QueueItem => ({ id, agentId: "helper", kind: "answer", text, voice: {} as any, enqueuedAt: NOW - 1000 })

function input(over: Partial<ScreenInput> = {}): ScreenInput {
  return { now: NOW, cards: [], held: [], voice: null, requests: null, ...over }
}

describe("the screen view", () => {
  it("lists pending cards only, oldest first, with titles and who raised them, never the ask", () => {
    const v = buildScreen(input({
      cards: [
        card("b", { created_at: new Date(NOW - HOUR).toISOString(), node: "studio" }),
        card("a", { created_at: new Date(NOW - 2 * HOUR).toISOString() }),
        card("done", { status: "decided" }),
      ],
    }))
    expect(v.cards).toEqual({
      total: 2,
      items: [
        { id: "a", title: "Approve a", raised_by: "helper", node: null, createdAt: new Date(NOW - 2 * HOUR).toISOString() },
        { id: "b", title: "Approve b", raised_by: "helper", node: "studio", createdAt: new Date(NOW - HOUR).toISOString() },
      ],
    })
    expect(JSON.stringify(v)).not.toContain("SECRET")
  })

  it("lists held notices by title, without their message", () => {
    const v = buildScreen(input({ held: [notice("2", NOW - 1000), notice("1", NOW - 5000)] }))
    expect(v.held.items.map((n) => n.id)).toEqual(["1", "2"])
    expect(v.held.items[0]).toEqual({ id: "1", title: "Build 1 finished", from: "builder", at: new Date(NOW - 5000).toISOString(), heldBecause: "Focus" })
    expect(JSON.stringify(v)).not.toContain("SECRET")
  })

  it("shows the speaking queue with each line cut short, or null without one", () => {
    expect(buildScreen(input()).voice).toBeNull()
    const v = buildScreen(input({
      voice: { paused: false, reserved: true, playing: voiceLine("s1", "Hello there"), waiting: [voiceLine("s2", "word ".repeat(100))], recent: [voiceLine("s0", "old")] },
    }))
    expect(v.voice!.reserved).toBe(true)
    expect(v.voice!.playing).toMatchObject({ id: "s1", agentId: "helper", kind: "answer", text: "Hello there" })
    expect(v.voice!.waiting.total).toBe(1)
    expect(v.voice!.waiting.items[0].text.length).toBeLessThanOrEqual(80)
    expect(v.voice).not.toHaveProperty("recent")
  })

  it("lists open requests waiting on the owner, and no other", () => {
    const s = new RequestStore(new Database(":memory:"))
    const ask = (id: string, at: number) => s.addCandidate({ id, runId: `run-${id}`, channel: "telegram", chatId: "c1", agentId: "writer", text: `Please plan the ${id} trip\n\nwith every detail`, now: at })
    ask("q", NOW - 3 * HOUR)
    s.waitOnOwner("q", "Which day?", NOW - 2 * HOUR)
    ask("w", NOW - 3 * HOUR)
    s.progress("w", NOW - 3 * HOUR)
    ask("x", NOW - 4 * HOUR)
    s.needsAttention("x", "it failed", NOW - HOUR)
    const v = buildScreen(input({ requests: s.listOpen() }))
    expect(v.requests.total).toBe(2)
    expect(v.requests.items.map((r) => [r.id, r.state])).toEqual([["x", "needs_attention"], ["q", "waiting_owner"]])
    expect(v.requests.items[1]).toMatchObject({ agentId: "writer", since: new Date(NOW - 2 * HOUR).toISOString() })
    expect(v.requests.items[1].title).not.toContain("Which day")
    expect(buildScreen(input()).requests).toEqual({ total: 0, items: [] })
  })

  it("holds at most a bounded number of each, and counts the rest", () => {
    const cards = Array.from({ length: SCREEN_LIST_MAX + 5 }, (_, i) => card(`c${String(i).padStart(2, "0")}`))
    const v = buildScreen(input({ cards }))
    expect(v.cards.total).toBe(SCREEN_LIST_MAX + 5)
    expect(v.cards.items).toHaveLength(SCREEN_LIST_MAX)
    expect(describeScreen(v)).toContain("… and 5 more")
  })

  it("names a source it could not read", () => {
    const v = buildScreen(input({ errors: ["held notices: bad file"] }))
    expect(v.errors).toEqual(["held notices: bad file"])
    expect(describeScreen(v)).toContain("Could not read: held notices: bad file")
  })

  it("reads as one line per thing, counts first", () => {
    const text = describeScreen(buildScreen(input({ cards: [card("a")], held: [notice("1", NOW)] })))
    expect(text).toContain("Decision cards waiting for an answer: 1")
    expect(text).toContain("  - Approve a (by helper")
    expect(text).toContain("Notices held by Focus or a call: 1")
    expect(text).toContain("Open requests waiting on the owner: 0")
  })
})

describe("who may read it", () => {
  it("is mesh-gated like /approvals, and a read-only tool", () => {
    expect(isMeshGatedPath("/screen")).toBe(true)
    expect(decideMeshAuth({ remoteAddress: "10.0.0.9", authorizationHeader: "", acceptedTokens: new Set(["t0k"]) }).allowed).toBe(false)
    expect(AGENTX_TOOL_NAMES).toContain("agentx_screen")
    expect(READ_TOOL_NAMES).toContain("agentx_screen")
  })
})
