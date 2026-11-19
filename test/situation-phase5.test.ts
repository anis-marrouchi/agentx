import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageRouter } from "../src/channels/router"
import { setMessageRouter } from "../src/channels/router-instance"
import { setSendToChatStore } from "../src/situations/send-to-chat"
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../src/channels/types"
import { HookRegistry } from "../src/hooks/registry"
import { SituationStore } from "../src/situations/store"
import { SituationGate } from "../src/situations/gate"
import { SituationSeat } from "../src/situations/seat"
import { situationKey } from "../src/situations/key"
import { DEFAULT_SITUATIONS_CONFIG, type SituationsConfig } from "../src/situations/config"
import { configureDecisions, labelSeatCall, resetDecisionsRuntime } from "../src/decisions/seat"
import { _resetDecisionBackendsForTesting, registerDecisionBackend, type DecisionBackend } from "../src/decisions/backend"
import { DecisionStore } from "../src/decisions/store"
import { finalizeAnswer } from "../src/decisions/normalize"
import { SITUATION_PHASE_SEAT } from "../src/decisions/seats/situation-phase"

// #1892 phase 5, proof of done (design 9, row 5): "The calibration report
// states the false 'no reply' rate. The seat goes active only below the
// limit Anis accepts." Run through the real router, the real gate, the
// real askSeat and a real decisions store. The backend is a stub that
// answers like a model would. Neutral ids only.

const GROUP = "120363000000000000@g.us"
const P = { id: "15550111@s.whatsapp.net", name: "Candidate" }

let dir: string
const cwd = process.cwd()
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentx-1892p5-")); process.chdir(dir) })
afterAll(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })
afterEach(() => { setSendToChatStore(null); setMessageRouter(null); resetDecisionsRuntime(); _resetDecisionBackendsForTesting() })

/** P(needs a reply) the stub gives each message. */
const NEEDS_REPLY: Record<string, number> = { "ok": 0.05, "👍": 0.08, "thanks John": 0.1, "perfect, thanks": 0.9 }

const load = { inflight: 0, max: 0 }

function stubBackend(fail?: Error, delayMs = 0): DecisionBackend {
  return {
    name: "stub",
    capabilities: { probabilitySource: "synthetic", calibratedProbabilities: false, maxChoiceOptions: 255, maxStateChars: 24_000, parallelQuestions: true, images: false },
    async decide(req: any) {
      if (fail) throw fail
      load.inflight++
      load.max = Math.max(load.max, load.inflight)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      load.inflight--
      const text = String(req.state.message)
      const p = NEEDS_REPLY[text] ?? 0.5
      const answers: Record<string, unknown> = {
        phase: finalizeAnswer(req.questions.phase, { probabilities: { during: p, ending: 0, ended: 1 - p } } as any).answer,
        needsReply: finalizeAnswer(req.questions.needsReply, { noul: p } as any).answer,
        importance: finalizeAnswer(req.questions.importance, { probabilities: { low: 0.2, normal: 0.7, high: 0.1 } } as any).answer,
      }
      return { model: "stub-1", answers, usage: { inputTokens: 100, outputTokens: 0 }, meta: { backend: "stub", structureMode: "mock", answerMode: "probabilities", repaired: false, retries: 0, stateTruncated: false, latencyMs: 1 } } as any
    },
  }
}

let n = 0
/** The seat as the operator names it: always with a hosted backend. */
const named = (mode: "shadow" | "active" | "off", extra: Record<string, unknown> = {}) => ({ seats: { [SITUATION_PHASE_SEAT]: { mode, backend: "stub", ...extra } } })

