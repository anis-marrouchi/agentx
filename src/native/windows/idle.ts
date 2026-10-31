import type { NativeIdle } from "../types"
import { capture as defaultCapture, type Capture } from "../macos/run"
import { POWERSHELL, psArgs } from "./powershell"

// --- How long since the person touched this PC ---
//
// GetLastInputInfo gives the tick of the last keyboard or mouse input for
// this session, with no permission needed. PowerShell reaches it through a
// small inline type; the script prints milliseconds idle.

export const IDLE_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  "using System; using System.Runtime.InteropServices;",
  "public static class AgentXIdle {",
  "  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
  "  [DllImport(\"user32.dll\")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);",
  "  public static long Ms() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);",
  "    if (!GetLastInputInfo(ref i)) return -1; return (long)(uint)(Environment.TickCount - (int)i.dwTime); }",
  "}",
  "'@",
  "[AgentXIdle]::Ms()",
].join("\n")

/** Seconds idle from the script's output, or null. */
export function idleSecondsFromMs(out: string): number | null {
  const ms = Number(out.trim())
  return Number.isFinite(ms) && ms >= 0 && out.trim() !== "" ? Math.floor(ms / 1000) : null
}

export function windowsIdle(io: { capture?: Capture } = {}): NativeIdle {
  const capture = io.capture ?? defaultCapture
  return {
    async seconds() {
      const out = await capture(POWERSHELL, psArgs(IDLE_SCRIPT))
      return out ? idleSecondsFromMs(out) : null
    },
  }
}
