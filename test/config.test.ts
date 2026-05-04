import { describe, it, expect } from "vitest"
import { daemonConfigSchema } from "../src/daemon/config"

describe("daemonConfigSchema", () => {
  it("validates minimal config", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.node.id).toBe("test")
      expect(result.data.node.bind).toBe("127.0.0.1:18800") // default
      expect(result.data.agents).toEqual({})
      expect(result.data.crons).toEqual({})
    }
  })

  it("validates full agent config", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
      agents: {
        "my-agent": {
          name: "My Agent",
          workspace: "/tmp/workspace",
          tier: "claude-code",
          mentions: ["@bot"],
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.agents["my-agent"].name).toBe("My Agent")
      expect(result.data.agents["my-agent"].maxConcurrent).toBe(1) // default
      expect(result.data.agents["my-agent"].permissionMode).toBe("default")
    }
  })

  it("validates codex-cli agent config", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
      agents: {
        "codex-agent": {
          name: "Codex Agent",
          workspace: "/tmp/workspace",
          tier: "codex-cli",
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it("validates telegram config", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
      channels: {
        telegram: {
          enabled: true,
          accounts: {
            default: { token: "123:ABC", agentBinding: "agent-1" },
          },
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.channels.telegram.enabled).toBe(true)
      expect(result.data.channels.telegram.policy.group).toBe("mention-required") // default
    }
  })

  it("validates whatsapp config with routes", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
      channels: {
        whatsapp: {
          enabled: true,
          defaultAgent: "atlas",
          routes: [
            { contact: "+1234567890", agent: "atlas" },
            { group: "Team Chat", agent: "devops" },
          ],
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.channels.whatsapp.routes).toHaveLength(2)
      expect(result.data.channels.whatsapp.defaultAgent).toBe("atlas")
    }
  })

  it("validates discord config", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
      channels: {
        discord: { enabled: true, token: "discord-token", agentBinding: "bot" },
      },
    })
    expect(result.success).toBe(true)
  })

  it("validates cron config", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
      crons: {
        "daily-report": {
          schedule: "0 9 * * *",
          agent: "atlas",
          prompt: "Generate report",
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.crons["daily-report"].timezone).toBe("UTC") // default
      expect(result.data.crons["daily-report"].timeout).toBe(600) // default
      expect(result.data.crons["daily-report"].enabled).toBe(true) // default
    }
  })

  it("validates mesh config", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
      mesh: {
        enabled: true,
        peers: [{ url: "http://10.0.0.1:18800", name: "server-2" }],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mesh.peers).toHaveLength(1)
      expect(result.data.mesh.healthCheck.interval).toBe(60) // default
    }
  })

  it("rejects invalid tier", () => {
    const result = daemonConfigSchema.safeParse({
      node: { id: "test", name: "Test" },
      agents: {
        bad: { name: "Bad", workspace: "/tmp", tier: "invalid" },
      },
    })
    expect(result.success).toBe(false)
  })
})
