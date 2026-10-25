import { execFileSync } from "child_process"
import { findBinary } from "@/voice/transcribe"

// --- Is a model CLI logged in? (#1163) ---
//
// `agentx start` and the chat's "no model yet" box ask for the CLI login
// when the engine's CLI is installed but has never been logged in, instead
// of letting the first message fail. Only Claude Code has a status command
// we can read (`claude auth status` prints {"loggedIn": …}); for anything
// else, or when the command fails (older CLI), the answer is null: unknown,
// and the caller assumes it is logged in.

export function cliLoggedIn(bin: string): boolean | null {
  if (bin !== "claude") return null
  const path = findBinary(bin)
  if (!path) return null
  try {
    const out = execFileSync(path, ["auth", "status"], { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
    return parseAuthStatus(out)
  } catch (e: any) {
    // It exits non-zero when logged out on some versions; its stdout still says so.
    return typeof e?.stdout === "string" ? parseAuthStatus(e.stdout) : null
  }
}

/** loggedIn from `claude auth status` output, or null when it is not that JSON. */
export function parseAuthStatus(out: string): boolean | null {
  try {
    const v = JSON.parse(out)
    return typeof v?.loggedIn === "boolean" ? v.loggedIn : null
  } catch { return null }
}
