import type { NativeIdle } from "../types"
import { capture as defaultCapture, type Capture } from "./run"

// --- How long since the person touched this Mac (#1138 step B) ---
//
// The HID system keeps the time since the last keyboard, mouse or trackpad
// input, in nanoseconds. ioreg prints it without any permission prompt.

/** Seconds idle from `ioreg -c IOHIDSystem -d 4` output, or null. */
export function idleSecondsIn(ioreg: string): number | null {
  const m = ioreg.match(/"HIDIdleTime"\s*=\s*(\d+)/)
  return m ? Math.floor(Number(m[1]) / 1e9) : null
}

export function macosIdle(io: { capture?: Capture } = {}): NativeIdle {
  const capture = io.capture ?? defaultCapture
  return {
    async seconds() {
      const out = await capture("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"])
      return out ? idleSecondsIn(out) : null
    },
  }
}
