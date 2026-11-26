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
// The daemon vouches for an agent it resolved itself (senderVerified: true).
const fromAgent = (id: string, extra: Record<string, unknown> = {}) => ({ channel: "a2a", chatId: `a2a:${id}:devops:d1`, sender: `agent:${id}`, senderVerified: true, ...extra })

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

  it("always lets the owner ask on their own turn", () => {
    const none = { people: [], agents: [] }
    expect(askerRefusal(people, "devops", none, fromBoss, local)).toBeNull()
    // With no owner listed, this machine's own surfaces are the built-in owner.
    expect(askerRefusal([sara], "devops", none, operatorContext({ channel: "dashboard", chatId: "d" }), local)).toBeNull()
  })

  // Review B1: "agent:" is trusted only on an agent channel, and only when
  // the daemon vouched for the name.
  it("B1: an agent-shaped display name on a person's channel is refused", () => {
    const all = { people: ["*"], agents: ["*", "pm"] }
    for (const channel of ["telegram", "slack", "whatsapp"]) {
      expect(askerRefusal(people, "devops", all, { channel, chatId: "c", sender: "agent:pm", senderId: "555" }, local)).toMatchObject({ reason: "unverified agent" })
      expect(askerRefusal(people, "devops", all, { channel, chatId: "c", sender: "agent:pm", senderVerified: true }, local)).toMatchObject({ reason: "unverified agent" })
      // Any other software-shaped name there is still a person, and unknown.
      expect(askerRefusal(people, "devops", all, { channel, chatId: "c", sender: "cron:nightly", senderId: "555" }, local)).toMatchObject({ reason: "sender not in people[]" })
    }
  })

  it("B1: an agent sender the daemon did not vouch for is refused", () => {
    const pm = { agents: ["pm"] }
    expect(askerRefusal(people, "devops", pm, fromAgent("pm", { senderVerified: undefined }), local)).toMatchObject({ reason: "unverified agent" })
    expect(askerRefusal(people, "devops", pm, fromAgent("pm", { channel: "mcp" }), local)).toBeNull()
    expect(askerRefusal(people, "devops", pm, fromAgent("pm", { channel: "mesh" }), local)).toBeNull()
  })

  it("B2: work from another machine is refused, even under a local agent's name", () => {
    const all = { people: ["*"], agents: ["*"] }
    expect(askerRefusal(people, "devops", all, fromAgent("pm", { fromPeer: true }), local)).toMatchObject({ reason: "work from another machine" })
    const root = rootInitiatorOf({ ...fromSara, person: "sara" }, "pm")
    expect(askerRefusal(people, "devops", all, { channel: "api", initiator: root, fromPeer: true }, local)).toMatchObject({ reason: "work from another machine" })
  })

  it("B3: a root naming the owner does not make the turn the owner's", () => {
    const none = { people: [], agents: [] }
    const root = rootInitiatorOf({ ...fromBoss, person: "boss" }, "coder")
    // A forwarded root, no agent sender: judged as the person, who is not listed.
    expect(askerRefusal(people, "devops", none, { channel: "api", chatId: "x", initiator: root }, local)).toMatchObject({ sender: "boss", reason: "person not in askers.people" })
    // A hand-off with the owner at its root is judged by the calling agent.
    expect(askerRefusal(people, "devops", none, fromAgent("coder", { initiator: root }), local)).toMatchObject({ reason: "agent not in askers.agents" })
    // The built-in owner id at a root gets nothing either.
    const implicit = rootInitiatorOf({ ...fromBoss, person: "owner" }, "coder")
    expect(askerRefusal([sara], "devops", none, { channel: "api", chatId: "x", initiator: implicit }, local)).not.toBeNull()
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
    expect((await registry.execute({ agentId: "devops", message: "deploy", context: { channel: "mcp", chatId: "mcp:pm:devops:1", sender: "agent:pm", senderVerified: true } })).content).toBe("ok")
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
