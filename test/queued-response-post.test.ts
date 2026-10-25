import { describe, it, expect, afterEach, vi } from "vitest"
import { tmpdir } from "os"

// A queued turn's reply goes back to its chat only when the channel has an
// adapter: a `requests` pick-up has none, and posting failed (#1263).

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { setMessageRouter, resetMessageRouterForTesting } from "../src/channels/router-instance"

afterEach(() => resetMessageRouterForTesting())

function setup() {
  const sendOutbound = vi.fn(async () => {})
  setMessageRouter({ getChannel: (name: string) => (name === "telegram" ? {} : undefined), sendOutbound } as any)
  const logs: string[] = []
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: tmpdir() } },
  })
  const r = new AgentRegistry(config, (m: string) => logs.push(m)) as any
  return { r, sendOutbound, logs }
}

describe("posting a queued turn's reply", () => {
  it("posts on a channel with an adapter", () => {
    const { r, sendOutbound } = setup()
    r.postQueuedResponseToChannel("ops", { channel: "telegram", chatId: "c1" }, { content: "done" })
    expect(sendOutbound).toHaveBeenCalledWith(expect.objectContaining({ channel: "telegram", chatId: "c1", text: "done" }))
  })

  it("skips a requests pick-up, which has no adapter", () => {
    const { r, sendOutbound, logs } = setup()
    r.postQueuedResponseToChannel("ops", { channel: "requests", chatId: "req-1" }, { content: "done" })
    expect(sendOutbound).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes("queued response post failed"))).toBe(false)
  })
})
