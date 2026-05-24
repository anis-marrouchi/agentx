// --- MCP stdio client + pool for the orchestrator tier ---
//
// CLI-backed tiers (claude-code, codex-cli) read <workspace>/.mcp.json
// natively, so the daemon's agent-mcp.ts sync is enough for them. The
// orchestrator tier runs agentx's own agentic loop against a provider
// (Claude / OpenAI / DeepSeek / Ollama / custom), and that loop has its
// own hand-rolled tool catalog (read_file, run_command, …) — MCP servers
// declared in agentx.json were dead weight for those agents until now.
//
// This module connects to each declared MCP server over stdio, lists
// its tools, namespaces them as `mcp__<server>__<tool>`, and exposes a
// dispatcher. The orchestrator merges the tool list into the catalog
// passed to provider.generateRaw() and routes matching tool_use blocks
// back through dispatch().

import { spawn, type ChildProcess } from "child_process"
import { debug } from "@/observability"

export interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type McpServerMap = Record<string, McpServerSpec>

export interface McpTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface McpCallResult {
  content: string
  isError?: boolean
}

const PROTOCOL_VERSION = "2024-11-05"
const INIT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 120_000
const TOOL_PREFIX = "mcp__"

export class McpClient {
  private proc: ChildProcess
  private buffer = ""
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private closed = false

  constructor(public readonly name: string, spec: McpServerSpec) {
    this.proc = spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(spec.env ?? {}) },
    })
    this.proc.stdout!.setEncoding("utf-8")
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk))
    this.proc.stderr!.setEncoding("utf-8")
    this.proc.stderr!.on("data", (chunk: string) =>
      debug.context("mcp", `${name} stderr: ${chunk.trimEnd()}`),
    )
    this.proc.on("exit", (code) => {
      this.closed = true
      debug.context("mcp", `${name}: exited (code=${code})`)
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`mcp server "${name}" exited`))
      }
      this.pending.clear()
    })
    this.proc.on("error", (e: Error) => {
      debug.context("mcp", `${name}: spawn error: ${e.message}`)
    })
  }

  async initialize(): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agentx-orchestrator", version: "0.1.0" },
      },
      INIT_TIMEOUT_MS,
    )
    this.notify("notifications/initialized")
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {}, INIT_TIMEOUT_MS)) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
    }
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema ?? { type: "object", properties: {} },
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request(
      "tools/call",
      { name, arguments: args ?? {} },
      CALL_TIMEOUT_MS,
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    // MCP tool results are a content array; flatten text blocks and JSON
    // any non-text blocks so the model sees something meaningful.
    const parts: string[] = []
    for (const block of result.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text)
      else parts.push(JSON.stringify(block))
    }
    return { content: parts.join("\n") || "(no output)", isError: result.isError }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.kill("SIGTERM")
    } catch {
      /* */
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const nl = this.buffer.indexOf("\n")
      if (nl < 0) break
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch (e: any) {
        debug.context("mcp", `${this.name}: parse error: ${e.message} (line: ${line.slice(0, 200)})`)
        continue
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        else p.resolve(msg.result)
      }
      // server-initiated notifications/requests (logging, sampling) are
      // ignored — the orchestrator doesn't expose capabilities for them.
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`mcp server "${this.name}" is closed`))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp "${this.name}" ${method} timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc.stdin!.write(payload)
      } catch (e: any) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`mcp "${this.name}" write failed: ${e.message}`))
      }
    })
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n"
    try {
      this.proc.stdin!.write(payload)
    } catch {
      /* */
    }
  }
}

export interface McpPool {
  /** Namespaced tools (`mcp__<server>__<tool>`) ready to merge into the
   *  agentic catalog passed to provider.generateRaw(). */
  tools: McpTool[]
  /** Resolve a namespaced tool name back to the right client and remote
   *  tool name. Returns an error envelope when the name is unknown. */
  dispatch(name: string, input: Record<string, unknown>): Promise<McpCallResult>
  close(): void
}

/** Spawn each declared server, list its tools, and return a pool that
 *  the orchestrator can drop into runAgenticLoop. A server that fails
 *  to initialize is dropped from the catalog (with a debug log) so one
 *  broken entry can't disable the whole tier. */
export async function startMcpPool(servers: McpServerMap): Promise<McpPool> {
  const clients = new Map<string, McpClient>()
  const tools: McpTool[] = []
  const router = new Map<string, { client: McpClient; remote: string }>()

  for (const [serverName, spec] of Object.entries(servers)) {
    const client = new McpClient(serverName, spec)
    try {
      await client.initialize()
      const remoteTools = await client.listTools()
      for (const t of remoteTools) {
        const namespaced = `${TOOL_PREFIX}${serverName}__${t.name}`
        tools.push({
          name: namespaced,
          description: t.description || `${serverName}.${t.name}`,
          input_schema: t.input_schema,
        })
        router.set(namespaced, { client, remote: t.name })
      }
      clients.set(serverName, client)
    } catch (e: any) {
      debug.context("mcp", `${serverName}: skipped — ${e.message}`)
      client.close()
    }
  }

  return {
    tools,
    async dispatch(name, input) {
      const route = router.get(name)
      if (!route) return { content: `Unknown MCP tool: ${name}`, isError: true }
      try {
        return await route.client.callTool(route.remote, input)
      } catch (e: any) {
        return { content: `MCP call failed: ${e.message}`, isError: true }
      }
    },
    close() {
      for (const c of clients.values()) c.close()
    },
  }
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(TOOL_PREFIX)
}
