import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentXDaemon } from "../src/daemon"
import { loadDaemonConfig } from "../src/daemon/config"

// A `people` edit must reach the registry on reload (#384): the registry
// stamps turns from its own config reference, which reload() used to swap
// only when `agents` changed.

let dir: string
const prevCwd = process.cwd()
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

describe("config reload", () => {
  it("hands a changed people list to the registry and reports it", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentx-people-reload-"))
    process.chdir(dir)
    const path = join(dir, "agentx.json")
    const raw = { node: { id: "test", name: "test" }, agents: {}, people: [] as unknown[] }
    writeFileSync(path, JSON.stringify(raw))
    const handed: unknown[] = []
    const daemon = Object.assign(Object.create(AgentXDaemon.prototype), {
      configPath: path,
      config: loadDaemonConfig(path),
      log: () => {},
      hooks: { clear: () => {} },
      contacts: { size: () => 0, reload: () => ({ count: 0 }) },
      router: { updateConfig: () => {} },
      registry: { setPeople: (people: unknown) => { handed.push(people) } },
      broadcastSSE: () => {},
    })

    expect((await daemon.reload()).applied).toEqual([])
    expect(handed).toEqual([])

    raw.people = [{ id: "sara", name: "Sara", identities: ["gitlab:sara.b"] }]
    writeFileSync(path, JSON.stringify(raw))
    const result = await daemon.reload()
    expect(result.applied).toEqual(["people(1)"])
    expect(result.restartRequired).toEqual([])
    expect(handed).toEqual([[{ id: "sara", name: "Sara", role: "member", identities: ["gitlab:sara.b"] }]])
  })
})
