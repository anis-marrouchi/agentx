// --- Is an added Codex account signed in? (#2347 note, #2101 R28d) ---
//
// The Hub shows "Signed out" on an added account whose CLI has no login, so
// the owner knows to run `CODEX_HOME=… codex login` (cli-accounts.ts). For
// Claude the plan reader finds that out (claude-plan-usage.ts). Codex has no
// usage endpoint (codex-plan-usage.ts), so this looks at where Codex keeps
// its login:
//
//   $CODEX_HOME/auth.json   written by `codex login`, deleted by
//                           `codex logout`. Holds either ChatGPT tokens
//                           ("tokens") or an API key ("OPENAI_API_KEY").
//
// Codex can also keep the login in the OS keyring instead
// (`cli_auth_credentials_store = "keyring"` or "auto" in config.toml).
// AgentX does not open the keyring, so for such a folder the state is not
// readable here and is "unknown": the Hub then shows no "Signed out".
//
// Only whether a login is there leaves this file, never a token or a key.

import { readFile } from "node:fs/promises"
import { join } from "node:path"

export type CodexLoginState = "signed-in" | "signed-out" | "unknown"

/** The credentials store config.toml names, when it names one. */
export function codexCredentialsStore(configToml: string): string | null {
  const m = /^\s*cli_auth_credentials_store\s*=\s*["']([a-z]+)["']/m.exec(configToml)
  return m ? m[1] : null
}

/** Whether an auth.json text holds a login. Null when it is not JSON. */
export function codexAuthHasLogin(text: string): boolean | null {
  let o: any
  try { o = JSON.parse(text) } catch { return null }
  if (!o || typeof o !== "object") return null
  const key = typeof o.OPENAI_API_KEY === "string" && o.OPENAI_API_KEY.length > 0
  const t = o.tokens
  const tokens = !!t && typeof t === "object" && (typeof t.access_token === "string" || typeof t.refresh_token === "string")
  return key || tokens
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT"
}

/** The login state of the Codex folder `dir` (a CODEX_HOME). */
export async function readCodexLoginState(dir: string): Promise<CodexLoginState> {
  let config = ""
  try { config = await readFile(join(dir, "config.toml"), "utf8") } catch (e) { if (!isMissing(e)) return "unknown" }
  const store = codexCredentialsStore(config)
  if (store && store !== "file") return "unknown"
  let auth: string
  try { auth = await readFile(join(dir, "auth.json"), "utf8") } catch (e) { return isMissing(e) ? "signed-out" : "unknown" }
  const has = codexAuthHasLogin(auth)
  return has === null ? "unknown" : has ? "signed-in" : "signed-out"
}
