import { execa } from "execa"
import { execFile, spawn } from "child_process"
import { friendlyModelError, renderFriendlyError } from "./error-map"
import type { AgentDef } from "@/daemon/config"

// --- Agent execution runtime ---
// Routes agent tasks to the correct execution tier:
// - claude-code: spawns claude CLI (subscription, full features)
// - sdk: uses Claude Agent SDK (API key, programmatic)
// - orchestrator: uses agentx's own agentic loop (any provider)

export interface AgentPeer {
  id: string
  name: string
  handle?: string       // e.g. "@my_bot"
  role?: string         // from systemPrompt, first line
}

export interface AgentTask {
  message: string
  agentId: string
  /** Correlator threaded by the workflow engine. When the engine dispatches
   *  an agent as part of a state transition, this carries the run id so
   *  post:response can re-enter the engine with an agentResult condition. */
  workflowRunId?: string
  /** Per-invocation model override (e.g. cron model). Falls back to agent.model. */
  model?: string
  /** Cacheable text delivered to Claude via --append-system-prompt. Typically
   *  agent.systemPrompt + SOUL/IDENTITY/AGENTS.md. Passing stable content
   *  here (instead of in the user-message body) keeps it inside Claude's
   *  cached system prompt across session resumes. */
  systemPromptAppend?: string
  /** Per-invocation override for the context assembly strategy. When unset,
   *  the registry falls back to config.session.contextStrategy. Set this
   *  from benchmark harnesses that want to A/B the same request under
   *  "layered" and "planner" without reloading daemon config. */
  contextStrategy?: "layered" | "planner"
  /** Upper bound on how long this task may run. Applied to mesh
   *  forwarding (as fetch timeout) and local execution when the runtime
   *  supports it. Workflow `agent` nodes pass this through from their
   *  config.timeoutMinutes. */
  timeoutMinutes?: number
  context?: {
    channel?: string
    sender?: string
    /** Platform user ID (e.g. Telegram user ID) */
    senderId?: string
    /** Platform username (e.g. @username) */
    senderUsername?: string
    group?: string
    /** Stable chat ID for session keying (e.g. "project:issue:123" for GitLab) */
    chatId?: string
    /** Attached media file (image, audio, video, document) */
    mediaPath?: string
    mediaType?: string
    /** Text of the message being replied to */
    replyToText?: string
    conversationHistory?: Array<{ role: string; content: string }>
    /** This agent's own handle on the current channel */
    myHandle?: string
    /** Other available agents and their handles */
    peers?: AgentPeer[]
    /** Verified channel metadata (from adapter) */
    channelMeta?: {
      agents?: Array<{ id: string; name: string; handle?: string }>
      project?: string
      issue?: { type: string; iid: string; title: string }
      facts?: string[]
    }
  }
}

export interface AgentResponse {
  content: string
  error?: string
  tokensUsed?: number
  duration?: number
  claudeSessionId?: string
  usage?: TokenUsage  // Real token counts from Claude's JSON output
  /** The model Claude actually billed for (from the CLI's init event). When
   *  absent, cost reporting should fall back to the model override / agent
   *  config. Knowing the billed model is what makes cache-aware pricing
   *  trustworthy — a task that ran sonnet but was logged as opus would
   *  overstate cost by ~5×. */
  billedModel?: string
  /** Set when the task was forwarded to a mesh peer that hosted the
   *  requested agent (the local registry didn't have it). Name of the
   *  peer that actually ran it. */
  viaMesh?: string
}

/** Callback for streaming text deltas */
export type StreamCallback = (delta: string, fullText: string) => void

/**
 * Build the prompt from agent config + task context + conversation history.
 */
