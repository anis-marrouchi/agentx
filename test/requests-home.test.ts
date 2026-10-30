import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep } from "../src/requests/sweep"
import { delegationAgents, fillLinkAgents } from "../src/requests/attach"
import { homeChecker, homeRefOf, type HomeChecker } from "../src/requests/home-check"
import type { ForgeItem, ForgeReader } from "../src/requests/checkers/issue"

// Done work leaves the open list (#1522): a merged or completed home closes
// the request, and a retried hand-off no longer holds it after a failure.

const HOUR = 3_600_000
const GITLAB = "https://gitlab.example.test"
const PR = "https://github.com/acme/app/pull/12"
const ISSUE = "https://github.com/acme/app/issues/7"
const MR = `${GITLAB}/group/project/-/merge_requests/3`
const GL_ISSUE = `${GITLAB}/group/project/-/issues/4`
const T0 = Date.parse("2030-03-01T12:00:00Z")
/** A close time after the request was asked. */
const LATER = "2030-03-01T13:00:00Z"

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let settings: RequestSettings
let clock: number
let logs: string[]
let items: Record<string, ForgeItem | { error: string }>
let reads: string[]
let github: boolean

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-home-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  settings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
  clock = T0
  logs = []
  items = {}
  reads = []
  github = true
  tracker = new RequestTracker(store, () => settings, (m) => logs.push(m), () => clock)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const forge: ForgeReader = async (provider, ref) => {
  const key = `${provider}:${ref.project}${provider === "gitlab" && ref.mr ? "!" : "#"}${ref.number}`
  reads.push(key)
  return items[key] ?? { error: "not found (or not visible to the connector)" }
}
const checkHome: HomeChecker = homeChecker(() => ({ forge, gitlabUrl: GITLAB, github }))

function start(taskId: string) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId,
    messagePreview: "fix it", fullMessage: "fix the login bug",
    at: new Date(clock).toISOString(), humanRoot: true, sender: { name: "Owner", id: "4242" },
  } as any)
}
function end(taskId: string) {
  tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, durationMs: 10, at: new Date(clock).toISOString() } as any)
}
const dlg = (id: string, callee = "devops") => ({ id, caller: "coder", callee, origin: { channel: "telegram", chatId: "chat-1" } })

/** An open request, waiting on a hand-off, whose home is `link`. */
function homed(link: string, id = "t1") {
  start(id)
  tracker.delegationStarted(dlg(`dlg-${id}`))
  end(id)
  store.setHome(`req-${id}`, { kind: "issue", link }, clock)
  return `req-${id}`
}

const sweep = (over: Partial<Parameters<typeof runRequestsSweep>[0]> = {}) =>
  runRequestsSweep({ store, settings, log: (m) => logs.push(m), now: clock, checkHome, ...over })

