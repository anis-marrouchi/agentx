import { execFileSync } from "child_process"
import { cliByCommand } from "@/agents/conventions"
import { findBinary } from "@/voice/transcribe"

// --- Is a model CLI logged in? (#1163) ---
//
// `agentx start` and the chat's "no model yet" box ask for the CLI login
// when the engine's CLI is installed but has never been logged in, instead
// of letting the first message fail. The CLI catalog (agents/conventions,
// #2349) says which CLI has a status command and how to read it; today only
// Claude Code (`claude auth status` prints {"loggedIn": …}). For any other
// CLI, or when the command fails (older CLI), the answer is null: unknown,
// and the caller assumes it is logged in.

export { parseAuthStatus } from "@/agents/conventions"

export function cliLoggedIn(bin: string): boolean | null {
  const check = cliByCommand(bin)?.signInStatus
  if (!check) return null
  const path = findBinary(bin)
  if (!path) return null
  try {
    const out = execFileSync(path, check.args, { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
    return check.parse(out)
  } catch (e: any) {
    // It exits non-zero when logged out on some versions; its stdout still says so.
    return typeof e?.stdout === "string" ? check.parse(e.stdout) : null
  }
}
