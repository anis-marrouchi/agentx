import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceEnd, recordTraceStart } from "../src/storage/traces"
import { RequestStore } from "../src/requests/store"
import { agentIdsFor, agentsOf } from "../src/members/agents"
import { queueOf } from "../src/members/queue"
import { insertQueuedMessage } from "../src/storage/queued-messages"
import { workOf } from "../src/members/work"
import { agentLine, requestState, sentState, summaryLine } from "../src/daemon/ui/pages/member-logic"
import { renderMemberPage } from "../src/daemon/ui/pages/member"
import type { Person } from "../src/people/people"

// #443: the work page's agent cards, built from the runs the node records.

const PEOPLE: Person[] = [
  { id: "anis", name: "Anis", role: "owner", identities: [] },
  { id: "sara", name: "Sara B", role: "member", identities: [] },
  { id: "omar", name: "Omar", role: "member", identities: [] },
]

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "member-agents-"))
  db = openDb({ path: join(dir, "db.sqlite"), quiet: true } as any)!
})
afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

function turn(taskId: string, agentId: string, person: string | null, o: { at?: number; text?: string; channel?: string; chatId?: string; end?: "ok" | "error" | "timeout" } = {}) {
  recordTraceStart(db, {
    agentId, person, channel: o.channel ?? "telegram", chatId: o.chatId ?? "c1",
    messagePreview: (o.text ?? taskId).slice(0, 200), originalMessage: o.text ?? taskId,
  } as any, taskId)
  if (o.at != null) db.prepare("UPDATE task_traces SET started_at = ? WHERE task_id = ?").run(o.at, taskId)
  if (o.end) {
    recordTraceEnd(db, taskId, { status: o.end })
    if (o.at != null) db.prepare("UPDATE task_traces SET finished_at = ? WHERE task_id = ?").run(o.at + 1000, taskId)
  }
}

const cards = (ids: string[]) => agentsOf(db, "sara", ids, { people: PEOPLE, linkFor: () => "https://git.example.com/x" })

describe("agent cards", () => {
  it("show the member's own running task in full, with where it was asked", () => {
    const long = "Check the staging login " + "x".repeat(300)
    turn("t1", "coder", "sara", { text: long, channel: "gitlab", chatId: "acme/portal:issue:88" })
    const [c] = cards(["coder"])
    expect(c).toMatchObject({ agentId: "coder", state: "working", by: "you", text: long.slice(0, 200), fullText: long })
    expect(c.where).toEqual({ label: "GitLab issue #88 in acme/portal", url: "https://git.example.com/x" })
  })

  // The owner's decision on #443 (2026-10-05): a busy card says what the task is.
  it("say what the agent is doing when someone else started it, but not where, and no more than the preview", () => {
    const long = "the owner's task " + "y".repeat(300)
    turn("t1", "ops", "anis", { text: long, channel: "gitlab", chatId: "acme/secret:issue:1" })
    turn("t2", "billing", "omar", { text: "omar's task" })
    turn("t3", "cron", null, { text: "a timer" })
    const out = cards(["ops", "billing", "cron"])
    expect(out.map((c) => [c.state, c.by, c.text])).toEqual([
      ["working", "owner", long.slice(0, 200)], ["working", "other", "omar's task"], ["working", "other", "a timer"],
    ])
    for (const c of out) expect([c.fullText, c.where]).toEqual([null, null])
    const json = JSON.stringify(out)
    expect(json).not.toContain("acme/secret")
    expect(json).not.toContain("y".repeat(201))
  })

  it("keep what someone else's agent finished to themselves", () => {
    turn("t1", "ops", "anis", { text: "owner work", end: "ok" })
    expect(cards(["ops"])[0]).toMatchObject({ state: "free", by: "owner", text: null, fullText: null, where: null })
  })

  it("say free, and what was finished when it was the member's", () => {
    turn("t1", "secretary", "sara", { text: "draft the reply", end: "ok" })
    turn("t2", "ops", "anis", { text: "owner work", end: "ok" })
    const [mine, theirs] = cards(["secretary", "ops"])
    expect(mine).toMatchObject({ state: "free", by: "you", text: "draft the reply", fullText: null })
    expect(theirs).toMatchObject({ state: "free", by: "owner", text: null })
  })

  it("say blocked only when the member's own last turn failed", () => {
    turn("t1", "billing", "sara", { text: "export the sheet", end: "error" })
    turn("t2", "ops", "anis", { text: "owner work", end: "timeout" })
    const [mine, theirs] = cards(["billing", "ops"])
    expect(mine).toMatchObject({ state: "blocked", by: "you", text: "export the sheet" })
    expect(theirs).toMatchObject({ state: "free", by: "owner", text: null })
  })

  it("show a hand-over between agents on the member's behalf as busy, not as a request of theirs to open", () => {
    turn("t1", "ops", "sara", { channel: "a2a", text: "agent-written brief" })
    expect(cards(["ops"])[0]).toMatchObject({ state: "working", by: "you", text: "agent-written brief", fullText: null, where: null })
  })

  it("carry the line behind each agent, and nothing of anyone else's message", () => {
    const now = Date.now()
    turn("t1", "coder", "anis", { text: "owner work" })
    const q = (agentId: string, person: string | null, chatId: string, at: number, text = "x") =>
      insertQueuedMessage(db, { agentId, channel: "telegram", chatId, person, sender: person, messagePreview: text, queuedAt: at })
    q("coder", "anis", "c1", now - 3000, "the owner's follow-up")
    q("coder", "sara", "c1", now - 2000, "mine first")
    q("coder", "omar", "c1", now - 1000)
    q("coder", "sara", "c1", now, "mine second")
    q("coder", "omar", "c2", now - 500)
    q("ops", "omar", "c9", now)
    const line = queueOf(db, "sara", { linkFor: () => null })
    expect(line.byAgent.get("coder")).toEqual({ waiting: 5, yours: 2, ahead: 1 })
    expect(line.byAgent.get("ops")).toEqual({ waiting: 1, yours: 0, ahead: null })
    expect(line.mine.map((m) => [m.messagePreview, m.ahead, m.where.label])).toEqual([["mine first", 1, "Telegram"], ["mine second", 3, "Telegram"]])
    expect(JSON.stringify(line.mine)).not.toMatch(/follow-up|omar/)
    const out = agentsOf(db, "sara", ["coder", "ops", "new"], { people: PEOPLE, queue: line.byAgent })
    expect(out.map((c) => c.queue)).toEqual([{ waiting: 5, yours: 2, ahead: 1 }, { waiting: 1, yours: 0, ahead: null }, { waiting: 0, yours: 0, ahead: null }])
  })

  it("a running turn wins over an older finished one; an agent that never ran is free", () => {
    turn("t1", "coder", "sara", { at: Date.now() - 60_000, end: "error" })
    turn("t2", "coder", "anis")
    expect(cards(["coder", "new"]).map((c) => [c.agentId, c.state, c.by])).toEqual([["coder", "working", "owner"], ["new", "free", null]])
  })
})

