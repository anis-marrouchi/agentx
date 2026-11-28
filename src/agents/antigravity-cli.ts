// --- Antigravity CLI (`agy`) print mode: its arguments and its stream (#2348) ---
//
// Checked against agy 1.5.19 on 28 Nov 2026. One run is
//   agy -p <prompt> --output-format stream-json [--conversation <id>]
// and stdout is one JSON event per line: `init`, `step_update`, `result`.
// Nothing here starts a process; runtime.ts does.

/** The binary. It installs to ~/.local/bin, which the run's PATH includes. */
export const AGY_COMMAND = "agy"

export function agyMissingMessage(): string {
  return (
    `Antigravity CLI not found on PATH. Install it from https://antigravity.google and verify with  agy --version. ` +
    `If you don't intend to use the antigravity-cli engine, set the agent's tier to "claude-code", "codex-cli", "sdk", or "orchestrator" in agentx.json.`
  )
}

export function buildAgyArgs(o: {
  prompt: string
  model?: string
  bypass?: boolean
  resumeSessionId?: string
}): string[] {
  const args = ["-p", o.prompt, "--output-format", "stream-json"]
  if (o.model) args.push("--model", o.model)
  if (o.resumeSessionId) args.push("--conversation", o.resumeSessionId)
  if (o.bypass) args.push("--dangerously-skip-permissions")
  return args
}

export interface AgyUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

function toUsage(u: any): AgyUsage {
  // input_tokens leaves the cached part out (total = input + output), so the
  // cached tokens are kept apart, as on the other engines.
  return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_tokens), cacheCreateTokens: 0 }
}

/** What one agy run said so far. Feed it stdout line by line. */
export class AgyStream {
  text = ""
  /** The CLI's own final answer, from the `result` event. */
  response?: string
  sessionId?: string
  model?: string
  error?: string
  private steps?: AgyUsage
  private total?: AgyUsage

  /** This run's tokens. The steps are summed because they belong to this
   *  run alone; the `result` total is the fallback when no step carried one. */
  get usage(): AgyUsage | undefined {
    return this.steps ?? this.total
  }

  /** Read one line. Returns the event when the line is one, and the text it
   *  added to the answer, if any. A line that is not JSON returns null. */
  push(line: string): { event: any; delta?: string } | null {
    if (!line.trim()) return null
    let event: any
    try { event = JSON.parse(line) } catch { return null }
    if (!event || typeof event !== "object") return null
    const body = event.init ?? event.step_update ?? event.result ?? {}
    const id = event.conversation_id ?? body.conversation_id
    if (typeof id === "string" && id) this.sessionId = id
    if (event.event === "init" && typeof body.model === "string") this.model = body.model
    if (event.event === "step_update") {
      if (body.usage && body.state === "DONE") {
        const u = toUsage(body.usage)
        const s = this.steps ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }
        this.steps = {
          inputTokens: s.inputTokens + u.inputTokens,
          outputTokens: s.outputTokens + u.outputTokens,
          cacheReadTokens: s.cacheReadTokens + u.cacheReadTokens,
          cacheCreateTokens: 0,
        }
      }
      if (body.step_type === "agent_response" && typeof body.text_delta === "string" && body.text_delta) {
        this.text += body.text_delta
        return { event, delta: body.text_delta }
      }
    }
    if (event.event === "result") {
      if (body.usage) this.total = toUsage(body.usage)
      if (typeof body.response === "string") this.response = body.response
      if (body.status !== "SUCCESS") {
        // The error lists every model after its first line; keep the cause.
        const raw = typeof body.error === "string" && body.error.trim() ? body.error.trim() : `Antigravity CLI ended with status ${body.status ?? "unknown"}`
        this.error = raw.split("\nAvailable models:")[0]
      }
    }
    return { event }
  }
}
