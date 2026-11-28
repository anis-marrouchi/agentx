import { describe, expect, it } from "vitest"
import vm from "vm"
import {
  wizId, wizUrgent, wizSteps, wizOneByOne, wizGone, wizLive, wizBody, wizWords, wizOutside, wizSummary,
  type WizCard, type WizStep,
} from "../src/daemon/ui/pages/app-desk-wizard-logic"
import { APP_DESK_WIZARD_SCRIPT } from "../src/daemon/ui/pages/app-desk-wizard.client"
import { APP_DESK_SCRIPT } from "../src/daemon/ui/pages/app-desk.client"
import { injectFns } from "../src/daemon/ui/inject"
import { renderAppPage } from "../src/daemon/ui/pages/app"

// The phone Desk's "Go through them" (#2499 part 2): the same wizard as the
// Hub's Waiting on you, on /app.

const FNS = { wizId, wizUrgent, wizSteps, wizOneByOne, wizGone, wizLive, wizBody, wizWords, wizOutside, wizSummary }

function card(over: Partial<WizCard> & { key: string }): WizCard {
  return { kind: "card", node: "http://mac", column: "yours", title: over.key, can: { answer: true }, ...over }
}

const NOW = Date.parse("2026-11-28T12:00:00Z")
const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString()

describe("the steps", () => {
  it("puts deploys first, then the soonest to expire, then the oldest", () => {
    const steps = wizSteps([
      card({ key: "card:old", askedAt: iso(-48) }),
      card({ key: "card:new", askedAt: iso(-1) }),
      card({ key: "card:soon", expires: iso(2), askedAt: iso(-1) }),
      card({ key: "card:dep", title: "Deploy 0.317.0 to the Mac", askedAt: iso(-1) }),
    ])
    expect(steps.map((s) => s.kind === "one" && s.card.key)).toEqual(["card:dep", "card:soon", "card:old", "card:new"])
  })

  it("only takes what waits for an answer: Your turn, can answer", () => {
    const steps = wizSteps([
      card({ key: "card:a" }),
      card({ key: "request:q", kind: "request", column: "agent" }),
      card({ key: "card:b", can: { answer: false } }),
    ])
    expect(steps).toHaveLength(1)
  })

  it("makes two or more requests one step, last; one request stays its own step", () => {
    const many = [card({ key: "card:a" }), ...Array.from({ length: 56 }, (_, n) => card({ key: `request:r${n}`, kind: "request", askedAt: iso(-n) }))]
    const steps = wizSteps(many)
    expect(steps).toHaveLength(2)
    expect(steps[1].kind).toBe("requests")
    const req = steps[1] as Extract<WizStep, { kind: "requests" }>
    expect(req.cards).toHaveLength(56)
    expect(req.cards[0].key).toBe("request:r55")
    expect(wizSteps([card({ key: "card:a" }), card({ key: "request:r", kind: "request" })]).map((s) => s.kind)).toEqual(["one", "one"])
  })

  it("opens the requests step one by one, in place", () => {
    const steps = wizSteps([card({ key: "card:a" }), card({ key: "request:1", kind: "request" }), card({ key: "request:2", kind: "request" })])
    const each = wizOneByOne(steps, 1)
    expect(each.map((s) => s.kind === "one" && s.card.key)).toEqual(["card:a", "request:1", "request:2"])
    expect(wizOneByOne(steps, 0)).toBe(steps)
  })

  it("passes over a step answered somewhere else, by node and key", () => {
    const a = card({ key: "card:a" })
    const other = card({ key: "card:a", node: "http://box" })
    const live = wizLive([other])
    expect(wizGone({ kind: "one", card: a }, live)).toBe(true)
    expect(wizGone({ kind: "one", card: other }, live)).toBe(false)
    expect(wizGone({ kind: "requests", cards: [a, other] }, live)).toBe(false)
    expect(wizGone({ kind: "requests", cards: [a] }, live)).toBe(true)
    expect(wizGone({ kind: "one", card: a }, null)).toBe(false)
    expect(wizId(other)).toBe("http://box|card:a")
  })

  it("keeps the order stable for cards that tie", () => {
    expect(wizUrgent(card({ key: "a" }), card({ key: "b" }))).toBe(0)
  })
})

