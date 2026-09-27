import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A second voice question to an agent still answering the first must wait
// for it, not be queued: /ask would reply "I'm still working" aloud, and the
// queued answer would be re-routed to "voice", which has no adapter.

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

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-voice-slot-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const config = () => daemonConfigSchema.parse({
  node: { id: "test", name: "test" },
  agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
})

function start(r: AgentRegistry, channel: string, chatId: string) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  const run = r.execute({ message: "hello", agentId: "ops", context: { channel, chatId }, onStart })
  return { started, run }
}

const pending = (ms = 700) => new Promise((res) => setTimeout(() => res("pending"), ms))

describe("a voice question while the same voice chat is busy", () => {
  it("waits for the first answer instead of being queued", async () => {
    const r = new AgentRegistry(config(), () => {})
    const first = start(r, "voice", "voice:ops")
    const firstId = await first.started

    const second = start(r, "voice", "voice:ops")
    // Neither answered (queued) nor started beside the first: waiting.
    expect(await Promise.race([second.run, second.started, pending()])).toBe("pending")

    r.cancelRunningTask(firstId, "done")
    await first.run
    const secondId = await second.started
    r.cancelRunningTask(secondId, "done")
    expect((await second.run).error ?? "").not.toMatch(/__queued__/)
  })

  it("lets only one of two waiting questions start when the chat frees", async () => {
    const r = new AgentRegistry(config(), () => {})
    const first = start(r, "voice", "voice:ops")
    const firstId = await first.started

    // A rate limiter that takes a moment, as it does near its limit: the
    // window in which a second waiter could see the chat still free.
    const limiter = (r as any).rateLimiter
    vi.spyOn(limiter, "acquire").mockImplementation(async () => {
      await new Promise((res) => setTimeout(res, 800))
      return { ok: true }
    })
    const second = start(r, "voice", "voice:ops")
    const third = start(r, "voice", "voice:ops")
    expect(await Promise.race([second.started, third.started, pending()])).toBe("pending")

    r.cancelRunningTask(firstId, "done")
    await first.run
    const tag = (p: Promise<string>, name: string) => p.then((id) => ({ name, id }))
    const next = await Promise.race([tag(second.started, "second"), tag(third.started, "third")])
    // The other one is still waiting for the chat.
    const later = next.name === "second" ? third : second
    expect(await Promise.race([later.started, pending(1_200)])).toBe("pending")

    r.cancelRunningTask(next.id, "done")
    const lastId = await later.started
    r.cancelRunningTask(lastId, "done")
    const results = await Promise.all([second.run, third.run])
    for (const res of results) expect(res.error ?? "").not.toMatch(/__queued__/)
  })

  it("still runs beside the agent's other work", async () => {
    const r = new AgentRegistry(config(), () => {})
    const busy = start(r, "cron", "cron:x")
    const busyId = await busy.started

    const voice = start(r, "voice", "voice:ops")
    const voiceId = await voice.started
    r.cancelRunningTask(voiceId, "done")
    r.cancelRunningTask(busyId, "done")
    await Promise.all([busy.run, voice.run])
  })
})
