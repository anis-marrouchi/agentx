import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The registry side of people (#384): a turn is stamped when it starts, so
// a delegation from it carries the person in its root.

const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { rootInitiatorOf } from "../src/a2a/initiator"

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-people-turn-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const config = (people: unknown[]) => daemonConfigSchema.parse({
  node: { id: "test", name: "test" },
  agents: { front: { name: "Front", tier: "claude-code", workspace: dir, maxConcurrent: 4 } },
  people,
})

async function stamped(r: AgentRegistry, context: Record<string, unknown>) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  const run = r.execute({ message: "hello", agentId: "front", context: context as any, onStart })
  const id = await started
  const turn = r.findRunningTurn("front", { taskId: id })!
  const root = rootInitiatorOf(turn.context as any, "front")
  r.cancelRunningTask(id, "done")
  await run
  return { person: (turn.context as any).person, root }
}

describe("a turn is stamped with its person when it starts", () => {
  const people = [{ id: "sara", name: "Sara", identities: ["gitlab:sara.b", "whatsapp:21620123456"] }]

  it("puts the same person on a GitLab turn and a WhatsApp turn, and in the root a delegation carries", async () => {
    const r = new AgentRegistry(config(people), () => {})
    const gitlab = await stamped(r, { channel: "gitlab", chatId: "g/app:issue:7", sender: "Sara B", senderUsername: "sara.b" })
    const whatsapp = await stamped(r, { channel: "whatsapp", chatId: "21620123456", sender: "Sara", senderId: "21620123456" })
    expect(gitlab.person).toBe("sara")
    expect(whatsapp.person).toBe("sara")
    expect(whatsapp.root.person).toBe("sara")
  })

  it("replaces a person the caller sent with what the sender fields say", async () => {
    const r = new AgentRegistry(config(people), () => {})
    const turn = await stamped(r, { channel: "telegram", chatId: "c9", sender: "Sara", senderId: "999", person: "sara" })
    expect(turn.person).toBeUndefined()
    expect(turn.root.person).toBeUndefined()
  })

  it("stamps from the new list after a config reload hands it over", async () => {
    const r = new AgentRegistry(config([]), () => {})
    const ctx = () => ({ channel: "gitlab", chatId: "g/app:issue:7", sender: "Sara B", senderUsername: "sara.b" })
    expect((await stamped(r, ctx())).person).toBeUndefined()
    r.setPeople(config(people).people)
    expect((await stamped(r, ctx())).person).toBe("sara")
  })

  it("changes nothing when no people are listed", async () => {
    const r = new AgentRegistry(config([]), () => {})
    const ctx = { channel: "telegram", chatId: "c1", sender: "Sam", senderId: "4242" }
    const turn = await stamped(r, ctx)
    expect(turn.person).toBeUndefined()
    expect(ctx).toEqual({ channel: "telegram", chatId: "c1", sender: "Sam", senderId: "4242" })
    expect(turn.root).toEqual({ kind: "human", channel: "telegram", chatId: "c1", sender: "Sam", agentId: "front" })
  })
})
