import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, it } from "vitest"
import { daemonNodeFromArgs } from "../src/daemon/upgrade"
import { ensureNativeModules } from "../src/daemon/upgrade-native"

// #2227: a release staged with another Node broke every openDb in the daemon.

describe("the daemon's Node", () => {
  it("is the first program argument when it is an absolute node path", () => {
    expect(daemonNodeFromArgs(["/Users/x/.nvm/versions/node/v22.22.0/bin/node", "/r/dist/cli.js", "daemon", "start"]))
      .toBe("/Users/x/.nvm/versions/node/v22.22.0/bin/node")
    expect(daemonNodeFromArgs(["/usr/bin/node", "/r/dist/cli.js"])).toBe("/usr/bin/node")
  })

  it("is null for a bare name, another program or no arguments", () => {
    expect(daemonNodeFromArgs(["node", "/r/dist/cli.js"])).toBeNull()
    expect(daemonNodeFromArgs(["/usr/local/bin/agentx", "daemon", "start"])).toBeNull()
    expect(daemonNodeFromArgs(undefined)).toBeNull()
    expect(daemonNodeFromArgs([])).toBeNull()
  })
})

describe("native modules of a release folder", () => {
  it("pass when the release has no better-sqlite3", () => {
    const dir = mkdtempSync(join(tmpdir(), "ax-native-"))
    try {
      expect(ensureNativeModules(dir, process.execPath)).toEqual({ ok: true, detail: "no better-sqlite3 in this release" })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("load with the Node that installed them (this checkout)", () => {
    const r = ensureNativeModules(process.cwd(), process.execPath)
    expect(r.ok).toBe(true)
    expect(r.detail).toBe(`loaded (modules ${process.versions.modules})`)
  })
})
