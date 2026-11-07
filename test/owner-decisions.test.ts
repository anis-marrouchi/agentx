import { describe, it, expect, afterEach } from "vitest"
import { buildOwnerDecisions, ruleText } from "../src/agents/owner-decisions"
import { buildAgentContext } from "../src/agents/context"
import { setAgentGitlabTokenResolver, withAgentGitlabEnv, ownGitlabToken } from "../src/channels/gitlab-token"

const NOW = Date.parse("2026-11-07T22:00:00Z")
const art = (title: string, content: string, lastUpdated = "2026-11-07", type = "decision", path = `decisions/${title}.md`) =>
  ({ meta: { title, type, tags: [], owner: "owner", access: "public", created: "2026-11-01", lastUpdated, sources: [] }, content, path }) as any

const APPENDED = `---
title: x
---
Intro.

## Rule
<!-- tags: deploy -->
- Deploys need the owner's own yes.

## History
- old things

## Update 2026-11-07 19:45Z — owner removes the yes
- No yes needed; push and deploy.

## Update 2026-11-07 19:55Z — branch dropped
- Live runs on main. Any yes approval is taken off.
`

describe("ruleText", () => {
  it("puts the newest update first and marks the older rule as older", () => {
    const t = ruleText(APPENDED)
    expect(t.indexOf("19:55Z")).toBeLessThan(t.indexOf("19:45Z"))
    expect(t).toContain("Older rule (the updates above win where they differ):")
    expect(t.indexOf("Older rule")).toBeGreaterThan(t.indexOf("19:45Z"))
    expect(t).not.toContain("old things")
    expect(t).not.toContain("<!--")
  })
  it("uses the rule alone when there is no update, and the body when there is no rule", () => {
    expect(ruleText("## Rule\n- One thing.\n\n## History\n- x")).toBe("- One thing.")
    expect(ruleText("Just a body.")).toBe("Just a body.")
  })
})

describe("buildOwnerDecisions", () => {
  it("lists recent decisions, newest first, and nothing else", () => {
    const out = buildOwnerDecisions([
      art("Old", "## Rule\nold", "2026-10-01"),
      art("Newer", "## Rule\nnewer rule", "2026-11-07"),
      art("Earlier", "## Rule\nearlier rule", "2026-11-05"),
      art("Not a decision", "## Rule\nx", "2026-11-07", "person"),
      art("Version", "## Rule\nv", "2026-11-07", "decision", "decisions/_versions/a.md"),
    ], NOW)
    expect(out).toContain("[Owner decisions")
    expect(out).toContain("outrank the chat history")
    expect(out.indexOf("Newer")).toBeLessThan(out.indexOf("Earlier"))
    expect(out).not.toContain("old\n")
    expect(out).not.toContain("Not a decision")
    expect(out).not.toContain("### Version")
  })
  it("is empty with no recent decision", () => {
    expect(buildOwnerDecisions([art("Old", "## Rule\nx", "2026-01-01")], NOW)).toBe("")
  })
  it("comes before the history and the continuity memo in the context", () => {
    const ctx = buildAgentContext({
      agentId: "pm", agentName: "PM", channel: "app", chatId: "c1", message: "hi",
      ownerDecisions: "[Owner decisions — X]",
      sessionHistory: "[Conversation history for today (2026-11-07)]\nAgent: needs your yes",
      rotationMemo: { memo: "- needs Telegram yes", reason: "tier-2", capturedAt: "2026-11-07T19:00:00Z" },
    } as any)
    expect(ctx.indexOf("[Owner decisions")).toBeGreaterThanOrEqual(0)
    expect(ctx.indexOf("[Owner decisions")).toBeLessThan(ctx.indexOf("[Conversation history"))
    expect(ctx.indexOf("[Owner decisions")).toBeLessThan(ctx.indexOf("[Continuity memo"))
    expect(ctx).toContain("owner decisions made after it win over it")
  })
})

describe("the agent's own GitLab token in its runs", () => {
  afterEach(() => setAgentGitlabTokenResolver(null))
  it("sets GITLAB_TOKEN to the agent's own token, and leaves it otherwise", () => {
    setAgentGitlabTokenResolver((id) => (id === "coder" ? "coder-tok" : undefined))
    expect(withAgentGitlabEnv({ GITLAB_TOKEN: "shared" }, "coder")).toMatchObject({ GITLAB_TOKEN: "coder-tok", GITLAB_ACCESS_TOKEN: "coder-tok" })
    expect(withAgentGitlabEnv({ GITLAB_TOKEN: "shared" }, "other").GITLAB_TOKEN).toBe("shared")
  })
  it("does nothing without a resolver or when it throws", () => {
    expect(withAgentGitlabEnv({ GITLAB_TOKEN: "shared" }, "coder").GITLAB_TOKEN).toBe("shared")
    setAgentGitlabTokenResolver(() => { throw new Error("x") })
    expect(withAgentGitlabEnv({ GITLAB_TOKEN: "shared" }, "coder").GITLAB_TOKEN).toBe("shared")
  })
  it("never returns the global token as an agent's own", () => {
    const cfg = { channels: { gitlab: { token: "global", agentMappings: [{ agentId: "ops", token: "ops-tok" }] } }, agents: {} } as any
    expect(ownGitlabToken(cfg, "ops")).toBe("ops-tok")
    expect(ownGitlabToken(cfg, "nobody")).toBeUndefined()
  })
})
