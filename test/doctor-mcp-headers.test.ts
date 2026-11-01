import { describe, expect, it } from "vitest"
import { mcpHeaderEnvChecks } from "../src/commands/doctor"

const cfg = {
  agents: {
    marketing: {
      mcp: {
        social: { type: "http", url: "https://connector.example.com/mcp", headersEnv: { "x-api-key": "CONNECTOR_KEY" } },
        plain: { command: "npx" },
      },
    },
  },
}

describe("mcpHeaderEnvChecks (#1698)", () => {
  it("fails when a header variable is not set, naming it but never a value", () => {
    const [c] = mcpHeaderEnvChecks(cfg, {}, {})
    expect(c.severity).toBe("fail")
    expect(c.title).toContain('"social"')
    expect(c.detail).toBe("CONNECTOR_KEY")
  })

  it("passes when the variable is in the environment or .env", () => {
    const fromEnv = mcpHeaderEnvChecks(cfg, { CONNECTOR_KEY: "secret-value" }, {})
    expect(fromEnv).toHaveLength(1)
    expect(fromEnv[0].severity).toBe("ok")
    expect(JSON.stringify(fromEnv)).not.toContain("secret-value")
    expect(mcpHeaderEnvChecks(cfg, {}, { CONNECTOR_KEY: "x" })[0].severity).toBe("ok")
  })

  it("says nothing when no server uses headersEnv", () => {
    expect(mcpHeaderEnvChecks({ agents: { a: { mcp: { p: { command: "x" } } } } }, {}, {})).toEqual([])
  })
})
