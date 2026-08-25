import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  installAttachHooks,
  uninstallAttachHooks,
  attachHooksInstalled,
} from "../../src/attach/install"

// The installer edits ~/.claude/settings.json — a file the human owns and
// that other tools also write to. Every test here is about being a good
// guest: never clobber, never duplicate, never corrupt, always reversible.

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "attach-install-"))
  file = path.join(dir, "settings.json")
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function read(): any {
  return JSON.parse(readFileSync(file, "utf-8"))
}

describe("install", () => {
  it("creates the file when it does not exist", () => {
    const r = installAttachHooks("19900", { path: file })
    expect(r.changed).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(Object.keys(read().hooks).sort()).toEqual([
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ])
  })

  it("points the hooks at the daemon port it was given", () => {
    installAttachHooks("18800", { path: file })
    expect(read().hooks.Stop[0].hooks[0].command).toContain("127.0.0.1:18800/attach/stop")
  })

  it("is idempotent — a second run adds nothing", () => {
    installAttachHooks("19900", { path: file })
    const first = readFileSync(file, "utf-8")
    const r = installAttachHooks("19900", { path: file })
    expect(r.changed).toBe(false)
    expect(readFileSync(file, "utf-8")).toBe(first)
  })

  it("replaces its own entries when the port changes instead of stacking", () => {
    installAttachHooks("19900", { path: file })
    installAttachHooks("18800", { path: file })
    const stop = read().hooks.Stop
    expect(stop).toHaveLength(1)
    expect(stop[0].hooks[0].command).toContain("18800")
  })

  it("preserves hooks belonging to other tools", () => {
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo someone-elses-hook" }] }],
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo log" }] }],
        },
        permissions: { allow: ["Bash(ls)"] },
      }),
    )
    installAttachHooks("19900", { path: file })
    const s = read()
    expect(s.hooks.Stop).toHaveLength(2)
    expect(s.hooks.Stop[0].hooks[0].command).toBe("echo someone-elses-hook")
    expect(s.hooks.PostToolUse).toHaveLength(1)
    expect(s.permissions.allow).toEqual(["Bash(ls)"])
  })

  it("refuses to overwrite a settings file it cannot parse", () => {
    writeFileSync(file, "{ this is not json")
    expect(() => installAttachHooks("19900", { path: file })).toThrow(/not valid JSON/)
    expect(readFileSync(file, "utf-8")).toBe("{ this is not json")
  })

  it("installs the guard hook at user scope by default", () => {
    const r = installAttachHooks("19900", { path: file })
    expect(r.guardInstalled).toBe(true)
    const matchers = read().hooks.PreToolUse.map((e: any) => e.matcher)
    expect(matchers).toEqual(["Bash", "Write|Edit"])
  })

  it("can skip the guard when explicitly asked", () => {
    const r = installAttachHooks("19900", { path: file, withGuard: false })
    expect(r.guardInstalled).toBe(false)
    expect(read().hooks.PreToolUse).toBeUndefined()
  })

  it("uses a numeric hook timeout — Claude Code rejects strings like \"10s\"", () => {
    installAttachHooks("19900", { path: file })
    for (const event of ["SessionStart", "Stop", "UserPromptSubmit", "SessionEnd"]) {
      expect(typeof read().hooks[event][0].hooks[0].timeout).toBe("number")
    }
  })

  it("degrades to a no-op when the daemon is down (|| true)", () => {
    installAttachHooks("19900", { path: file })
    expect(read().hooks.Stop[0].hooks[0].command).toMatch(/\|\| true$/)
  })
})

describe("detection", () => {
  it("reports installed state", () => {
    expect(attachHooksInstalled(file)).toBe(false)
    installAttachHooks("19900", { path: file })
    expect(attachHooksInstalled(file)).toBe(true)
  })

  it("does not throw on a missing or malformed file", () => {
    expect(attachHooksInstalled(path.join(dir, "nope.json"))).toBe(false)
    writeFileSync(file, "not json")
    expect(attachHooksInstalled(file)).toBe(false)
  })
})

describe("uninstall", () => {
  it("removes attach hooks and leaves other tools' hooks alone", () => {
    writeFileSync(
      file,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
    )
    installAttachHooks("19900", { path: file })
    const r = uninstallAttachHooks({ path: file })
    expect(r.changed).toBe(true)
    const s = read()
    expect(s.hooks.Stop).toHaveLength(1)
    expect(s.hooks.Stop[0].hooks[0].command).toBe("echo mine")
  })

  it("keeps the guard hook unless asked to remove it", () => {
    installAttachHooks("19900", { path: file })
    uninstallAttachHooks({ path: file })
    expect(read().hooks.PreToolUse).toHaveLength(2)

    uninstallAttachHooks({ path: file, keepGuard: false })
    expect(read().hooks?.PreToolUse).toBeUndefined()
  })

  it("drops empty hook arrays rather than leaving [] behind", () => {
    installAttachHooks("19900", { path: file, withGuard: false })
    uninstallAttachHooks({ path: file })
    expect(read().hooks).toBeUndefined()
  })

  it("is a no-op on a file that was never installed into", () => {
    writeFileSync(file, JSON.stringify({ permissions: { allow: [] } }))
    const r = uninstallAttachHooks({ path: file })
    expect(r.changed).toBe(false)
  })
})