describe("which agents", () => {
  it("the person's own list when the owner set one, else the agents they talked to lately", () => {
    const now = Date.now()
    turn("t1", "coder", "sara", { at: now - 60_000 })
    turn("t2", "secretary", "sara", { at: now - 1000 })
    turn("t3", "old", "sara", { at: now - 9 * 86_400_000 })
    turn("t4", "ops", "omar")
    turn("t5", "hop", "sara", { channel: "a2a" })
    expect(agentIdsFor(db, { id: "sara" }, now)).toEqual(["secretary", "coder"])
    expect(agentIdsFor(db, { id: "sara", agents: ["ops", "coder"] }, now)).toEqual(["ops", "coder"])
  })
})

describe("what the person sent", () => {
  it("lists the last 7 days of turns, with the request a turn became", () => {
    const now = Date.now()
    turn("t1", "coder", "sara", { at: now - 60_000, channel: "gitlab", chatId: "acme/portal:issue:7" })
    turn("t2", "coder", "sara", { at: now - 8 * 86_400_000 })
    turn("t3", "coder", "omar", { at: now - 1000 })
    const store = new RequestStore(db)
    store.addCandidate({ id: "req-1", runId: "t1", channel: "gitlab", chatId: "acme/portal:issue:7", sender: "sara", person: "sara", agentId: "coder", text: "x", now } as any)
    store.progress("req-1", now)
    const w = workOf(db, "sara", { now })
    expect(w.runs.map((r) => r.taskId)).toEqual(["t1"])
    expect(w.runs[0].where?.label).toBe("GitLab issue #7 in acme/portal")
    expect(w.runs[0].request?.state).toBe("in_progress")
  })

  it("keeps requests no listed turn stands for: an older turn, or none", () => {
    const now = Date.now()
    const store = new RequestStore(db)
    const ask = (id: string, runId: string, at: number) =>
      store.addCandidate({ id, runId, channel: "telegram", chatId: "c1", sender: "sara", person: "sara", agentId: "coder", text: id, now: at } as any)
    turn("t1", "coder", "sara", { at: now - 60_000 })
    ask("req-new", "t1", now - 60_000)
    store.progress("req-new", now - 60_000)
    turn("t2", "coder", "sara", { at: now - 9 * 86_400_000 })
    ask("req-old", "t2", now - 9 * 86_400_000)
    store.progress("req-old", now - 9 * 86_400_000, "waiting_other")
    ask("req-closed", "t-gone", now - 10 * 86_400_000)
    store.progress("req-closed", now - 10 * 86_400_000)
    store.close("req-closed", "done", "https://x/1", now - 1000)
    ask("req-stuck", "t-gone2", now - 9 * 86_400_000)
    store.progress("req-stuck", now - 9 * 86_400_000)
    store.needsAttention("req-stuck", "no answer", now - 1000)
    const w = workOf(db, "sara", { now })
    expect(w.runs.map((r) => r.request?.id)).toEqual(["req-new"])
    // "Needs a person" shows req-stuck; the list keeps the other two.
    expect(w.other.map((r) => r.id)).toEqual(["req-old", "req-closed"])
  })
})

