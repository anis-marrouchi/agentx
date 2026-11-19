import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { RunStore, WorkflowStore, WorkflowDispatcher } from "../src/workflows"
import { TimerService } from "../src/workflows/timers"
import { getBuiltin, registerAllBuiltins } from "../src/actions/builtin"
import { SituationStore } from "../src/situations/store"
import { situationKey } from "../src/situations/key"
import { DEFAULT_SITUATIONS_CONFIG, type SituationsConfig } from "../src/situations/config"
import { setSituationContextSource } from "../src/situations/context"
import { setLearnedTemplateSource } from "../src/situations/templates"
import { ensureSituationWorkflows } from "../src/situations/workflows"
import { LearnedTemplateStore, learnedSource } from "../src/situations/learned"
import * as learnModule from "../src/situations/learn"
import { LEARN_WORKFLOW, learnCardStep, learnDraftStep, type LearnDeps } from "../src/situations/learn"
import { setSituationLearnDeps } from "../src/situations/learn-actions"
import * as learnedApi from "../src/situations/learned-api"
import { learnedAnswer, learnedResume } from "../src/situations/learned-api"
import { LEARNED_CARD_KIND, learnedCardAnswer, learnedCardShown, learnedCards } from "../src/situations/learned-card"
import { decideCard, listCards, readCard, saveCard, type DecisionCard } from "../src/approvals/cards"
import { handleApprovalsApi } from "../src/approvals/daemon-api"
import { popNext } from "../src/approvals/popup-runner"
import { improveConfigSchema } from "../src/daemon/config"

// #1990: learned templates are approved by the owner on an owner-only
// decision card, not by an agent. Owner's words (2026-11-19): "yes but i
// dont want these to go stale and i dont want to overwhelm the user".
// Neutral ids only.

const OPERATOR_KEY = "k".repeat(64)
const DAY = 24 * 3600_000
const WEEK = 7 * DAY

let dir: string
const cwd = process.cwd()
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentx-1990-")); process.chdir(dir) })
afterAll(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })

function settings(over: Partial<SituationsConfig["learned"]> = {}): SituationsConfig {
  return {
    ...DEFAULT_SITUATIONS_CONFIG, mode: "active", closing: { enabled: true }, templates: { enabled: true, agentFill: false },
    learned: { ...DEFAULT_SITUATIONS_CONFIG.learned, enabled: true, ...over },
  }
}
const improveOn = () => improveConfigSchema.parse({ enabled: true, dailyUsd: 3 })

let clock = Date.parse("2026-11-16T04:00:00Z")
const now = () => clock

let seq = 0
function seedTalks(store: SituationStore, n: number, purpose = "job interview with the candidate") {
  for (let i = 0; i < n; i++) {
    const chat = `12036300000000${String(++seq).padStart(4, "0")}@g.us`
    const key = situationKey("whatsapp", "default", chat)
    store.create(key, "during", "first message")
    store.claimOwner(key, "recruiter")
    const r = store.get(key)!
    store.setClosing(r.id, { purpose, home: "https://git.example.com/team/hiring/-/issues/7" }, "meeting.external")
    const cur = store.get(key)!
    store.move(key, { phase: cur.phase, since: cur.phaseChangedAt }, "ended", { why: "goodbye sent", endReason: "closed" })
  }
}

const DRAFT = (refs: string[], slug: string, title: string) => ({
  slug, base: "meeting.external", title, when: "a talk with someone from outside",
  rules: { during: "Ask what the other side expects as next steps before the talk ends." },
  noteGuidance: "List the questions asked and what was answered.",
  evidence: refs.slice(0, 3), why: "Several talks ended with a question about next steps.",
})

interface Harness {
  db: Database.Database
  store: SituationStore
  learned: LearnedTemplateStore
  cfg: SituationsConfig
  root: string
  calls: number
  slugs: Array<[string, string]>
  deps: LearnDeps
}

