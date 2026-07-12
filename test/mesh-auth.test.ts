import { describe, it, expect } from "vitest"
import { decideMeshAuth } from "../src/daemon/mesh-auth"

const TOKENS = new Set(["shared-mesh-token", "peer-b-token"])

describe("decideMeshAuth", () => {
  it("always allows loopback callers", () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const d = decideMeshAuth({
        remoteAddress: addr,
        authorizationHeader: "",
        acceptedTokens: TOKENS,
      })
      expect(d).toEqual({ allowed: true, reason: "loopback" })
    }
  })

  it("allows non-loopback callers with a valid Bearer token", () => {
    const d = decideMeshAuth({
      remoteAddress: "100.67.108.119",
      authorizationHeader: "Bearer shared-mesh-token",
      acceptedTokens: TOKENS,
    })
    expect(d).toEqual({ allowed: true, reason: "token" })
  })

  it("accepts any configured token (peer token, not just MESH_TOKEN)", () => {
    const d = decideMeshAuth({
      remoteAddress: "100.67.108.119",
      authorizationHeader: "Bearer peer-b-token",
      acceptedTokens: TOKENS,
    })
    expect(d.allowed).toBe(true)
  })

  it("rejects non-loopback callers with no token", () => {
    const d = decideMeshAuth({
      remoteAddress: "100.67.108.119",
      authorizationHeader: "",
      acceptedTokens: TOKENS,
    })
    expect(d).toEqual({ allowed: false, reason: "missing-or-invalid-token" })
  })

  it("rejects wrong tokens and non-Bearer schemes", () => {
    expect(
      decideMeshAuth({
        remoteAddress: "192.168.1.20",
        authorizationHeader: "Bearer wrong-token",
        acceptedTokens: TOKENS,
      }).allowed,
    ).toBe(false)
    expect(
      decideMeshAuth({
        remoteAddress: "192.168.1.20",
        authorizationHeader: "Basic c2hhcmVkLW1lc2gtdG9rZW4=",
        acceptedTokens: TOKENS,
      }).allowed,
    ).toBe(false)
  })

  it("tolerates surrounding whitespace in the Bearer value", () => {
    const d = decideMeshAuth({
      remoteAddress: "10.0.0.5",
      authorizationHeader: "Bearer  shared-mesh-token ",
      acceptedTokens: TOKENS,
    })
    expect(d.allowed).toBe(true)
  })

  it("grace path: allows (with reason) when no tokens are configured at all", () => {
    const d = decideMeshAuth({
      remoteAddress: "100.67.108.119",
      authorizationHeader: "",
      acceptedTokens: new Set(),
    })
    expect(d).toEqual({ allowed: true, reason: "no-tokens-configured" })
  })

  it("escape hatch: AGENTX_MESH_AUTH=off disables enforcement", () => {
    const d = decideMeshAuth({
      remoteAddress: "100.67.108.119",
      authorizationHeader: "",
      acceptedTokens: TOKENS,
      enforcementDisabled: true,
    })
    expect(d).toEqual({ allowed: true, reason: "disabled" })
  })
})
