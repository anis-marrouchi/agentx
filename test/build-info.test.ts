import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { buildInfo } from "../src/utils/build-info"

describe("buildInfo (GET /health version fields)", () => {
  it("falls back to package.json and a null commit when run from source", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"))
    expect(buildInfo.version).toBe(pkg.version)
    expect(buildInfo.commit).toBeNull()
  })

  it("reports when the process started, not when the module loaded", () => {
    const started = Date.parse(buildInfo.startedAt)
    expect(new Date(started).toISOString()).toBe(buildInfo.startedAt)
    expect(started).toBeLessThanOrEqual(Date.now())
    expect(Math.abs(started - (Date.now() - process.uptime() * 1000))).toBeLessThan(1000)
  })

  it("adds no paths or environment values", () => {
    expect(Object.keys(buildInfo).sort()).toEqual(["commit", "startedAt", "version"])
    for (const v of Object.values(buildInfo)) expect(String(v)).not.toMatch(/[\/\\]/)
  })
})
