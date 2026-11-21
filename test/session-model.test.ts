import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { rmSync, writeFileSync } from "fs"
import { resolve } from "path"

// #2001: one model per session. The rules, as pure functions, and the
// session store fields they read and write.

const hoisted = vi.hoisted(() => ({ askSeat: vi.fn(), getSeatMode: vi.fn() }))
vi.mock("../src/decisions/seat", () => ({ askSeat: hoisted.askSeat, getSeatMode: hoisted.getSeatMode }))

import {
  canHoldUpgrade, coldResumeChoice, isWarm, modelToStore, namedModelRotates, resumeModel, sameModel, warmEdgeRotates,
} from "../src/agents/session-model"
import { CACHE_TTL_MS, routeTaskModel } from "../src/agents/routing"
import { routeTaskEdge, type EdgeRouteResult } from "../src/agents/edge-routing"
import { SessionStore } from "../src/agents/sessions"

const AGENT = "claude-opus-5-5"
const EDGE = "claude-fable-5-2"
const CHEAP = "claude-haiku-5-1"
const MIN = 60_000

const edge = (over: Partial<EdgeRouteResult>): EdgeRouteResult => ({
  upgraded: false, subagents: false, needsEdge: null, subagentsHelp: null, reason: "test", ...over,
})

describe("sameModel", () => {
  it("matches a dated id or an alias against the configured name", () => {
    expect(sameModel(AGENT, AGENT)).toBe(true)
    expect(sameModel(AGENT, `${AGENT}-20261001`)).toBe(true)
    expect(sameModel(AGENT, `${AGENT}[1m]`)).toBe(true)
    expect(sameModel("opus", AGENT)).toBe(true)
  })
  it("keeps different models apart", () => {
    expect(sameModel(AGENT, EDGE)).toBe(false)
    expect(sameModel("gpt-5", "gpt-5-mini")).toBe(false)
    expect(sameModel(undefined, AGENT)).toBe(false)
  })
})

describe("the cache lifetime", () => {
  it("is the router's, exported, and splits warm from cold", () => {
    expect(CACHE_TTL_MS).toBe(60 * MIN)
    expect(isWarm(59 * MIN)).toBe(true)
    expect(isWarm(61 * MIN)).toBe(false)
  })
})

describe("condition 1: a resume names the stored model", () => {
  it("uses the stored model over the job model and the agent's model", () => {
    expect(resumeModel(EDGE, undefined, AGENT)).toBe(EDGE)
    expect(resumeModel(EDGE, CHEAP, AGENT)).toBe(EDGE)
  })
  it("falls back to the job model, then the agent's model, for a session stored before #2001", () => {
    expect(resumeModel(undefined, CHEAP, AGENT)).toBe(CHEAP)
    expect(resumeModel(undefined, undefined, AGENT)).toBe(AGENT)
  })
})

describe("rule 2: a model named on the task", () => {
  it("starts a new session when it differs from the stored one", () => {
    expect(namedModelRotates(AGENT, EDGE)).toBe(true)
    expect(namedModelRotates(AGENT, AGENT)).toBe(false)
    expect(namedModelRotates(AGENT, undefined)).toBe(false)
    expect(namedModelRotates(undefined, EDGE)).toBe(false)
  })
})

describe("rule 4 (condition 2): a cold resume", () => {
  it("an answered low P on a session on the edge model starts a new session on the agent's model", () => {
    const c = coldResumeChoice({
      stored: EDGE, agentModel: AGENT,
      edge: edge({ seat: "answered", needsEdge: 0.1 }),
    })
    expect(c).toEqual({ rotate: true, model: AGENT })
  })
  it("the same session with the seat timing out resumes on the edge model", () => {
    const c = coldResumeChoice({
      stored: EDGE, agentModel: AGENT,
      edge: edge({ seat: "failed", reason: "edge seat unavailable" }),
    })
    expect(c).toEqual({ rotate: false, model: EDGE })
  })
  it("any failed seat keeps the stored model, even when another answered", () => {
    const c = coldResumeChoice({
      stored: EDGE, agentModel: AGENT,
      edge: edge({ seat: "failed" }),
      routed: { downgraded: false, needsFlagship: 0.9, reason: "x", seat: "answered" },
    })
    expect(c).toEqual({ rotate: false, model: EDGE })
  })
  it("no seat asked or only shadow answers keeps the stored model", () => {
    expect(coldResumeChoice({ stored: CHEAP, agentModel: AGENT })).toEqual({ rotate: false, model: CHEAP })
    expect(coldResumeChoice({ stored: CHEAP, agentModel: AGENT, edge: edge({ reason: "shadow" }) }))
      .toEqual({ rotate: false, model: CHEAP })
  })
  it("a confident edge answer moves a cold session up", () => {
    const c = coldResumeChoice({
      stored: AGENT, agentModel: AGENT,
      edge: edge({ seat: "answered", model: EDGE, upgraded: true, needsEdge: 0.9 }),
    })
    expect(c).toEqual({ rotate: true, model: EDGE })
  })
  it("a triage rule counts as an answer", () => {
    const c = coldResumeChoice({
      stored: AGENT, agentModel: AGENT,
      triage: { model: CHEAP, downgraded: true, needsFlagship: null, reason: "triage" },
    })
    expect(c).toEqual({ rotate: true, model: CHEAP })
  })
  it("the same model answered resumes", () => {
    const c = coldResumeChoice({ stored: AGENT, agentModel: AGENT, edge: edge({ seat: "answered", needsEdge: 0.1 }) })
    expect(c).toEqual({ rotate: false, model: AGENT })
  })
})