describe("the home closes the request (#1522)", () => {
  it("closes a request whose pull request merged, checked, with who merged it", async () => {
    const id = homed(PR)
    items["github:acme/app#12"] = { state: "merged", url: PR, closedBy: "anis", closedAt: LATER }
    const res = await sweep()
    expect(res.homesClosed).toBe(1)
    expect(store.get(id)).toMatchObject({ state: "done", verifyState: "verified", evidence: `home ${PR} merged by anis at ${LATER}` })
    expect(logs.join("\n")).toContain(`${id} closed: home ${PR} merged`)
  })

  it("closes one that needs attention, and names the message steps its plan had left", async () => {
    const id = homed(ISSUE)
    store.needsAttention(id, 'Step 2 "Tell Anis" is blocked: waiting for approval', clock)
    items["github:acme/app#7"] = { state: "closed", url: ISSUE, stateReason: "completed", closedAt: LATER }
    await sweep({ planLeft: (r) => (r === id ? [{ step: "2. Tell Anis", agent: false }, { step: "3. Tell the client", agent: false }] : []) })
    expect(store.get(id)).toMatchObject({ state: "done", evidence: `home ${ISSUE} closed at ${LATER}; its plan stopped with steps left: 2. Tell Anis; 3. Tell the client` })
  })

  it("leaves open a request whose active plan still has a step an agent owns, and says so", async () => {
    const id = homed(ISSUE)
    items["github:acme/app#7"] = { state: "closed", url: ISSUE, stateReason: "completed", closedAt: LATER }
    const left = [{ step: "2. Live check", agent: true }, { step: "3. Tell Anis", agent: false }]
    const res = await sweep({ planLeft: (r) => (r === id ? left : []) })
    expect(res.homesClosed).toBe(0)
    expect(store.get(id)?.state).not.toBe("done")
    expect(logs.join("\n")).toContain(`${id} left open: home ${ISSUE} closed at ${LATER}; home closed, plan has agent steps left: 2. Live check`)
    // The agent step finished: the next read closes it, naming what is left.
    left.shift()
    clock += 2 * HOUR
    expect((await sweep({ planLeft: (r) => (r === id ? left : []) })).homesClosed).toBe(1)
    expect(store.get(id)).toMatchObject({ state: "done", evidence: `home ${ISSUE} closed at ${LATER}; its plan stopped with steps left: 3. Tell Anis` })
  })

  it("never reads a comment or note anchor as its item's state", async () => {
    const id = homed(`${GL_ISSUE}#note_130788`, "t1")
    const other = homed(`${ISSUE}#issuecomment-6493803179`, "t2")
    items["gitlab:group/project#4"] = { state: "closed", url: GL_ISSUE, closedAt: LATER }
    items["github:acme/app#7"] = { state: "closed", url: ISSUE, stateReason: "completed", closedAt: LATER }
    expect((await sweep()).homesClosed).toBe(0)
    expect(reads).toEqual([])
    expect(store.get(id)?.state).not.toBe("done")
    expect(store.get(other)?.state).not.toBe("done")
    expect(homeRefOf({ home: { kind: "issue", link: `${PR}#discussion_r1` } }, GITLAB)).toBeNull()
  })

  it("reads a merge request and an issue on this node's GitLab", async () => {
    const mr = homed(MR, "a")
    const issue = homed(GL_ISSUE, "b")
    items["gitlab:group/project!3"] = { state: "merged", url: MR, closedBy: "devops", closedAt: LATER }
    items["gitlab:group/project#4"] = { state: "closed", url: GL_ISSUE, closedAt: LATER }
    await sweep()
    expect(store.get(mr)).toMatchObject({ state: "done", evidence: `home ${MR} merged by devops at ${LATER}` })
    expect(store.get(issue)?.state).toBe("done")
  })

  it("leaves a pull or merge request closed without merging", async () => {
    const pr = homed(PR, "a")
    const mr = homed(MR, "b")
    items["github:acme/app#12"] = { state: "closed", url: PR, closedAt: LATER }
    items["gitlab:group/project!3"] = { state: "closed", url: MR, closedAt: LATER }
    expect((await sweep()).homesClosed).toBe(0)
    expect(store.get(pr)?.state).toBe("waiting_other")
    expect(store.get(mr)?.state).toBe("waiting_other")
  })

  it("leaves an open home, one closed as not planned or a duplicate, one with no close time, and one it cannot read", async () => {
    const open = homed(PR, "a")
    const notPlanned = homed(ISSUE, "b")
    const duplicate = homed("https://github.com/acme/app/issues/8", "c")
    const noTime = homed(GL_ISSUE, "d")
    const unread = homed("https://github.com/acme/app/issues/99", "e")
    items["github:acme/app#12"] = { state: "open", url: PR }
    items["github:acme/app#7"] = { state: "closed", url: ISSUE, stateReason: "not_planned", closedAt: LATER }
    items["github:acme/app#8"] = { state: "closed", url: ISSUE, stateReason: "duplicate", closedAt: LATER }
    items["gitlab:group/project#4"] = { state: "closed", url: GL_ISSUE }
    const res = await sweep()
    expect(res.homesClosed).toBe(0)
    for (const id of [open, notPlanned, duplicate, noTime, unread]) expect(store.get(id)?.state).toBe("waiting_other")
    // Not a verify state: a request with no checker is not "unverified".
    expect(store.get(unread)?.verifyState).toBeNull()
  })

  it("leaves a home that closed before the request was asked", async () => {
    const id = homed(PR)
    items["github:acme/app#12"] = { state: "merged", url: PR, closedAt: "2030-03-01T11:00:00Z" }
    await sweep()
    expect(store.get(id)?.state).toBe("waiting_other")
  })

  it("does not close again what the owner reopened or sent back after the home closed", async () => {
    const id = homed(PR)
    items["github:acme/app#12"] = { state: "merged", url: PR, closedAt: LATER }
    clock = Date.parse(LATER) + HOUR
    await sweep()
    expect(store.get(id)?.state).toBe("done")
    // The owner comments on the closed post: "still broken".
    expect(store.reopen(id, "still broken", clock)).toBe(true)
    await sweep({ tellAgent: async () => {}, hasAgent: () => true })
    clock += 11 * 60_000
    await sweep()
    expect(store.get(id)?.state).toBe("in_progress")
    // And a hand-off on an open one, likewise.
    const other = homed(PR, "t2")
    expect(store.handOff(other, "devops", "redo it", clock)).toBe(true)
    await sweep({ tellAgent: async () => {}, hasAgent: () => true })
    clock += 11 * 60_000
    await sweep()
    expect(store.get(other)?.state).toBe("in_progress")
  })

  it("never closes a request waiting on the owner, a promise, or one with its own checker", async () => {
    const waiting = homed(PR, "a")
    store.waitOnOwner(waiting, "Send the client the release note?", clock)
    const checked = homed(PR, "b")
    store.setLoop(checked, { closeWhen: { kind: "url", url: "https://example.test/live" } }, clock)
    const promised = homed(PR, "c")
    db.prepare("UPDATE requests SET promise = 1 WHERE id = ?").run(promised)
    items["github:acme/app#12"] = { state: "merged", url: PR, closedAt: LATER }
    await sweep({ check: async () => ({ verdict: "not_met", detail: "not yet" }) })
    expect(store.get(waiting)?.state).toBe("waiting_owner")
    expect(store.get(checked)?.state).not.toBe("done")
    expect(store.get(promised)?.state).not.toBe("done")
  })

  it("leaves a home on another forge host, a short ref, and a home that is not an issue", () => {
    expect(homeRefOf({ home: { kind: "issue", link: "https://gitlab.other.test/g/p/-/issues/1" } }, GITLAB)).toBeNull()
    expect(homeRefOf({ home: { kind: "idea", link: ISSUE } }, GITLAB)).toBeNull()
    expect(homeRefOf({ home: { kind: "issue", link: "noqta/noqta#412" } }, GITLAB)).toBeNull()
    expect(homeRefOf({ home: { kind: "issue", link: ISSUE } }, GITLAB)).toMatchObject({ provider: "github", ref: { project: "acme/app", number: 7, mr: false } })
  })

  it("reads GitHub only with a token", async () => {
    github = false
    const id = homed(PR)
    items["github:acme/app#12"] = { state: "merged", url: PR, closedAt: LATER }
    await sweep()
    expect(reads).toEqual([])
    expect(store.get(id)?.state).toBe("waiting_other")
  })

  it("reads each home once per checker interval, not every minute", async () => {
    homed(PR)
    items["github:acme/app#12"] = { state: "open", url: PR }
    await sweep()
    clock += 60_000
    await sweep()
    expect(reads).toHaveLength(1)
    clock += 10 * 60_000
    await sweep()
    expect(reads).toHaveLength(2)
  })

  it("is off with homeCloses: false", async () => {
    const id = homed(PR)
    items["github:acme/app#12"] = { state: "merged", url: PR, closedAt: LATER }
    settings.homeCloses = false
    await sweep()
    expect(reads).toEqual([])
    expect(store.get(id)?.state).toBe("waiting_other")
  })
})

