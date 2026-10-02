import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { FSWatcher } from "fs"
import { watchConfigFile } from "../src/daemon/config-watch"

// #482: a look changed in agentx.json shows without a restart only if the
// daemon sees the save, whichever way the editor writes the file.

describe("watchConfigFile", () => {
  let dir: string
  let watcher: FSWatcher | undefined
  afterEach(() => {
    watcher?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const setup = async () => {
    dir = mkdtempSync(join(tmpdir(), "agentx-config-watch-"))
    const file = join(dir, "agentx.json")
    writeFileSync(file, "{}")
    // macOS reports a write made just before the watch started.
    await new Promise((r) => setTimeout(r, 300))
    let calls = 0
    watcher = watchConfigFile(file, () => { calls++ }, 20)
    const until = async (n: number) => {
      for (let i = 0; i < 100 && calls < n; i++) await new Promise((r) => setTimeout(r, 50))
      return calls
    }
    return { file, until, calls: () => calls }
  }
  const saveByRename = (file: string, text: string) => {
    writeFileSync(`${file}.tmp`, text)
    renameSync(`${file}.tmp`, file)
  }

  it("sees a write in place", async () => {
    const { file, until } = await setup()
    writeFileSync(file, '{"a":1}')
    expect(await until(1)).toBe(1)
  })

  it("sees a save that writes a new file over the old one, and the saves after it", async () => {
    const { file, until } = await setup()
    saveByRename(file, '{"a":1}')
    expect(await until(1)).toBe(1)
    writeFileSync(file, '{"a":2}')
    expect(await until(2)).toBe(2)
    saveByRename(file, '{"a":3}')
    expect(await until(3)).toBe(3)
  })

  it("ignores the other files of the folder", async () => {
    const { calls } = await setup()
    writeFileSync(join(dir, "db.sqlite-wal"), "x")
    await new Promise((r) => setTimeout(r, 300))
    expect(calls()).toBe(0)
  })
})
