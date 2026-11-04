import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { GitLabAdapter } from "../src/channels/gitlab"
import { _handleToolCallForTesting, _resetDaemonUrlForTesting } from "../src/mcp/index"

// An agent that called agentx_channel_reply with no agentId had its GitLab
// note signed "unknown" and sent with the global token, with no log line
// saying so. The MCP server knows who is calling; these tools must say.

describe("agentId the MCP tools send to the daemon", () => {
  let server: Server
  let bodies: Array<{ path: string; body: any }>
  const savedAgent = process.env.AGENTX_AGENT_ID

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ""
      req.on("data", (d) => { raw += d })
      req.on("end", () => {
        bodies.push({ path: req.url ?? "", body: JSON.parse(raw) })
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ ok: true, messageId: "1", output: { messageId: "1", labels: [] } }))
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    process.env.AGENTX_DAEMON_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    _resetDaemonUrlForTesting()
  })

  afterAll(async () => {
    delete process.env.AGENTX_DAEMON_URL
    _resetDaemonUrlForTesting()
    await new Promise((r) => server.close(r))
  })

  beforeEach(() => {
    bodies = []
    process.env.AGENTX_AGENT_ID = "pm-acme"
  })

  afterEach(() => {
    if (savedAgent === undefined) delete process.env.AGENTX_AGENT_ID
    else process.env.AGENTX_AGENT_ID = savedAgent
  })

  const reply = (args: Record<string, unknown>) =>
    _handleToolCallForTesting("agentx_channel_reply", { chatId: "acme/shop:issue:7", text: "hi", ...args })
  const label = (args: Record<string, unknown> = {}) =>
    _handleToolCallForTesting("agentx_channel_label", { project: "acme/shop", kind: "issue", iid: "7", add: ["x"], ...args })
  const send = (args: Record<string, unknown>) =>
    _handleToolCallForTesting("agentx_send", { chatId: "acme/shop:issue:7", text: "hi", ...args })

  it("names the running agent on a GitLab reply, a label change and a send", async () => {
    await reply({ channel: "gitlab" })
    await label()
    await send({ channel: "gitlab" })
    expect(bodies.map((b) => b.body.agentId)).toEqual(["pm-acme", "pm-acme", "pm-acme"])
  })

  it("keeps an agentId the caller gave", async () => {
    await reply({ channel: "gitlab", agentId: "other" })
    await label({ agentId: "other" })
    await send({ channel: "gitlab", agentId: "other" })
    expect(bodies.map((b) => b.body.agentId)).toEqual(["other", "other", "other"])
  })

  it("adds nothing outside an agent's run", async () => {
    delete process.env.AGENTX_AGENT_ID
    await reply({ channel: "gitlab" })
    await label()
    await send({ channel: "gitlab" })
    expect(bodies.map((b) => b.body.agentId)).toEqual([undefined, undefined, undefined])
  })

  // An agentId picks the agent's bound bot on Telegram, which may not be in
  // the chat, and the per-agent token on GitHub. Neither is this defect.
  it("leaves other channels as they were", async () => {
    await reply({ channel: "telegram", chatId: "123" })
    await reply({ channel: "github", chatId: "acme/shop:issue:7" })
    await send({ channel: "telegram", chatId: "123" })
    expect(bodies.map((b) => b.body.agentId)).toEqual([undefined, undefined, undefined])
  })
})

describe("GitLab global token with no agent named", () => {
  const adapter = (logs: string[]) => new GitLabAdapter(
    { webhookPort: 0, webhookSecret: "s", host: "https://gl.test", token: "global" } as any,
    (m: string) => logs.push(m),
  )

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 5, labels: [] }), { status: 200 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("logs a note posted with no agent id", async () => {
    const logs: string[] = []
    await adapter(logs).send({ channel: "gitlab", chatId: "acme/shop:issue:7", text: "hi" })
    expect(logs.filter((l) => l.includes("[gitlab/identity]") && l.includes("no agent id"))).toHaveLength(1)
  })

  it("logs a label change with no agent id", async () => {
    const logs: string[] = []
    await adapter(logs).setLabels({ project: "acme/shop", iid: "7", add: ["x"] })
    expect(logs.filter((l) => l.includes("[gitlab/identity]") && l.includes("no agent id"))).toHaveLength(1)
  })

  it("keeps the existing line when an agent without a token posts", async () => {
    const logs: string[] = []
    await adapter(logs).send({ channel: "gitlab", chatId: "acme/shop:issue:7", text: "hi", agentId: "pm-acme" })
    expect(logs.filter((l) => l.includes("[gitlab/identity]"))).toEqual([expect.stringContaining('note from "pm-acme"')])
  })
})
