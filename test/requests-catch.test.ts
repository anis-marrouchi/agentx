import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import {
  CatchLog, catchPrompt, catchSettingsOf, DEFAULT_CATCH_SETTINGS, firmQuote, mayCatch, PromiseCatcher, readVerdict, type CatchSettings,
} from "../src/requests/catch"
import { MAX_OPEN_PROMISES } from "../src/requests/daemon-api"
import { requestsConfigSchema } from "../src/daemon/config"

// Catch "I'll do X" as a promise (#1138 step E). The model is mocked:
// these tests cover what its verdict makes of a request. How well the
// real model reads replies is measured offline (pnpm bench:catch).

const HOUR = 3_600_000

let tmp: string
let db: Database.Database
let store: RequestStore
let log: CatchLog
let tracker: RequestTracker
let settings: RequestSettings
let catching: CatchSettings
let clock: number
let answer: string
let calls: string[]
let settled: Array<Promise<unknown>>

const promiseAnswer = (quote: string, what: string, due: string | null = null) =>
  JSON.stringify({ kind: "promise", quote, what, due, question: null })

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-catch-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  log = new CatchLog(db)
  clock = Date.parse("2030-03-01T12:00:00Z")
  catching = { ...DEFAULT_CATCH_SETTINGS, enabled: true }
  settings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90, catchPromises: catching }
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
  answer = JSON.stringify({ kind: "none", quote: null, what: null, due: null, question: null })
  calls = []
  settled = []
  const catcher = new PromiseCatcher({
    store, log, settings: () => catchSettingsOf(settings), say: () => {}, now: () => clock,
    generate: async (prompt) => { calls.push(prompt); return answer },
  })
  // Keep each verdict's promise, so a test can wait for it.
  const turnEnded = catcher.turnEnded.bind(catcher)
  catcher.turnEnded = (t) => {
    const r = turnEnded(t)
    if (r) settled.push(r.settled)
    return r
  }
  tracker.setCatcher(catcher)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

let seq = 0
/** One owner turn on coder in chat-1 that ends with `reply`. */
async function turn(reply: string, opts: { taskId?: string; delegate?: boolean } = {}): Promise<string> {
  const taskId = opts.taskId ?? `t${++seq}`
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, messagePreview: "send the report", fullMessage: "send the report",
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
  if (opts.delegate) tracker.delegationStarted({ id: `dlg-${taskId}`, caller: "coder", callee: "devops", origin: { channel: "telegram", chatId: "chat-1" } } as any)
  tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, durationMs: 1, at: "", finalResponse: reply } as any)
  await Promise.all(settled.splice(0))
  return `req-${taskId}`
}

const promisesOf = (agentId: string) => store.listOpen().filter((r) => r.promise && r.agentId === agentId)

