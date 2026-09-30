import { describe, expect, it } from "vitest"
import { nodeVersionSupported } from "../src/commands/doctor"

// `agentx doctor` accepts the same Node range as package.json "engines".
describe("nodeVersionSupported", () => {
  it("accepts 22.19 and newer, up to 26", () => {
    for (const v of ["22.19.0", "22.22.0", "23.11.1", "24.21.0", "25.6.1", "26.10.0"]) {
      expect(nodeVersionSupported(v), v).toBe(true)
    }
  })

  it("rejects older 22.x, older majors and 27+", () => {
    for (const v of ["22.18.0", "22.0.0", "20.19.0", "27.0.0"]) {
      expect(nodeVersionSupported(v), v).toBe(false)
    }
  })

  it("matches package.json engines", async () => {
    const { engines } = await import("../package.json")
    expect(engines.node).toBe(">=22.19.0 <27")
  })
})
