import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { listedTools } from "../src/mcp"
import { AGENTX_TOOL_NAMES, MCP_TOOL_SETS, READ_TOOL_NAMES } from "../src/mcp/tool-names"

// #1024 — the Claude Code plugin pack. `claude plugin install agentx
// --marketplace anis-marrouchi/agentx` reads these files straight from
// the repo, so a broken manifest or a stale skill ships the moment it
// lands on main.

const root = join(__dirname, "..")
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"))

const marketplace = readJson(".claude-plugin/marketplace.json")
const entry = marketplace.plugins.find((p: { name: string }) => p.name === "agentx")
const pluginDir = entry.source.replace(/^\.\//, "")
const manifest = readJson(`${pluginDir}/.claude-plugin/plugin.json`)
const mcp = readJson(`${pluginDir}/.mcp.json`)
const server = mcp.mcpServers.agentx
const skill = readFileSync(join(root, pluginDir, "skills/agentx/SKILL.md"), "utf8")

describe("Claude Code plugin pack (#1024)", () => {
  it("lists one agentx plugin whose folder and manifest exist", () => {
    expect(marketplace.name).toBe("agentx")
    expect(existsSync(join(root, pluginDir, ".claude-plugin/plugin.json"))).toBe(true)
    expect(manifest.name).toBe(entry.name)
  })

  it("starts the tool server read-only unless the person picks full", () => {
    expect(server.command).toBe("agentx")
    expect(server.args.slice(0, 2)).toEqual(["serve", "--stdio"])
    expect(manifest.userConfig.tools.default).toBe("read")
    expect(manifest.userConfig.tools.options).toEqual([...MCP_TOOL_SETS])
    expect(manifest.userConfig.token.sensitive).toBe(true)
  })

  it("declares every user_config option the tool server uses", () => {
    const refs = [...JSON.stringify(server).matchAll(/\$\{user_config\.([a-z_]+)\}/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const key of refs) expect(manifest.userConfig).toHaveProperty(key)
  })

  it("names only real agentx tools, and its look-only table only read tools", () => {
    const named = [...new Set(skill.match(/agentx_[a-z_]+/g) ?? [])]
    expect(named.filter((t) => !AGENTX_TOOL_NAMES.includes(t))).toEqual([])
    const lookSection = skill.split("## 2. Look before you act")[1].split("## 3.")[0]
    const lookTools = lookSection.match(/agentx_[a-z_]+/g) ?? []
    expect(lookTools.filter((t) => !READ_TOOL_NAMES.includes(t))).toEqual([])
  })

  it("names each tool's fields as the tool server defines them", () => {
    const tools = listedTools({}, "full")
    const uses = [...skill.matchAll(/`(agentx_[a-z_]+)` \(fields ([^)]+)\)/g)]
    expect(uses.length).toBeGreaterThan(0)
    for (const [, name, list] of uses) {
      const props = Object.keys(tools.find((t) => t.name === name)?.inputSchema.properties ?? {})
      const fields = [...list.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1])
      expect(fields.filter((f) => !props.includes(f)), name).toEqual([])
    }
  })

  it("ships the same contribute skill as skills/agentx-contribute", () => {
    expect(readFileSync(join(root, pluginDir, "skills/agentx-contribute/SKILL.md"), "utf8")).toBe(
      readFileSync(join(root, "skills/agentx-contribute/SKILL.md"), "utf8"),
    )
  })
})
