import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsCall } from "../src/requests/daemon-api"
import { DEFAULT_OWNER_CHECK, OwnerWordsCheck, ownerCheckPrompt } from "../src/requests/owner-check"
import { sameCheckDetail, splitCheckEvidence } from "../src/requests/close-proof"
import { describeProofLinks } from "../src/requests/tool"

// #1943 — neutral fixture: the owner asks for two things, "the merge
// request is merged" and "it is live". The daemon's own close check
// (merge request merged) is met; the agent closes with a live-proof link.
// The close reviewer saw only the merge, and reopened for "nothing on live".
const SAID = "Check the merge request example/app!4 is merged, then confirm the change is live."
const MR = "https://git.example.test/example/app/-/merge_requests/4"
const MET = `${MR} is merged`
const CLOSE_WHEN = { kind: "issue", provider: "gitlab", ref: "example/app!4", state: "merged" }
const MERGE_NOTE = `${MR}#note_101`
const LIVE = "https://status.example.test/deploys/42"
const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const ID = "req-t1"

let tmp: string
let db: Database.Database
let store: RequestStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-met-check-proofs-"))
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
const api = (body: Record<string, unknown>, now = 6_000) =>
  handleRequestsCall("POST", "/requests", { agentId: "coder", ...body }, {
    store, tracker: undefined as any, enabled: true, hasAgent: (id) => id === "coder", now,
    runningTurn: (agentId) => (agentId === "coder" ? { channel: "telegram", chatId: "chat-1" } : null),
    check: met,
  }, { taskId: "t1" })

/** A strict reviewer: it reopens for "nothing on live" unless the prompt
 *  it is given shows a proof link for the live deliverable. */
function reviewer() {
  const prompts: string[] = []
  const c = new OwnerWordsCheck({
    store, settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true }),
    generate: async (p) => {
      prompts.push(p)
      const liveShown = p.split("\n").some((l) => /^-?\s*2\b/.test(l.trim()) && l.includes(LIVE))
      return JSON.stringify(liveShown ? { verdict: "match", why: "merged and live, each with its link" } : { verdict: "mismatch", why: "the evidence only shows the merge request is merged, nothing on live" })
    },
    now: () => 10_000,
  })
  return { c, prompts }
}

const closeWithTwoProofs = () => api({
  action: "done", id: ID, evidence: `live: ${LIVE}`, proof: LIVE,
  proofs: [{ deliverable: 1, link: MERGE_NOTE }, { deliverable: 2, link: LIVE }],
})

describe("a met close check keeps the agent's proofs (#1943)", () => {
  for (const read of [true, false]) {
    describe(read ? "deliverables read" : "deliverables never read (closeProof off)", () => {
      beforeEach(() => { if (read) store.setDeliverables(ID, ["the merge request is merged", "the change is live"]) })

      it("the close record keeps the met check, the agent's evidence and every proofs[] link", async () => {
        const out = await closeWithTwoProofs()
        expect(out.status).toBe(200)
        const r = store.get(ID)!
        expect(r).toMatchObject({ state: "done", closedBy: "check" })
        expect(r.evidence).toContain(MET)
        expect(r.evidence).toContain(LIVE)
        expect(r.deliverableProofs!.map((p) => [p.deliverable, p.link])).toEqual([["1", MERGE_NOTE], ["2", LIVE]])
        // The hold of #692 still reads the checker's own words in it.
        expect(sameCheckDetail(r.evidence, MET)).toBe(true)
        // The close result names each kept link, not only the check.
        const said = describeProofLinks(r)
        expect(said).toContain(`1: ${MERGE_NOTE}`)
        expect(said).toContain(`2: ${LIVE}`)
      })

      it("the reviewer gets every deliverable's proof link, the agent's evidence, and that the check proves only the merge", async () => {
        expect((await closeWithTwoProofs()).status).toBe(200)
        const p = ownerCheckPrompt(store.get(ID)!)
        expect(p).toContain(MERGE_NOTE)
        expect(p).toContain(LIVE)
        expect(p).toContain(`daemon's own close check was met: ${MET}`)
        expect(p).toMatch(/proves only what it checks/)
        expect(p).toContain(`Evidence given by the assistant: live: ${LIVE}`)
        expect(p).not.toContain("(agent: ")
      })

      it("a two-deliverable request closed with two proofs stays closed", async () => {
        expect((await closeWithTwoProofs()).status).toBe(200)
        const { c, prompts } = reviewer()
        expect(await c.run()).toMatchObject({ checked: 1, reopened: [] })
        expect(prompts).toHaveLength(1)
        expect(store.get(ID)).toMatchObject({ state: "done", ownerCheck: "match" })
      })
    })
  }

  it("keeps the agent's typed proof beside the met check when the evidence does not hold it", async () => {
    expect((await api({ action: "done", id: ID, evidence: "merged and deployed", proof: LIVE })).status).toBe(200)
    const r = store.get(ID)!
    expect(r.evidence).toContain("merged and deployed")
    expect(r.evidence).toContain(LIVE)
    expect(sameCheckDetail(r.evidence, MET)).toBe(true)
  })

  it("splits the kept evidence into the check's words and the agent's", () => {
    expect(splitCheckEvidence(`${MET} (agent: live: ${LIVE})`)).toEqual({ check: MET, agent: `live: ${LIVE}` })
    expect(splitCheckEvidence(MET)).toEqual({ check: MET, agent: null })
  })
})
