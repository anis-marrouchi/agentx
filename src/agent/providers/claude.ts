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
import { resolveToken } from "@/utils/auth-store"
import { getLegacyTools } from "../tools/definitions"

// --- Claude provider (default) using Anthropic SDK ---

const DEFAULT_MODEL = "claude-sonnet-4-20250514"
const DEFAULT_MAX_TOKENS = 8192
// Min tokens for Anthropic prompt-cache eligibility (varies by model:
// 1024 Haiku / 2048 Sonnet / 4096 Opus). Below threshold the API
// silently skips caching. We wrap unconditionally — cheap when it
// doesn't fit, big win when it does. Voice/text on noqta-public have
// 40K-token system prompts so caching always kicks in there.
const CACHE_MIN_CHARS = 4 * 1024 // ~1k tokens at 4 char/tok

/**
 * Wrap a system-prompt string in an Anthropic structured-block array
 * with `cache_control: { type: "ephemeral" }`. Returns a plain string
 * when the prompt is too short to be cache-eligible (saves a request-
 * shape change that wouldn't help). Cache TTL is the default 5 minutes;
 * suitable for back-to-back chat turns within a session.
 */
function wrapSystemForCache(systemPrompt: string): unknown {
  if (!systemPrompt || systemPrompt.length < CACHE_MIN_CHARS) {
    return systemPrompt
  }
  return [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ]
}

interface AnthropicResponse {
  id: string
  content: Array<{
    type: "text" | "tool_use" | "tool_result"
    text?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
    tool_use_id?: string
    content?: string
  }>
  model: string
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}

