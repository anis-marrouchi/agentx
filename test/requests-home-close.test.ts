import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { PlanStore } from "../src/requests/plan-store"
import { endPlan } from "../src/requests/plan-sweep"
import { runRequestsSweep } from "../src/requests/sweep"
import { homeFinished } from "../src/requests/home-close"
import type { ForgeItem, ForgeReader } from "../src/requests/checkers/issue"

// --- #1522: a closed or merged home closes the request; a retried
// hand-off replaces its failed one ---

const HOUR = 3_600_000
const GL = "https://gitlab.example.test"
const ON: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let plans: PlanStore
let settings: RequestSettings
let clock: number
let logs: string[]
let told: string[]
let reads: string[]
/** What the forge says, by "provider:project#n" (or "!n" for a merge request). */
let forge: Map<string, ForgeItem | { error: string }>

const read: ForgeReader = async (provider, ref) => {
  const key = `${provider}:${ref.project}${ref.mr && provider === "gitlab" ? "!" : "#"}${ref.number}`
  reads.push(key)
  return forge.get(key) ?? { error: "not found (or not visible to the connector)" }
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-home-close-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  plans = new PlanStore(db)
  settings = { ...ON }
  clock = 1_000_000_000
  logs = []
  told = []
  reads = []
  forge = new Map()
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** An open request in progress, its home a forge link. */
function open(id: string, link: string | null, over: { channel?: string; chatId?: string } = {}) {
  store.addCandidate({ id, runId: `run-${id}`, channel: over.channel ?? "telegram", chatId: over.chatId ?? "chat-1", agentId: "coder", text: "ship the fix", now: clock })
  store.progress(id, clock)
  if (link) store.setHome(id, { kind: "issue", link }, clock)
}

const sweep = (over: Partial<Parameters<typeof runRequestsSweep>[0]> = {}) => runRequestsSweep({
  store, settings, log: (m) => logs.push(m), now: clock,
  notify: async (_title, message, r) => { told.push(`${r.id}|${message}`) },
  home: { read, gitlabUrl: GL },
  endPlan: (id, why, now) => { endPlan(plans, id, why, now) },
  ...over,
})

const merged: ForgeItem = { state: "merged", url: "https://github.com/example-org/app/pull/7", closedBy: "reviewer", closedAt: "2026-10-28T00:51:00Z", pullRequest: true }

describe("the home check", () => {
  it("closes a request whose pull request was merged, verified, and tells nobody", async () => {
    open("req-1", "https://github.com/example-org/app/pull/7")
    forge.set("github:example-org/app#7", merged)
    const result = await sweep()
    expect(result.homeClosed).toBe(1)
    expect(store.get("req-1")).toMatchObject({
      state: "done", verifyState: "verified",
      evidence: "https://github.com/example-org/app/pull/7 merged by reviewer on 2026-10-28 00:51 UTC",
    })
    expect(store.get("req-1")?.proof?.kind).toBe("check")
    expect(told).toEqual([])
    expect(logs).toContain("[requests] req-1 closed: home example-org/app#7 merged by reviewer")
  })

  it("closes one whose issue was closed as completed, and one whose GitLab merge request was merged", async () => {
    open("req-1", "https://github.com/example-org/app/issues/12")
    open("req-2", null, { channel: "gitlab", chatId: "example-group/site:merge_request:38" })
    forge.set("github:example-org/app#12", { state: "closed", url: "https://github.com/example-org/app/issues/12", closedBy: "owner", stateReason: "completed" })
    forge.set("gitlab:example-group/site!38", { state: "merged", url: `${GL}/example-group/site/-/merge_requests/38`, closedBy: "devops" })
    expect((await sweep()).homeClosed).toBe(2)
    expect(store.get("req-1")?.state).toBe("done")
    expect(store.get("req-2")?.evidence).toBe(`${GL}/example-group/site/-/merge_requests/38 merged by devops`)
  })

  it("ends the request's active plan, its steps left kept and marked skipped", async () => {
    open("req-1", "https://github.com/example-org/app/pull/7")
    plans.create("req-1", "coder", [
      { name: "Fix it", kind: "work", agentId: "coder", doneWhen: "PR open", needsApproval: false },
      { name: "Merge after the owner says yes", kind: "work", agentId: "coder", doneWhen: "merged", needsApproval: false },
    ], clock)
    plans.updateStep("req-1", 1, { state: "done" })
    plans.updateStep("req-1", 2, { state: "blocked", note: "no progress after 3 nudges" })
    forge.set("github:example-org/app#7", merged)
    await sweep()
    expect(plans.get("req-1")?.state).toBe("closed")
    const steps = plans.steps("req-1")
    expect(steps.map((s) => s.state)).toEqual(["done", "skipped"])
    expect(steps[1].note).toBe("home closed: example-org/app#7 merged by reviewer")
    // Closed, not done: no "Plan finished" summary goes to the owner.
    expect(plans.awaitingSummary()).toEqual([])
  })

  it("leaves open homes, not-planned issues, unmerged pull requests and unreadable homes alone", async () => {
    open("req-open", "https://github.com/example-org/app/issues/1")
    open("req-np", "https://github.com/example-org/app/issues/2")
    open("req-dup", "https://github.com/example-org/app/issues/3")
    open("req-pr", "https://github.com/example-org/app/pull/4")
    open("req-gone", "https://github.com/example-org/app/issues/5")
    forge.set("github:example-org/app#1", { state: "open", url: "u1" })
    forge.set("github:example-org/app#2", { state: "closed", url: "u2", stateReason: "not_planned" })
    forge.set("github:example-org/app#3", { state: "closed", url: "u3", stateReason: "duplicate" })
    forge.set("github:example-org/app#4", { state: "closed", url: "u4", pullRequest: true })
    const result = await sweep()
    expect(result.homeClosed).toBe(0)
    expect(reads).toHaveLength(5)
    for (const id of ["req-open", "req-np", "req-dup", "req-pr", "req-gone"]) expect(store.get(id)?.state).toBe("in_progress")
  })

  it("leaves a request waiting on the owner alone, and one with its own check", async () => {
    open("req-1", "https://github.com/example-org/app/pull/7")
    store.waitOnOwner("req-1", "Merge it?", clock)
    open("req-2", "https://github.com/example-org/app/pull/7")
    store.setLoop("req-2", { closeWhen: { kind: "url", url: "https://example.test/" } }, clock)
    forge.set("github:example-org/app#7", merged)
    expect((await sweep()).homeClosed).toBe(0)
    expect(reads).toEqual([])
    expect(store.get("req-1")?.state).toBe("waiting_owner")
  })

  it("reads each home once per checkEveryMinutes", async () => {
    open("req-1", "https://github.com/example-org/app/issues/1")
    forge.set("github:example-org/app#1", { state: "open", url: "u1" })
    await sweep()
    clock += 9 * 60_000
    await sweep()
    expect(reads).toHaveLength(1)
    clock += 2 * 60_000
    forge.set("github:example-org/app#1", { state: "closed", url: "u1", stateReason: "completed" })
    expect((await sweep()).homeClosed).toBe(1)
  })

  it("is off with homeCloses: false", async () => {
    settings.homeCloses = false
    open("req-1", "https://github.com/example-org/app/pull/7")
    forge.set("github:example-org/app#7", merged)
    expect((await sweep()).homeClosed).toBe(0)
    expect(reads).toEqual([])
    expect(store.get("req-1")?.state).toBe("in_progress")
  })

  it("homeFinished: merged or completed only", () => {
    expect(homeFinished({ state: "merged", url: "" }, true)).toBe("merged")
    expect(homeFinished({ state: "closed", url: "" }, false)).toBe("closed")
    expect(homeFinished({ state: "closed", url: "" }, true)).toBeNull()
    expect(homeFinished({ state: "open", url: "" }, false)).toBeNull()
  })
})

describe("a retried hand-off", () => {
  let tracker: RequestTracker
  beforeEach(() => {
    tracker = new RequestTracker(store, () => settings, (m) => logs.push(m), () => clock)
  })

  const turn = (taskId: string) => tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, messagePreview: "deploy it", fullMessage: "deploy it",
    at: new Date(clock).toISOString(), humanRoot: true, sender: { name: "Owner", id: "4242" },
  } as any)
  const end = (taskId: string) => tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, durationMs: 10, at: new Date(clock).toISOString() } as any)
  const dlg = (id: string, callee = "devops") => ({ id, caller: "coder", callee, origin: { channel: "telegram", chatId: "chat-1" } })

  /** dlg-1 to devops ends `first`; its retry dlg-2 to `retryTo` comes back done. */
  function retried(first: "error" | "lost", retryTo = "devops", lostAfter = false) {
    turn("t1")
    tracker.delegationStarted(dlg("dlg-1"))
    clock += 1000
    tracker.delegationStarted(dlg("dlg-2", retryTo))
    end("t1")
    const id = store.byLink("delegation", "dlg-1")!.id
    if (!lostAfter) tracker.delegationDone(dlg("dlg-1"), first, "weekly limit")
    clock += 1000
    tracker.delegationDone(dlg("dlg-2", retryTo), "done", "deployed: https://example.test/deploys/9")
    // A lost one reported after its retry came back keeps it raised.
    if (lostAfter) tracker.delegationDone(dlg("dlg-1"), first, "This machine restarted while the work was in progress.")
    return id
  }

  it("settles once the retry has been back for staleAfterHours", async () => {
    const id = retried("error")
    expect(store.get(id)?.state).toBe("in_progress")
    clock += 25 * HOUR
    expect((await sweep()).settled).toBe(1)
    expect(store.get(id)).toMatchObject({ state: "done", evidence: "https://example.test/deploys/9" })
  })

  it("settles a request raised only for a hand-off lost after its retry came back", async () => {
    const id = retried("lost", "devops", true)
    expect(store.get(id)).toMatchObject({ state: "needs_attention" })
    expect(store.get(id)?.attentionReason).toMatch(/^The work handed to devops was lost in a restart/)
    clock += 23 * HOUR
    expect((await sweep()).settled).toBe(0)
    clock += 2 * HOUR
    expect((await sweep()).settled).toBe(1)
    expect(store.get(id)?.state).toBe("done")
  })

  it("does not count a done hand-off to another agent as the retry", async () => {
    const id = retried("lost", "qa", true)
    clock += 25 * HOUR
    expect((await sweep()).settled).toBe(0)
    expect(store.get(id)?.state).toBe("needs_attention")
  })
})
