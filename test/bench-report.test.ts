import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

// bench/harbor/report.py is Python (it runs next to Harbor); its tests are
// stdlib unittest. Run them here so `pnpm test` covers the report too.
describe("bench/harbor/report.py", () => {
  it("passes its unittest suite", () => {
    const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", "bench/harbor", "-p", "test_report.py"], {
      cwd: resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: 60_000,
    })
    expect(r.error, "python3 must be on PATH").toBeUndefined()
    expect(r.status, r.stderr).toBe(0)
  }, 60_000)
})
