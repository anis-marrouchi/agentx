// --- The desktop helper contract (#1594) ---
//
// The daemon and the CLI talk to the desktop helper by subcommand, flags as
// `--name value`, and one JSON object on stdout. A failure exits non-zero
// and prints {"ok":false,"error":"..."}. Long-lived verbs read lines on
// stdin until EOF, so they never outlive the process that started them.
//
// A flag's value is always the argument right after it, even when that
// value starts with `--` ("--help" as a banner message is text). A helper
// reads flags left to right by position; it never searches argv for a
// flag's name, which would match a value spelled like one.
//
// Every helper, whatever the OS, answers these verbs with the same output.
// The macOS helper (apps/mac-helper) is the reference; a Windows helper
// answers the same verbs, so src/computer-use, point, teach and live-teach
// do not change. test/computer-use/helper-contract.test.ts holds this table
// and apps/mac-helper/Sources/AgentXHelper/main.swift to the same list.
//
// Coordinates are screen points with a top-left origin, across all
// displays, in the same convention for every verb, so a rect from `read`
// or `ocr` can go straight to `point` or `click`. On Windows that means the
// helper is per-monitor DPI aware and reports logical (scaled) pixels.

export type HelperTier = "read" | "act" | "overlay" | "notify" | "check"

export interface HelperVerb {
  verb: string
  tier: HelperTier
  /** What it does, in a few words. */
  does: string
  /** True for verbs that run until stdin closes. */
  longLived?: boolean
  /** What the macOS helper uses. */
  macos: string
  /** What a Windows helper is expected to use. */
  windows: string
}

export const HELPER_VERBS: readonly HelperVerb[] = [
  { verb: "read", tier: "read", does: "the focused window's accessibility tree", macos: "AXUIElement", windows: "UI Automation" },
  { verb: "focused", tier: "read", does: "what has keyboard focus", macos: "AXUIElement", windows: "UI Automation (FocusedElement)" },
  { verb: "hittest", tier: "read", does: "what is on top at a point", macos: "AXUIElement + window list", windows: "UI Automation (ElementFromPoint)" },
  { verb: "ocr", tier: "read", does: "text read off the screen", macos: "Vision", windows: "Windows.Media.Ocr" },
  { verb: "capture", tier: "read", does: "a screenshot of a region", macos: "CGWindowListCreateImage", windows: "Windows.Graphics.Capture or DXGI" },
  { verb: "screens", tier: "read", does: "display geometry", macos: "NSScreen", windows: "EnumDisplayMonitors, per-monitor DPI" },
  { verb: "buffer", tier: "read", does: "the last seconds of a region, kept in memory", longLived: true, macos: "CGWindowListCreateImage", windows: "Windows.Graphics.Capture or DXGI" },
  { verb: "point", tier: "overlay", does: "move the cursor to a rect and highlight it", macos: "CGEvent + NSPanel", windows: "SendInput + layered window" },
  { verb: "click", tier: "act", does: "press where the cursor is", macos: "CGEvent", windows: "SendInput or UIA Invoke" },
  { verb: "scroll", tier: "act", does: "scroll where the cursor is", macos: "CGEvent", windows: "SendInput" },
  { verb: "drag", tier: "act", does: "drag from the cursor to a point", macos: "CGEvent", windows: "SendInput" },
  { verb: "type", tier: "act", does: "type text into the focused control", macos: "CGEvent", windows: "SendInput or UIA Value" },
  { verb: "key", tier: "act", does: "press one key with modifiers", macos: "CGEvent", windows: "SendInput" },
  { verb: "hud", tier: "overlay", does: "the lesson heads-up display", longLived: true, macos: "NSPanel", windows: "layered WS_EX_TRANSPARENT top-most window" },
  { verb: "presence", tier: "overlay", does: "the agent's own drawn cursor and name tag", longLived: true, macos: "NSPanel", windows: "layered WS_EX_TRANSPARENT top-most window" },
  { verb: "notify", tier: "notify", does: "a banner under the helper's name", macos: "UNUserNotificationCenter", windows: "toast notification" },
  { verb: "notify-status", tier: "notify", does: "whether banners are allowed", macos: "UNUserNotificationCenter", windows: "ToastNotifier.Setting" },
  { verb: "trusted", tier: "check", does: "whether the helper may read and act", macos: "Accessibility grant", windows: "always true at the same integrity level; elevated targets are refused (UIPI)" },
]

/** The verbs a new helper needs first, so it can be built in steps:
 *  `agentx point` reads the screen and highlights; a lesson then clicks,
 *  types and shows the agent's cursor. */
export const POINT_VERBS = ["read", "ocr", "point"] as const
export const TEACH_VERBS = [...POINT_VERBS, "focused", "hittest", "click", "type", "key", "scroll", "hud", "presence"] as const