describe("a retried hand-off replaces its failed one (#1522)", () => {
  const settle = () => runRequestsSweep({ store, settings, log: (m) => logs.push(m), now: clock })
  /** A request handed to devops as dlg-1. */
  const handed = () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
  }
  /** A second hand-off on the same request, from a later turn. */
  const again = (id: string, callee = "devops") => {
    start("t9")
    tracker.delegationStarted(dlg(id, callee))
    // The later turn is a request of its own; its hand-off belongs to t1.
    db.prepare("UPDATE request_links SET request_id = 'req-t1' WHERE ref = ?").run(id)
  }

  it("settles once the retry to the same agent came back done, though the first was lost in a restart", async () => {
    handed()
    tracker.delegationDone(dlg("dlg-1"), "lost", "This machine restarted while the work was in progress.")
    expect(store.get("req-t1")?.state).toBe("needs_attention")
    clock += 1000
    again("dlg-2")
    clock += 1000
    tracker.delegationDone(dlg("dlg-2"), "done", "redone: https://example.test/pr/5")
    clock += 25 * HOUR
    expect((await settle()).settled).toBe(1)
    expect(store.get("req-t1")).toMatchObject({ state: "done", evidence: "https://example.test/pr/5" })
  })

  it("still holds a failed hand-off when the one that came back went to another agent", async () => {
    handed()
    tracker.delegationDone(dlg("dlg-1"), "error", "crashed")
    clock += 1000
    again("dlg-2", "coder")
    clock += 1000
    tracker.delegationDone(dlg("dlg-2", "coder"), "done", "ok")
    clock += 25 * HOUR
    expect((await settle()).settled).toBe(0)
  })

  it("still holds a failed hand-off when the one that came back ran beside it, not after it", async () => {
    handed()
    clock += 1000
    again("dlg-2")
    clock += 1000
    tracker.delegationDone(dlg("dlg-1"), "error", "part A crashed")
    clock += 1000
    tracker.delegationDone(dlg("dlg-2"), "done", "part B: https://example.test/pr/6")
    clock += 25 * HOUR
    expect((await settle()).settled).toBe(0)
  })

  it("still holds a hand-off that ended waiting before the retry", async () => {
    handed()
    tracker.delegationDone(dlg("dlg-1"), "waiting", "waiting for the DNS")
    clock += 1000
    again("dlg-2")
    clock += 1000
    tracker.delegationDone(dlg("dlg-2"), "done", "ok")
    clock += 25 * HOUR
    expect((await settle()).settled).toBe(0)
  })

  /** dlg-1 is lost in a restart, then its retry dlg-2 comes back done. */
  const lostThenRetried = () => {
    handed()
    tracker.delegationDone(dlg("dlg-1"), "lost", "This machine restarted while the work was in progress.")
    clock += 1000
    again("dlg-2")
    clock += 1000
    tracker.delegationDone(dlg("dlg-2"), "done", "redone: https://example.test/pr/8")
  }

  it("still holds a lost part when a different part handed beside it came back done (#1520)", async () => {
    handed()
    clock += 1000
    again("dlg-2")
    clock += 1000
    tracker.delegationDone(dlg("dlg-2"), "done", "part B: https://example.test/pr/8")
    clock += 1000
    tracker.delegationDone(dlg("dlg-1"), "lost", "This machine restarted while the work was in progress.")
    clock += 25 * HOUR
    expect((await settle()).settled).toBe(0)
    expect(store.get("req-t1")?.state).toBe("needs_attention")
  })

  it("settles hand-offs kept without their agent once it is filled (#1520)", async () => {
    lostThenRetried()
    db.prepare("UPDATE request_links SET agent = NULL").run()
    clock += 25 * HOUR
    expect(store.fillLinkAgents(new Map([["dlg-1", "devops"], ["dlg-2", "devops"], ["dlg-x", "devops"]]))).toBe(2)
    expect(store.fillLinkAgents(new Map([["dlg-1", "coder"]]))).toBe(0)
    expect((await settle()).settled).toBe(1)
  })

  it("still holds a hand-off that failed after the last one came back", async () => {
    handed()
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    clock += 1000
    again("dlg-2")
    tracker.delegationDone(dlg("dlg-2"), "error", "crashed")
    clock += 25 * HOUR
    expect((await settle()).settled).toBe(0)
    expect(store.get("req-t1")?.state).toBe("needs_attention")
  })
})

