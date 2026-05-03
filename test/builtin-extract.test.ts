import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  registerAllBuiltins,
  runBuiltin,
  _resetBuiltinsForTesting,
} from "../src/actions/builtin"

const origKey = process.env.ANTHROPIC_API_KEY
const origFetch = globalThis.fetch

beforeEach(() => {
  _resetBuiltinsForTesting()
  registerAllBuiltins()
  process.env.ANTHROPIC_API_KEY = "sk-test-fake"
})

afterEach(() => {
  if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = origKey
  globalThis.fetch = origFetch
})

function mockFetchOnce(handler: (req: Request) => Promise<Response> | Response) {
  globalThis.fetch = vi.fn(handler) as any
}

describe("extract.structured", () => {
  it("calls Anthropic Messages API with forced tool_use and returns the tool input verbatim", async () => {
    let receivedBody: any = null
    let receivedHeaders: Record<string, string> = {}
    mockFetchOnce(async (req: any) => {
      const url = typeof req === "string" ? req : (req.url ?? req.toString())
      expect(url).toBe("https://api.anthropic.com/v1/messages")
      // The mocked fetch is called with (url, init) signature.
      // Our action passes a string URL + init. Recover init from the second arg.
      // vitest's vi.fn gives us access to the call args via .mock.calls below.
      return new Response(
        JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          content: [{
            type: "tool_use",
            name: "respond_with_structure",
            input: { name: "Alice", age: 30 },
          }],
          usage: { input_tokens: 42, output_tokens: 12 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })
    // Replace with a fetch that captures the request body.
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      receivedBody = JSON.parse(init.body)
      receivedHeaders = init.headers
      return new Response(
        JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          content: [{
            type: "tool_use",
            name: "respond_with_structure",
            input: { name: "Alice", age: 30 },
          }],
          usage: { input_tokens: 42, output_tokens: 12 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as any

    const out: any = await runBuiltin("extract.structured", {
      prompt: "Extract name and age from: Alice is 30 years old.",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "number" } },
        required: ["name", "age"],
      },
    })

    expect(out.data).toEqual({ name: "Alice", age: 30 })
    expect(out.usage).toEqual({ inputTokens: 42, outputTokens: 12 })
    expect(out.model).toBe("claude-haiku-4-5-20251001")

    // Verify the request shape — forced tool_use is the load-bearing detail.
    expect(receivedBody.tool_choice).toEqual({ type: "tool", name: "respond_with_structure" })
    expect(receivedBody.tools[0].name).toBe("respond_with_structure")
    expect(receivedBody.tools[0].input_schema.required).toEqual(["name", "age"])
    expect(receivedHeaders["x-api-key"]).toBe("sk-test-fake")
    expect(receivedHeaders["anthropic-version"]).toBe("2023-06-01")
  })

  it("forwards systemPrompt when provided", async () => {
    let receivedBody: any = null
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      receivedBody = JSON.parse(init.body)
      return new Response(
        JSON.stringify({
          model: "x", content: [{ type: "tool_use", name: "respond_with_structure", input: {} }],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
        { status: 200 },
      )
    }) as any
    await runBuiltin("extract.structured", {
      prompt: "test", schema: { type: "object" },
      systemPrompt: "You are a strict extractor.",
    })
    expect(receivedBody.system).toBe("You are a strict extractor.")
  })

  it("rejects when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY
    await expect(runBuiltin("extract.structured", { prompt: "x", schema: {} }))
      .rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  it("propagates non-200 API responses with body excerpt", async () => {
    globalThis.fetch = vi.fn(async () => new Response("rate limit", { status: 429 })) as any
    await expect(runBuiltin("extract.structured", { prompt: "x", schema: {} }))
      .rejects.toThrow(/anthropic API 429: rate limit/)
  })

  it("rejects when no respond_with_structure block returned", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ model: "x", content: [{ type: "text", text: "hi" }], usage: {} }),
      { status: 200 },
    )) as any
    await expect(runBuiltin("extract.structured", { prompt: "x", schema: {} }))
      .rejects.toThrow(/no respond_with_structure tool_use/)
  })

  it("validates input — empty prompt rejected", async () => {
    await expect(runBuiltin("extract.structured", { prompt: "", schema: {} })).rejects.toThrow()
  })
})
