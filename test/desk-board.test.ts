import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { buildDesk, DESK_DONE_MAX, DESK_TITLE_MAX, type DeskInbox, type DeskInput } from "../src/desk/board"
import { RequestStore } from "../src/requests/store"
import type { DecisionCard } from "../src/approvals/cards"

// The Desk (#959): every column is worked out from the source at the
// moment of the read. Names and texts here are invented.

const HOUR = 3_600_000
const NOW = Date.parse("2026-01-05T12:00:00Z")
const NODE = "http://studio-mac:18800"

function store() {
  return new RequestStore(new Database(":memory:"))
}

function ask(s: RequestStore, id: string, at: number, text = `please do ${id}`) {
  s.addCandidate({ id, runId: `run-${id}`, channel: "telegram", chatId: "c1", agentId: "writer", text, now: at })
}

function input(s: RequestStore | null, over: Partial<DeskInput> = {}): DeskInput {
  const requests = s
    ? [...s.listOpen(), ...s.listClosedSince(NOW - 7 * 24 * HOUR)].map((record) => ({ record, links: s.links(record.id) }))
    : null
  return { now: NOW, node: NODE, nodeName: "studio-mac", inbox: [], requests, cards: [], liveRuns: new Set(), ...over }
}

const inbox = (items: DeskInbox["items"], over: Partial<DeskInbox> = {}): DeskInbox => ({ node: NODE, nodeName: "studio-mac", items, ...over })

const column = (board: ReturnType<typeof buildDesk>, key: string) => board.cards.find((c) => c.key === key)?.column

describe("with an agent needs proof", () => {
  it("shows work as running only while a run of it is live or something changed lately", () => {
    const s = store()
    ask(s, "live", NOW - 30 * HOUR)
    s.progress("live", NOW - 30 * HOUR)
    ask(s, "fresh", NOW - 2 * HOUR)
    s.progress("fresh", NOW - 2 * HOUR, "waiting_other")
    ask(s, "silent", NOW - 30 * HOUR)
    s.progress("silent", NOW - 4 * HOUR)

    const board = buildDesk(input(s, { liveRuns: new Set(["run-live"]) }))
    expect(column(board, "request:live")).toBe("agent")
    expect(board.cards.find((c) => c.key === "request:live")!.live).toBe(true)
    // A written word starts its own turn: not offered beside a live run.
    expect(board.cards.find((c) => c.key === "request:live")!.can.reply).toBe(false)
    expect(board.cards.find((c) => c.key === "request:fresh")!.can.reply).toBe(true)
    expect(column(board, "request:fresh")).toBe("agent")
    expect(board.cards.find((c) => c.key === "request:fresh")!.live).toBeUndefined()
    expect(column(board, "request:silent")).toBe("quiet")
    expect(board.figures.agent.count).toBe(2)
    expect(board.figures.quiet).toEqual({ count: 1, oldest: new Date(NOW - 4 * HOUR).toISOString() })
  })

  it("moves a card the moment its source changes, with nothing to update by hand", () => {
    const s = store()
    ask(s, "a", NOW - 5 * HOUR)
    s.progress("a", NOW - 5 * HOUR)
    expect(column(buildDesk(input(s, { liveRuns: new Set(["run-a"]) })), "request:a")).toBe("agent")
    // The run ended and nothing happened since: not shown as running.
    expect(column(buildDesk(input(s)), "request:a")).toBe("quiet")
    s.close("a", "done", "https://example.test/proof/1", NOW)
    const done = buildDesk(input(s)).cards.find((c) => c.key === "request:a")!
    expect(done).toMatchObject({ column: "done", outcome: "Done", evidence: "https://example.test/proof/1" })
    expect(done.can).toEqual({ answer: false, later: false, reply: false })
  })

  it("honours a different quiet limit", () => {
    const s = store()
    ask(s, "a", NOW - 2 * HOUR)
    s.progress("a", NOW - 2 * HOUR)
    expect(column(buildDesk(input(s, { quietHours: 1 })), "request:a")).toBe("quiet")
  })
})