function world(seatMode?: "shadow" | "active" | "off", fail?: Error, delayMs = 0) {
  registerDecisionBackend("stub", () => stubBackend(fail, delayMs))
  const decisions = new DecisionStore({ path: join(dir, `decisions-${++n}.sqlite`) })
  // The default backend is the local CLI one, not registered here: a call
  // that fell through to it would fail. The seat must use its named one.
  configureDecisions({ enabled: true, defaultBackend: "local", store: decisions, ...(seatMode ? named(seatMode) : { seats: {} }) })

  const store = new SituationStore(new Database(":memory:"))
  const cfg: SituationsConfig = { ...DEFAULT_SITUATIONS_CONFIG, mode: "active", seat: { noReplyBelow: 0.2, minLabeled: 4 } }
  const sent: OutgoingMessage[] = []
  const reacts: string[] = []
  const turns: string[] = []
  const registry = {
    getAgent: (id: string) => (id === "recruiter" ? { name: "Recruiter", mentions: [] } : undefined),
    getSessionStore: () => ({ addAgentMessage: () => {} }),
    execute: async (req: { message: string }) => {
      const latest = req.message.split("\n\n").pop() ?? req.message
      turns.push(latest)
      return { content: /goodbye/i.test(latest) ? "Goodbye, and good luck." : "Noted." }
    },
  }
  const router = new MessageRouter(registry as any, { channels: { telegram: { accounts: {} } }, agents: {} } as any, new HookRegistry(), () => {})
  const adapter = {
    name: "whatsapp", start: async () => {}, stop: async () => {}, onMessage: () => {},
    send: async (m: OutgoingMessage) => { sent.push(m); return `out-${sent.length}` },
    react: async (_c: string, _m: string, emoji?: string) => { reacts.push(emoji ?? "") },
    sendTyping: async () => {},
  } as unknown as ChannelAdapter
  router.addChannel(adapter)
  setMessageRouter(router)
  setSendToChatStore(store)
  const seat = new SituationSeat({ settings: () => cfg, cacheMs: 0 })
  const gate = new SituationGate({ store, settings: () => cfg, seat })
  router.setSituationGate(gate)

  const say = async (text: string) => {
    const msg: IncomingMessage = {
      id: `in-${++n}`, channel: "whatsapp", accountId: "default", sender: P,
      group: { id: GROUP, name: "Interview" }, text, timestamp: new Date(), resolvedAgent: "recruiter",
    }
    await (router as any).handleMessage(adapter, msg)
    await seat.settled()
  }
  const phase = () => store.get(situationKey("whatsapp", "default", GROUP))?.phase
  /** Hello, the agent answers; thanks and goodbye, the agent says goodbye: ended. */
  const endTalk = async () => {
    await say("Hello, I am here for the interview.")
    await say("Thank you, goodbye!")
    expect(phase()).toBe("ended")
  }
  const seatRows = () => decisions.gradedRows({ seat: SITUATION_PHASE_SEAT, question: "needsReply" })
  return { store, cfg, sent, reacts, turns, seat, gate, say, phase, endTalk, decisions, seatRows }
}

