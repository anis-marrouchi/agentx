import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { HEADLINE_MAX, HeadlineWriter, headlinePrompt, parseDescription, readHeadline } from "../src/requests/headline"
import { cardWords, NOTHING_NEEDED, requestCard } from "../src/requests/card-view"
import { attentionTitle, runRequestsSweep } from "../src/requests/sweep"
import { buildDesk } from "../src/desk/board"

// #1126 step 1: every request card, push and Desk line says what the
// request is and what is needed from the owner; their words come below.

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const SAID = "so um can you look at the thing from yesterday, the invoices one, #412, and tell me if it's fine to send"

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-headlines-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function turn(taskId: string, text = SAID) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, messagePreview: text, fullMessage: text,
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
}

const api = (body: Record<string, unknown>) =>
  handleRequestsApi("POST", "/requests", { agentId: "coder", ...body }, {
    store, tracker, enabled: true, hasAgent: (id) => id === "coder", now: 6_000,
    runningTurn: (agentId) => (agentId === "coder" ? { channel: "telegram", chatId: "chat-1" } : null),
  }, { taskId: "t1" })

describe("what an agent may write", () => {
  it("takes a short headline and need, and refuses one that is too long or only a reference", () => {
    expect(parseDescription({ headline: "  Check the  invoices batch ", need: "Say if it can go out." }))
      .toEqual({ headline: "Check the invoices batch", need: "Say if it can go out." })
    expect(parseDescription({})).toEqual({})
    expect(parseDescription({ headline: "x".repeat(HEADLINE_MAX + 1) })).toMatch(/longer than 80/)
    expect(parseDescription({ headline: "#412" })).toMatch(/^headline is only a reference/)
    expect(parseDescription({ need: "y".repeat(161) })).toMatch(/longer than 160/)
  })
})

describe("the model's headline", () => {
  it("is read from one JSON line, cut at a word to fit, and dropped when it is only a reference", () => {
    expect(readHeadline('{"headline": "Check the invoices batch"}')).toBe("Check the invoices batch")
    expect(readHeadline('Sure! {"headline":"\\"Quoted title\\""}')).toBe("Quoted title")
    const long = readHeadline(`{"headline":"${"word ".repeat(30)}"}`)!
    expect(long.length).toBeLessThanOrEqual(HEADLINE_MAX)
    expect(long.endsWith("…")).toBe(true)
    expect(readHeadline('{"headline":"#412"}')).toBeNull()
    expect(readHeadline("no json here")).toBeNull()
    expect(readHeadline('{"title":"wrong key"}')).toBeNull()
  })

  it("is asked for with the request fenced as data", () => {
    const p = headlinePrompt({ text: SAID, agentId: "coder", state: "in_progress" })
    expect(p).toContain("```\n" + SAID + "\n```")
    expect(p).toContain("At most 80 characters")
  })
})

describe("the store", () => {
  it("keeps the agent's words over the model's, whichever comes last", () => {
    turn("t1")
    expect(store.setHeadline("req-t1", { headline: "Model's words" }, "model")).toBe(true)
    expect(store.setHeadline("req-t1", { headline: "Model again" }, "model")).toBe(false)
    expect(store.setHeadline("req-t1", { headline: "Agent's words", need: "Nothing" }, "agent")).toBe(true)
    expect(store.get("req-t1")).toMatchObject({ headline: "Agent's words", need: "Nothing", headlineBy: "agent" })
    expect(store.setHeadline("req-t1", { headline: "Late model" }, "model")).toBe(false)
    expect(store.get("req-t1")?.headline).toBe("Agent's words")
  })

  it("drops a need written for the work when the request turns to the owner's answer", () => {
    turn("t1")
    store.setHeadline("req-t1", { need: NOTHING_NEEDED }, "agent")
    store.waitOnOwner("req-t1", "Send them today or Monday?", 7_000)
    expect(store.get("req-t1")?.need).toBeNull()
  })

  it("lists open requests without a headline, newest first", () => {
    turn("t1")
    turn("t2", "second ask")
    store.progress("req-t1", 6_000)
    store.progress("req-t2", 6_000)
    store.setHeadline("req-t1", { headline: "Has one" }, "agent")
    expect(store.withoutHeadline().map((r) => r.id)).toEqual(["req-t2"])
  })
})

