import { describe, expect, it } from "vitest"
// @ts-expect-error plain ESM script without type declarations
import { KEEP, badgeJson, passRate, recordRun } from "../scripts/install-matrix-lib.mjs"

// Install matrix pass rate (#1294): the README badge counts the last runs.

const run = (version: string, ok: boolean) => ({ at: "2026-10-25T10:00:00Z", version, ok, run: "https://example.test/run" })

describe("install matrix history", () => {
  it("keeps the newest runs only, newest last", () => {
    let h: any[] = []
    for (let i = 0; i < KEEP + 3; i++) h = recordRun(h, run(`0.${i}.0`, true))
    expect(h).toHaveLength(KEEP)
    expect(h[0].version).toBe("0.3.0")
    expect(h[h.length - 1].version).toBe(`0.${KEEP + 2}.0`)
  })

  it("counts a run as passed only when it says ok, and starts from a missing file", () => {
    const h = recordRun(recordRun(null, run("1.0.0", true)), { ...run("1.0.1", false), ok: "true" })
    expect(h.map((r: any) => r.ok)).toEqual([true, false])
    expect(passRate(h)).toEqual({ passed: 1, runs: 2, percent: 50 })
  })
})

describe("the README badge", () => {
  it("shows the pass rate of the last runs, coloured by it", () => {
    const all = Array.from({ length: 20 }, (_, i) => run(`0.${i}.0`, i !== 4))
    expect(badgeJson(all)).toEqual({ schemaVersion: 1, label: "install matrix", message: "95% of last 20 (19/20)", color: "green" })
    expect(badgeJson(all.map((r) => ({ ...r, ok: true }))).color).toBe("brightgreen")
    expect(badgeJson([run("1", false), run("2", true)]).color).toBe("red")
  })

  it("says so before the first run", () => {
    expect(badgeJson([])).toEqual({ schemaVersion: 1, label: "install matrix", message: "no runs yet", color: "lightgrey" })
  })
})
