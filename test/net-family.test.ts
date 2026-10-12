import net from "node:net"
import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyConnectAttemptTimeout, configPathFromArgv, readConnectAttemptTimeout } from "../src/daemon/net-family"

const original = net.getDefaultAutoSelectFamilyAttemptTimeout()

afterEach(() => { net.setDefaultAutoSelectFamilyAttemptTimeout(original) })

describe("applyConnectAttemptTimeout (#930)", () => {
  it("raises Node's 250 ms per-address connect attempt timeout", () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250)
    expect(applyConnectAttemptTimeout(5000)).toBe(5000)
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5000)
  })

  it("never lowers a larger value set on the command line", () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(10_000)
    expect(applyConnectAttemptTimeout(5000)).toBe(10_000)
  })
})

describe("readConnectAttemptTimeout (#930, CLI)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "agentx-net-"))

  it("reads node.connectAttemptTimeoutMs from agentx.json", () => {
    const d = dir()
    writeFileSync(join(d, "agentx.json"), JSON.stringify({ node: { connectAttemptTimeoutMs: 8000 } }))
    expect(readConnectAttemptTimeout(d)).toBe(8000)
  })

  it("reads .agentx/config.json when there is no agentx.json", () => {
    const d = dir()
    mkdirSync(join(d, ".agentx"))
    writeFileSync(join(d, ".agentx/config.json"), JSON.stringify({ node: { connectAttemptTimeoutMs: 3000 } }))
    expect(readConnectAttemptTimeout(d)).toBe(3000)
  })

  it("falls back to 5000 ms with no file, an invalid file or an out-of-range value", () => {
    expect(readConnectAttemptTimeout(dir())).toBe(5000)
    const bad = dir()
    writeFileSync(join(bad, "agentx.json"), "{ not json")
    expect(readConnectAttemptTimeout(bad)).toBe(5000)
    const low = dir()
    writeFileSync(join(low, "agentx.json"), JSON.stringify({ node: { connectAttemptTimeoutMs: 10 } }))
    expect(readConnectAttemptTimeout(low)).toBe(5000)
  })

  it("reads the config file given by hand, not the one in the current folder", () => {
    const d = dir()
    writeFileSync(join(d, "agentx.json"), JSON.stringify({ node: { connectAttemptTimeoutMs: 8000 } }))
    const other = dir()
    writeFileSync(join(other, "node.json"), JSON.stringify({ node: { connectAttemptTimeoutMs: 1500 } }))
    expect(readConnectAttemptTimeout(d, join(other, "node.json"))).toBe(1500)
    expect(readConnectAttemptTimeout(d, join(other, "missing.json"))).toBe(5000)
  })
})

describe("configPathFromArgv (#930, CLI)", () => {
  it("finds --config in either form and -c when it names a .json file", () => {
    expect(configPathFromArgv(["daemon", "start", "--config", "/etc/agentx/node.json"])).toBe("/etc/agentx/node.json")
    expect(configPathFromArgv(["daemon", "start", "--config=/etc/agentx/node.json"])).toBe("/etc/agentx/node.json")
    expect(configPathFromArgv(["daemon", "start", "-c", "/etc/agentx/node.json"])).toBe("/etc/agentx/node.json")
  })

  it("ignores -c naming a folder (--cwd), arguments after --, and no flag", () => {
    expect(configPathFromArgv(["skill", "list", "-c", "/srv/project"])).toBeUndefined()
    expect(configPathFromArgv(["exec", "--", "--config", "x.json"])).toBeUndefined()
    expect(configPathFromArgv(["status"])).toBeUndefined()
  })
})
