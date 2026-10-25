import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs"
import { parseDotEnv } from "@/utils/workspace-env"

// --- .env in the folder AgentX runs in: read it, add one key ---
//
// The daemon loads .env itself in loadDaemonConfig, which also runs on
// POST /reload, so a key added here is picked up without a restart (#1163).

/** The KEY=VALUE pairs of a .env file. Missing file: empty. */
export function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  return Object.fromEntries(parseDotEnv(readFileSync(path, "utf-8")))
}

/** Add KEY=value to .env, creating it (mode 600) if needed. Never replaces
 *  a key that already has a value: returns false and leaves the file alone. */
export function addDotenvKey(path: string, key: string, value: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`not an environment variable name: ${key}`)
  if (!value || /[\r\n]/.test(value)) throw new Error("the value must be one non-empty line")
  if (readDotenv(path)[key]) return false
  if (!existsSync(path)) {
    writeFileSync(path, `# AgentX environment variables\n# (Never commit this file: it contains secrets.)\n\n${key}=${value}\n`, { mode: 0o600 })
    return true
  }
  const existing = readFileSync(path, "utf-8")
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n"
  appendFileSync(path, `${sep}${key}=${value}\n`)
  return true
}
