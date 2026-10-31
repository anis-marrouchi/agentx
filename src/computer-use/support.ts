// --- What computer use can do on this machine (#1595) ---
//
// Point, teach and act run through the AgentX Helper, which today exists
// only for macOS (apps/mac-helper). Windows (#1594) and Ubuntu (#1595) are
// planned ports. On Linux the display session decides what a port could
// ever do, so it is worth saying now, before any Linux helper exists:
//
//   X11        read (AT-SPI), act (AT-SPI + XTest), capture, cursor overlay
//   Wayland    read and AT-SPI actions only: the compositor blocks moving
//              the pointer for another app and has no global top-most
//              click-through window, so no cursor overlay
//   no display nothing to read or press (a server, an SSH shell)
//
// Pure: the platform and environment are passed in, so it is unit tested
// on any OS. `agentx daemon status` prints `supportLine` from the CLI
// process, which carries the desktop session's variables; a daemon under
// `systemd --user` may not.

export type DisplaySession = "x11" | "wayland" | "none"

export interface ComputerUseSupport {
  /** "macos", "linux", "windows" or Node's platform name. */
  os: string
  /** Linux only: the display session this shell belongs to. */
  session: DisplaySession | null
  /** True when this OS has an AgentX Helper today. */
  helper: boolean
  /** What the display allows a helper to do, ported or not. */
  read: boolean
  /** "full": pointer, keys and accessibility actions.
   *  "accessibility": only accessibility actions (press, set value). */
  act: "full" | "accessibility" | "none"
  /** Whether a click-through cursor overlay can be drawn over other apps. */
  overlay: boolean
}

/** The display session from the environment of a desktop shell.
 *  XDG_SESSION_TYPE is set by the login manager; WAYLAND_DISPLAY and
 *  DISPLAY cover shells it does not reach (a terminal inside a nested
 *  session, a `systemd --user` unit with imported variables). */
export function displaySession(env: Record<string, string | undefined>): DisplaySession {
  const type = env.XDG_SESSION_TYPE?.trim().toLowerCase()
  if (type === "wayland") return "wayland"
  if (type === "x11") return "x11"
  if (env.WAYLAND_DISPLAY) return "wayland"
  if (env.DISPLAY) return "x11"
  return "none"
}

export function computerUseSupport(platform: string, env: Record<string, string | undefined>): ComputerUseSupport {
  if (platform === "darwin")
    return { os: "macos", session: null, helper: true, read: true, act: "full", overlay: true }
  if (platform === "linux") {
    const session = displaySession(env)
    if (session === "x11") return { os: "linux", session, helper: false, read: true, act: "full", overlay: true }
    if (session === "wayland") return { os: "linux", session, helper: false, read: true, act: "accessibility", overlay: false }
    return { os: "linux", session, helper: false, read: false, act: "none", overlay: false }
  }
  if (platform === "win32")
    return { os: "windows", session: null, helper: false, read: true, act: "full", overlay: true }
  return { os: platform, session: null, helper: false, read: false, act: "none", overlay: false }
}

/** One line for people, in the words `agentx daemon status` prints. */
export function supportLine(s: ComputerUseSupport): string {
  if (s.helper) return "available (AgentX Helper)"
  if (s.os === "windows") return "not on Windows yet (planned, #1594)"
  if (s.os !== "linux") return `not available on ${s.os}`
  const planned = "not on Linux yet (planned, #1595)"
  if (s.session === "x11") return `${planned}. This is an X11 session: reading, acting and the cursor overlay will all work here`
  if (s.session === "wayland")
    return `${planned}. This is a Wayland session: reading the screen and pressing controls will work, but the cursor overlay and moving the pointer will not. Pick "Ubuntu on Xorg" at login for the overlay`
  return `${planned}. No desktop session in this shell, so there is no screen to read`
}