describe("the owner writing again releases a wait the agent set (#1520)", () => {
  /** An open request, waiting on the owner with no caught question. */
  const waiting = () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
    store.waitOnOwner("req-t1", "Which key should I use?", clock)
    clock += 1000
  }
  const ownerTurn = (taskId: string, chatId = "chat-1") => tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId, taskId, messagePreview: "use the new one", fullMessage: "use the new one",
    at: new Date(clock).toISOString(), humanRoot: true, sender: { name: "Owner", id: "4242" },
  } as any)

  it("goes back to work when the owner writes in the same chat", () => {
    waiting()
    ownerTurn("t2")
    expect(store.get("req-t1")).toMatchObject({ state: "in_progress", question: null })
    expect(logs.join("\n")).toContain("req-t1 back to work: the owner wrote again in the chat")
  })

  it("keeps waiting when the owner writes in another chat", () => {
    waiting()
    ownerTurn("t2", "chat-2")
    expect(store.get("req-t1")?.state).toBe("waiting_owner")
  })

  it("keeps waiting with releaseOnOwnerTurn off", () => {
    settings.releaseOnOwnerTurn = false
    waiting()
    ownerTurn("t2")
    expect(store.get("req-t1")?.state).toBe("waiting_owner")
  })

  it("keeps waiting on a decision card the owner has not decided, and goes on once it is", () => {
    start("t1")
    tracker.cardRaised({ id: "card-1", raised_by: "coder", ask: "Ship it?" }, { channel: "telegram", chatId: "chat-1" })
    end("t1")
    clock += 1000
    ownerTurn("t2")
    expect(store.get("req-t1")?.state).toBe("waiting_owner")
    tracker.cardResolved({ id: "card-1", status: "decided", ask: "Ship it?", verdict: "approved" })
    expect(store.get("req-t1")?.state).toBe("in_progress")
    store.waitOnOwner("req-t1", "Which key should I use?", clock)
    clock += 1000
    ownerTurn("t3")
    expect(store.get("req-t1")?.state).toBe("in_progress")
  })

  it("leaves a promise waiting on the owner", () => {
    waiting()
    db.prepare("UPDATE requests SET promise = 1 WHERE id = 'req-t1'").run()
    ownerTurn("t2")
    expect(store.get("req-t1")?.state).toBe("waiting_owner")
  })
})