describe("the verdict, read from the model's answer", () => {
  const reply = "Deploying now. I'll send you the report at 18:00 once CI is green."

  it("reads a firm promise with what and when", () => {
    const v = readVerdict(promiseAnswer("I'll send you the report at 18:00 once CI is green.", "Send the report", "2030-03-01T18:00:00Z"), clock, reply)
    expect(v).toEqual({ kind: "promise", what: "Send the report", dueAt: Date.parse("2030-03-01T18:00:00Z"), question: null })
  })

  it("reads a fenced answer, a question to the owner, and none", () => {
    expect(readVerdict('```json\n{"kind":"waiting_owner","question":"Which account?"}\n```', clock, "Which account should I use?"))
      .toEqual({ kind: "waiting_owner", what: null, dueAt: null, question: "Which account?" })
    expect(readVerdict('{"kind":"none"}', clock, reply)?.kind).toBe("none")
  })

  it("gives no verdict for an answer that does not read", () => {
    expect(readVerdict("I think it is a promise", clock, reply)).toBeNull()
    expect(readVerdict('{"kind":"maybe"}', clock, reply)).toBeNull()
    expect(readVerdict('{"kind":"promise","quote":"I\'ll send you the report at 18:00 once CI is green.","what":""}', clock, reply)).toBeNull()
    expect(readVerdict('{"kind":"waiting_owner","question":""}', clock, reply)).toBeNull()
  })

  it("drops a due time already past or months away", () => {
    const quote = "I'll send you the report at 18:00 once CI is green."
    expect(readVerdict(promiseAnswer(quote, "Send it", "2030-02-01T18:00:00Z"), clock, reply)?.dueAt).toBeNull()
    expect(readVerdict(promiseAnswer(quote, "Send it", "2031-01-01T18:00:00Z"), clock, reply)?.dueAt).toBeNull()
    expect(readVerdict(promiseAnswer(quote, "Send it", "tomorrow"), clock, reply)?.dueAt).toBeNull()
  })

  it("reads a promise as none unless its quoted sentence is in the reply and commits", () => {
    // Not in the reply: the model made it up.
    expect(readVerdict(promiseAnswer("I'll call you tomorrow.", "Call"), clock, reply)?.kind).toBe("none")
    // No quote at all.
    expect(readVerdict(promiseAnswer("", "Send it"), clock, reply)?.kind).toBe("none")
    expect(firmQuote("If it is, I will bring it to you.", "Maybe. If it is, I will bring it to you.")).toBe(false)
    expect(firmQuote("I can try all three again this afternoon.", "I can try all three again this afternoon.")).toBe(false)
    expect(firmQuote("DevOps will report the version.", "DevOps will report the version.")).toBe(false)
    expect(firmQuote("I’ll tell you when it’s live.", "Coder is on it, and I'll tell you when it's live.")).toBe(true)
    expect(firmQuote("I will check it tomorrow", "Done for today. I will check it **tomorrow**.")).toBe(true)
  })

  it("skips replies that cannot hold a promise or a question without a call", () => {
    expect(mayCatch("Done: the report is sent, link below.")).toBe(false)
    expect(mayCatch("I'll send it at six.")).toBe(true)
    expect(mayCatch("Which account should I use?")).toBe(true)
  })

  it("fences the reply and the request as data in the prompt", () => {
    const p = catchPrompt({ reply: "I'll do it", asked: "do it", now: clock })
    expect(p).toContain("THE AGENT'S REPLY:\n```\nI'll do it\n```")
    expect(p).toContain("WHAT THE PERSON ASKED:\n```\ndo it\n```")
  })
})

