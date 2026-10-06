import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { AgentRegistry, buildWikiContext } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { WikiHub } from "../src/wiki/hub"

// #603: the daemon read agents/<id>/unified/ while the CLI, the MCP wiki
// tool and `wiki prune` keep articles in agents/<id>/graph/, so a fresh
// session's wiki catalog and the mesh /wiki endpoints came up empty.

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-wiki-mode-"))
  process.chdir(dir)
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

describe("daemon wiki hub", () => {
  it("reads the same graph/ folder the CLI writes", () => {
    // Written the way `agentx wiki` does it (default mode).
    const cli = new WikiHub(resolve(dir, ".agentx/wiki"), () => {})
    cli.getAgentWiki("ops").writeArticle("concepts/release-steps.md", {
      title: "Release Steps", tags: [], owner: "ops", access: "public",
      created: "2026-01-01", lastUpdated: "2026-01-01", sources: [],
    }, "How we release.", "ops")

    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir } },
    })
    const hub = new AgentRegistry(config, () => {}).getWikiHub()
    expect(hub.getMode()).toBe("graph")

    const store = hub.getAgentWiki("ops")
    expect(store.listArticles("ops").map((a) => a.meta.title)).toEqual(["Release Steps"])
    expect(buildWikiContext(store, "ops")).toContain("Release Steps")
  })
})
