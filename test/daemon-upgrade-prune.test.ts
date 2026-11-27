import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync, existsSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { choosePrune, listReleaseFolders, pruneReleases, releasePrefix, textNamesDir, type PruneDeps } from "../src/daemon/upgrade-prune"

// Old release folders after an ok `agentx daemon upgrade` (#2495).

const f = (dir: string, mtimeMs: number) => ({ dir, mtimeMs })

describe("choosePrune: which release folders go", () => {
  const folders = [f("/r/a-1", 1), f("/r/a-2", 2), f("/r/a-3", 3), f("/r/a-4", 4), f("/r/a-5", 5)]

  it("keeps the live and the rollback folder only, by default", () => {
    const c = choosePrune({ folders, live: "/r/a-5", rollback: "/r/a-2", keep: 2, inUse: () => false })
    expect(c.keep).toEqual(["/r/a-5", "/r/a-2"])
    expect(c.prune.sort()).toEqual(["/r/a-1", "/r/a-3", "/r/a-4"])
    expect(c.inUse).toEqual([])
  })

  it("fills extra keep slots with the newest others", () => {
    const c = choosePrune({ folders, live: "/r/a-5", rollback: "/r/a-1", keep: 3, inUse: () => false })
    expect(c.keep).toEqual(["/r/a-5", "/r/a-1", "/r/a-4"])
    expect(c.prune.sort()).toEqual(["/r/a-2", "/r/a-3"])
  })

  it("never prunes a folder in use, whatever its age", () => {
    const c = choosePrune({ folders, live: "/r/a-5", rollback: "/r/a-4", keep: 2, inUse: (d) => d === "/r/a-1" })
    expect(c.inUse).toEqual(["/r/a-1"])
    expect(c.prune.sort()).toEqual(["/r/a-2", "/r/a-3"])
  })

  it("keeps live and rollback even when they are the oldest", () => {
    const c = choosePrune({ folders, live: "/r/a-1", rollback: "/r/a-2", keep: 2, inUse: () => false })
    expect(c.keep).toEqual(["/r/a-1", "/r/a-2"])
    expect(c.prune).not.toContain("/r/a-1")
    expect(c.prune).not.toContain("/r/a-2")
  })
})

describe("releasePrefix and textNamesDir", () => {
  it("takes the name up to its last dash", () => {
    expect(releasePrefix("/s/agentx-release-af561ac8")).toBe("agentx-release-")
    expect(releasePrefix("/s/new")).toBeNull()
  })

  it("matches a folder as a path, not as the prefix of a longer name", () => {
    const d = "/s/agentx-release-af56"
    expect(textNamesDir("node /s/agentx-release-af56/dist/cli.js daemon start", d)).toBe(true)
    expect(textNamesDir("<string>/s/agentx-release-af56</string>", d)).toBe(true)
    expect(textNamesDir("cd /s/agentx-release-af56\nls", d)).toBe(true)
    expect(textNamesDir("node /s/agentx-release-af5612/dist/cli.js", d)).toBe(false)
  })
})

describe("pruneReleases on real folders", () => {
  let root: string
  const mk = (name: string, age: number, cli = true) => {
    const dir = join(root, name)
    mkdirSync(join(dir, "dist"), { recursive: true })
    if (cli) writeFileSync(join(dir, "dist/cli.js"), "")
    const t = Date.now() / 1000 - age
    utimesSync(dir, t, t)
    return dir
  }
  const deps = (named: () => string, logs: string[] = []): PruneDeps => ({
    list: listReleaseFolders, inUseText: named, bytes: () => 1024 ** 3,
    remove: (d) => rmSync(d, { recursive: true, force: true }), log: (s) => logs.push(s),
  })

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "prune-")) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("leaves exactly live + rollback, and only touches same-prefix folders with dist/cli.js", () => {
    const old = [mk("agentx-release-a1", 500), mk("agentx-release-a2", 400), mk("agentx-release-a3", 300)]
    const rollback = mk("agentx-release-b1", 200)
    const live = mk("agentx-release-c1", 100)
    const noCli = mk("agentx-release-x0", 900, false)
    const other = mk("other-thing-1", 900)
    symlinkSync(old[0], join(root, "agentx-release-link"))
    writeFileSync(join(root, "agentx-release-a1.build.log"), "log")
    const logs: string[] = []
    const r = pruneReleases({ live, rollback, keep: 2 }, deps(() => "", logs))
    expect(r.error).toBeUndefined()
    expect(r.pruned.map((p) => p.dir).sort()).toEqual(old.sort())
    expect(r.freedBytes).toBe(3 * 1024 ** 3)
    for (const d of [live, rollback, noCli, other, join(root, "agentx-release-a1.build.log")]) expect(existsSync(d)).toBe(true)
    expect(logs.at(-1)).toBe("releases: kept 2, deleted 3, freed 3.00 GiB")
  })

  it("keeps a folder a launchd file or process names, also when it starts being used mid-prune", () => {
    const a = mk("agentx-release-a1", 500)
    const b = mk("agentx-release-a2", 400)
    const rollback = mk("agentx-release-b1", 200)
    const live = mk("agentx-release-c1", 100)
    let calls = 0
    // First snapshot: a1 in a plist. Recheck before deleting a2: a run started on it.
    const named = () => (calls++ === 0 ? `<string>${a}/dist/cli.js</string>` : `node ${b}/dist/cli.js wiki query x`)
    const r = pruneReleases({ live, rollback, keep: 2 }, deps(named))
    expect(r.keptInUse.sort()).toEqual([a, b].sort())
    expect(r.pruned).toEqual([])
    expect(existsSync(a) && existsSync(b)).toBe(true)
  })

  it("deletes nothing and records why when the process list fails", () => {
    const a = mk("agentx-release-a1", 500)
    const r = pruneReleases({ live: mk("agentx-release-c1", 100), rollback: mk("agentx-release-b1", 200), keep: 2 },
      deps(() => { throw new Error("ps failed: exit 1") }))
    expect(r.error).toBe("ps failed: exit 1")
    expect(existsSync(a)).toBe(true)
  })
})
