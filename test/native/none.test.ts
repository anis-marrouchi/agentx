import { describe, expect, it } from "vitest"
import { loadNativeAdapter, noneAdapter } from "../../src/native"
import { runNativeContract } from "./contract"

runNativeContract("none", () => noneAdapter("test"))

describe("loadNativeAdapter (#1062)", () => {
  it("gives none on a platform with no adapter", async () => {
    const a = loadNativeAdapter({}, { platform: "linux", factories: {} })
    expect(a.os).toBe("none")
    expect((await a.describe()).problems[0]).toMatch(/no native adapter for linux/)
  })

  it("uses the adapter registered for the platform on auto", () => {
    const fake = { ...noneAdapter("x"), os: "macos" as const }
    expect(loadNativeAdapter({ native: { adapter: "auto" } }, { platform: "darwin", factories: { darwin: () => fake } })).toBe(fake)
  })

  it("forces none when native.adapter is none, even with an adapter for the platform", async () => {
    const a = loadNativeAdapter({ native: { adapter: "none" } }, { platform: "darwin", factories: { darwin: () => { throw new Error("must not build") } } })
    expect(a.os).toBe("none")
    expect((await a.describe()).problems[0]).toMatch(/native.adapter/)
  })
})

describe("doctor Native line (#1062)", () => {
  it("prints one ok line when the machine has no adapter", async () => {
    const { runNativeChecks } = await import("../../src/commands/doctor")
    const checks: any[] = []
    await runNativeChecks(checks, {}, noneAdapter("AgentX has no native adapter for linux yet."))
    expect(checks).toEqual([expect.objectContaining({ severity: "ok", group: "Native", title: "Native apps: none on this machine" })])
  })

  it("lists what an OS adapter offers, with its problems as detail", async () => {
    const { runNativeChecks } = await import("../../src/commands/doctor")
    const checks: any[] = []
    const adapter = {
      os: "macos" as const,
      banner: {} as any,
      async describe() {
        return { os: "macos" as const, tasks: false, notes: false, banner: true, sound: false, focus: false, problems: ["remindctl not found."] }
      },
    }
    await runNativeChecks(checks, {}, adapter)
    expect(checks[0]).toMatchObject({ severity: "ok", title: "Native apps (macos): banner", detail: "remindctl not found." })
  })

  it("warns instead of failing doctor when the adapter throws", async () => {
    const { runNativeChecks } = await import("../../src/commands/doctor")
    const checks: any[] = []
    await runNativeChecks(checks, {}, { os: "macos", async describe() { throw new Error("boom") } })
    expect(checks[0]).toMatchObject({ severity: "warn", title: "Native apps: could not be read", detail: "boom" })
  })
})
