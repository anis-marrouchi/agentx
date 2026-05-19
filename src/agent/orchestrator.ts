// --- Agentic Orchestrator: tool_result feedback loop ---

import type {
  AgentProvider,
  GenerationMessage,
  GeneratedFile,
  ProviderOptions,
  AnthropicMessage,
  ContentBlock,
  RawGenerationResult,
} from "./providers/types"
import { ToolExecutor, type ToolResult } from "./tools"
import { getAnthropicTools, formatToolsForSystemPrompt } from "./tools"
import { NOQTA_TOOLS, type NoqtaToolContext } from "./tools/noqta"
import { debug } from "@/observability"

export interface AgenticLoopOptions {
  provider: AgentProvider
  systemPrompt: string
  messages: GenerationMessage[]
  providerOptions: ProviderOptions
  cwd: string
  maxIterations?: number
  enabledTools?: string[]
  interactive?: boolean
  overwrite?: boolean
  dryRun?: boolean
  onProgress?: (event: AgenticProgressEvent) => void
  /** When set, the noqta workspace tool catalog (list_projects,
   *  create_task, …) becomes part of the agent's tool set and the
   *  executor dispatches calls via /api/agent/tools using the server-
   *  held bearer. The bearer NEVER enters the model's prompt context. */
  noqtaContext?: NoqtaToolContext
  /** Cancel signal. Forwarded into ProviderOptions so the provider's
   *  fetch() actually closes when the operator hits Stop. */
  abortSignal?: AbortSignal
}

export type AgenticProgressEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "tool_call"; name: string; id: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; id: string; content: string; is_error?: boolean }
  | { type: "text_delta"; text: string }
  // Thinking-mode chunk (DeepSeek V4 `reasoning_content` / OpenAI o-series).
  // Distinct from text_delta so consumers can render with a different style
  // and so the final response content stays clean.
  | { type: "thinking_delta"; text: string }
  | { type: "files_created"; files: GeneratedFile[] }
  | { type: "complete"; iterations: number; totalTokens: number }

export interface AgenticResult {
  files: GeneratedFile[]
  content: string
  followUp?: string
  tokensUsed: number
  /** Split input/output token counts when the provider supplies them.
   *  Kept separate from `tokensUsed` so callers that bill by direction
   *  (input vs output have very different per-1M costs) don't have to
   *  guess a 30/70 split. Undefined when the provider only reports a
   *  combined total (CLI tier, legacy loop). */
  inputTokens?: number
  outputTokens?: number
  iterations: number
}

/**
 * Run the agentic tool_result loop.
 * The LLM decides what tools to call (read files, search, edit, etc.)
 * and we feed results back until it signals completion.
 */