function buildPrompt(agent: AgentDef, task: AgentTask, historyContext?: string): string {
  const parts: string[] = []

  // NOTE: agent.systemPrompt is no longer injected into the user-message body —
  // it's now delivered via `--append-system-prompt` so Claude's prompt cache
  // retains it across turns instead of us paying cache-create for it on every
  // new session. If a per-task override is needed, use task.context.systemPrompt
  // (which buildClaudeArgs also forwards to --append-system-prompt).

  // Inject environment context — skip if historyContext is provided (context engine handles it)
  if (task.context && !historyContext) {
    const ctx = task.context
    const envLines: string[] = ["", "[Environment]"]
    const isGitLab = ctx.channel === "gitlab" || ctx.channel?.startsWith("webhook:")
    const isTelegram = ctx.channel === "telegram"

    if (ctx.channel) envLines.push(`Channel: ${ctx.channel}`)
    if (ctx.group) envLines.push(`Group: ${ctx.group}`)
    if (ctx.sender) envLines.push(`Message from: ${ctx.sender}`)
    if (ctx.myHandle) envLines.push(`Your handle on this channel: ${ctx.myHandle}`)

    if (isGitLab) {
      envLines.push("")
      envLines.push("[IMPORTANT: You are responding to a GitLab comment/event]")
      envLines.push("- Keep it short — 3-5 lines for the main message. Humans scan, not read")
      envLines.push("- Lead with the result or action, not a narration of what you plan to do")
      envLines.push("- Use <details><summary>Details</summary>\\n\\ncontent\\n</details> for verbose output (logs, full commands, step-by-step)")
      envLines.push("- Do NOT mention Telegram handles — they don't work on GitLab")
      envLines.push("- Do NOT try to delegate to other agents — reply directly")
      envLines.push("- Reference issues with #IID and MRs with !IID")
    }

    if (isTelegram && ctx.peers?.length) {
      envLines.push("")
      envLines.push("[Team — other agents you can mention to delegate or collaborate]")
      for (const peer of ctx.peers) {
        const handle = peer.handle ? ` (mention: ${peer.handle})` : ""
        const role = peer.role ? ` — ${peer.role}` : ""
        envLines.push(`• ${peer.name}${handle}${role}`)
      }
      envLines.push("")
      envLines.push("To involve another agent, mention their handle in your response and they will automatically see it and reply.")
    }

    parts.push(envLines.join("\n"))
  }

  // Reply-to context (when user replies to a specific message)
  if (task.context?.replyToText) {
    parts.push("")
    parts.push(`[Replying to]: ${task.context.replyToText}`)
  }

  // Attached media
  if (task.context?.mediaPath) {
    parts.push("")
    parts.push(`[Attached file: ${task.context.mediaPath}]`)
    parts.push(`[File type: ${task.context.mediaType || "unknown"}]`)
    if (task.context.mediaType?.startsWith("image/")) {
      parts.push("Please read/view this image file and describe or respond to it.")
    } else if (task.context.mediaType?.startsWith("audio/")) {
      parts.push("Please transcribe this audio file and respond to its content.")
    } else if (task.context.mediaType?.startsWith("video/")) {
      parts.push("A video file is attached. Describe what you can determine about it.")
    } else {
      parts.push("Please read this file and respond based on its content.")
    }
  }

  // Inject conversation history for session continuity
  if (historyContext) {
    parts.push("")
    parts.push(historyContext)
  }

  parts.push("")
  parts.push(task.message)

  return parts.join("\n")
}

/**
 * Build CLI args for claude command.
 */
function buildClaudeArgs(
  agent: AgentDef,
  prompt: string,
  streaming: boolean,
  resumeSessionId?: string,
  modelOverride?: string,
  /** Static per-agent preamble delivered via --append-system-prompt. Content
   *  here is Claude-cached across turns as part of the system prompt, so
   *  moving stable content (agent.systemPrompt + SOUL/IDENTITY/AGENTS.md) out
   *  of the user-message body and into this arg avoids paying cache-create
   *  for it on every new session. */
  systemPromptAppend?: string,
): string[] {
  const args: string[] = [
    "-p", prompt,
    "--output-format", streaming ? "stream-json" : "json",
  ]

  // stream-json requires --verbose in recent Claude Code versions
  if (streaming) {
    args.push("--verbose")
  }

  // Resume existing Claude session for conversation continuity
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId)
  }

  const model = modelOverride || agent.model
  if (model) {
    args.push("--model", model)
  }

  if (agent.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions")
  }

  if (systemPromptAppend && systemPromptAppend.trim().length > 0) {
    args.push("--append-system-prompt", systemPromptAppend)
  }

  return args
}

/**
 * Parse JSON output from `claude -p --output-format json`.
 * Returns the text result and session_id.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
}

/**
 * When the Claude Code CLI returns exit=0 but the run itself errored (e.g.
 * out-of-credits mid-session), it emits a top-level JSON object with
 * `is_error: true` and the raw API error in `result`. Detect + extract so we
 * can run the same friendly-error translator we use for stderr.
 * Returns null when the output is a normal success.
 */
function extractClaudeIsError(stdout: string): string | null {
  try {
    const data = JSON.parse(stdout)
    if (data && data.is_error && typeof data.result === "string") return data.result
    if (data && data.error && typeof data.error === "string") return data.error
  } catch { /* not JSON — fall through */ }
  return null
}