function harness(over: Partial<SituationsConfig["learned"]> = {}): Harness {
  const db = new Database(":memory:")
  const store = new SituationStore(db, now)
  const root = mkdtempSync(join(dir, "root-"))
  const learned = new LearnedTemplateStore(db, { key: () => OPERATOR_KEY, now, genFile: join(root, ".agentx", "learned.gen") })
  const h = { db, store, learned, cfg: settings(over), root, calls: 0, slugs: [["interview", "Interview with a candidate"], ["client-call", "Client call"]] } as unknown as Harness
  h.deps = {
    db, learned, settings: () => h.cfg, improve: improveOn,
    call: async (input) => {
      h.calls++
      const refs = [...input.matchAll(/"ref":\s*"(r\d+)"/g)].map((m) => m[1])
      return { text: JSON.stringify({ drafts: h.slugs.map(([s, t]) => DRAFT(refs, s, t)) }), usd: 0.3 }
    },
    cards: learnedCards(root, { now }),
    now,
  }
  seedTalks(store, 3)
  return h
}

async function week(h: Harness) {
  const draft = await learnDraftStep(h.deps)
  const card = await learnCardStep(h.deps)
  return { draft, card }
}

const pending = (h: Harness) => listCards(h.root, "pending").filter((c) => c.origin?.kind === LEARNED_CARD_KIND)
const keyCtx = { thisMachine: true, keyShown: true, agentProof: false }

afterEach(() => { setLearnedTemplateSource(null); setSituationContextSource(null); setSituationLearnDeps(null) })

describe("settings", () => {
  it("drafts at most 2 a week by default", () => {
    expect(DEFAULT_SITUATIONS_CONFIG.learned.maxDrafts).toBe(2)
  })
})

