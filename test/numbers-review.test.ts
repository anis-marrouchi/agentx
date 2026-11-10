import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { NumberStore } from "../src/numbers/store"
import { DAY_MS, type Reading } from "../src/numbers/model"
import { cardRoute, missStreakStart, raiseMissedTwiceCards, reviewList, type CardDeps } from "../src/numbers/review"
import { installTemplate, NUMBER_TEMPLATES } from "../src/numbers/templates"
import { handleNumbersApi } from "../src/numbers/daemon-api"
import { runNumbersTool } from "../src/numbers/tool"
import { createCard, listCards, verdictMessage, type DecisionCard } from "../src/approvals/cards"
import { numberReviewerMessage } from "../src/approvals/origin"
import { daemonConfigSchema } from "../src/daemon/config"

// Numbers N3 (#1826): the review list and the missed-twice card.

const day = (s: string) => Date.parse(`${s}T00:00:00Z`)
// Tuesday 2026-11-10: the last whole week is 11-02..11-08.
const NOW = Date.parse("2026-11-10T09:00:00Z")
const WEEKS = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]

let tmp: string
let db: Database.Database
let store: NumberStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-numbers-review-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new NumberStore(db)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const AGENTS = new Set(["marketer", "reviewer-agent", "writer"])
const hasAgent = (id: string) => AGENTS.has(id)

function addNumber(id: string, opts: { owner?: string | null; target?: number | null; tags?: string[] } = {}) {
  return store.upsert({
    id, name: `Number ${id}`, origin: "cli", unit: "views", rhythm: "weekly",
    ownerAgent: opts.owner === undefined ? "marketer" : opts.owner,
    target: opts.target === null ? null : { value: opts.target ?? 1000, direction: "up" },
    tags: opts.tags ?? [],
  }, NOW)
}

/** Weekly readings, oldest first, the last one for 11-02..11-08. */
function record(id: string, values: (number | null)[], weeks = WEEKS.slice(-values.length)) {
  values.forEach((value, i) => {
    const start = day(weeks[i]!)
    store.record({ numberId: id, value, error: value === null ? "boom" : null, readAt: NOW, periodStart: start, periodEnd: start + 7 * DAY_MS, by: "reader" })
  })
}

function deps(over: Partial<CardDeps> = {}) {
  const raised: { input: any; origin: any }[] = []
  const d: CardDeps = {
    hasAgent,
    raise: (input, origin) => {
      raised.push({ input, origin })
      return { ok: true, card: { id: `card-${raised.length}` } as DecisionCard }
    },
    ...over,
  }
  return { d, raised }
}

const r = (value: number | null, start: string): Reading => ({
  numberId: "n", value, error: null, readAt: NOW, periodStart: day(start), periodEnd: day(start) + 7 * DAY_MS, by: "reader", note: null,
})

describe("missStreakStart", () => {
  const target = { value: 10, direction: "up" as const }
  it("goes back to the first miss of the run, newest first", () => {
    expect(missStreakStart(target, [r(1, "2026-11-02"), r(2, "2026-10-26"), r(20, "2026-10-19")])).toBe(day("2026-10-26"))
  })
  it("skips failed reads: they do not end a run", () => {
    expect(missStreakStart(target, [r(1, "2026-11-02"), r(null, "2026-10-26"), r(2, "2026-10-19"), r(30, "2026-10-12")])).toBe(day("2026-10-19"))
  })
  it("is null when the newest value meets the target", () => {
    expect(missStreakStart(target, [r(11, "2026-11-02"), r(2, "2026-10-26")])).toBeNull()
  })
})

describe("review list", () => {
  it("keeps missed twice, missed and no reading, worst first; tags narrow it", () => {
    addNumber("on", { tags: ["channel:video"] }); record("on", [2000])
    addNumber("once", { tags: ["channel:video"] }); record("once", [2000, 10])
    addNumber("twice", { tags: ["channel:video"] }); record("twice", [10, 20])
    addNumber("none", { tags: ["channel:social"] })
    addNumber("failed", { tags: ["channel:video"] }); record("failed", [2000, null])
    addNumber("untargeted", { target: null }); record("untargeted", [5])
    const all = reviewList(store, NOW)
    expect(all.map((i) => [i.number.id, i.status])).toEqual([
      ["twice", "missed_twice"], ["once", "missed"], ["failed", "no_reading"], ["none", "no_reading"],
    ])
    expect(reviewList(store, NOW, { tags: ["channel:video"] }).map((i) => i.number.id)).toEqual(["twice", "once", "failed"])
  })

  it("leaves out archived numbers", () => {
    addNumber("gone"); record("gone", [1, 2])
    store.archive("gone", NOW)
    expect(reviewList(store, NOW)).toEqual([])
  })
})

