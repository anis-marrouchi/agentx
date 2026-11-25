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

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  // Keep the caller's AGENTX_* out: the test decides whether it is an agent run.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENTX_")))
  return new Promise((resolve) => {
    execFile("bash", [SCRIPT, "hello"], { env: { ...base, ...env } }, (err, stdout) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout })
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

  it("teaches the receipt flow", () => {
    const skill = readFileSync(join(__dirname, "../skills/agentx-bridge/SKILL.md"), "utf-8")
    expect(skill).toMatch(/receipt/)
    expect(skill).toContain("Do not wait or poll")
    expect(skill).toContain("AGENTX_AGENT_ID")
  })
})
