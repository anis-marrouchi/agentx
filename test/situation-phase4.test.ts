import { afterEach, beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { RunStore, WorkflowStore, WorkflowDispatcher, type AgentExecuteRequest, type WorkflowRun } from "../src/workflows"
import { TimerService, type TimerRecord } from "../src/workflows/timers"
import type { OwnerCardInput } from "../src/workflows/nodes/types"
import { registerAllBuiltins } from "../src/actions/builtin"
import { RequestStore } from "../src/requests/store"
import { SituationStore } from "../src/situations/store"
import { situationKey } from "../src/situations/key"
import { DEFAULT_SITUATIONS_CONFIG, type SituationsConfig } from "../src/situations/config"
import { setSendToChatStore } from "../src/situations/send-to-chat"
import { SituationRuns, CLOSE_WORKFLOW, EXPIRY_WORKFLOW, situationStartGuard } from "../src/situations/runs"
import { setSituationClosingDeps } from "../src/situations/closing-actions"
import { ensureSituationWorkflows } from "../src/situations/workflows"
import { attachSituationHook, situationHookContext } from "../src/situations/hook"
import { situationsClosing } from "../src/situations/api"
import { getEventBus } from "../src/events/bus"
import { HOOK_EVENTS } from "../src/hooks/types"
import { startWorkflowTriggers } from "../src/workflows/triggers"
import { HookRegistry } from "../src/hooks/registry"

// #1892 phase 4: closing steps. Proof of done (design 9): after a test
// interview, one note at its home, each follow-up is an open promise with
// an owner, the owner got one message. Two quick phase changes leave one
// live expiry run. A reopen then a second end gives two close runs, one
// per generation. The runs are workflow runs (the Workflows page lists
// them). Neutral ids only.

const GROUP = "120363000000000000@g.us"
const KEY = situationKey("whatsapp", "default", GROUP)
const HOME = "https://git.example.com/team/hiring/-/issues/7"
/** The GitLab chat the note is posted on. */
const NOTE_CHAT = "team/hiring:issue:7"
const AGENTS = new Set(["recruiter", "helper", "devops-agent"])
const API = { closingEnabled: true, isAgent: (id: string) => AGENTS.has(id), gitlabUrl: "https://git.example.com" }

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface H {
  dir: string
  db: Database.Database
  situations: SituationStore
  requests: RequestStore
  workflows: WorkflowStore
  runs: RunStore
  timers: TimerService
  dispatcher: WorkflowDispatcher
  sitRuns: SituationRuns
  settings: SituationsConfig
  /** Notes written, by forge chat. */
  notes: Map<string, string[]>
  /** The note the note step's agent drafts. */
  note: string
  /** What the note step's agent lists as follow-ups. */
  followUps: Array<Record<string, string>>
  /** The talk's recent messages (the group log). */
  transcript: Array<{ sender: string; text: string; timestamp: number }>
  logs: string[]
  /** The idempotency key each note post carried. */
  noteKeys: string[]
  told: string[]
  cards: Array<{ cardId: string; input: OwnerCardInput; runId: string; nodeId: string }>
  sends: Array<{ channel: string; chatId: string; text: string }>
  turns: AgentExecuteRequest[]
  fire(runId: string): Promise<void>
  runsOf(workflowId: string): WorkflowRun[]
}

let h: H

function setup(opts: { closing?: boolean } = {}): H {
  const dir = mkdtempSync(join(tmpdir(), "agentx-1892p4-"))
  const db = new Database(":memory:")
  const situations = new SituationStore(db)
  const requests = new RequestStore(db)
  const workflows = new WorkflowStore({ baseDir: dir })
  const runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
  const timers = new TimerService({ baseDir: resolve(dir, "_timers") })
  const x = { dir, db, situations, requests, workflows, runs, timers, notes: new Map(), told: [], cards: [], sends: [], turns: [], logs: [], noteKeys: [] } as unknown as H
  x.note = "Interview notes"
  x.followUps = [
    { what: "Send the candidate the written offer terms", owner: "recruiter", waitsOn: "owner" },
    { what: "Decide the start date", owner: "owner", waitsOn: "recruiter" },
  ]
  x.transcript = [
    { sender: "Candidate", text: "When would I hear back?", timestamp: 1 },
    { sender: "Recruiter", text: "We will send the offer terms by Friday.", timestamp: 2 },
  ]
  x.settings = { ...DEFAULT_SITUATIONS_CONFIG, mode: "active", closing: { enabled: opts.closing ?? true } }
  let n = 0
  x.dispatcher = new WorkflowDispatcher({
    store: workflows, runs, nodeId: "node-a", timers,
    agents: {
      // The talk's agent: drafts the note (it cannot post it), lists the follow-ups.
      execute: async (req) => {
        x.turns.push(req)
        return { content: `Draft ready.\n\`\`\`json\n${JSON.stringify({ note: x.note, followUps: x.followUps })}\n\`\`\`` }
      },
    },
    channels: { whatsapp: { send: async (m: { channel: string; chatId: string; text: string }) => { x.sends.push(m); return `m${x.sends.length}` } } },
    owner: {
      notify: async (text) => { x.told.push(text) },
      ask: async (input, run, nodeId) => {
        const cardId = `card-${++n}`
        x.cards.push({ cardId, input, runId: run.id, nodeId })
        return { cardId }
      },
    },
    followUp: () => ({ stallMinutes: 30, maxNudges: 2, approval: "start" }),
    startGuard: situationStartGuard,
  })
  x.sitRuns = new SituationRuns({
    store: situations,
    settings: () => x.settings,
    dispatcher: () => x.dispatcher,
    ensureWorkflows: () => ensureSituationWorkflows(workflows),
    runStatus: (id) => runs.get(id)?.status ?? null,
    isAgent: (id) => AGENTS.has(id),
    log: (m) => { x.logs.push(m) },
  })
  x.sitRuns.attach()
  setSendToChatStore(situations)
  setSituationClosingDeps({
    store: situations, requests: () => requests, settings: () => x.settings,
    isAgent: (id) => AGENTS.has(id),
    transcript: () => x.transcript,
    gitlabUrl: () => "https://git.example.com",
    postNote: async (target, text, _agent, _home, key) => {
      x.noteKeys.push(key)
      x.notes.set(target.chatId, [...(x.notes.get(target.chatId) ?? []), text])
      return `${HOME}#note_1`
    },
  })
  x.runsOf = (wf) => runs.list().filter((r) => r.workflowId === wf)
  x.fire = async (runId) => {
    const t = timers.list().find((r) => r.runId === runId)
    if (!t) throw new Error(`no timer for ${runId}`)
    timers.cancel({ cancelKey: t.cancelKey })
    await (x.dispatcher as unknown as { resumeFromTimer(t: TimerRecord): Promise<void> }).resumeFromTimer(t)
  }
  return x
}

const live = (r: WorkflowRun) => r.status === "running" || r.status === "paused"

/** A talk with closing steps, in `during`. */
function interview(x: H, extra: { message?: string; chatId?: string; agents?: string[] } = {}) {
  x.situations.create(KEY, "during", "first message")
  x.situations.claimOwner(KEY, "recruiter")
  const row = x.situations.get(KEY)!
  x.situations.setClosing(row.id, { purpose: "the job interview with a test candidate", home: HOME, ...extra }, "meeting")
  return x.situations.get(KEY)!
}

function moveTo(x: H, to: "during" | "ending" | "ended", why = "test") {
  const r = x.situations.get(KEY)!
  expect(x.situations.move(KEY, { phase: r.phase, since: r.phaseChangedAt }, to, { why })).toBe(true)
}

beforeEach(() => { registerAllBuiltins(); h = setup() })
afterEach(() => {
  h.sitRuns.detach()
  setSendToChatStore(null)
  setSituationClosingDeps(null)
  rmSync(h.dir, { recursive: true, force: true })
})

describe("phase 4 proof: a test interview closes", () => {
  it("one note at its home, each follow-up an open promise with an owner, one message to the owner", async () => {
    interview(h)
    // The candidate says goodbye: ending. Our agent's goodbye goes out: ended (closed).
    moveTo(h, "ending", "a closer from the candidate")
    expect(h.situations.noteSent(KEY, "recruiter")).toBe(true)
    expect(h.situations.get(KEY)!.phase).toBe("ended")
    await h.sitRuns.idle()
    const [close] = h.runsOf(CLOSE_WORKFLOW)
    expect(close).toBeTruthy()
    await until(() => h.runs.get(close.id)!.status === "completed")

    // One note, at its home, posted by the workflow (not by the agent).
    expect([...h.notes.keys()]).toEqual([NOTE_CHAT])
    expect(h.notes.get(NOTE_CHAT)).toHaveLength(1)
    expect(h.notes.get(NOTE_CHAT)![0]).toContain("Interview notes")
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0].agentId).toBe("recruiter")
    // M3: the drafting turn is read-only (no channel send, no write) and
    // reads a bounded excerpt of the talk.
    expect(h.turns[0].autonomy).toBe("report")
    expect(h.turns[0].message).toContain("Recruiter: We will send the offer terms by Friday.")
    // Each follow-up: an open promise with an owner.
    const open = h.requests.listOpen().filter((r) => r.promise)
    expect(open.map((p) => p.text).sort()).toEqual(["Decide the start date", "Send the candidate the written offer terms"])
    for (const p of open) expect(p.owedBy ?? p.agentId).toBeTruthy()
    expect(open.find((p) => p.text === "Decide the start date")!.owedBy).toBe("owner")
    expect(open.find((p) => p.text.startsWith("Send"))!.agentId).toBe("recruiter")
    expect(open.every((p) => p.dueAt === null)).toBe(true)
    // The owner got one message, opening with its subject.
    expect(h.told).toHaveLength(1)
    expect(h.told[0]).toMatch(/^About the job interview with a test candidate: the talk ended \(closed\)\. Note: https:\/\/git\.example\.com\/team\/hiring\/-\/issues\/7#note_1\. 2 follow-ups/)
    // Nothing went to the other side, no card was raised.
    expect(h.sends).toHaveLength(0)
    expect(h.cards).toHaveLength(0)
    // The close run is stored on the record for this end generation.
    const row = h.situations.get(KEY)!
    expect(row.closeRunId).toBe(close.id)
    expect(row.closeGeneration).toBe(0)
    // Both runs are workflow runs of installed workflows (Workflows page).
    expect(h.workflows.get(CLOSE_WORKFLOW)?.title).toBe("Situation close")
    expect(h.workflows.get(EXPIRY_WORKFLOW)?.title).toBe("Situation expiry")
    expect(h.runsOf(EXPIRY_WORKFLOW).filter(live)).toHaveLength(0)
  })

  it("a re-run of the promises step opens no second promise", async () => {
    interview(h)
    moveTo(h, "ended")
    await h.sitRuns.idle()
    await until(() => h.runsOf(CLOSE_WORKFLOW).some((r) => r.status === "completed"))
    const { runBuiltin } = await import("../src/actions/builtin")
    const row = h.situations.get(KEY)!
    const again = await runBuiltin("situation.promises", { situationId: row.id, endGeneration: "0", agent: "recruiter", channel: "whatsapp", chatId: GROUP, home: HOME,
      followUps: JSON.stringify([{ what: "Decide the start date", owner: "owner" }, { what: "Send the candidate the written offer terms", owner: "recruiter" }]) }) as { opened: number }
    expect(again.opened).toBe(0)
    // L6: reworded on a second run, still one set per close generation.
    const reworded = await runBuiltin("situation.promises", { situationId: row.id, endGeneration: "0", agent: "recruiter", channel: "whatsapp", chatId: GROUP, home: HOME,
      followUps: JSON.stringify([{ what: "Pick a start date", owner: "owner" }]) }) as { opened: number }
    expect(reworded.opened).toBe(0)
    expect(h.requests.listOpen().filter((r) => r.promise)).toHaveLength(2)
  })

  it("an outward closing message asks the owner first and is not sent on its own", async () => {
    interview(h, { message: "Thank you for your time today." })
    moveTo(h, "ending")
    h.situations.noteSent(KEY, "recruiter")
    await h.sitRuns.idle()
    await until(() => h.cards.length === 1)
    expect(h.cards[0].input.draft).toBe("Thank you for your time today.")
    expect(h.sends).toHaveLength(0)
    expect(h.told).toHaveLength(1)
  })
})

