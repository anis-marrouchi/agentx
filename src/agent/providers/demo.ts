// --- Demo provider: canned replies, real protocol ---
//
// Powers `agentx demo` — a zero-key walkthrough where every daemon,
// mesh hop, ledger row, and dashboard view is real and only the LLM is
// replaced by a scripted transcript. The provider reads a script file
// (path in AGENTX_DEMO_SCRIPT) and answers each request with the first
// step whose `match` regex hits the latest user message, streamed with
// human-ish pacing so the live views have something to show.
//
// Deliberately boring: no tools, no files, one text block per turn.
// The point of the demo is the plumbing around the model, not the model.

import { readFileSync } from "fs"
import type {
  AgentProvider,
  GenerationMessage,
  GenerationResult,
  ProviderOptions,
  StreamEvent,
  AnthropicMessage,
  RawGenerationResult,
  RawStreamEvent,
} from "./types"

interface DemoStep {
  /** Regex tested (case-insensitive) against the latest user message. */
  match: string
  /** Optional "thinking" text streamed as thinking_delta before the reply. */
  thinking?: string
  reply: string
  /** Pause before the first token. Default 700ms. */
  delayMs?: number
  /** Pause between streamed chunks. Default 35ms. */
  chunkMs?: number
}

interface DemoScript {
  steps: DemoStep[]
  fallback?: Pick<DemoStep, "reply" | "thinking" | "delayMs" | "chunkMs">
}

const DEFAULT_FALLBACK: DemoScript["fallback"] = {
  reply:
    "This is demo mode — I answer from a script, not a live model. " +
    "Run `agentx setup` to connect a real provider.",
}

function loadScript(): DemoScript {
  const path = process.env.AGENTX_DEMO_SCRIPT
  if (!path) return { steps: [], fallback: DEFAULT_FALLBACK }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DemoScript
    return {
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      fallback: parsed.fallback || DEFAULT_FALLBACK,
    }
  } catch (e: any) {
    return {
      steps: [],
      fallback: { reply: `Demo script unreadable (${e.message}) — check AGENTX_DEMO_SCRIPT.` },
    }
  }
}

function latestUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue
    const c = messages[i].content
    if (typeof c === "string") return c
    if (Array.isArray(c)) {
      return c
        .map((b: any) => (b?.type === "text" ? b.text : b?.type === "tool_result" ? b.content : ""))
        .filter(Boolean)
        .join("\n")
    }
  }
  return ""
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")) }, { once: true })
  })
}

/** Split into word-ish chunks so streaming looks like generation, not a paste. */
function chunks(text: string): string[] {
  return text.match(/\S+\s*/g) || [text]
}

const approxTokens = (s: string) => Math.max(1, Math.round(s.length / 4))

export class DemoProvider implements AgentProvider {
  name = "demo"
  private script: DemoScript

  constructor() {
    this.script = loadScript()
  }

  private pick(userText: string): Required<Pick<DemoStep, "reply" | "delayMs" | "chunkMs">> & Pick<DemoStep, "thinking"> {
    // The orchestrator prepends conversation history to the task text, so
    // an early scene's trigger phrase stays present in every later turn.
    // Prefer the step whose regex matches LATEST in the text — the newest
    // part of the conversation wins, which is how a real model would read it.
    let best: DemoStep | undefined
    let bestIndex = -1
    for (const step of this.script.steps) {
      try {
        const re = new RegExp(step.match, "ig")
        let m: RegExpExecArray | null
        let last = -1
        while ((m = re.exec(userText)) !== null) {
          last = m.index
          if (m.index === re.lastIndex) re.lastIndex++ // zero-width guard
        }
        if (last > bestIndex) {
          bestIndex = last
          best = step
        }
      } catch { /* bad regex in a step — skip it */ }
    }
    if (best) {
      return { reply: best.reply, thinking: best.thinking, delayMs: best.delayMs ?? 700, chunkMs: best.chunkMs ?? 35 }
    }
    const f = this.script.fallback || DEFAULT_FALLBACK
    return { reply: f!.reply, thinking: f!.thinking, delayMs: f!.delayMs ?? 700, chunkMs: f!.chunkMs ?? 35 }
  }

  async generate(messages: GenerationMessage[], options?: ProviderOptions): Promise<GenerationResult> {
    const step = this.pick(latestUserText(messages))
    await sleep(step.delayMs, options?.abortSignal)
    return { content: step.reply, files: [], tokensUsed: approxTokens(step.reply) }
  }

  async *stream(messages: GenerationMessage[], options?: ProviderOptions): AsyncIterable<StreamEvent> {
    const step = this.pick(latestUserText(messages))
    await sleep(step.delayMs, options?.abortSignal)
    if (step.thinking) {
      for (const c of chunks(step.thinking)) {
        yield { type: "thinking_delta", text: c }
        await sleep(step.chunkMs, options?.abortSignal)
      }
    }
    for (const c of chunks(step.reply)) {
      yield { type: "text_delta", text: c }
      await sleep(step.chunkMs, options?.abortSignal)
    }
    yield { type: "done", result: { content: step.reply, files: [], tokensUsed: approxTokens(step.reply) } }
  }

  async generateRaw(
    messages: AnthropicMessage[],
    _systemPrompt: string,
    _tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    options?: ProviderOptions,
  ): Promise<RawGenerationResult> {
    const step = this.pick(latestUserText(messages))
    await sleep(step.delayMs, options?.abortSignal)
    return {
      content: [{ type: "text", text: step.reply }],
      stop_reason: "end_turn",
      usage: { input_tokens: approxTokens(latestUserText(messages)), output_tokens: approxTokens(step.reply) },
    }
  }

  async *generateRawStream(
    messages: AnthropicMessage[],
    _systemPrompt: string,
    _tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    options?: ProviderOptions,
  ): AsyncIterable<RawStreamEvent> {
    const step = this.pick(latestUserText(messages))
    await sleep(step.delayMs, options?.abortSignal)
    if (step.thinking) {
      for (const c of chunks(step.thinking)) {
        yield { type: "thinking_delta", text: c }
        await sleep(step.chunkMs, options?.abortSignal)
      }
    }
    for (const c of chunks(step.reply)) {
      yield { type: "text_delta", text: c }
      await sleep(step.chunkMs, options?.abortSignal)
    }
    yield {
      type: "raw_result",
      result: {
        content: [{ type: "text", text: step.reply }],
        stop_reason: "end_turn",
        usage: { input_tokens: approxTokens(latestUserText(messages)), output_tokens: approxTokens(step.reply) },
      },
    }
  }
}
