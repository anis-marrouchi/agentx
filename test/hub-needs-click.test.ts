// #2505: a Needs you row opens on its questions, and says its numbers in words.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { haAskWords, haRowHref, haRowHtml, hubAgentRows, type HaNeed } from "../src/daemon/ui/pages/hub-agents"
import { HUB_NAV_CSS } from "../src/daemon/ui/pages/hub-nav"
import { liveWorkCount, ltAge, ltEsc, ltPlain, ltTitle, type LtNode } from "../src/daemon/ui/pages/wall-tree"
import { WALL_CONTEXT_SCRIPT } from "../src/daemon/ui/pages/wall-context.client"
import { askWords } from "../src/hub/shell/menu"
import { AgentQuestions, agentQuestions, answerBody, laterQuestion, openQuestion, rowsWithout } from "../src/hub/shell/AgentQuestions"
import type { WaitingItem } from "../src/hub/waiting"

const NOW = Date.parse("2026-11-27T12:00:00Z")
const DAY = Date.parse("2026-11-27T00:00:00Z")
const title = (t: Parameters<typeof ltTitle>[0]) => ltTitle(t, null)
const nodes: LtNode[] = [{ name: "Mac", url: "http://mac", reachable: true, agents: [
  { id: "coder", name: "Coder", hourlyTasks: [...new Array(23).fill(0), 76] },
  { id: "pm", name: "Hakim" },
] }]
// Out of order on purpose: the row must still name the oldest.
const needs: HaNeed[] = [
  { key: "request:r3", title: "Third, newest", agent: "coder", at: NOW - 60_000 },
  { key: "card:a", title: "Oldest: sign-up copy", agent: "coder", at: NOW - 40 * 60_000 },
  { key: "card:b", title: "Middle one", agent: "coder", at: NOW - 10 * 60_000 },
  { key: "card:z", title: "Put off", agent: "coder", at: NOW - 50 * 60_000, snoozed: NOW + 3_600_000 },
]
const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain, liveWorkCount(nodes))
const coder = m.rows.find((r) => r.id === "coder")!

describe("the agent's questions on its row (#2505)", () => {
  it("keeps every question, oldest first, put-off ones left out; the title is the first", () => {
    expect(coder.state).toBe("needs")
    expect(coder.asks!.map((a) => a.key)).toEqual(["card:a", "card:b", "request:r3"])
    expect(coder.line).toBe("Oldest: sign-up copy")
    expect(coder.unread).toBe(3)
    expect(m.rows.find((r) => r.id === "pm")!.asks).toBeUndefined()
  })
  it("links a Needs you row to its first question; other rows to the chat as before", () => {
    expect(haRowHref(coder)).toBe("#page=chat&agent=coder&ask=card%3Aa")
    expect(haRowHref({ ...coder, state: "idle" })).toBe("#page=chat&agent=coder")
    expect(haRowHref({ ...coder, asks: [] })).toBe("#page=chat&agent=coder")
  })
  it("says the numbers in words: how many for you, and since when the oldest waits", () => {
    expect(coder.askMs).toBe(40 * 60_000)
    expect(haAskWords(coder, ltAge)).toEqual({ count: "3 for you", since: "asked 40m" })
    expect(haAskWords({ ...coder, askMs: -1 }, ltAge)).toEqual({ count: "3 for you", since: "" })
    expect(haAskWords({ ...coder, state: "working" }, ltAge)).toEqual({ count: "", since: "" })
    expect(askWords(coder)).toEqual({ count: "3 for you", since: "asked 40m" })
  })
})

describe("the old Hub's Needs you row (#2505)", () => {
  const h = haRowHtml(coder, "", ltEsc, ltAge)
  it("draws '3 for you' and the waiting line, without the run numbers or the age", () => {
    expect(h).toContain(">3 for you</b>")
    expect(h).toContain('<span class="ha__since">asked 40m</span>')
    expect(h).not.toContain("ha__stats")
    expect(h).not.toContain("<time")
    expect(h).toContain('href="#page=chat&amp;agent=coder&amp;ask=card%3Aa"')
  })
  it("keeps the numbers on a row that is not Needs you", () => {
    expect(haRowHtml({ ...coder, state: "done", unread: 0, asks: undefined }, "", ltEsc, ltAge)).toContain("ha__stats")
  })
  it("styles the waiting line quietly, on one line", () => {
    expect(HUB_NAV_CSS).toMatch(/\.ha__since \{[^}]*color: var\(--ax-muted\)[^}]*text-overflow: ellipsis/)
  })
})

