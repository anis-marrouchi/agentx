import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { MCP_TOOL_SETS } from "../src/mcp/tool-names"

// #1024 — the Claude Code plugin in plugins/agentx: one install gives the
// AgentX skills and the agentx tool server. Its skills are copies of
// skills/ (Claude Code copies a plugin into its cache, so links would
// break); scripts/sync-plugin-skills.mjs refreshes them.

const root = join(__dirname, "..")
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"))
const sync = await import("../scripts/sync-plugin-skills.mjs")

describe("Claude Code plugin", () => {
  const marketplace = json(".claude-plugin/marketplace.json")
  const plugin = json("plugins/agentx/.claude-plugin/plugin.json")
  const mcp = json("plugins/agentx/.mcp.json")

  it("is listed as agentx@agentx and points at its folder", () => {
    expect(marketplace.name).toBe("agentx")
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "agentx", source: "./plugins/agentx" })])
    expect(plugin.name).toBe("agentx")
  })

  it("ships skill copies that match skills/", () => {
    expect(sync.staleSkills()).toEqual([])
    for (const name of sync.PACK_SKILLS) {
      const text = readFileSync(join(root, "plugins/agentx/skills", name, "SKILL.md"), "utf8")
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`))
    }
  })

  it("starts the tool server with the read tool set unless configured", () => {
    const server = mcp.mcpServers.agentx
    expect(server.command).toBe("agentx")
    expect(server.args).toEqual(["serve", "--stdio", "--tools", "${user_config.tools}"])
    expect(plugin.userConfig.tools.default).toBe("read")
    expect(MCP_TOOL_SETS).toContain(plugin.userConfig.tools.default)
    expect(plugin.userConfig.token.sensitive).toBe(true)
  })

  it("passes only declared options to the tool server", () => {
    const used = [...JSON.stringify(mcp).matchAll(/\$\{user_config\.(\w+)\}/g)].map((m) => m[1])
    for (const key of used) expect(plugin.userConfig, key).toHaveProperty(key)
  })

  it("is documented", () => {
    expect(existsSync(join(root, "docs/jobs/install-skill-pack.md"))).toBe(true)
  })
})
