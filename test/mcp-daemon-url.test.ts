import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { _resolveDaemonUrlForTesting } from "../src/mcp"

// The MCP server used to hardcode http://localhost:19900 as the daemon. That
// is one node's port, so every daemon-backed tool died with a bare "fetch
// failed" on any node bound elsewhere — exactly the failure that hid a
// working secretary behind a broken channel.reply.

let dir: string
let cwd: string
const savedEnv = process.env.AGENTX_DAEMON_URL

function writeConfig(bind: unknown, rel = "agentx.json") {
  const path = join(dir, rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify({ node: { id: "n", name: "N", bind } }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-daemon-url-"))
  cwd = process.cwd()
  process.chdir(dir)
  delete process.env.AGENTX_DAEMON_URL
})

afterEach(() => {
  process.chdir(cwd)
  rmSync(dir, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env.AGENTX_DAEMON_URL
  else process.env.AGENTX_DAEMON_URL = savedEnv
})

describe("MCP daemon URL resolution", () => {
  it("reads the port the daemon actually binds", () => {
    writeConfig("127.0.0.1:18800")
    expect(_resolveDaemonUrlForTesting()).toBe("http://127.0.0.1:18800")
  })

  it("dials loopback when the bind host is a wildcard", () => {
    writeConfig("0.0.0.0:18800")
    expect(_resolveDaemonUrlForTesting()).toBe("http://127.0.0.1:18800")
  })

  it("keeps a real bind host as-is", () => {
    writeConfig("100.64.0.1:19900")
    expect(_resolveDaemonUrlForTesting()).toBe("http://100.64.0.1:19900")
  })

  it("falls back to .agentx/config.json", () => {
    writeConfig("127.0.0.1:12345", ".agentx/config.json")
    expect(_resolveDaemonUrlForTesting()).toBe("http://127.0.0.1:12345")
  })

  it("lets AGENTX_DAEMON_URL override the config, for pointing at a remote node", () => {
    writeConfig("127.0.0.1:18800")
    process.env.AGENTX_DAEMON_URL = "http://clawd.internal:19900"
    expect(_resolveDaemonUrlForTesting()).toBe("http://clawd.internal:19900")
  })

  it("keeps the legacy default when there is no config at all", () => {
    expect(_resolveDaemonUrlForTesting()).toBe("http://localhost:19900")
  })

  it("keeps the legacy default when the config is unparseable", () => {
    writeFileSync(join(dir, "agentx.json"), "{ not json")
    expect(_resolveDaemonUrlForTesting()).toBe("http://localhost:19900")
  })

  it("keeps the legacy default when bind is missing or malformed", () => {
    writeConfig("18800")
    expect(_resolveDaemonUrlForTesting()).toBe("http://localhost:19900")
  })
})