describe("what is sent", () => {
  it("sends the node, the 1-based choice on a yes and the draft's hash on a yes only", () => {
    const c = card({ key: "content:d1", kind: "content", textHash: "h1" })
    expect(wizBody(c, "yes", 1)).toEqual({ node: "http://mac", key: "content:d1", action: "yes", choice: 2, seen: "h1" })
    expect(wizBody(c, "no", 1)).toEqual({ node: "http://mac", key: "content:d1", action: "no" })
    expect(wizBody(c, "later")).toEqual({ node: "http://mac", key: "content:d1", action: "later" })
    expect(wizBody(card({ key: "card:a" }), "yes", null)).toEqual({ node: "http://mac", key: "card:a", action: "yes" })
  })

  it("says each answer in words", () => {
    const pick = card({ key: "card:p", choices: ["Blue", "Red"] })
    expect(wizWords(pick, "yes", 1)).toBe("Red")
    expect(wizWords(pick, "no")).toBe("No")
    expect(wizWords(card({ key: "request:r", kind: "request" }), "yes")).toBe("Pick it up again")
    expect(wizWords(card({ key: "request:r", kind: "request" }), "no")).toBe("Close it")
    expect(wizWords(card({ key: "card:a" }), "later")).toBe("Later")
  })

  it("asks once more before a yes that goes outside", () => {
    expect(["whatsapp", "email", "content"].every(wizOutside)).toBe(true)
    expect(wizOutside("card")).toBe(false)
  })

  it("sums up by agent, in the order first answered, and lists what was not sent", () => {
    const s = wizSummary([
      { id: "1", title: "A", agent: "coder", words: "Yes" },
      { id: "2", title: "B", agent: "nadia", words: "No" },
      { id: "3", title: "C", agent: "coder", words: "Later" },
      { id: "4", title: "D", words: "Yes", error: "already answered" },
      { id: "5", title: "E", words: "Yes" },
    ])
    expect(s.byAgent.map((g) => [g.agent, g.answers.map((a) => a.title)])).toEqual([["coder", ["A", "C"]], ["nadia", ["B"]], ["", ["E"]]])
    expect(s.failed.map((f) => f.title)).toEqual(["D"])
  })
})

describe("on the page", () => {
  it("works once shipped: each function stands alone, as injectFns writes it", () => {
    const ctx: Record<string, any> = {}
    vm.createContext(ctx)
    vm.runInContext(injectFns(FNS) + ";globalThis.out = wizSummary([{ id: '1', title: 'A', agent: 'x', words: 'Yes' }]).byAgent.length + wizSteps([" +
      "{ key: 'request:1', kind: 'request', node: 'n', column: 'yours', title: 'a', can: { answer: true } }," +
      "{ key: 'request:2', kind: 'request', node: 'n', column: 'yours', title: 'b', can: { answer: true } }]).length", ctx)
    expect(ctx.out).toBe(2)
  })

  it("parses, and comes after the sheet it asks through and before the Desk that opens it", () => {
    expect(() => new Function(APP_DESK_WIZARD_SCRIPT)).not.toThrow()
    const html = renderAppPage()
    expect(html).toContain(APP_DESK_WIZARD_SCRIPT)
    expect(html.indexOf("window.AXAsk = ")).toBeLessThan(html.indexOf(APP_DESK_WIZARD_SCRIPT))
    expect(html.indexOf(APP_DESK_WIZARD_SCRIPT)).toBeLessThan(html.indexOf(APP_DESK_SCRIPT))
    expect(html).toContain("const wizSteps=")
  })

  it("answers through the Desk's own decide call, and the Desk shows the button only when something waits", () => {
    expect(APP_DESK_WIZARD_SCRIPT).toContain("'/api/app/approvals/decide', wizBody(")
    expect(APP_DESK_SCRIPT).toContain("var steps = wz ? wz.count(data.cards) : 0")
    expect(APP_DESK_SCRIPT).toContain('data-act="wizard">Go through them')
    // While it is open the 15 s read does not redraw the panel.
    expect(APP_DESK_SCRIPT).toContain("if (wz && wz.active()) { panel._data = data; wz.live(data.cards); return; }")
  })
})