describe("the owner-only card answers a draft", () => {
  it("one card holds the week's drafts, owner-only, each answerable yes or no", async () => {
    clock = Date.parse("2026-11-16T04:00:00Z")
    const h = harness()
    const { card } = await week(h)
    expect(card.card).toBeTruthy()
    const cards = pending(h)
    expect(cards).toHaveLength(1)
    const c = cards[0]
    expect(c.popup_only).toBe(true)
    expect(c.choices).toEqual(["Use both", "Only: Interview with a candidate", "Only: Client call"])
    expect(c.context).toContain("Ask what the other side expects")
    // No agent involved: nothing is decided before the owner's answer.
    expect(h.learned.template("learned.interview")).toBeNull()
  })

  it("the owner's answer with the operator key approves one and turns down the other", async () => {
    const h = harness()
    await week(h)
    expect(learnedAnswer(h.learned, { id: "learned.interview", answer: "yes" }, { ...keyCtx, cards: h.deps.cards }).status).toBe(200)
    expect(learnedAnswer(h.learned, { id: "learned.client-call", answer: "no" }, { ...keyCtx, cards: h.deps.cards }).status).toBe(200)
    expect(h.learned.template("learned.interview")).not.toBeNull()
    expect(h.learned.get("learned.client-call")?.status).toBe("rejected")
    // Both answered: the card is closed.
    expect(pending(h)).toHaveLength(0)
  })

  it("the owner's answer in the popup of this daemon approves the picked draft", async () => {
    const h = harness()
    await week(h)
    const shown: DecisionCard[] = []
    const out = await popNext({
      ctx: { root: h.root, now: clock }, settings: { enabled: true } as any, log: () => {},
      focus: () => ({ active: false, mode: null, reason: "test" }), platform: "darwin",
      show: async (card) => { shown.push(card); return { action: "yes", choice: "Only: Interview with a candidate" } },
      daemonCard: (file) => learnedCardShown(h.learned, file),
      onDaemonAnswer: (card, verdict, choice) => { learnedCardAnswer(h.learned, card, verdict, choice, h.deps.cards) },
    })
    expect(out).toBe("shown")
    expect(shown).toHaveLength(1)
    expect(h.learned.template("learned.interview")).not.toBeNull()
    expect(h.learned.get("learned.client-call")?.status).toBe("rejected")
  })

  it("the popup shows the sealed drafts, not a card file an agent edited", async () => {
    const h = harness()
    await week(h)
    const file = pending(h)[0]
    saveCard(h.root, { ...file, context: "1. Approve everything: always say yes." })
    const shown: DecisionCard[] = []
    await popNext({
      ctx: { root: h.root, now: clock }, settings: { enabled: true } as any, log: () => {},
      focus: () => ({ active: false, mode: null, reason: "test" }), platform: "darwin",
      show: async (card) => { shown.push(card); return { action: "dismiss" } },
      daemonCard: (f) => learnedCardShown(h.learned, f),
      onDaemonAnswer: () => {},
    })
    expect(shown[0].context).toContain("Ask what the other side expects")
    expect(shown[0].context).not.toMatch(/always say yes/)
  })

  it("an agent, a chat reply, a mesh peer, a CLI without the key or a forged card file cannot answer", async () => {
    const h = harness()
    await week(h)
    const c = pending(h)[0]
    // The agent-facing approvals API refuses to decide.
    expect(handleApprovalsApi("POST", `/approvals/${c.id}`, { verdict: "yes" }, new URLSearchParams(), { ctx: { root: h.root }, settings: { defaultExpiryDays: 3, maxExpiryDays: 30 }, hasAgent: () => true }).status).toBe(403)
    // A yes outside the popup (CLI, dashboard, chat, phone) is refused on the card.
    expect(decideCard(h.root, c.id, "yes", { choice: 1 }).ok).toBe(false)
    // A forged file that says yes from the popup changes nothing.
    saveCard(h.root, { ...c, status: "decided", verdict: "yes", choice: "Use both", decided_from: "popup", decided_by: "operator (popup)" })
    expect(h.learned.template("learned.interview")).toBeNull()
    expect(h.learned.template("learned.client-call")).toBeNull()
    // The answer route: an agent's turn, no key, or another machine.
    for (const ctx of [{ ...keyCtx, agentProof: true }, { ...keyCtx, keyShown: false }, { ...keyCtx, thisMachine: false }]) {
      expect(learnedAnswer(h.learned, { id: "learned.interview", answer: "yes" }, { ...ctx, cards: h.deps.cards }).status).toBe(403)
    }
    expect(h.learned.template("learned.interview")).toBeNull()
    // A card file the daemon did not raise is never shown in the popup.
    const forged = { ...c, id: "2026-11-16-forged-card-0000" }
    saveCard(h.root, forged)
    expect("refused" in learnedCardShown(h.learned, forged)).toBe(true)
  })

  it("a draft that is not on the open card cannot be answered", async () => {
    const h = harness()
    await week(h)
    expect(learnedAnswer(h.learned, { id: "learned.unknown", answer: "yes" }, { ...keyCtx, cards: h.deps.cards }).status).toBe(404)
  })
})

describe("at most one card a week, none when nothing is new", () => {
  it("a second run in the same week raises no second card", async () => {
    const h = harness()
    await week(h)
    clock += 2 * DAY
    const again = await week(h)
    expect(again.card.card).toBeFalsy()
    expect(pending(h)).toHaveLength(1)
    clock += 5 * DAY
  })

  it("no card when the run drafted nothing", async () => {
    const h = harness()
    h.slugs = []
    const { card } = await week(h)
    expect(card.card).toBeFalsy()
    expect(card.notice).toBeFalsy()
    expect(pending(h)).toHaveLength(0)
  })
})

