import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "fs"
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

import { AgentRegistry, richReplyPrompt } from "../src/agents/registry"
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

const config = (maxConcurrent = 1) => daemonConfigSchema.parse({
  node: { id: "test", name: "test" },
  agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent } },
})

function start(r: AgentRegistry, channel: string, chatId: string, via?: "voice") {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  const run = r.execute({ message: "hello", agentId: "ops", context: { channel, chatId, ...(via ? { via } : {}) }, onStart })
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

// AgentX Voice runs a spoken question in the phone's conversation (#1455):
// channel "app", the phone's chat id. One turn at a time on that chat,
// whoever sent it, and a spoken one does not wait for the agent's slots.
describe("a spoken question in a phone conversation", () => {
  it("waits for the phone's own turn on the same chat, even with a free slot", async () => {
    const r = new AgentRegistry(config(2), () => {})
    const phone = start(r, "app", "app:c1")
    const phoneId = await phone.started

    const spoken = start(r, "app", "app:c1", "voice")
    expect(await Promise.race([spoken.run, spoken.started, pending()])).toBe("pending")

    r.cancelRunningTask(phoneId, "done")
    await phone.run
    const spokenId = await spoken.started
    r.cancelRunningTask(spokenId, "done")
    expect((await spoken.run).error ?? "").not.toMatch(/__queued__/)
  })

  it("holds the phone's next turn on that chat until it is answered", async () => {
    const r = new AgentRegistry(config(2), () => {})
    const spoken = start(r, "app", "app:c1", "voice")
    const spokenId = await spoken.started

    const phone = start(r, "app", "app:c1")
    expect(await Promise.race([phone.run, phone.started, pending()])).toBe("pending")
    // Another conversation is not held.
    const other = start(r, "app", "app:c2")
    const otherId = await other.started

    r.cancelRunningTask(spokenId, "done")
    await spoken.run
    const phoneId = await phone.started
    r.cancelRunningTask(phoneId, "done")
    r.cancelRunningTask(otherId, "done")
    await Promise.all([phone.run, other.run])
  })

  it("runs beside the agent's other work instead of waiting for a slot", async () => {
    const r = new AgentRegistry(config(1), () => {})
    const busy = start(r, "cron", "cron:x")
    const busyId = await busy.started

    const spoken = start(r, "app", "app:c1", "voice")
    const spokenId = await spoken.started
    r.cancelRunningTask(spokenId, "done")
    r.cancelRunningTask(busyId, "done")
    await Promise.all([busy.run, spoken.run])
  })

  it("gets no phone prompt for quick replies and buttons", () => {
    const src = readFileSync(join(__dirname, "../src/agents/registry.ts"), "utf8")
    expect(src).toContain('richReplyPrompt(state.def.richMessages, task.context?.via === "voice" ? "voice" : channel)')
    expect(richReplyPrompt(undefined, "voice")).toBe("")
  })
})
