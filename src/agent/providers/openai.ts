import type {
  AgentProvider,
  GenerationMessage,
  GenerationResult,
  GeneratedFile,
  ProviderOptions,
  StreamEvent,
  AnthropicMessage,
  RawGenerationResult,
  RawStreamEvent,
  ContentBlock,
} from "./types"
import { getLegacyTools } from "../tools/definitions"

// --- OpenAI-compatible provider (OpenAI, DeepSeek, OpenRouter, Together,
//     vLLM, llama.cpp, anything that speaks the Chat Completions API).
//
// Zero new deps — uses raw `fetch` to mirror the ClaudeProvider pattern.
// Routes through OPENAI_BASE_URL so the same class works for every
// OpenAI-shape backend; defaults to api.openai.com/v1.
//
// Environment knobs:
//   OPENAI_BASE_URL  e.g. https://api.deepseek.com/v1 (defaults to OpenAI)
//   OPENAI_API_KEY   bearer token for the upstream
//   OPENAI_MODEL     default model id (per-call override via options.model)
//
// The agentx-side tool catalog uses Anthropic's `input_schema` shape and
// the rest of the runtime expects RawGenerationResult in Anthropic shape
// (ContentBlock[] with stop_reason: "end_turn"|"tool_use"|…). We translate
// at the boundary so the tool/agentic loop above is provider-agnostic.

const DEFAULT_MODEL = "gpt-4o-mini"
const DEFAULT_MAX_TOKENS = 8192

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAIResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: OpenAIToolCall[]
  // DeepSeek V4 reasoning output ("thinking mode"). When present, MUST
  // be echoed back on subsequent requests of the same turn or DeepSeek
  // 400s with "The reasoning_content in the thinking mode must be
  // passed back to the API." We surface it as a {type:"reasoning"}
  // ContentBlock so the agentic loop carries it through.
  reasoning_content?: string
}

