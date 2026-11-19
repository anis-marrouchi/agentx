import type { FocusState } from "./focus"
import { ownerCall, ownerFocus } from "@/situations/sources/owner-busy"

// --- The owner's hold: Focus or a call (#394) ---
//
// What notify, the popup, the Focus watcher and the [Situation] layer hold
// on. Since #1892 phase 3 each part is read through its signal-source
// adapter (situations/sources/owner-busy.ts): `widget-hold`, `macos-focus`
// (loaded on macOS only, so a Linux node reads no macOS file) and
// `call-hold`. The answer is the same as before: unknown means not held,
// so messages keep flowing.

export { CALL_HOLD, readCall, writeCallHold } from "./call-hold"

/** Focus or a call: what notify, the popup and the Focus watcher hold on. */
export function readHold(focus: () => FocusState = ownerFocus, call: () => FocusState = ownerCall): FocusState {
  const f = focus()
  return f.active ? f : call()
}
