import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { gateEventsSince } from "../src/gates/events"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { DEFAULT_OWNER_CHECK, OwnerWordsCheck, wokenAgent } from "../src/requests/owner-check"
import { attentionText, runRequestsSweep } from "../src/requests/sweep"
import { cardWords, requestCard } from "../src/requests/card-view"
import { stalledWhy, waitsOn } from "../src/requests/loops"
import { wallPost } from "../src/daemon/wall-api"
import { JobStore } from "../src/jobs/store"
import { WORK_SCRIPT } from "../src/daemon/ui/pages/member-work.client"
import { issueCloseWhen, openPromise } from "../src/requests/promise"
import type { CloseProofCtx } from "../src/requests/close-proof"
import { checkIssue, type ForgeItem } from "../src/requests/checkers/issue"
import type { IssueSpec } from "../src/requests/checkers"

// noqta#876: the owner's open-request list must say what is true. Four
// causes kept held and overdue requests sitting with nobody woken.

const SAID = "post the release note, the staging link and the test report on the issue"
const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const ID = "req-t1"
const HOUR = 3_600_000

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-truth-876-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: SAID, fullMessage: SAID,
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
  store.progress(ID, 5_500)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const api = (body: Record<string, unknown>, closeProof?: CloseProofCtx) =>
  handleRequestsApi("POST", "/requests", { agentId: "coder", ...body }, {
    store, tracker, enabled: true, hasAgent: (id) => id === "coder", now: 6_000, closeProof,
    runningTurn: (agentId) => (agentId === "coder" ? { channel: "telegram", chatId: "chat-1" } : null),
  }, { taskId: "t1" })

describe("cause 1: an owner-words mismatch wakes the agent that closed it", () => {
  const MISMATCH = '{"verdict":"mismatch","why":"only the release note was posted"}'

  function check(over: Partial<typeof DEFAULT_OWNER_CHECK> = {}, hasAgent: (id: string) => boolean = (id) => id === "coder") {
    const woken: Array<{ agentId: string; text: string }> = []
    const c = new OwnerWordsCheck({
      store, settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true, ...over }), generate: async () => MISMATCH,
      wake: (r, text, agentId) => { woken.push({ agentId: agentId ?? r.agentId, text }) }, hasAgent, now: () => 10_000,
    })
    return { c, woken }
  }

  it("a reopen with 2 deliverables, both proven, asks a link for both again (#1952: the reopen clears the proofs)", async () => {
    store.setDeliverables(ID, ["release note", "staging link"])
    store.addProofs(ID, [
      { deliverable: "1", link: "https://git.example/g/p/-/issues/9#note_1" },
      { deliverable: "2", link: "https://git.example/g/p/-/issues/9#note_2" },
    ], 5_800)
    expect(api({ action: "done", id: ID, evidence: "https://git.example/g/p/-/issues/9#note_1" }).status).toBe(200)
    const { c, woken } = check()
    expect(await c.run()).toMatchObject({ reopened: [ID], woken: [ID] })
    expect(store.get(ID)!.deliverableProofs ?? []).toEqual([])
    expect(woken[0].text).toContain("Give a proof link for each")
    expect(woken[0].text).toContain("- 1. release note")
    expect(woken[0].text).toContain("- 2. staging link")
    expect(woken[0].text).toContain("proofs:[{deliverable:<number>")
  })

  it("wakes the closing agent once, asking a link for every deliverable, and the owner reads that it is the agent's", async () => {
    store.setDeliverables(ID, ["release note", "staging link", "test report"])
    store.addProofs(ID, [{ deliverable: "1", link: "https://git.example/g/p/-/issues/9#note_1" }], 5_800)
    expect(api({ action: "done", id: ID, evidence: "https://git.example/g/p/-/issues/9#note_1" }).status).toBe(200)
    const { c, woken } = check()
    expect(await c.run()).toMatchObject({ reopened: [ID], woken: [ID] })
    expect(woken).toHaveLength(1)
    expect(woken[0].agentId).toBe("coder")
    expect(woken[0].text).toContain("only the release note was posted")
    expect(woken[0].text).toContain("2. staging link")
    expect(woken[0].text).toContain("3. test report")
    expect(woken[0].text).toContain("1. release note")
    const r = store.get(ID)!
    expect(r.state).toBe("needs_attention")
    expect(wokenAgent(r)).toBe("coder")
    expect(waitsOn(r, { isAgent: () => true })).toEqual({ group: "agent", who: "coder" })
    const notice = attentionText(r, () => true)
    expect(notice).toContain("Waiting on: agent coder")
    expect(notice).toContain("Nothing needed from you: coder is woken to finish it.")
    expect(notice).not.toContain("Needed from you")
    expect(cardWords(r).need).toBe("Nothing: coder is woken to finish it.")
    // Once: nothing is left to judge.
    expect((await c.run()).woken).toEqual([])
  })

  it("wakes the request's agent for a settle, never the owner", async () => {
    expect(store.settle(ID, "https://example.com/pr/1", "handed work came back", 6_000)).toBe(true)
    const { c, woken } = check()
    expect((await c.run()).woken).toEqual([ID])
    expect(woken[0].agentId).toBe("coder")
  })

  it("with wakeOnMismatch off, or no such agent here, reopens for the owner only and says it is theirs", async () => {
    api({ action: "decline", id: ID, reason: "waits on the tester" })
    const off = check({ wakeOnMismatch: false })
    expect(await off.c.run()).toMatchObject({ reopened: [ID], woken: [] })
    expect(off.woken).toEqual([])
    const r = store.get(ID)!
    expect(wokenAgent(r)).toBeNull()
    expect(attentionText(r)).toContain("Needed from you")
  })

  it("an agent not on this node is not woken", async () => {
    api({ action: "decline", id: ID, reason: "waits on the tester" })
    const gone = check({}, () => false)
    expect(await gone.c.run()).toMatchObject({ reopened: [ID], woken: [] })
    expect(attentionText(store.get(ID)!)).toContain("Needed from you")
  })

  it("does not say woken when the wake failed", async () => {
    api({ action: "decline", id: ID, reason: "waits on the tester" })
    const c = new OwnerWordsCheck({
      store, settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true }), generate: async () => MISMATCH,
      wake: () => { throw new Error("agent gone") }, now: () => 10_000,
    })
    expect(await c.run()).toMatchObject({ reopened: [ID], woken: [] })
    expect(wokenAgent(store.get(ID)!)).toBeNull()
  })
})

