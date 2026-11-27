import { describe, expect, it } from "vitest"
import { assistantModel, modelChoices } from "../src/daemon/assistant-model"

// #2101 P7: the Hub composer's model picker, checked on the daemon.
describe("the composer's model choice", () => {
  it("offers Claude's short names and Codex's seeded slugs, none to others (#2349)", () => {
    expect(modelChoices("claude-code")).toEqual(["opus", "sonnet", "haiku"])
    expect(modelChoices("codex-cli")).toContain("gpt-6.2-sol")
    expect(modelChoices("opencode")).toEqual([])
    expect(modelChoices("sdk")).toEqual([])
    expect(modelChoices(undefined)).toEqual([])
  })

  it("runs on the agent's own model when none is picked", () => {
    expect(assistantModel("claude-code", undefined)).toEqual({})
    expect(assistantModel("claude-code", "")).toEqual({})
    expect(assistantModel("codex-cli", "  ")).toEqual({})
  })

  it("takes an offered model, whatever its case", () => {
    expect(assistantModel("claude-code", "Sonnet")).toEqual({ model: "sonnet" })
  })

  it("refuses a model the engine does not offer, so it never reaches the CLI", () => {
    expect(assistantModel("claude-code", "--dangerously-skip-permissions").error).toMatch(/not offered/)
    expect(assistantModel("codex-cli", "opus").error).toMatch(/not offered/)
    expect(assistantModel("opencode", "opus").error).toMatch(/own model only/)
    expect(assistantModel("claude-code", 7).error).toMatch(/string/)
  })
})