describe("the words", () => {
  it("of a request no turn stands for", () => {
    expect(requestState("in_progress")).toEqual({ label: "In progress", tone: "work" })
    expect(requestState("waiting_other")).toEqual({ label: "Waiting on another agent", tone: "wait" })
    expect(requestState("done")).toEqual({ label: "Finished", tone: "done" })
    expect(requestState("dropped")).toEqual({ label: "Dropped", tone: "off" })
  })

  it("of a card", () => {
    expect(agentLine({ state: "working", by: "you", text: "fix it" })).toMatchObject({ label: "Working", what: "fix it", by: "you", hint: "Busy. A new message waits in line until this ends." })
    expect(agentLine({ state: "working", by: "owner", text: null })).toMatchObject({ what: "Busy with someone else's task", by: "the owner", hint: "A message you send now waits in line until this ends." })
    expect(agentLine({ state: "working", by: "owner", text: "the owner's task" }).what).toBe("the owner's task")
    expect(agentLine({ state: "working", by: "other", text: null }).by).toBe("someone else")
    expect(agentLine({ state: "free", by: "you", text: "draft" })).toMatchObject({ label: "Free", what: "Finished: draft", hint: "Free. Ready for your next message." })
    expect(agentLine({ state: "free", by: "owner", text: null })).toMatchObject({ what: null, by: null })
    expect(agentLine({ state: "blocked", by: "you", text: "export" })).toMatchObject({ label: "Blocked", tone: "stuck", what: "Stopped on: export" })
  })

  it("of the line behind a busy card", () => {
    const hint = (by: string, queue: { waiting: number; yours: number; ahead: number | null }) => agentLine({ state: "working", by, text: null, queue }).hint
    expect(hint("owner", { waiting: 1, yours: 1, ahead: 0 })).toBe("Your message is in line: it runs when this ends.")
    expect(hint("you", { waiting: 3, yours: 1, ahead: 2 })).toBe("Your message is in line, 2 messages ahead of it.")
    expect(hint("owner", { waiting: 2, yours: 2, ahead: 0 })).toBe("2 messages of yours are in line: the first runs when this ends.")
    expect(hint("owner", { waiting: 3, yours: 2, ahead: 1 })).toBe("2 messages of yours are in line, 1 message ahead of the first.")
    expect(hint("owner", { waiting: 1, yours: 0, ahead: null })).toBe("1 message waits in line. A new one from you waits behind it.")
    expect(hint("you", { waiting: 2, yours: 0, ahead: null })).toBe("2 messages wait in line. A new one from you waits behind them.")
    expect(hint("you", { waiting: 0, yours: 0, ahead: null })).toBe("Busy. A new message waits in line until this ends.")
  })

  it("of a sent row, the request first", () => {
    expect(sentState({ status: "queued" })).toEqual({ label: "In line", tone: "wait" })
    expect(sentState({ status: "in-flight" }).label).toBe("Running")
    expect(sentState({ status: "in-flight", request: { state: "waiting_owner" } }).label).toBe("Waiting on the owner")
    expect(sentState({ status: "ok" }).label).toBe("Finished")
    expect(sentState({ status: "error" }).label).toBe("Stopped")
    expect(sentState({ status: "canceled" })).toEqual({ label: "Stopped", tone: "off" })
  })

  it("of the summary", () => {
    expect(summaryLine([], 0)).toBe("Nothing sent yet.")
    expect(summaryLine([{ agentId: "coder", state: "working", by: "you" }, { agentId: "secretary", state: "free", by: null }], 2))
      .toBe("coder is working on your task. secretary is free.")
  })

  it("are sent to the page", () => {
    const page = renderMemberPage()
    for (const id of ["sum", "agents", "need-list", "sent"]) expect(page).toContain(`id="${id}"`)
    for (const fn of ["agentLine", "sentState", "summaryLine"]) expect(page).toContain(`const ${fn}=`)
  })
})