describe("cause 2: an agent's done is held to each deliverable", () => {
  const block: CloseProofCtx = { mode: "block", ownerCheckOn: false }

  it("refuses one link for three things, with the missing list, and closes once each has its proof", () => {
    store.setDeliverables(ID, ["release note", "staging link", "test report"])
    const res = api({ action: "done", id: ID, evidence: "https://git.example/g/p/-/issues/9#note_1", proofs: [{ deliverable: 1, link: "https://git.example/g/p/-/issues/9#note_1" }] }, block)
    expect(res.status).toBe(409)
    expect((res.body as any).missing).toEqual(["2. staging link", "3. test report"])
    expect(store.get(ID)).toMatchObject({ state: "in_progress", verifyState: "proof_missing" })
    const ok = api({
      action: "done", id: ID, evidence: "https://git.example/g/p/-/issues/9#note_3",
      proofs: [{ deliverable: 2, link: "https://staging.example/" }, { deliverable: 3, link: "https://git.example/g/p/-/issues/9#note_3" }],
    }, block)
    expect(ok.status).toBe(200)
    expect(store.get(ID)?.state).toBe("done")
  })

  it("reads unread words first in block mode, and closes as before when off or with one deliverable", () => {
    const read: string[] = []
    const reading = api({ action: "done", id: ID, evidence: "https://example.com/x" }, { ...block, read: async (r) => { read.push(r.id) } })
    expect(reading.status).toBe(202)
    expect(read).toEqual([ID])
    expect(store.get(ID)?.state).toBe("in_progress")
    store.setDeliverables(ID, ["release note"])
    expect(api({ action: "done", id: ID, evidence: "https://example.com/x" }, block).status).toBe(200)
  })

  it("mode off closes on one link, as before", () => {
    store.setDeliverables(ID, ["release note", "staging link"])
    expect(api({ action: "done", id: ID, evidence: "https://example.com/x" }, { mode: "off", ownerCheckOn: false }).status).toBe(200)
  })
})

