import { describe, it, expect } from "vitest"
import { encodeInvite, decodeInvite } from "../src/connect/mesh"

describe("mesh invite URL", () => {
  it("round-trips a payload", () => {
    const p = { url: "http://100.67.108.119:19900", token: "abcd".repeat(16), name: "clawd-server", version: 1 as const }
    const link = encodeInvite(p)
    expect(link).toMatch(/^agentx-mesh:\/\/join\//)
    expect(decodeInvite(link)).toEqual(p)
  })

  it("rejects non-invite strings", () => {
    expect(() => decodeInvite("https://example.com")).toThrow(/mesh invite/)
    expect(() => decodeInvite("agentx-mesh://pair/foo")).toThrow(/mesh invite/)
  })

  it("rejects unsupported versions", () => {
    // Build a link with version 99 manually
    const payload = { url: "http://x", token: "y", name: "z", version: 99 }
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
    expect(() => decodeInvite(`agentx-mesh://join/${b64}`)).toThrow(/Unsupported invite version/)
  })

  it("rejects payloads missing required fields", () => {
    const b64 = Buffer.from(JSON.stringify({ version: 1, url: "http://x" })).toString("base64url")
    expect(() => decodeInvite(`agentx-mesh://join/${b64}`)).toThrow(/required fields/)
  })
})
