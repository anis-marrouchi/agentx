import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { join, win32 } from "path"
import { HELPER_VERBS, POINT_VERBS, TEACH_VERBS } from "../../src/computer-use/contract"
import { helperMissingMessage, helperOs, helperOverride, installedWindowsHelper, resolveDesktopHelper } from "../../src/computer-use/helper"

// #1594: every desktop helper answers the same verbs. The table in
// contract.ts and the macOS helper's switch must list the same ones, so a
// Windows helper built from the table matches what the Mac does.

const MAIN = join(__dirname, "..", "..", "apps/mac-helper/Sources/AgentXHelper/main.swift")

describe("desktop helper contract (#1594)", () => {
  it("lists exactly the verbs the macOS helper answers", () => {
    const swift = [...readFileSync(MAIN, "utf8").matchAll(/^case "([a-z-]+)":/gm)].map((m) => m[1]).sort()
    expect(HELPER_VERBS.map((v) => v.verb).sort()).toEqual(swift)
  })

  it("names each verb once, with a Windows plan", () => {
    const names = HELPER_VERBS.map((v) => v.verb)
    expect(new Set(names).size).toBe(names.length)
    for (const v of HELPER_VERBS) expect(v.windows, v.verb).not.toBe("")
  })

  it("builds point and teach from verbs in the table", () => {
    const names = new Set(HELPER_VERBS.map((v) => v.verb))
    for (const v of [...POINT_VERBS, ...TEACH_VERBS]) expect(names.has(v), v).toBe(true)
  })
})

describe("per-OS helper lookup (#1594)", () => {
  const base = { root: "/pkg", home: "/home/u", env: {}, exists: () => false }

  it("knows macOS and Windows, and nothing else yet", () => {
    expect(helperOs("darwin")).toBe("macos")
    expect(helperOs("win32")).toBe("windows")
    expect(helperOs("linux")).toBeNull()
  })

  it("keeps the Mac lookup as it was", () => {
    expect(resolveDesktopHelper({ ...base, platform: "darwin" }))
      .toBe("/pkg/apps/mac-helper/build/AgentX Helper.app/Contents/MacOS/agentx-mac-helper")
    expect(resolveDesktopHelper({ ...base, platform: "darwin", exists: () => true }))
      .toBe("/home/u/Applications/AgentX Helper.app/Contents/MacOS/agentx-mac-helper")
    expect(resolveDesktopHelper({ ...base, platform: "darwin", env: { AGENTX_MAC_HELPER: "/x/helper" } })).toBe("/x/helper")
  })

  it("finds the Windows helper under LOCALAPPDATA, else in the package", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }
    const installed = "C:\\Users\\u\\AppData\\Local\\Programs\\AgentX\\agentx-helper.exe"
    expect(installedWindowsHelper(env.LOCALAPPDATA)).toBe(installed)
    expect(resolveDesktopHelper({ ...base, platform: "win32", env, exists: (p) => p === installed })).toBe(installed)
    expect(resolveDesktopHelper({ ...base, platform: "win32", env, root: "C:\\agentx" }))
      .toBe(win32.join("C:\\agentx", "apps", "win-helper", "build", "agentx-helper.exe"))
    expect(resolveDesktopHelper({ ...base, platform: "win32", env, root: null })).toBe(installed)
  })

  it("lets AGENTX_DESKTOP_HELPER win on any OS, and ignores the Mac name elsewhere", () => {
    expect(helperOverride("win32", { AGENTX_DESKTOP_HELPER: "D:\\h.exe", AGENTX_MAC_HELPER: "/m" })).toBe("D:\\h.exe")
    expect(helperOverride("darwin", { AGENTX_DESKTOP_HELPER: "/d", AGENTX_MAC_HELPER: "/m" })).toBe("/d")
    expect(helperOverride("win32", { AGENTX_MAC_HELPER: "/m" })).toBeUndefined()
  })

  it("has no helper on Linux, and says so plainly", () => {
    expect(resolveDesktopHelper({ ...base, platform: "linux" })).toBeNull()
    expect(helperMissingMessage("linux")).toMatch(/not available on linux/)
    expect(helperMissingMessage("win32")).toMatch(/AGENTX_DESKTOP_HELPER/)
    expect(helperMissingMessage("darwin")).toMatch(/mac-helper/)
  })
})