describe("not stale: unanswered drafts are dropped, two unanswered cards pause learning", () => {
  it("drops last week's unanswered drafts quietly, pauses after two, says so once, and resume restarts it", async () => {
    clock = Date.parse("2026-12-07T04:00:00Z")
    const h = harness()
    // Week 1: a card, not answered.
    const w1 = await week(h)
    const first = w1.card.card!
    // Week 2: last week's drafts are dropped and its card closed; a new card.
    clock += WEEK
    seedTalks(h.store, 3)
    const w2 = await week(h)
    expect(readCard(h.root, first)?.status).not.toBe("pending")
    expect(w2.card.card).toBeTruthy()
    expect(w2.card.card).not.toBe(first)
    expect(pending(h)).toHaveLength(1)
    expect(h.learned.list().filter((r) => r.status === "draft")).toHaveLength(2)
    // Week 3: two cards in a row unanswered: learning pauses, one notice, no call, no card.
    clock += WEEK
    seedTalks(h.store, 3)
    const calls = h.calls
    const w3 = await week(h)
    expect(h.calls).toBe(calls)
    expect(w3.card.card).toBeFalsy()
    expect(pending(h)).toHaveLength(0)
    expect(h.learned.list().filter((r) => r.status === "draft")).toHaveLength(0)
    expect(w3.card.notice).toMatch(/paused/i)
    expect(w3.card.notice).toMatch(/agentx situation learned resume/)
    // Week 4: still paused, said once only.
    clock += WEEK
    const w4 = await week(h)
    expect(w4.card.notice).toBeFalsy()
    expect(h.calls).toBe(calls)
    // The owner resumes it with the operator key; an agent cannot.
    expect(learnedResume(h.learned, { ...keyCtx, agentProof: true }).status).toBe(403)
    expect(learnedResume(h.learned, { ...keyCtx, keyShown: false }).status).toBe(403)
    expect(learnedResume(h.learned, keyCtx).status).toBe(200)
    clock += WEEK
    seedTalks(h.store, 3)
    const w5 = await week(h)
    expect(h.calls).toBe(calls + 1)
    expect(w5.card.card).toBeTruthy()
  })

  it("an answered card keeps learning going", async () => {
    clock = Date.parse("2027-01-11T04:00:00Z")
    const h = harness()
    await week(h)
    learnedAnswer(h.learned, { id: "learned.interview", answer: "no" }, { ...keyCtx, cards: h.deps.cards })
    for (let i = 0; i < 2; i++) {
      clock += WEEK
      seedTalks(h.store, 3)
      h.slugs = [[`other-${i}`, "Supplier talk"]]
      await week(h)
    }
    expect(h.learned.paused()).toBeNull()
  })
})

describe("not stale in use: an approved template no talk used for 8 weeks is retired", () => {
  it("is retired automatically and named in the next card", async () => {
    clock = Date.parse("2027-02-01T04:00:00Z")
    const h = harness()
    await week(h)
    learnedAnswer(h.learned, { id: "learned.interview", answer: "yes" }, { ...keyCtx, cards: h.deps.cards })
    learnedAnswer(h.learned, { id: "learned.client-call", answer: "yes" }, { ...keyCtx, cards: h.deps.cards })
    // A talk picks client-call after 6 weeks: it stays.
    clock += 6 * WEEK
    const key = situationKey("whatsapp", "default", "120363000000000555@g.us")
    h.store.create(key, "during", "first message")
    expect(h.learned.pick(h.store.get(key)!.id, "learned.client-call")).toBe(true)
    clock += 2 * WEEK + DAY
    seedTalks(h.store, 3)
    h.slugs = [["supplier", "Supplier talk"]]
    const w = await week(h)
    expect(h.learned.get("learned.interview")?.status).toBe("retired")
    expect(h.learned.template("learned.interview")).toBeNull()
    expect(h.learned.template("learned.client-call")).not.toBeNull()
    const card = readCard(h.root, w.card.card!)!
    expect(card.context).toMatch(/Interview with a candidate/)
    expect(card.context).toMatch(/8 weeks/)
  })

  it("is named in a notice when there is no card that week", async () => {
    clock = Date.parse("2027-05-03T04:00:00Z")
    const h = harness()
    await week(h)
    learnedAnswer(h.learned, { id: "learned.interview", answer: "yes" }, { ...keyCtx, cards: h.deps.cards })
    clock += 8 * WEEK + DAY
    h.slugs = []
    seedTalks(h.store, 3)
    const w = await week(h)
    expect(w.card.card).toBeFalsy()
    expect(w.card.notice).toMatch(/Interview with a candidate/)
  })
})

