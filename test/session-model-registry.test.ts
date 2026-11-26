import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2001: no model switch inside a session, checked through a real
// AgentRegistry with the runtime and the edge seat mocked.

const calls = vi.hoisted(() => [] as Array<{ model?: string; resume?: string; context: string; turnNote?: string }>)
const billed = vi.hoisted(() => ({ model: undefined as string | undefined, n: 0 }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, task: any, _providers: any, _onDelta: any, historyContext: string, resumeSessionId?: string) => {
      calls.push({ model: task.model, resume: resumeSessionId, context: historyContext ?? "", turnNote: task.turnNote })
      billed.n++
      return Promise.resolve({
        content: "ok", duration: 1,
        claudeSessionId: resumeSessionId ?? `native-new-${billed.n}`,
        ...(billed.model ? { billedModel: billed.model } : {}),
      })
    },
  }
})

const seat = vi.hoisted(() => ({ route: vi.fn(), on: true }))
vi.mock("../src/agents/edge-routing", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, edgeSeatOn: () => seat.on, routeTaskEdge: seat.route }
})
const gate = vi.hoisted(() => ({ slow: undefined as Record<string, unknown> | undefined }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => gate.slow
      ? new Promise((res) => setTimeout(() => res(gate.slow), 30))
      : real.evaluateRequest(...args),
  }
})
vi.mock("../src/agents/rotation-memo", () => ({
  extractRotationMemo: async () => ({ memo: undefined, reason: "test", durationMs: 0 }),
}))

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"

const AGENT = "claude-opus-5-5"
const EDGE = "claude-fable-5-2"
const CHEAP = "claude-haiku-5-1"
const MIN = 60_000

const keep = (over: Record<string, unknown> = {}) => ({
  upgraded: false, subagents: false, needsEdge: 0.1, subagentsHelp: 0.1, reason: "keep", seat: "answered", ...over,
})
const hard = (over: Record<string, unknown> = {}) => ({
  model: EDGE, upgraded: true, subagents: false, needsEdge: 0.9, subagentsHelp: 0.1, reason: "hard", seat: "answered", ...over,
})
const failed = () => ({ upgraded: false, subagents: false, needsEdge: null, subagentsHelp: null, reason: "edge seat unavailable", seat: "failed" })

let dir: string
let lines: string[]
let rotations: any[]
const prevCwd = process.cwd()
const listen = (p: any) => { rotations.push(p) }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-session-model-"))
  process.chdir(dir)
  calls.length = 0
  billed.model = undefined
  billed.n = 0
  gate.slow = undefined
  lines = []
  rotations = []
  seat.route.mockReset()
  seat.route.mockResolvedValue(keep())
  seat.on = true
  getEventBus().on("session:rotated", listen)
})
afterEach(() => {
  getEventBus().off("session:rotated", listen)
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(model = AGENT): AgentRegistry {
  const config = daemonConfigSchema.parse({
    jobState: { enabled: false },
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, model } },
    decisions: { routing: { edgeModels: { "claude-code": EDGE } } },
  })
  return new AgentRegistry(config, (l: string) => { lines.push(l) })
}

/** A stored session on `model`, idle for `idleMs`. */
function stored(r: AgentRegistry, model: string | undefined, idleMs: number) {
  const sessions = (r as any).sessions
  sessions.addUserMessage("ops", "telegram", "chat-1", "Sam", "earlier question about the queue")
  sessions.setClaudeSessionId("ops", "telegram", "chat-1", "native-1", model)
  sessions.getSession("ops", "telegram", "chat-1").updatedAt = new Date(Date.now() - idleMs).toISOString()
  return sessions
}

const turn = (r: AgentRegistry, extra: Record<string, unknown> = {}) =>
  r.execute({ message: "hello", agentId: "ops", context: { channel: "telegram", chatId: "chat-1", sender: "Sam" }, ...extra } as any)

const modelRotations = () => rotations.filter((p) => p.reason === "model")

