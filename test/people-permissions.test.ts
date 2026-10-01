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

const sara: Person = { id: "sara", name: "Sara B", role: "member", identities: ["telegram:4242"], agents: ["coder"] }
const omar: Person = { id: "omar", name: "Omar K", role: "member", identities: ["telegram:7"] }

describe("per-agent permission", () => {
  it("is open by default and limited only by a list", () => {
    expect(agentAllowed(omar, "devops")).toBe(true)
    expect(agentAllowed({ agents: [] }, "devops")).toBe(true)
    expect(agentAllowed(sara, "coder")).toBe(true)
    expect(agentAllowed(sara, "devops")).toBe(false)
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

  it("is a setting on the person, with agent ids only", () => {
    expect(personSchema.parse({ id: "sara", name: "Sara" }).agents).toEqual([])
    expect(personSchema.parse({ id: "sara", name: "Sara", agents: ["coder", "pm-agent"] }).agents).toEqual(["coder", "pm-agent"])
    expect(personSchema.safeParse({ id: "sara", name: "Sara", agents: ["Not An Id"] }).success).toBe(false)
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
