import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { init } from "../src/commands/init"
import { install } from "../src/commands/team"
import { shippedTeam } from "../src/teams/catalog"

// #1332: `agentx init` then `agentx team add` in the same folder.
describe("team add after agentx init", () => {
  const cwd = process.cwd()
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-init-"))
    process.chdir(dir)
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as any)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it("gives the assistant its own folder, so a team's agents do not overlap it", async () => {
    await init.parseAsync([], { from: "user" })
    const config = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    expect(config.agents.assistant.workspace).toBe(join(process.cwd(), "agents", "assistant"))
    expect(existsSync(join(dir, "agents", "assistant", ".claude"))).toBe(true)

    const pkg = shippedTeam("support")!
    await install(pkg, {})
    const after = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    for (const id of Object.keys(pkg.agents)) expect(after.agents[id].workspace).toBe(join(process.cwd(), "agents", id))
    expect(after.agents.assistant.workspace).toBe(config.agents.assistant.workspace)
  })
})
