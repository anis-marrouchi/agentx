import { describe, expect, it } from "vitest"
import { runMeshTokenChecks, type Check } from "../src/commands/doctor"

// `agentx doctor` warns when a mesh peer's token can't name that peer
// (#1100): this node's own MESH_TOKEN, or one token shared by two peers.

function run(peers: Array<{ name: string; url?: string; token?: string }>, env: Record<string, string | undefined> = {}): Check[] {
  const checks: Check[] = []
  runMeshTokenChecks(checks, { mesh: { peers: peers.map((p) => ({ url: "http://peer.example:18800", ...p })) } }, env)
  return checks
}

describe("runMeshTokenChecks", () => {
  it("warns when a peer's token is this node's own MESH_TOKEN, literal or by reference", () => {
    for (const token of ["shared-secret", "${MESH_TOKEN}", "${PEER_B_TOKEN}"]) {
      const [c] = run([{ name: "peer-b", token }], { MESH_TOKEN: "shared-secret", PEER_B_TOKEN: "shared-secret" })
      expect(c.severity).toBe("warn")
      expect(c.title).toContain("peer-b")
      expect(c.title).toContain("own MESH_TOKEN")
    }
  })

  it("warns on a ${MESH_TOKEN} reference even when this shell has no MESH_TOKEN", () => {
    expect(run([{ name: "peer-b", token: "${MESH_TOKEN}" }])[0].severity).toBe("warn")
  })

  it("warns when two peers share one token", () => {
    const [c] = run([{ name: "peer-b", token: "pair-token" }, { name: "peer-c", token: "pair-token" }], { MESH_TOKEN: "node-token" })
    expect(c.severity).toBe("warn")
    expect(c.title).toMatch(/"peer-b", "peer-c" share one token/)
  })

  it("is ok when every peer has a token of its own", () => {
    const checks = run([{ name: "peer-b", token: "b-token" }, { name: "peer-c", token: "${PEER_C_TOKEN}" }], { MESH_TOKEN: "node-token", PEER_C_TOKEN: "c-token" })
    expect(checks).toEqual([expect.objectContaining({ severity: "ok", group: "Mesh" })])
  })

  it("says nothing without peer tokens", () => {
    expect(run([])).toEqual([])
    expect(run([{ name: "peer-b" }], { MESH_TOKEN: "node-token" })).toEqual([])
  })
})