describe("one model per session (#2001)", () => {
  it("condition 1: a warm resume runs on the stored model, not a changed config", async () => {
    const r = registry(AGENT)
    stored(r, EDGE, 5 * MIN)
    await turn(r)
    expect(calls[0]).toMatchObject({ model: EDGE, resume: "native-1" })
    expect(modelRotations()).toHaveLength(0)
  })

  it("a session stored on another runtime's model starts anew on the agent's model, warm or cold", async () => {
    for (const idle of [5 * MIN, 90 * MIN]) {
      calls.length = 0
      rotations.length = 0
      const r = registry(AGENT)
      const sessions = stored(r, "gpt-6.2-sol", idle)
      await turn(r)
      expect(calls[0].resume).toBeUndefined()
      expect(calls[0].model).toBe(AGENT)
      expect(calls[0].context).toContain("earlier question about the queue")
      expect(modelRotations()).toHaveLength(1)
      expect(lines.some((l) => l.includes("not a claude-code model"))).toBe(true)
      expect(sessions.getSessionModel("ops", "telegram", "chat-1")).not.toBe("gpt-6.2-sol")
    }
  })

  it("ping-pong: hard, easy, hard on a warm session gives no new session and one model", async () => {
    const r = registry()
    stored(r, AGENT, 5 * MIN)
    seat.route.mockResolvedValueOnce(hard()).mockResolvedValueOnce(keep()).mockResolvedValueOnce(hard())
    await turn(r)
    await turn(r)
    await turn(r)
    expect(calls.map((c) => c.model)).toEqual([AGENT, AGENT, AGENT])
    expect(calls.map((c) => c.resume)).toEqual(["native-1", "native-1", "native-1"])
    expect(modelRotations()).toHaveLength(0)
    const held = lines.filter((l) => l.includes("edge upgrade held"))
    expect(held).toHaveLength(2)
    expect(held[0]).toContain(`stored=${AGENT}`)
  })

  it("a warm turn keeps the implied-work note while the upgrade is held", async () => {
    const r = registry()
    stored(r, AGENT, 5 * MIN)
    seat.route.mockResolvedValueOnce(hard({ impliedWork: true, impliedP: 0.95, designChange: 0.9 }))
    await turn(r)
    expect(calls[0].model).toBe(AGENT)
    expect(calls[0].turnNote).toContain("[Implied request]")
  })

  it("cold upgrade: a confident seat on a cold session starts exactly one new session with history", async () => {
    const r = registry()
    const sessions = stored(r, AGENT, 90 * MIN)
    seat.route.mockResolvedValueOnce(hard())
    await turn(r)
    expect(modelRotations()).toHaveLength(1)
    expect(calls[0].resume).toBeUndefined()
    expect(calls[0].model).toBe(EDGE)
    expect(calls[0].context).toContain("earlier question about the queue")
    expect(lines.some((l) => l.includes(`model changed for telegram:chat-1 (${AGENT} → ${EDGE})`))).toBe(true)
    expect(sessions.getSessionModel("ops", "telegram", "chat-1")).toBe(EDGE)
  })

  it("rule 4: a cold session on the edge model with an answered low P moves to the agent's model", async () => {
    const r = registry()
    stored(r, EDGE, 90 * MIN)
    seat.route.mockResolvedValueOnce(keep())
    await turn(r)
    expect(modelRotations()).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: AGENT, resume: undefined })
  })

  it("rule 4: the same session with the seat timing out resumes on the edge model", async () => {
    const r = registry()
    stored(r, EDGE, 90 * MIN)
    seat.route.mockResolvedValueOnce(failed())
    await turn(r)
    expect(modelRotations()).toHaveLength(0)
    expect(calls[0]).toMatchObject({ model: EDGE, resume: "native-1" })
  })

  it("condition 3: a warm session on a cheap model with a confident edge answer starts a new session", async () => {
    const r = registry()
    stored(r, CHEAP, 5 * MIN)
    seat.route.mockResolvedValueOnce(hard())
    await turn(r)
    expect(modelRotations()).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: EDGE, resume: undefined })
  })

  it("rule 2: a model named on the task starts a new session when it differs, and resumes when it matches", async () => {
    const r = registry()
    stored(r, AGENT, 5 * MIN)
    await turn(r, { model: EDGE })
    expect(modelRotations()).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: EDGE, resume: undefined })
    expect(calls[0].context).toContain("earlier question about the queue")
    await turn(r, { model: EDGE })
    expect(calls[1]).toMatchObject({ model: EDGE, resume: "native-new-1" })
  })

  it("a session stored before #2001 resumes as before and gets its model stored", async () => {
    const r = registry()
    const sessions = stored(r, undefined, 5 * MIN)
    await turn(r)
    expect(modelRotations()).toHaveLength(0)
    expect(calls[0]).toMatchObject({ model: AGENT, resume: "native-1" })
    expect(sessions.getSessionModel("ops", "telegram", "chat-1")).toBe(AGENT)
  })

  it("stores the asked model when a side model dominated the turn's billing", async () => {
    const r = registry()
    const sessions = stored(r, AGENT, 5 * MIN)
    // billedModel is modelUsage's most expensive entry: here a sub-agent's.
    billed.model = EDGE
    await turn(r)
    expect(sessions.getSessionModel("ops", "telegram", "chat-1")).toBe(AGENT)
    billed.model = undefined
    await turn(r)
    expect(calls[1]).toMatchObject({ model: AGENT, resume: "native-1" })
  })

  it("request-gate holdout on a cold resume: early seat answers are dropped and the stored model holds", async () => {
    // The gate is still out at the check, so the seats start without it;
    // it then turns out active without preprocessing (the holdout arm).
    gate.slow = { active: true, preprocess: false, arm: "holdout" }
    const r = registry()
    stored(r, AGENT, 90 * MIN)
    seat.route.mockResolvedValueOnce(keep({ subagents: true, subagentsHelp: 0.9 }))
    await turn(r)
    expect(modelRotations()).toHaveLength(0)
    expect(calls[0]).toMatchObject({ model: AGENT, resume: "native-1" })
    expect(calls[0].turnNote).toBeUndefined()
  })

  describe("#2034: an owner's turn on a warm cheap session", () => {
    const ownerRegistry = () => {
      const config = daemonConfigSchema.parse({
        jobState: { enabled: false },
        node: { id: "test", name: "test" },
        agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, model: AGENT } },
        decisions: { routing: { edgeModels: { "claude-code": EDGE } } },
        session: { triage: { models: { "claude-code": CHEAP } } },
        people: [{ id: "sam", name: "Sam", role: "owner", identities: ["gitlab:sam"] }],
      })
      return new AgentRegistry(config, (l: string) => { lines.push(l) })
    }
    const gitlab = (r: AgentRegistry, ctx: Record<string, unknown>) =>
      r.execute({ message: "hello", agentId: "ops", context: { channel: "gitlab", chatId: "issue-7", ...ctx } } as any)
    const labelEvent = (r: AgentRegistry) => gitlab(r, { sender: "bot", channelMeta: { eventActions: ["labeled"] } })
    const ownerComment = (r: AgentRegistry) => gitlab(r, { sender: "Sam", senderUsername: "sam" })
    const tenMinutesLater = (r: AgentRegistry) => {
      ;(r as any).sessions.getSession("ops", "gitlab", "issue-7").updatedAt = new Date(Date.now() - 10 * MIN).toISOString()
    }

    for (const edgeOn of [true, false]) {
      it(`label event on the cheap model, owner comment 10 min later runs on the agent's model (edge check ${edgeOn ? "on" : "off"})`, async () => {
        seat.on = edgeOn
        const r = ownerRegistry()
        await labelEvent(r)
        expect(calls[0]).toMatchObject({ model: CHEAP, resume: undefined })
        tenMinutesLater(r)
        await ownerComment(r)
        expect(modelRotations()).toHaveLength(1)
        expect(calls[1]).toMatchObject({ model: AGENT, resume: undefined })
        expect((r as any).sessions.getSessionModel("ops", "gitlab", "issue-7")).toBe(AGENT)
        // The next owner turn resumes on the agent's model: no second rotation.
        await ownerComment(r)
        expect(calls[2]).toMatchObject({ model: AGENT, resume: "native-new-2" })
        expect(modelRotations()).toHaveLength(1)
      })
    }

    it("a non-owner turn on the warm cheap session keeps the cheap model", async () => {
      const r = ownerRegistry()
      await labelEvent(r)
      tenMinutesLater(r)
      await gitlab(r, { sender: "Kim", senderUsername: "kim" })
      expect(modelRotations()).toHaveLength(0)
      expect(calls[1]).toMatchObject({ model: CHEAP, resume: "native-new-1" })
    })

    it("an owner turn on a warm session already on the agent's model keeps it, no cache loss", async () => {
      const r = ownerRegistry()
      await ownerComment(r)
      tenMinutesLater(r)
      await ownerComment(r)
      expect(modelRotations()).toHaveLength(0)
      expect(calls[1]).toMatchObject({ model: AGENT, resume: "native-new-1" })
    })
  })

  it("a fresh session always names its model", async () => {
    const r = registry()
    await turn(r)
    expect(calls[0]).toMatchObject({ model: AGENT, resume: undefined })
  })
})
