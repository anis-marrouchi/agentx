import { afterEach, describe, expect, it, vi } from "vitest"
import { GitLabAdapter } from "../src/channels/gitlab"
import { _handleToolCallForTesting, _resetDaemonUrlForTesting, postingAgentId } from "../src/mcp/index"

// #1745: agentx_channel_reply with no agentId posted a GitLab note under the
// global token, signed agentx:unknown, and nothing in the log said so.

const HOST = "https://gitlab.example.com"

describe("postingAgentId", () => {
  it("uses an explicit agentId first", () => {
    expect(postingAgentId({ agentId: "helper-agent" }, { AGENTX_AGENT_ID: "caller" })).toBe("helper-agent")
  })
  it("falls back to the calling agent", () => {
    expect(postingAgentId({}, { AGENTX_AGENT_ID: "caller" })).toBe("caller")
    expect(postingAgentId({ agentId: "  " }, { AGENTX_AGENT_ID: "caller" })).toBe("caller")
  })
  it("stays undefined for a non-agent caller", () => {
    expect(postingAgentId({}, {})).toBeUndefined()
  })
})

describe("channel write tools carry the calling agent's id", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    _resetDaemonUrlForTesting()
    vi.unstubAllGlobals()
  })

  function captureBodies() {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response(JSON.stringify({ output: { messageId: "1", labels: [] }, messageId: "1" }), { status: 200 })
    }))
    return bodies
  }

  it.each([
    ["agentx_channel_reply", { channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi" }],
    ["agentx_channel_label", { project: "acme/widgets", kind: "issue", iid: "7", add: ["x"] }],
    ["agentx_send", { channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi" }],
  ])("%s defaults agentId to AGENTX_AGENT_ID", async (tool, args) => {
    process.env.AGENTX_DAEMON_URL = "http://127.0.0.1:9"
    process.env.AGENTX_AGENT_ID = "caller"
    _resetDaemonUrlForTesting()
    const bodies = captureBodies()
    await _handleToolCallForTesting(tool, args)
    expect(bodies.at(-1)?.agentId).toBe("caller")
  })

  it("leaves agentId out for a non-agent caller", async () => {
    process.env.AGENTX_DAEMON_URL = "http://127.0.0.1:9"
    delete process.env.AGENTX_AGENT_ID
    _resetDaemonUrlForTesting()
    const bodies = captureBodies()
    await _handleToolCallForTesting("agentx_channel_reply", { channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi" })
    expect(bodies.at(-1)).not.toHaveProperty("agentId")
  })
})

describe("GitLab global-token writes with no agent id are logged", () => {
  afterEach(() => vi.unstubAllGlobals())

  function adapter(log: (m: string) => void) {
    return new GitLabAdapter({ host: HOST, token: "global-token", webhookPort: 0, routes: [] } as any, log)
  }

  it("send logs the unknown-signed note", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 55 }), text: async () => "" })))
    const lines: string[] = []
    await adapter((m) => lines.push(m)).send({ channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi" })
    expect(lines.some((l) => l.includes("[gitlab/identity]") && l.includes("no agent id") && l.includes("acme/widgets issue/7"))).toBe(true)
  })

  it("setLabels logs the no-agent change", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ labels: ["x"] }), text: async () => "" })))
    const lines: string[] = []
    await adapter((m) => lines.push(m)).setLabels({ project: "acme/widgets", iid: "7", add: ["x"] })
    expect(lines.some((l) => l.includes("[gitlab/identity] setLabels") && l.includes("no agent id"))).toBe(true)
  })
})