describe("a turn that ends with a promise", () => {
  it("opens a promise owned by the agent, owed to whoever asked, due when the reply said", async () => {
    answer = promiseAnswer("I'll send you the report at 18:00.", "Send the report", "2030-03-01T18:00:00Z")
    const id = await turn("Started on it. I'll send you the report at 18:00.")
    // The turn's candidate leaves; the promise follows the work instead.
    expect(store.get(id)).toBeNull()
    const [p] = promisesOf("coder")
    expect(p).toMatchObject({
      agentId: "coder", owedTo: "4242", text: "Send the report", headline: "Send the report", channel: "telegram", chatId: "chat-1",
      state: "in_progress", dueAt: Date.parse("2030-03-01T18:00:00Z"),
    })
    expect(store.byLink("run", "t" + seq)?.id).toBe(p.id)
    expect(log.summary(0)).toEqual({ promise: 1 })
  })

  it("gives an open request the due time it lacked, and opens no second loop", async () => {
    answer = promiseAnswer("I'll confirm tomorrow at noon.", "Confirm the deploy", "2030-03-02T12:00:00Z")
    const id = await turn("DevOps is deploying. I'll confirm tomorrow at noon.", { delegate: true })
    expect(store.get(id)).toMatchObject({ state: "waiting_other", dueAt: Date.parse("2030-03-02T12:00:00Z") })
    expect(promisesOf("coder")).toHaveLength(0)
  })

  it("opens none when the agent opened its own promise in that turn", async () => {
    answer = promiseAnswer("I'll send you the report at 18:00.", "Send the report")
    tracker.taskStarted({
      agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t-own", messagePreview: "x", fullMessage: "x", at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
    store.addPromise({ id: "prm-own", channel: "telegram", chatId: "chat-1", agentId: "coder", text: "Send the report", owedTo: "owner", now: clock })
    tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t-own", durationMs: 1, at: "", finalResponse: "I'll send you the report at 18:00." } as any)
    await Promise.all(settled.splice(0))
    expect(promisesOf("coder").map((r) => r.id)).toEqual(["prm-own"])
  })

  it("opens none past the agent's limit of open promises", async () => {
    for (let i = 0; i < MAX_OPEN_PROMISES; i++) {
      store.addPromise({ id: `prm-${i}`, channel: "x", chatId: `c${i}`, agentId: "coder", text: "t", owedTo: "owner", now: clock - HOUR })
    }
    answer = promiseAnswer("I'll send you the report at 18:00.", "Send the report")
    await turn("I'll send you the report at 18:00.")
    expect(promisesOf("coder")).toHaveLength(MAX_OPEN_PROMISES)
    expect(log.summary(0)).toEqual({ skipped: 1 })
  })
})

describe("a turn that ends asking the owner", () => {
  it("leaves the request waiting on the owner, with the question", async () => {
    answer = JSON.stringify({ kind: "waiting_owner", question: "Which account should the report go to?" })
    const id = await turn("Ready to send. Which account should it go to?")
    expect(store.get(id)).toMatchObject({ state: "waiting_owner", question: "Which account should the report go to?" })
  })

  it("closes that wait when the owner writes again in the chat", async () => {
    answer = JSON.stringify({ kind: "waiting_owner", question: "Which account?" })
    const id = await turn("Which account should it go to?")
    answer = JSON.stringify({ kind: "none" })
    const next = await turn("Sent.")
    expect(store.get(id)).toMatchObject({ state: "done" })
    expect(store.get(id)?.evidence).toContain("the owner answered in chat")
    expect(store.get(next)).toBeNull()
  })

  it("puts an open request back to work when the owner answers", async () => {
    answer = JSON.stringify({ kind: "waiting_owner", question: "Which account?" })
    const id = await turn("DevOps has it. Which account should it go to?", { delegate: true })
    expect(store.get(id)?.state).toBe("waiting_owner")
    answer = JSON.stringify({ kind: "none" })
    await turn("Thanks.")
    expect(store.get(id)?.state).toBe("in_progress")
  })

  it("is left alone with waitingOwner off", async () => {
    catching.waitingOwner = false
    answer = JSON.stringify({ kind: "waiting_owner", question: "Which account?" })
    const id = await turn("Which account should it go to?")
    expect(store.get(id)).toBeNull()
  })
})

describe("cost bounds", () => {
  it("does nothing while the switch is off", async () => {
    catching.enabled = false
    answer = promiseAnswer("I'll send you the report at 18:00.", "Send the report")
    const id = await turn("I'll send you the report at 18:00.")
    expect(calls).toHaveLength(0)
    expect(store.get(id)).toBeNull()
    expect(promisesOf("coder")).toHaveLength(0)
  })

  it("is off when the settings never mention it", () => {
    expect(requestsConfigSchema.parse({}).catchPromises).toMatchObject({ enabled: false, dailyCap: 300, waitingOwner: true })
    expect(catchSettingsOf({}).enabled).toBe(false)
  })

  it("stops calling at the daily cap, and starts again the next day", async () => {
    catching.dailyCap = 2
    answer = JSON.stringify({ kind: "none" })
    for (let i = 0; i < 3; i++) await turn("I'll look at it.")
    expect(calls).toHaveLength(2)
    clock += 24 * HOUR
    await turn("I'll look at it.")
    expect(calls).toHaveLength(3)
  })

  it("makes no call for a reply the word check skips, nor for an empty one", async () => {
    await turn("Done: the report is sent.")
    await turn("")
    expect(calls).toHaveLength(0)
  })

  it("reads a run once", async () => {
    answer = JSON.stringify({ kind: "none" })
    await turn("I'll look at it.", { taskId: "same" })
    await turn("I'll look at it.", { taskId: "same" })
    expect(calls).toHaveLength(1)
  })
})

describe("when the call fails", () => {
  it("drops the candidate as before and records the error", async () => {
    tracker.setCatcher(new PromiseCatcher({
      store, log, settings: () => catchSettingsOf(settings), say: () => {}, now: () => clock,
      generate: async () => { throw new Error("model down") },
    }))
    tracker.taskStarted({
      agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "tf", messagePreview: "x", fullMessage: "x", at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
    tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "tf", durationMs: 1, at: "", finalResponse: "I'll do it." } as any)
    await new Promise((r) => setTimeout(r, 10))
    expect(store.get("req-tf")).toBeNull()
    expect(log.summary(0)).toEqual({ error: 1 })
  })
})
