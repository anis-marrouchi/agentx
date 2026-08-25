import { describe, it, expect } from "vitest"
import { resolveProvider, shortModel } from "../src/tui/provider"

describe("resolveProvider", () => {
  it("maps tiers to their underlying command", () => {
    expect(resolveProvider("claude-code", "claude-opus-4-8").command).toBe("claude")
    expect(resolveProvider("claude-code").label).toBe("claude")
    expect(resolveProvider("codex-cli").command).toBe("codex")
    expect(resolveProvider("codex-cli").label).toBe("codex")
    expect(resolveProvider("opencode").command).toBe("opencode")
    expect(resolveProvider("opencode").label).toBe("opencode")
    expect(resolveProvider("sdk").command).toBe("@anthropic-ai/sdk")
  })

  it("disambiguates the orchestrator tier by model", () => {
    expect(resolveProvider("orchestrator", "deepseek-v4-pro").id).toBe("deepseek")
    expect(resolveProvider("orchestrator", "gpt-5").id).toBe("openai")
    expect(resolveProvider("orchestrator", "gemini-2.0").id).toBe("gemini")
    expect(resolveProvider("orchestrator", "claude-sonnet").id).toBe("claude")
    expect(resolveProvider("orchestrator", "mystery-model").id).toBe("orchestrator")
  })

  it("falls back to unknown for an unrecognised tier", () => {
    expect(resolveProvider("").id).toBe("unknown")
  })
})

describe("shortModel", () => {
  it("strips a provider prefix", () => {
    expect(shortModel("claude-opus-4-8")).toBe("opus-4-8")
    expect(shortModel("gpt-5-codex")).toBe("5-codex")
    expect(shortModel("deepseek-v4-pro")).toBe("v4-pro")
    expect(shortModel(undefined)).toBe("")
  })
})