describe("expiry runs", () => {
  it("two quick phase changes leave one live expiry run", async () => {
    interview(h)
    await h.sitRuns.idle()
    expect(h.runsOf(EXPIRY_WORKFLOW).filter(live)).toHaveLength(1)
    moveTo(h, "ending")
    moveTo(h, "during", "a real message")
    await h.sitRuns.idle()
    const all = h.runsOf(EXPIRY_WORKFLOW)
    expect(all.filter(live)).toHaveLength(1)
    expect(all.filter((r) => r.status === "canceled").length).toBeGreaterThanOrEqual(1)
    expect(h.situations.get(KEY)!.expiryRunId).toBe(all.find(live)!.id)
  })

  it("at max age the talk ends as stale; the close runs inward steps only", async () => {
    interview(h)
    await h.sitRuns.idle()
    const [exp] = h.runsOf(EXPIRY_WORKFLOW).filter(live)
    await h.fire(exp.id)
    await until(() => h.situations.get(KEY)!.phase === "ended")
    expect(h.situations.get(KEY)!.endReason).toBe("stale")
    await h.sitRuns.idle()
    await until(() => h.runsOf(CLOSE_WORKFLOW).some((r) => r.status === "completed"))
    expect(h.notes.get(NOTE_CHAT)).toHaveLength(1)
    expect(h.requests.listOpen().filter((r) => r.promise)).toHaveLength(2)
    expect(h.told).toHaveLength(0)
    expect(h.cards).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
  })

  it("a missed cancel is harmless: the old run's expire does nothing", async () => {
    const row = interview(h)
    moveTo(h, "ending")
    const r = h.situations.expire(row.id, row.phaseChangedAt)
    expect(r.ended).toBe(false)
    expect(h.situations.get(KEY)!.phase).toBe("ending")
  })

  it("at daemon start, a missing expiry run is started again for every open talk with closing steps (S14)", async () => {
    interview(h)
    await h.sitRuns.idle()
    const [first] = h.runsOf(EXPIRY_WORKFLOW).filter(live)
    await h.dispatcher.cancelRun(first.id, "lost")
    await h.sitRuns.resumeOnStart()
    expect(h.runsOf(EXPIRY_WORKFLOW).filter(live)).toHaveLength(1)
    // A live one is kept, not doubled.
    await h.sitRuns.resumeOnStart()
    expect(h.runsOf(EXPIRY_WORKFLOW).filter(live)).toHaveLength(1)
  })
})

