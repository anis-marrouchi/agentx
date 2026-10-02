import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep, pickupText, pickupEnded } from "../src/requests/sweep"
import { plain, requestCard, summarize } from "../src/requests/card-view"
import { handleRequestsPanel } from "../src/daemon/requests-panel"
import { REQUESTS_SCRIPT } from "../src/daemon/ui/pages/approvals-requests"
import { nextRequestToPop, popNext, requestAsCard } from "../src/approvals/popup-runner"
import { renderCardPage } from "../src/approvals/card-page"
import { createCard } from "../src/approvals/cards"

// Open requests as cards (#459): quick to read, with reply, hand-off, done
// and drop, and a notice on the Mac that stays up.

const settings: RequestSettings = { enabled: true, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 }
const P = "/api/admin/approvals/requests"
const SPOKEN = "## Report\n\nBuild the **weekly report** and `deploy` it. Then tell [Sam](https://example.test/sam).\n\n- include <b>sales</b>"

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let clock: number
let on: boolean

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-request-cards-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, final_response TEXT)")
  store = new RequestStore(db)
  clock = Date.parse("2026-10-02T10:00:00Z")
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
  on = true
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ctx = () => {
  const configPath = path.join(tmp, "agentx.json")
  writeFileSync(configPath, JSON.stringify({ node: { id: "n", name: "n" }, agents: { coder: { name: "Coder" }, writer: {} }, requests: { enabled: on } }))
  return { root: tmp, requests: store, now: clock, configPath, reload: false }
}

/** A voice request whose run answered, then timed out. */
function failed(taskId: string, answer?: string) {
  tracker.taskStarted({ agentId: "coder", channel: "voice", chatId: "mac", taskId, messagePreview: "", fullMessage: SPOKEN, at: "", humanRoot: true, operator: true } as any)
  if (answer) db.prepare("INSERT INTO task_traces VALUES (?, 'coder', ?, ?, ?)").run(taskId, clock, clock + 5, answer)
  tracker.taskCompleted({ agentId: "coder", channel: "voice", chatId: "mac", taskId, durationMs: 1, error: "Task timed out after 60 minutes", at: "" } as any)
}

const items = async () => ((await handleRequestsPanel("GET", P, {}, ctx())).body as any).items as any[]

