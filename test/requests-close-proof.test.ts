import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { checkLoops } from "../src/requests/loops"
import { checkHomes } from "../src/requests/home-check"
import { runRequestsSweep } from "../src/requests/sweep"
import { handleRequestsCall } from "../src/requests/daemon-api"
import { DEFAULT_OWNER_CHECK, OwnerWordsCheck, ownerCheckPrompt } from "../src/requests/owner-check"
import { DeliverablesReader, readDeliverables } from "../src/requests/deliverables-reader"
import { closeByCheckNow, HELD_TEXT, planDeliverables, sameCheckDetail, type CloseProofCtx } from "../src/requests/close-proof"
import { readSignals } from "../src/improve/signals"
import type { PlanStep } from "../src/requests/plan-store"

// retro:01M70Z38BBZYRBBCZW2T1S3T3K — neutral fixture: a release with six
// stages the owner asked to see confirmed one by one, closed by a check on
// the tracker issue's state alone.
const SAID = "Post a note on the tracker issue for each stage of the release (build, review, merge, staging, test, production) as it happens, until production."
const STAGES = ["build", "review", "merge", "staging", "test", "production"]
const ISSUE = "https://git.example.test/example/tracker/-/issues/7"
const MET = `${ISSUE} is closed`
const CLOSE_WHEN = { kind: "issue", provider: "gitlab", ref: "example/tracker#7", state: "closed" }
const noteLink = (i: number) => `${ISSUE}#note_${1000 + i}`
const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const ID = "req-t1"
const MIN = 60_000

let tmp: string
let db: Database.Database
let store: RequestStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-close-proof-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  const tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: SAID, fullMessage: SAID,
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
  store.progress(ID, 5_500)
  store.setLoop(ID, { closeWhen: CLOSE_WHEN as any }, 5_500)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const met = async () => ({ verdict: "met" as const, detail: MET })
const signals = (kind: string) => readSignals(db, 0).filter((s) => s.kind === kind)
const loop = (now: number, proof: CloseProofCtx) => checkLoops(store, met, { everyMinutes: 10, now, log: () => {}, proof })

function api(body: Record<string, unknown>, now: number, closeProof?: CloseProofCtx, check = met) {
  return handleRequestsCall("POST", "/requests", { agentId: "coder", ...body }, {
    store, tracker: undefined as any, enabled: true, hasAgent: (id) => id === "coder", now,
    runningTurn: (agentId) => (agentId === "coder" ? { channel: "telegram", chatId: "chat-1" } : null),
    check, closeProof,
  }, { taskId: "t1" })
}

function ownerCheck(verdict: "match" | "mismatch", now: () => number) {
  const prompts: string[] = []
  const c = new OwnerWordsCheck({
    store, settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true }),
    generate: async (p) => { prompts.push(p); return JSON.stringify({ verdict, why: verdict === "match" ? "each stage has its note" : "only the issue state is shown" }) },
    now,
  })
  return { c, prompts }
}