describe("close runs: once per end generation", () => {
  it("a reopen then a second end gives two close runs, one per generation", async () => {
    interview(h)
    moveTo(h, "ended")
    await h.sitRuns.idle()
    moveTo(h, "during", "a real message")
    moveTo(h, "ended")
    await h.sitRuns.idle()
    const closes = h.runsOf(CLOSE_WORKFLOW)
    expect(closes).toHaveLength(2)
    expect(closes.map((r) => (r.context.start as { endGeneration: number }).endGeneration).sort()).toEqual([0, 1])
    expect(h.situations.get(KEY)!.closeGeneration).toBe(1)
  })

  it("the owner message of an old generation is not sent after a reopen (S7)", async () => {
    const row = interview(h, { message: "Thank you for your time.", chatId: GROUP })
    moveTo(h, "ended")
    moveTo(h, "during", "a real message")
    await h.sitRuns.idle()
    // A close of generation 0 that was already past its cancel.
    const started = await h.dispatcher.startRun({ workflowId: CLOSE_WORKFLOW, inputs: {
      situationId: row.id, endGeneration: 0, reason: "closed", inwardOnly: "no", agent: "recruiter",
      purpose: "the interview", home: HOME, channel: "whatsapp", chatId: GROUP, message: "Thank you for your time.",
    }, meta: { startedBy: "situation", followUp: false } })
    await until(() => ["completed", "failed"].includes(h.runs.get(started.run!.id)!.status))
    const run = h.runs.get(started.run!.id)!
    expect(run.status).toBe("failed")
    expect(run.history.at(-1)!.note ?? "").toMatch(/reopened/)
    expect(h.told).toHaveLength(0)
    expect(h.cards).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
  })

  it("an approved closing message of an old generation is not sent after a reopen (S7)", async () => {
    interview(h, { message: "Thank you for your time.", chatId: GROUP })
    moveTo(h, "ending")
    h.situations.noteSent(KEY, "recruiter")
    await h.sitRuns.idle()
    await until(() => h.cards.length === 1)
    moveTo(h, "during", "one more question")
    await h.sitRuns.idle()
    const card = h.cards[0]
    await h.dispatcher.resumeFromCard({ id: card.cardId, status: "decided", verdict: "yes", origin: { kind: "workflow", runId: card.runId, nodeId: card.nodeId } })
    expect(h.sends).toHaveLength(0)
  })

  it("an end another organisation's agent reported starts no closing steps (Q4: quiet, never act)", async () => {
    interview(h)
    const r = h.situations.get(KEY)!
    h.situations.move(KEY, { phase: r.phase, since: r.phaseChangedAt }, "ended", { why: "a peer said the meeting ended", setBy: "peer" })
    await h.sitRuns.idle()
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(0)
    expect(h.situations.get(KEY)!.phase).toBe("ended")
  })

  it("a talk with no closing steps starts no run at all (phases 1-3 unchanged)", async () => {
    h.situations.create(KEY, "during", "first message")
    moveTo(h, "ending")
    h.situations.noteSent(KEY, "recruiter")
    await h.sitRuns.idle()
    expect(h.runs.list()).toHaveLength(0)
  })

  it("closing steps given to a talk that already ended wait for its next end", async () => {
    h.situations.create(KEY, "during", "first message")
    h.situations.claimOwner(KEY, "recruiter")
    moveTo(h, "ended")
    h.situations.setClosing(h.situations.get(KEY)!.id, { purpose: "p", home: HOME })
    await h.sitRuns.idle()
    expect(h.runs.list()).toHaveLength(0)
    moveTo(h, "during", "a real message")
    moveTo(h, "ended")
    await h.sitRuns.idle()
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(1)
  })

  it("with situations.closing.enabled false nothing starts", async () => {
    h.sitRuns.detach()
    h = setup({ closing: false })
    interview(h)
    moveTo(h, "ended")
    await h.sitRuns.idle()
    expect(h.runs.list()).toHaveLength(0)
  })
})

