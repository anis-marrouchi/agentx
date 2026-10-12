import net from "node:net"
import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyConnectAttemptTimeout, readConnectAttemptTimeout } from "../src/daemon/net-family"

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
})
