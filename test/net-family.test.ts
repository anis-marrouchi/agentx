import net from "node:net"
import { describe, it, expect, afterEach } from "vitest"
import { applyConnectAttemptTimeout } from "../src/daemon/net-family"

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
