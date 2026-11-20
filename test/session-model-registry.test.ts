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

const seat = vi.hoisted(() => ({ route: vi.fn() }))
vi.mock("../src/agents/edge-routing", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, edgeSeatOn: () => true, routeTaskEdge: seat.route }
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
  lines = []
  rotations = []
  seat.route.mockReset()
  seat.route.mockResolvedValue(keep())
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

  it("stores the model the turn was billed on when it differs from the one asked", async () => {
    const r = registry()
    const sessions = stored(r, AGENT, 5 * MIN)
    billed.model = CHEAP
    await turn(r)
    expect(sessions.getSessionModel("ops", "telegram", "chat-1")).toBe(CHEAP)
  })

  it("a fresh session always names its model", async () => {
    const r = registry()
    await turn(r)
    expect(calls[0]).toMatchObject({ model: AGENT, resume: undefined })
  })
})