describe("the old Hub's Working on line (#2505)", () => {
  it("has no select any more, and follows the question a row opened", () => {
    expect(WALL_CONTEXT_SCRIPT).not.toContain('data-cx="pick"')
    expect(WALL_CONTEXT_SCRIPT).not.toContain("<select")
    expect(WALL_CONTEXT_SCRIPT).toContain("ask=")
  })
})

describe("the React chat's questions block (#2505)", () => {
  const item = (key: string, title: string): WaitingItem => ({ key, kind: "card", title })
  const items = [item("request:r3", "Third"), item("card:b", "Middle"), item("card:x", "Someone else's")]
  it("lists the agent's questions still waiting, in the row's order", () => {
    expect(agentQuestions(coder.asks, items).map((i) => i.key)).toEqual(["card:b", "request:r3"])
    expect(agentQuestions(undefined, items)).toEqual([])
  })
  it("opens the one asked for, else the first still waiting, else none (never an empty block)", () => {
    const list = agentQuestions(coder.asks, items)
    expect(openQuestion(list, "request:r3")).toBe("request:r3")
    expect(openQuestion(list, "card:a")).toBe("card:b") // answered: the next one
    expect(openQuestion([], "card:a")).toBeNull()
  })
})

describe("the React chat's questions block, drawn (#2505)", () => {
  const list: WaitingItem[] = [
    { key: "card:a", kind: "card", title: "Oldest: sign-up copy", ask: "Ship the new sign-up copy?" },
    { key: "card:b", kind: "card", title: "Middle one" },
  ]
  const draw = (l: WaitingItem[] | undefined, whole = false) =>
    renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AgentQuestions, { agentId: "coder", list: l, whole, onWhole: () => {} })))
  it("lists them oldest first, the first open with what is asked, and a Whole chat button", () => {
    const h = draw(list)
    expect(h).toContain("2 for you, oldest first")
    expect(h.indexOf('data-question="card:a"')).toBeLessThan(h.indexOf('data-question="card:b"'))
    expect(h).toContain('data-question="card:a" data-question-open="true"')
    expect(h).toContain("Ship the new sign-up copy?")
    expect(h).toContain(">Whole chat</button>")
    expect(draw(list, true)).toContain(">Hide the chat</button>")
  })
  it("draws nothing once all are answered, and a placeholder while it reads", () => {
    expect(draw([])).toBe("")
    expect(draw(undefined)).toContain("animate-pulse")
  })
})

describe("answering in place (#2505 C1)", () => {
  const two: WaitingItem[] = [{ key: "card:a", kind: "card", title: "A" }, { key: "card:b", kind: "card", title: "B" }]
  it("sends yes or no, with the 1-based choice only on yes", () => {
    expect(answerBody("card:a", "yes", 1)).toEqual({ key: "card:a", action: "yes", choice: 2 })
    expect(answerBody("card:a", "yes", null)).toEqual({ key: "card:a", action: "yes" })
    expect(answerBody("card:a", "no", 1)).toEqual({ key: "card:a", action: "no" })
  })
  it("Later folds this one, keeps it, and opens the next; after the last, none is open", () => {
    expect(laterQuestion(two, "card:a")).toBe("card:b")
    expect(laterQuestion(two, "card:b")).toBe(false)
    expect(openQuestion(two, false)).toBeNull()
  })
  it("counts the row down at once, and takes it out of Needs you at 0", () => {
    const one = rowsWithout(m, "coder", "card:a")!
    const r1 = one.rows.find((r) => r.id === "coder")!
    expect([r1.unread, r1.state, r1.line]).toEqual([2, "needs", "Middle one"])
    let left = rowsWithout(one, "coder", "card:b")!
    left = rowsWithout(left, "coder", "request:r3")!
    const r0 = left.rows.find((r) => r.id === "coder")!
    expect([r0.unread, r0.state]).toEqual([0, "idle"])
    expect(left.counts.needs).toBe(m.counts.needs - 1)
    expect(rowsWithout(m, "coder", "card:nope")).toBe(m)
  })
  it("draws Yes, No and Later under the open question, and a task link for a request", () => {
    const draw = (l: WaitingItem[]) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(AgentQuestions, { agentId: "coder", list: l, whole: false, onWhole: () => {} })))
    const h = draw(two)
    expect(h).toContain('data-question-act="yes"')
    expect(h).toContain('data-question-act="no"')
    expect(h).toContain('data-question-act="later"')
    expect(h).not.toContain("old Hub")
    const r = draw([{ key: "request:r3", kind: "request", title: "Reply" }])
    expect(r).toContain('data-question-act="task"')
    expect(r).not.toContain('data-question-act="yes"')
  })
})
