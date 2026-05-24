import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createServer, type Server } from "http"
import { AddressInfo } from "net"
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

// --- HTTP transport coverage ---
// Spin up a tiny Node http.Server that speaks the Streamable HTTP MCP
// flavour: POST JSON-RPC, answer with SSE `data: <json>` payloads. The
// test exercises the same initialize → tools/list → tools/call round-trip
// as the stdio cases but over fetch, and verifies the
// `Mcp-Session-Id` handshake survives across calls.

function startHttpMockServer(opts: { contentType?: "sse" | "json" } = {}): Promise<{ url: string; server: Server; sessions: Set<string> }> {
  return new Promise((resolve) => {
    const sessions = new Set<string>()
    const server = createServer((req, res) => {
      if (req.method !== "POST") { res.statusCode = 405; res.end(); return }
      let body = ""
      req.on("data", (c) => { body += c.toString() })
      req.on("end", () => {
        let msg: any
        try { msg = JSON.parse(body) } catch { res.statusCode = 400; res.end("bad json"); return }
        const sid = req.headers["mcp-session-id"] as string | undefined
        if (sid) sessions.add(sid)

        // Notifications: 202 Accepted, no body.
        if (typeof msg.id === "undefined") { res.statusCode = 202; res.end(); return }

        let result: any
        if (msg.method === "initialize") {
          // Hand out a session id on initialize; client must echo it back.
          res.setHeader("Mcp-Session-Id", "sess-abc")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "http-mock", version: "0.0.0" },
          }
        } else if (msg.method === "tools/list") {
          result = { tools: [
            { name: "ping", description: "HTTP echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
          ] }
        } else if (msg.method === "tools/call") {
          result = { content: [{ type: "text", text: JSON.stringify({ pong: msg.params?.arguments }) }] }
        } else {
          res.statusCode = 400; res.end("unknown method"); return
        }

        const envelope = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })
        if (opts.contentType === "json") {
          res.setHeader("Content-Type", "application/json")
          res.end(envelope)
        } else {
          res.setHeader("Content-Type", "text/event-stream")
          res.write(`data: ${envelope}\n\n`)
          res.end()
        }
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      resolve({ url: `http://127.0.0.1:${port}/`, server, sessions })
    })
  })
}

describe("McpClient (HTTP transport)", () => {
  it("round-trips initialize / tools/list / tools/call over SSE", async () => {
    const { url, server, sessions } = await startHttpMockServer()
    const client = new McpClient("http-mock", { type: "http", url })
    try {
      await client.initialize()
      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(["ping"])
      const r = await client.callTool("ping", { text: "hello" })
      expect(r.isError).toBeFalsy()
      expect(r.content).toContain('"hello"')
      // The mock issued sess-abc on initialize; every later request must
      // carry it back. We saw at least initialize + tools/list +
      // tools/call → server should have logged the same id for the
      // post-initialize calls.
      expect(sessions.has("sess-abc")).toBe(true)
    } finally {
      client.close()
      server.close()
    }
  })

  it("handles application/json responses (non-SSE servers)", async () => {
    const { url, server } = await startHttpMockServer({ contentType: "json" })
    const client = new McpClient("http-mock", { type: "http", url })
    try {
      await client.initialize()
      const r = await client.callTool("ping", { text: "json-mode" })
      expect(r.content).toContain('"json-mode"')
    } finally {
      client.close()
      server.close()
    }
  })

  it("startMcpPool namespaces tools from an HTTP server", async () => {
    const { url, server } = await startHttpMockServer()
    const pool = await startMcpPool({
      remote: { type: "http", url },
    })
    try {
      expect(pool.tools.map((t) => t.name)).toEqual(["mcp__remote__ping"])
      const r = await pool.dispatch("mcp__remote__ping", { text: "via-pool" })
      expect(r.isError).toBeFalsy()
      expect(r.content).toContain('"via-pool"')
    } finally {
      pool.close()
      server.close()
    }
  })
})