describe("an open request as a card", () => {
  it("summarizes in plain words, never raw markdown", () => {
    expect(plain(SPOKEN)).toBe("Report Build the weekly report and deploy it. Then tell Sam. include <b>sales</b>")
    const long = `**First** sentence here. ${"word ".repeat(80)}`
    expect(summarize(long, 60)).toMatch(/…$/)
    expect(summarize(long, 60)).not.toContain("*")
    expect(summarize("One. Two is the second sentence and it runs on for a while longer.", 40)).toBe("One. Two is the second sentence and it…")
    expect(summarize("A first sentence that is long. Then more words follow here.", 40)).toBe("A first sentence that is long.")
  })

  it("carries the transcript, why it is not finished, and the agent's last answer, rendered and escaped", async () => {
    failed("t1", "I built it. **Deploy failed**: <script>alert(1)</script>")
    const [c] = await items()
    expect(c.summary).not.toMatch(/[#*`]/)
    expect(c.why).toBe("coder timed out: Task timed out after 60 minutes")
    expect(c.textHtml).toContain("<strong>weekly report</strong>")
    expect(c.textHtml).toContain("&lt;b&gt;sales&lt;/b&gt;")
    expect(c.lastAnswer).toMatchObject({ agentId: "coder" })
    expect(c.lastAnswer.html).toContain("<strong>Deploy failed</strong>")
    expect(c.lastAnswer.html).not.toContain("<script>")
  })

  it("has no last answer when no run recorded one, or the database has no traces", () => {
    failed("t1")
    expect(requestCard(store.get("req-t1")!, store).lastAnswer).toBeNull()
    db.exec("DROP TABLE task_traces")
    expect(store.lastAnswer("req-t1")).toBeNull()
  })

  it("lists this node's agents for the hand-off", async () => {
    const r = await handleRequestsPanel("GET", P, {}, ctx())
    expect((r.body as any).agents).toEqual([{ id: "coder", name: "Coder" }, { id: "writer", name: "writer" }])
  })
})

describe("deciding on a card", () => {
  const sweep = async () => {
    const turns: Array<{ agentId: string; text: string }> = []
    await runRequestsSweep({ store, settings, log: () => {}, now: clock, hasAgent: () => true, tellAgent: async (agentId, text) => { turns.push({ agentId, text }) } })
    return turns
  }

  it("a reply goes to the agent that has it, with the words, and the request is in progress", async () => {
    failed("t1")
    expect((await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "  " }, ctx())).status).toBe(400)
    const r = await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Skip the deploy, send me the file." }, ctx())
    expect(r).toMatchObject({ status: 200, body: { ok: true } })
    expect(store.get("req-t1")).toMatchObject({ state: "in_progress", agentId: "coder", ownerNote: "Skip the deploy, send me the file.", attentionReason: null })
    const turns = await sweep()
    expect(turns).toHaveLength(1)
    expect(turns[0].agentId).toBe("coder")
    expect(turns[0].text).toContain("What they say now:\nSkip the deploy, send me the file.")
    expect(await sweep()).toEqual([])
  })

  it("a reply is said once: a later pick-up without words does not repeat it (#480)", async () => {
    failed("t1")
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Skip the deploy, send me the file." }, ctx())
    expect((await sweep())[0].text).toContain("What they say now:")
    expect(store.needsAttention("req-t1", "No activity for 24 h", clock)).toBe(true)
    expect(store.requestPickup("req-t1", clock)).toBe(true)
    const turns = await sweep()
    expect(turns).toHaveLength(1)
    expect(turns[0].text).not.toContain("What they say now")
    expect(turns[0].text).not.toContain("Skip the deploy")
    // The card still shows it.
    expect((await items())[0].ownerNoteHtml).toContain("Skip the deploy")
    // New words are said again, once.
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Send it today." }, ctx())
    expect((await sweep())[0].text).toContain("What they say now:\nSend it today.")
  })

  it("a reply the agent never read is said on the next pick-up (#480)", async () => {
    failed("t1")
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Skip the deploy, send me the file." }, ctx())
    const sent: any[] = []
    await runRequestsSweep({ store, settings, log: () => {}, now: clock, hasAgent: () => true, tellAgent: async (_a, _t, r) => { sent.push(r) } })
    // The turn could not start.
    expect(pickupEnded(store, sent[0], { error: "rate limited" }, clock)).toBe(true)
    expect(store.requestPickup("req-t1", clock)).toBe(true)
    expect((await sweep())[0].text).toContain("What they say now:\nSkip the deploy, send me the file.")
    // Read this time: a later pick-up without words leaves it out.
    store.needsAttention("req-t1", "No activity for 24 h", clock)
    store.requestPickup("req-t1", clock)
    expect((await sweep())[0].text).not.toContain("What they say now")
  })

  it("a reply is kept when the agent could not be told, or is not on this node (#480)", async () => {
    failed("t1")
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Skip the deploy, send me the file." }, ctx())
    const base = { store, settings, log: () => {}, now: clock }
    await runRequestsSweep({ ...base, hasAgent: () => true, tellAgent: async () => { throw new Error("socket closed") } })
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", noteSaid: false })
    expect(store.requestPickup("req-t1", clock)).toBe(true)
    await runRequestsSweep({ ...base, hasAgent: () => false, tellAgent: async () => {} })
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", noteSaid: false })
    expect(store.requestPickup("req-t1", clock)).toBe(true)
    expect((await sweep())[0].text).toContain("What they say now:\nSkip the deploy, send me the file.")
  })

  it("a reply written while the earlier one is being given is still said (#480)", async () => {
    failed("t1")
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Skip the deploy." }, ctx())
    await runRequestsSweep({ store, settings, log: () => {}, now: clock, hasAgent: () => true, tellAgent: async () => {
      await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Send it today." }, ctx())
    } })
    expect((await sweep())[0].text).toContain("What they say now:\nSend it today.")
  })

  it("a reply is kept when the start fails with no wait (#485)", async () => {
    failed("t1")
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Skip the deploy." }, ctx())
    // As the daemon does it: not awaited, the result read in `.then`.
    const start = async () => ({ error: "rate limited" })
    await runRequestsSweep({ store, settings, log: () => {}, now: clock, hasAgent: () => true, tellAgent: async (_a, _t, r) => {
      void start().then((res) => { pickupEnded(store, r, res, clock) })
    } })
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", noteSaid: false })
    expect(store.requestPickup("req-t1", clock)).toBe(true)
    expect((await sweep())[0].text).toContain("What they say now:\nSkip the deploy.")
  })

  it("a late error from an older turn does not repeat a newer reply (#485)", async () => {
    failed("t1")
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Skip the deploy." }, ctx())
    const sent: any[] = []
    const tell = { store, settings, log: () => {}, now: clock, hasAgent: () => true, tellAgent: async (_a: string, _t: string, r: any) => { sent.push(r) } }
    await runRequestsSweep(tell)
    // The first turn is still running when the second reply is given.
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "Send it today." }, ctx())
    await runRequestsSweep(tell)
    expect(pickupEnded(store, sent[0], { error: "timed out" }, clock)).toBe(true)
    expect(store.get("req-t1")).toMatchObject({ ownerNote: "Send it today.", noteSaid: true })
    expect(store.requestPickup("req-t1", clock)).toBe(true)
    expect((await sweep())[0].text).not.toContain("What they say now")
  })

  it("a hand-off gives it to another agent, who is told and can be seen on the card", async () => {
    failed("t1")
    expect((await handleRequestsPanel("POST", `${P}/handoff`, { id: "req-t1", agentId: "nobody" }, ctx())).status).toBe(400)
    const r = await handleRequestsPanel("POST", `${P}/handoff`, { id: "req-t1", agentId: "writer" }, ctx())
    expect(r.status).toBe(200)
    const turns = await sweep()
    expect(turns.map((t) => t.agentId)).toEqual(["writer"])
    expect(turns[0].text).toBe(pickupText(store.get("req-t1")!))
    expect(turns[0].text).not.toContain("What they say now")
    // Still open, and the card names who has it.
    expect((await items()).map((c) => [c.id, c.agentId, c.state])).toEqual([["req-t1", "writer", "in_progress"]])
    // The pick-up turn of the new agent belongs to the request.
    tracker.taskStarted({ agentId: "writer", channel: "requests", chatId: "req-t1", taskId: "t9", messagePreview: "", at: "", pickup: true } as any)
    expect(store.byLink("run", "t9")?.id).toBe("req-t1")
  })

  it("a hand-off to another agent does not send it to the first agent's chat (#481)", async () => {
    failed("t1")
    // A reply, and a hand-off to the agent that was asked: the chat is its own.
    await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "go on" }, ctx())
    expect((await sweep())[0].text).toContain("Report to them in that chat.")
    await handleRequestsPanel("POST", `${P}/handoff`, { id: "req-t1", agentId: "coder" }, ctx())
    expect((await sweep())[0].text).toContain("Report to them in that chat.")
    // Another agent: the chat is named as the first agent's, and the card is where the answer is read.
    await handleRequestsPanel("POST", `${P}/handoff`, { id: "req-t1", agentId: "writer" }, ctx())
    expect(store.get("req-t1")).toMatchObject({ agentId: "writer", askedAgent: "coder" })
    const [told] = await sweep()
    expect(told.agentId).toBe("writer")
    expect(told.text).toContain("The owner handed this request to you. It was asked of coder on voice (chat mac)")
    expect(told.text).not.toContain("Report to them in that chat")
    expect(told.text).toContain("That chat is coder's")
    expect(told.text).toContain("request's card")
    expect(told.text).toContain('agentx_request: {action:"done", id:"req-t1"')
    // The answer of that turn is what the card shows.
    tracker.taskStarted({ agentId: "writer", channel: "requests", chatId: "req-t1", taskId: "t9", messagePreview: "", at: "", pickup: true } as any)
    db.prepare("INSERT INTO task_traces VALUES ('t9', 'writer', ?, ?, 'The report is built.')").run(clock + 10, clock + 20)
    expect((await items())[0].lastAnswer).toMatchObject({ agentId: "writer" })
    // Handed on again, the first agent is still the one that was asked.
    await handleRequestsPanel("POST", `${P}/handoff`, { id: "req-t1", agentId: "writer", note: "today please" }, ctx())
    expect(store.get("req-t1")?.askedAgent).toBe("coder")
    expect((await sweep())[0].text).toContain("It was asked of coder on")
    // Back with the agent that was asked: its own chat again.
    await handleRequestsPanel("POST", `${P}/handoff`, { id: "req-t1", agentId: "coder" }, ctx())
    const [back] = await sweep()
    expect(back.text).toContain("Report to them in that chat.")
    expect(back.text).not.toContain("asked of")
  })

  it("works on a request that is only waiting, and refuses a closed one", async () => {
    failed("t1")
    store.progress("req-t1", clock)
    expect((await handleRequestsPanel("POST", `${P}/handoff`, { id: "req-t1", agentId: "coder", note: "today please" }, ctx())).status).toBe(200)
    expect(store.get("req-t1")?.ownerNote).toBe("today please")
    store.close("req-t1", "dropped", "no", clock)
    expect((await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "again" }, ctx())).status).toBe(409)
    expect((await handleRequestsPanel("POST", `${P}/reply`, { id: "nope", text: "again" }, ctx())).status).toBe(404)
  })

  it("says so when requests are off, since nothing would tell the agent", async () => {
    failed("t1")
    on = false
    const r = await handleRequestsPanel("POST", `${P}/reply`, { id: "req-t1", text: "go on" }, ctx())
    expect(r.status).toBe(409)
    expect(store.get("req-t1")?.state).toBe("needs_attention")
  })

  it("the owner closes as done without a link, or with one", async () => {
    failed("t1"); failed("t2")
    expect((await handleRequestsPanel("POST", `${P}/close`, { id: "req-t1", action: "done" }, ctx())).status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ state: "done", evidence: "closed by the owner (dashboard)" })
    await handleRequestsPanel("POST", `${P}/close`, { id: "req-t2", action: "done", evidence: "https://example.test/pr/4" }, ctx())
    expect(store.get("req-t2")?.evidence).toBe("https://example.test/pr/4")
  })

  it("ships a page script that parses and has every action", () => {
    expect(() => new Function(REQUESTS_SCRIPT)).not.toThrow()
    for (const a of ["reply", "handoff", "done", "drop"]) expect(REQUESTS_SCRIPT).toContain(`data-req="${a}"`)
  })
})

