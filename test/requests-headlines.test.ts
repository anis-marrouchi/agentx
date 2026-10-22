import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { HEADLINE_MAX, RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { runRequestTool } from "../src/requests/tool"
import { requestCard, requestTitle } from "../src/requests/card-view"
import { attentionText } from "../src/requests/sweep"
import { headlinePrompt, NEED_FYI, parseModelDescription, writeMissingHeadlines } from "../src/requests/headline"
import { requestAsCard } from "../src/approvals/popup-runner"
import { cardRuleBreak } from "../src/approvals/screen-gate"
import { listInbox } from "../src/approvals/inbox"
import { buildDesk } from "../src/desk/board"

// Headlines (#1126): every request says what it is and what is needed
// from the owner; the owner's own words move below, under "You said".
// Names and texts here are invented.

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const NOW = Date.parse("2026-10-01T10:00:00Z")

let store: RequestStore
let tracker: RequestTracker

beforeEach(() => {
  store = new RequestStore(new Database(":memory:"))
  tracker = new RequestTracker(store, () => settings, () => {}, () => NOW)
})

const api = (body: Record<string, unknown>) =>
  handleRequestsApi("POST", "/requests", { agentId: "coder", ...body }, {
    store, tracker, enabled: true, hasAgent: (id) => id === "coder" || id === "devops", now: NOW,
    runningTurn: (agentId) => agentId === "coder" ? { channel: "telegram", chatId: "chat-1" } : null,
  }, { taskId: "run-1" })

/** An open request of coder's, in the owner's words. */
function open(id: string, text = "can you look at #1104 and the thing from yesterday, the page is broken on my phone") {
  store.addCandidate({ id, runId: `run-${id}`, channel: "telegram", chatId: "chat-1", agentId: "coder", text, now: NOW })
  store.progress(id, NOW)
}

describe("an agent describes its request", () => {
  it("sets the headline and need on accept, and later with describe", () => {
    open("req-1")
    expect(api({ action: "accept", id: "req-1", headline: "Fix the login page on mobile", need: "Nothing, just so you know" }).status).toBe(200)
    expect(store.get("req-1")).toMatchObject({ headline: "Fix the login page on mobile", need: "Nothing, just so you know", headlineBy: "agent" })

    const r = api({ action: "describe", id: "req-1", need: "Send the phone model" })
    expect(r.status).toBe(200)
    expect(store.get("req-1")).toMatchObject({ headline: "Fix the login page on mobile", need: "Send the phone model" })
  })

  it("takes them on wait and promise too", () => {
    open("req-2")
    api({ action: "wait", id: "req-2", question: "Which phone?", headline: "Login page broken on a phone", need: "Say which phone" })
    expect(store.get("req-2")).toMatchObject({ state: "waiting_owner", headline: "Login page broken on a phone", need: "Say which phone" })

    const p = api({ action: "promise", owedTo: "owner", text: "send the report by Friday", headline: "Weekly report by Friday" })
    expect(p.status).toBe(200)
    expect((p.body as any).request).toMatchObject({ promise: true, headline: "Weekly report by Friday", need: null })
  })

  it("refuses an empty describe, a headline too long, and another agent's request", () => {
    open("req-3")
    expect(api({ action: "describe", id: "req-3" }).status).toBe(400)
    const long = api({ action: "describe", id: "req-3", headline: "x".repeat(HEADLINE_MAX + 1) })
    expect(long).toMatchObject({ status: 400, body: { error: expect.stringContaining("say it shorter") } })
    expect(api({ action: "describe", id: "req-3", headline: 42 as any }).status).toBe(400)
    store.addCandidate({ id: "req-4", runId: "run-4", channel: "telegram", chatId: "chat-1", agentId: "devops", text: "restart it", now: NOW })
    store.progress("req-4", NOW)
    expect(api({ action: "describe", id: "req-4", headline: "Restart the server" }).status).toBe(403)
    expect(store.get("req-3")!.headline).toBeNull()
  })

  it("is not activity: describing a request does not reset its quiet time", () => {
    open("req-5")
    store.touch("req-5", NOW - 5_000)
    api({ action: "describe", id: "req-5", headline: "Fix the login page" })
    expect(store.get("req-5")!.updatedAt).toBe(NOW - 5_000)
  })

  it("is sent by the tool, which says what the request now reads", async () => {
    let sent: any
    const text = await runRequestTool({ action: "describe", id: "req-1", headline: "Fix the login page", need: "Nothing, just so you know", callerAgentId: "coder" }, {
      daemonUrl: "http://daemon",
      env: { AGENTX_TASK_ID: "run-1" },
      fetch: (async (_url: string, init: any) => {
        sent = JSON.parse(init.body)
        return new Response(JSON.stringify({ request: { id: "req-1", headline: sent.headline, need: sent.need } }), { status: 200 })
      }) as any,
    })
    expect(sent).toMatchObject({ action: "describe", headline: "Fix the login page", need: "Nothing, just so you know" })
    expect(text).toBe("Request req-1 now reads: Fix the login page. Needed from the owner: Nothing, just so you know.")
  })
})

describe("the daemon's headline for a request with none", () => {
  const answer = (headline: string, need?: string) => async () => JSON.stringify(need === undefined ? { headline } : { headline, need })

  it("writes one once, through one model call per request", async () => {
    open("req-1")
    open("req-2")
    let calls = 0
    const model = async (system: string, prompt: string) => {
      calls++
      expect(system).toContain("JSON")
      expect(prompt).toContain("the page is broken on my phone")
      return '```json\n{"headline": "Login page broken on phone", "need": "Nothing, just so you know"}\n```'
    }
    expect(await writeMissingHeadlines(store, model, { now: NOW })).toBe(2)
    expect(store.get("req-1")).toMatchObject({ headline: "Login page broken on phone", need: "Nothing, just so you know", headlineBy: "daemon" })
    // Each is tried once: a second pass makes no call.
    expect(await writeMissingHeadlines(store, model, { now: NOW })).toBe(0)
    expect(calls).toBe(2)
  })

  it("never replaces the agent's words, and leaves candidates and closed requests alone", async () => {
    open("req-1")
    store.describe("req-1", { headline: "The agent's headline" }, "agent")
    store.addCandidate({ id: "req-c", runId: "run-c", channel: "telegram", chatId: "chat-1", agentId: "coder", text: "hello", now: NOW })
    open("req-d")
    store.close("req-d", "done", "https://example.com/pull/1", NOW)
    let calls = 0
    expect(await writeMissingHeadlines(store, async () => { calls++; return "{}" }, { now: NOW })).toBe(0)
    expect(calls).toBe(0)
    // Nor can a late model answer overwrite it.
    expect(store.describe("req-1", { headline: "A guess" }, "daemon")).toBe(false)
    expect(store.get("req-1")!.headline).toBe("The agent's headline")
  })

  it("does not try again after a failed call, and keeps to its limit", async () => {
    open("req-1")
    open("req-2")
    const logs: string[] = []
    expect(await writeMissingHeadlines(store, async () => { throw new Error("rate limited") }, { now: NOW, limit: 1, log: (m) => logs.push(m) })).toBe(0)
    expect(logs[0]).toContain("rate limited")
    expect(await writeMissingHeadlines(store, answer("Second one"), { now: NOW, limit: 5 })).toBe(1)
    expect(store.get("req-1")!.headline).toBeNull()
    expect(store.get("req-2")!.headline).toBe("Second one")
  })

  it("reads the model's answer: a missing need is 'just so you know', no headline is nothing", () => {
    expect(parseModelDescription('{"headline":"Renew the domain"}')).toEqual({ headline: "Renew the domain", need: NEED_FYI })
    expect(parseModelDescription('{"need":"Pay it"}')).toBeNull()
    expect(parseModelDescription("not json")).toBeNull()
    expect(parseModelDescription(JSON.stringify({ headline: "y".repeat(300) }))!.headline).toHaveLength(HEADLINE_MAX)
  })

  it("asks for it in the request's language, with no ids or links", () => {
    open("req-1", "**Peux-tu** relancer le serveur ?")
    const prompt = headlinePrompt(store.get("req-1")!)
    expect(prompt).toContain("language of the request")
    expect(prompt).toContain("No ids, links or issue numbers")
    expect(prompt).toContain("Peux-tu relancer le serveur ?")
  })
})

describe("every surface shows the headline, then the need, then You said", () => {
  function described(id: string) {
    open(id)
    store.describe(id, { headline: "Fix the login page on mobile", need: "Say which phone you use" }, "agent")
    store.needsAttention(id, "No activity for 24 h", NOW)
  }

  it("falls back to the start of the owner's words without one", () => {
    open("req-1", "## Please\n\nrenew the **domain** before it expires")
    expect(requestTitle(store.get("req-1")!)).toBe("Please renew the domain before it expires")
    expect(requestCard(store.get("req-1")!, store).summary).toBe("Please renew the domain before it expires")
  })

  it("titles the dashboard card with it, and keeps the owner's words", () => {
    described("req-1")
    const card = requestCard(store.get("req-1")!, store)
    expect(card).toMatchObject({ summary: "Fix the login page on mobile", need: "Say which phone you use" })
    expect(card.textHtml).toContain("the page is broken on my phone")
  })

  it("puts it first in the push text, the owner's words under You said", () => {
    described("req-1")
    const lines = attentionText(store.get("req-1")!).split("\n")
    expect(lines[0]).toBe("Fix the login page on mobile")
    expect(lines[1]).toBe("Needed from you: Say which phone you use")
    expect(lines.find((l) => l.startsWith("You said: "))).toContain("the page is broken on my phone")
  })

  it("titles the popup card with it, which then passes the screen gate", () => {
    open("req-0")
    store.needsAttention("req-0", "No activity for 24 h", NOW)
    store.describe("req-0", { headline: "review #1104" }, "agent")
    expect(cardRuleBreak(requestAsCard(store.get("req-0")!, NOW))).toContain("only a reference")

    described("req-1")
    const card = requestAsCard(store.get("req-1")!, NOW)
    expect(card.title).toBe("Fix the login page on mobile")
    expect(card.context).toContain("Say which phone you use")
    expect(card.context).toContain("You said: ")
    expect(cardRuleBreak(card)).toBeNull()
  })

  it("titles the inbox item with it", () => {
    described("req-1")
    const { items } = listInbox({ root: "/nonexistent", requests: store, now: NOW } as any, { kinds: ["request"] })
    expect(items[0].title).toBe("Fix the login page on mobile")
    expect(items[0].detail).toMatch(/^Say which phone you use\. No activity for 24 h\. You said on telegram: /)
  })

  it("titles the Desk line with it, the need as its ask and the owner's words as its facts", () => {
    open("req-1")
    store.describe("req-1", { headline: "Fix the login page on mobile", need: "Nothing, just so you know" }, "agent")
    const record = store.get("req-1")!
    const board = buildDesk({ now: NOW, node: "http://node-a:18800", nodeName: "node-a", inbox: [], requests: [{ record, links: store.links("req-1") }], cards: [], liveRuns: new Set() })
    expect(board.cards[0]).toMatchObject({
      key: "request:req-1", title: "Fix the login page on mobile", ask: "Nothing, just so you know",
      facts: expect.stringMatching(/^You said: can you look at #1104/),
    })
  })
})
