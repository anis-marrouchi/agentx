import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A listed person may be limited to named agents (#379, first slice).
// The default is open; a limit answers with a note instead of a run, and
// follows the person through a delegation.

const run = vi.hoisted(() => ({ calls: 0 }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, executeTask: () => { run.calls++; return Promise.resolve({ content: "ok", duration: 1 }) } }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema, personSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { agentAllowed, personRefusal, type Person } from "../src/people/people"
import { rootInitiatorOf } from "../src/a2a/initiator"
import { MemberStore } from "../src/members/store"
import { getAttachRegistry } from "../src/attach"
import { MessageRouter } from "../src/channels/router"
import { chainRootOf, createDelegations, CallbackReplies, hopRefusal, SyncWaits } from "../src/daemon/delegation-wiring"
import { readFileSync } from "fs"

const sara: Person = { id: "sara", name: "Sara B", role: "member", identities: ["telegram:4242"], agents: ["coder"] }
const omar: Person = { id: "omar", name: "Omar K", role: "member", identities: ["telegram:7"] }

describe("per-agent permission", () => {
  it("is open by default and limited only by a list", () => {
    expect(agentAllowed(omar, "devops")).toBe(true)
    expect(agentAllowed({ agents: [] }, "devops")).toBe(true)
    expect(agentAllowed(sara, "coder")).toBe(true)
    expect(agentAllowed(sara, "devops")).toBe(false)
  })

  it("never limits an owner, whose own surfaces must reach every agent", () => {
    const boss: Person = { id: "boss", name: "Boss", role: "owner", identities: ["telegram:1"], agents: ["coder"] }
    expect(agentAllowed(boss, "devops")).toBe(true)
    expect(personRefusal([boss], "devops", { channel: "telegram", senderId: "1" })).toBeNull()
  })

  it("answers a refused turn with what the person can reach, and nothing for others", () => {
    const people = [sara, omar]
    expect(personRefusal(people, "devops", { channel: "telegram", senderId: "4242", sender: "Sara" })).toBe(
      "Sara B, you can reach coder here, not devops. Ask the owner if you need devops.",
    )
    expect(personRefusal(people, "coder", { channel: "telegram", senderId: "4242" })).toBeNull()
    expect(personRefusal(people, "devops", { channel: "telegram", senderId: "7" })).toBeNull()
    // An unknown sender is not limited here.
    expect(personRefusal(people, "devops", { channel: "telegram", senderId: "999" })).toBeNull()
    expect(personRefusal(people, "devops", undefined)).toBeNull()
  })

  it("follows the person through a delegation", () => {
    const root = rootInitiatorOf({ channel: "telegram", chatId: "c1", senderId: "4242", person: "sara" }, "coder")
    const hop = JSON.parse(JSON.stringify({ channel: "a2a", sender: "agent:coder", initiator: root }))
    expect(personRefusal([sara], "devops", hop)).toContain("not devops")
    expect(personRefusal([sara], "coder", hop)).toBeNull()
  })

  it("is a setting on the person, taking any agent id the agents setting takes", () => {
    expect(personSchema.parse({ id: "sara", name: "Sara" }).agents).toEqual([])
    expect(personSchema.parse({ id: "sara", name: "Sara", agents: ["coder", "pm-agent"] }).agents).toEqual(["coder", "pm-agent"])
    expect(personSchema.parse({ id: "sara", name: "Sara", agents: ["Ops.Agent"] }).agents).toEqual(["Ops.Agent"])
    expect(personSchema.safeParse({ id: "sara", name: "Sara", agents: [""] }).success).toBe(false)
  })
})

describe("through the registry", () => {
  let dir: string
  let registry: AgentRegistry
  const prevCwd = process.cwd()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-perm-"))
    process.chdir(dir)
    getEventBus().removeAllListeners()
    run.calls = 0
    registry = new AgentRegistry(daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      people: [sara],
      agents: {
        coder: { name: "Coder", tier: "claude-code", workspace: dir },
        devops: { name: "DevOps", tier: "claude-code", workspace: dir },
      },
    }), () => {})
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  it("refuses the agent the person may not reach without a run, and runs the one they may", async () => {
    const started: string[] = []
    getEventBus().on("task:started", (p) => started.push(p.agentId))
    const refused = await registry.execute({ agentId: "devops", message: "deploy it", context: { channel: "telegram", chatId: "c1", sender: "Sara", senderId: "4242" } })
    expect(refused.error).toBeUndefined()
    expect(refused.content).toContain("not devops")
    expect(run.calls).toBe(0)
    expect(started).toEqual([])
    const ok = await registry.execute({ agentId: "coder", message: "fix it", context: { channel: "telegram", chatId: "c1", sender: "Sara", senderId: "4242" } })
    expect(ok.content).toBe("ok")
    expect(run.calls).toBe(1)
    expect(started).toEqual(["coder"])
  }, 15_000)

  const fromSara = { channel: "telegram", chatId: "c1", sender: "Sara", senderId: "4242" }

  it("refuses before an attached session is offered the message", async () => {
    const offer = vi.spyOn(getAttachRegistry(), "offer").mockReturnValue(Promise.resolve({ kind: "answered", text: "deployed", sessionId: "sess-1" }) as any)
    try {
      const refused = await registry.execute({ agentId: "devops", message: "deploy it", context: { ...fromSara } })
      expect(refused.content).toContain("not devops")
      expect(offer).not.toHaveBeenCalled()
    } finally { offer.mockRestore() }
  })

  it("refuses an agent on a mesh peer instead of forwarding it", async () => {
    const sendTask = vi.fn(async () => "answer from atlas")
    registry.setMeshFallback({
      findPeerWithSkill: () => undefined,
      sendTask,
      directory: () => [{ peer: "clawd", healthy: true, skills: [{ id: "atlas" }] }],
    })
    const refused = await registry.execute({ agentId: "atlas", message: "hello", context: { ...fromSara } })
    expect(refused.content).toContain("not atlas")
    expect(sendTask).not.toHaveBeenCalled()
    // Someone with no limit still gets through to the peer.
    const ok = await registry.execute({ agentId: "atlas", message: "hello", context: { channel: "telegram", chatId: "c2", sender: "Omar", senderId: "7" } })
    expect(ok.content).toBe("answer from atlas")
  })

  it("refuses in the channel router, by agent id and by named peer, before the message leaves", async () => {
    const sendTask = vi.fn(async () => "answer from atlas")
    const adapter: any = { name: "telegram", send: vi.fn(async () => "m1"), react: vi.fn(), sendTyping: vi.fn() }
    const router = new MessageRouter(registry, { channels: {} } as any, undefined, () => {})
    router.setMesh({
      directory: () => [{ peer: "clawd", peerUrl: "u", healthy: true, skills: [{ id: "atlas", name: "Atlas" }], channels: [] }],
      findAgentPeer: () => ({ peer: "clawd", healthy: true }),
      sendTask,
      onPeerChange: () => {},
    } as any)
    const msg = { id: "m0", channel: "telegram", accountId: "default", sender: { id: "4242", name: "Sara" }, text: "atlas, deploy it" } as any
    expect(await (router as any).handleViaMeshByAgentId(adapter, msg, "atlas")).toBe(true)
    expect(await (router as any).handleViaMeshByPeer(adapter, msg, "atlas", "clawd")).toBe(true)
    expect(await (router as any).handleViaMesh(adapter, msg)).toBe(true)
    expect(sendTask).not.toHaveBeenCalled()
    expect(adapter.send).toHaveBeenCalledTimes(3)
    for (const [out] of adapter.send.mock.calls) expect(out.text).toContain("not atlas")
    // Someone with no limit is forwarded as before.
    await (router as any).handleViaMeshByAgentId(adapter, { ...msg, sender: { id: "7", name: "Omar" } }, "atlas")
    expect(sendTask).toHaveBeenCalledTimes(1)
  })

  it("refuses a delegation to a peer agent for work the person started", async () => {
    const peerCalls: string[] = []
    const mgr = createDelegations({
      config: daemonConfigSchema.parse({ node: { id: "n", name: "n" } }),
      registry,
      router: { getChannel: () => undefined, sendOutbound: async () => {} } as any,
      mesh: () => ({ sendTask: async (_p: string, _t: string, agent: string) => { peerCalls.push(agent); return "peer answer" } }) as any,
      log: () => {},
      replies: new CallbackReplies(),
      baseDir: dir,
    })
    try {
      mgr.start({ caller: { agentId: "coder", taskId: "run-1", context: { ...fromSara, person: "sara" } }, callee: "atlas", peer: "clawd", message: "deploy it" })
      await new Promise((r) => setTimeout(r, 20))
      expect(peerCalls).toEqual([])
      expect(new MemberStore(dir).events("sara")).toMatchObject([{ event: "agent-refused", detail: "atlas" }])
    } finally { mgr.stop() }
  })

  it("refuses a synchronous hand-off, and the hop after one, for work the person started", () => {
    const waits = new SyncWaits()
    // Sara's own turn on coder: the daemon stamped the person on it.
    const first = { agentId: "coder", taskId: "run-1", context: { ...fromSara, person: "sara" } }
    expect(hopRefusal("devops", first, registry, waits)).toContain("not devops")
    expect(hopRefusal("coder", first, registry, waits)).toBeNull()
    // A synchronous callee's context carries no root; the chain's root is
    // kept with the wait, so the next hop is still her work.
    waits.begin("run-1", "run-2", chainRootOf(first, waits))
    const second = { agentId: "coder", taskId: "run-2", context: { channel: "a2a", sender: "agent:coder", chatId: "coder" } }
    expect(hopRefusal("devops", second, registry, waits)).toContain("not devops")
    waits.begin("run-2", "run-3", chainRootOf(second, waits))
    expect(hopRefusal("atlas", { ...second, taskId: "run-3" }, registry, waits)).toContain("not atlas")
    // Once the hop ends, the same agent's next turn is nobody's.
    waits.end("run-2")
    expect(hopRefusal("devops", second, registry, waits)).toBeNull()
    // A caller the daemon cannot name is not checked, and an agent's own work is not limited.
    expect(hopRefusal("devops", null, registry, waits)).toBeNull()
    expect(hopRefusal("devops", { agentId: "coder", taskId: "run-9", context: { channel: "cron", chatId: "nightly" } }, registry, waits)).toBeNull()
    expect(new MemberStore(dir).events("sara").map((e) => e.detail)).toEqual(["atlas", "devops", "devops"])
  })

  it("asks at the delegation gate and on /mesh/task, before any hop starts", () => {
    const src = readFileSync(join(__dirname, "../src/daemon/index.ts"), "utf-8")
    const gate = src.slice(src.indexOf("private delegationGate("), src.indexOf("private startCallback("))
    expect(gate.indexOf("hopRefusal(target.callee, caller")).toBeGreaterThan(0)
    expect(gate.indexOf("hopRefusal(")).toBeLessThan(gate.indexOf("this.startCallback("))
    const meshTask = src.slice(src.indexOf('case "POST /mesh/task"'), src.indexOf("// Streaming pass-through"))
    expect(meshTask.indexOf("hopRefusal(")).toBeGreaterThan(0)
    expect(meshTask.indexOf("hopRefusal(")).toBeLessThan(meshTask.indexOf("askHost("))
  })

  it("keeps each refusal in the person's trail", async () => {
    await registry.execute({ agentId: "devops", message: "deploy it", context: { ...fromSara } })
    expect(new MemberStore(dir).events("sara")).toMatchObject([{ person: "sara", event: "agent-refused", detail: "devops" }])
  })
})

describe("the per-person log's retention", () => {
  it("drops lines older than the retention and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-members-log-"))
    let now = Date.parse("2026-10-01T00:00:00Z")
    const store = new MemberStore(dir, () => now, 90)
    store.log({ person: "sara", event: "invited" })
    now += 10 * 86_400_000
    store.log({ person: "sara", event: "paired" })
    expect(store.events("sara").map((e) => e.event)).toEqual(["paired", "invited"])
    // 100 days on: the next line written prunes the first (the hourly
    // throttle has long passed), and a forced prune finds nothing more.
    now += 100 * 86_400_000
    store.log({ person: "sara", event: "signed-in" })
    expect(store.events("sara").map((e) => e.event)).toEqual(["signed-in"])
    expect(store.prune(true)).toBe(0)
    // A line just inside the window stays.
    now += 80 * 86_400_000
    expect(store.prune(true)).toBe(0)
    now += 11 * 86_400_000
    expect(store.prune(true)).toBe(1)
    expect(store.events("sara")).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
