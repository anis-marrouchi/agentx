import type { OwnerBusyOptions, OwnerBusySource } from "@/situations/sources/busy"
import { macosFocusSource } from "./macos/focus-source"
import { browserTabsSource, openAppsSource } from "./macos/screen-sources"
import type { RunCommand } from "@/situations/sources/per-request"
import type { SignalSource } from "@/situations/sources/types"

// --- OS signal sources (#1892 phase 3) ---
//
// The owner-busy adapters that read an OS's own state. Each declares the
// platforms it fits; the core (situations/sources/owner-busy.ts) loads only
// those that fit the node. A new OS adds its adapter here.

export function nativeBusySources(o: OwnerBusyOptions = {}): OwnerBusySource[] {
  return [macosFocusSource(o)]
}

/** The per-request screen sources (#1892 phase 7). `tabsReader` is a
 *  separate reader holding the Automation permission; without one, no
 *  tabs source is returned. */
export function nativeScreenSources(o: { run?: RunCommand; tabsReader?: RunCommand; includePaths: () => boolean }): SignalSource[] {
  return [openAppsSource(o.run), ...(o.tabsReader ? [browserTabsSource(o.tabsReader, o.includePaths)] : [])]
}
