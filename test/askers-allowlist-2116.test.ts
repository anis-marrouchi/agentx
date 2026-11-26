import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Who may ask an agent (#2116): `agents.<id>.askers` lists the people and
// agents it takes work from. Unset is open, as before.

const run = vi.hoisted(() => ({ calls: 0 }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, executeTask: () => { run.calls++; return Promise.resolve({ content: "ok", duration: 1 }) } }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { askerRefusal, type Person } from "../src/people/people"
import { rootInitiatorOf } from "../src/a2a/initiator"
import { hopRefusal, SyncWaits } from "../src/daemon/delegation-wiring"
import { operatorContext } from "../src/requests/operator"

const boss: Person = { id: "boss", name: "Boss", role: "owner", identities: ["telegram:1"] }
const sara: Person = { id: "sara", name: "Sara B", role: "member", identities: ["telegram:4242"] }
const omar: Person = { id: "omar", name: "Omar K", role: "member", identities: ["telegram:7"] }
const people = [boss, sara, omar]
const local = (id: string) => ["coder", "pm", "devops"].includes(id)

const fromSara = { channel: "telegram", chatId: "c1", sender: "Sara", senderId: "4242" }
const fromOmar = { channel: "telegram", chatId: "c2", sender: "Omar", senderId: "7" }
const fromStranger = { channel: "telegram", chatId: "c3", sender: "Eve", senderId: "999" }
const fromBoss = { channel: "telegram", chatId: "c4", sender: "Boss", senderId: "1" }
const fromAgent = (id: string, extra: Record<string, unknown> = {}) => ({ channel: "a2a", chatId: `a2a:${id}:devops:d1`, sender: `agent:${id}`, ...extra })

describe("askerRefusal", () => {
  const askers = { people: ["sara"], agents: ["pm"] }

  it("changes nothing when askers is unset", () => {
    for (const ctx of [fromSara, fromOmar, fromStranger, fromAgent("coder"), fromAgent("ghost", { senderVerified: false })]) {
      expect(askerRefusal(people, "devops", undefined, ctx, local)).toBeNull()
    }
  })

  it("lets a listed person ask, by id or by name", () => {
    expect(askerRefusal(people, "devops", askers, fromSara, local)).toBeNull()
    expect(askerRefusal(people, "devops", { people: ["sara b"] }, fromSara, local)).toBeNull()
    expect(askerRefusal(people, "devops", { people: ["*"] }, fromOmar, local)).toBeNull()
  })

  it("refuses an unlisted person and a sender who is not in people[]", () => {
    expect(askerRefusal(people, "devops", askers, fromOmar, local)).toMatchObject({ sender: "omar", reason: "person not in askers.people" })
    expect(askerRefusal(people, "devops", askers, fromStranger, local)).toMatchObject({ reason: "sender not in people[]" })
    expect(askerRefusal(people, "devops", { people: ["*"] }, fromStranger, local)?.note).toContain("Ask the owner")
  })

  it("lets a listed agent ask and refuses an unlisted or unverified one", () => {
    expect(askerRefusal(people, "devops", askers, fromAgent("pm"), local)).toBeNull()
    expect(askerRefusal(people, "devops", { agents: ["*"] }, fromAgent("coder"), local)).toBeNull()
    expect(askerRefusal(people, "devops", askers, fromAgent("coder"), local)).toMatchObject({ sender: "agent:coder", reason: "agent not in askers.agents" })
    // #2052: a name a caller gave, or one that is no agent of this machine.
    expect(askerRefusal(people, "devops", askers, fromAgent("pm", { senderVerified: false }), local)).toMatchObject({ reason: "unverified agent" })
    expect(askerRefusal(people, "devops", { agents: ["*"] }, fromAgent("ghost"), local)).toMatchObject({ reason: "unverified agent" })
    expect(askerRefusal(people, "devops", askers, { channel: "a2a", sender: "agent" }, local)).toMatchObject({ reason: "unverified agent" })
  })

  it("judges a hand-off by the agent that asks, not by the person behind it", () => {
    const root = rootInitiatorOf({ ...fromOmar, person: "omar" }, "pm")
    expect(askerRefusal(people, "devops", askers, fromAgent("pm", { initiator: root }), local)).toBeNull()
    const sarasRoot = rootInitiatorOf({ ...fromSara, person: "sara" }, "coder")
    expect(askerRefusal(people, "devops", askers, fromAgent("coder", { initiator: sarasRoot }), local)).not.toBeNull()
  })

  it("always lets the owner ask, directly or at the root of a chain", () => {
    const none = { people: [], agents: [] }
    expect(askerRefusal(people, "devops", none, fromBoss, local)).toBeNull()
    const root = rootInitiatorOf({ ...fromBoss, person: "boss" }, "coder")
    expect(askerRefusal(people, "devops", none, fromAgent("coder", { initiator: root }), local)).toBeNull()
    // With no owner listed, this machine's own surfaces are the built-in owner.
    expect(askerRefusal([sara], "devops", none, operatorContext({ channel: "dashboard", chatId: "d" }), local)).toBeNull()
  })

  it("leaves the agent's own schedules alone", () => {
    expect(askerRefusal(people, "devops", { people: [], agents: [] }, { channel: "cron", chatId: "cron:nightly" }, local)).toBeNull()
  })

  it("is an optional setting on the agent", () => {
    const parse = (askers?: unknown) => daemonConfigSchema.parse({
      node: { id: "t", name: "t" },
      agents: { devops: { name: "DevOps", workspace: "/tmp", ...(askers ? { askers } : {}) } },
    }).agents.devops.askers
    expect(parse()).toBeUndefined()
    expect(parse({ people: ["sara"] })).toEqual({ people: ["sara"], agents: [] })
  })
})

describe("through the registry", () => {
  let dir: string
  let registry: AgentRegistry
  const logs: string[] = []
  const prevCwd = process.cwd()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-askers-"))
    process.chdir(dir)
    getEventBus().removeAllListeners()
    run.calls = 0
    logs.length = 0
    registry = new AgentRegistry(daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      people,
      agents: {
        coder: { name: "Coder", tier: "claude-code", workspace: dir },
        pm: { name: "PM", tier: "claude-code", workspace: dir },
        devops: { name: "DevOps", tier: "claude-code", workspace: dir, askers: { people: ["sara"], agents: ["pm"] } },
      },
    }), (...args: unknown[]) => { logs.push(args.join(" ")) })
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  it("refuses before a run, logs who and why, and runs a listed asker", async () => {
    const refused = await registry.execute({ agentId: "devops", message: "deploy", context: { ...fromOmar } })
    expect(refused.content).toContain("Ask the owner")
    expect(run.calls).toBe(0)
    expect(logs.some((l) => l.includes("[devops] refused: omar") && l.includes("person not in askers.people"))).toBe(true)
    expect((await registry.execute({ agentId: "devops", message: "deploy", context: { ...fromSara } })).content).toBe("ok")
    expect((await registry.execute({ agentId: "devops", message: "deploy", context: { channel: "mcp", chatId: "mcp:pm:devops:1", sender: "agent:pm" } })).content).toBe("ok")
    expect((await registry.execute({ agentId: "coder", message: "fix", context: { ...fromStranger } })).content).toBe("ok")
    expect(run.calls).toBe(3)
  }, 15_000)

  it("refuses a hand-off at the gate by the calling agent", () => {
    const waits = new SyncWaits()
    const turn = (agentId: string) => ({ agentId, taskId: `run-${agentId}`, context: { channel: "cron", chatId: "nightly" } })
    expect(hopRefusal("devops", turn("pm"), registry, waits)).toBeNull()
    expect(hopRefusal("devops", turn("coder"), registry, waits)).toContain("Ask the owner")
    expect(hopRefusal("coder", turn("pm"), registry, waits)).toBeNull()
  })
})
