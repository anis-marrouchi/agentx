import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "fs"
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

/** Add KEY=value to .env, creating it (mode 600) if needed; an existing file
 *  is tightened to 600 before the key is written. Never replaces
 *  a key that already has a value: returns false and leaves the file alone. */
export function addDotenvKey(path: string, key: string, value: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`not an environment variable name: ${key}`)
  if (!value || /[\r\n]/.test(value)) throw new Error("the value must be one non-empty line")
  if (readDotenv(path)[key]) return false
  if (!existsSync(path)) {
    writeFileSync(path, `# AgentX environment variables\n# (Never commit this file: it contains secrets.)\n\n${key}=${value}\n`, { mode: 0o600 })
    return true
  }
  // Best effort: a file we can write but do not own cannot be chmod-ed.
  try { chmodSync(path, 0o600) } catch {}
  const existing = readFileSync(path, "utf-8")
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n"
  appendFileSync(path, `${sep}${key}=${value}\n`)
  return true
}

/** Set KEY=value in .env, replacing every earlier line for KEY. Same file
 *  rules as addDotenvKey (created or tightened to mode 600). */
export function setDotenvKey(path: string, key: string, value: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`not an environment variable name: ${key}`)
  if (!value || /[\r\n]/.test(value)) throw new Error("the value must be one non-empty line")
  if (!existsSync(path)) { addDotenvKey(path, key, value); return }
  try { chmodSync(path, 0o600) } catch {}
  const isKey = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
  const kept = readFileSync(path, "utf-8").split("\n").filter((line) => !isKey.test(line))
  while (kept.length && kept[kept.length - 1] === "") kept.pop()
  writeFileSync(path, `${kept.join("\n")}${kept.length ? "\n" : ""}${key}=${value}\n`, { mode: 0o600 })
}
