// --- MCP client + pool for the orchestrator tier ---
//
// CLI-backed tiers (claude-code, codex-cli) read <workspace>/.mcp.json
// natively, so the daemon's agent-mcp.ts sync is enough for them. The
// orchestrator tier runs agentx's own agentic loop against a provider
// (Claude / OpenAI / DeepSeek / Ollama / custom), and that loop has its
// own hand-rolled tool catalog (read_file, run_command, …) — MCP servers
// declared in agentx.json were dead weight for those agents until now.
//
// This module connects to each declared MCP server (stdio child or
// HTTP+SSE endpoint), lists its tools, namespaces them as
// `mcp__<server>__<tool>`, and exposes a dispatcher. The orchestrator
// merges the tool list into the catalog passed to provider.generateRaw()
// and routes matching tool_use blocks back through dispatch().

import { spawn, type ChildProcess } from "child_process"
import { debug } from "@/observability"

/** stdio MCP server — spawned as a child process, JSON-RPC over NDJSON
 *  on stdin/stdout. The `type` field is optional for backward compat
 *  with the original config shape (`{ command, args, env }`). */
export interface McpStdioSpec {
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** HTTP MCP server (Streamable HTTP transport) — POST JSON-RPC bodies to
 *  `url`, server may answer as `application/json` or stream as
 *  `text/event-stream` (`data: <json>` lines). Optional `headers` get
 *  merged into every request (auth tokens, tenancy hints, etc.). */
export interface McpHttpSpec {
  type: "http"
  url: string
  headers?: Record<string, string>
}

export type McpServerSpec = McpStdioSpec | McpHttpSpec

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

function isHttpSpec(spec: McpServerSpec): spec is McpHttpSpec {
  return (spec as McpHttpSpec).type === "http"
}

interface Transport {
  /** Issue a JSON-RPC request and resolve with the `result` payload. */
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>
  /** Fire a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: Record<string, unknown>): void
  /** Release transport resources. Safe to call multiple times. */
  close(): void
}

class StdioTransport implements Transport {
  private proc: ChildProcess
  private buffer = ""
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private closed = false

  constructor(private readonly name: string, spec: McpStdioSpec) {
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

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
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

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n"
    try {
      this.proc.stdin!.write(payload)
    } catch {
      /* */
    }
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
}

class HttpTransport implements Transport {
  private nextId = 1
  private sessionId: string | null = null
  private closed = false

  constructor(private readonly name: string, private readonly spec: McpHttpSpec) {}

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) throw new Error(`mcp server "${this.name}" is closed`)
    const id = this.nextId++
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // The Streamable HTTP MCP spec lets servers answer either inline
      // JSON or via SSE; advertising both keeps us compatible with both
      // flavours (JORT-wiki uses SSE; some hosted MCPs return raw JSON).
      Accept: "application/json, text/event-stream",
      ...(this.spec.headers ?? {}),
    }
    // The MCP session-id handshake: server may return `mcp-session-id`
    // on the initialize response; we echo it back on every subsequent
    // call so the server can attach state (auth scope, conversation
    // history, etc.).
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    ;(timer as any).unref?.()

    let res: Response
    try {
      res = await fetch(this.spec.url, {
        method: "POST",
        headers,
        body,
        signal: ctl.signal,
      })
    } catch (e: any) {
      clearTimeout(timer)
      if (e?.name === "AbortError") {
        throw new Error(`mcp "${this.name}" ${method} timeout after ${timeoutMs}ms`)
      }
      throw new Error(`mcp "${this.name}" ${method} fetch failed: ${e?.message ?? e}`)
    }

    // Capture the session id from initialize (and any later response
    // that re-issues it). Header lookup is case-insensitive.
    const newSession = res.headers.get("mcp-session-id")
    if (newSession) this.sessionId = newSession

    if (!res.ok) {
      clearTimeout(timer)
      const errText = await res.text().catch(() => "")
      throw new Error(`mcp "${this.name}" HTTP ${res.status}: ${errText.slice(0, 300)}`)
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase()
    let parsed: any
    try {
      if (contentType.includes("text/event-stream")) {
        parsed = await parseSseEnvelope(res, id)
      } else {
        parsed = await res.json()
      }
    } catch (e: any) {
      clearTimeout(timer)
      throw new Error(`mcp "${this.name}" ${method} response parse failed: ${e?.message ?? e}`)
    } finally {
      clearTimeout(timer)
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(`mcp "${this.name}" ${method} returned non-object body`)
    }
    if (parsed.error) {
      throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
    }
    return parsed.result
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return
    // Notifications have no id and expect no response body. Server may
    // still 200 / 202; we don't care about the result. Fire-and-forget
    // so the caller (initialize → notifications/initialized) isn't
    // blocked on a round-trip the protocol doesn't require.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.spec.headers ?? {}),
    }
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
    fetch(this.spec.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
    }).catch((e: any) => {
      debug.context("mcp", `${this.name}: notify ${method} failed: ${e?.message ?? e}`)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // The Streamable HTTP MCP spec defines DELETE on the URL with the
    // session id to terminate. Fire-and-forget; the server may also
    // expire sessions on its own.
    if (this.sessionId) {
      const headers: Record<string, string> = {
        "Mcp-Session-Id": this.sessionId,
        ...(this.spec.headers ?? {}),
      }
      fetch(this.spec.url, { method: "DELETE", headers }).catch(() => { /* */ })
    }
  }
}

/** Read the SSE body, find the `data:` line whose JSON payload matches
 *  `id`, and return that JSON-RPC envelope. Discards any other events
 *  (server-initiated notifications, keep-alives, comment lines). */
async function parseSseEnvelope(res: Response, id: number): Promise<any> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error("SSE response had no body")
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE messages are separated by blank lines. Within a message,
      // `data:` may appear multiple times — concatenate them.
      let sepIdx: number
      while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, sepIdx)
        buffer = buffer.slice(sepIdx + 2)
        const dataLines: string[] = []
        for (const line of raw.split("\n")) {
          const trimmed = line.replace(/\r$/, "")
          if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trim())
        }
        if (!dataLines.length) continue
        const dataStr = dataLines.join("\n")
        if (!dataStr || dataStr === "[DONE]") continue
        let payload: any
        try { payload = JSON.parse(dataStr) } catch { continue }
        // Match by request id; ignore unrelated notifications.
        if (payload && payload.id === id) return payload
      }
    }
  } finally {
    try { reader.cancel().catch(() => { /* */ }) } catch { /* */ }
  }
  throw new Error(`SSE stream ended without a response for id=${id}`)
}

export class McpClient {
  private transport: Transport

  constructor(public readonly name: string, spec: McpServerSpec) {
    this.transport = isHttpSpec(spec)
      ? new HttpTransport(name, spec)
      : new StdioTransport(name, spec)
  }

  async initialize(): Promise<void> {
    await this.transport.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agentx-orchestrator", version: "0.1.0" },
      },
      INIT_TIMEOUT_MS,
    )
    this.transport.notify("notifications/initialized")
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.transport.request("tools/list", {}, INIT_TIMEOUT_MS)) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
    }
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema ?? { type: "object", properties: {} },
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.transport.request(
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
    this.transport.close()
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

/** Boot each declared server, list its tools, and return a pool that
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