describe("missed-twice card", () => {
  it("raises one card for the owner, and not again for the same run", () => {
    addNumber("views"); record("views", [900, 800])
    const { d, raised } = deps()
    expect(raiseMissedTwiceCards(store, d, NOW)).toEqual([{ numberId: "views", result: "raised", cardId: "card-1", raisedFor: "marketer" }])
    expect(raised[0]!.input.raised_by).toBe("marketer")
    expect(raised[0]!.origin).toEqual({ kind: "number", numberId: "views", streakStart: day("2026-10-26") })
    expect(raised[0]!.input.ask).toContain("800 views for 2026-11-02..2026-11-08")
    // The next check, and a third miss in the same run: no second card.
    expect(raiseMissedTwiceCards(store, d, NOW + 60_000)).toEqual([])
    record("views", [700], ["2026-11-09"])
    expect(raiseMissedTwiceCards(store, d, NOW + 8 * DAY_MS)).toEqual([])
    expect(raised).toHaveLength(1)
    expect(store.lastAlert("views")).toMatchObject({ cardId: "card-1", raisedFor: "marketer", reviewer: null, error: null })
  })

  it("raises again only after it meets the target and misses twice again", () => {
    addNumber("views"); record("views", [900, 800])
    const { d, raised } = deps()
    raiseMissedTwiceCards(store, d, NOW)
    record("views", [1200], ["2026-11-09"])
    expect(raiseMissedTwiceCards(store, d, NOW + 7 * DAY_MS)).toEqual([])
    record("views", [500], ["2026-11-16"])
    expect(raiseMissedTwiceCards(store, d, NOW + 14 * DAY_MS)).toEqual([]) // missed once
    record("views", [400], ["2026-11-23"])
    const out = raiseMissedTwiceCards(store, d, NOW + 21 * DAY_MS)
    expect(out.map((o) => o.result)).toEqual(["raised"])
    expect(raised).toHaveLength(2)
    expect(raised[1]!.origin.streakStart).toBe(day("2026-11-16"))
  })

  it("a failed read in the middle does not count as a recovery", () => {
    addNumber("views"); record("views", [900, 800])
    const { d, raised } = deps()
    raiseMissedTwiceCards(store, d, NOW)
    record("views", [null, 700, 600], ["2026-11-09", "2026-11-16", "2026-11-23"])
    expect(raiseMissedTwiceCards(store, d, NOW + 21 * DAY_MS)).toEqual([])
    expect(raised).toHaveLength(1)
  })

  it("does nothing for a number missed once, on target, or with no reading", () => {
    addNumber("once"); record("once", [2000, 10])
    addNumber("on"); record("on", [10, 2000])
    addNumber("none")
    const { d, raised } = deps()
    expect(raiseMissedTwiceCards(store, d, NOW)).toEqual([])
    expect(raised).toEqual([])
  })

  it("names the reviewer from settings; the owner still gets the card", () => {
    addNumber("views"); record("views", [900, 800])
    const { d, raised } = deps({ reviewer: "reviewer-agent" })
    raiseMissedTwiceCards(store, d, NOW)
    expect(raised[0]!.input.raised_by).toBe("marketer")
    expect(raised[0]!.origin.reviewer).toBe("reviewer-agent")
    expect(raised[0]!.input.recommend).toContain("reviewer-agent reviews it")
    expect(store.lastAlert("views")).toMatchObject({ raisedFor: "marketer", reviewer: "reviewer-agent" })
  })

  it("goes to the reviewer when the number has no owner agent here", () => {
    addNumber("views", { owner: null }); record("views", [900, 800])
    addNumber("away", { owner: "elsewhere" }); record("away", [900, 800])
    const { d, raised } = deps({ reviewer: "reviewer-agent" })
    raiseMissedTwiceCards(store, d, NOW)
    expect(raised.map((x) => [x.input.raised_by, x.origin.reviewer])).toEqual([["reviewer-agent", undefined], ["reviewer-agent", undefined]])
  })

  it("keeps why no card was raised, and does not retry the same run", () => {
    addNumber("views", { owner: null }); record("views", [900, 800])
    const logs: string[] = []
    const { d, raised } = deps({ log: (m) => logs.push(m) })
    expect(raiseMissedTwiceCards(store, d, NOW)[0]).toMatchObject({ result: "failed" })
    expect(raiseMissedTwiceCards(store, d, NOW + 60_000)).toEqual([])
    expect(raised).toEqual([])
    expect(store.lastAlert("views")?.error).toContain("no owner agent")
    expect(logs).toHaveLength(1)
  })

  it("routes: owner by default, reviewer only when another agent here", () => {
    expect(cardRoute({ ownerAgent: "marketer" }, undefined, hasAgent)).toEqual({ raisedFor: "marketer", reviewer: null })
    expect(cardRoute({ ownerAgent: "marketer" }, "marketer", hasAgent)).toEqual({ raisedFor: "marketer", reviewer: null })
    expect(cardRoute({ ownerAgent: "marketer" }, "nobody", hasAgent)).toEqual({ raisedFor: "marketer", reviewer: null })
    expect(cardRoute({ ownerAgent: null }, undefined, hasAgent)).toHaveProperty("error")
  })

  it("makes a real decision card that passes the screen gate", () => {
    addNumber("views"); record("views", [900, 800])
    const root = path.join(tmp, "node")
    const out = raiseMissedTwiceCards(store, {
      hasAgent, reviewer: "reviewer-agent",
      raise: (input, origin) => createCard(root, input, { origin, now: NOW }),
    }, NOW)
    expect(out[0]!.result).toBe("raised")
    const [card] = listCards(root, "pending")
    expect(card).toMatchObject({ raised_by: "marketer", title: "Number views missed its target twice", origin: { kind: "number", numberId: "views", reviewer: "reviewer-agent" } })

    const yes = { ...card!, status: "decided" as const, verdict: "yes" as const }
    expect(verdictMessage(yes)).toContain("The question above gives both readings and the target")
    expect(verdictMessage(yes)).toContain("reviewer-agent reviews your follow-up")
    expect(numberReviewerMessage(yes)).toMatchObject({ agentId: "reviewer-agent" })
    const no = { ...card!, status: "decided" as const, verdict: "no" as const }
    expect(verdictMessage(no)).toContain("No new card comes until")
    expect(numberReviewerMessage(no)).toBeNull()
    expect(numberReviewerMessage({ ...yes, origin: { kind: "number", numberId: "views", streakStart: 0 } })).toBeNull()
  })
})