export class ClaudeProvider implements AgentProvider {
  name = "claude"
  private apiKey: string
  private authType: "api-key" | "oauth" = "api-key"

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || ""
    if (!this.apiKey) {
      // Fallback to auth store
      const resolved = resolveToken()
      if (resolved) {
        this.apiKey = resolved.token
        this.authType = resolved.authType
      }
    }
    if (!this.apiKey) {
      throw new Error(
        "Anthropic API key required. Run `agentx model` to configure, set ANTHROPIC_API_KEY, or pass --api-key."
      )
    }
  }

  async generate(
    messages: GenerationMessage[],
    options?: ProviderOptions
  ): Promise<GenerationResult> {
    const model = options?.model || DEFAULT_MODEL
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS

    // Extract system message
    const systemMsg = messages.find((m) => m.role === "system")
    const conversationMsgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: conversationMsgs,
      tools: getLegacyTools(),
    }

    if (systemMsg) {
      body.system = wrapSystemForCache(systemMsg.content)
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature
    }

    const response = await this.callApi(body)

    return this.parseResponse(response)
  }

  async generateRaw(
    messages: AnthropicMessage[],
    systemPrompt: string,
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    options?: ProviderOptions
  ): Promise<RawGenerationResult> {
    const model = options?.model || DEFAULT_MODEL
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: wrapSystemForCache(systemPrompt),
      messages,
      tools,
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature
    }

    const response = await this.callApi(body)

    // Map response content blocks to our ContentBlock type
    const content: ContentBlock[] = response.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text || "" }
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use" as const,
          id: block.id || "",
          name: block.name || "",
          input: block.input || {},
        }
      }
      return { type: "text" as const, text: "" }
    })

    return {
      content,
      stop_reason: response.stop_reason as RawGenerationResult["stop_reason"],
      usage: response.usage,
    }
  }

  async *stream(
    messages: GenerationMessage[],
    options?: ProviderOptions
  ): AsyncIterable<StreamEvent> {
    const model = options?.model || DEFAULT_MODEL
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS

    const systemMsg = messages.find((m) => m.role === "system")
    const conversationMsgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: conversationMsgs,
      stream: true,
      tools: getLegacyTools(),
    }

    if (systemMsg) {
      body.system = wrapSystemForCache(systemMsg.content)
    }

    const headers = this.buildHeaders()

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text()
      yield { type: "error", error: `Anthropic API error (${res.status}): ${errorText}` }
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      yield { type: "error", error: "No response body" }
      return
    }

    const decoder = new TextDecoder()
    let buffer = ""
    const files: GeneratedFile[] = []
    let content = ""
    let followUp: string | undefined
    let tokensUsed = 0
    let activeTool: { name: string; id: string; json: string } | null = null

    const inferFollowUpFromText = (text: string): string | undefined => {
      const cleaned = (text || "").trim()
      if (!cleaned) return undefined
      if (cleaned.includes("```")) return undefined

      const lines = cleaned.replace(/\r\n/g, "\n").split("\n")
      const tail = lines.slice(Math.max(0, lines.length - 20))
      const tailText = tail.join("\n")

      const looksLikePlanApproval =
        /\b(plan|proposal)\b/i.test(tailText) &&
        /(ready for your review|review (the )?plan|requesting plan approval|awaiting approval|waiting for (your )?approval|approve (the )?plan|approval to proceed)/i.test(
          tailText
        )

      if (looksLikePlanApproval) {
        return (
          "The provider is requesting plan approval.\n" +
          "Reply with:\n" +
          "- approve\n" +
          "- revise: <what to change>\n" +
          "- cancel"
        )
      }

      const isIntro = (l: string) =>
        /^(question|clarification|clarify|i need|need more|before i proceed|to proceed|please (confirm|clarify)|which|what|where|when|how|do you)/i.test(
          l.trim()
        )

      let startIdx = -1
      for (let i = tail.length - 1; i >= 0; i--) {
        const l = tail[i].trim()
        if (!l) continue
        if (isIntro(l) || l.includes("?")) {
          startIdx = i
          break
        }
      }
      if (startIdx === -1) return undefined

      const out: string[] = []
      for (let i = startIdx; i < tail.length && out.length < 8; i++) {
        const l = tail[i]
        const t = l.trim()
        if (out.length > 0 && !t) break
        if (
          out.length > 0 &&
          !/^(options?:|[-*]\s|\d+[\).]\s)/i.test(t) &&
          !t.includes("?")
        ) {
          break
        }
        out.push(l.trimEnd())
      }

      const candidate = out.join("\n").trim()
      if (candidate.length < 5) return undefined
      if (candidate.length > 800) return candidate.slice(0, 800).trimEnd()
      return candidate
    }

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

          try {
            const event = JSON.parse(data)

            if (event.type === "content_block_start") {
              if (event.content_block?.type === "tool_use") {
                // Finalize any previous tool block if the stream didn't send a stop.
                if (activeTool) {
                  yield { type: "tool_use_end", name: activeTool.name }
                  try {
                    const input = JSON.parse(activeTool.json || "{}") as any
                    if (activeTool.name === "create_files" && input) {
                      if (Array.isArray(input.files)) {
                        files.push(...(input.files as GeneratedFile[]))
                      }
                      if (typeof input.summary === "string" && input.summary.trim()) {
                        content += `\n${input.summary}`
                      }
                    }
                    if (activeTool.name === "ask_user" && input) {
                      if (typeof input.question === "string" && input.question.trim()) {
                        followUp = input.question
                        if (Array.isArray(input.options) && input.options.length) {
                          followUp += `\nOptions: ${input.options.join(", ")}`
                        }
                      }
                    }
                  } catch {
                    // Ignore invalid tool JSON
                  } finally {
                    activeTool = null
                  }
                }

                activeTool = {
                  name: event.content_block.name,
                  id: event.content_block.id,
                  json: "",
                }
                yield {
                  type: "tool_use_start",
                  name: event.content_block.name,
                  id: event.content_block.id,
                }
              }
            }

            if (event.type === "content_block_delta") {
              if (event.delta?.type === "text_delta") {
                content += event.delta.text
                yield { type: "text_delta", text: event.delta.text }
              }
              if (event.delta?.type === "input_json_delta") {
                if (activeTool) activeTool.json += event.delta.partial_json || ""
                yield { type: "tool_use_delta", json: event.delta.partial_json }
              }
            }

            if (event.type === "content_block_stop") {
              // Tool use blocks are complete
              if (activeTool) {
                // Manually inline finalize to avoid generator gymnastics.
                yield { type: "tool_use_end", name: activeTool.name }
                try {
                  const input = JSON.parse(activeTool.json || "{}") as any
                  if (activeTool.name === "create_files" && input) {
                    if (Array.isArray(input.files)) {
                      files.push(...(input.files as GeneratedFile[]))
                    }
                    if (typeof input.summary === "string" && input.summary.trim()) {
                      content += `\n${input.summary}`
                    }
                  }
                  if (activeTool.name === "ask_user" && input) {
                    if (typeof input.question === "string" && input.question.trim()) {
                      followUp = input.question
                      if (Array.isArray(input.options) && input.options.length) {
                        followUp += `\nOptions: ${input.options.join(", ")}`
                      }
                    }
                  }
                } catch {
                  // Ignore invalid tool JSON
                } finally {
                  activeTool = null
                }
              }
            }

            if (event.type === "message_delta") {
              if (event.usage) {
                tokensUsed = (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0)
              }
            }

            if (event.type === "message_stop") {
              // Message complete
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Flush any trailing tool input.
    if (activeTool) {
      yield { type: "tool_use_end", name: activeTool.name }
      try {
        const input = JSON.parse(activeTool.json || "{}") as any
        if (activeTool.name === "create_files" && input) {
          if (Array.isArray(input.files)) {
            files.push(...(input.files as GeneratedFile[]))
          }
          if (typeof input.summary === "string" && input.summary.trim()) {
            content += `\n${input.summary}`
          }
        }
        if (activeTool.name === "ask_user" && input) {
          if (typeof input.question === "string" && input.question.trim()) {
            followUp = input.question
            if (Array.isArray(input.options) && input.options.length) {
              followUp += `\nOptions: ${input.options.join(", ")}`
            }
          }
        }
      } catch {
        // Ignore
      }
      activeTool = null
    }

    if (!followUp && files.length === 0) {
      followUp = inferFollowUpFromText(content)
    }

    yield {
      type: "done",
      result: { content, files, followUp, tokensUsed },
    }
  }

  /**
   * Streaming variant of generateRaw — yields text_delta events per
   * chunk so callers can pipe per-token to a UI, AND assembles the full
   * RawGenerationResult (with tool_use blocks intact, stop_reason set)
   * so the agentic loop's tool dispatch keeps working unchanged.
   *
   * Implementation mirrors stream() but:
   *   - Targets generateRaw's signature (anthropicMessages + systemPrompt +
   *     tools as parameters, not interleaved messages).
   *   - Builds a ContentBlock[] with both text and tool_use blocks in the
   *     order they arrived, so the agentic loop's `result.content.filter(
   *     b => b.type === "tool_use")` still finds them.
   *   - Yields one terminal `raw_result` event the loop consumes.
   */
  async *generateRawStream(
    messages: AnthropicMessage[],
    systemPrompt: string,
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    options?: ProviderOptions,
  ): AsyncIterable<RawStreamEvent> {
    const model = options?.model || DEFAULT_MODEL
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: wrapSystemForCache(systemPrompt),
      messages,
      tools,
      stream: true,
    }
    if (options?.temperature !== undefined) body.temperature = options.temperature

    const headers = this.buildHeaders()
    let res: Response
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
    } catch (err: any) {
      yield { type: "error", error: `Anthropic stream init failed: ${err?.message ?? err}` }
      return
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      yield { type: "error", error: `Anthropic API error (${res.status}): ${errText.slice(0, 500)}` }
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      yield { type: "error", error: "No response body on Anthropic stream" }
      return
    }

    const decoder = new TextDecoder()
    let buffer = ""
    const blocks: ContentBlock[] = []
    let activeBlockIdx: number | null = null
    let stopReason: RawGenerationResult["stop_reason"] = "end_turn"
    let inputTokens = 0
    let outputTokens = 0

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
          if (!data || data === "[DONE]") continue

          let event: any
          try { event = JSON.parse(data) } catch { continue }

          if (event.type === "message_start" && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0
          }

          if (event.type === "content_block_start") {
            const cb = event.content_block
            if (cb?.type === "text") {
              activeBlockIdx = blocks.length
              blocks.push({ type: "text", text: "" })
            } else if (cb?.type === "tool_use") {
              activeBlockIdx = blocks.length
              blocks.push({
                type: "tool_use",
                id: cb.id || "",
                name: cb.name || "",
                input: {},
              })
              // We'll accumulate the input JSON across input_json_delta
              // events and parse once content_block_stop fires.
              ;(blocks[activeBlockIdx] as any)._rawJson = ""
            } else {
              activeBlockIdx = null
            }
          }

          if (event.type === "content_block_delta" && activeBlockIdx != null) {
            const block = blocks[activeBlockIdx]
            if (event.delta?.type === "text_delta" && block.type === "text") {
              block.text += event.delta.text
              yield { type: "text_delta", text: event.delta.text }
            } else if (event.delta?.type === "input_json_delta" && block.type === "tool_use") {
              ;(block as any)._rawJson += event.delta.partial_json || ""
            }
          }

          if (event.type === "content_block_stop" && activeBlockIdx != null) {
            const block = blocks[activeBlockIdx]
            if (block.type === "tool_use") {
              const raw = (block as any)._rawJson || "{}"
              try {
                block.input = JSON.parse(raw) as Record<string, unknown>
              } catch {
                block.input = {}
              }
              delete (block as any)._rawJson
            }
            activeBlockIdx = null
          }

          if (event.type === "message_delta") {
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason as RawGenerationResult["stop_reason"]
            }
            if (event.usage) {
              outputTokens = event.usage.output_tokens || 0
            }
          }
        }
      }
    } catch (err: any) {
      yield { type: "error", error: `Anthropic stream read failed: ${err?.message ?? err}` }
      return
    } finally {
      reader.releaseLock()
    }

    yield {
      type: "raw_result",
      result: {
        content: blocks,
        stop_reason: stopReason,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    }

    if (this.authType === "oauth") {
      headers["Authorization"] = `Bearer ${this.apiKey}`
      headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20"
      headers["user-agent"] = "claude-cli/2.1.2 (external, cli)"
      headers["x-app"] = "cli"
      headers["anthropic-dangerous-direct-browser-access"] = "true"
    } else {
      headers["x-api-key"] = this.apiKey
    }

    return headers
  }

  private async callApi(body: Record<string, unknown>): Promise<AnthropicResponse> {
    const headers = this.buildHeaders()

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(`Anthropic API error (${res.status}): ${errorText}`)
    }

    return (await res.json()) as AnthropicResponse
  }

  private parseResponse(response: AnthropicResponse): GenerationResult {
    const files: GeneratedFile[] = []
    let content = ""
    let followUp: string | undefined

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text || ""
      }

      if (block.type === "tool_use") {
        if (block.name === "create_files" && block.input) {
          const input = block.input as {
            files: GeneratedFile[]
            summary?: string
          }
          files.push(...(input.files || []))
          if (input.summary) {
            content += `\n${input.summary}`
          }
        }

        if (block.name === "ask_user" && block.input) {
          const input = block.input as { question: string; options?: string[] }
          followUp = input.question
          if (input.options?.length) {
            followUp += `\nOptions: ${input.options.join(", ")}`
          }
        }
      }
    }

    return {
      content,
      files,
      followUp,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    }
  }
}
