import { describe, it, expect, vi, afterEach } from "vitest"
import { dashboardTokenForNode } from "../src/daemon/mesh-auth"
import { resolveNodeTargets } from "../src/daemon/board-dashboard"

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

  it("falls back to MESH_TOKEN for a primary with no dashboard.token", () => {
    expect(dashboardTokenForNode({ ...dashboard, token: "" }, "http://127.0.0.1:18800", env)).toBe("mesh-secret")
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

describe("resolveNodeTargets", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("gives mesh-discovered peers the MESH_TOKEN so the live snapshot can read them", async () => {
    vi.stubEnv("MESH_TOKEN", "mesh-secret")
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ peer: "vps", peerUrl: "http://vps:18800/" }])))
    vi.stubGlobal("fetch", fetchMock)
    const daemon = {
      dashboard: { daemonUrl: "http://127.0.0.1:18800", token: "", daemons: [{ name: "mini", url: "http://mini:18800", token: "mini-token" }] },
    } as any

    const targets = await resolveNodeTargets(daemon)

    expect(targets).toEqual([
      { name: "primary", url: "http://127.0.0.1:18800", token: "mesh-secret" },
      { name: "mini", url: "http://mini:18800", token: "mini-token" },
      { name: "vps", url: "http://vps:18800", token: "mesh-secret" },
    ])
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:18800/mesh", expect.objectContaining({
      headers: { Authorization: "Bearer mesh-secret" },
    }))
  })
})
