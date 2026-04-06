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
    const ctx = buildAgentContext({ ...baseInput, agentHandle: "@noqta_nadia_bot" })
    expect(ctx).toContain("@noqta_nadia_bot")
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
      groupName: "Noqta Team",
    })
    expect(ctx).toContain("Group: Noqta Team")
  })

  it("includes project scope", () => {
    const ctx = buildAgentContext({
      ...baseInput,
      channel: "gitlab",
      channelScope: "project",
      projectPath: "mtgl/mtgl-system-v2",
    })
    expect(ctx).toContain("Project: mtgl/mtgl-system-v2")
  })

  it("includes peers only on telegram", () => {
    const peers = [{ name: "DevOps", handle: "@noqta_devops_bot", role: "infrastructure" }]

    const tgCtx = buildAgentContext({ ...baseInput, channel: "telegram", peers })
    expect(tgCtx).toContain("DevOps")
    expect(tgCtx).toContain("@noqta_devops_bot")

    const glCtx = buildAgentContext({ ...baseInput, channel: "gitlab", peers })
    expect(glCtx).not.toContain("@noqta_devops_bot")
  })

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
    const ctx = buildAgentContext({ ...baseInput, wikiContext: "[Wiki Knowledge]\n## MTGL Deploy\nStaging on port 3000" })
    expect(ctx).toContain("MTGL Deploy")
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
