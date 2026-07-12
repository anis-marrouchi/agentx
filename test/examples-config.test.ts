import { readFileSync, readdirSync, existsSync } from "fs"
import { join } from "path"
import { describe, it, expect } from "vitest"
import { daemonConfigSchema } from "../src/daemon/config"

// Every example config must validate against the live schema — broken
// examples in a public repo are worse than none.
const examplesDir = join(__dirname, "..", "examples")
const scenarios = readdirSync(examplesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(examplesDir, d.name, "agentx.json")))
  .map((d) => d.name)

describe("examples/ configs validate against daemonConfigSchema", () => {
  it("found the scenario examples", () => {
    expect(scenarios).toEqual(
      expect.arrayContaining(["solo-founder", "agency", "civic", "maintainer-fleet"]),
    )
  })

  for (const name of scenarios) {
    it(`examples/${name}/agentx.json parses`, () => {
      const raw = JSON.parse(readFileSync(join(examplesDir, name, "agentx.json"), "utf8"))
      const result = daemonConfigSchema.safeParse(raw)
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues, null, 2))
      }
    })
  }

  it("root agentx.example.json parses", () => {
    const raw = JSON.parse(readFileSync(join(examplesDir, "..", "agentx.example.json"), "utf8"))
    const result = daemonConfigSchema.safeParse(raw)
    if (!result.success) {
      throw new Error(JSON.stringify(result.error.issues, null, 2))
    }
  })
})
