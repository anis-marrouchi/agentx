import { execa } from "execa"
import { execFile, spawn } from "child_process"
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
}

/** Callback for streaming text deltas */
export type StreamCallback = (delta: string, fullText: string) => void

/**
 * Build the prompt from agent config + task context + conversation history.
 */
function buildPrompt(agent: AgentDef, task: AgentTask, historyContext?: string): string {
  const parts: string[] = []

  if (agent.systemPrompt) {
    parts.push(agent.systemPrompt)
  }

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

  if (agent.model) {
    args.push("--model", agent.model)
  }

  if (agent.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions")
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

function parseClaudeJsonOutput(stdout: string): { text: string; sessionId?: string; usage?: TokenUsage } {
  try {
    const data = JSON.parse(stdout)
    const usage = data.usage ? {
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
      cacheReadTokens: data.usage.cache_read_input_tokens || 0,
      cacheCreateTokens: data.usage.cache_creation_input_tokens || 0,
    } : undefined

    return {
      text: data.result || data.content || "",
      sessionId: data.session_id,
      usage,
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
  const prompt = buildPrompt(agent, task, resumeSessionId ? undefined : historyContext)
  const args = buildClaudeArgs(agent, prompt, false, resumeSessionId)

  try {
    const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const proc = execFile("claude", args, {
        cwd: agent.workspace,
        timeout: 600_000,
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
    })

    if (!stdout && exitCode !== 0) {
      const errMsg = stderr?.trim() || `Claude Code exited with code ${exitCode}`
      return {
        content: "",
        error: errMsg.slice(0, 300),
        duration: Date.now() - start,
      }
    }

    const parsed = parseClaudeJsonOutput(stdout)

    return {
      content: parsed.text,
      duration: Date.now() - start,
      claudeSessionId: parsed.sessionId,
      usage: parsed.usage,
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
): Promise<AgentResponse> {
  const start = Date.now()
  const prompt = buildPrompt(agent, task, resumeSessionId ? undefined : historyContext)
  const args = buildClaudeArgs(agent, prompt, true, resumeSessionId)

  let fullText = ""

  try {
    const proc = execa("claude", args, {
      cwd: agent.workspace,
      timeout: 600_000, // 10 minutes
      reject: false,
      env: process.env,
      // Don't buffer — we'll read stdout line by line
      buffer: false,
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

            // "result" event contains final text
            if (event.type === "result" && event.result) {
              const resultText = typeof event.result === "string"
                ? event.result
                : event.result
              if (typeof resultText === "string" && resultText.length > fullText.length) {
                const delta = resultText.slice(fullText.length)
                fullText = resultText
                if (delta) onDelta(delta, fullText)
              }
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
      return {
        content: "",
        error: stderr || `Claude Code exited with code ${result.exitCode}`,
        duration: Date.now() - start,
      }
    }

    return {
      content: fullText,
      duration: Date.now() - start,
    }
  } catch (error: any) {
    return {
      content: fullText || "",
      error: error.message,
      duration: Date.now() - start,
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
): Promise<AgentResponse> {
  const start = Date.now()

  try {
    // @ts-ignore — SDK may not be installed
    const sdk = await import("@anthropic-ai/claude-agent-sdk")
    const { query } = sdk

    const prompt = agent.systemPrompt
      ? `${agent.systemPrompt}\n\n${task.message}`
      : task.message

    let content = ""

    const q = query({
      prompt,
      options: {
        model: agent.model,
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
): Promise<AgentResponse> {
  const start = Date.now()

  try {
    const { generate } = await import("@/agent")
    const providerName = agent.provider || "claude-code"

    const result = await generate({
      task: task.message,
      cwd: agent.workspace,
      provider: providerName as any,
      model: agent.model,
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
): Promise<AgentResponse> {
  switch (agent.tier) {
    case "claude-code":
      if (onDelta) {
        return executeClaudeCodeStreaming(agent, task, onDelta, historyContext, resumeSessionId)
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
      return executeSdk(agent, task, apiKey)
    }

    case "orchestrator": {
      const providerName = agent.provider || "claude-code"
      const apiKey = providers[providerName]?.apiKey
      return executeOrchestrator(agent, task, apiKey)
    }

    default:
      return {
        content: "",
        error: `Unknown tier: ${agent.tier}`,
      }
  }
}
