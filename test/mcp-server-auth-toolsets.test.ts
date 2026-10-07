import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  _daemonFetchForTesting,
  _resetDaemonUrlForTesting,
  _resolveDaemonTokenForTesting,
  _resolveDaemonUrlForTesting,
  listedTools,
  negotiateProtocolVersion,
  toolInSet,
  toolSetTools,
} from "../src/mcp"
import { AGENTX_TOOL_NAMES, READ_TOOL_NAMES, isMcpToolSet } from "../src/mcp/tool-names"

// #794 — step 1 of the MCP connector plan: every daemon call carries the
// node's token, the last-resort URL is the daemon's default port, the
// protocol version is negotiated, and `serve --tools read` offers only
// tools that change nothing.

let dir: string
let cwd: string
const saved = {
  AGENTX_DAEMON_URL: process.env.AGENTX_DAEMON_URL,
  AGENTX_TOKEN: process.env.AGENTX_TOKEN,
  MESH_TOKEN: process.env.MESH_TOKEN,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-"))
  cwd = process.cwd()
  process.chdir(dir)
  delete process.env.AGENTX_DAEMON_URL
  delete process.env.AGENTX_TOKEN
  delete process.env.MESH_TOKEN
  _resetDaemonUrlForTesting()
})

afterEach(() => {
  process.chdir(cwd)
  rmSync(dir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetDaemonUrlForTesting()
  vi.unstubAllGlobals()
})

describe("daemon token", () => {
  it("prefers AGENTX_TOKEN", () => {
    expect(_resolveDaemonTokenForTesting({ AGENTX_TOKEN: "a", MESH_TOKEN: "m" })).toBe("a")
  })

  it("falls back to MESH_TOKEN, then the install's .env", () => {
    expect(_resolveDaemonTokenForTesting({ MESH_TOKEN: "m" })).toBe("m")
    writeFileSync(join(dir, ".env"), "OTHER=1\nexport MESH_TOKEN=\"from-file\"\n")
    expect(_resolveDaemonTokenForTesting({})).toBe("from-file")
  })

  it("falls back to dashboard.token in the node config", () => {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ dashboard: { token: "dash" } }))
    expect(_resolveDaemonTokenForTesting({})).toBe("dash")
  })

  it("is empty when nothing names one", () => {
    expect(_resolveDaemonTokenForTesting({})).toBe("")
  })
})

describe("daemon calls", () => {
  it("send Authorization: Bearer <token>", async () => {
    process.env.AGENTX_TOKEN = "secret"
    const calls: Array<[unknown, RequestInit | undefined]> = []
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      calls.push([input, init])
      return new Response("{}")
    })
    await _daemonFetchForTesting("http://localhost:18800/health", { headers: { "Content-Type": "application/json" } })
    const headers = new Headers(calls[0][1]?.headers)
    expect(headers.get("Authorization")).toBe("Bearer secret")
    expect(headers.get("Content-Type")).toBe("application/json")
  })

  it("send no header when there is no token", async () => {
    let seen: RequestInit | undefined
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      seen = init
      return new Response("{}")
    })
    await _daemonFetchForTesting("http://localhost:18800/health")
    expect(new Headers(seen?.headers).has("Authorization")).toBe(false)
  })

  it("default to the daemon's own port", () => {
    expect(_resolveDaemonUrlForTesting()).toBe("http://localhost:18800")
  })
})

describe("protocol version", () => {
  it("answers with the client's version when supported", () => {
    expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18")
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05")
  })

  it("falls back to 2024-11-05 otherwise", () => {
    expect(negotiateProtocolVersion("1999-01-01")).toBe("2024-11-05")
    expect(negotiateProtocolVersion(undefined)).toBe("2024-11-05")
  })
})

describe("tool sets", () => {
  it("full lists every tool, as before", () => {
    expect(listedTools({}, "full").map((t) => t.name)).toEqual([...AGENTX_TOOL_NAMES])
  })

  it("read lists only the read tools, all of which exist", () => {
    const names = toolSetTools("read").map((t) => t.name)
    expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort())
  })

  it("read refuses a tool that acts", () => {
    expect(toolInSet("agentx_send", "read")).toBe(false)
    expect(toolInSet("agentx_health", "read")).toBe(true)
    expect(toolInSet("agentx_send", "full")).toBe(true)
  })

  it("AGENTX_MCP_TOOLS narrows within the set", () => {
    const env = { AGENTX_MCP_TOOLS: "agentx_send,agentx_health" }
    expect(listedTools(env, "read").map((t) => t.name)).toEqual(["agentx_health"])
  })

  it("accepts only known set names", () => {
    expect(isMcpToolSet("read")).toBe(true)
    expect(isMcpToolSet("full")).toBe(true)
    expect(isMcpToolSet("write")).toBe(false)
  })
})