export async function runAgenticLoop(options: AgenticLoopOptions): Promise<AgenticResult> {
  const {
    provider,
    systemPrompt,
    messages: inputMessages,
    providerOptions: providerOptionsRaw,
    cwd,
    maxIterations = 20,
    enabledTools,
    interactive = true,
    overwrite = false,
    dryRun = false,
    onProgress,
    abortSignal,
  } = options
  // Fold the abort signal into ProviderOptions so each iteration's
  // provider call (fetch under the hood) gets it. Without this, an
  // operator Stop only flags the task in the registry — the in-flight
  // HTTP request to DeepSeek/OpenAI keeps running until the model
  // decides to finish, which has produced multi-hour hangs.
  const providerOptions: ProviderOptions = abortSignal
    ? { ...providerOptionsRaw, abortSignal }
    : providerOptionsRaw

  // Check if provider supports generateRaw
  if (!provider.generateRaw) {
    return runLegacyLoop(options)
  }

  const executor = new ToolExecutor(cwd, {
    interactive,
    overwrite,
    dryRun,
    noqtaContext: options.noqtaContext,
  })
  const tools = getAnthropicTools(enabledTools)
  // Append noqta workspace tools only when we have a noqta user context
  // to dispatch them against. Adding them otherwise would confuse the
  // model (it'd see tools it can't successfully invoke).
  if (options.noqtaContext) {
    for (const t of NOQTA_TOOLS) {
      tools.push({ name: t.name, description: t.description, input_schema: t.input_schema })
    }
  }

  // Convert GenerationMessage[] to AnthropicMessage[] (strip system messages)
  const anthropicMessages: AnthropicMessage[] = inputMessages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))

  const allFiles: GeneratedFile[] = []
  let totalTokens = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let textContent = ""
  let followUp: string | undefined
  let iteration = 0

  while (iteration < maxIterations) {
    iteration++
    // Operator-cancel check between iterations — bails before we
    // pay for another provider round-trip.
    if (abortSignal?.aborted) {
      throw new Error("cancelled")
    }
    onProgress?.({ type: "iteration_start", iteration })
    debug.step(iteration, `Agentic loop iteration (${tools.length} tools available)`)

    // Streaming path: when the provider supports generateRawStream AND a
    // caller is listening for progress events, pipe text deltas through
    // as they arrive (so voice/SSE clients see per-token output) and
    // still assemble the same RawGenerationResult the non-streaming
    // path produces. Tool detection then runs unchanged on result.content.
    //
    // The fallback (generateRaw, single-shot) is preserved for:
    //   - providers without generateRawStream (CLI, anything pre-stream)
    //   - non-streaming callers (no onProgress) — extra streaming
    //     ceremony would add latency and per-chunk parsing overhead
    //     for callers that don't need it (telegram, crons, mesh).
    let result: RawGenerationResult
    const useRawStream = !!provider.generateRawStream && !!onProgress
    try {
      if (useRawStream) {
        // We accumulate text per-block as it streams. The raw_result
        // event at the end carries the same blocks (with tool_use
        // inputs fully parsed) so the existing tool-dispatch branch
        // below operates on identical data to the non-streaming case.
        let streamedResult: RawGenerationResult | null = null
        let streamError: string | null = null
        let streamedTextThisIteration = ""
        for await (const ev of provider.generateRawStream!(
          anthropicMessages,
          systemPrompt,
          tools,
          providerOptions,
        )) {
          if (ev.type === "text_delta") {
            streamedTextThisIteration += ev.text
            // Emit per-chunk so the caller (daemon /chat handler ->
            // SSE writer) can push to the client right away. We do NOT
            // emit a duplicate text_delta from the result-block loop
            // below for streamed text (handled via the `streamedText`
            // guard on each text block).
            onProgress?.({ type: "text_delta", text: ev.text })
          } else if (ev.type === "thinking_delta") {
            // Forward the thinking chunk. It's not folded into
            // streamedTextThisIteration (or `content`) — the agent's
            // visible answer should stay clean — but the raw_result's
            // `reasoning` content block carries the full text for the
            // agentic round-trip.
            onProgress?.({ type: "thinking_delta", text: ev.text })
          } else if (ev.type === "raw_result") {
            streamedResult = ev.result
          } else if (ev.type === "error") {
            streamError = ev.error
          }
        }
        if (streamError && !streamedResult) {
          throw new Error(streamError)
        }
        if (!streamedResult) {
          throw new Error("generateRawStream returned no raw_result event")
        }
        result = streamedResult
        // Track the text we already streamed so the block-loop below
        // doesn't re-emit it as a duplicate text_delta event.
        ;(result as any)._streamedText = streamedTextThisIteration
      } else {
        result = await provider.generateRaw!(
          anthropicMessages,
          systemPrompt,
          tools,
          providerOptions,
        )
      }
    } catch (error: any) {
      // If generateRaw fails (e.g., OAuth mode), fall back to legacy
      if (error.message?.includes("not available")) {
        return runLegacyLoop(options)
      }
      throw error
    }

    totalTokens += result.usage.input_tokens + result.usage.output_tokens
    totalInputTokens += result.usage.input_tokens
    totalOutputTokens += result.usage.output_tokens

    // Collect text from response. In the streaming path we already
    // emitted per-chunk deltas above — only re-emit text from blocks
    // that came in AFTER our streamed accumulation (defensive: should
    // be zero, but a divergence wouldn't silently lose tokens).
    const streamedText: string | undefined = (result as any)._streamedText
    for (const block of result.content) {
      if (block.type === "text") {
        textContent += block.text
        if (streamedText === undefined) {
          // Non-streaming path — fire one text_delta per block as before.
          onProgress?.({ type: "text_delta", text: block.text })
        }
      }
    }
    if (streamedText !== undefined) delete (result as any)._streamedText

    // If stop_reason is end_turn or max_tokens, we're done
    if (result.stop_reason === "end_turn" || result.stop_reason === "max_tokens") {
      break
    }

    // If stop_reason is tool_use, execute the tools
    if (result.stop_reason === "tool_use") {
      const toolUseBlocks = result.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
      )

      if (toolUseBlocks.length === 0) break

      // Append assistant message with the tool_use blocks
      anthropicMessages.push({
        role: "assistant",
        content: result.content,
      })

      // Execute each tool and collect results
      const toolResults: ContentBlock[] = []

      for (const toolBlock of toolUseBlocks) {
        onProgress?.({
          type: "tool_call",
          name: toolBlock.name,
          id: toolBlock.id,
          input: toolBlock.input,
        })

        debug.step(iteration, `Tool call: ${toolBlock.name}`)

        const toolResult = await executor.execute({
          name: toolBlock.name,
          id: toolBlock.id,
          input: toolBlock.input,
        })

        onProgress?.({
          type: "tool_result",
          name: toolBlock.name,
          id: toolBlock.id,
          content: toolResult.content.slice(0, 200),
          is_error: toolResult.is_error,
        })

        // Collect files from create_files calls
        if (toolResult.files?.length) {
          allFiles.push(...toolResult.files)
          onProgress?.({ type: "files_created", files: toolResult.files })
        }

        // Handle ask_user — surface the question to caller
        if (toolResult.followUp) {
          followUp = toolResult.followUp
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolResult.tool_use_id,
          content: toolResult.content,
          is_error: toolResult.is_error,
        })
      }

      // Append user message with tool_result blocks
      anthropicMessages.push({
        role: "user",
        content: toolResults,
      })

      // If we got a follow-up question, break the loop to surface it
      if (followUp) break

      continue
    }

    // Unknown stop_reason — break
    break
  }

  onProgress?.({ type: "complete", iterations: iteration, totalTokens })

  return {
    files: allFiles,
    content: textContent,
    followUp,
    tokensUsed: totalTokens,
    inputTokens: totalInputTokens || undefined,
    outputTokens: totalOutputTokens || undefined,
    iterations: iteration,
  }
}

