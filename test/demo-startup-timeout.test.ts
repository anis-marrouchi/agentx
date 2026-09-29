import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  adaptiveStartupTimeout,
  configStartupTimeout,
  resolveStartupTimeout,
} from "../src/commands/demo-startup"
import { demo } from "../src/commands/demo"

let dir: string | undefined

function folderWith(config?: object): string {
  dir = mkdtempSync(join(tmpdir(), "agentx-demo-startup-"))
  if (config) writeFileSync(join(dir, "agentx.json"), JSON.stringify(config))
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("adaptiveStartupTimeout", () => {
  it("is 60 s when the load is at or under the CPU count", () => {
    expect(adaptiveStartupTimeout(0, 8)).toBe(60)
    expect(adaptiveStartupTimeout(8, 8)).toBe(60)
  })

  it("scales with load per CPU", () => {
    expect(adaptiveStartupTimeout(12, 8)).toBe(90)
    expect(adaptiveStartupTimeout(16, 8)).toBe(120)
  })

  it("is capped at 300 s", () => {
    expect(adaptiveStartupTimeout(400, 8)).toBe(300)
  })

  it("survives a zero CPU count", () => {
    expect(adaptiveStartupTimeout(2, 0)).toBe(120)
  })
})

describe("resolveStartupTimeout", () => {
  const idle = { load1: 1, cpuCount: 8 }

  it("prefers the flag over env and config", () => {
    expect(resolveStartupTimeout({ ...idle, flag: "90", env: "45", config: 30 })).toEqual({ seconds: 90, source: "--startup-timeout" })
  })

  it("uses the env var when there is no flag", () => {
    expect(resolveStartupTimeout({ ...idle, env: "45", config: 30 })).toEqual({ seconds: 45, source: "AGENTX_DEMO_STARTUP_TIMEOUT" })
  })

  it("uses config when neither flag nor env is set", () => {
    expect(resolveStartupTimeout({ ...idle, env: "", config: 30 })).toEqual({ seconds: 30, source: "demo.startupTimeoutSeconds" })
  })

  it("falls back to the load-aware default", () => {
    const r = resolveStartupTimeout({ load1: 16, cpuCount: 8 })
    expect(r.seconds).toBe(120)
    expect(r.source).toMatch(/load 16\.0 on 8 CPUs/)
  })

  it("rejects values that are not a positive number", () => {
    expect(() => resolveStartupTimeout({ ...idle, flag: "soon" })).toThrow(/--startup-timeout/)
    expect(() => resolveStartupTimeout({ ...idle, env: "0" })).toThrow(/AGENTX_DEMO_STARTUP_TIMEOUT/)
  })
})

describe("configStartupTimeout", () => {
  it("is undefined when the folder has no agentx.json", () => {
    expect(configStartupTimeout(folderWith())).toBeUndefined()
  })

  it("is undefined when agentx.json has no demo block", () => {
    expect(configStartupTimeout(folderWith({ node: { id: "x", name: "x" } }))).toBeUndefined()
  })

  it("reads demo.startupTimeoutSeconds", () => {
    expect(configStartupTimeout(folderWith({ demo: { startupTimeoutSeconds: 180 } }))).toBe(180)
  })

  it("refuses an invalid value instead of ignoring it", () => {
    expect(() => configStartupTimeout(folderWith({ demo: { startupTimeoutSeconds: -5 } }))).toThrow(/startupTimeoutSeconds/)
  })
})

describe("agentx demo", () => {
  it("offers --startup-timeout", () => {
    expect(demo.options.map((o) => o.long)).toContain("--startup-timeout")
  })
})
