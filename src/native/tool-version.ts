// --- The version of one installed program (#1531) ---
//
// Runs `<command> --version` (or the arguments configured) and keeps the
// first version-looking token of what it prints. On Windows, package
// managers install `.cmd` shims that only a shell can start, so the
// command runs through the shell there; the command and arguments come
// from the operator's config, never from a request.

import { execFile } from "child_process"
import { platform } from "os"

export interface ToolVersion {
  /** False when the command is not installed (or not on the PATH). */
  found: boolean
  /** e.g. "2.1.4"; null when the output had no version in it. */
  version: string | null
  /** The first line it printed, trimmed, for versions in other shapes. */
  raw: string | null
  error?: string
}

/** First "1.2" / "v1.2.3" / "1.2.3-beta.1" token in the output. */
export function parseVersion(out: string): string | null {
  const m = out.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/)
  return m ? m[1] : null
}

export function readToolVersion(command: string, args: string[] = ["--version"], timeoutMs = 5000): Promise<ToolVersion> {
  return new Promise((res) => {
    execFile(command, args, { timeout: timeoutMs, shell: platform() === "win32", windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}\n${stderr ?? ""}`.trim()
      const raw = out.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? null
      if (err) {
        const code = (err as NodeJS.ErrnoException).code
        // A shell reports a missing command as exit 127 (or 9009 on Windows).
        const missing = code === "ENOENT" || (err as { code?: unknown }).code === 127 || (err as { code?: unknown }).code === 9009
        if (missing) return res({ found: false, version: null, raw: null })
        // Some programs print their version and still exit non-zero.
        const v = parseVersion(out)
        if (v) return res({ found: true, version: v, raw })
        return res({ found: true, version: null, raw, error: (err.killed ? "timed out" : err.message).slice(0, 160) })
      }
      res({ found: true, version: parseVersion(out), raw })
    })
  })
}