describe("your turn", () => {
  it("lists every waiting inbox item with its answers, and a request that asks the owner", () => {
    const s = store()
    ask(s, "q", NOW - 3 * HOUR)
    s.waitOnOwner("q", "Blue or green for the cover?", NOW - HOUR)
    const board = buildDesk(input(s, {
      inbox: [inbox([
        { key: "card:c1", title: "Spring newsletter is ready", ask: "Send it?", choices: ["Send today", "Send Monday"], recommend: "Send today", raisedBy: "writer", detail: "3 links tested.", createdAt: "2026-01-04T09:00:00Z" },
        { key: "schedule:digest", title: 'New schedule "digest"', yes: "enable it", no: "drop the request", createdAt: "2026-01-05T09:00:00Z" },
      ])],
    }))
    const card = board.cards.find((c) => c.key === "card:c1")!
    expect(card).toMatchObject({ column: "yours", kind: "card", agent: "writer", facts: "3 links tested.", choices: ["Send today", "Send Monday"] })
    expect(card.can).toEqual({ answer: true, later: true, reply: false })
    expect(board.cards.find((c) => c.key === "schedule:digest")!.kind).toBe("schedule")
    const q = board.cards.find((c) => c.key === "request:q")!
    expect(q).toMatchObject({ column: "yours", ask: "Blue or green for the cover?" })
    expect(q.can).toEqual({ answer: false, later: false, reply: true })
    expect(board.figures.yours).toEqual({ count: 3, oldest: "2026-01-04T09:00:00Z" })
  })

  it("shows a request and the decision card that asks its question as one card", () => {
    const s = store()
    ask(s, "q", NOW - HOUR)
    s.link("q", "card", "c1", NOW - HOUR)
    s.waitOnOwner("q", "Send it?", NOW - HOUR)
    const waiting = buildDesk(input(s, { inbox: [inbox([{ key: "card:c1", title: "Newsletter", ask: "Send it?" }])] }))
    expect(waiting.cards.map((c) => c.key)).toEqual(["card:c1"])
    // Put off: "later" on the card hides its request too.
    expect(buildDesk(input(s, { deferred: new Set(["card:c1"]) })).cards).toEqual([])
    // The card is gone (answered elsewhere): the request still shows its question.
    expect(buildDesk(input(s)).cards.map((c) => c.key)).toEqual(["request:q"])
  })

  it("takes a request that needs attention from the inbox, once, and lets the owner write on it", () => {
    const s = store()
    ask(s, "x", NOW - 30 * HOUR)
    s.needsAttention("x", "the run failed", NOW - HOUR)
    const item = { key: "request:x", title: "Request not finished: please do x", yes: "hand it back to writer", no: "drop the request" }
    const board = buildDesk(input(s, { inbox: [inbox([item]), inbox([{ ...item, key: "request:y" }], { node: "http://other:18800", nodeName: "other" })] }))
    expect(board.cards.filter((c) => c.key === "request:x")).toHaveLength(1)
    expect(board.cards.find((c) => c.key === "request:x")!.can).toEqual({ answer: true, later: true, reply: true })
    // Another node's request is answered there; a reply from here has nowhere to go.
    expect(board.cards.find((c) => c.key === "request:y")!.can.reply).toBe(false)
  })

  it("says which node could not be read", () => {
    const board = buildDesk(input(null, { inbox: [inbox([], { nodeName: "other", error: "unreachable" })] }))
    expect(board.errors).toEqual(["What waits on other could not be read: unreachable"])
    expect(board.cards).toEqual([])
  })
})

describe("done", () => {
  const card = (over: Partial<DecisionCard>): DecisionCard => ({
    id: "c", title: "Newsletter", ask: "Send it?", recommend: "", if_silent: "keep", expires: "2026-01-08T00:00:00Z",
    raised_by: "writer", created_at: "2026-01-04T09:00:00Z", status: "decided", ...over,
  })

  it("keeps what ended in the last days, newest first, with the result in words", () => {
    const s = store()
    ask(s, "old", NOW - 10 * 24 * HOUR)
    s.close("old", "done", "proof", NOW - 8 * 24 * HOUR)
    ask(s, "no", NOW - 30 * HOUR)
    s.close("no", "dropped", "not needed any more", NOW - 2 * HOUR)
    const board = buildDesk(input(s, {
      cards: [
        card({ id: "yes", verdict: "yes", choice: "Send today", decided_at: new Date(NOW - HOUR).toISOString() }),
        card({ id: "late", status: "expired", outcome: "discard", decided_at: new Date(NOW - 3 * HOUR).toISOString() }),
        card({ id: "closed", status: "resolved", resolution: "answered in chat", decided_at: new Date(NOW - 4 * HOUR).toISOString() }),
        card({ id: "ancient", verdict: "no", decided_at: new Date(NOW - 9 * 24 * HOUR).toISOString() }),
        card({ id: "open", status: "pending" }),
      ],
    }))
    expect(board.cards.map((c) => [c.key, c.outcome])).toEqual([
      ["card:yes", "Answered yes: Send today"],
      ["request:no", "Dropped"],
      ["card:late", "No answer in time: discarded"],
      ["card:closed", "Closed by the agent"],
    ])
    expect(board.cards.find((c) => c.key === "request:no")!.evidence).toBe("not needed any more")
    expect(board.figures.done.count).toBe(4)
  })

  it("holds a bounded number of cards", () => {
    const cards = Array.from({ length: DESK_DONE_MAX + 5 }, (_, i) => card({ id: `c${i}`, verdict: "no", decided_at: new Date(NOW - i * 60_000).toISOString() }))
    expect(buildDesk(input(null, { cards })).figures.done.count).toBe(DESK_DONE_MAX)
  })
})

describe("card text", () => {
  it("cuts a long request to a title and leaves candidates out", () => {
    const s = store()
    ask(s, "long", NOW - HOUR, "word ".repeat(200))
    s.progress("long", NOW - HOUR)
    ask(s, "candidate", NOW - HOUR)
    const board = buildDesk(input(s))
    expect(board.cards.map((c) => c.key)).toEqual(["request:long"])
    expect(board.cards[0].title.length).toBeLessThanOrEqual(DESK_TITLE_MAX)
  })
})