describe("closing steps are set by a person or a workflow step", () => {
  it("POST /situations/closing sets them on an existing talk and validates the input", () => {
    h.situations.create(KEY, "during", "first message")
    const id = h.situations.get(KEY)!.id
    expect(situationsClosing(h.situations, { id, purpose: "an interview", home: HOME }, API).status).toBe(200)
    expect(h.situations.get(KEY)!.closing).toEqual({ purpose: "an interview", home: HOME })
    expect(h.situations.get(KEY)!.template).toBe("meeting")
    expect(situationsClosing(h.situations, { id, purpose: "", home: HOME }, API).status).toBe(400)
    expect(situationsClosing(h.situations, { id: "nope-nope", purpose: "x", home: HOME }, API).status).toBe(404)
    expect(situationsClosing(h.situations, { id, clear: true }, API).status).toBe(200)
    expect(h.situations.get(KEY)!.closing).toBeNull()
  })
})

describe("review fixes", () => {
  const ended = async () => {
    moveTo(h, "ending")
    h.situations.noteSent(KEY, "recruiter")
    await h.sitRuns.idle()
  }
  const doneClose = () => until(() => h.runsOf(CLOSE_WORKFLOW).some((r) => r.status === "completed" || r.status === "failed"))

  it("M1: an owner's broken edit of a workflow is not overwritten, and no close starts", async () => {
    writeFileSync(join(h.dir, "situation-close.yaml"), "id: situation-close\nnodes: [this is not a workflow\n")
    interview(h)
    await ended()
    expect(readFileSync(join(h.dir, "situation-close.yaml"), "utf-8")).toContain("this is not a workflow")
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(0)
    expect(h.logs.some((l) => /situation-close.*does not load/.test(l))).toBe(true)
  })

  it("M1: a .json and a .yaml of the same workflow are left alone", () => {
    writeFileSync(join(h.dir, "situation-expiry.json"), "{}")
    writeFileSync(join(h.dir, "situation-expiry.yaml"), "id: situation-expiry\n")
    const r = ensureSituationWorkflows(h.workflows)
    expect(r.broken.map((b) => b.id)).toContain("situation-expiry")
    expect(readFileSync(join(h.dir, "situation-expiry.json"), "utf-8")).toBe("{}")
  })

  it("M1: a deleted template stays deleted; it is logged once and no run starts", async () => {
    expect(ensureSituationWorkflows(h.workflows).added).toEqual([CLOSE_WORKFLOW, EXPIRY_WORKFLOW])
    rmSync(join(h.dir, "situation-close.yaml"))
    expect(ensureSituationWorkflows(h.workflows).added).toEqual([])
    expect(existsSync(join(h.dir, "situation-close.yaml"))).toBe(false)
    interview(h)
    await ended()
    moveTo(h, "during", "again")
    moveTo(h, "ended")
    await h.sitRuns.idle()
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(0)
    expect(h.logs.filter((l) => /situation-close.*was deleted/.test(l))).toHaveLength(1)
  })

  it("M2: a follow-up owned by an unknown party is kept by the talk's agent, named in its words", async () => {
    h.followUps = [{ what: "Send the portfolio", owner: "candidate", waitsOn: "recruiter" }]
    interview(h)
    await ended()
    await doneClose()
    const [p] = h.requests.listOpen().filter((r) => r.promise)
    expect(p.agentId).toBe("recruiter")
    expect(p.text).toBe("Send the portfolio (named owner: candidate)")
  })

  it("M2: a real agent the closing steps do not allow is not given the promise", async () => {
    h.followUps = [{ what: "Restart the build server", owner: "devops-agent" }]
    interview(h)
    await ended()
    await doneClose()
    const [p] = h.requests.listOpen().filter((r) => r.promise)
    expect(p.agentId).toBe("recruiter")
    expect(p.text).toContain("named owner: devops-agent")
  })

  it("M2: an agent the closing steps allow owns its follow-up", async () => {
    h.followUps = [{ what: "Book the second interview", owner: "helper" }]
    interview(h, { agents: ["helper"] })
    await ended()
    await doneClose()
    const [p] = h.requests.listOpen().filter((r) => r.promise)
    expect(p.agentId).toBe("helper")
    expect(p.text).toBe("Book the second interview")
  })

  it("M3: a home that is not a forge issue or merge request is refused", () => {
    h.situations.create(KEY, "during", "first message")
    const id = h.situations.get(KEY)!.id
    const r = situationsClosing(h.situations, { id, purpose: "x", home: "https://wiki.example.com/page" }, API)
    expect(r.status).toBe(400)
  })

  it("L1: clearing an ended talk cancels its close run", async () => {
    interview(h, { message: "Thanks.", chatId: GROUP })
    await ended()
    await until(() => h.cards.length === 1)
    const [close] = h.runsOf(CLOSE_WORKFLOW)
    expect(live(close)).toBe(true)
    expect(h.situations.override(h.situations.get(KEY)!.id, "clear", "test").ok).toBe(true)
    await h.sitRuns.idle()
    expect(h.runs.get(close.id)!.status).toBe("canceled")
  })

  it("L2: a close or expiry run not started by the situation record is refused", async () => {
    ensureSituationWorkflows(h.workflows)
    const r = await h.dispatcher.startRun({ workflowId: CLOSE_WORKFLOW, inputs: { agent: "recruiter" }, meta: { startedBy: "recruiter" } })
    expect(r.run).toBeNull()
    expect(r.error).toMatch(/only by the situation record/)
    const e = await h.dispatcher.startRun({ workflowId: EXPIRY_WORKFLOW, inputs: {} })
    expect(e.run).toBeNull()
  })

  it("L2: closing steps naming an unknown agent are refused", () => {
    h.situations.create(KEY, "during", "first message")
    const id = h.situations.get(KEY)!.id
    expect(situationsClosing(h.situations, { id, purpose: "x", home: HOME, agent: "nobody" }, API).status).toBe(400)
  })

  it("L3: setting closing steps while closing is off answers 409", () => {
    h.situations.create(KEY, "during", "first message")
    const id = h.situations.get(KEY)!.id
    const r = situationsClosing(h.situations, { id, purpose: "x", home: HOME }, { ...API, closingEnabled: false })
    expect(r.status).toBe(409)
    expect((r.body as { error: string }).error).toMatch(/situations\.closing\.enabled/)
  })

  it("L4: situation.expire does nothing while closing is off", async () => {
    const row = interview(h)
    h.settings = { ...h.settings, closing: { enabled: false } }
    const { runBuiltin } = await import("../src/actions/builtin")
    const r = await runBuiltin("situation.expire", { situationId: row.id, phaseChangedAt: String(row.phaseChangedAt) }) as { ended: boolean }
    expect(r.ended).toBe(false)
    expect(h.situations.get(KEY)!.phase).toBe("during")
  })

  it("L5: at daemon start, a close missed for a recent end is started", async () => {
    interview(h)
    await h.sitRuns.idle()
    h.sitRuns.detach()
    moveTo(h, "ended")
    h.sitRuns.attach()
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(0)
    await h.sitRuns.resumeOnStart()
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(1)
    await h.sitRuns.resumeOnStart()
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(1)
  })
})