describe("phase 5 proof of done: the seat in shadow, the report, then active below the owner's limit", () => {
  it("walks the whole path", async () => {
    // 0. Shipped off: decisions on, the seat not named. Nothing is asked.
    const w = world()
    expect(w.seat.plan().mode).toBe("off")
    await w.endTalk()
    await w.say("ok")
    expect(w.seatRows()).toHaveLength(0)

    // 1. The owner names it in shadow, with a hosted backend.
    configureDecisions(named("shadow"))
    expect(w.seat.plan().mode).toBe("shadow")
    const turnsBefore = w.turns.length
    for (const t of ["ok", "👍", "thanks John", "perfect, thanks", "ok"]) await w.say(t)
    // Shadow changes nothing: every unsure message reached the agent.
    expect(w.turns.length).toBe(turnsBefore + 5)
    expect(w.reacts.filter((r) => r === "🙏")).toEqual([])
    expect(w.phase()).toBe("ended") // unsure never reopens
    // Each was asked once; the four "no reply" answers are would-drops
    // in the gate log, with the seat's call id for labelling.
    const rows = w.seatRows()
    expect(rows).toHaveLength(5)
    const log = w.store.gateLog({ outcome: "would-drop" })
    expect(log.map((r) => r.text).sort()).toEqual(["ok", "ok", "thanks John", "👍"])
    expect(log.every((r) => r.seatCallId && /seat/.test(r.reason))).toBe(true)
    // What left the node names no sender: only "person", never a name or id.
    const states = (w.decisions.db.prepare("SELECT state_json FROM decision_calls").all() as Array<{ state_json: string }>).map((r) => r.state_json).join("\n")
    expect(states).toContain("\"sender\":\"person\"")
    expect(states).not.toMatch(/Candidate|15550111/)

    // 2. A person reads the would-drops and labels them: "thanks John" did
    // need a reply (it was to a colleague named John in the chat).
    for (const r of log) labelSeatCall(r.seatCallId!, "needsReply", r.text === "thanks John" ? "yes" : "no", { labeledBy: "reviewer" })
    const report = w.seat.report()
    expect(report).toMatchObject({ noReply: 4, labeled: 4, falseNoReply: 1 })
    expect(report.rate).toBeCloseTo(0.25, 6)
    expect(w.seat.reportText().join("\n")).toContain("False \"no reply\" rate: 25.0% (1 of 4 labeled)")

    // 3. Switched to active with no limit set: it still only records.
    configureDecisions(named("active"))
    expect(w.seat.plan()).toMatchObject({ mode: "active", act: false })
    let before = w.turns.length
    await w.say("ok")
    expect(w.turns.length).toBe(before + 1)

    // 4. The owner's limit is under the report's upper bound: not active.
    w.cfg.seat = { ...w.cfg.seat, maxFalseNoReply: 0.3 }
    expect(w.seat.plan()).toMatchObject({ act: false, why: expect.stringMatching(/over the limit/) })
    before = w.turns.length
    await w.say("ok")
    expect(w.turns.length).toBe(before + 1)

    // 5. Enough clean labels bring the bound under the limit: the seat acts.
    // (Labels from another backend would not count: see the unit test.)
    for (let i = 0; i < 60; i++) {
      const id = w.decisions.recordCall({
        seat: SITUATION_PHASE_SEAT, mode: "shadow", backend: "stub", model: "stub-1",
        meta: { structureMode: "mock", answerMode: "probabilities", retries: 0, stateTruncated: false, latencyMs: 1 } as any,
        state: { message: "ok" }, questions: { needsReply: { type: "noul" } } as any,
        answers: { needsReply: { type: "noul", noul: 0.05 } } as any,
      })
      labelSeatCall(id, "needsReply", "no")
    }
    expect(w.seat.plan()).toMatchObject({ mode: "active", act: true })
    before = w.turns.length
    await w.say("ok")
    expect(w.turns.length).toBe(before) // held: no run
    expect(w.reacts.filter((r) => r === "🙏")).toEqual(["🙏"]) // a person gets the reaction (Q2)
    const dropped = w.store.gateLog({ outcome: "drop" })
    expect(dropped).toHaveLength(1)
    expect(dropped[0].reason).toMatch(/seat: no reply needed/)
    // A confident "needs a reply" still passes.
    await w.say("perfect, thanks")
    expect(w.turns.length).toBe(before + 1)

    // A person releases the wrong drop: the seat's call is labelled "yes".
    const released = w.gate.release(dropped[0].id)
    expect(released.ok).toBe(true)
    const truth = w.seatRows().find((r) => r.callId === dropped[0].seatCallId)?.truth
    expect(truth).toBe("yes")

    // 6. The owner switches the seat off: today's rule again.
    configureDecisions(named("off"))
    await w.endTalk()
    before = w.turns.length
    await w.say("ok")
    expect(w.turns.length).toBe(before + 1)
  })

  it("fails closed to today's behaviour when the seat errors (credits out)", async () => {
    const w = world("active", new Error("402 Payment Required: insufficient credits"))
    w.cfg.seat = { ...w.cfg.seat, maxFalseNoReply: 0.9, minLabeled: 1 }
    // A report that passes, from earlier rows.
    const id = w.decisions.recordCall({
      seat: SITUATION_PHASE_SEAT, mode: "active", backend: "stub", model: "stub-1",
      meta: { structureMode: "mock", answerMode: "probabilities", retries: 0, stateTruncated: false, latencyMs: 1 } as any,
      state: { message: "ok" }, questions: { needsReply: { type: "noul" } } as any, answers: { needsReply: { type: "noul", noul: 0.05 } } as any,
    })
    labelSeatCall(id, "needsReply", "no")
    expect(w.seat.plan().act).toBe(true)
    await w.endTalk()
    const before = w.turns.length
    await w.say("ok")
    expect(w.turns.length).toBe(before + 1) // passed, as without the seat
    expect(w.store.gateLog({ outcome: "drop" })).toHaveLength(0)
  })

  it("switching the backend resets readiness", async () => {
    const w = world("active")
    w.cfg.seat = { ...w.cfg.seat, maxFalseNoReply: 0.9, minLabeled: 1 }
    const id = w.decisions.recordCall({
      seat: SITUATION_PHASE_SEAT, mode: "active", backend: "stub", model: "stub-1",
      meta: { structureMode: "mock", answerMode: "probabilities", retries: 0, stateTruncated: false, latencyMs: 1 } as any,
      state: { message: "ok" }, questions: { needsReply: { type: "noul" } } as any, answers: { needsReply: { type: "noul", noul: 0.05 } } as any,
    })
    labelSeatCall(id, "needsReply", "no")
    expect(w.seat.plan().act).toBe(true)
    expect(w.seat.report()).toMatchObject({ backend: "stub", model: "stub-1" })
    configureDecisions(named("active", { backend: "other" }))
    expect(w.seat.plan()).toMatchObject({ act: false })
    expect(w.seat.report()).toMatchObject({ backend: "other", calls: 0 })
  })

  it("an explored answer passes and is recorded as explored", async () => {
    const w = world("active")
    configureDecisions(named("active", { explore: 1 }))
    w.cfg.seat = { ...w.cfg.seat, maxFalseNoReply: 0.9, minLabeled: 1 }
    const id = w.decisions.recordCall({
      seat: SITUATION_PHASE_SEAT, mode: "active", backend: "stub", model: "stub-1",
      meta: { structureMode: "mock", answerMode: "probabilities", retries: 0, stateTruncated: false, latencyMs: 1 } as any,
      state: { message: "ok" }, questions: { needsReply: { type: "noul" } } as any, answers: { needsReply: { type: "noul", noul: 0.05 } } as any,
    })
    labelSeatCall(id, "needsReply", "no")
    await w.endTalk()
    const before = w.turns.length
    await w.say("ok")
    expect(w.turns.length).toBe(before + 1)
    const fresh = w.seatRows().find((r) => r.callId !== id)
    expect(fresh).toMatchObject({ action: "skip", explored: true })
  })

  it("two messages for one chat wait for the seat one after the other", async () => {
    const w = world("active", undefined, 30)
    w.cfg.seat = { ...w.cfg.seat, maxFalseNoReply: 0.9, minLabeled: 1 }
    const id = w.decisions.recordCall({
      seat: SITUATION_PHASE_SEAT, mode: "active", backend: "stub", model: "stub-1",
      meta: { structureMode: "mock", answerMode: "probabilities", retries: 0, stateTruncated: false, latencyMs: 1 } as any,
      state: { message: "ok" }, questions: { needsReply: { type: "noul" } } as any, answers: { needsReply: { type: "noul", noul: 0.05 } } as any,
    })
    labelSeatCall(id, "needsReply", "no")
    await w.endTalk()
    load.max = 0
    const before = w.turns.length
    await Promise.all([w.say("ok"), w.say("👍")])
    expect(load.max).toBe(1)
    expect(w.turns.length).toBe(before)
    expect(w.store.gateLog({ outcome: "drop" })).toHaveLength(2)
  })

  it("is not asked when its answer could change nothing", async () => {
    const w = world("shadow")
    const key = situationKey("whatsapp", "default", GROUP)
    w.store.create(key, "ending", "set up for the test") // ending, slot free: a closer would pass too
    await w.say("ok")
    expect(w.seatRows()).toHaveLength(0)
  })

  it("is never asked about a clear message, or before the talk is ending", async () => {
    const w = world("shadow")
    await w.say("ok") // during: unsure, but nothing to decide
    await w.say("Can you send the contract?")
    expect(w.seatRows()).toHaveLength(0)
    await w.say("Thank you, goodbye!")
    await w.say("Thanks again, bye!") // courtesy: the word list decides
    expect(w.seatRows()).toHaveLength(0)
  })
})

