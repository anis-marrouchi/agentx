import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { requests } from "../src/commands/requests"
import { OWNER_BY, RequestStore } from "../src/requests/store"
import { NumberStore } from "../src/numbers/store"
import { requestCard } from "../src/requests/card-view"
import { standingLine, standingView } from "../src/requests/standing"
import { DEFAULT_PROMISE_SETTINGS, openPromise } from "../src/requests/promise"
import { DUE_WAKE_LOG, duePromiseText, runRequestsSweep } from "../src/requests/sweep"
import type { RequestSettings } from "../src/requests/tracker"

// #2383: a standing order shows its number; an agent's close of one gets
// the standing refusal; the due-wake log says why an agent was not woken.

const DAY = 86_400_000
const ID = "req-daily"
let tmp: string
let cwd: string
let store: RequestStore
let numbers: NumberStore
let clock: number
const agentEnv = process.env.AGENTX_AGENT_ID

beforeEach(() => {
  cwd = process.cwd()
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "agentx-2383-")))
  process.chdir(tmp)
  writeFileSync(path.join(tmp, "agentx.json"), JSON.stringify({ node: { id: "n", name: "n" }, agents: {} }))
  const db = openDb()!
  store = new RequestStore(db)
  numbers = new NumberStore(db)
  clock = Date.parse("2030-03-01T12:00:00Z")
  numbers.upsert({ id: "posts-per-day", name: "Posts", rhythm: "daily", ownerAgent: "marketing", origin: "agent", target: { value: 2, direction: "up" } }, clock)
  store.addCandidate({ id: ID, runId: "run-1", channel: "telegram", chatId: "chat-1", sender: "4242", agentId: "marketing", text: "Publish two posts every day", now: clock })
  store.progress(ID, clock)
  store.setStanding(ID, { rhythm: "daily", numberId: "posts-per-day", cronId: null, since: clock })
})
afterEach(() => {
  closeDb()
  process.chdir(cwd)
  process.exitCode = undefined
  if (agentEnv === undefined) delete process.env.AGENTX_AGENT_ID
  else process.env.AGENTX_AGENT_ID = agentEnv
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

const reading = (value: number) =>
  numbers.record({ numberId: "posts-per-day", value, readAt: clock, periodStart: clock - DAY, periodEnd: clock, by: "marketing" })

describe("a standing order's number on the card", () => {
  it("shows no reading yet, then the latest against its target", () => {
    const r = store.get(ID)!
    expect(standingLine(standingView(r.standing!, numbers))).toBe("Standing order, daily: number posts-per-day, no reading yet against at least 2")
    reading(1)
    const card = requestCard(store.get(ID)!, store, null, undefined, numbers)
    expect(card.standingView).toMatchObject({ rhythm: "daily", numberId: "posts-per-day", latest: { value: 1 }, status: "missed" })
    reading(3)
    expect(standingLine(standingView(r.standing!, numbers))).toMatch(/latest 3 \(period to 2030-03-01\) against at least 2: on target$/)
  })

  it("has none on a request that is not standing, and reads a gone number as no reading", () => {
    store.addCandidate({ id: "req-once", runId: "run-2", channel: "telegram", chatId: "chat-2", sender: "4242", agentId: "marketing", text: "One post", now: clock })
    expect(requestCard(store.get("req-once")!, store).standingView).toBeNull()
    expect(standingView(store.get(ID)!.standing!, null).status).toBe("no_reading")
  })

  it("prints the line in agentx requests show", async () => {
    reading(1)
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await requests.parseAsync(["show", ID], { from: "user" })
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("number posts-per-day, latest 1")
  })
})

describe("agentx requests drop on a standing order", () => {
  it("gives an agent the standing refusal and how the owner ends it, not 'already closed'", async () => {
    process.env.AGENTX_AGENT_ID = "marketing"
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await requests.parseAsync(["drop", ID, "--reason", "done for now"], { from: "user" })
    expect(process.exitCode).toBe(1)
    const said = String(err.mock.calls[0]?.[0])
    expect(said).toContain("standing order (daily)")
    expect(said).toContain("Hub's requests panel")
    expect(said).not.toContain("already closed")
    expect(store.get(ID)!.state).toBe("in_progress")
  })

  it("lets the owner end it", async () => {
    delete process.env.AGENTX_AGENT_ID
    vi.spyOn(console, "log").mockImplementation(() => {})
    await requests.parseAsync(["drop", ID, "--reason", "no longer needed"], { from: "user" })
    expect(store.get(ID)).toMatchObject({ state: "dropped", closedBy: OWNER_BY })
  })
})

describe("the due-wake log line (#2383 item 3)", () => {
  const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90, promises: { ...DEFAULT_PROMISE_SETTINGS, leadMinutes: 0, graceMinutes: 0 } }

  const fallDue = async (wakeJob: () => boolean, jobBusy?: () => boolean) => {
    const p = openPromise(store, { agentId: "sales", owedTo: "pm", text: "Send the report", channel: "telegram", chatId: `c-${Math.random()}`, dueAt: clock + 60_000, now: clock, wake: false })
    const lines: string[] = []
    const told: string[] = []
    await runRequestsSweep({
      store, settings, log: (l) => { lines.push(l) }, now: clock + 2 * 60_000,
      hasAgent: (id) => ["sales", "pm"].includes(id), wakeJob, jobBusy,
      tellRequester: (_to, text) => { told.push(text); return true },
      notify: async () => {},
    })
    return { line: lines.find((l) => l.includes(`${p.id} fell due`)) ?? "", told: told[0] ?? "" }
  }

  it("says woken, a run is on it, or cannot be woken, and tells the waiter the same", async () => {
    const woken = await fallDue(() => true)
    expect(woken.line).toContain("sales woken")
    expect(woken.told).toContain("sales was woken")
    const busy = await fallDue(() => false, () => true)
    expect(busy.line).toContain(`sales ${DUE_WAKE_LOG.busy}`)
    expect(busy.told).toContain("sales is in a run on it now")
    const none = await fallDue(() => false, () => false)
    expect(none.line).toContain(`sales ${DUE_WAKE_LOG.none}`)
    expect(none.told).toContain("sales could not be woken")
    expect(none.told).not.toContain("was woken")
  })

  it("keeps the old waiter words by default", () => {
    const r = { id: "x", agentId: "a", text: "t", headline: null, dueAt: clock } as any
    expect(duePromiseText(r)).toContain("a was woken to keep it now")
  })
})