describe("proof per deliverable before a close by check (Part A)", () => {
  beforeEach(() => { store.setDeliverables(ID, STAGES) })

  it("warn: closes, with exactly one signal naming the six deliverables", async () => {
    const proof: CloseProofCtx = { mode: "warn", ownerCheckOn: false }
    expect((await loop(10 * MIN, proof)).closed).toBe(1)
    expect(store.get(ID)!.state).toBe("done")
    const s = signals("close_proof_missing")
    expect(s).toHaveLength(1)
    for (const [i, n] of STAGES.entries()) expect(s[0].detail).toContain(`${i + 1}. ${n}`)
  })

  it("block: stays open, the refusal lists the six, and the agent is told once", async () => {
    const told: string[] = []
    const proof: CloseProofCtx = { mode: "block", ownerCheckOn: false, tell: async (_a, t) => { told.push(t) }, askBudget: { left: 3 } }
    for (let i = 1; i <= 3; i++) expect((await loop(i * 11 * MIN, proof)).closed).toBe(0)
    const r = store.get(ID)!
    expect(r.state).toBe("in_progress")
    expect(r.verifyState).toBe("proof_missing")
    for (const n of STAGES) expect(r.verifyDetail).toContain(n)
    expect(told).toHaveLength(1)
    expect(signals("close_proof_missing")).toHaveLength(0)
  })

  it("with six note links: closes in warn and in block, and the owner-words check reads all six", async () => {
    for (const mode of ["warn", "block"] as const) {
      db.prepare("UPDATE requests SET state = 'in_progress', closed_at = NULL, owner_check = NULL, deliverable_proofs = NULL WHERE id = ?").run(ID)
      const proofs = STAGES.map((_, i) => ({ deliverable: i + 1, link: noteLink(i) }))
      expect((await api({ action: "step", id: ID, proofs }, 6_000)).status).toBe(200)
      expect((await loop(mode === "warn" ? 20 * MIN : 40 * MIN, { mode, ownerCheckOn: true })).closed).toBe(1)
      const { c, prompts } = ownerCheck("match", () => 50 * MIN)
      expect((await c.run()).reopened).toEqual([])
      for (let i = 0; i < 6; i++) expect(prompts[0]).toContain(noteLink(i))
      expect(store.get(ID)).toMatchObject({ state: "done", ownerCheck: "match" })
    }
    expect(signals("close_proof_missing")).toHaveLength(0)
  })

  it("block through done: 409 with the missing items, then closes once the links are given", async () => {
    const proof: CloseProofCtx = { mode: "block", ownerCheckOn: false }
    const first = await api({ action: "done", id: ID, evidence: "all stages done" }, 7_000, proof)
    expect(first.status).toBe(409)
    expect((first.body as any).missing).toHaveLength(6)
    expect(store.get(ID)!.proofAskedAt).toBe(7_000)
    const proofs = STAGES.map((n, i) => ({ deliverable: n, link: noteLink(i) }))
    const second = await api({ action: "done", id: ID, evidence: "all stages done", proofs }, 8_000, proof)
    expect(second.status).toBe(200)
    expect(store.get(ID)!.state).toBe("done")
  })

  it("refuses the checked issue or the home as a proof, and takes a merge request link", async () => {
    store.setHome(ID, { kind: "issue", link: ISSUE }, 6_000)
    expect((await api({ action: "step", id: ID, proofs: [{ deliverable: 1, link: ISSUE }] }, 6_000)).status).toBe(400)
    expect((await api({ action: "step", id: ID, proofs: [{ deliverable: 9, link: noteLink(0) }] }, 6_000)).status).toBe(400)
    expect((await api({ action: "step", id: ID, proofs: [{ deliverable: "deploy", link: noteLink(0) }] }, 6_000)).status).toBe(400)
    const mr = "https://git.example.test/example/app/-/merge_requests/3"
    const ok = await api({ action: "step", id: ID, proofs: [{ deliverable: "merge", link: mr }, { deliverable: "merge", link: mr }] }, 6_000)
    expect((ok.body as any).proofsAdded).toBe(1)
  })

  it("one deliverable with a state-only check closes as today, in block", async () => {
    db.prepare("UPDATE requests SET deliverables = ? WHERE id = ?").run(JSON.stringify(["close the tracker issue"]), ID)
    expect((await loop(10 * MIN, { mode: "block", ownerCheckOn: false })).closed).toBe(1)
  })

  it("off changes nothing: closes with no proof and no signal", async () => {
    expect((await loop(10 * MIN, { mode: "off", ownerCheckOn: false })).closed).toBe(1)
    expect(signals("close_proof_missing")).toHaveLength(0)
  })

  it("a promise closes by its check under the same rule", async () => {
    db.prepare("UPDATE requests SET promise = 1, owed_to = 'owner' WHERE id = ?").run(ID)
    expect((await loop(10 * MIN, { mode: "block", ownerCheckOn: false })).closed).toBe(0)
    expect(store.get(ID)!.verifyState).toBe("proof_missing")
  })
})