describe("cause 3: an overdue request wakes its agent, and a later touch does not hide it", () => {
  const sweepAt = (now: number, told: string[]) => runRequestsSweep({
    store, settings, log: () => {}, now, hasAgent: () => true,
    tellAgent: async (agentId, text) => { told.push(`${agentId}: ${text}`) },
  })

  it("wakes the agent at its due time once, though it was touched after it fell due", async () => {
    const due = 10 * HOUR
    store.setLoop(ID, { dueAt: due }, 6_000)
    store.touch(ID, due + 30 * 60_000)
    const told: string[] = []
    const res = await sweepAt(due + HOUR, told)
    expect(res.quiet).toBe(1)
    expect(res.duePushed).toBe(1)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatch(/^coder: \[agentx:request-overdue id=req-t1\] It fell due/)
    const r = store.get(ID)!
    expect(r.state).toBe("needs_attention")
    expect(r.attentionReason).toMatch(/^Past its due time \(.*\)\. Next step: coder, woken to finish it\.$/)
    expect(attentionText(r, () => true)).toContain("Nothing needed from you: coder is woken to finish it.")
    // Picked up again with the same due time: not woken twice for it.
    store.requestPickup(ID, due + 2 * HOUR)
    store.takePickups()
    store.progress(ID, due + 2 * HOUR)
    await sweepAt(due + 3 * HOUR, told)
    expect(told).toHaveLength(1)
  })

  it("reports an overdue owner wait once per due time and keeps it open for the answer", async () => {
    const due = 10 * HOUR
    store.setLoop(ID, { dueAt: due }, 6_000)
    store.waitOnOwner(ID, "Can I proceed?", 7_000)
    const notices: string[] = []
    const woken: string[] = []
    const sweep = (now: number) => runRequestsSweep({
      store, settings, log: () => {}, now, hasAgent: () => true,
      tellAgent: async (agent) => { woken.push(agent) },
      notify: async (_title, _line, _request, kind, key) => {
        notices.push(`${kind}:${key}`)
        throw new Error("Push unavailable")
      },
    })
    await sweep(due + 1)
    await sweep(due + 2)
    expect(store.get(ID)).toMatchObject({
      state: "waiting_owner",
      attentionReason: expect.stringContaining("Can I proceed?"),
    })
    expect(notices).toEqual([`notice:request:${ID}:due:${due}:${due + 1}`])
    expect(gateEventsSince(db, "due-wake", 0)).toMatchObject([{ ref: ID, outcome: "reported" }])
    expect(woken).toEqual([])

    const moved = due + HOUR
    store.setLoop(ID, { dueAt: moved }, due + 3)
    await sweep(moved + 1)
    store.setLoop(ID, { dueAt: due }, moved + 2)
    expect(store.get(ID)?.attentionReason).toBeNull()
    await sweep(moved + 3)
    expect(notices).toEqual([
      `notice:request:${ID}:due:${due}:${due + 1}`,
      `notice:request:${ID}:due:${moved}:${moved + 1}`,
      `notice:request:${ID}:due:${due}:${moved + 3}`,
    ])
    store.progress(ID, moved + 4)
    expect(store.get(ID)).toMatchObject({ state: "in_progress", attentionReason: null })
  })

  it("a new due time wakes it again", async () => {
    const told: string[] = []
    store.setLoop(ID, { dueAt: 10 * HOUR }, 6_000)
    await sweepAt(11 * HOUR, told)
    store.progress(ID, 11 * HOUR)
    store.setLoop(ID, { dueAt: 13 * HOUR }, 11 * HOUR)
    await sweepAt(12 * HOUR, told)
    expect(told).toHaveLength(1)
    await sweepAt(14 * HOUR, told)
    expect(told).toHaveLength(2)
  })
})

describe("cause 4: a promise that links an issue closes when the work is done", () => {
  it("reads a GitLab or GitHub issue or merge request link in its words", () => {
    expect(issueCloseWhen("I will post the list on https://gitlab.example.com/grp/proj/-/issues/849 by 16:00Z.", "prm-1", 7)).toEqual({
      kind: "issue", provider: "gitlab", ref: "https://gitlab.example.com/grp/proj/-/issues/849", notePattern: "prm-1", after: 7,
    })
    expect(issueCloseWhen("review https://github.com/acme/app/pull/12, then merge", "prm-2", 7)).toMatchObject({ provider: "github", ref: "https://github.com/acme/app/pull/12" })
    expect(issueCloseWhen("send the deck by noon", "prm-3", 7)).toBeNull()
    expect(issueCloseWhen("see https://example.com/blog/issues", "prm-4", 7)).toBeNull()
  })

  it("an item already closed or merged does not close it; a later note with its id does", async () => {
    const spec = issueCloseWhen("deploy after https://github.com/acme/app/pull/12 merges", "prm-5", 1_000) as IssueSpec
    const item = (state: ForgeItem["state"], notes: string[] = [], noteTimes: number[] = []): ForgeItem => ({ state, notes, noteTimes, url: "https://github.com/acme/app/pull/12" })
    const check = (it: ForgeItem) => checkIssue(spec, { forge: async () => it })
    expect((await check(item("merged"))).verdict).toBe("not_met")
    expect((await check(item("closed"))).verdict).toBe("not_met")
    expect((await check(item("merged", ["done prm-5"], [500]))).verdict).toBe("not_met")
    expect((await check(item("merged", ["done prm-5"], [2_000]))).verdict).toBe("met")
  })

  it("a promise with an issue home is read by the home check", () => {
    const p = openPromise(store, {
      agentId: "coder", owedTo: "owner", text: "post the list", channel: "telegram", chatId: "chat-1",
      home: { kind: "issue", link: "https://github.com/acme/app/issues/7" }, now: 6_000,
    })
    expect(store.homesDue(7_000).map((h) => h.request.id)).toContain(p.id)
  })
})