describe("condition 3: which warm sessions may hold an upgrade", () => {
  it("holds on the agent's own model or the edge model", () => {
    expect(canHoldUpgrade(AGENT, AGENT, EDGE)).toBe(true)
    expect(canHoldUpgrade(EDGE, AGENT, EDGE)).toBe(true)
    expect(canHoldUpgrade(CHEAP, AGENT, EDGE)).toBe(false)
  })
  it("a cheap session with a confident edge answer starts a new session", () => {
    const confident = edge({ seat: "answered", model: EDGE, upgraded: true, needsEdge: 0.9 })
    expect(warmEdgeRotates(CHEAP, AGENT, EDGE, confident)).toBe(EDGE)
    expect(warmEdgeRotates(AGENT, AGENT, EDGE, confident)).toBeUndefined()
    expect(warmEdgeRotates(CHEAP, AGENT, EDGE, edge({ seat: "answered", needsEdge: 0.1 }))).toBeUndefined()
    expect(warmEdgeRotates(CHEAP, AGENT, EDGE, edge({ seat: "failed" }))).toBeUndefined()
  })
})

describe("condition 4: the model stored is the one the turn asked for", () => {
  it("stores the asked model, even when a side model was billed the most", () => {
    expect(modelToStore(AGENT, `${AGENT}-20261001`)).toBe(AGENT)
    expect(modelToStore(AGENT, undefined)).toBe(AGENT)
    // modelUsage's most expensive entry can be a side or sub-agent model.
    expect(modelToStore(AGENT, CHEAP)).toBe(AGENT)
    expect(modelToStore(AGENT, EDGE)).toBe(AGENT)
  })
  it("stores nothing for an agent with no model named", () => {
    expect(modelToStore(undefined, AGENT)).toBeUndefined()
  })
})

describe("seat outcomes", () => {
  beforeEach(() => { hoisted.askSeat.mockReset(); hoisted.getSeatMode.mockReset() })
  const base = { message: "find the cause", agent: "ops", tier: "claude-code", edgeModel: EDGE, currentModel: AGENT }

  it("edge seat: an active answer is answered, a timeout is failed, shadow is neither", async () => {
    hoisted.askSeat.mockResolvedValueOnce({ answers: { needsEdge: { noul: 0.1 }, subagentsHelp: { noul: 0.1 } }, mode: "active", callId: "c" })
    expect((await routeTaskEdge(base)).seat).toBe("answered")
    hoisted.askSeat.mockResolvedValueOnce(null)
    expect((await routeTaskEdge(base)).seat).toBe("failed")
    hoisted.askSeat.mockRejectedValueOnce(new Error("boom"))
    expect((await routeTaskEdge(base)).seat).toBe("failed")
    hoisted.askSeat.mockResolvedValueOnce({ answers: { needsEdge: { noul: 0.9 }, subagentsHelp: { noul: 0.1 } }, mode: "shadow", callId: "c" })
    expect((await routeTaskEdge(base)).seat).toBeUndefined()
    hoisted.askSeat.mockResolvedValueOnce({ answers: { needsEdge: { noul: 0.9 }, subagentsHelp: { noul: 0.1 } }, mode: "active", callId: "c" })
    expect((await routeTaskEdge(base)).seat).toBe("answered")
  })

  it("downgrade seat: the same outcomes", async () => {
    const opts = { message: "rename a file", agent: "ops", cheapModel: CHEAP }
    hoisted.askSeat.mockResolvedValueOnce({ answers: { needsFlagship: { noul: 0.9 } }, mode: "active", callId: "c" })
    expect((await routeTaskModel(opts)).seat).toBe("answered")
    hoisted.askSeat.mockResolvedValueOnce(null)
    expect((await routeTaskModel(opts)).seat).toBe("failed")
  })
})

