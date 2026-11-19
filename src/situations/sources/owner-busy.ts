import { WIDGET_HOLD, readWidgetHold, type FocusState } from "@/notify/focus"
import { CALL_HOLD, readCall } from "@/notify/call-hold"
import { nativeBusySources } from "@/native/signal-sources"
import { busySignal, type OwnerBusyOptions, type OwnerBusySource } from "./busy"
import { fitsPlatform } from "./types"

export type { OwnerBusyOptions, OwnerBusySource } from "./busy"

// --- The owner is busy: Focus, the widget hold, a call (#1892 phase 3) ---
//
// Three adapters behind the signal-source interface:
//
//   widget-hold   ~/.agentx/focus.json, the widget's own toggle    any OS
//   <os focus>    the OS's own Focus (src/native/; today macOS's   its OS only
//                 private Focus database: `macos-focus`)
//   call-hold     ~/.agentx/call.json, written while on a call     any OS
//
// They wrap the readers that were always there (notify/focus.ts,
// notify/call-hold.ts), unchanged, so the hold answers exactly as before:
// Focus is the widget toggle, else the system Focus; the hold is Focus,
// else a call. The only difference is where an adapter does not fit: on
// a node with no OS Focus adapter the system Focus is never read, and
// Focus answers what the old reader answered there ("no Focus database on
// this machine", not in Focus).
//
// As signals, each answers one `busy` signal about the owner. An OS Focus
// that cannot be read is `unknown` there, not "not busy"; the hold keeps
// its rule that unknown means deliver (notify/focus.ts).

/** What the old reader answered on a machine with no Focus database. */
const NO_FOCUS_DB: FocusState = { active: false, mode: null, reason: "no Focus database on this machine" }

export function widgetHoldSource(o: OwnerBusyOptions = {}): OwnerBusySource {
  const state = () => readWidgetHold(o.widget ?? WIDGET_HOLD)
  return {
    id: "widget-hold", kind: "busy", sensitivity: "personal", platforms: ["any"], mode: "read",
    state,
    // An absent or unreadable file is the widget saying "not held".
    read: () => [busySignal("widget-hold", state(), true, o.now?.() ?? Date.now())],
  }
}

export function callHoldSource(o: OwnerBusyOptions = {}): OwnerBusySource {
  const state = () => readCall(o.call ?? CALL_HOLD, o.now?.() ?? Date.now())
  return {
    id: "call-hold", kind: "busy", sensitivity: "personal", platforms: ["any"], mode: "read",
    state,
    read: () => [busySignal("call-hold", state(), true, o.now?.() ?? Date.now())],
  }
}

/** All owner-busy adapters, the OS ones included. The registry loads
 *  those that fit the node. */
export function ownerBusySources(o: OwnerBusyOptions = {}): OwnerBusySource[] {
  return [widgetHoldSource(o), ...nativeBusySources(o), callHoldSource(o)]
}

/** Focus, from either source: the widget's toggle or the OS's (only where
 *  an OS adapter fits). Same answer as readFocus. */
export function ownerFocus(o: OwnerBusyOptions = {}): FocusState {
  const held = widgetHoldSource(o).state()
  if (held.active) return held
  const platform = o.platform ?? process.platform
  const system = nativeBusySources(o).find((s) => fitsPlatform(s, platform))
  return system ? system.state() : NO_FOCUS_DB
}

/** The call hold. Same answer as readCall. */
export function ownerCall(o: OwnerBusyOptions = {}): FocusState {
  return callHoldSource(o).state()
}

/** Focus or a call. Same answer as readHold. */
export function ownerHold(o: OwnerBusyOptions = {}): FocusState {
  const f = ownerFocus(o)
  return f.active ? f : ownerCall(o)
}