describe("review over the API and the tool", () => {
  const apiDeps = () => ({ store, hasAgent, runningTurn: () => null, now: NOW })

  it("GET /numbers?review=1 lists only what needs a look, with the card", () => {
    addNumber("views"); record("views", [900, 800])
    addNumber("fine"); record("fine", [2000])
    raiseMissedTwiceCards(store, deps().d, NOW)
    const reply = handleNumbersApi("GET", "/numbers", new URLSearchParams({ review: "1" }), undefined, apiDeps())
    const body = reply.body as any
    expect(reply.status).toBe(200)
    expect(body.numbers.map((n: any) => [n.id, n.status, n.card?.cardId])).toEqual([["views", "missed_twice", "card-1"]])
  })

  it("the tool's review action says each number and its card", async () => {
    addNumber("views"); record("views", [900, 800])
    raiseMissedTwiceCards(store, deps({ reviewer: "reviewer-agent" }).d, NOW)
    const fetchStub = (async (url: string) => {
      const u = new URL(url)
      const reply = handleNumbersApi("GET", u.pathname, u.searchParams, undefined, apiDeps())
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    }) as unknown as typeof fetch
    const text = await runNumbersTool({ action: "review" }, { daemonUrl: "http://daemon", fetch: fetchStub })
    expect(text).toContain("1 number to review")
    expect(text).toContain("[missed twice]")
    expect(text).toContain("Missed-twice card card-1")
    expect(text).toContain("reviewer reviewer-agent")
    store.archive("views", NOW)
    expect(await runNumbersTool({ action: "review" }, { daemonUrl: "http://daemon", fetch: fetchStub })).toContain("Nothing to review")
  })
})

describe("templates", () => {
  it("adds a template's numbers once, with the owner, and keeps existing ones", () => {
    addNumber("journey-enquiries", { owner: "writer" })
    const res = installTemplate(store, "client-journey", "marketer", NOW)
    if ("error" in res) throw new Error(res.error)
    expect(res.kept).toEqual(["journey-enquiries"])
    expect(res.added).toHaveLength(NUMBER_TEMPLATES["client-journey"]!.numbers.length - 1)
    expect(store.get("journey-enquiries")?.ownerAgent).toBe("writer")
    expect(store.get("journey-signed")).toMatchObject({ ownerAgent: "marketer", origin: "cli", source: { kind: "manual" } })
    expect(store.get("journey-reply-hours")?.target).toEqual({ value: 24, direction: "down" })
    const again = installTemplate(store, "client-journey", "marketer", NOW)
    expect("added" in again && again.added).toEqual([])
  })

  it("every bundled template installs cleanly", () => {
    for (const name of Object.keys(NUMBER_TEMPLATES)) {
      const res = installTemplate(store, name, null, NOW)
      expect(res).not.toHaveProperty("error")
    }
    expect(installTemplate(store, "nope", null, NOW)).toHaveProperty("error")
  })
})

describe("settings", () => {
  it("raise cards by default, no reviewer; a reviewer can be set", () => {
    const base = daemonConfigSchema.parse({ node: { id: "n", name: "n" } }).numbers
    expect(base.missedTwiceCard).toBe(true)
    expect(base.reviewer).toBeUndefined()
    expect(daemonConfigSchema.parse({ node: { id: "n", name: "n" }, numbers: { reviewer: "reviewer-agent", missedTwiceCard: false } }).numbers).toMatchObject({ reviewer: "reviewer-agent", missedTwiceCard: false })
  })
})