function parseClaudeJsonOutput(stdout: string): { text: string; sessionId?: string; usage?: TokenUsage; billedModel?: string } {
  try {
    const data = JSON.parse(stdout)
    const usage = data.usage ? {
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
      cacheReadTokens: data.usage.cache_read_input_tokens || 0,
      cacheCreateTokens: data.usage.cache_creation_input_tokens || 0,
    } : undefined

    // Claude Code's --output-format json response carries the actual billed
    // model at `model` (or nested under `message.model` depending on CLI ver).
    const billedModel: string | undefined =
      (typeof data.model === "string" && data.model) ||
      (typeof data.message?.model === "string" && data.message.model) ||
      undefined

    return {
      text: data.result || data.content || "",
      sessionId: data.session_id,
      usage,
      billedModel,
    }
  } catch {
    return { text: stdout }
  }
}

/**
 * Execute a task using the Claude Code CLI (tier: "claude-code").
 * Non-streaming — waits for full response.
 */
export async function executeClaudeCode(
  agent: AgentDef,
  task: AgentTask,
  historyContext?: string,
  resumeSessionId?: string,
): Promise<AgentResponse> {
  const start = Date.now()
  // Always inject context (landscape, rules, channel info) even on resume.
  // Claude CLI --resume carries its own conversation history, but the
  // landscape + rules must be fresh so the agent sees capability updates.
  const prompt = buildPrompt(agent, task, historyContext)
  const args = buildClaudeArgs(agent, prompt, false, resumeSessionId, task.model, task.systemPromptAppend)

  try {
    const timeoutMs = Math.max(60_000, (agent.maxExecutionMinutes ?? 20) * 60_000)
    const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const proc = execFile("claude", args, {
        cwd: agent.workspace,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || "/home/" + (process.env.USER || "user") },
      }, (error, stdout, stderr) => {
        // Always resolve — we handle errors ourselves based on stdout/stderr
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: error ? (error as any).code ?? 1 : 0,
        })
      })
      // Close stdin immediately. Claude CLI otherwise waits 3s for input then
      // proceeds with a warning; in cron retries that cascade invalidates the
      // prompt cache between attempts (5× input cost on cache-create).
      proc.stdin?.end()
    })

    if (!stdout && exitCode !== 0) {
      // exit 143 = 128+SIGTERM → our own `timeout` killed the process. Surface
      // that as a recognizable "timed out after Xm" message so operators can
      // bump agent.maxExecutionMinutes instead of guessing at an opaque 143.
      let errMsg: string
      if (exitCode === 143) {
        errMsg = `Claude Code timed out after ${Math.round(timeoutMs / 60_000)}m (SIGTERM). Bump agent.maxExecutionMinutes for "${agent.name || "this agent"}" if tasks need longer.`
      } else {
        errMsg = stderr?.trim() || `Claude Code exited with code ${exitCode}`
      }
      return {
        content: "",
        error: renderFriendlyError(friendlyModelError(errMsg)),
        duration: Date.now() - start,
      }
    }

    // Claude Code sometimes exits 0 but embeds the API error in stdout's
    // "result" field when `is_error` is set. Translate that too.
    const apiErrorInStdout = extractClaudeIsError(stdout)
    if (apiErrorInStdout) {
      return {
        content: "",
        error: renderFriendlyError(friendlyModelError(apiErrorInStdout)),
        duration: Date.now() - start,
      }
    }

    const parsed = parseClaudeJsonOutput(stdout)

    return {
      content: parsed.text,
      duration: Date.now() - start,
      claudeSessionId: parsed.sessionId,
      usage: parsed.usage,
      billedModel: parsed.billedModel,
    }
  } catch (error: any) {
    console.error(`[runtime] execFile threw: ${error.message}`)
    return {
      content: "",
      error: error.message || "Claude Code failed",
      duration: Date.now() - start,
    }
  }
}

/**
 * Execute with streaming — calls onDelta with text chunks as they arrive.
 * Uses claude --output-format stream-json to get real-time output.
 */
