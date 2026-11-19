import type { FocusState } from "@/notify/focus"
import { UNKNOWN, type Signal, type SignalSource } from "./types"

// --- The shape shared by the owner-busy adapters (#1892 phase 3) ---
//
// Core-side (situations/sources/owner-busy.ts) and OS-side
// (src/native/<os>/focus-source.ts) adapters both build on this, so the
// core imports no OS file and an OS file imports nothing from the core
// but this shape.

export interface OwnerBusyOptions {
  /** Paths, for tests. Defaults: the real files. */
  assertions?: string
  widget?: string
  call?: string
  /** The platform; defaults to this process's, read on every call. */
  platform?: NodeJS.Platform
  now?: () => number
}

/** An owner-busy adapter: a signal source that also gives its reader's
 *  own FocusState, which the hold composes. */
export interface OwnerBusySource extends SignalSource {
  state(): FocusState
}

/** One `busy` signal about the owner. `known` false: a state that is not
 *  active is `unknown` (the reader could not tell), not "not busy". */
export function busySignal(id: string, state: FocusState, known: boolean, now: number): Signal {
  return { source: id, kind: "busy", subject: "owner", value: state.active ? true : known ? false : UNKNOWN, checkedAt: now, expiresAt: null, reason: state.reason }
}