describe("importance (situations.importance)", () => {
  const msg = (from: { id: string; name: string; isBot?: boolean }, text = "Hello"): IncomingMessage => ({
    id: `imp-${++n}`, channel: "whatsapp", accountId: "default", sender: from, group: { id: GROUP, name: "Interview" }, text, timestamp: new Date(),
  })
  const setup = (enabled: boolean, promise: { dueAt: number | null } | null = null) => {
    const store = new SituationStore(new Database(":memory:"))
    const cfg: SituationsConfig = { ...DEFAULT_SITUATIONS_CONFIG, mode: "active", importance: { enabled } }
    const gate = new SituationGate({
      store, settings: () => cfg,
      importance: { roleOf: (m) => (m.sender.id === P.id ? "client" : null), openPromise: () => promise },
    })
    const run = (m: IncomingMessage) => { const d = gate.decide(m); gate.commit(d, m); return store.get(d.key) }
    return { store, run }
  }

  it("off by default: nothing is judged", () => {
    expect(setup(false).run(msg(P))?.importance).toBeNull()
  })

  it("a client is high, a bot with a promise due in 3 days is normal, an unknown person keeps what is there", () => {
    const w = setup(true)
    expect(w.run(msg(P))).toMatchObject({ importance: "high", importanceWhy: "a client is in the talk" })
    expect(w.run(msg({ id: "15550199@s.whatsapp.net", name: "Someone" }))?.importance).toBe("high")
    const b = setup(true, { dueAt: Date.now() + 3 * 86_400_000 })
    expect(b.run(msg({ id: "bot-1", name: "Bot", isBot: true }))).toMatchObject({ importance: "normal", importanceWhy: "an open promise on this chat" })
    expect(setup(true).run(msg({ id: "15550199@s.whatsapp.net", name: "Someone" }))).toMatchObject({ importance: "normal" })
  })

  it("the [Situation] line names a high importance only when on", async () => {
    const { renderSituationLayer } = await import("../src/situations/context")
    const row = setup(true).run(msg(P))!
    expect(renderSituationLayer(row, { fresh: true, importance: true })).toContain("This talk matters: a client is in the talk.")
    expect(renderSituationLayer(row, { fresh: true })).not.toContain("matters")
  })
})
