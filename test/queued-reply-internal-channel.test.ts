import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A queued request pick-up ("requests:req-…") that flushes later must not
// be posted to a "requests" adapter that does not exist (#1259). Its reply
// reaches the request's card through task:completed instead.

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { setMessageRouter, resetMessageRouterForTesting } from "../src/channels/router-instance"
import { pickupContext } from "../src/requests/tracker"

let dir: string
let sent: Array<{ channel: string; chatId: string; text: string }>
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-queued-internal-"))
  process.chdir(dir)
  sent = []
  setMessageRouter({
    getChannel: (name: string) => (name === "telegram" ? {} : undefined),
    sendOutbound: async (msg: any) => {
      if (msg.channel !== "telegram") throw new Error(`Unknown channel: "${msg.channel}"`)
      sent.push(msg)
    },
  } as any)
})
afterEach(() => {
  resetMessageRouterForTesting()
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(logs: string[]) {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir } },
  })
  return new AgentRegistry(config, (m: string) => logs.push(m))
}

describe("posting a flushed queued reply", () => {
  it("skips a request pick-up, which has no adapter", async () => {
    const logs: string[] = []
    const r = registry(logs) as any
    r.postQueuedResponseToChannel("ops", pickupContext("req-01"), { content: "done" })
    await new Promise((res) => setTimeout(res, 0))
    expect(sent).toEqual([])
    expect(logs.filter((l) => l.includes("queued response post failed"))).toEqual([])
  })

  it("still posts to a channel with an adapter", async () => {
    const r = registry([]) as any
    r.postQueuedResponseToChannel("ops", { channel: "telegram", chatId: "c1" }, { content: "done" })
    await new Promise((res) => setTimeout(res, 0))
    expect(sent.map((m) => [m.channel, m.chatId, m.text])).toEqual([["telegram", "c1", "done"]])
  })
})
