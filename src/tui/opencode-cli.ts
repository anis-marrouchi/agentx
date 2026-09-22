import { execFileSync } from "node:child_process"

export type OpenCodeCheck =
  | { ok: true; version: string }
  | { ok: false; reason: string }

/** Check the executable before launching the TUI so v1 never receives v2 config. */
export function checkOpenCodeVersion(runVersion: () => string = () =>
  execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 5_000 }).trim(),
): OpenCodeCheck {
  let version: string
  try {
    version = runVersion().trim()
  } catch (error: any) {
    return {
      ok: false,
      reason: error?.code === "ENOENT"
        ? "OpenCode is not installed or is not on PATH."
        : `Could not run opencode --version: ${error?.message || String(error)}`,
    }
  }
  const match = version.match(/^(?:opencode\s+)?v?(\d+)\.\d+\.\d+(?:\s|$)/i)
  if (!match) return { ok: false, reason: `Could not recognize the OpenCode version: ${version || "empty output"}` }
  if (Number(match[1]) < 2) return { ok: false, reason: `OpenCode ${version} is too old; AgentX TUI requires OpenCode v2 or newer.` }
  return { ok: true, version }
}
