import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { meshPeerTokenChecks, meshTokenChecksFromConfig } from "../src/commands/doctor"

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

describe("meshTokenChecksFromConfig reads tokens as the daemon does", () => {
  const cfg = (token: string) => ({ mesh: { peers: [{ name: "alpha", token }] } })

  it("expands a ${VAR} token and compares it with MESH_TOKEN", () => {
    const c = meshTokenChecksFromConfig(cfg("${ALPHA_TOKEN}"), { ALPHA_TOKEN: "t-shared", MESH_TOKEN: "t-shared" }, {})
    expect(c[0].title).toMatch(/"alpha" uses this node's own MESH_TOKEN/)
    expect(meshTokenChecksFromConfig(cfg("${ALPHA_TOKEN}"), { ALPHA_TOKEN: "t-alpha", MESH_TOKEN: "t-shared" }, {})[0].severity).toBe("ok")
  })

  it("lets an empty variable fall through to .env", () => {
    const c = meshTokenChecksFromConfig(cfg("${ALPHA_TOKEN}"), { ALPHA_TOKEN: "", MESH_TOKEN: "" }, { ALPHA_TOKEN: "t-shared", MESH_TOKEN: "t-shared" })
    expect(c[0].title).toMatch(/uses this node's own MESH_TOKEN/)
  })

  it("treats a ${VAR} set nowhere as no token", () => {
    const c = meshTokenChecksFromConfig(cfg("${ALPHA_TOKEN}"), {}, {})
    expect(c[0].title).toMatch(/"alpha" has no token/)
  })

  it("keeps quotes in a .env value, so a quoted copy is not the same token", () => {
    const c = meshTokenChecksFromConfig(cfg("t-shared"), {}, { MESH_TOKEN: "\"t-shared\"" })
    expect(c[0].severity).toBe("ok")
  })

  it("reads the .env in the working directory by default", () => {
    const prev = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "doctor-mesh-"))
    try {
      writeFileSync(join(dir, ".env"), "ALPHA_TOKEN=t-shared\nMESH_TOKEN=t-shared\n")
      process.chdir(dir)
      const c = meshTokenChecksFromConfig(cfg("${ALPHA_TOKEN}"), {})
      expect(c[0].title).toMatch(/uses this node's own MESH_TOKEN/)
    } finally {
      process.chdir(prev)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