describe("reading the deliverables (B5)", () => {
  it("reads the list once, and an unread one at the gate in warn", async () => {
    const reader = new DeliverablesReader({ store, perCheck: () => 2, generate: async () => JSON.stringify({ deliverables: STAGES }) })
    const proof: CloseProofCtx = { mode: "warn", ownerCheckOn: false, read: (r) => reader.read(r) }
    expect((await loop(10 * MIN, proof)).closed).toBe(1)
    expect(store.get(ID)!.deliverables).toEqual(STAGES)
    expect(signals("close_proof_missing")).toHaveLength(1)
  })

  it("after three failed reads the list is unreadable and counts as one", async () => {
    const lines: string[] = []
    const reader = new DeliverablesReader({ store, perCheck: () => 2, generate: async () => { throw new Error("no answer") }, log: (l) => lines.push(l) })
    const proof: CloseProofCtx = { mode: "block", ownerCheckOn: false, read: (r) => reader.read(r) }
    expect((await loop(10 * MIN, proof)).closed).toBe(0)
    expect(store.get(ID)!.verifyState).toBe("proof_missing")
    expect((await loop(21 * MIN, proof)).closed).toBe(0)
    expect((await loop(32 * MIN, proof)).closed).toBe(1)
    expect(store.get(ID)!.deliverables).toBe("unreadable")
    expect(lines.filter((l) => l.includes("could not be read"))).toHaveLength(1)
  })

  it("without a reader an unread list counts as one", async () => {
    expect((await loop(10 * MIN, { mode: "block", ownerCheckOn: false })).closed).toBe(1)
  })

  it("reads only a list of strings", () => {
    expect(readDeliverables('{"deliverables":["a","b"]}')).toEqual(["a", "b"])
    expect(readDeliverables('{"deliverables":[]}')).toBeNull()
    expect(readDeliverables("no json")).toBeNull()
  })
})

describe("a new owner note asks again (B7)", () => {
  it("clears the list, the proofs and the asked mark", async () => {
    store.setDeliverables(ID, STAGES)
    store.addProofs(ID, [{ deliverable: "1", link: noteLink(0) }], 6_000)
    store.markProofAsked(ID, 6_000)
    store.handOff(ID, "coder", "also add the rollback stage", 7_000)
    expect(store.get(ID)).toMatchObject({ deliverables: null, deliverableProofs: [], proofAskedAt: null })
  })
})

describe("a tracked plan's steps are the deliverables (B6)", () => {
  const step = (idx: number, name: string, state: string, evidence: string | null): PlanStep =>
    ({ requestId: ID, idx, name, state, evidence, updatedAt: 6_000 + idx } as any)
  const link = (t: string) => t.match(/https?:\/\/\S+/)?.[0] ?? null

  it("each step's own link is its proof; skipped steps are left out", () => {
    const steps = [step(1, "build", "done", `built ${noteLink(0)}`), step(2, "review", "active", null), step(3, "extra", "skipped", null)]
    const plan = planDeliverables(steps, link)!
    expect(plan.names).toEqual(["build", "review"])
    const out = closeByCheckNow(store, ID, MET, MET, 10 * MIN, { mode: "block", ownerCheckOn: false, plan: () => plan })
    expect(out).toMatchObject({ outcome: "blocked", missing: ["2. review"] })
  })

  it("refuses proofs on a request with a plan", async () => {
    const res = handleRequestsCall("POST", "/requests", { agentId: "coder", action: "step", id: ID, proofs: [{ deliverable: 1, link: noteLink(0) }] }, {
      store, tracker: undefined as any, enabled: true, hasAgent: () => true, now: 6_000,
      runningTurn: () => ({ channel: "telegram", chatId: "chat-1" }), plans: { get: () => ({ state: "active" }) } as any,
    }, { taskId: "t1" })
    expect((await res).status).toBe(400)
  })
})