/**
 * Fallback to the legacy [CONTINUE]-based multi-step loop.
 * Used when provider doesn't support generateRaw() (CLI/OAuth mode).
 * For CLI mode, we include tool descriptions in the system prompt so the
 * `claude` binary uses its own built-in tools (read, write, bash, etc.).
 */
async function runLegacyLoop(options: AgenticLoopOptions): Promise<AgenticResult> {
  const {
    provider,
    systemPrompt,
    messages: inputMessages,
    providerOptions,
    maxIterations = 5,
  } = options

  // Enhance system prompt with tool descriptions for CLI mode
  const enhancedSystemPrompt = systemPrompt + "\n\n" + formatToolsForSystemPrompt()

  const messages: GenerationMessage[] = [
    { role: "system", content: enhancedSystemPrompt },
    ...inputMessages.filter((m) => m.role !== "system"),
  ]

  const allFiles: GeneratedFile[] = []
  let totalTokens = 0
  let content = ""
  let followUp: string | undefined
  let step = 0

  while (step < maxIterations) {
    step++
    debug.step(step, `Legacy loop step (model: ${providerOptions.model || "default"})`)

    const result = await provider.generate(messages, providerOptions)

    totalTokens += result.tokensUsed || 0
    content = result.content

    if (result.files.length) {
      allFiles.push(...result.files)
    }

    if (result.followUp) {
      followUp = result.followUp
      break
    }

    if (result.files.length === 0 && step > 1) break

    const wantsContinuation =
      result.content.includes("[CONTINUE]") ||
      result.content.includes("Next, I'll") ||
      result.content.includes("Now let me") ||
      result.content.includes("I'll also generate")

    if (!wantsContinuation) break

    const filesSummary = result.files
      .map((f) => `Created: ${f.path}${f.description ? ` — ${f.description}` : ""}`)
      .join("\n")

    messages.push({
      role: "assistant",
      content: result.content + (filesSummary ? `\n\nFiles created:\n${filesSummary}` : ""),
    })

    messages.push({
      role: "user",
      content:
        "Continue generating the remaining files. Build on what you've already created. When finished, do not include [CONTINUE] in your response.",
    })
  }

  return {
    files: allFiles,
    content,
    followUp,
    tokensUsed: totalTokens,
    iterations: step,
  }
}

/**
 * Check if a provider supports the agentic loop (has generateRaw).
 */
export function supportsAgenticLoop(provider: AgentProvider): boolean {
  return typeof provider.generateRaw === "function"
}