export async function executeClaudeCodeStreaming(
  agent: AgentDef,
  task: AgentTask,
  onDelta: StreamCallback,
  historyContext?: string,
  resumeSessionId?: string,
  onEvent?: (event: any) => void,
): Promise<AgentResponse> {
  const start = Date.now()
  // Always inject context (landscape, rules, channel info) even on resume.
  // Claude CLI --resume carries its own conversation history, but the
  // landscape + rules must be fresh so the agent sees capability updates.
  const prompt = buildPrompt(agent, task, historyContext)
  const args = buildClaudeArgs(agent, prompt, true, resumeSessionId, task.model, task.systemPromptAppend)

  let fullText = ""
  // Capture model + usage + session id from the stream events — Claude Code
  // emits a system-init event up front (with the billed model) and a terminal
  // result event with the full usage accounting. Without these we can't
  // attribute cost correctly for streamed tasks.
  let streamBilledModel: string | undefined
  let streamUsage: TokenUsage | undefined
  let streamSessionId: string | undefined
  /** If the terminal `result` event carries is_error, we stash it here and
   *  surface the translated message instead of treating `result` as agent text. */
  let streamApiError: string | undefined

  try {
    const streamTimeoutMs = Math.max(60_000, (agent.maxExecutionMinutes ?? 20) * 60_000)
    const proc = execa("claude", args, {
      cwd: agent.workspace,
      timeout: streamTimeoutMs,
      reject: false,
      env: process.env,
      // Don't buffer — we'll read stdout line by line
      buffer: false,
      // Close stdin so Claude CLI doesn't wait 3s for input (see executeClaudeCode).
      stdin: "ignore",
    })

    // Parse stream-json output line by line
    if (proc.stdout) {
      let lineBuffer = ""

      proc.stdout.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString()
        const lines = lineBuffer.split("\n")
        lineBuffer = lines.pop() || ""

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)

            // Surface every parsed event for observability (dashboard streaming).
            // Best-effort — never let a subscriber crash the runtime.
            if (onEvent) {
              try { onEvent(event) } catch { /* */ }
            }

            // Claude stream-json emits different event types
            // "assistant" messages with content contain the text
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  const delta = block.text.slice(fullText.length)
                  if (delta) {
                    fullText = block.text
                    onDelta(delta, fullText)
                  }
                }
              }
            }

            // "content_block_delta" for streaming text
            if (event.type === "content_block_delta" && event.delta?.text) {
              fullText += event.delta.text
              onDelta(event.delta.text, fullText)
            }

            // "result" event contains final text (or an API error, when is_error).
            if (event.type === "result" && event.result) {
              if (event.is_error && typeof event.result === "string") {
                streamApiError = event.result
              } else {
                const resultText = typeof event.result === "string"
                  ? event.result
                  : event.result
                if (typeof resultText === "string" && resultText.length > fullText.length) {
                  const delta = resultText.slice(fullText.length)
                  fullText = resultText
                  if (delta) onDelta(delta, fullText)
                }
              }
              // Final event also carries the authoritative usage + model + session.
              if (event.usage) {
                streamUsage = {
                  inputTokens: event.usage.input_tokens || 0,
                  outputTokens: event.usage.output_tokens || 0,
                  cacheReadTokens: event.usage.cache_read_input_tokens || 0,
                  cacheCreateTokens: event.usage.cache_creation_input_tokens || 0,
                }
              }
              if (typeof event.model === "string") streamBilledModel = event.model
              if (typeof event.session_id === "string") streamSessionId = event.session_id
            }

            // System-init event (first thing the CLI emits) carries the model
            // it's about to invoke — capture early so we have it even if the
            // run errors before the terminal result.
            if (event.type === "system" && event.subtype === "init") {
              if (typeof event.model === "string") streamBilledModel = event.model
              if (typeof event.session_id === "string") streamSessionId = event.session_id
            }
          } catch {
            // Not JSON — could be raw text output, append it
            if (line.trim() && !line.startsWith("{")) {
              fullText += line + "\n"
              onDelta(line + "\n", fullText)
            }
          }
        }
      })
    }

    const result = await proc

    // If we got no streaming content, fall back to stdout
    if (!fullText && result.stdout) {
      fullText = typeof result.stdout === "string" ? result.stdout : ""
    }

    if (result.exitCode !== 0 && !fullText) {
      const stderr = typeof result.stderr === "string" ? result.stderr : ""
      // execa sets exitCode=undefined when the child is killed by signal —
      // surface that as a recognizable timeout message instead of leaking
      // "exited with code undefined" into the user's chat. Mirrors the
      // non-streaming path's exit-143 handling.
      const r = result as { exitCode?: number; signal?: string; timedOut?: boolean }
      let errMsg: string
      if (r.timedOut) {
        errMsg = `Claude Code timed out after ${Math.round(streamTimeoutMs / 60_000)}m. Bump agent.maxExecutionMinutes for "${agent.name || "this agent"}" if tasks need longer.`
      } else if (r.signal) {
        errMsg = stderr.trim() || `Claude Code killed by signal ${r.signal}`
      } else {
        errMsg = stderr.trim() || `Claude Code exited with code ${r.exitCode ?? "unknown"}`
      }
      return {
        content: "",
        error: renderFriendlyError(friendlyModelError(errMsg)),
        duration: Date.now() - start,
      }
    }

    if (streamApiError) {
      return {
        content: "",
        error: renderFriendlyError(friendlyModelError(streamApiError)),
        duration: Date.now() - start,
        usage: streamUsage,
        billedModel: streamBilledModel,
        claudeSessionId: streamSessionId,
      }
    }

    return {
      content: fullText,
      duration: Date.now() - start,
      usage: streamUsage,
      billedModel: streamBilledModel,
      claudeSessionId: streamSessionId,
    }
  } catch (error: any) {
    return {
      content: fullText || "",
      error: renderFriendlyError(friendlyModelError(error.message)),
      duration: Date.now() - start,
      usage: streamUsage,
      billedModel: streamBilledModel,
      claudeSessionId: streamSessionId,
    }
  }
}

