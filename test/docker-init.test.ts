// docker/init.mjs is the compose entrypoint's first-run config writer.
// A fresh Docker install must open the simple Hub; an existing one is kept (#2466).
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { HUB_FRESH_LAYOUT, resolveHubLayout } from "../src/hub/layout"

const INIT = resolve(__dirname, "../docker/init.mjs")

describe("docker/init.mjs", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-docker-init-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const run = () => execFileSync(process.execPath, [INIT], { cwd: dir, encoding: "utf8" })

  it("writes a fresh config whose Hub opens simple", () => {
    run()
    const config = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf8"))
    expect(config.dashboard.hub).toEqual({ layout: HUB_FRESH_LAYOUT })
    expect(resolveHubLayout(config.dashboard.hub).layout).toBe("simple")
    expect(readFileSync(join(dir, ".env"), "utf8")).toMatch(/^MESH_TOKEN=[0-9a-f]{64}$/m)
  })

  it("leaves an existing config alone", () => {
    const existing = JSON.stringify({ node: { id: "old" }, dashboard: { enabled: true } })
    writeFileSync(join(dir, "agentx.json"), existing)
    expect(run()).toContain("Existing agentx.json retained.")
    expect(readFileSync(join(dir, "agentx.json"), "utf8")).toBe(existing)
  })
})
