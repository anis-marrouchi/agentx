import { describe, it, expect, onTestFinished } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { execFile } from "child_process"
import { readFileSync } from "fs"
import { join } from "path"
import type { AddressInfo } from "net"

// #2007 last box: the agentx-bridge skill uses the receipt flow. An agent run
// names its caller and gets a receipt; anyone else waits for the answer.

const SCRIPT = join(__dirname, "../skills/agentx-bridge/agentx-bridge.sh")

type Seen = { path?: string; body?: Record<string, unknown>; task?: string }

async function stub(reply: (seen: Seen) => [number, unknown]): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = {}
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      seen.path = req.url
      seen.body = JSON.parse(raw)
      seen.task = req.headers["x-agentx-task"] as string | undefined
      const [status, body] = reply(seen)
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  onTestFinished(() => new Promise<void>((r) => server.close(() => r())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

function run(env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  // Keep the caller's AGENTX_* out: the test decides whether it is an agent run.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENTX_")))
  return new Promise((resolve) => {
    execFile("bash", [SCRIPT, "hello"], { env: { ...base, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr })
    })
  })
}

describe("agentx-bridge skill (#2007 receipt flow)", () => {
  it("an agent run names its caller and stops at the receipt", async () => {
    const { url, seen } = await stub(() => [202, { accepted: true, taskId: "hnd-1" }])
    const { code, out } = await run({
      AGENTX_BRIDGE_URL: url,
      AGENTX_LOCAL: "true",
      AGENTX_AGENT: "devops-agent",
      AGENTX_AGENT_ID: "coder-agent",
      AGENTX_CHANNEL: "a2a",
      AGENTX_CHAT_ID: "a2a:x:y",
      AGENTX_TASK_ID: "t-1",
    })
    expect(code).toBe(0)
    expect(seen.path).toBe("/task")
    expect(seen.body).toMatchObject({ agent: "devops-agent", message: "hello", senderAgentId: "coder-agent", callerChannel: "a2a", callerChatId: "a2a:x:y" })
    expect(seen.task).toBe("t-1")
    expect(out).toContain("hnd-1")
    expect(out).toMatch(/Do not wait/)
  })

  it("a person or script names no caller and prints the answer", async () => {
    const { url, seen } = await stub(() => [200, { content: "pong" }])
    const { code, out } = await run({ AGENTX_BRIDGE_URL: url, AGENTX_LOCAL: "true", AGENTX_AGENT: "devops-agent" })
    expect(code).toBe(0)
    expect(seen.body).not.toHaveProperty("senderAgentId")
    expect(seen.task).toBeUndefined()
    expect(out.trim()).toBe("pong")
  })

  it("a none receipt says the answer is read by its id, not in this chat", async () => {
    const { url } = await stub(() => [202, { accepted: true, mode: "none", taskId: "dlg-9" }])
    const { code, out } = await run({ AGENTX_BRIDGE_URL: url, AGENTX_LOCAL: "true", AGENTX_AGENT: "devops-agent", AGENTX_AGENT_ID: "coder-agent" })
    expect(code).toBe(0)
    expect(out).toContain('agentx_lookup (handoff: "dlg-9")')
    expect(out).toContain("/a2a/delegations/dlg-9?as=coder-agent")
    expect(out).not.toMatch(/comes back to this chat/)
  })

  it("has no default agent or peer", async () => {
    const noAgent = await run({ AGENTX_BRIDGE_URL: "http://127.0.0.1:1", AGENTX_LOCAL: "true" })
    expect(noAgent.code).toBe(1)
    expect(noAgent.err).toContain("set AGENTX_AGENT")
    const noPeer = await run({ AGENTX_BRIDGE_URL: "http://127.0.0.1:1", AGENTX_AGENT: "devops-agent" })
    expect(noPeer.code).toBe(1)
    expect(noPeer.err).toMatch(/set AGENTX_PEER.*AGENTX_LOCAL=true/)
  })

  it("a mesh send escapes the message and names the peer", async () => {
    const { url, seen } = await stub(() => [200, { content: "pong" }])
    const { code } = await run({ AGENTX_BRIDGE_URL: url, AGENTX_AGENT: "devops-agent", AGENTX_PEER: "box", AGENTX_CHANNEL: "a2a", AGENTX_CHAT_ID: 'a"b' })
    expect(code).toBe(0)
    expect(seen.path).toBe("/mesh/task")
    expect(seen.body).toEqual({ peer: "box", agent: "devops-agent", message: "hello", async: true, context: { channel: "a2a", chatId: 'a"b' } })
  })

  it("an agent caller's mesh send keeps its context and names itself", async () => {
    const { url, seen } = await stub(() => [202, { accepted: true, mode: "callback", taskId: "dlg-7" }])
    const { code, out } = await run({
      AGENTX_BRIDGE_URL: url,
      AGENTX_AGENT: "devops-agent",
      AGENTX_PEER: "box",
      AGENTX_AGENT_ID: "coder-agent",
      AGENTX_CHANNEL: "a2a",
      AGENTX_CHAT_ID: "a2a:x:y",
    })
    expect(code).toBe(0)
    expect(seen.path).toBe("/mesh/task")
    // #709: the peer keys the callee's session by context. No async flag:
    // async:true with a chat would deliver there instead of a callback.
    expect(seen.body).toEqual({
      peer: "box", agent: "devops-agent", message: "hello",
      senderAgentId: "coder-agent", callerChannel: "a2a", callerChatId: "a2a:x:y",
      context: { channel: "a2a", chatId: "a2a:x:y" },
    })
    expect(out).toContain("dlg-7")
  })

  it("teaches the receipt flow", () => {
    const skill = readFileSync(join(__dirname, "../skills/agentx-bridge/SKILL.md"), "utf-8")
    expect(skill).toMatch(/receipt/)
    expect(skill).toContain("Do not wait or poll")
    expect(skill).toContain("AGENTX_AGENT_ID")
    expect(skill).toContain('mode: "none"')
    expect(skill).toContain("agentx_send_agent")
    expect(skill).not.toMatch(/atlas|clawd-server/)
    expect(skill).toContain("~/.claude/skills/agentx-bridge/agentx-bridge.sh")
    expect(skill).not.toMatch(/^\S*\s*skills\/agentx-bridge\/agentx-bridge\.sh/m)
  })
})
