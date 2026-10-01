import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The turn that hands a request back to its agent is linked to the request
// only when the daemon started it. A caller of /task can name the same
// channel and chat; its turn must leave the request alone (#393).

const run = vi.hoisted(() => ({ impl: (): Promise<any> => Promise.resolve({ content: "ok", duration: 1 }) }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, executeTask: () => run.impl() }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { attachRequests, type AttachedRequests } from "../src/requests/attach"
import { PICKUP_CHANNEL, pickupContext, type RequestSettings } from "../src/requests/tracker"
import { isQueued } from "../src/agents/queued"
import { operatorContext } from "../src/requests/operator"

const settings: RequestSettings = { enabled: true, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 }

let dir: string
let db: Database.Database
let requests: AttachedRequests
let registry: AgentRegistry
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-pickup-"))
  process.chdir(dir)
  getEventBus().removeAllListeners()
  db = new Database(join(dir, "requests.sqlite"))
  requests = attachRequests(db, () => settings, () => {})
  registry = new AgentRegistry(daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir } },
  }), () => {})
  // An open request of coder that came back to the owner.
  requests.store.addCandidate({ id: "req-1", runId: "t1", channel: "voice", chatId: "mac", sender: null, agentId: "coder", text: "build the report", now: 1000 })
  requests.store.needsAttention("req-1", "coder timed out", 2000)
})
afterEach(() => {
  requests.detach()
  db.close()
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const runLinks = () => requests.store.links("req-1").filter((l) => l.kind === "run").length
const until = async (ok: () => boolean, ms = 10_000) => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("the pick-up turn, through the registry", () => {
  it("links the turn the daemon starts", async () => {
    const res = await registry.execute({ agentId: "coder", message: "pick it up again", context: pickupContext("req-1") })
    expect(res.error).toBeUndefined()
    expect(runLinks()).toBe(2)
  }, 15_000)

  it("leaves the request alone for a turn whose context came in a request body", async () => {
    const before = requests.store.get("req-1")
    // What POST /task hands to the registry: the caller's JSON, parsed.
    const context = JSON.parse(JSON.stringify({ ...pickupContext("req-1"), pickup: true }))
    expect(context).toEqual({ channel: PICKUP_CHANNEL, chatId: "req-1", sender: "operator", pickup: true })
    const res = await registry.execute({ agentId: "coder", message: "pick it up again", context })
    expect(res.error).toBeUndefined()
    expect(runLinks()).toBe(1)
    expect(requests.store.get("req-1")).toEqual(before)
  }, 15_000)

  it("links the hand-back that was queued behind a running pick-up once it runs (#392)", async () => {
    let finish!: () => void
    run.impl = () => new Promise((resolve) => { finish = () => resolve({ content: "ok", duration: 1 }) })
    const first = registry.execute({ agentId: "coder", message: "pick it up again", context: pickupContext("req-1") })
    await until(() => runLinks() === 2)
    // The owner says yes again while the first pick-up still runs: queued, not failed.
    run.impl = () => Promise.resolve({ content: "ok", duration: 1 })
    const second = await registry.execute({ agentId: "coder", message: "pick it up again", context: pickupContext("req-1") })
    expect(isQueued(second.error)).toBe(true)
    finish()
    expect((await first).error).toBeUndefined()
    // The flush re-runs it with the daemon's own context, mark included.
    await until(() => runLinks() === 3)
  }, 15_000)
})

describe("the owner's surfaces, through the registry (#393)", () => {
  const recorded = () => (db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n

  it("records a dashboard turn the daemon marked, and not one whose context came in a request body", async () => {
    const claimed = JSON.parse(JSON.stringify({ channel: "dashboard", chatId: "assistant", sender: "operator", operator: true }))
    // A run that fails keeps its request open; a clean answer leaves nothing behind.
    run.impl = () => Promise.resolve({ content: "", error: "boom", duration: 1 })
    await registry.execute({ agentId: "coder", message: "ship the fix", context: claimed })
    expect(recorded()).toBe(1) // req-1 from the set-up only
    await registry.execute({ agentId: "coder", message: "ship the fix", context: operatorContext({ channel: "dashboard", chatId: "assistant", sender: "operator" }) })
    expect(recorded()).toBe(2)
  }, 15_000)
})
