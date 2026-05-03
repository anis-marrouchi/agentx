import { z } from "zod"
import type { BuiltinAction } from "./types"

// --- extract.structured ---
//
// Single-call structured extraction: ask Claude for a JSON value
// matching a caller-supplied JSON-Schema. The agent / workflow gets
// typed structured data back — no parser needed downstream.
//
// Implementation: Anthropic Messages API with a forced tool_use whose
// input_schema is the caller's schema. Forced tool use guarantees the
// model's response is the structured value, not free-form text. We
// extract the tool's `input` and return it verbatim.
//
// Why we hit the API directly instead of routing through the
// claude-code subprocess (or the SDK):
//   - The persistent-process path keeps a turn slot busy for >2s
//     even on warm cache; for a single extraction this is overkill.
//   - The SDK adds a 10MB+ dependency; raw fetch needs zero new deps.
//   - The model + auth are the same — ANTHROPIC_API_KEY env var.
//
// Input shape:
//   model:       Anthropic model id ("claude-sonnet-4-6" / "claude-haiku-4-5" / etc.)
//   prompt:      User-message text the model extracts from.
//   schema:      JSON-Schema-shaped object (NOT a Zod schema) — this is what
//                the model is told to fill in. Caller-defined.
//   maxTokens:   Output-token cap, default 1024.
//
// Output shape:
//   data:        The structured value, exactly as the model returned it.
//                Validated only against "is an object/array/scalar" — the
//                caller's schema is the contract; we don't re-validate
//                because that would require shipping a JSON-Schema validator.
//   usage:       Token counts for cost accounting.
//   model:       Model that actually billed (echoed from the response).

const extractInput = z.object({
  model: z.string().default("claude-haiku-4-5"),
  prompt: z.string().min(1),
  /** JSON-Schema describing the output shape. Passed to the Claude
   *  API as the input_schema of a forced tool_use. */
  schema: z.record(z.string(), z.unknown()),
  /** Optional system prompt prepended to the conversation. */
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().min(1).max(8_000).default(1024),
  /** Per-call timeout. Default 60s. */
  timeoutMs: z.number().int().min(1).max(120_000).default(60_000),
})
type ExtractInput = z.infer<typeof extractInput>

const extractOutput = z.object({
  data: z.unknown(),
  model: z.string(),
  usage: z.object({
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  }),
})
type ExtractOutput = z.infer<typeof extractOutput>

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_VERSION = "2023-06-01"

export const extractStructured: BuiltinAction<ExtractInput, ExtractOutput> = {
  name: "extract.structured",
  description: "Single-call typed extraction: prompt + JSON-Schema → structured data via forced tool_use",
  inputSchema: extractInput,
  outputSchema: extractOutput,
  timeoutMs: 120_000,
  handler: async (input) => {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY env var is not set — extract.structured needs direct API access")
    }

    // Use a forced tool_use with input_schema = the caller's schema.
    // tool_choice: { type: "tool", name: "respond_with_structure" }
    // makes the model produce a tool_use block as the entire reply,
    // whose `input` field IS the structured value.
    const requestBody: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens,
      messages: [{ role: "user", content: input.prompt }],
      tools: [{
        name: "respond_with_structure",
        description: "Return a structured value matching the schema",
        input_schema: input.schema,
      }],
      tool_choice: { type: "tool", name: "respond_with_structure" },
    }
    if (input.systemPrompt) {
      requestBody.system = input.systemPrompt
    }

    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), input.timeoutMs)
    let res: Response
    try {
      res = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(requestBody),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(t)
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      throw new Error(`anthropic API ${res.status}: ${errBody.slice(0, 500)}`)
    }
    const body: any = await res.json()
    const blocks = Array.isArray(body.content) ? body.content : []
    const toolUse = blocks.find((b: any) => b?.type === "tool_use" && b?.name === "respond_with_structure")
    if (!toolUse || toolUse.input === undefined) {
      throw new Error(`anthropic API returned no respond_with_structure tool_use (got ${blocks.length} blocks)`)
    }

    const usage = body.usage ?? {}
    return {
      data: toolUse.input,
      model: typeof body.model === "string" ? body.model : input.model,
      usage: {
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      },
    }
  },
}