describe("re-check fixes", () => {
  const ended = async () => {
    moveTo(h, "ending")
    h.situations.noteSent(KEY, "recruiter")
    await h.sitRuns.idle()
  }
  const doneClose = () => until(() => h.runsOf(CLOSE_WORKFLOW).some((r) => r.status === "completed" || r.status === "failed"))

  it("F1: closing steps set on an ended talk start no close at the next daemon start", async () => {
    h.situations.create(KEY, "during", "first message")
    h.situations.claimOwner(KEY, "recruiter")
    moveTo(h, "ended")
    h.situations.setClosing(h.situations.get(KEY)!.id, { purpose: "p", home: HOME, message: "Thanks.", chatId: GROUP })
    await h.sitRuns.idle()
    await h.sitRuns.resumeOnStart()
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(0)
    expect(h.told).toHaveLength(0)
    expect(h.cards).toHaveLength(0)
    // Its next end still closes.
    moveTo(h, "during", "a real message")
    moveTo(h, "ended")
    await h.sitRuns.idle()
    expect(h.runsOf(CLOSE_WORKFLOW)).toHaveLength(1)
  })

  it("L-a: with no messages of the talk kept, the run opens no promises", async () => {
    h.transcript = []
    interview(h)
    await ended()
    await doneClose()
    expect(h.requests.listOpen().filter((r) => r.promise)).toHaveLength(0)
    expect(h.turns[0].message).toContain("no messages of this talk are kept")
    expect(h.told[0]).toMatch(/No follow-ups/)
  })

  it("L-b: the note is posted once per end, with a stable key, even when the step runs again", async () => {
    interview(h)
    await ended()
    await doneClose()
    const row = h.situations.get(KEY)!
    expect(h.noteKeys).toEqual([`situation:${row.id}:0:note`])
    const { runBuiltin } = await import("../src/actions/builtin")
    const again = await runBuiltin("situation.note", { situationId: row.id, endGeneration: "0", home: HOME, agent: "recruiter", note: "Interview notes" }) as { noteAt: string }
    expect(again.noteAt).toBe(`${HOME}#note_1`)
    expect(h.notes.get(NOTE_CHAT)).toHaveLength(1)
  })

  it("#1973: an empty drafted note posts nothing and still opens the follow-ups", async () => {
    h.note = "  "
    h.followUps = [{ what: "Send the candidate the written offer terms", owner: "recruiter" }]
    interview(h)
    await ended()
    await doneClose()
    expect(h.runsOf(CLOSE_WORKFLOW)[0].status).toBe("completed")
    expect(h.notes.size).toBe(0)
    expect(h.situations.noteFor(h.situations.get(KEY)!.id, 0)).toBeNull()
    expect(h.requests.listOpen().filter((r) => r.promise).map((p) => p.text)).toEqual(["Send the candidate the written offer terms"])
    expect(h.told).toHaveLength(1)
    expect(h.told[0]).toMatch(/\(closed\)\. Note: none, the agent drafted no note\. 1 follow-up, owners named: /)
  })

  it("L-c: an allowed agent named in other letter case owns the promise under its registry id", async () => {
    h.followUps = [{ what: "Book the second interview", owner: "HELPER" }]
    interview(h, { agents: ["helper"] })
    await ended()
    await doneClose()
    const [p] = h.requests.listOpen().filter((r) => r.promise)
    expect(p.agentId).toBe("helper")
  })
})

