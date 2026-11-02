import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { createRequire } from "module"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { createCard } from "../src/approvals/cards"
import { resolveDaemonRoot, writeDaemonRoot } from "../src/utils/daemon-root"

// `agentx approvals` read the inbox from the working folder, so run from
// anywhere but the daemon's folder it printed "nothing waiting" while cards
// waited. The daemon records its folder; the CLI reads it.

const projectRoot = resolve(__dirname, "..")
let tmp: string, home: string, root: string, elsewhere: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agentx-daemon-root-"))
  home = join(tmp, "home"); root = join(tmp, "install"); elsewhere = join(tmp, "elsewhere")
  for (const d of [home, root, elsewhere]) mkdirSync(d, { recursive: true })
  writeFileSync(join(root, "agentx.json"), "{}")
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe("resolveDaemonRoot", () => {
  it("is the working folder when nothing else is known", () => {
    expect(resolveDaemonRoot({ cwd: elsewhere, env: {}, home })).toBe(elsewhere)
  })

  it("is the folder the daemon recorded, from another folder", () => {
    writeDaemonRoot(root, home)
    expect(resolveDaemonRoot({ cwd: elsewhere, env: {}, home })).toBe(root)
  })

  it("keeps a folder that holds its own daemon config", () => {
    writeDaemonRoot(elsewhere, home)
    expect(resolveDaemonRoot({ cwd: root, env: {}, home })).toBe(root)
  })

  it("lets AGENTX_ROOT win", () => {
    writeDaemonRoot(elsewhere, home)
    expect(resolveDaemonRoot({ cwd: root, env: { AGENTX_ROOT: elsewhere }, home })).toBe(elsewhere)
  })

  it("ignores a recorded folder that is gone", () => {
    writeDaemonRoot(join(tmp, "removed"), home)
    expect(resolveDaemonRoot({ cwd: elsewhere, env: {}, home })).toBe(elsewhere)
  })
})

describe("agentx approvals list from another folder", () => {
  it("shows the cards waiting in the daemon's folder", () => {
    const r = createCard(root, { raised_by: "helper", title: "Pick a meeting date", ask: "Thursday?", recommend: "Thursday", if_silent: "keep" })
    if (!r.ok) throw new Error(r.error)
    writeDaemonRoot(root, home)
    const out = execFileSync(
      process.execPath,
      [createRequire(import.meta.url).resolve("tsx/cli"), "--tsconfig", join(projectRoot, "tsconfig.json"), join(projectRoot, "src/cli.ts"), "approvals", "list", "--all"],
      {
        cwd: elsewhere, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, AGENTX_ROOT: "", FORCE_COLOR: "0", PATH: resolve(process.execPath, "..") + ":" + process.env.PATH },
      },
    )
    expect(out).toContain("Pick a meeting date")
    expect(out).not.toContain("nothing waiting")
  }, 60_000)
})
