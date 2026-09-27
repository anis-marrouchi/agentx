import { describe, it, expect } from "vitest"
import { nodeToken } from "../src/daemon/board-dashboard"

const dash = {
  daemonUrl: "http://127.0.0.1:18800/",
  token: "",
  daemons: [{ name: "peer-a", url: "http://peer-a:18800", token: "peer-a-token" }],
} as any

describe("nodeToken", () => {
  it("prefers the token configured for that node", () => {
    expect(nodeToken(dash, "http://peer-a:18800/", { MESH_TOKEN: "mesh" })).toBe("peer-a-token")
    expect(nodeToken({ ...dash, token: "dash" }, "http://127.0.0.1:18800", { MESH_TOKEN: "mesh" })).toBe("dash")
  })

  it("falls back to MESH_TOKEN for the primary and for mesh-discovered peers", () => {
    expect(nodeToken(dash, "http://127.0.0.1:18800", { MESH_TOKEN: "mesh" })).toBe("mesh")
    expect(nodeToken(dash, "http://peer-b:19900", { MESH_TOKEN: "mesh" })).toBe("mesh")
  })

  it("returns undefined when nothing is configured", () => {
    expect(nodeToken(dash, "http://peer-b:19900", {})).toBeUndefined()
  })
})