describe("SessionStore sessionModel", () => {
  const DIR = resolve(__dirname, "../.test-sessions-model")
  let store: SessionStore
  beforeEach(() => { rmSync(DIR, { recursive: true, force: true }); store = new SessionStore(DIR, { staleMinutes: 720 }) })
  afterEach(() => rmSync(DIR, { recursive: true, force: true }))

  it("the three setters store the model beside the session id", () => {
    store.setClaudeSessionId("a", "telegram", "c1", "s1", AGENT)
    expect(store.getSessionModel("a", "telegram", "c1")).toBe(AGENT)
    store.setCodexSessionId("a", "telegram", "c2", "t1", "gpt-5")
    expect(store.getSessionModel("a", "telegram", "c2")).toBe("gpt-5")
    store.setOpenCodeSessionId("a", "telegram", "c3", "o1", "x-model")
    expect(store.getSessionModel("a", "telegram", "c3")).toBe("x-model")
  })

  it("a setter without a model leaves no stale model behind", () => {
    store.setClaudeSessionId("a", "telegram", "c1", "s1", AGENT)
    store.setClaudeSessionId("a", "telegram", "c1", "s2")
    expect(store.getSessionModel("a", "telegram", "c1")).toBeUndefined()
  })

  it("clearClaudeSessionId and clearSession clear it", () => {
    store.setClaudeSessionId("a", "telegram", "c1", "s1", AGENT)
    store.clearClaudeSessionId("a", "telegram", "c1")
    expect(store.getSessionModel("a", "telegram", "c1")).toBeUndefined()
    store.setClaudeSessionId("a", "telegram", "c1", "s1", AGENT)
    store.clearSession("a", "telegram", "c1")
    expect(store.getSessionModel("a", "telegram", "c1")).toBeUndefined()
  })

  it("continueFrom copies it", () => {
    store.setClaudeSessionId("a", "telegram", "c1", "s1", EDGE)
    expect(store.continueFrom("a", { channel: "telegram", chatId: "c1" }, { channel: "api", chatId: "c9" })).toBe(true)
    expect(store.getSessionModel("a", "api", "c9")).toBe(EDGE)
  })

  it("continueFrom leaves no pointer unless asked: other continuations stay as before (#2010)", () => {
    store.addUserMessage("a", "a2a", "src", "agent:p", "Review team/site!12")
    store.setClaudeSessionId("a", "a2a", "src", "s1", AGENT)
    expect(store.continueFrom("a", { channel: "a2a", chatId: "src" }, { channel: "a2a", chatId: "dst" })).toBe(true)
    expect(store.getSession("a", "a2a", "dst").continuedFrom).toBeUndefined()
    expect(store.continuedFromMessage("a", "a2a", "dst", "x")).toBeNull()
    // A later plain continuation drops a pointer left by a topic resume.
    expect(store.continueFrom("a", { channel: "a2a", chatId: "src" }, { channel: "a2a", chatId: "dst2" }, { pointer: true })).toBe(true)
    expect(store.continueFrom("a", { channel: "a2a", chatId: "src" }, { channel: "a2a", chatId: "dst2" })).toBe(true)
    expect(store.getSession("a", "a2a", "dst2").continuedFrom).toBeUndefined()
  })

  it("continueFrom leaves a pointer for a topic resume, never a copied message (#2010)", () => {
    store.addUserMessage("a", "a2a", "src", "agent:p", "Review team/site!12")
    store.setClaudeSessionId("a", "a2a", "src", "s1", AGENT)
    expect(store.continueFrom("a", { channel: "a2a", chatId: "src" }, { channel: "a2a", chatId: "dst" }, { pointer: true })).toBe(true)
    store.addUserMessage("a", "a2a", "dst", "agent:p", "Now fix the notes")
    const dst = store.getSession("a", "a2a", "dst")
    expect(dst.continuedFrom).toEqual({ channel: "a2a", chatId: "src" })
    expect(dst.messages.map((m) => m.content)).toEqual(["Now fix the notes"])
    expect(store.continuedFromMessage("a", "a2a", "dst", "Now fix the notes")).toBe("Review team/site!12")
    // A chat that was not continued has nothing to offer.
    expect(store.continuedFromMessage("a", "a2a", "src", "x")).toBeNull()
  })

  it("the midnight carry copies it, and the OpenCode session id", () => {
    const prevDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const key = `a:telegram:g1:${prevDay}`
    const at = new Date(Date.now() - 2 * 3600_000).toISOString()
    store.getSession("a", "telegram", "init") // creates the directory
    writeFileSync(resolve(DIR, ".agentx/sessions", `${key}.json`), JSON.stringify({
      id: key, agentId: "a", channel: "telegram", chatId: "g1", day: prevDay, messages: [],
      createdAt: at, updatedAt: at, opencodeSessionId: "ses-yesterday", sessionModel: EDGE,
    }))
    const s = store.getSession("a", "telegram", "g1")
    expect(s.opencodeSessionId).toBe("ses-yesterday")
    expect(s.sessionModel).toBe(EDGE)
  })
})
