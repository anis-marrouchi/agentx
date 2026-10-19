import { describe, expect, it } from "vitest"
import type { NativeAdapter } from "../../src/native"

// #1062: the cases every NativeAdapter passes, whatever the OS. An OS
// adapter's own test calls runNativeContract with a factory that fakes the
// OS programs, so the same cases run on any machine in CI.

const CAPABILITIES = ["tasks", "notes", "banner", "sound", "focus"] as const

export function runNativeContract(name: string, make: () => NativeAdapter): void {
  describe(`NativeAdapter contract: ${name}`, () => {
    it("names a known OS", () => {
      expect(["macos", "windows", "none"]).toContain(make().os)
    })

    it("describe() never throws and matches what the adapter offers", async () => {
      const adapter = make()
      const d = await adapter.describe()
      expect(d.os).toBe(adapter.os)
      for (const c of CAPABILITIES) expect(d[c], c).toBe(adapter[c] !== undefined)
      expect(Array.isArray(d.problems)).toBe(true)
    })

    it("explains every missing capability", async () => {
      const d = await make().describe()
      if (CAPABILITIES.some((c) => !d[c])) expect(d.problems.length).toBeGreaterThan(0)
    })
  })
}