interface OpenAIChatResponse {
  id: string
  model: string
  choices: Array<{
    index: number
    message: OpenAIResponseMessage
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export interface OpenAIProviderOptions {
  /** Toggle "thinking mode" on backends that support it (DeepSeek V4
   *  `reasoning_content`). Default `true` for DeepSeek baseUrls so the
   *  agent surfaces its reasoning live in the dashboard; set to `false`
   *  via `providers.<name>.thinking` in agentx.json if a particular
   *  agent wants the extra latency / cost back. Ignored on backends
   *  that don't speak the thinking-mode protocol (vanilla OpenAI,
   *  vLLM, Together, …). */
  thinking?: boolean
}

export class OpenAIProvider implements AgentProvider {
  name = "openai"
  private apiKey: string
  private baseUrl: string
  /** Resolved thinking flag — null when the backend isn't a known
   *  thinking-mode endpoint and the option is irrelevant. */
  private thinkingEnabled: boolean | null

  constructor(apiKey?: string, baseUrl?: string, opts: OpenAIProviderOptions = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || ""
    this.baseUrl = (
      baseUrl ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1"
    ).replace(/\/$/, "")
    // DeepSeek defaults to thinking ON — that's the model's own default
    // behavior. Operator can flip it off via providers.<name>.thinking=false.
    // Non-DeepSeek backends ignore the flag entirely.
    const isDeepseek = this.baseUrl.includes("deepseek.com")
    this.thinkingEnabled = isDeepseek
      ? (opts.thinking === false ? false : true)
      : null
    if (!this.apiKey) {
      throw new Error(
        "OpenAI-compatible API key required. Set OPENAI_API_KEY (or pass --api-key). " +
        "For DeepSeek, also set OPENAI_BASE_URL=https://api.deepseek.com/v1.",
      )
    }
  }

  async generate(
    messages: GenerationMessage[],
    options?: ProviderOptions,
  ): Promise<GenerationResult> {
    const model = options?.model || process.env.OPENAI_MODEL || DEFAULT_MODEL
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS

    // OpenAI takes system as just another message with role:"system" at the top.
    const oaMessages = messages.map((m) => ({ role: m.role, content: m.content }))

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: oaMessages,
      tools: this.legacyToolsAsOpenAI(),
    }
    if (options?.temperature !== undefined) body.temperature = options.temperature

    const data = await this.callApi(body)
    return this.parseHighLevelResponse(data)
  }

  async generateRaw(
    messages: AnthropicMessage[],
    systemPrompt: string,
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    options?: ProviderOptions,
  ): Promise<RawGenerationResult> {
    const body = this.buildRawBody(messages, systemPrompt, tools, options)
    const data = await this.callApi(body, options?.abortSignal)
    return this.parseRawResponse(data)
  }

  /**
   * Streaming variant of generateRaw. Yields text_delta and thinking_delta
   * events as the model speaks, then a terminal raw_result with the full
   * content blocks (text, tool_use, and — for DeepSeek thinking mode —
   * a `reasoning` block at the head). The agentic loop's tool-dispatch
   * and reasoning-round-trip logic then operates on identical data to
   * the non-streaming path.
   */
  async *generateRawStream(
    messages: AnthropicMessage[],
    systemPrompt: string,
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    options?: ProviderOptions,
  ): AsyncIterable<RawStreamEvent> {
    const body = { ...this.buildRawBody(messages, systemPrompt, tools, options), stream: true, stream_options: { include_usage: true } }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(this.maybeDeepseekExtras(body)),
        // Forward operator cancel down to the HTTP layer so Stop
        // actually terminates the in-flight request. Without this,
        // the abort fires in the registry but fetch keeps draining
        // tokens.
        signal: options?.abortSignal as any,
      })
    } catch (err: any) {
      // AbortError surfaces here when the operator cancelled before
      // the connection completed. Treat as cancelled, not a real
      // error — the registry's outer handler already records the
      // cancellation.
      if (err?.name === "AbortError" || options?.abortSignal?.aborted) {
        yield { type: "error", error: "cancelled" }
        return
      }
      yield { type: "error", error: `OpenAI-compat raw stream init failed: ${err?.message ?? err}` }
      return
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      yield { type: "error", error: `OpenAI-compat API error (${res.status}): ${errText.slice(0, 500)}` }
      return
    }
    const reader = res.body?.getReader()
    if (!reader) { yield { type: "error", error: "No response body on OpenAI-compat raw stream" }; return }

    // Wire the operator's abort signal into reader.cancel() so an abort
    // mid-stream actually closes the underlying TCP socket. Without this,
    // undici sometimes keeps reader.read() pending forever even after
    // fetch's signal aborts — DeepSeek's reasoning_content can stream for
    // many minutes, and the orchestrator's wall-clock timer fired into a
    // signal that no one was actually watching here. Production saw 58+
    // min hangs past the 15-min maxExecutionMinutes cap on noqta-public.
    const onAbortCancelReader = () => {
      reader.cancel(new Error("aborted")).catch(() => { /* already closed */ })
    }
    if (options?.abortSignal) {
      if (options.abortSignal.aborted) onAbortCancelReader()
      else options.abortSignal.addEventListener("abort", onAbortCancelReader, { once: true })
    }

    const decoder = new TextDecoder()
    let buffer = ""
    let textOut = ""
    let reasoningOut = ""
    let inputTokens = 0
    let outputTokens = 0
    let finishReason: string | null = null
    interface ToolAcc { id: string; name: string; argumentsRaw: string }
    const toolAcc: Record<number, ToolAcc> = {}

    try {
      while (true) {
        // Belt-and-braces: bail between chunks too, in case reader.cancel()
        // didn't unblock the pending read (some SSE proxies hold the
        // connection open even after upstream close).
        if (options?.abortSignal?.aborted) {
          yield { type: "error", error: "cancelled" }
          return
        }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const data = line.slice(6).trim()
          if (!data || data === "[DONE]") continue
          let chunk: any
          try { chunk = JSON.parse(data) } catch { continue }
          const choice = chunk.choices?.[0]
          const delta = choice?.delta
          if (choice?.finish_reason) finishReason = choice.finish_reason

          if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
            reasoningOut += delta.reasoning_content
            yield { type: "thinking_delta", text: delta.reasoning_content }
          }
          if (typeof delta?.content === "string" && delta.content) {
            textOut += delta.content
            yield { type: "text_delta", text: delta.content }
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (idx == null) continue
              const acc = (toolAcc[idx] ||= { id: "", name: "", argumentsRaw: "" })
              if (tc.id) acc.id = tc.id
              if (tc.function?.name) acc.name = tc.function.name
              if (tc.function?.arguments) acc.argumentsRaw += tc.function.arguments
            }
          }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || 0
            outputTokens = chunk.usage.completion_tokens || 0
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || options?.abortSignal?.aborted) {
        yield { type: "error", error: "cancelled" }
        return
      }
      yield { type: "error", error: `OpenAI-compat raw stream read failed: ${err?.message ?? err}` }
      return
    } finally {
      if (options?.abortSignal) {
        options.abortSignal.removeEventListener("abort", onAbortCancelReader)
      }
    }

    // Assemble blocks in the same order parseRawResponse uses so the
    // agentic loop's round-trip stays consistent.
    const blocks: ContentBlock[] = []
    if (reasoningOut) blocks.push({ type: "reasoning", text: reasoningOut })
    if (textOut) blocks.push({ type: "text", text: textOut })
    for (const acc of Object.values(toolAcc)) {
      if (!acc.id || !acc.name) continue
      let input: Record<string, unknown> = {}
      try { input = acc.argumentsRaw ? JSON.parse(acc.argumentsRaw) : {} } catch { /* keep empty input */ }
      blocks.push({ type: "tool_use", id: acc.id, name: acc.name, input })
    }

    let stop_reason: RawGenerationResult["stop_reason"] = "end_turn"
    switch (finishReason) {
      case "tool_calls":
      case "function_call":
        stop_reason = "tool_use"; break
      case "length":
        stop_reason = "max_tokens"; break
    }

    yield {
      type: "raw_result",
      result: { content: blocks, stop_reason, usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
    }
  }

  /** Shared request-body builder for generateRaw / generateRawStream — both
   *  need the same message translation, tool list, and provider extras. */
  private buildRawBody(
    messages: AnthropicMessage[],
    systemPrompt: string,
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    options?: ProviderOptions,
  ): Record<string, unknown> {
    const model = options?.model || process.env.OPENAI_MODEL || DEFAULT_MODEL
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS

    // Translate Anthropic-shape messages (with tool_use / tool_result content blocks)
    // into OpenAI Chat Completions message shape (with role:"tool" turns and
    // assistant.tool_calls). System prompt goes in as messages[0].
    const oaMessages: any[] = systemPrompt
      ? [{ role: "system", content: systemPrompt }]
      : []

    for (const m of messages) {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text" as const, text: m.content }]
      if (m.role === "user") {
        const toolResults = blocks.filter((b) => (b as any).type === "tool_result") as Array<{
          type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean;
        }>
        const textParts = blocks
          .filter((b) => (b as any).type === "text")
          .map((b) => (b as any).text)
          .join("")
        for (const tr of toolResults) {
          oaMessages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.is_error ? `[error] ${tr.content}` : tr.content,
          })
        }
        if (textParts) {
          oaMessages.push({ role: "user", content: textParts })
        } else if (toolResults.length === 0) {
          oaMessages.push({ role: "user", content: m.content as any })
        }
      } else {
        // Assistant turns may have text + tool_use + reasoning blocks;
        // OpenAI wants `content` + `tool_calls` on a single message,
        // and DeepSeek V4 also wants the prior `reasoning_content` so
        // thinking-mode round-trip works.
        const toolUses = blocks.filter((b) => (b as any).type === "tool_use") as Array<{
          type: "tool_use"; id: string; name: string; input: Record<string, unknown>;
        }>
        const text = blocks
          .filter((b) => (b as any).type === "text")
          .map((b) => (b as any).text)
          .join("")
        const reasoning = blocks
          .filter((b) => (b as any).type === "reasoning")
          .map((b) => (b as any).text)
          .join("")
        const msg: any = { role: "assistant", content: text || null }
        if (toolUses.length > 0) {
          msg.tool_calls = toolUses.map((tu) => ({
            id: tu.id,
            type: "function" as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
          }))
        }
        if (reasoning) {
          msg.reasoning_content = reasoning
        }
        oaMessages.push(msg)
      }
    }

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: oaMessages,
      tools: tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
      tool_choice: "auto",
    }
    if (options?.temperature !== undefined) body.temperature = options.temperature
    return body
  }

  async *stream(
    messages: GenerationMessage[],
    options?: ProviderOptions,
  ): AsyncIterable<StreamEvent> {
    const model = options?.model || process.env.OPENAI_MODEL || DEFAULT_MODEL
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS

    const oaMessages = messages.map((m) => ({ role: m.role, content: m.content }))

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: oaMessages,
      tools: this.legacyToolsAsOpenAI(),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (options?.temperature !== undefined) body.temperature = options.temperature

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.maybeDeepseekExtras(body)),
      })
    } catch (err: any) {
      yield { type: "error", error: `OpenAI-compat stream init failed: ${err.message}` }
      return
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      yield {
        type: "error",
        error: `OpenAI-compat API error (${res.status}): ${errText.slice(0, 500)}`,
      }
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      yield { type: "error", error: "No response body on OpenAI-compat stream" }
      return
    }

    // Same SSE parsing approach as ClaudeProvider.stream — read chunks, split
    // on lines, accumulate tool_calls by index. Tool args arrive as
    // many small string fragments and must be joined before JSON.parse.
    const decoder = new TextDecoder()
    let buffer = ""
    let content = ""
    let followUp: string | undefined
    let tokensUsed = 0
    const files: GeneratedFile[] = []
    interface ToolAcc { id: string; name: string; argumentsRaw: string }
    const toolAcc: Record<number, ToolAcc> = {}
    let activeToolEmittedIdx: Record<number, boolean> = {}

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const data = line.slice(6).trim()
          if (data === "[DONE]") continue

          let chunk: any
          try { chunk = JSON.parse(data) } catch { continue }
          const choice = chunk.choices?.[0]
          const delta = choice?.delta

          // Reasoning deltas (DeepSeek V4 thinking mode). Emit as a
          // separate event so the consumer can render them inline as
          // the agent thinks, without polluting `content`. The high-
          // level stream() path doesn't carry reasoning into the
          // final `GenerationResult` (it's not part of the visible
          // answer) — only generateRawStream does, so the agentic
          // round-trip can echo it back.
          if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
            yield { type: "thinking_delta", text: delta.reasoning_content }
          }

          // Text deltas — stream to caller and accumulate.
          if (typeof delta?.content === "string" && delta.content) {
            content += delta.content
            yield { type: "text_delta", text: delta.content }
          }

          // Tool call deltas — accumulate per index. Emit start once per
          // tool, emit delta fragments as input_json comes in.
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (idx == null) continue
              const acc = (toolAcc[idx] ||= { id: "", name: "", argumentsRaw: "" })
              if (tc.id) acc.id = tc.id
              if (tc.function?.name) acc.name = tc.function.name
              if (tc.function?.arguments) acc.argumentsRaw += tc.function.arguments

              if (acc.id && acc.name && !activeToolEmittedIdx[idx]) {
                activeToolEmittedIdx[idx] = true
                yield { type: "tool_use_start", name: acc.name, id: acc.id }
              }
              if (activeToolEmittedIdx[idx] && tc.function?.arguments) {
                yield { type: "tool_use_delta", json: tc.function.arguments }
              }
            }
          }

          // Usage chunk (OpenAI sends a final chunk with `usage` when
          // stream_options.include_usage=true; DeepSeek/others may not).
          if (chunk.usage) {
            tokensUsed =
              (chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0)
          }
        }
      }
    } catch (err: any) {
      yield { type: "error", error: `OpenAI-compat stream read failed: ${err.message}` }
      return
    }

    // Finalize tool_calls: parse the joined arguments JSON and map
    // create_files / ask_user the same way ClaudeProvider does.
    for (const acc of Object.values(toolAcc)) {
      if (!acc.name) continue
      yield { type: "tool_use_end", name: acc.name }
      try {
        const input = acc.argumentsRaw ? JSON.parse(acc.argumentsRaw) : {}
        if (acc.name === "create_files" && Array.isArray(input.files)) {
          files.push(...(input.files as GeneratedFile[]))
          if (typeof input.summary === "string" && input.summary.trim()) {
            content += (content ? "\n" : "") + input.summary
          }
        } else if (acc.name === "ask_user" && typeof input.question === "string") {
          followUp = input.question
          if (Array.isArray(input.options) && input.options.length) {
            followUp += `\nOptions: ${input.options.join(", ")}`
          }
        }
      } catch {
        // Malformed tool args — surface as missing, don't crash the stream.
      }
    }

    yield { type: "done", result: { content, files, followUp, tokensUsed } }
  }

  // --- helpers ---

  private async callApi(body: Record<string, unknown>, abortSignal?: AbortSignal): Promise<OpenAIChatResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.maybeDeepseekExtras(body)),
      signal: abortSignal as any,
    })
    if (!res.ok) {
      const errorText = await res.text().catch(() => "")
      throw new Error(`OpenAI-compatible API error (${res.status}) ${this.baseUrl}: ${errorText.slice(0, 500)}`)
    }
    return (await res.json()) as OpenAIChatResponse
  }

  /**
   * DeepSeek v4 enables "thinking mode" by default — the model emits a
   * `reasoning_content` block that the API expects to be echoed back on
   * the next request. The agentic loop now handles that round-trip
   * (assistant turns with a `reasoning` content block get folded into
   * `msg.reasoning_content` in the next request), so we no longer need
   * to globally disable it. Operator can still opt out per provider via
   * `providers.<name>.thinking: false` in agentx.json — the constructor
   * resolves `this.thinkingEnabled` and we only emit `enable_thinking:
   * false` when explicitly disabled.
   */
  private maybeDeepseekExtras(body: Record<string, unknown>): Record<string, unknown> {
    if (this.thinkingEnabled === null) return body  // not a thinking-mode backend
    if (this.thinkingEnabled === false) return { ...body, enable_thinking: false }
    return body  // thinking ON — DeepSeek's default, no extra flag needed
  }

  private parseHighLevelResponse(response: OpenAIChatResponse): GenerationResult {
    const choice = response.choices?.[0]
    const message = choice?.message
    const files: GeneratedFile[] = []
    let content = message?.content || ""
    let followUp: string | undefined

    // Map legacy tools (create_files, ask_user) the same way ClaudeProvider
    // does — these are the only tools getLegacyTools() exposes today.
    for (const tc of message?.tool_calls || []) {
      let parsedArgs: any = {}
      try {
        parsedArgs = JSON.parse(tc.function.arguments || "{}")
      } catch {
        /* ignore malformed tool args */
      }
      if (tc.function.name === "create_files" && Array.isArray(parsedArgs.files)) {
        files.push(...parsedArgs.files)
        if (typeof parsedArgs.summary === "string" && parsedArgs.summary.trim()) {
          content += (content ? "\n" : "") + parsedArgs.summary
        }
      } else if (tc.function.name === "ask_user" && typeof parsedArgs.question === "string") {
        followUp = parsedArgs.question
        if (Array.isArray(parsedArgs.options) && parsedArgs.options.length) {
          followUp += `\nOptions: ${parsedArgs.options.join(", ")}`
        }
      }
    }

    const usage = response.usage
    return {
      content,
      files,
      followUp,
      tokensUsed: usage ? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) : undefined,
    }
  }

  private parseRawResponse(response: OpenAIChatResponse): RawGenerationResult {
    const choice = response.choices?.[0]
    const message = choice?.message
    const blocks: ContentBlock[] = []

    // Reasoning_content goes FIRST so the order matches what the
    // upstream returned (DeepSeek emits reasoning then content). The
    // agentic loop preserves block order when round-tripping.
    if (message?.reasoning_content) {
      blocks.push({ type: "reasoning", text: message.reasoning_content })
    }
    if (message?.content) {
      blocks.push({ type: "text", text: message.content })
    }
    for (const tc of message?.tool_calls || []) {
      let input: Record<string, unknown> = {}
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
      } catch {
        // Malformed JSON — surface as empty input rather than crashing the loop.
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input })
    }

    // Translate OpenAI finish_reason → Anthropic stop_reason vocabulary.
    let stop_reason: RawGenerationResult["stop_reason"] = "end_turn"
    switch (choice?.finish_reason) {
      case "tool_calls":
      case "function_call":
        stop_reason = "tool_use"
        break
      case "length":
        stop_reason = "max_tokens"
        break
      case "stop":
      case null:
      case undefined:
      default:
        stop_reason = "end_turn"
    }

    const usage = response.usage
    return {
      content: blocks,
      stop_reason,
      usage: {
        input_tokens: usage?.prompt_tokens || 0,
        output_tokens: usage?.completion_tokens || 0,
      },
    }
  }

  private legacyToolsAsOpenAI() {
    // ClaudeProvider passes Anthropic-shaped legacy tools; translate to OpenAI's
    // function-tool shape so generate() still surfaces create_files / ask_user.
    return getLegacyTools().map((t: any) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }
}