describe("on:situation hook event", () => {
  it("is a hook event workflows can subscribe to", () => {
    expect((HOOK_EVENTS as readonly string[]).includes("on:situation")).toBe(true)
  })

  it("fires once per committed phase change, from the bus event", async () => {
    const fired: Array<Record<string, unknown>> = []
    const off = attachSituationHook({ execute: async (event: string, ctx: Record<string, unknown>) => { if (event === "on:situation") fired.push(ctx); return {} } })
    try {
      h.situations.create(KEY, "during", "first message")
      moveTo(h, "ending")
      // A lost race commits nothing and fires nothing.
      expect(h.situations.move(KEY, { phase: "during", since: 1 }, "ended", { why: "stale read" })).toBe(false)
      await new Promise((r) => setTimeout(r, 0))
      expect(fired.map((c) => [c.from, c.to])).toEqual([[null, "during"], ["during", "ending"]])
      expect(fired[1]).toMatchObject({ channel: "whatsapp", template: "conversation", phase: "ending" })
    } finally { off() }
  })

  it("builds the context from the event", () => {
    const ctx = situationHookContext({ situationId: "s1", key: KEY, channel: "whatsapp", chatId: "1", template: "meeting", endGeneration: 2, from: "ending", to: "ended", cause: "x", setBy: "rule", endReason: "closed", at: "2026-01-01T00:00:00.000Z" })
    expect(ctx).toMatchObject({ situationId: "s1", phase: "ended", from: "ending", to: "ended", endReason: "closed", endGeneration: 2 })
  })

  it("a trigger.hook workflow with filter.phase runs only for that phase", async () => {
    h.workflows.save({
      id: "on-ended", version: 2, title: "On ended", nodes: [
        { id: "t", type: "trigger.hook", config: { event: "on:situation", filter: { phase: ["ended"] } } },
        { id: "e", type: "end", config: {} },
      ], edges: [{ from: "t", to: "e" }],
    } as never)
    const hooks = new HookRegistry()
    startWorkflowTriggers({ store: h.workflows, dispatcher: h.dispatcher, hooks, log: () => {} })
    const off = attachSituationHook(hooks)
    try {
      h.situations.create(KEY, "during", "first message")
      moveTo(h, "ending")
      await new Promise((r) => setTimeout(r, 20))
      expect(h.runsOf("on-ended")).toHaveLength(0)
      moveTo(h, "ended")
      await until(() => h.runsOf("on-ended").length === 1)
    } finally { off() }
  })
})

describe("the emit point stays one", () => {
  it("setting closing steps emits no phase event", () => {
    const seen: string[] = []
    const fn = (p: { to: string }) => seen.push(p.to)
    getEventBus().on("situation:phase", fn as never)
    try {
      h.situations.create(KEY, "during", "first message")
      h.situations.setClosing(h.situations.get(KEY)!.id, { purpose: "p", home: HOME })
      expect(seen).toEqual(["during"])
    } finally { getEventBus().off("situation:phase", fn as never) }
  })
})