describe("how every surface titles a request", () => {
  it("falls back to the owner's words, and says what is needed from where it stands", () => {
    turn("t1")
    store.progress("req-t1", 6_000)
    let r = store.get("req-t1")!
    expect(cardWords(r)).toMatchObject({ headline: SAID, need: NOTHING_NEEDED, said: SAID })

    store.setHeadline("req-t1", { headline: "Check the invoices batch", need: "Nothing yet." }, "agent")
    r = store.get("req-t1")!
    expect(cardWords(r)).toMatchObject({ headline: "Check the invoices batch", need: "Nothing yet." })

    store.waitOnOwner("req-t1", "Send them today or wait for Monday?", 7_000)
    expect(cardWords(store.get("req-t1")!).need).toBe("Answer: Send them today or wait for Monday?")

    store.needsAttention("req-t1", "No activity for 24 h", 8_000)
    // Whatever the agent wrote before, a stopped request asks the owner to decide.
    expect(cardWords(store.get("req-t1")!).need).toBe("Hand it back to coder, or drop it.")
  })

  it("puts the headline on the Approvals card with the need, and the owner's words below", () => {
    turn("t1")
    store.progress("req-t1", 6_000)
    store.setHeadline("req-t1", { headline: "Check the invoices batch" }, "model")
    const card = requestCard(store.get("req-t1")!, store)
    expect(card).toMatchObject({ summary: "Check the invoices batch", needed: NOTHING_NEEDED })
    expect(card.textHtml).toContain("invoices one")
  })

  it("gives a Desk line the headline, the need and the owner's words", () => {
    turn("t1")
    store.progress("req-t1", 6_000)
    store.setHeadline("req-t1", { headline: "Check the invoices batch", need: "Nothing, just so you know." }, "agent")
    const board = buildDesk({
      now: 6_000, node: "local", nodeName: "Local", inbox: [], cards: [], liveRuns: new Set(),
      requests: [{ record: store.get("req-t1")!, links: [] }],
    })
    expect(board.cards[0]).toMatchObject({ title: "Check the invoices batch", need: "Nothing, just so you know.", said: SAID })
  })

  it("does not repeat the owner's words under a title that already is them", () => {
    turn("t1")
    store.progress("req-t1", 6_000)
    const board = buildDesk({
      now: 6_000, node: "local", nodeName: "Local", inbox: [], cards: [], liveRuns: new Set(),
      requests: [{ record: store.get("req-t1")!, links: [] }],
    })
    expect(board.cards[0].title).toBe(SAID)
    expect(board.cards[0].said).toBeUndefined()
  })
})

describe("the agentx_request actions", () => {
  it("describe sets the headline and need of the turn's request without touching it", () => {
    turn("t1")
    const before = store.get("req-t1")!.updatedAt
    const res = api({ action: "describe", headline: "Check the invoices batch", need: "Say if they can go out." })
    expect(res.status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ headline: "Check the invoices batch", need: "Say if they can go out.", headlineBy: "agent", updatedAt: before })
  })

  it("describe without either field, or with a bare reference, is refused", () => {
    turn("t1")
    expect(api({ action: "describe" }).status).toBe(400)
    expect((api({ action: "describe", headline: "#412" }).body as any).error).toMatch(/only a reference/)
    expect(store.get("req-t1")?.headline).toBeNull()
  })

  it("accept, wait and promise take them alongside", () => {
    turn("t1")
    expect(api({ action: "accept", headline: "Check the invoices batch", need: NOTHING_NEEDED }).status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ state: "in_progress", headline: "Check the invoices batch" })
    expect(api({ action: "wait", question: "Today or Monday?", need: "Pick a day." }).status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ state: "waiting_owner", need: "Pick a day." })
    const p = api({ action: "promise", owedTo: "owner", text: "send the summary by Friday", headline: "Weekly summary" })
    expect(p.status).toBe(200)
    expect((p.body as any).request).toMatchObject({ promise: true, headline: "Weekly summary", headlineBy: "agent" })
  })
})

