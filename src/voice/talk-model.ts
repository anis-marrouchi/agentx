// --- The fast model behind spoken lines (talk mode, task narration) ---
//
// A spoken line needs no tools and no workspace, and it needs its first
// words fast. A full agent turn (Claude Code with tools, MCP, hooks) took
// 5–43 s per line. Two ways to be fast, measured on the Mac on 2026-09-24:
//
//   cli  one warm `claude -p` per speaker, fed turns over stream-json, with
//        MCP, hooks and settings off. ~2.7 s to first word cold, then
//        1.2–1.8 s. Uses the fleet's subscription login, like every agent.
//   api  a direct streaming Messages call through the provider layer. Fastest,
//        but needs a working API key or OAuth token that the provider can
//        resolve; on this Mac it resolved a stale one (401).
//
// "cli" is the default; AGENTX_TALK_BACKEND=api picks the other.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { createInterface } from "readline"
import { stripAnthropicApiKey } from "@/utils/workspace-env"

export const TALK_MODEL = "claude-haiku-4-5-20251001"

export interface TurnUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null }

export interface LineModel {
  /** Stream the reply to `message`; the model keeps the conversation. An
   *  aborted reply stops yielding at once. */
  reply(message: string, signal?: AbortSignal): AsyncIterable<string>
  close(): void
  /** Tokens and cost of the last finished turn, when the backend reports them. */
  lastUsage?: TurnUsage
}

export interface LineModelOpts {
  system: string
  model?: string
  backend?: "cli" | "api"
}

export function createLineModel(opts: LineModelOpts): LineModel {
  const backend = opts.backend ?? (process.env.AGENTX_TALK_BACKEND === "api" ? "api" : "cli")
  return backend === "api" ? new ApiLineModel(opts) : new CliLineModel(opts)
}

/** A warm `claude -p` process holding one speaker's side of the talk. */
export class CliLineModel implements LineModel {
  private child: ChildProcessWithoutNullStreams
  private lines: AsyncIterator<string>
  /** Turns run one at a time: each waits for the previous result line. */
  private queue: Promise<void> = Promise.resolve()
  private dead: string | null = null
  private seq = 0
  lastUsage?: TurnUsage

  constructor(opts: LineModelOpts, binary = "claude") {
    const env = stripAnthropicApiKey({ ...process.env })
    delete env.CLAUDECODE
    this.child = spawn(binary, [
      "-p", "--model", opts.model ?? TALK_MODEL,
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--include-partial-messages",
      "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", '{"disableAllHooks":true}', "--setting-sources", "",
      "--no-session-persistence", "--system-prompt", opts.system,
    ], { env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams
    this.child.on("error", (e) => { this.dead = e.message })
    this.child.on("exit", (code) => { this.dead ??= `claude exited (${code})` })
    this.child.stdin.on("error", () => {})
    this.child.stderr.resume()
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]()
  }

  reply(message: string, signal?: AbortSignal): AsyncIterable<string> {
    const out = new Channel<string>()
    const prev = this.queue
    // Read to the result line even when the caller stops listening, so the
    // next turn starts on its own output. An abort asks claude to stop the
    // turn (its result follows within tens of ms) rather than waiting out
    // the reply.
    const turn = (async () => {
      await prev
      if (this.dead) throw new Error(this.dead)
      if (signal?.aborted) return out.end()
      this.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: message } }) + "\n")
      const interrupt = () => this.child.stdin.write(JSON.stringify({
        type: "control_request", request_id: `interrupt-${++this.seq}`, request: { subtype: "interrupt" },
      }) + "\n")
      signal?.addEventListener("abort", interrupt, { once: true })
      try { await this.readTurn(out, signal) } finally { signal?.removeEventListener("abort", interrupt) }
    })().catch((e) => out.fail(e))
    this.queue = turn.then(() => {}, () => {})
    return out.read(signal)
  }

  private async readTurn(out: Channel<string>, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const next = await this.lines.next()
      if (next.done) throw new Error(this.dead ?? "claude closed its output")
      let ev: any
      try { ev = JSON.parse(next.value) } catch { continue }
      if (ev.type === "result") {
        const u = ev.usage ?? {}
        this.lastUsage = {
          inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null,
        }
        // An interrupted turn ends as an error; that is the abort working.
        if (ev.is_error && !signal?.aborted) throw new Error(String(ev.result ?? ev.subtype ?? "model error").slice(0, 200))
        return out.end()
      }
      const d = ev.type === "stream_event" && ev.event?.type === "content_block_delta" ? ev.event.delta : null
      if (d?.type === "text_delta") out.push(d.text as string)
    }
  }

  close(): void {
    this.dead ??= "closed"
    this.child.stdin.end()
    this.child.kill()
  }
}

/** A direct streaming call through the provider layer; history kept here. */
export class ApiLineModel implements LineModel {
  private history: Array<{ role: "user" | "assistant"; content: string }> = []

  constructor(private opts: LineModelOpts) {}

  async *reply(message: string, signal?: AbortSignal): AsyncIterable<string> {
    const { createProvider } = await import("@/agent/providers")
    const provider = createProvider("claude") as any
    this.history.push({ role: "user", content: message })
    let said = ""
    try {
      for await (const ev of provider.generateRawStream(this.history, this.opts.system, [], {
        model: this.opts.model ?? TALK_MODEL, maxTokens: 400, abortSignal: signal,
      })) {
        if (ev.type === "error") { if (signal?.aborted) return; throw new Error(ev.error) }
        if (ev.type === "text_delta") { said += ev.text; yield ev.text }
      }
    } finally {
      // Keep the turn order valid for the next call, even when cut short.
      this.history.push({ role: "assistant", content: said || "…" })
    }
  }

  close(): void {}
}

/** A one-reader async queue: a producer pushes, `read` yields until end. */
export class Channel<T> {
  private items: T[] = []
  private done = false
  private error: Error | null = null
  private wake: (() => void) | null = null

  push(v: T): void { this.items.push(v); this.wake?.() }
  end(): void { this.done = true; this.wake?.() }
  fail(e: unknown): void { this.error = e instanceof Error ? e : new Error(String(e)); this.end() }

  async *read(signal?: AbortSignal): AsyncIterable<T> {
    const onAbort = () => this.wake?.()
    signal?.addEventListener("abort", onAbort)
    try {
      for (;;) {
        if (signal?.aborted) return
        if (this.items.length) { yield this.items.shift()!; continue }
        if (this.error) throw this.error
        if (this.done) return
        await new Promise<void>((r) => { this.wake = r })
        this.wake = null
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }
}
