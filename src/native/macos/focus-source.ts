import { ASSERTIONS, readSystemFocus } from "@/notify/focus"
import { busySignal, type OwnerBusyOptions, type OwnerBusySource } from "@/situations/sources/busy"

// --- macOS Focus as a signal source (#1892 phase 3) ---
//
// The system Focus, from macOS's private Focus database (the reader is
// notify/focus.ts, unchanged). Declared for darwin only: the signal-source
// registry and the owner's hold load it on macOS and nowhere else, so a
// Linux node never reads this file.

export function macosFocusSource(o: OwnerBusyOptions = {}): OwnerBusySource {
  const state = () => readSystemFocus(o.assertions ?? ASSERTIONS)
  return {
    id: "macos-focus", kind: "busy", sensitivity: "personal", platforms: ["darwin"], mode: "read",
    state,
    read: () => {
      const s = state()
      // Only a clean read says "not in Focus"; a missing, unreadable or
      // changed file means the OS could not tell (as the native adapter's
      // focus does).
      return [busySignal("macos-focus", s, s.reason === "no active Focus assertion", o.now?.() ?? Date.now())]
    },
  }
}