describe("the daemon's headline writer", () => {
  const writer = (generate: (p: string, s: AbortSignal) => Promise<string>, enabled = true) =>
    new HeadlineWriter({ store, generate, settings: () => ({ enabled, timeoutSeconds: 5 }), log: () => {} })

  it("writes a missing headline once, and never asks again for the same request", async () => {
    turn("t1")
    store.progress("req-t1", 6_000)
    const generate = vi.fn(async () => '{"headline":"Check the invoices batch"}')
    const w = writer(generate)
    expect((await w.ensure(store.get("req-t1")!)).headline).toBe("Check the invoices batch")
    expect(store.get("req-t1")?.headlineBy).toBe("model")
    await w.ensure(store.get("req-t1")!)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it("leaves the request as it was when the model fails, and does not retry it every minute", async () => {
    turn("t1")
    store.progress("req-t1", 6_000)
    const generate = vi.fn(async () => { throw new Error("rate limited") })
    const w = writer(generate)
    expect((await w.ensure(store.get("req-t1")!)).headline).toBeNull()
    expect(await w.fill()).toBe(0)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it("calls nothing when switched off", async () => {
    turn("t1")
    store.progress("req-t1", 6_000)
    const generate = vi.fn(async () => '{"headline":"x y"}')
    expect(await writer(generate, false).fill()).toBe(0)
    expect(generate).not.toHaveBeenCalled()
  })

  it("fills the newest requests first, a few per pass", async () => {
    for (const t of ["t1", "t2", "t3"]) { turn(t, `ask ${t}`); store.progress(`req-${t}`, 6_000) }
    const w = writer(async (p) => `{"headline":"About ${p.match(/ask (t\d)/)![1]}"}`)
    expect(await w.fill(2)).toBe(2)
    expect(store.get("req-t3")?.headline).toBe("About t3")
    expect(store.get("req-t1")?.headline).toBeNull()
  })
})

describe("after review", () => {
  const writer = (generate: (p: string, s: AbortSignal) => Promise<string>) =>
    new HeadlineWriter({ store, generate, settings: () => ({ enabled: true, timeoutSeconds: 5 }), log: () => {}, now: () => 6_000 })

  it("drops a need written for the owner's answer once work goes on, or the request is handed back", () => {
    turn("t1")
    expect(api({ action: "wait", question: "Which date?", need: "Pick a date." }).status).toBe(200)
    store.progress("req-t1", 7_000)
    expect(store.get("req-t1")?.need).toBeNull()
    store.setHeadline("req-t1", { need: "Pick a date." }, "agent")
    store.needsAttention("req-t1", "quiet", 8_000)
    store.requestPickup("req-t1", 9_000)
    expect(store.get("req-t1")?.need).toBeNull()
  })

  it("writes a need only when its action went through", () => {
    turn("t1")
    expect(api({ action: "wait", need: "Pick a date." }).status).toBe(400)
    expect(store.get("req-t1")?.need).toBeNull()
    expect(api({ action: "accept", need: "Nothing, just so you know.", headline: "Book the venue" }).status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ need: "Nothing, just so you know.", headline: "Book the venue" })
  })

  it("keeps saying the model wrote the headline when the agent adds only a need", () => {
    turn("t1")
    store.setHeadline("req-t1", { headline: "Model's words" }, "model")
    store.setHeadline("req-t1", { need: "Nothing." }, "agent")
    expect(store.get("req-t1")).toMatchObject({ headline: "Model's words", headlineBy: "model", need: "Nothing." })
  })

  it("asks once per request, even across restarts, and the fill gets past the ones it tried", async () => {
    for (const t of ["t1", "t2", "t3"]) { turn(t, `ask ${t}`); store.progress(`req-${t}`, 6_000) }
    const failing = vi.fn(async () => { throw new Error("down") })
    expect(await writer(failing).fill(2)).toBe(0)
    expect(failing).toHaveBeenCalledTimes(2)
    // A new writer: the daemon restarted.
    const working = vi.fn(async (p: string) => `{"headline":"About ${p.match(/ask (t\d)/)![1]}"}`)
    expect(await writer(working).fill(2)).toBe(1)
    expect(working).toHaveBeenCalledTimes(1)
    expect(store.get("req-t1")?.headline).toBe("About t1")
  })

  it("calls the model once even when two passes hold an old copy of the request", async () => {
    turn("t1")
    store.progress("req-t1", 6_000)
    const stale = store.get("req-t1")!
    const generate = vi.fn(async () => '{"headline":"One call"}')
    const w = writer(generate)
    await Promise.all([w.ensure(stale), w.ensure(stale)])
    expect(generate).toHaveBeenCalledTimes(1)
    expect(store.get("req-t1")?.headline).toBe("One call")
  })

  it("shows a refused request popup once its agent described it", async () => {
    const { popNext } = await import("../src/approvals/popup-runner")
    turn("t9", "review #412")
    store.needsAttention("req-t9", "timed out", 6_000)
    const shown: string[] = []
    const told: string[] = []
    const deps = {
      ctx: { root: tmp, now: 7_000, requests: store }, log: () => {}, platform: "darwin" as const,
      settings: { enabled: true, speak: false, sound: "", volume: 0, timeoutSeconds: 30 },
      focus: () => ({ active: false, mode: null, reason: "test" }),
      show: async (c: any) => { shown.push(c.title); return { action: "dismiss" as const } },
      returnToAuthor: (_c: any, text: string) => { told.push(text) },
    }
    expect(await popNext(deps as any)).toBe("returned")
    expect(await popNext(deps as any)).toBe("none")
    expect(told).toHaveLength(1)
    store.setHeadline("req-t9", { headline: "Review the login fix" }, "agent")
    await popNext(deps as any)
    expect(shown).toEqual(["Review the login fix"])
  })
})

describe("the owner's notice", () => {
  it("is titled with the headline written just before it is sent", async () => {
    turn("t1")
    store.needsAttention("req-t1", "coder timed out", 6_000)
    const told: Array<{ title: string; text: string }> = []
    const w = new HeadlineWriter({ store, generate: async () => '{"headline":"Check the invoices batch"}', settings: () => ({ enabled: true, timeoutSeconds: 5 }), log: () => {} })
    await runRequestsSweep({
      store, settings, log: () => {}, now: 7_000,
      describe: (r) => w.ensure(r),
      notify: async (title, text) => { told.push({ title, text }) },
    })
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe("Not finished: Check the invoices batch")
    expect(told[0].text).toMatch(/Needed from you: Hand it back to coder, or drop it\.\nYou said: so um can you look/)
    expect(attentionTitle(store.get("req-t1")!)).toBe("Not finished: Check the invoices batch")
  })
})