describe("reopen once (Part B)", () => {
  /** Close by check, then the owner-words check finds a mismatch. */
  async function closeAndMismatch(mode: "off" | "warn" = "off") {
    expect((await loop(10 * MIN, { mode, ownerCheckOn: true })).closed).toBe(1)
    expect((await ownerCheck("mismatch", () => 11 * MIN).c.run()).reopened).toEqual([ID])
  }

  it("13 checks over two hours after a mismatch: one reopen, one notice, no second close", async () => {
    await closeAndMismatch()
    let notices = 0
    let closes = 0
    for (let i = 1; i <= 13; i++) {
      const now = 11 * MIN + i * 10 * MIN
      const res = await runRequestsSweep({
        store, settings: { ...settings, ownerCheck: { enabled: true } }, now, log: () => {},
        check: met, notify: async () => { notices++ },
      })
      closes += res.verified
      await ownerCheck("mismatch", () => now).c.run()
    }
    expect(closes).toBe(0)
    expect(notices).toBe(1)
    expect(signals("owner_check_mismatch")).toHaveLength(1)
    expect(store.get(ID)).toMatchObject({ state: "needs_attention", verifyState: "held" })
  })

  it("a row already at mismatch at upgrade is held at the first check (B2)", async () => {
    db.prepare("UPDATE requests SET state = 'needs_attention', evidence = ?, owner_check = 'mismatch', owner_check_at = ? WHERE id = ?").run(MET, 9 * MIN, ID)
    expect((await loop(10 * MIN, { mode: "off", ownerCheckOn: true })).closed).toBe(0)
    expect(store.get(ID)!.verifyDetail).toBe(HELD_TEXT)
  })

  it("the agent's new words on done are not new (B1): 409, no close", async () => {
    await closeAndMismatch()
    const res = await api({ action: "done", id: ID, evidence: "now really finished" }, 20 * MIN, { mode: "off", ownerCheckOn: true })
    expect(res.status).toBe(409)
    expect((res.body as any).held).toBe(true)
    expect(store.get(ID)!.state).toBe("needs_attention")
  })

  it("a changed checker detail closes it again (B1)", async () => {
    await closeAndMismatch()
    const changed = async () => ({ verdict: "met" as const, detail: `${ISSUE} is closed; 0 open items left` })
    expect((await checkLoops(store, changed, { everyMinutes: 10, now: 30 * MIN, log: () => {}, proof: { mode: "off", ownerCheckOn: true } })).closed).toBe(1)
  })

  it("an owner send-back alone does not lift the hold; a proof given after it does (B3)", async () => {
    await closeAndMismatch()
    store.addProofs(ID, [{ deliverable: "1", link: noteLink(0) }], 10.5 * MIN) // before the reopen: not new
    store.handOff(ID, "coder", "do the six stages", 15 * MIN)
    store.takePickups()
    expect((await loop(30 * MIN, { mode: "off", ownerCheckOn: true })).closed).toBe(0)
    store.addProofs(ID, [{ deliverable: "1", link: noteLink(0) }], 35 * MIN)
    expect((await loop(45 * MIN, { mode: "off", ownerCheckOn: true })).closed).toBe(1)
  })

  it("with ownerCheck off, nothing is held", async () => {
    db.prepare("UPDATE requests SET evidence = ?, owner_check = 'mismatch', owner_check_at = ? WHERE id = ?").run(MET, 9 * MIN, ID)
    expect((await loop(10 * MIN, { mode: "off", ownerCheckOn: false })).closed).toBe(1)
  })

  it("the home path is held the same way", async () => {
    db.prepare("UPDATE requests SET close_when = NULL WHERE id = ?").run(ID)
    store.setHome(ID, { kind: "issue", link: ISSUE }, 6_000)
    const home = async () => ({ verdict: "closed" as const, detail: `home ${ISSUE} closed`, closedAt: 8 * MIN })
    const opts = (now: number) => ({ everyMinutes: 10, now, log: () => {}, proof: { mode: "off" as const, ownerCheckOn: true } })
    expect((await checkHomes(store, home, opts(10 * MIN))).closed).toBe(1)
    expect((await ownerCheck("mismatch", () => 11 * MIN).c.run()).reopened).toEqual([ID])
    expect((await checkHomes(store, home, opts(30 * MIN))).closed).toBe(0)
  })
})

describe("sameCheckDetail (B1)", () => {
  it("ignores the agent's words and the plan suffix, not a changed detail", () => {
    expect(sameCheckDetail(MET, MET)).toBe(true)
    expect(sameCheckDetail(`${MET} (agent: done, all six)`, MET)).toBe(true)
    expect(sameCheckDetail(`${MET}; its plan stopped with steps left: 2. review`, MET)).toBe(true)
    expect(sameCheckDetail(`${MET}, 3 left`, MET)).toBe(false)
    expect(sameCheckDetail(null, MET)).toBe(false)
    const long = "x".repeat(600)
    expect(sameCheckDetail("x".repeat(500), long)).toBe(true)
  })

  it("the owner-words prompt holds every link, past the 500-character evidence (B4)", () => {
    store.setDeliverables(ID, STAGES)
    const long = (i: number) => `https://git.example.test/example/a-rather-long-project-path/-/issues/7#note_${100000 + i}`
    store.addProofs(ID, STAGES.map((n, i) => ({ deliverable: n, link: long(i) })), 6_000)
    const p = ownerCheckPrompt(store.get(ID)!)
    for (let i = 0; i < 6; i++) expect(p).toContain(long(i))
  })
})
