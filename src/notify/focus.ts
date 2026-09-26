import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// Is the person currently in Do Not Disturb / a Focus mode?
//
// macOS keeps the answer in a JSON file rather than behind an API a
// non-sandboxed CLI can reach. An ACTIVE focus appears as an entry under
// `data[0].storeAssertionRecords`; when nothing is active the key is not
// merely empty, it is absent, and the file instead holds the invalidation
// records for the focus that was just switched off.
//
// Verified on this machine at both ends:
//
//   focus off   data[0] = { storeInvalidationRequestRecords,
//                           storeInvalidationRecords }      (no assertions)
//   focus on    data[0] gains storeAssertionRecords with one entry per
//               active mode
//
// Reading a private file is a compromise and it is worth naming. The
// alternative is to ignore Focus entirely and interrupt someone who has
// explicitly asked not to be, which is worse. The failure mode is chosen
// to match: anything unexpected — file missing, shape changed after an OS
// update, unreadable — is reported as NOT in focus, so notifications keep
// flowing. A notification that arrives during Focus is a small annoyance;
// one that is swallowed forever because a file moved is a broken feature.

export interface FocusState {
  /** True when a Focus / Do Not Disturb mode is on. */
  active: boolean
  /** The mode's identifier when macOS names one, e.g. com.apple.sleep.sleep-mode. */
  mode: string | null
  /** Why we believe this — recorded so a wrong answer is diagnosable. */
  reason: string
}

const ASSERTIONS = join(homedir(), "Library", "DoNotDisturb", "DB", "Assertions.json")

/** Where the widget records a hold the person switched on themselves. */
const WIDGET_HOLD = join(homedir(), ".agentx", "focus.json")

/**
 * Focus, from either source: the widget's own toggle or the system's.
 *
 * The widget toggle exists because macOS Focus is a heavy instrument —
 * turning it on silences everything on every device, which is more than
 * someone wants when they only mean "let me finish this". A switch on the
 * widget is a hold you can flick on for twenty minutes without negotiating
 * with the operating system.
 *
 * Either source being on is enough. They are not ranked: both are the
 * same person saying the same thing by different means, and a rule that
 * let one override the other would mean ignoring an explicit instruction
 * because it arrived through the wrong switch.
 */
export function readFocus(path = ASSERTIONS, holdPath = WIDGET_HOLD): FocusState {
  const held = readWidgetHold(holdPath)
  if (held.active) return held
  return readSystemFocus(path)
}

/** The widget's own toggle. Absent file means not held. */
export function readWidgetHold(path = WIDGET_HOLD): FocusState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    if (parsed?.active === true) {
      return { active: true, mode: "widget", reason: "holding — switched on from the widget" }
    }
  } catch {
    /* no file, or unreadable: not held */
  }
  return { active: false, mode: null, reason: "widget hold is off" }
}

export function readSystemFocus(path = ASSERTIONS): FocusState {
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (e: any) {
    // The file exists on every recent macOS but is private: without Full
    // Disk Access for the process reading it, the answer is "denied", and
    // saying so is the difference between a fixable setup and a mystery.
    if (e?.code === "EPERM" || e?.code === "EACCES") {
      return { active: false, mode: null, reason: "Focus database not readable — grant Full Disk Access to the app running agentx" }
    }
    return { active: false, mode: null, reason: "no Focus database on this machine" }
  }

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { active: false, mode: null, reason: "Focus database was not readable JSON" }
  }

  const record = Array.isArray(parsed?.data) ? parsed.data[0] : null
  const assertions = record?.storeAssertionRecords
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return { active: false, mode: null, reason: "no active Focus assertion" }
  }

  // The mode identifier lives a few levels down and its exact path has
  // moved between OS versions, so it is treated as a nicety: the presence
  // of the assertion is what decides, the name only improves the message.
  const first = assertions[0]
  const mode =
    first?.assertionDetails?.assertionDetailsModeIdentifier ??
    first?.assertionDetails?.assertionDetailsModeID ??
    null

  return {
    active: true,
    mode: typeof mode === "string" ? mode : null,
    reason: `Focus assertion present${mode ? ` (${mode})` : ""}`,
  }
}

/** A short phrase for logs and for telling someone why a message waited. */
export function focusLabel(state: FocusState): string {
  if (!state.active) return "not in Focus"
  if (state.mode === "widget") return "holding (widget)"
  if (!state.mode) return "in Focus"
  // com.apple.sleep.sleep-mode -> sleep mode
  const tail = state.mode.split(".").pop() ?? state.mode
  return `in ${tail.replace(/-/g, " ")}`
}
