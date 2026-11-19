import type { OwnerBusyOptions, OwnerBusySource } from "@/situations/sources/busy"
import { macosFocusSource } from "./macos/focus-source"

// --- OS signal sources (#1892 phase 3) ---
//
// The owner-busy adapters that read an OS's own state. Each declares the
// platforms it fits; the core (situations/sources/owner-busy.ts) loads only
// those that fit the node. A new OS adds its adapter here.

export function nativeBusySources(o: OwnerBusyOptions = {}): OwnerBusySource[] {
  return [macosFocusSource(o)]
}