describe("the notice on the Mac", () => {
  const POPUP = { enabled: true, speak: false, sound: "", volume: 0, timeoutSeconds: 60 }
  const off = () => ({ active: false } as any)
  const deps = (show: any) => ({ ctx: ctx(), settings: POPUP, log: () => {}, platform: "darwin" as const, focus: off, show })

  it("shows a request that needs attention as a card, once, and hands it back on yes", async () => {
    failed("t1")
    const seen: any[] = []
    expect(await popNext(deps(async (card: any) => { seen.push(card); return { action: "yes" as const } }))).toBe("shown")
    expect(seen[0]).toMatchObject({ id: "req-t1", origin: { kind: "request", id: "req-t1" }, context: "coder timed out: Task timed out after 60 minutes" })
    expect(seen[0].title).not.toMatch(/[#*`]/)
    expect(store.get("req-t1")?.state).toBe("in_progress")
    expect(await popNext(deps(async () => ({ action: "yes" as const })))).toBe("none")
  })

  it("leaves it on the list on Not now, does not show it twice, and drops on no", async () => {
    failed("t1")
    expect(await popNext(deps(async () => ({ action: "dismiss" as const, why: "not now" as const })))).toBe("shown")
    expect(store.get("req-t1")?.state).toBe("needs_attention")
    expect(nextRequestToPop(ctx())).toBeNull()
    clock += 1000
    failed("t2")
    await popNext(deps(async () => ({ action: "no" as const })))
    expect(store.get("req-t2")?.state).toBe("dropped")
    // Showing the second one did not forget that the first was shown.
    expect(nextRequestToPop(ctx())).toBeNull()
  })

  it("lets a decision card go first, and skips a request that is a day old", async () => {
    failed("t1")
    const card = createCard(tmp, { title: "Send the offer?", ask: "Send it?", recommend: "yes", if_silent: "keep", raised_by: "coder" } as any, { now: clock })
    if (!card.ok) throw new Error(card.error)
    const seen: string[] = []
    await popNext(deps(async (c: any) => { seen.push(c.id); return { action: "dismiss" as const } }))
    expect(seen).toEqual([card.card.id])
    clock += 25 * 3_600_000
    expect(nextRequestToPop(ctx())).toBeNull()
  })

  it("draws the request card with its own words", () => {
    failed("t1")
    const html = renderCardPage(requestAsCard(store.get("req-t1")!, clock), { now: clock, still: true })
    expect(html).toContain(">Request<")
    expect(html).toContain("Hand it back")
    expect(html).toContain(">Drop<")
    expect(html).toContain("It stays in Open requests")
    expect(html).not.toContain("If you don't answer by")
  })
})
