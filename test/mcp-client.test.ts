import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { McpClient, startMcpPool, isMcpToolName } from "../src/agent/mcp-client"

// Minimal stdio MCP server used as a test double. Reads NDJSON requests
// from stdin and answers initialize / tools/list / tools/call. The
// `echo` tool returns the arguments as JSON in a text content block —
// that's enough to verify the client → server → client round-trip and
// the response-flattening logic in McpClient.callTool.
const MOCK_SERVER = `
let buf = ""
process.stdin.setEncoding("utf-8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  while (true) {
    const nl = buf.indexOf("\\n")
    if (nl < 0) break
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "0.0.0" },
      } }) + "\\n")
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [
          { name: "echo", description: "Echo back input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
          { name: "boom", description: "Always errors", inputSchema: { type: "object", properties: {} } },
        ],
      } }) + "\\n")
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params || {}
      if (name === "boom") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: "kaboom" }],
          isError: true,
        } }) + "\\n")
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: JSON.stringify({ echoed: args }) }],
        } }) + "\\n")
      }
    }
  }
})
`

let tmpDir: string | null = null
function mockServerScript(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "agentx-mcp-test-"))
  const script = join(tmpDir, "mock-server.mjs")
  writeFileSync(script, MOCK_SERVER)
  return script
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

describe("isMcpToolName", () => {
  it("matches the namespaced prefix", () => {
    expect(isMcpToolName("mcp__github__search")).toBe(true)
    expect(isMcpToolName("read_file")).toBe(false)
  })
})

describe("McpClient", () => {
  it("initialises, lists tools, and calls a tool round-trip", async () => {
    const client = new McpClient("mock", { command: process.execPath, args: [mockServerScript()] })
    try {
      await client.initialize()
      const tools = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"])
      const echo = tools.find((t) => t.name === "echo")!
      expect(echo.description).toBe("Echo back input")
      expect(echo.input_schema).toMatchObject({ type: "object" })

      const ok = await client.callTool("echo", { text: "hi" })
      expect(ok.isError).toBeFalsy()
      expect(ok.content).toContain('"echoed"')
      expect(ok.content).toContain('"hi"')

      const err = await client.callTool("boom", {})
      expect(err.isError).toBe(true)
      expect(err.content).toBe("kaboom")
    } finally {
      client.close()
    }
  })

  it("rejects requests after close", async () => {
    const client = new McpClient("mock", { command: process.execPath, args: [mockServerScript()] })
    await client.initialize()
    client.close()
    await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/closed|exited/)
  })
})

describe("startMcpPool", () => {
  it("namespaces tools and dispatches by namespaced name", async () => {
    const script = mockServerScript()
    const pool = await startMcpPool({
      alpha: { command: process.execPath, args: [script] },
      beta: { command: process.execPath, args: [script] },
    })
    try {
      const names = pool.tools.map((t) => t.name).sort()
      expect(names).toEqual([
        "mcp__alpha__boom",
        "mcp__alpha__echo",
        "mcp__beta__boom",
        "mcp__beta__echo",
      ])

      const r = await pool.dispatch("mcp__beta__echo", { text: "ping" })
      expect(r.isError).toBeFalsy()
      expect(r.content).toContain('"ping"')

      const unknown = await pool.dispatch("mcp__nope__nothing", {})
      expect(unknown.isError).toBe(true)
      expect(unknown.content).toMatch(/Unknown MCP tool/)
    } finally {
      pool.close()
    }
  })

  it("drops a server that fails to initialise but keeps the rest", async () => {
    const script = mockServerScript()
    const pool = await startMcpPool({
      good: { command: process.execPath, args: [script] },
      bad: { command: process.execPath, args: ["-e", "process.exit(1)"] },
    })
    try {
      const serverNames = new Set(pool.tools.map((t) => t.name.split("__")[1]))
      expect(serverNames.has("good")).toBe(true)
      expect(serverNames.has("bad")).toBe(false)
    } finally {
      pool.close()
    }
  })
})
