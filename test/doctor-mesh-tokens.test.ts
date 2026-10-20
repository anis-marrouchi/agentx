import { describe, expect, it } from "vitest"
import { meshPeerTokenChecks } from "../src/commands/doctor"

// `agentx doctor` warns when a mesh peer has no token of its own, or uses
// this node's MESH_TOKEN: the daemon then can't tell which peer is calling.

describe("meshPeerTokenChecks", () => {
  it("is ok when every peer has a token of its own", () => {
    const c = meshPeerTokenChecks([{ name: "alpha", token: "t-alpha" }, { name: "beta", token: "t-beta" }], "t-shared")
    expect(c).toHaveLength(1)
    expect(c[0].severity).toBe("ok")
  })

  it("warns, never fails, on a peer with no token", () => {
    const c = meshPeerTokenChecks([{ name: "alpha" }, { name: "beta", token: "  " }], "t-shared")
    expect(c.map((x) => x.severity)).toEqual(["warn", "warn"])
    expect(c[0].title).toMatch(/"alpha" has no token/)
    expect(c[0].detail).toMatch(/cannot tell which peer is calling/)
  })

  it("warns on a peer whose token is this node's own mesh token", () => {
    const c = meshPeerTokenChecks([{ name: "alpha", token: "t-shared" }, { name: "beta", token: "t-beta" }], "t-shared")
    expect(c).toHaveLength(1)
    expect(c[0].severity).toBe("warn")
    expect(c[0].title).toMatch(/"alpha" uses this node's own MESH_TOKEN/)
    expect(c[0].detail).toMatch(/approval card/)
  })

  it("says nothing when there are no peers", () => {
    expect(meshPeerTokenChecks([], "t-shared")).toEqual([])
  })
})
