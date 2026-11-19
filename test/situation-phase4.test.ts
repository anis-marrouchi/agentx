import { afterEach, beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
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
import { SituationRuns, CLOSE_WORKFLOW, EXPIRY_WORKFLOW } from "../src/situations/runs"
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
const HOME = "https://git.example.com/hiring/issues/7"

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
  /** Notes the agent wrote, by home. */
  notes: Map<string, string[]>
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
  const x = { dir, db, situations, requests, workflows, runs, timers, notes: new Map(), told: [], cards: [], sends: [], turns: [] } as unknown as H
  x.settings = { ...DEFAULT_SITUATIONS_CONFIG, mode: "active", closing: { enabled: opts.closing ?? true } }
  let n = 0
  x.dispatcher = new WorkflowDispatcher({
    store: workflows, runs, nodeId: "node-a", timers,
    agents: {
      // The talk's agent: writes one note at the home, lists two follow-ups.
      execute: async (req) => {
        x.turns.push(req)
        const home = /home: (\S+)/.exec(req.message)?.[1] ?? "?"
        x.notes.set(home, [...(x.notes.get(home) ?? []), "Interview notes"])
        return { content: `Note written.\n\`\`\`json\n${JSON.stringify({ noteAt: `${home}#note-1`, followUps: [
          { what: "Send the candidate the written offer terms", owner: "recruiter", waitsOn: "owner" },
          { what: "Decide the start date", owner: "owner", waitsOn: "recruiter" },
        ] })}\n\`\`\`` }
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
  })
  x.sitRuns = new SituationRuns({
    store: situations,
    settings: () => x.settings,
    dispatcher: () => x.dispatcher,
    ensureWorkflows: () => { ensureSituationWorkflows(workflows) },
    runStatus: (id) => runs.get(id)?.status ?? null,
    log: () => {},
  })
  x.sitRuns.attach()
  setSendToChatStore(situations)
  setSituationClosingDeps({ store: situations, requests: () => requests })
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
function interview(x: H, extra: { message?: string; chatId?: string } = {}) {
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

    // One note, at its home.
    expect([...h.notes.keys()]).toEqual([HOME])
    expect(h.notes.get(HOME)).toHaveLength(1)
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0].agentId).toBe("recruiter")
    // Each follow-up: an open promise with an owner.
    const open = h.requests.listOpen().filter((r) => r.promise)
    expect(open.map((p) => p.text).sort()).toEqual(["Decide the start date", "Send the candidate the written offer terms"])
    for (const p of open) expect(p.owedBy ?? p.agentId).toBeTruthy()
    expect(open.find((p) => p.text === "Decide the start date")!.owedBy).toBe("owner")
    expect(open.find((p) => p.text.startsWith("Send"))!.agentId).toBe("recruiter")
    expect(open.every((p) => p.dueAt === null)).toBe(true)
    // The owner got one message, opening with its subject.
    expect(h.told).toHaveLength(1)
    expect(h.told[0]).toMatch(/^About the job interview with a test candidate: the talk ended \(closed\)\. Note: https:\/\/git\.example\.com\/hiring\/issues\/7#note-1\. 2 follow-ups/)
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
    expect(h.notes.get(HOME)).toHaveLength(1)
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
    }, meta: { followUp: false } })
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
    expect(situationsClosing(h.situations, { id, purpose: "an interview", home: HOME }).status).toBe(200)
    expect(h.situations.get(KEY)!.closing).toEqual({ purpose: "an interview", home: HOME })
    expect(h.situations.get(KEY)!.template).toBe("meeting")
    expect(situationsClosing(h.situations, { id, purpose: "", home: HOME }).status).toBe(400)
    expect(situationsClosing(h.situations, { id: "nope-nope", purpose: "x", home: HOME }).status).toBe(404)
    expect(situationsClosing(h.situations, { id, clear: true }).status).toBe(200)
    expect(h.situations.get(KEY)!.closing).toBeNull()
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
