import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { configuredGraphWeight } from "../src/mcp"

// #310: docs said wiki ranking follows graph.retrievalWeights.graph, but the
// MCP tool never read it, so the built-in 0.6 always applied.

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-graph-weight-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("configuredGraphWeight", () => {
  it("reads graph.retrievalWeights.graph from agentx.json", () => {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ graph: { retrievalWeights: { graph: 0.25 } } }))
    expect(configuredGraphWeight(dir)).toBe(0.25)
  })

  it("is undefined when unset, invalid or unreadable", () => {
    expect(configuredGraphWeight(dir)).toBeUndefined()
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ graph: { retrievalWeights: { graph: -1 } } }))
    expect(configuredGraphWeight(dir)).toBeUndefined()
    writeFileSync(join(dir, "agentx.json"), "{ not json")
    expect(configuredGraphWeight(dir)).toBeUndefined()
  })
})
