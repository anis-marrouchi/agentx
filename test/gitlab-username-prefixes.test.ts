import { describe, it, expect } from "vitest"
import { GitLabAdapter, type GitLabChannelConfig } from "../src/channels/gitlab"

function adapter(overrides: Partial<GitLabChannelConfig> = {}) {
  const cfg: GitLabChannelConfig = {
    webhookPort: 0, host: "https://gitlab.example.test", token: "glpat-test-token-000000", routes: [],
    agentMappings: [], knownAgentIds: ["helper", "coder"], ...overrides,
  }
  const a = new GitLabAdapter(cfg, () => {}) as any
  a.deriveDefaultMappings()
  return a
}

describe("GitLab derived usernames", () => {
  it("answers to the agent id only, by default — no organisation prefix baked into code", () => {
    const map: Map<string, string> = adapter().usernameToAgent
    expect(map.get("helper")).toBe("helper")
    expect([...map.keys()].some((u) => u.includes("-helper") && u !== "helper")).toBe(false)
  })

  it("adds a username per configured prefix", () => {
    const map: Map<string, string> = adapter({ agentUsernamePrefixes: ["team-", "bot-"] }).usernameToAgent
    expect(map.get("team-helper")).toBe("helper")
    expect(map.get("bot-coder")).toBe("coder")
  })

  it("derives nothing for an agent with an explicit mapping", () => {
    const map: Map<string, string> = adapter({
      agentUsernamePrefixes: ["team-"],
      agentMappings: [{ agentId: "coder", gitlabUsernames: ["custom-coder"], keywords: [] }],
    }).usernameToAgent
    expect(map.has("team-coder")).toBe(false)
    expect(map.get("team-helper")).toBe("helper")
  })
})
