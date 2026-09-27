import { describe, it, expect } from "vitest"
import { decideMeshAuth, collectAcceptedMeshTokens, isMeshGatedPath, isControlPost, dashboardTokenForNode } from "../src/daemon/mesh-auth"

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
      remoteAddress: "100.64.0.11",
      authorizationHeader: "Bearer shared-mesh-token",
      acceptedTokens: TOKENS,
    })
    expect(d).toEqual({ allowed: true, reason: "token" })
  })

  it("accepts any configured token (peer token, not just MESH_TOKEN)", () => {
    const d = decideMeshAuth({
      remoteAddress: "100.64.0.11",
      authorizationHeader: "Bearer peer-b-token",
      acceptedTokens: TOKENS,
    })
    expect(d.allowed).toBe(true)
  })

  it("rejects non-loopback callers with no token", () => {
    const d = decideMeshAuth({
      remoteAddress: "100.64.0.11",
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
      remoteAddress: "100.64.0.11",
      authorizationHeader: "",
      acceptedTokens: new Set(),
    })
    expect(d).toEqual({ allowed: true, reason: "no-tokens-configured" })
  })

  it("escape hatch: AGENTX_MESH_AUTH=off disables enforcement", () => {
    const d = decideMeshAuth({
      remoteAddress: "100.64.0.11",
      authorizationHeader: "",
      acceptedTokens: TOKENS,
      enforcementDisabled: true,
    })
    expect(d).toEqual({ allowed: true, reason: "disabled" })
  })
})

describe("collectAcceptedMeshTokens", () => {
  const config = {
    mesh: { peers: [{ token: "peer-a" }, { token: "peer-b" }, {}] },
    dashboard: { token: "agx_dash_secret" },
  }

  it("accepts MESH_TOKEN and every per-peer token", () => {
    const got = collectAcceptedMeshTokens(config, { MESH_TOKEN: "env-token" })
    expect([...got].sort()).toEqual(["env-token", "peer-a", "peer-b"])
  })

  it("never accepts dashboard.token on a write path", () => {
    // Regression guard. dashboard.token used to be accepted here, which made
    // the dashboard secret sufficient to POST /task, /channel/send, and the
    // GitLab/GitHub peer-identity forwards that post as this node's bot.
    const got = collectAcceptedMeshTokens(config, { MESH_TOKEN: "env-token" })
    expect(got.has("agx_dash_secret")).toBe(false)
  })

  it("returns an empty set when nothing is configured, so the grace path still applies", () => {
    expect(collectAcceptedMeshTokens({}, {}).size).toBe(0)
  })

  it("ignores peers with no token rather than adding undefined", () => {
    const got = collectAcceptedMeshTokens({ mesh: { peers: [{}, { token: "" }] } }, {})
    expect(got.size).toBe(0)
  })
})

describe("isMeshGatedPath — routes gated for every method", () => {
  it("gates the agent-memory API, reads and item paths included", () => {
    expect(isMeshGatedPath("/api/memory")).toBe(true)
    expect(isMeshGatedPath("/api/memory/no-mock-db")).toBe(true)
  })

  it("does not gate look-alike or unrelated paths", () => {
    expect(isMeshGatedPath("/api/memoryx")).toBe(false)
    expect(isMeshGatedPath("/api/mesh")).toBe(false)
    expect(isMeshGatedPath("/health")).toBe(false)
  })

  it("an off-box memory read without a token is refused; the local agent's curl is not", () => {
    const tokens = new Set(["mesh-secret"])
    expect(decideMeshAuth({ remoteAddress: "100.64.0.9", authorizationHeader: "", acceptedTokens: tokens }).allowed).toBe(false)
    expect(decideMeshAuth({ remoteAddress: "127.0.0.1", authorizationHeader: "", acceptedTokens: tokens }).allowed).toBe(true)
    expect(decideMeshAuth({ remoteAddress: "100.64.0.9", authorizationHeader: "Bearer mesh-secret", acceptedTokens: tokens }).allowed).toBe(true)
  })
})

describe("isControlPost — daemon control routes need a mesh token off-box", () => {
  it("gates reload, task cancel/followup, process kill and channel sends", () => {
    for (const p of ["/reload", "/api/tasks/t-1/cancel", "/api/tasks/t-1/followup", "/api/processes/kill", "/send", "/send/agent", "/send/contact"]) {
      expect(isControlPost(p)).toBe(true)
    }
  })

  it("does not gate look-alike or read paths", () => {
    for (const p of ["/api/tasks", "/api/tasks/t-1", "/api/tasks/t-1/cancel/x", "/api/tasks//cancel", "/api/processes", "/sendx", "/reload/x", "/health"]) {
      expect(isControlPost(p)).toBe(false)
    }
  })

  it("an off-box call without a token is refused; loopback stays exempt", () => {
    const tokens = new Set(["mesh-secret"])
    expect(decideMeshAuth({ remoteAddress: "100.64.0.9", authorizationHeader: "", acceptedTokens: tokens }).allowed).toBe(false)
    expect(decideMeshAuth({ remoteAddress: "::1", authorizationHeader: "", acceptedTokens: tokens }).allowed).toBe(true)
    expect(decideMeshAuth({ remoteAddress: "100.64.0.9", authorizationHeader: "Bearer mesh-secret", acceptedTokens: tokens }).allowed).toBe(true)
  })
})

describe("dashboardTokenForNode", () => {
  const dashboard = {
    daemonUrl: "http://127.0.0.1:18800/",
    token: "dash-token",
    daemons: [{ url: "http://mini:18800/", token: "mini-token" }, { url: "http://bare:18800" }],
  }
  const env = { MESH_TOKEN: "mesh-secret" }

  it("uses dashboard.token for the primary daemon", () => {
    expect(dashboardTokenForNode(dashboard, "http://127.0.0.1:18800", env)).toBe("dash-token")
  })

  it("uses a configured daemon's own token", () => {
    expect(dashboardTokenForNode(dashboard, "http://mini:18800", env)).toBe("mini-token")
  })

  it("falls back to MESH_TOKEN for a peer found only through /mesh or configured without a token", () => {
    expect(dashboardTokenForNode(dashboard, "http://vps:18800", env)).toBe("mesh-secret")
    expect(dashboardTokenForNode(dashboard, "http://bare:18800", env)).toBe("mesh-secret")
  })

  it("sends nothing when there is no token to send", () => {
    expect(dashboardTokenForNode(dashboard, "http://vps:18800", {})).toBeUndefined()
  })
})