/**
 * Execute a task using the Claude Agent SDK (tier: "sdk").
 */
export async function executeSdk(
  agent: AgentDef,
  task: AgentTask,
  apiKey: string,
  historyContext?: string,
): Promise<AgentResponse> {
  const start = Date.now()

  try {
    // @ts-ignore — SDK may not be installed
    const sdk = await import("@anthropic-ai/claude-agent-sdk")
    const { query } = sdk

    // Build prompt with full context (landscape, memory, patterns, etc.)
    const prompt = buildPrompt(agent, task, historyContext)

    let content = ""

    const q = query({
      prompt,
      options: {
        model: task.model || agent.model,
        cwd: agent.workspace,
        permissionMode: "bypassPermissions" as any,
      },
    })

    for await (const message of q) {
      if (message.type === "result" && message.subtype === "success") {
        content = message.result || ""
      }
    }

    return {
      content,
      duration: Date.now() - start,
    }
  } catch (error: any) {
    return {
      content: "",
      error: `SDK error: ${error.message}`,
      duration: Date.now() - start,
    }
  }
}

/**
 * Execute a task using agentx's own orchestrator (tier: "orchestrator").
 */
export async function executeOrchestrator(
  agent: AgentDef,
  task: AgentTask,
  apiKey?: string,
  historyContext?: string,
): Promise<AgentResponse> {
  const start = Date.now()

  try {
    const { generate } = await import("@/agent")
    const providerName = agent.provider || "claude-code"

    // Build full prompt with context (landscape, memory, patterns, etc.)
    const fullTask = historyContext
      ? `${historyContext}\n\n${task.message}`
      : task.message

    const result = await generate({
      task: fullTask,
      cwd: agent.workspace,
      provider: providerName as any,
      model: task.model || agent.model,
      apiKey,
      overwrite: true,
      interactive: false,
      context7: false,
    })

    return {
      content: result.content || "Done.",
      tokensUsed: result.tokensUsed,
      duration: Date.now() - start,
    }
  } catch (error: any) {
    return {
      content: "",
      error: `Orchestrator error: ${error.message}`,
      duration: Date.now() - start,
    }
  }
}

/**
 * Route a task to the correct execution tier.
 */
export async function executeTask(
  agent: AgentDef,
  task: AgentTask,
  providers: Record<string, { apiKey?: string }>,
  onDelta?: StreamCallback,
  historyContext?: string,
  resumeSessionId?: string,
  onEvent?: (event: any) => void,
): Promise<AgentResponse> {
  switch (agent.tier) {
    case "claude-code":
      if (onDelta) {
        return executeClaudeCodeStreaming(agent, task, onDelta, historyContext, resumeSessionId, onEvent)
      }
      return executeClaudeCode(agent, task, historyContext, resumeSessionId)

    case "sdk": {
      const providerName = agent.provider || "claude"
      const apiKey = providers[providerName]?.apiKey
      if (!apiKey) {
        return {
          content: "",
          error: `No API key for provider "${providerName}". Configure providers.${providerName}.apiKey`,
        }
      }
      return executeSdk(agent, task, apiKey, historyContext)
    }

    case "orchestrator": {
      const providerName = agent.provider || "claude-code"
      const apiKey = providers[providerName]?.apiKey
      return executeOrchestrator(agent, task, apiKey, historyContext)
    }

    default:
      return {
        content: "",
        error: `Unknown tier: ${agent.tier}`,
      }
  }
}
