import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep } from "../src/requests/sweep"
import { homeChecker, homeRefOf, type HomeChecker } from "../src/requests/home-check"
import type { ForgeItem, ForgeReader } from "../src/requests/checkers/issue"

// Done work leaves the open list (#1522): a merged or closed home closes
// the request, and a retried hand-off no longer holds it after a failure.

const HOUR = 3_600_000
const GITLAB = "https://gitlab.example.test"
const PR = "https://github.com/acme/app/pull/12"
const ISSUE = "https://github.com/acme/app/issues/7"
const MR = `${GITLAB}/group/project/-/merge_requests/3`

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let settings: RequestSettings
let clock: number
let logs: string[]
let items: Record<string, ForgeItem | { error: string }>
let reads: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-home-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  settings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
  clock = 1_000_000
  logs = []
  items = {}
  reads = []
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
const checkHome: HomeChecker = homeChecker(() => ({ forge, gitlabUrl: GITLAB }))

function start(taskId: string) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId,
    messagePreview: "fix it", fullMessage: "fix the login bug",
    at: new Date(clock).toISOString(), humanRoot: true, sender: { name: "Owner", id: "4242" },
  } as any)
}
function end(taskId: string, over: Record<string, unknown> = {}) {
  tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, durationMs: 10, at: new Date(clock).toISOString(), ...over } as any)
}
const dlg = (id: string) => ({ id, caller: "coder", callee: "devops", origin: { channel: "telegram", chatId: "chat-1" } })

/** An open request, in progress, whose home is `link`. */
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
    items["github:acme/app#12"] = { state: "merged", url: PR, closedBy: "anis", closedAt: "2030-01-01T10:00:00Z" }
    const res = await sweep()
    expect(res.homesClosed).toBe(1)
    expect(store.get(id)).toMatchObject({ state: "done", verifyState: "verified", evidence: `home ${PR} merged by anis at 2030-01-01T10:00:00Z` })
    expect(logs.join("\n")).toContain(`${id} closed: home ${PR} merged`)
  })

  it("closes one that needs attention, as a blocked plan step leaves it", async () => {
    const id = homed(ISSUE)
    store.needsAttention(id, 'Step 2 "Merge after Anis yes" (coder) is blocked: no progress after 3 nudges', clock)
    items["github:acme/app#7"] = { state: "closed", url: ISSUE, stateReason: "completed" }
    await sweep()
    expect(store.get(id)?.state).toBe("done")
  })

  it("reads a merge request on this node's GitLab", async () => {
    const id = homed(MR)
    items["gitlab:group/project!3"] = { state: "merged", url: MR, closedBy: "devops" }
    await sweep()
    expect(store.get(id)).toMatchObject({ state: "done", evidence: `home ${MR} merged by devops` })
  })

  it("leaves an open home, one closed as not planned, and one it cannot read", async () => {
    const open = homed(PR, "a")
    const notPlanned = homed(ISSUE, "b")
    const unread = homed("https://github.com/acme/app/issues/99", "c")
    items["github:acme/app#12"] = { state: "open", url: PR }
    items["github:acme/app#7"] = { state: "closed", url: ISSUE, stateReason: "not_planned" }
    const res = await sweep()
    expect(res.homesClosed).toBe(0)
    for (const id of [open, notPlanned, unread]) expect(store.get(id)?.state).toBe("waiting_other")
    // Not a verify state: a request with no checker is not "unverified".
    expect(store.get(unread)?.verifyState).toBeNull()
  })

  it("never closes a request waiting on the owner, a promise, or one with its own checker", async () => {
    const waiting = homed(PR, "a")
    store.waitOnOwner(waiting, "Send the client the release note?", clock)
    const checked = homed(PR, "b")
    store.setLoop(checked, { closeWhen: { kind: "url", url: "https://example.test/live" } }, clock)
    const promised = homed(PR, "c")
    db.prepare("UPDATE requests SET promise = 1 WHERE id = ?").run(promised)
    items["github:acme/app#12"] = { state: "merged", url: PR }
    await sweep({ check: async () => ({ verdict: "not_met", detail: "not yet" }) })
    expect(store.get(waiting)?.state).toBe("waiting_owner")
    expect(store.get(checked)?.state).not.toBe("done")
    expect(store.get(promised)?.state).not.toBe("done")
  })

  it("leaves a home on another forge host, and a home that is not an issue", () => {
    expect(homeRefOf({ home: { kind: "issue", link: "https://gitlab.other.test/g/p/-/issues/1" } }, GITLAB)).toBeNull()
    expect(homeRefOf({ home: { kind: "idea", link: ISSUE } }, GITLAB)).toBeNull()
    expect(homeRefOf({ home: { kind: "issue", link: "noqta/noqta#412" } }, GITLAB)).toBeNull()
    expect(homeRefOf({ home: { kind: "issue", link: ISSUE } }, GITLAB)).toMatchObject({ provider: "github", ref: { project: "acme/app", number: 7, mr: false } })
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
    items["github:acme/app#12"] = { state: "merged", url: PR }
    settings.homeCloses = false
    await sweep()
    expect(reads).toEqual([])
    expect(store.get(id)?.state).toBe("waiting_other")
  })
})

describe("a retried hand-off replaces its failed one (#1522)", () => {
  const settle = () => runRequestsSweep({ store, settings, log: (m) => logs.push(m), now: clock })

  it("settles once the retry came back done, though the first one was lost in a restart", async () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
    tracker.delegationDone(dlg("dlg-1"), "lost", "This machine restarted while the work was in progress.")
    expect(store.get("req-t1")?.state).toBe("needs_attention")
    clock += 1000
    store.link("req-t1", "delegation", "dlg-2", clock)
    clock += 1000
    tracker.delegationDone(dlg("dlg-2"), "done", "redone: https://example.test/pr/5")
    clock += 25 * HOUR
    expect((await settle()).settled).toBe(1)
    expect(store.get("req-t1")).toMatchObject({ state: "done", evidence: "https://example.test/pr/5" })
  })

  it("still leaves a hand-off that failed after the last one came back", async () => {
    start("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    end("t1")
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    clock += 1000
    store.link("req-t1", "delegation", "dlg-2", clock)
    tracker.delegationDone(dlg("dlg-2"), "error", "crashed")
    clock += 25 * HOUR
    expect((await settle()).settled).toBe(0)
    expect(store.get("req-t1")?.state).toBe("needs_attention")
  })
})