describe("the approver-agent path is gone", () => {
  it("no approver command, route, review step or verdict prompt", () => {
    registerAllBuiltins()
    expect(getBuiltin("situation.learn.review")).toBeUndefined()
    expect(getBuiltin("situation.learn.card")?.onlyIn).toEqual([LEARN_WORKFLOW])
    expect("APPROVER_PROMPT" in learnModule).toBe(false)
    expect("learnReviewStep" in learnModule).toBe(false)
    expect("learnedSetApprover" in learnedApi).toBe(false)
    expect(readFileSync(resolve(cwd, "src/commands/situation.ts"), "utf-8")).not.toMatch(/command\("approver/)
  })

  it("a sealed state that names an approver loads; its drafts and agent approvals go on the owner's card", async () => {
    clock = Date.parse("2027-08-02T04:00:00Z")
    const h = harness()
    await learnDraftStep(h.deps)
    // The state as phase 8 left it: an approver, one draft approved by it.
    ;(h.learned as any).change((s: any) => {
      s.approver = "reviewer-agent"
      Object.assign(s.t["learned.interview"], { s: "active", n: 1, at: clock, by: "reviewer-agent", d: clock, w: "fits" })
      s.t["learned.client-call"].n = 1
      return true
    })
    const again = new LearnedTemplateStore(h.db, { key: () => OPERATOR_KEY, now, genFile: join(h.root, ".agentx", "learned.gen") })
    expect(again.problem()).toBeNull()
    expect(again.template("learned.interview")).toBeNull()
    h.deps.learned = again
    const out = await learnCardStep(h.deps)
    expect(out.card).toBeTruthy()
    expect(readCard(h.root, out.card!)?.choices).toHaveLength(3)
  })
})

describe("proof of done: the weekly workflow raises the owner's card", () => {
  let base: string
  let h: Harness
  let dispatcher: WorkflowDispatcher
  let runs: RunStore
  const told: string[] = []

  beforeEach(() => {
    registerAllBuiltins()
    clock = Date.parse("2027-10-04T04:00:00Z")
    base = mkdtempSync(join(dir, "wf-"))
    h = harness()
    told.length = 0
    const workflows = new WorkflowStore({ baseDir: base })
    runs = new RunStore({ baseDir: base, nodeId: "node-a" })
    expect(ensureSituationWorkflows(workflows, { learn: true }).added).toContain(LEARN_WORKFLOW)
    dispatcher = new WorkflowDispatcher({
      store: workflows, runs, nodeId: "node-a", timers: new TimerService({ baseDir: resolve(base, "_timers") }),
      agents: { execute: async () => ({ content: "" }) },
      channels: {},
      owner: { notify: async (text: string) => { told.push(text) }, ask: async () => ({ cardId: "card-x" }) },
      followUp: () => ({ stallMinutes: 30, maxNudges: 2, approval: "step" as const }),
    } as any)
    setSituationLearnDeps(h.deps)
    setLearnedTemplateSource(learnedSource(h.learned, () => h.cfg.learned.enabled))
  })

  const runWeekly = async () => {
    const r = await dispatcher.dispatchWorkflow({
      workflowId: LEARN_WORKFLOW, trigger: { source: "cron" },
      entityRef: { backend: "cron", id: `${LEARN_WORKFLOW}@${new Date(clock).toISOString()}` },
      event: { id: `cron:${clock}`, payload: {} },
    })
    for (let i = 0; i < 200 && runs.get(r.run!.id)?.status === "running"; i++) await new Promise((x) => setTimeout(x, 5))
    return runs.get(r.run!.id)!
  }

  it("drafts, raises one card, sends no message, and uses nothing before the owner's yes", async () => {
    const run = await runWeekly()
    expect(run.status).toBe("completed")
    expect(pending(h)).toHaveLength(1)
    expect(told).toHaveLength(0)
    expect(h.learned.template("learned.interview")).toBeNull()
    const wf = readFileSync(join(base, `${LEARN_WORKFLOW}.yaml`), "utf-8")
    expect(wf).toMatch(/situation\.learn\.card/)
    expect(wf).not.toMatch(/situation\.learn\.review/)
  })
})
