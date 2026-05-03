import { describe, it, expect } from "vitest"
import { buildAgentContext, estimateTokens, type ContextInput } from "../src/agents/context"

const baseInput: ContextInput = {
  channel: "telegram",
  agentId: "nadia",
  agentName: "Nadia",
  sender: "Anis",
  message: "Hello",
}

describe("buildAgentContext", () => {
  it("includes channel layer", () => {
    const ctx = buildAgentContext(baseInput)
    expect(ctx).toContain("Channel: telegram")
  })

  it("includes sender", () => {
    const ctx = buildAgentContext(baseInput)
    expect(ctx).toContain("From: Anis")
  })

  it("includes agent handle on telegram", () => {
    const ctx = buildAgentContext({ ...baseInput, agentHandle: "@test_bot" })
    expect(ctx).toContain("@test_bot")
  })

  it("adds gitlab-specific rules", () => {
    const ctx = buildAgentContext({ ...baseInput, channel: "gitlab" })
    expect(ctx).toContain("GitLab comment")
    expect(ctx).toContain("Do NOT mention Telegram handles")
    expect(ctx).toContain("Do NOT delegate")
  })

  it("includes group scope", () => {
    const ctx = buildAgentContext({
      ...baseInput,
      channelScope: "group",
      groupName: "Dev Team",
    })
    expect(ctx).toContain("Group: Dev Team")
  })

  it("includes project scope", () => {
    const ctx = buildAgentContext({
      ...baseInput,
      channel: "gitlab",
      channelScope: "project",
      projectPath: "org/my-project",
    })
    expect(ctx).toContain("Project: org/my-project")
  })

  // (Deleted) "includes peers only on telegram" — the assertion was that
  // `buildAgentContext` renders peers, but peers handling moved to
  // src/agents/runtime.ts:131 where it lives on the AgentTask context
  // path. The test was passing extra-property `peers` to ContextInput
  // (which has no such field) and asserting behaviour that this layer
  // never had after the move. Coverage for the runtime peers logic is
  // a separate concern; tracked as a follow-up.

  it("extracts intent tags", () => {
    const ctx = buildAgentContext({ ...baseInput, message: "please deploy the latest build to staging" })
    expect(ctx).toContain("deployment")
  })

  it("includes reply-to context", () => {
    const ctx = buildAgentContext({ ...baseInput, replyToText: "What about the MR?" })
    expect(ctx).toContain("[Replying to]: What about the MR?")
  })

  it("includes media context", () => {
    const ctx = buildAgentContext({ ...baseInput, mediaPath: "/tmp/photo.jpg", mediaType: "image/jpeg" })
    expect(ctx).toContain("/tmp/photo.jpg")
    expect(ctx).toContain("view this image")
  })

  it("includes wiki context", () => {
    const ctx = buildAgentContext({ ...baseInput, wikiContext: "[Wiki Knowledge]\n## Staging Deploy\nStaging on port 3000" })
    expect(ctx).toContain("Staging Deploy")
  })

  it("includes group history", () => {
    const ctx = buildAgentContext({ ...baseInput, groupHistory: "[Recent conversation]\nAnis: deploy?\nNadia: ready" })
    expect(ctx).toContain("deploy?")
  })

  it("respects total token budget", () => {
    const longHistory = "x".repeat(20000)
    const ctx = buildAgentContext({ ...baseInput, groupHistory: longHistory }, { totalBudget: 500 })
    expect(ctx.length).toBeLessThan(500 * 4 + 100) // 4 chars/token + some overhead
  })

  it("prioritizes channel over wiki", () => {
    const ctx = buildAgentContext({
      ...baseInput,
      wikiContext: "WIKI_CONTENT_HERE",
    })
    const channelIdx = ctx.indexOf("Channel:")
    const wikiIdx = ctx.indexOf("WIKI_CONTENT_HERE")
    expect(channelIdx).toBeLessThan(wikiIdx)
  })
})

describe("estimateTokens", () => {
  it("estimates roughly 1 token per 4 chars", () => {
    expect(estimateTokens("hello world")).toBe(3) // 11 chars / 4 = 2.75 → 3
  })

  it("handles empty string", () => {
    expect(estimateTokens("")).toBe(0)
  })
})
