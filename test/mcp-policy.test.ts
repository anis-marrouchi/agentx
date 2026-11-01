import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { loadDaemonConfig } from "../src/daemon/config"
import {
  allowListHookMatcher,
  headerEnvNames,
  mcpAllowListDenial,
  placeholderHeaders,
  resolveHttpHeaders,
  toolAllowed,
} from "../src/agent/mcp-policy"

describe("resolveHttpHeaders", () => {
  it("adds headersEnv values on top of literal headers", () => {
    const h = resolveHttpHeaders(
      { headers: { "x-team": "demo" }, headersEnv: { "x-api-key": "CONNECTOR_KEY" } },
      { CONNECTOR_KEY: " secret-1 " },
    )
    expect(h).toEqual({ "x-team": "demo", "x-api-key": "secret-1" })
  })

  it("leaves out a header whose variable is unset or empty", () => {
    expect(resolveHttpHeaders({ headersEnv: { a: "MISSING", b: "EMPTY" } }, { EMPTY: "  " })).toEqual({})
  })
})

describe("placeholderHeaders", () => {
  it("writes ${NAME} placeholders, never the value", () => {
    process.env.CONNECTOR_KEY_PLACEHOLDER_TEST = "do-not-leak"
    try {
      const h = placeholderHeaders({ headersEnv: { "x-api-key": "CONNECTOR_KEY_PLACEHOLDER_TEST" } })
      expect(h).toEqual({ "x-api-key": "${CONNECTOR_KEY_PLACEHOLDER_TEST}" })
      expect(JSON.stringify(h)).not.toContain("do-not-leak")
    } finally {
      delete process.env.CONNECTOR_KEY_PLACEHOLDER_TEST
    }
  })

  it("is undefined when there are no headers at all", () => {
    expect(placeholderHeaders({})).toBeUndefined()
  })

  it("lists each variable once", () => {
    expect(headerEnvNames({ headersEnv: { a: "K", b: "K", c: "L" } })).toEqual(["K", "L"])
  })
})

describe("toolAllowed", () => {
  it("allows everything without a list and nothing with an empty one", () => {
    expect(toolAllowed(undefined, "anything")).toBe(true)
    expect(toolAllowed([], "anything")).toBe(false)
  })

  it("matches exact names and * wildcards over the whole name", () => {
    const list = ["GET_PAGE_INSIGHTS", "QUERY_*"]
    expect(toolAllowed(list, "GET_PAGE_INSIGHTS")).toBe(true)
    expect(toolAllowed(list, "QUERY_ANALYTICS")).toBe(true)
    expect(toolAllowed(list, "CREATE_POST")).toBe(false)
    expect(toolAllowed(list, "X_QUERY_ANALYTICS")).toBe(false)
    expect(toolAllowed(["a.b"], "aXb")).toBe(false)
  })
})

describe("mcpAllowListDenial", () => {
  const servers = {
    social: { allowTools: ["GET_*"] },
    open: {},
    "social__ads": { allowTools: [] },
  }

  it("refuses a tool left off the list and allows one on it", () => {
    expect(mcpAllowListDenial("mcp__social__GET_INSIGHTS", servers)).toBeNull()
    expect(mcpAllowListDenial("mcp__social__CREATE_POST", servers)).toMatch(/not on the allowTools list of MCP server "social"/)
  })

  it("ignores servers without a list, unknown servers and non-MCP tools", () => {
    expect(mcpAllowListDenial("mcp__open__DELETE", servers)).toBeNull()
    expect(mcpAllowListDenial("mcp__other__DELETE", servers)).toBeNull()
    expect(mcpAllowListDenial("Bash", servers)).toBeNull()
    expect(mcpAllowListDenial("mcp__social__X", undefined)).toBeNull()
  })

  it("prefers the longest matching server name", () => {
    expect(mcpAllowListDenial("mcp__social__ads__GET_X", servers)).toMatch(/server "social__ads"/)
  })
})

describe("allowListHookMatcher", () => {
  it("covers only servers with a list, escaping their names", () => {
    expect(allowListHookMatcher({ a: {}, "b.c": { allowTools: ["x"] }, d: { allowTools: [] } })).toBe("mcp__(b\\.c|d)__.*")
    expect(allowListHookMatcher({ a: {} })).toBeNull()
    expect(allowListHookMatcher(undefined)).toBeNull()
  })
})

describe("allowTools server names (#1698)", () => {
  let dir: string
  const cwd = process.cwd()
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ax-mcp-")) })
  afterEach(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })

  const load = (name: string) => {
    const mcp = { [name]: { type: "http", url: "https://mcp.example.com", allowTools: ["GET_*"] } }
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ node: { id: "n", name: "n" }, agents: { a: { name: "a", workspace: dir, mcp } } }))
    process.chdir(dir)
    return () => loadDaemonConfig(join(dir, "agentx.json"))
  }

  it("refuses a name the hook matcher could miss", () => {
    expect(load("my.social")).toThrow(/letters, digits, _ or -/)
  })

  it("accepts a plain name", () => {
    expect(load("my_social-1")).not.toThrow()
  })
})
