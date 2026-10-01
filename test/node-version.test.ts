import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { nodeVersionSupported, unsupportedNodeMessage } from "../src/utils/node-version"

// The CLI and `agentx doctor` accept the same Node range as package.json "engines".
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

describe("unsupportedNodeMessage", () => {
  it("is one line naming the version needed and the one found", () => {
    for (const v of ["20.20.2", "22.18.0", "27.0.0"]) {
      const message = unsupportedNodeMessage(v)
      expect(message, v).toContain("22.19")
      expect(message, v).toContain(v)
      expect(message, v).not.toContain("\n")
    }
  })

  it("says nothing on a supported version", () => {
    expect(unsupportedNodeMessage("22.19.0")).toBeNull()
  })
})

// Static imports load before any code in the file runs, and a dependency
// fails to load on Node 20 (#403). So the entry may import only the check
// statically; everything else comes after it.
describe("src/cli.ts", () => {
  const source = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8")

  it("statically imports nothing but the Node check", () => {
    const statics = source.split("\n").filter((line) => /^import\s/.test(line))
    expect(statics).toEqual(['import { unsupportedNodeMessage } from "@/utils/node-version"'])
  })

  it("checks the version before it loads the program", () => {
    const check = source.indexOf("unsupportedNodeMessage(process.versions.node)")
    const load = source.indexOf('await import("@/program")')
    expect(check).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(check)
  })
})