describe("hand-off agents from the delegation log (#1520)", () => {
  it("reads each start's callee, with its peer, and skips broken lines", () => {
    const log = [
      JSON.stringify({ type: "start", ts: 1, id: "dlg-a", caller: "coder", callee: "devops", request: "x" }),
      JSON.stringify({ type: "done", id: "dlg-a", status: "done", ts: 2 }),
      JSON.stringify({ type: "start", ts: 3, id: "dlg-b", caller: "pm", callee: "pm-ksi", peer: "clawd", request: "y" }),
      '{"type":"start","id":"dlg-c","cal',
    ].join("\n")
    expect([...delegationAgents(log)]).toEqual([["dlg-a", "devops"], ["dlg-b", "pm-ksi@clawd"]])
  })

  it("fills from the callee's runs when the compacted log kept only done lines", () => {
    db.exec("CREATE TABLE task_history (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, chat_id TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL)")
    const run = db.prepare("INSERT INTO task_history (id, agent_id, chat_id, status, started_at, finished_at) VALUES (?, ?, ?, 'ok', '', '')")
    // The run's agent differs from the chat's callee: the chat wins.
    run.run("r1", "devops-main", "a2a:coder:devops:dlg-1")
    run.run("r2", "pm", "a2a:coder:pm:dlg-2")
    run.run("r3", "coder", "telegram:chat-1")
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    tracker.delegationStarted(dlg("dlg-2", "pm"))
    tracker.delegationStarted(dlg("dlg-3", "qa"))
    end("t1")
    db.prepare("UPDATE request_links SET agent = NULL").run()
    const logPath = path.join(tmp, "delegations.jsonl")
    writeFileSync(logPath, [
      JSON.stringify({ type: "done", id: "dlg-1", status: "done", ts: 2 }),
      JSON.stringify({ type: "done", id: "dlg-2", status: "done", ts: 3 }),
      JSON.stringify({ type: "start", ts: 4, id: "dlg-3", caller: "coder", callee: "qa", request: "z" }),
    ].join("\n"))
    fillLinkAgents(store, db, logPath, (m) => logs.push(m))
    const agents = db.prepare("SELECT ref, agent FROM request_links WHERE kind = 'delegation' ORDER BY ref").all()
    expect(agents).toEqual([{ ref: "dlg-1", agent: "devops" }, { ref: "dlg-2", agent: "pm" }, { ref: "dlg-3", agent: "qa" }])
    expect(logs.join("\n")).toContain("3 hand-off links given their agent")
  })
})