// #2085 G2 (design v5 S″, v6 S‴): an owner wait past its due time is
// reported to the owner once per due time, stays waiting_owner, and every
// owner surface shows the due line.
describe("#2085: the due time of a request waiting on the owner", () => {
  const due = 10 * HOUR
  const sweep = (now: number, notices: string[], fail?: (id: string) => boolean, woken: string[] = []) => runRequestsSweep({
    store, settings, log: () => {}, now, hasAgent: () => true,
    tellAgent: async (agent) => { woken.push(agent) },
    notify: async (_title, _line, request, kind, key) => {
      notices.push(`${request.id}:${kind}:${key}`)
      if (fail?.(request.id)) throw new Error("Push unavailable")
    },
  })

  it("S9: card, Wall, stall line and CLI detail show the due line on the wait, and the question without it", () => {
    store.setLoop(ID, { dueAt: due }, 6_000)
    store.waitOnOwner(ID, "Can I proceed with the long migration plan?".repeat(6), 7_000)
    const before = store.get(ID)!
    expect(requestCard(before, store).why).toBe(before.question)
    const line = `Due 10:00Z, still waiting on the owner: ${before.question}`
    expect(store.noteOwnerDue(before, line, due + 1)).toBe(true)
    const after = store.get(ID)!
    expect(requestCard(after, store).why).toBe(line)
    expect(stalledWhy(after, 24, due + 2)).toBe(line)
    const post = wallPost(after, { store, db: null, now: due + 2, staleAfterHours: 24, isAgent: () => true })
    // The whole question is kept on the Wall, not cut at 200 characters.
    expect(post.blocked?.why).toContain(before.question!.slice(-40))
    expect(WORK_SCRIPT).toContain("r.state === 'waiting_owner' ? (r.attentionReason || r.question)")
  })

  it("S10: a push that throws for one row does not stop the next", async () => {
    const second = "req-t2"
    store.addWallPost({ id: second, agentId: "coder", text: "second", now: 5_500 })
    for (const id of [ID, second]) {
      store.progress(id, 5_600)
      store.setLoop(id, { dueAt: due }, 6_000)
      store.waitOnOwner(id, "Which one?", 7_000)
    }
    const notices: string[] = []
    await sweep(due + 1, notices, (id) => id === ID)
    expect(notices).toHaveLength(2)
    expect(gateEventsSince(db, "due-wake", 0).filter((e) => e.outcome === "reported").map((e) => e.ref).sort()).toEqual([ID, second].sort())
  })

  it("S6/S12: after the report the owner's answer releases it, the line goes, and the same due time wakes nobody", async () => {
    store.setLoop(ID, { dueAt: due }, 6_000)
    store.waitOnOwner(ID, "Can I proceed?", 7_000)
    const notices: string[] = []
    const woken: string[] = []
    await sweep(due + 1, notices, undefined, woken)
    expect(notices).toHaveLength(1)
    expect(store.releaseOwnerWaits("coder", "telegram", "chat-1", due + 2)).toEqual([ID])
    expect(store.get(ID)).toMatchObject({ state: "in_progress", attentionReason: null })
    await sweep(due + 3, notices, undefined, woken)
    expect(woken).toEqual([])
    expect(notices).toHaveLength(1)
  })

  it("S3: a wait on the owner names the owner, so it is never stalled as waiting on nobody", () => {
    const jobs = new JobStore(db)
    const withJobs = new RequestStore(db)
    db.prepare("UPDATE requests SET job_state = 'continue', wake_at = ? WHERE id = ?").run(due, ID)
    withJobs.waitOnOwner(ID, "Can I proceed?", 7_000)
    expect(db.prepare("SELECT waiting_on, job_state, wake_at FROM requests WHERE id = ?").get(ID))
      .toEqual({ waiting_on: "owner", job_state: "working", wake_at: null })
    expect(jobs.unheldCandidates().map((j) => j.id)).not.toContain(ID)
  })
})
