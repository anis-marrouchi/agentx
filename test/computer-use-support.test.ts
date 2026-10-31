import { describe, expect, it } from "vitest"
import { computerUseSupport, displaySession, supportLine } from "../src/computer-use/support"

describe("displaySession (#1595)", () => {
  it("trusts XDG_SESSION_TYPE first", () => {
    expect(displaySession({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" })).toBe("wayland")
    expect(displaySession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" })).toBe("x11")
    expect(displaySession({ XDG_SESSION_TYPE: " Wayland " })).toBe("wayland")
  })
  it("falls back to WAYLAND_DISPLAY, then DISPLAY", () => {
    expect(displaySession({ XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("wayland")
    expect(displaySession({ DISPLAY: ":1" })).toBe("x11")
  })
  it("is none without a desktop (SSH, server)", () => {
    expect(displaySession({})).toBe("none")
    expect(displaySession({ XDG_SESSION_TYPE: "tty" })).toBe("none")
  })
})

describe("computerUseSupport", () => {
  it("macOS has the helper and everything", () => {
    expect(computerUseSupport("darwin", {})).toEqual({ os: "macos", session: null, helper: true, read: true, act: "full", overlay: true })
    expect(supportLine(computerUseSupport("darwin", {}))).toBe("available (AgentX Helper)")
  })
  it("Linux on X11 could do everything once ported", () => {
    const s = computerUseSupport("linux", { XDG_SESSION_TYPE: "x11" })
    expect(s).toMatchObject({ helper: false, read: true, act: "full", overlay: true })
    expect(supportLine(s)).toMatch(/not on Linux yet.*X11 session/)
  })
  it("Linux on Wayland: read and accessibility actions, no overlay, and says so", () => {
    const s = computerUseSupport("linux", { XDG_SESSION_TYPE: "wayland" })
    expect(s).toMatchObject({ helper: false, read: true, act: "accessibility", overlay: false })
    expect(supportLine(s)).toMatch(/Wayland session.*accessibility.*blocks moving the pointer and drawing over other apps/)
    // States what the display allows, not what a future port will do (#1595 options are open).
    expect(supportLine(s)).not.toMatch(/will|Ubuntu on Xorg/)
  })
  it("Linux without a desktop can do nothing", () => {
    const s = computerUseSupport("linux", {})
    expect(s).toMatchObject({ session: "none", read: false, act: "none", overlay: false })
    expect(supportLine(s)).toMatch(/No desktop session/)
  })
  it("Windows points at its own port", () => {
    expect(supportLine(computerUseSupport("win32", {}))).toMatch(/#1594/)
  })
  it("other platforms are named plainly", () => {
    expect(supportLine(computerUseSupport("freebsd", {}))).toBe("not available on freebsd")
  })
})
